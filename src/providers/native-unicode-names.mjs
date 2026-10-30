// Unicode named-escape lookup for the ``\N{name}`` string escape, matching
// CPython's ``Modules/unicodedata.c::_getcode`` (cpython v3.11.0) as invoked by
// the ``\N`` escape decoder in ``Objects/unicodeobject.c`` (which calls
// ``ucnhash_capi->getcode(name, namelen, &ch, 0)`` — note the final ``0``:
// ``with_named_seq = 0``). Verified against the parent-pinned
// ``unicodedata-cpython311.c`` lines 1188-1275.
//
// The distinction the parent review flagged: the ``\N`` escape uses
// ``with_named_seq=0``, so ``_check_alias_and_seq`` REJECTS named sequences
// (``IS_NAMED_SEQ``) even though it still resolves aliases (``IS_ALIAS``).
// ``unicodedata.lookup`` uses ``with_named_seq=1`` and CAN resolve named
// sequences — but that path is not reachable from ``\N``. This module
// therefore accepts explicit names + all aliases + algorithmic CJK/Hangul
// forms, and rejects named sequences, exactly like ``\N``.
//
// Case handling (two DIFFERENT rules, matching CPython exactly):
//   - Explicit names + aliases: CPython ``_cmpname`` compares with
//     ``Py_TOUPPER(name[i])``. ``Py_TOUPPER`` is ASCII-ONLY (it is the C
//     ``toupper`` on the low byte); a non-ASCII byte passes through unchanged.
//     So lookup upper-cases only ASCII a-z (NOT JS ``toUpperCase()``, which
//     Unicode-case-folds e.g. ``ß``->``SS`` or fullwidth ``a``->``A``). A
//     name with a non-ASCII byte that does not already match the stored
//     uppercase name rejects.
//   - Algorithmic forms: CPython matches the ``"HANGUL SYLLABLE "`` and
//     ``"CJK UNIFIED IDEOGRAPH-"`` prefixes and the Jamo syllable parts with
//     ``strncmp`` — CASE-SENSITIVE, exact uppercase. Lowercase
//     ``hangul syllable ga`` does NOT match the prefix and falls through to
//     the explicit-name table (where it rejects, since the stored name is
//     not ``hangul syllable ga``). CJK hex digits are likewise case-sensitive
//     uppercase A-F.
//
// Algorithmic forms (matching ``_getcode``):
//   - ``HANGUL SYLLABLE <L><V><T>``: ``find_syllable`` matches each of L/V/T
//     longest-first against the pinned ``hangul_syllables`` columns using
//     case-sensitive ``strncmp``. EMPTY Jamo short names match with length 0
//     (``strncmp(str,"",0)==0`` is always true): e.g. L index 11 (IEUNG,
//     empty) is a valid L, so ``HANGUL SYLLABLE A`` = U+C544. The code point
//     is ``SBase + (L*VCount + V)*TCount + T``. The whole remainder must be
//     consumed.
//   - ``CJK UNIFIED IDEOGRAPH-<hex>``: exactly 4 or 5 uppercase hex digits
//     (``[0-9A-F]``; lowercase rejects) naming a code point inside one of the
//     8 pinned ``is_unified_ideograph`` ranges.
//
// This module loads the bundled data JSON (native-unicode-names-data.json)
// once at import and builds name->code-point maps. It performs NO network
// access and NO eval/Function. ``lookupUnicodeName`` returns the code point
// (number) for an accepted name, or ``null`` for an unknown/rejected name.

import data from "./native-unicode-names-data.json" with { type: "json" };

const HANGUL = data.hangul;
const SBase = HANGUL.sBase;
const VCount = HANGUL.vCount;
const TCount = HANGUL.tCount;

// ASCII-only upper-case matching CPython ``Py_TOUPPER`` (C ``toupper`` on the
// low byte). Non-ASCII bytes pass through UNCHANGED — they are NOT folded to
// an ASCII uppercase (JS ``String.prototype.toUpperCase`` would fold e.g.
// U+FF21 fullwidth A to U+0041, which CPython does not do for the \N lookup).
function pyToUpperChar(c) {
  const code = c.charCodeAt(0);
  if (code >= 0x61 && code <= 0x7a) return String.fromCharCode(code - 32);
  return c;
}
function pyToUpperAscii(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) out += pyToUpperChar(s[i]);
  return out;
}

