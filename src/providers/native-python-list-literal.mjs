// Bounded safe Python literal validator for the ``python_list`` final shape.
//
// Ports the acceptance path of ``ksadk/studio/native_final_shape.py::_violation``
// (the ``shape == "python_list"`` branch) from the pinned reference commit
// 355059d78e47ed764bbdb3606304cdf34e9838a3. The Python source uses
// ``ast.parse(candidate, mode="eval")`` then checks:
//   1. ``expression.body`` is an ``ast.List``
//   2. ``ast.get_source_segment(candidate, expression.body) == candidate``
//      (the list node spans the whole candidate, so no leading/trailing prose,
//      quotes, fences, comments or a second expression survive)
//   3. ``sum(1 for _ in ast.walk(expression)) <= 4096`` (AST node budget,
//      INCLUDING operator nodes Add/Sub/UAdd/USub and the ``Name`` in ``set()``)
//   4. ``isinstance(ast.literal_eval(expression), list)`` (every nested node is
//      a literal Python understands, and the top value is a list)
// plus a length gate ``len(candidate) <= 65536`` (code points) before parsing.
//
// The accepted literal forms mirror CPython ``ast.literal_eval`` (verified
// against the stdlib ``ast.py`` ``_convert``/``_convert_num``/``_convert_signed_num``
// for the real+/-complex rule, the empty-``set()`` call, and adjacent
// string/bytes concatenation):
//   - Constant: str, bytes, int, float, complex, bool, None, Ellipsis
//   - Tuple / List / Set / Dict (with hashable set elements and dict keys)
//   - ``set()`` (the empty ``set`` call ONLY; any other call rejects)
//   - adjacent string/bytes literals (``'a' 'b'`` -> one Constant; mixing
//     str and bytes is a SyntaxError -> reject; f-strings reject)
//   - UnaryOp ``+``/``-`` on a numeric Constant (``-1``, ``+2j``); a signed
//     operand may only be a single Constant (``--1`` rejects)
//   - BinOp ``+``/``-`` forming a complex from a REAL left and an IMAGINARY
//     right: ``1+2j``, ``-1-2j``; ``1+2`` (real+real) and ``2j+1`` (imaginary
//     left) reject, matching ``isinstance(left,(int,float)) and
//     isinstance(right,complex)``.
//
// This module never executes Python or JavaScript: there is no ``eval``,
// ``Function``, ``vm`` or subprocess. It is a hand-written tokenizer plus
// recursive-descent parser. Numeric, string/bytes and escape grammar follow
// CPython 3's tokenizer (verified against Objects/unicodeobject.c
// ``_PyUnicode_DecodeUnicodeEscapeInternal`` and Modules/unicodedata.c
// ``_getcode`` at cpython v3.11.0):
//   - base-specific digits (binary ``[01]``, octal ``[0-7]``, hex
//     ``[0-9a-fA-F]``), one underscore allowed after a base prefix (``0x_FF``),
//     decimal leading-zero restriction applies to pure integers only
//     (``00``/``0_0`` accept, ``01`` rejects; ``01.0``/``01e2``/``01j`` accept
//     as float/imaginary).
//   - octal escapes above 0o377 are ACCEPTED (CPython emits only a
//     DeprecationWarning, not an error): ``\400`` is a valid literal.
//   - in a bytes literal, ``\u``/``\U``/``\N`` are UNRECOGNIZED escapes: the
//     backslash and letter are preserved literally (warning), NOT forbidden
//     Unicode escapes. Only str resolves ``\u``/``\U``/``\N``.
//   - bytes literal bodies must be ASCII; a real non-ASCII source byte rejects.
//   - ``\U`` values > 0x10FFFF reject ("illegal Unicode character"); lone
//     surrogates (0xD800-0xDFFF via ``\U`` or ``\u``) are PERMITTED by CPython's
//     str decoder and accepted here.
//   - a real NUL byte anywhere in the source rejects; an escaped ``\x00`` inside
//     a literal is valid. Backslash line continuation handles CRLF (including
//     in triple strings).
//   - ``\N{name}`` is validated against the bundled Unicode 14.0.0 name table
//     (native-unicode-names.mjs), matching CPython's ``\N`` escape path
//     (``getcode(..., with_named_seq=0)``): explicit names, all alias types,
//     algorithmic ``HANGUL SYLLABLE``/``CJK UNIFIED IDEOGRAPH-HEX`` forms
//     resolve; named SEQUENCES reject; truncated/empty/unknown names reject.
//     Raw strings/bytes do not resolve ``\N``.
//
// Documented bounded approximations (toward safe rejection):
//  - An unhashable set element or dict key (e.g. ``[{[1,2]}]``, ``[{set()}]``)
//    is rejected here. CPython ``literal_eval`` raises an UNCAUGHT ``TypeError``
//    on these (not in ``_violation``'s ``(SyntaxError, ValueError, RecursionError)``
//    catch tuple), which would propagate; this port turns that into a bounded
//    rejection instead of crashing.
//  - The Unicode name table is pinned to Unicode 14.0.0 (the CPython 3.11
//    baseline). A name added in a newer Unicode version than the bundled data
//    rejects — a platform/version difference, not an arbitrary-unknown-name
//    acceptance.

