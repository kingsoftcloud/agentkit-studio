// Shared Python text-parity helpers.
//
// Pure string/whitespace primitives that mirror CPython ``str``/``re`` behavior,
// reused by the Python literal validator (``native-python-list-literal.mjs``)
// and the output-field/object-field shape modules. Extracted from
// ``native-python-list-literal.mjs`` to keep each source below the 1000-line
// gate without inlining, raising the gate, or dropping documentation.
//
// ``isPySpaceCp`` is the Python ``str.isspace()`` / ``re`` ``\s`` code-point
// set: ASCII whitespace, U+001C-001F, U+0085 (NEL), and the Unicode Zs/Zl/Zp
// separators. U+FEFF (category Cf) is intentionally NOT whitespace in Python.
// This is NARROWER than nothing — it is the exact ``str``/``re`` set, distinct
// from the source-trivia set (ASCII space/tab/formfeed/CR/LF only) the
// tokenizer accepts between tokens; a source byte like U+00A0 between tokens
// is a syntax error even though ``str.isspace()`` is true.

export function codePointLength(s) {
  // Number of Unicode code points, matching Python ``len(str)``.
  let n = 0;
  for (let i = 0; i < s.length; ) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const c2 = s.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        i += 2;
        n++;
        continue;
      }
    }
    i++;
    n++;
  }
  return n;
}

function isPySpaceCp(cp) {
  // Python ``str.isspace()`` / ``re`` ``\s`` code-point set: ASCII whitespace,
  // U+001C-001F, U+0085 (NEL), and the Unicode Zs/Zl/Zp separators. U+FEFF
  // (category Cf) is intentionally NOT whitespace in Python.
  return (
    (cp >= 0x09 && cp <= 0x0d) ||
    cp === 0x20 ||
    cp === 0x85 ||
    (cp >= 0x1c && cp <= 0x1f) ||
    cp === 0xa0 ||
    cp === 0x1680 ||
    (cp >= 0x2000 && cp <= 0x200a) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    cp === 0x202f ||
    cp === 0x205f ||
    cp === 0x3000
  );
}

// Regex char-class source matching Python ``\s`` (for building faithful
// ``new RegExp(..., "iu")`` patterns in the other modules). Excludes U+FEFF.
export const PY_WS =
  "\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";

export function pythonStrip(s) {
  // ``str.strip()`` parity over the Python ``isspace`` set.
  const arr = Array.from(s);
  let start = 0;
  let end = arr.length;
  while (start < end && isPySpaceCp(arr[start].codePointAt(0))) start++;
  while (end > start && isPySpaceCp(arr[end - 1].codePointAt(0))) end--;
  return arr.slice(start, end).join("");
}

export function pythonLstrip(s) {
  const arr = Array.from(s);
  let start = 0;
  const end = arr.length;
  while (start < end && isPySpaceCp(arr[start].codePointAt(0))) start++;
  return arr.slice(start).join("");
}

export function pythonSplitLines(s) {
  // ``str.splitlines()`` parity over Python's full line-boundary set; a
  // trailing boundary does not produce a trailing empty element. Built via
  // the RegExp constructor so U+2028/U+2029 (which cannot appear in a regex
  // literal) enter the pattern as ordinary class members.
  if (s === "") return [];
  const parts = [];
  let start = 0;
  const re = new RegExp(
    "\\r\\n|[\\n\\r\\x0b\\x0c\\x1c-\\x1f\\x85" +
      String.fromCharCode(0x2028) +
      String.fromCharCode(0x2029) +
      "]",
    "g"
  );
  let m;
  while ((m = re.exec(s)) !== null) {
    parts.push(s.slice(start, m.index));
    start = re.lastIndex;
  }
  if (start < s.length) parts.push(s.slice(start));
  return parts;
}

export function fullMatch(re, s) {
  // Python ``re.fullmatch`` parity: the pattern must match the ENTIRE string.
  // JS ``$`` lets a trailing ``\n`` sneak through; checking the match spans
  // the whole string restores fullmatch semantics regardless of ``$``.
  const m = re.exec(s);
  return m !== null && m.index === 0 && m[0].length === s.length;
}