// ``find_syllable`` parity: iterate the column, keep the LONGEST matching
// prefix via case-sensitive comparison. An EMPTY short name (length 0) matches
// with length 0: ``strncmp(str, "", 0) == 0`` is always true, and
// ``len1(0) <= *len(-1)`` is false so the match is taken (the first empty
// entry wins ties because later empties have ``len1(0) <= *len(0)`` = true
// and are skipped). Returns {index, length} or null only if NO entry (empty
// or not) matched — but the empty entry always matches, so this never returns
// null for a column that contains an empty name (L and T do; V does not).
function findSyllable(str, names, count) {
  let bestLen = -1;
  let bestIdx = -1;
  for (let i = 0; i < count; i++) {
    const s = names[i];
    if (s.length <= bestLen) continue; // ties skip (CPython ``len1 <= *len``)
    if (str.startsWith(s)) { // case-sensitive; "" matches anything with len 0
      bestLen = s.length;
      bestIdx = i;
    }
  }
  if (bestIdx < 0) return null; // no match (only possible for a column w/o "")
  return { index: bestIdx, length: bestLen };
}

function resolveHangulSyllable(rest) {
  // ``rest`` is the part after the case-sensitive ``HANGUL SYLLABLE `` prefix.
  // L, V, T are matched case-sensitively (CPython strncmp). The whole remainder
  // must be consumed.
  const l = findSyllable(rest, HANGUL.lNames, HANGUL.lCount);
  if (!l) return null; // L column has "" so this never happens, but keep the guard
  let pos = l.length;
  const v = findSyllable(rest.slice(pos), HANGUL.vNames, HANGUL.vCount);
  if (!v) return null; // V column has no "" -> a bad V rejects
  pos += v.length;
  const t = findSyllable(rest.slice(pos), HANGUL.tNames, HANGUL.tCount);
  if (!t) return null; // T column has "" so trailing-empty is T index 0
  pos += t.length;
  if (pos !== rest.length) return null; // must consume exactly the remainder
  return SBase + (l.index * VCount + v.index) * TCount + t.index;
}

const HEX = /^[0-9A-F]+$/;
function resolveCjkIdeograph(rest) {
  // ``rest`` is the part after the case-sensitive ``CJK UNIFIED IDEOGRAPH-``
  // prefix. CPython requires exactly 4 or 5 hex digits and uppercase A-F
  // (lowercase rejects via the explicit 'A'..'F' check), and the code point
  // must fall in one of the unified-ideograph ranges.
  if (rest.length !== 4 && rest.length !== 5) return null;
  if (!HEX.test(rest)) return null;
  const v = parseInt(rest, 16);
  for (const [lo, hi] of data.cjkRanges) {
    if (v >= lo && v <= hi) return v;
  }
  return null;
}

// Build the explicit-name and alias lookup maps once. Keys are the stored
// names (already uppercase in the data); queries are ASCII-upper-cased to
// match CPython ``_cmpname``'s ``Py_TOUPPER`` (non-ASCII passes through).
const nameToCode = new Map();
for (let i = 0; i < data.codePoints.length; i++) {
  nameToCode.set(data.names[i], data.codePoints[i]);
}
const aliasToCode = new Map();
for (let i = 0; i < data.aliasCodePoints.length; i++) {
  aliasToCode.set(data.aliasNames[i], data.aliasCodePoints[i]);
}

const HANGUL_PREFIX = "HANGUL SYLLABLE ";
const CJK_PREFIX = "CJK UNIFIED IDEOGRAPH-";

// Resolve a Unicode character name as the ``\N{name}`` escape does. Returns
// the code point (number) or ``null`` if the name is unknown / a named
// sequence / a malformed algorithmic form. Pure and synchronous.
export function lookupUnicodeName(name) {
  if (typeof name !== "string" || name.length === 0) return null;
  // Algorithmic prefixes are matched CASE-SENSITIVELY (CPython ``strncmp``).
  // A lowercase prefix does not match and falls through to the explicit-name
  // table (which rejects it, since the stored name is the canonical form).
  if (name.startsWith(HANGUL_PREFIX)) {
    return resolveHangulSyllable(name.slice(HANGUL_PREFIX.length));
  }
  if (name.startsWith(CJK_PREFIX)) {
    return resolveCjkIdeograph(name.slice(CJK_PREFIX.length));
  }
  // Explicit name, then alias. ASCII-only upper-case (Py_TOUPPER); a non-ASCII
  // byte is NOT folded into an ASCII uppercase, so e.g. a fullwidth-letter name
  // does not match the stored ASCII-uppercase name.
  const up = pyToUpperAscii(name);
  if (nameToCode.has(up)) return nameToCode.get(up);
  if (aliasToCode.has(up)) return aliasToCode.get(up);
  return null;
}

// Exposed for testing: the pinned Unicode version and data provenance.
export const unicodeVersion = data.unicodeVersion;
export const nameCount = data.codePoints.length;
export const aliasCount = data.aliasCodePoints.length;
export const sourceProvenance = data.source || null;