import { lookupUnicodeName } from "./native-unicode-names.mjs";
// Shared Python text-parity helpers (codePointLength, PY_WS, pythonStrip,
// pythonLstrip, pythonSplitLines, fullMatch) live in native-python-text.mjs.
// Re-exported here so this module's original API surface is unchanged for
// existing importers (native-final-shape, native-output-fields, tests).
export {
  codePointLength,
  PY_WS,
  pythonStrip,
  pythonLstrip,
  pythonSplitLines,
  fullMatch,
} from "./native-python-text.mjs";
import { codePointLength } from "./native-python-text.mjs";

// --- tokenizer ----------------------------------------------------------------

class ParseError extends Error {}

class Cursor {
  constructor(s) {
    this.s = s;
    this.i = 0; // UTF-16 index
    this.cp = 0; // code-point index (matches Python col_offset)
    this.n = s.length;
  }
  eof() {
    return this.i >= this.n;
  }
  ch() {
    return this.i < this.n ? this.s[this.i] : "";
  }
  chAt(offset) {
    // UTF-16 char `offset` code points ahead (for ASCII lookahead only).
    let j = this.i;
    let k = 0;
    while (j < this.n && k < offset) {
      const c = this.s.charCodeAt(j);
      if (c >= 0xd800 && c <= 0xdbff && j + 1 < this.n) {
        const c2 = this.s.charCodeAt(j + 1);
        if (c2 >= 0xdc00 && c2 <= 0xdfff) {
          j += 2;
          k++;
          continue;
        }
      }
      j++;
      k++;
    }
    return j < this.n ? this.s[j] : "";
  }
  codePoint() {
    if (this.i >= this.n) return -1;
    const c = this.s.charCodeAt(this.i);
    if (c >= 0xd800 && c <= 0xdbff && this.i + 1 < this.n) {
      const c2 = this.s.charCodeAt(this.i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        return 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
      }
    }
    return c;
  }
  advance() {
    if (this.i >= this.n) return;
    const c = this.s.charCodeAt(this.i);
    if (c >= 0xd800 && c <= 0xdbff && this.i + 1 < this.n) {
      const c2 = this.s.charCodeAt(this.i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        this.i += 2;
        this.cp++;
        return;
      }
    }
    this.i++;
    this.cp++;
  }
}

// Python SOURCE lexical whitespace, matching CPython's tokenizer (cpython
// v3.11.0 Parser/tokenizer.c: the indentation loop and the inter-token
// "Skip spaces" loop accept only space, tab, and formfeed (0x0C); CR/LF are
// line terminators, also trivia inside bracketed expressions). This is NARROWER
// than Python ``str``/``re`` ``\s`` (which includes U+0085 NEL, U+2028, U+00A0,
// vertical tab 0x0B, etc.) — those are NOT source trivia and a source byte like
// U+00A0 between tokens is a syntax error. The ``str``/``re`` whitespace parity
// (``isPySpaceCp``) used by ``pythonStrip`` etc. lives in native-python-text.mjs.
function isSourceTriviaCp(cp) {
  return cp === 0x20 || cp === 0x09 || cp === 0x0c || cp === 0x0a || cp === 0x0d;
}

function skipTrivia(cursor) {
  // Source lexical trivia: ASCII space/tab/formfeed, CR/LF line terminators,
  // backslash line continuation (``\`` + newline), and ``#`` comments to end
  // of line. Non-ASCII "whitespace" (NEL, line separator, NBSP, vertical tab,
  // etc.) is NOT trivia in source and is left for the tokenizer to reject.
  while (!cursor.eof()) {
    const cp = cursor.codePoint();
    if (isSourceTriviaCp(cp)) {
      cursor.advance();
      continue;
    }
    if (cursor.ch() === "\\") {
      if (cursor.chAt(1) === "\n") {
        cursor.advance();
        cursor.advance();
        continue;
      }
      if (cursor.chAt(1) === "\r") {
        cursor.advance();
        cursor.advance();
        if (cursor.ch() === "\n") cursor.advance();
        continue;
      }
      throw new ParseError("unexpected backslash");
    }
    if (cursor.ch() === "#") {
      while (!cursor.eof() && cursor.codePoint() !== 0x0a && cursor.codePoint() !== 0x0d) {
        cursor.advance();
      }
      continue;
    }
    break;
  }
}

function isDecDigit(ch) {
  return ch >= "0" && ch <= "9";
}
function isHexDigit(ch) {
  return (
    (ch >= "0" && ch <= "9") ||
    (ch >= "a" && ch <= "f") ||
    (ch >= "A" && ch <= "F")
  );
}
function isOctDigit(ch) {
  return ch >= "0" && ch <= "7";
}
function isBinDigit(ch) {
  return ch === "0" || ch === "1";
}

function scanRun(cursor, isDigit) {
  // One mandatory digit, then ``(_? digit)*`` so underscores sit strictly
  // between digits (no leading/trailing/adjacent underscore).
  if (!isDigit(cursor.ch())) throw new ParseError("digit expected");
  cursor.advance();
  while (!cursor.eof()) {
    if (cursor.ch() === "_") {
      if (!isDigit(cursor.chAt(1))) throw new ParseError("bad underscore in number");
      cursor.advance();
      cursor.advance();
    } else if (isDigit(cursor.ch())) {
      cursor.advance();
    } else {
      break;
    }
  }
}

function tokenizeNumber(cursor) {
  const start = cursor.cp;
  const first = cursor.ch();
  // --- prefixed integer: hex (0x), octal (0o), binary (0b) ---
  if (first === "0" && /[xXoObB]/.test(cursor.chAt(1))) {
    cursor.advance(); // 0
    const prefixChar = cursor.ch();
    cursor.advance(); // base prefix
    const isHex = /[xX]/.test(prefixChar);
    const isOct = /[oO]/.test(prefixChar);
    const isDigit = isHex ? isHexDigit : isOct ? isOctDigit : isBinDigit;
    // Python permits ONE underscore immediately after the base prefix
    // (``0x_FF``, ``0b_10``, ``0o_77``); a second underscore or a non-digit
    // after the prefix-underscore rejects.
    if (cursor.ch() === "_") {
      if (!isDigit(cursor.chAt(1))) throw new ParseError("bad underscore after base prefix");
      cursor.advance();
    }
    if (!isDigit(cursor.ch())) throw new ParseError("incomplete numeric literal");
    scanRun(cursor, isDigit);
    return { type: "NUMBER", start, end: cursor.cp, numKind: "int", isImaginary: false };
  }
  // --- decimal: integer, float, or imaginary ---
  // CPython 3.11's default int-max-str-digits is 4300 (pycore_long.h
  // _PY_LONG_DEFAULT_MAX_STR_DIGITS): a decimal INTEGER literal with more than
  // 4300 digits (underscores excluded) raises ValueError in PyLong_FromString,
  // which ``ast.literal_eval`` catches and rejects. This port enforces that
  // default on pure decimal INTEGERS only (hex/oct/bin ints, floats and
  // imaginaries are separate conversion paths and are NOT subject to this
  // specific limit; they remain bounded by the 65536 code-point and 4096
  // AST-node limits). The limit is a configurable interpreter default; a
  // different ``sys.set_int_max_str_digits`` setting is a platform difference.
  const DEC_INT_DIGIT_LIMIT = 4300;
  let isFloat = false;
  let isImaginary = false;
  let startedWithZero = false;
  let intPartHadNonzero = false;
  let decIntDigits = 0; // decimal integer-part digit count (underscores excluded)
  if (cursor.ch() === ".") {
    isFloat = true; // leading-dot float like ``.5``
  } else {
    // Integer part: one mandatory digit, then ``(_? digit)*``. Track a leading
    // zero and any nonzero digit so the pure-integer leading-zero rule can be
    // applied after the float/imaginary suffixes are known.
    if (!isDecDigit(cursor.ch())) throw new ParseError("not a number");
    if (cursor.ch() === "0") startedWithZero = true;
    else intPartHadNonzero = true;
    decIntDigits++;
    cursor.advance();
    while (!cursor.eof()) {
      if (cursor.ch() === "_") {
        if (!isDecDigit(cursor.chAt(1))) throw new ParseError("bad underscore in number");
        cursor.advance();
        if (cursor.ch() !== "0") intPartHadNonzero = true;
        decIntDigits++;
        cursor.advance();
      } else if (isDecDigit(cursor.ch())) {
        if (cursor.ch() !== "0") intPartHadNonzero = true;
        decIntDigits++;
        cursor.advance();
      } else {
        break;
      }
    }
  }
  if (cursor.ch() === ".") {
    isFloat = true;
    cursor.advance();
    if (isDecDigit(cursor.ch())) scanRun(cursor, isDecDigit);
  }
  if (cursor.ch() === "e" || cursor.ch() === "E") {
    isFloat = true;
    cursor.advance();
    if (cursor.ch() === "+" || cursor.ch() === "-") cursor.advance();
    if (!isDecDigit(cursor.ch())) throw new ParseError("bad exponent");
    scanRun(cursor, isDecDigit);
  }
  if (cursor.ch() === "j" || cursor.ch() === "J") {
    cursor.advance();
    isImaginary = true;
  }
  const isPureInt = !isFloat && !isImaginary;
  // The leading-zero restriction applies ONLY to a standalone decimal integer
  // (``01`` rejects); ``00``/``0_0``/``000`` accept (all zeros), and floats /
  // imaginaries (``01.0``/``01e2``/``01j``) accept regardless.
  if (isPureInt && startedWithZero && intPartHadNonzero) {
    throw new ParseError("leading zero in decimal integer");
  }
  // CPython 3.11 default int-max-str-digits (4300): a pure decimal INTEGER
  // with more than 4300 digits (underscores excluded) rejects. Hex/oct/bin
  // ints, floats and imaginaries are not subject to this limit.
  if (isPureInt && decIntDigits > DEC_INT_DIGIT_LIMIT) {
    throw new ParseError("decimal integer exceeds the 4300-digit limit");
  }
  const numKind = isImaginary ? "complex" : isFloat ? "float" : "int";
  return { type: "NUMBER", start, end: cursor.cp, numKind, isImaginary };
}

function readHexValue(cursor, count, label) {
  let value = 0;
  for (let i = 0; i < count; i++) {
    if (!isHexDigit(cursor.ch())) throw new ParseError("truncated " + label + " escape");
    value = value * 16 + parseInt(cursor.ch(), 16);
    cursor.advance();
  }
  return value;
}

function readNamedEsc(cursor) {
  // ``\N{NAME}`` in a str literal: requires ``{``, a non-empty name, and ``}``,
  // and the name must resolve via the bundled Unicode table (matching CPython's
  // ``\N`` escape path). Bytes literals do not reach here — ``\N`` is an
  // unrecognized escape in bytes and is consumed literally instead.
  if (cursor.ch() !== "{") throw new ParseError("malformed \\N escape");
  cursor.advance();
  const nameStart = cursor.i;
  while (cursor.ch() !== "}") {
    if (cursor.eof() || cursor.ch() === "\n" || cursor.ch() === "\r") {
      throw new ParseError("unterminated \\N escape");
    }
    cursor.advance();
  }
  const name = cursor.s.slice(nameStart, cursor.i);
  if (name.length === 0) throw new ParseError("empty \\N escape name");
  // Resolve the name exactly as CPython's \N escape does (getcode with
  // with_named_seq=0). Unknown names, named sequences, and malformed
  // algorithmic forms reject.
  if (lookupUnicodeName(name) === null) throw new ParseError("unknown Unicode character name");
  cursor.advance(); // ``}``
}

function readHexEscapeContent(cursor, count, label) {
  // Consume the escape letter then ``count`` hex digits, returning the value.
  // CPython rejects ``\U`` values > 0x10FFFF ("illegal Unicode character") but
  // PERMITS surrogates (0xD800-0xDFFF) — they are written as-is by the decoder.
  cursor.advance(); // the escape letter
  const value = readHexValue(cursor, count, label);
  if (count === 8 && value > 0x10ffff) throw new ParseError("illegal Unicode character");
  return value;
}

function tokenizeString(cursor) {
  const start = cursor.cp;
  let isBytes = false;
  let isRaw = false;
  let isFstring = false;
  const prefixChars = [];
  for (let k = 0; k < 2 && !cursor.eof(); k++) {
    const ch = cursor.ch();
    if (/[bBrRuUfF]/.test(ch)) {
      prefixChars.push(ch);
      cursor.advance();
      continue;
    }
    break;
  }
  for (const ch of prefixChars) {
    if (ch === "f" || ch === "F") isFstring = true;
    if (ch === "b" || ch === "B") isBytes = true;
    if (ch === "r" || ch === "R") isRaw = true;
  }
  const prefixKey = prefixChars.map((c) => c.toLowerCase()).sort().join("");
  if (prefixChars.length === 2 && !["br", "fr", "rb", "rf"].includes(prefixKey)) {
    throw new ParseError("bad string prefix");
  }
  const quote = cursor.ch();
  if (quote !== '"' && quote !== "'") throw new ParseError("string without quote");
  cursor.advance();
  const triple = cursor.ch() === quote && cursor.chAt(1) === quote;
  if (triple) {
    cursor.advance();
    cursor.advance();
  }
  while (!cursor.eof()) {
    const ch = cursor.ch();
    if (ch === "\\") {
      cursor.advance(); // backslash
      if (cursor.eof()) throw new ParseError("unterminated string");
      const esc = cursor.ch();
      // A bytes literal's source must be ASCII EVERYWHERE, including the char
      // consumed after a backslash (raw or ordinary). CPython's bytes tokenizer
      // rejects a non-ASCII byte even inside an escape. str literals allow it.
      if (isBytes && cursor.codePoint() > 0x7f) {
        throw new ParseError("bytes literal must be ASCII");
      }
      if (isRaw) {
        // Raw strings/bytes keep backslashes literally; the backslash only
        // prevents the next char from terminating. An odd trailing backslash
        // rejects (the would-be closing quote gets escaped). Raw does NOT
        // resolve \u/\U/\N — they are preserved literally.
        cursor.advance();
        continue;
      }
      if (esc === "x") {
        cursor.advance();
        readHexValue(cursor, 2, "hex");
      } else if (esc === "u" || esc === "U") {
        if (isBytes) {
          // In a bytes literal, \u and \U are UNRECOGNIZED escapes: the
          // backslash and letter are preserved literally (CPython emits a
          // DeprecationWarning, not an error). Consume just the letter; any
          // following hex digits are ordinary bytes-literal characters.
          cursor.advance();
        } else {
          readHexEscapeContent(cursor, esc === "u" ? 4 : 8, esc === "u" ? "\\u" : "\\U");
        }
      } else if (esc === "N") {
        if (isBytes) {
          // \N in a bytes literal is an unrecognized escape: preserve ``\N{...}``
          // literally. Consume the ``N``; the ``{...}`` is ordinary bytes text
          // (each byte ASCII-checked by the common-content branch).
          cursor.advance();
        } else {
          cursor.advance(); // N
          readNamedEsc(cursor);
        }
      } else if (isOctDigit(esc)) {
        // Octal escape: consume up to 3 octal digits (the first is ``esc``).
        cursor.advance();
        let n = 1;
        while (n < 3 && isOctDigit(cursor.ch())) {
          cursor.advance();
          n++;
        }
      } else {
        // Single-char escape (recognized like \n, or unknown like \d): both
        // allowed; the backslash is consumed with the char. A backslash before
        // a newline is a line continuation (allowed in non-triple and triple
        // strings; CRLF is consumed as one continuation). The char after a
        // line continuation in a bytes literal must also be ASCII.
        if (esc === "\r") {
          cursor.advance();
          if (cursor.ch() === "\n") cursor.advance();
          if (isBytes && !cursor.eof() && cursor.codePoint() > 0x7f) {
            throw new ParseError("bytes literal must be ASCII");
          }
        } else {
          cursor.advance();
        }
      }
      continue;
    }
    if (ch === quote) {
      if (triple) {
        // A triple string closes ONLY on three consecutive matching quotes. A
        // single embedded quote (or a run of fewer than 3) is content.
        if (cursor.chAt(1) === quote && cursor.chAt(2) === quote) {
          cursor.advance();
          cursor.advance();
          cursor.advance();
          return { type: "STRING", start, end: cursor.cp, isBytes, isFstring };
        }
        // Not a closing triple: this quote is content. (Bare newlines, NUL and
        // non-ASCII bytes are handled by the common-content branch below.)
      } else {
        cursor.advance();
        return { type: "STRING", start, end: cursor.cp, isBytes, isFstring };
      }
    }
    if (triple) {
      // Triple-quoted strings allow bare newlines; CRLF, LF, CR are line
      // terminators. A real NUL or (for bytes) a non-ASCII byte still rejects.
      if (ch === "\0") throw new ParseError("NUL byte in string");
      if (isBytes && cursor.codePoint() > 0x7f) {
        throw new ParseError("bytes literal must be ASCII");
      }
      cursor.advance();
      continue;
    }
    // Non-triple: a bare newline (LF/CR/CRLF) terminates => unterminated.
    if (ch === "\n" || ch === "\r") throw new ParseError("unterminated string");
    if (ch === "\0") throw new ParseError("NUL byte in string");
    if (isBytes && cursor.codePoint() > 0x7f) {
      throw new ParseError("bytes literal must be ASCII");
    }
    cursor.advance();
  }
  throw new ParseError("unterminated string");
}

// CPython's identifier start/continue predicates (cpython v3.11.0
// Parser/tokenizer.c): start = ASCII a-z/A-Z/``_`` or any byte >= 128;
// continue = ASCII a-z/A-Z/0-9/``_`` or any byte >= 128. (``$`` is NOT a
// valid identifier start in CPython — it is a JS-only extension.) Non-ASCII
// starts are then validated by ``verify_identifier`` (XID_Start/XID_Continue);
// for this parser's tiny accepted surface only ``set`` and the keyword
// constants matter, so XID validity is checked via ``\p{XID_Start}`` for the
// first code point and ``\p{XID_Continue}`` for the rest.
function isIdentStartCp(cp) {
  if (cp === 0x5f) return true; // underscore (special-cased, not XID_Start)
  if (cp < 0x80) return (cp >= 0x61 && cp <= 0x7a) || (cp >= 0x41 && cp <= 0x5a);
  return /\p{XID_Start}/u.test(String.fromCodePoint(cp));
}
function isIdentContCp(cp) {
  if (cp === 0x5f) return true;
  if (cp < 0x80) return (cp >= 0x61 && cp <= 0x7a) || (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x30 && cp <= 0x39);
  return /\p{XID_Continue}/u.test(String.fromCodePoint(cp));
}

function tokenizeIdentifier(cursor) {
  const start = cursor.cp;
  const startI = cursor.i;
  const firstCp = cursor.codePoint();
  if (!isIdentStartCp(firstCp)) throw new ParseError("not an identifier");
  cursor.advance();
  while (!cursor.eof()) {
    const cp = cursor.codePoint();
    if (!isIdentContCp(cp)) break;
    cursor.advance();
  }
  // Raw (un-normalized) identifier text. NFKC normalization for the ``set``
  // call path is applied in the parser; keyword constants are matched on the
  // RAW ASCII text (CPython recognizes True/False/None at tokenize time before
  // normalization, so a non-ASCII spelling is a NAME, not a keyword constant).
  const value = cursor.s.slice(startI, cursor.i);
  return { type: "NAME", start, end: cursor.cp, value };
}

function tokenize(s) {
  // A real NUL byte anywhere in the source is rejected by CPython's tokenizer
  // (it cannot appear in source outside a literal). An escaped ``\x00`` inside
  // a string literal is valid and handled by tokenizeString.
  if (s.indexOf("\0") >= 0) throw new ParseError("NUL byte in source");
  const cursor = new Cursor(s);
  const tokens = [];
  while (true) {
    skipTrivia(cursor);
    if (cursor.eof()) break;
    const start = cursor.cp;
    const ch = cursor.ch();
    if (ch === "." && cursor.chAt(1) === "." && cursor.chAt(2) === ".") {
      cursor.advance();
      cursor.advance();
      cursor.advance();
      tokens.push({ type: "ELLIPSIS", start, end: cursor.cp });
      continue;
    }
    if (ch === '"' || ch === "'" || /[bBrRuUfF]/.test(ch)) {
      // A prefix letter could also start an identifier; only treat as a string
      // if a quote actually follows the optional prefix run.
      const saveI = cursor.i;
      const saveCp = cursor.cp;
      let k = 0;
      while (k < 2 && /[bBrRuUfF]/.test(cursor.s[cursor.i + k] || "")) k++;
      if (cursor.s[cursor.i + k] === '"' || cursor.s[cursor.i + k] === "'") {
        tokens.push(tokenizeString(cursor));
        continue;
      }
      cursor.i = saveI;
      cursor.cp = saveCp;
      tokens.push(tokenizeIdentifier(cursor));
      continue;
    }
    if (isDecDigit(ch) || (ch === "." && isDecDigit(cursor.chAt(1)))) {
      tokens.push(tokenizeNumber(cursor));
      continue;
    }
    if ("[](){},:+-*~".includes(ch)) {
      cursor.advance();
      tokens.push({ type: "OP", value: ch, start, end: cursor.cp });
      continue;
    }
    // Identifier start: ASCII letter/underscore OR any non-ASCII code point
    // (CPython accepts c>=128 as a potential identifier start, then validates
    // via XID). ``$`` is NOT a valid identifier start (JS-only extension).
    const cp = cursor.codePoint();
    if (isIdentStartCp(cp)) {
      tokens.push(tokenizeIdentifier(cursor));
      continue;
    }
    throw new ParseError("unexpected character " + JSON.stringify(ch));
  }
  return tokens;
}

// --- parser (recursive descent) -----------------------------------------------

// CPython's tokenizer limits bracket/paren/brace nesting to 200 (the ``nesting``
// counter in Parser/tokenize.c, ``MAXNesting``). This port enforces the same
// limit at parse time: each container open (``[``/``(``/``{``) increments the
// counter, and exceeding 200 rejects before the JS stack would overflow.
const MAX_NESTING = 200;
let parseNesting = 0;
function openContainer() {
  parseNesting++;
  if (parseNesting > MAX_NESTING) throw new ParseError("nesting limit exceeded");
}
function closeContainer() {
  parseNesting--;
}

function mk(kind, start, end, count, extra) {
  return Object.assign({ kind, start, end, count }, extra);
}
function sumCount(nodes) {
  let s = 0;
  for (const n of nodes) if (n) s += n.count;
  return s;
}

function parseExpression(tokens, pos) {
  // Expression := Additive
  return parseAdditive(tokens, pos);
}

function parseAdditive(tokens, pos) {
  // Additive := Unary ((+|-) Unary)*  (left-associative). Only ``+``/``-`` are
  // infix here; any other operator leaves leftover tokens => reject.
  let r = parseUnary(tokens, pos);
  let node = r.node;
  pos = r.pos;
  while (tokens[pos] && tokens[pos].type === "OP" && (tokens[pos].value === "+" || tokens[pos].value === "-")) {
    const opTok = tokens[pos];
    const op = opTok.value === "+" ? "Add" : "Sub";
    pos++;
    const right = parseUnary(tokens, pos);
    node = mk("BinOp", node.start, right.node.end, 1 + 1 + node.count + right.node.count, {
      op,
      left: node,
      right: right.node,
    });
    pos = right.pos;
  }
  return { node, pos };
}

function parseUnary(tokens, pos) {
  // Unary := (+|-) Unary | Primary. Nested unary (``--1``) parses but is
  // rejected by validateLiteral (a signed operand may only be a Constant).
  const tok = tokens[pos];
  if (tok && tok.type === "OP" && (tok.value === "+" || tok.value === "-")) {
    const op = tok.value === "-" ? "USub" : "UAdd";
    const inner = parseUnary(tokens, pos + 1);
    const node = mk("UnaryOp", tok.start, inner.node.end, 1 + 1 + inner.node.count, {
      op,
      operand: inner.node,
    });
    return { node, pos: inner.pos };
  }
  return parsePrimary(tokens, pos);
}

function parseStringLiteral(tokens, pos) {
  // Adjacent string/bytes literals merge into ONE Constant (CPython implicit
  // concatenation). Mixed str/bytes is a SyntaxError => reject. Any f-string
  // member marks the merged Constant f-string => reject in validateLiteral.
  const first = tokens[pos];
  let isBytes = first.isBytes;
  let isFstring = !!first.isFstring;
  let end = first.end;
  pos++;
  while (tokens[pos] && tokens[pos].type === "STRING") {
    const next = tokens[pos];
    if (next.isBytes !== isBytes) throw new ParseError("cannot mix bytes and nonbytes literals");
    if (next.isFstring) isFstring = true;
    end = next.end;
    pos++;
  }
  const node = mk("Constant", first.start, end, 1, {
    valueType: isBytes ? "bytes" : "str",
    isFstring,
  });
  return { node, pos };
}

function parseCall(tokens, pos) {
  // Call := NAME '(' [expr (',' expr)* [',']] ')'. Keywords (``name=value``)
  // cannot tokenize (``=`` is not a token) so a call that parses has no
  // keywords; validateLiteral accepts only empty ``set()``. The function name
  // is NFKC-normalized (CPython normalizes identifier names in the AST), so a
  // fullwidth ``ｓｅｔ()`` normalizes to ``set`` and is accepted. Keyword
  // constants (True/False/None) are matched on raw ASCII in parsePrimary, so
  // a non-ASCII spelling of them stays a NAME and rejects here.
  const nameTok = tokens[pos];
  const normalizedValue = nameTok.value.normalize("NFKC");
  const name = mk("Name", nameTok.start, nameTok.end, 1, { value: normalizedValue });
  pos += 2; // NAME and '('
  const args = [];
  if (tokens[pos] && tokens[pos].type === "OP" && tokens[pos].value === ")") {
    pos++;
    return { node: mk("Call", nameTok.start, tokens[pos - 1].end, 1 + name.count, { func: name, args }), pos };
  }
  while (true) {
    const r = parseExpression(tokens, pos);
    args.push(r.node);
    pos = r.pos;
    const sep = tokens[pos];
    if (!sep || sep.type !== "OP") throw new ParseError("call missing close");
    if (sep.value === ")") {
      pos++;
      return { node: mk("Call", nameTok.start, sep.end, 1 + name.count + sumCount(args), { func: name, args }), pos };
    }
    if (sep.value === ",") {
      pos++;
      if (tokens[pos] && tokens[pos].type === "OP" && tokens[pos].value === ")") {
        pos++;
        return { node: mk("Call", nameTok.start, tokens[pos - 1].end, 1 + name.count + sumCount(args), { func: name, args }), pos };
      }
      continue;
    }
    throw new ParseError("call missing close");
  }
}

function parsePrimary(tokens, pos) {
  const tok = tokens[pos];
  if (!tok) throw new ParseError("unexpected end");
  if (tok.type === "STRING") return parseStringLiteral(tokens, pos);
  if (tok.type === "NUMBER") {
    return {
      node: mk("Constant", tok.start, tok.end, 1, { valueType: tok.numKind, isFstring: false }),
      pos: pos + 1,
    };
  }
  if (tok.type === "ELLIPSIS") {
    return {
      node: mk("Constant", tok.start, tok.end, 1, { valueType: "ellipsis", isFstring: false }),
      pos: pos + 1,
    };
  }
  if (tok.type === "NAME") {
    if (tok.value === "True" || tok.value === "False") {
      return { node: mk("Constant", tok.start, tok.end, 1, { valueType: "bool", isFstring: false }), pos: pos + 1 };
    }
    if (tok.value === "None") {
      return { node: mk("Constant", tok.start, tok.end, 1, { valueType: "none", isFstring: false }), pos: pos + 1 };
    }
    // A bare name followed by '(' is a call (e.g. ``set()``).
    if (tokens[pos + 1] && tokens[pos + 1].type === "OP" && tokens[pos + 1].value === "(") {
      return parseCall(tokens, pos);
    }
    return { node: mk("Name", tok.start, tok.end, 1, { value: tok.value }), pos: pos + 1 };
  }
  if (tok.type === "OP") {
    if (tok.value === "[") return parseList(tokens, pos);
    if (tok.value === "(") return parseTupleOrParen(tokens, pos);
    if (tok.value === "{") return parseSetOrDict(tokens, pos);
  }
  throw new ParseError("unexpected token");
}

function parseList(tokens, pos) {
  const open = tokens[pos];
  const start = open.start;
  pos++;
  openContainer();
  try {
    const elts = [];
    if (tokens[pos] && tokens[pos].type === "OP" && tokens[pos].value === "]") {
      pos++;
      return { node: mk("List", start, tokens[pos - 1].end, 1 + sumCount(elts), { elts }), pos };
    }
    while (true) {
      const r = parseExpression(tokens, pos);
      elts.push(r.node);
      pos = r.pos;
      const sep = tokens[pos];
      if (!sep || sep.type !== "OP") throw new ParseError("list missing close");
      if (sep.value === "]") {
        pos++;
        return { node: mk("List", start, sep.end, 1 + sumCount(elts), { elts }), pos };
      }
      if (sep.value === ",") {
        pos++;
        if (tokens[pos] && tokens[pos].type === "OP" && tokens[pos].value === "]") {
          pos++;
          return { node: mk("List", start, tokens[pos - 1].end, 1 + sumCount(elts), { elts }), pos };
        }
        continue;
      }
      throw new ParseError("list missing close");
    }
  } finally {
    closeContainer();
  }
}

function parseTupleOrParen(tokens, pos) {
  const open = tokens[pos];
  const start = open.start;
  pos++;
  openContainer();
  try {
    if (tokens[pos] && tokens[pos].type === "OP" && tokens[pos].value === ")") {
      pos++;
      return { node: mk("Tuple", start, tokens[pos - 1].end, 1, { elts: [] }), pos };
    }
    const first = parseExpression(tokens, pos);
    pos = first.pos;
    const sep = tokens[pos];
    if (sep && sep.type === "OP" && sep.value === ")") {
      pos++;
      // Parenthesized single expression: parens do not create a node, the inner
      // expression keeps its own source span, so the list span check rejects
      // ``([1,2])`` (the inner List does not span the outer parens).
      return { node: first.node, pos };
    }
    const elts = [first.node];
    if (!sep || sep.type !== "OP" || sep.value !== ",") throw new ParseError("paren malformed");
    pos++;
    while (true) {
      const next = tokens[pos];
      if (next && next.type === "OP" && next.value === ")") {
        pos++;
        return { node: mk("Tuple", start, next.end, 1 + sumCount(elts), { elts }), pos };
      }
      const r = parseExpression(tokens, pos);
      elts.push(r.node);
      pos = r.pos;
      const sep2 = tokens[pos];
      if (!sep2 || sep2.type !== "OP") throw new ParseError("tuple missing close");
      if (sep2.value === ")") {
        pos++;
        return { node: mk("Tuple", start, sep2.end, 1 + sumCount(elts), { elts }), pos };
      }
      if (sep2.value === ",") {
        pos++;
        continue;
      }
      throw new ParseError("tuple missing close");
    }
  } finally {
    closeContainer();
  }
}

function parseSetOrDict(tokens, pos) {
  const open = tokens[pos];
  const start = open.start;
  pos++;
  openContainer();
  try {
    if (tokens[pos] && tokens[pos].type === "OP" && tokens[pos].value === "}") {
      pos++;
      // ``{}`` is an empty dict, never an empty set.
      return { node: mk("Dict", start, tokens[pos - 1].end, 1, { keys: [], values: [] }), pos };
    }
    const first = parseExpression(tokens, pos);
    pos = first.pos;
    const sep = tokens[pos];
    if (sep && sep.type === "OP" && sep.value === ":") {
      pos++;
      const val = parseExpression(tokens, pos);
      pos = val.pos;
      const keys = [first.node];
      const values = [val.node];
      const close = tokens[pos];
      if (close && close.type === "OP" && close.value === "}") {
        pos++;
        return { node: mk("Dict", start, close.end, 1 + sumCount(keys) + sumCount(values), { keys, values }), pos };
      }
      if (!close || close.type !== "OP" || close.value !== ",") throw new ParseError("dict missing close");
      pos++;
      while (true) {
        const next = tokens[pos];
        if (next && next.type === "OP" && next.value === "}") {
          pos++;
          return { node: mk("Dict", start, next.end, 1 + sumCount(keys) + sumCount(values), { keys, values }), pos };
        }
        const k = parseExpression(tokens, pos);
        pos = k.pos;
        const colon = tokens[pos];
        if (!colon || colon.type !== "OP" || colon.value !== ":") throw new ParseError("dict missing colon");
        pos++;
        const v = parseExpression(tokens, pos);
        pos = v.pos;
        keys.push(k.node);
        values.push(v.node);
        const sep2 = tokens[pos];
        if (!sep2 || sep2.type !== "OP") throw new ParseError("dict missing close");
        if (sep2.value === "}") {
          pos++;
          return { node: mk("Dict", start, sep2.end, 1 + sumCount(keys) + sumCount(values), { keys, values }), pos };
        }
        if (sep2.value === ",") {
          pos++;
          continue;
        }
        throw new ParseError("dict missing close");
      }
    }
    // Set.
    const elts = [first.node];
    if (!sep || sep.type !== "OP") throw new ParseError("set missing close");
    if (sep.value === "}") {
      pos++;
      return { node: mk("Set", start, sep.end, 1 + sumCount(elts), { elts }), pos };
    }
    if (sep.value !== ",") throw new ParseError("set malformed");
    pos++;
    while (true) {
      const next = tokens[pos];
      if (next && next.type === "OP" && next.value === "}") {
        pos++;
        return { node: mk("Set", start, next.end, 1 + sumCount(elts), { elts }), pos };
      }
      const r = parseExpression(tokens, pos);
      elts.push(r.node);
      pos = r.pos;
      const sep2 = tokens[pos];
      if (!sep2 || sep2.type !== "OP") throw new ParseError("set missing close");
      if (sep2.value === "}") {
        pos++;
        return { node: mk("Set", start, sep2.end, 1 + sumCount(elts), { elts }), pos };
      }
      if (sep2.value === ",") {
        pos++;
        continue;
      }
      throw new ParseError("set missing close");
    }
  } finally {
    closeContainer();
  }
}

// --- literal_eval-equivalent validation ---------------------------------------
// ``numKind``/``signedNumKind``/``isHashable``/``validateLiteral`` (the
// ``ast.literal_eval``-equivalent node checks) live in
// native-python-literal-validation.mjs. They are pure functions over the
// plain-data AST nodes this parser emits and hold no parser/tokenizer state.
import { validateLiteral } from "./native-python-literal-validation.mjs";

// Returns null if the candidate is not a valid Python list literal within the
// pinned bounds, or a plain record describing the accepted literal otherwise.
export function parsePythonListLiteral(candidate) {
  if (codePointLength(candidate) > 65536) return null;
  let top;
  try {
    const tokens = tokenize(candidate);
    if (tokens.length === 0) return null;
    parseNesting = 0; // reset the bracket-nesting counter per parse
    const r = parseExpression(tokens, 0);
    top = r.node;
    // A pure-literal top expression must consume every token; any leftover
    // (a second expression, a trailing operator, or junk) means the top is
    // not the single literal Python would have parsed.
    if (r.pos !== tokens.length) return null;
  } catch (err) {
    return null;
  }
  if (top.kind !== "List") return null;
  if (top.start !== 0 || top.end !== codePointLength(candidate)) return null;
  // +1 for the implicit ``ast.Expression`` wrapper that ``ast.walk`` counts.
  const nodeCount = 1 + top.count;
  if (nodeCount > 4096) return null;
  if (!validateLiteral(top)) return null;
  return { nodeCount, start: top.start, end: top.end };
}

export function isPythonListLiteral(candidate) {
  return parsePythonListLiteral(candidate) !== null;
}
