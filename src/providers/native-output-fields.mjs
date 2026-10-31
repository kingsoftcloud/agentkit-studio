// Compile explicit JSON object field lists; never infer field values or
// semantics.
//
// Ports ``ksadk/studio/native_output_fields.py`` (declared_object_fields and
// its private regexes) from the pinned reference commit
// 355059d78e47ed764bbdb3606304cdf34e9838a3. Only the recognized final-output
// clauses supplied by Studio are eligible: bare keys are ASCII identifiers,
// other supported keys need explicit quotes (backtick or double-quote), and
// Chinese (CJK) keys may appear bare inside quotes. Unknown syntax, duplicate
// keys, conflicting declarations and per-item declarations that disagree add
// no constraint. Nested item declarations do not infer an array or field value
// type. A clause whose shape is not ``json_object`` makes the whole result
// null (conflicting outer shape); a clause that is ``json_object`` but does
// not match the key grammar is simply skipped (no constraint added).
//
// Unicode parity: ``\s`` uses the Python whitespace class (PY_WS) rather than
// JS ``\s``; ``.fullmatch`` is honored via the ``fullMatch`` helper (no
// trailing-newline leak). The key grammar itself is ASCII + an explicit CJK
// range, exactly mirroring the source (``_KEY`` / ``_QUOTED_KEY``); the source
// accepts no astral identifier forms in the quoted form because it only adds
// ``[一-鿿]``.

import { pythonStrip, PY_WS, fullMatch } from "./native-python-list-literal.mjs";

const WS = "[" + PY_WS + "]";

const KEY = "[A-Za-z_][A-Za-z0-9_.\\-]{0,63}";
const QUOTED_KEY = "(?:[A-Za-z_][A-Za-z0-9_.\\-]{0,63}|[一-鿿]{1,32})";
const TOKEN = "(?:" + KEY + "|`" + QUOTED_KEY + "`|\"" + QUOTED_KEY + "\")";
const SEPARATOR =
  WS + "*(?:[,，、]|" + WS + "+(?:and|和|与)" + WS + "+)" + WS + "*";

// Source flags: _LIST and _KEY_CLAUSE use re.I; _ITEM_CLAUSE uses no flag.
// All three are applied with .fullmatch (no ^/$ anchors; fullMatch anchors).
const LIST_RE = new RegExp(TOKEN + "(?:" + SEPARATOR + TOKEN + ")*", "iu");
const SEPARATOR_RE = new RegExp(SEPARATOR, "iu");
const KEY_CLAUSE_RE = new RegExp(
  WS +
    "*(?:(?:最后|最终)(?:请)?|请)?(?:只|仅)(?:回复|输出|返回)" +
    WS +
    "*(?:一个|上述|该)?" +
    WS +
    "*JSON" +
    WS +
    "*对象" +
    WS +
    "*[,，]" +
    WS +
    "*(?:键|字段)(?:仅)?(?:为|是)" +
    WS +
    "*(?<keys>.*)",
  "iu"
);
const ITEM_CLAUSE_RE = new RegExp(
  WS +
    "*(?<field>" +
    TOKEN +
    ")" +
    WS +
    "*的?" +
    WS +
    "*每项(?:键|字段)(?:为|是)" +
    WS +
    "*(?<keys>.*)",
  "u"
);
const SEMICOLON_RE = /[;；]/;

function stripChars(s, chars) {
  const set = new Set(chars);
  const arr = Array.from(s);
  let start = 0;
  let end = arr.length;
  while (start < end && set.has(arr[start])) start++;
  while (end > start && set.has(arr[end - 1])) end--;
  return arr.slice(start, end).join("");
}

function fullMatchExec(re, s) {
  const m = re.exec(s);
  return m !== null && m.index === 0 && m[0].length === s.length ? m : null;
}

function keysFromListing(listing) {
  const stripped = pythonStrip(listing);
  if (!fullMatch(LIST_RE, stripped)) return null;
  const tokens = stripped.split(SEPARATOR_RE);
  const keys = tokens.map((t) => stripChars(t, "`\""));
  if (keys.length > 32 || new Set(keys).size !== keys.length) return null;
  return keys;
}

// ``clauses`` is an array of ``[shape, clauseText]`` pairs as produced by
// ``structuredJsonClauses`` in native-final-shape.mjs. Returns a sorted array
// of field names when a single unambiguous explicit key set is declared, or
// ``null`` when the clauses conflict or carry no recognized declaration.
export function declaredObjectFields(clauses) {
  const sets = [];
  for (const [shape, clause] of clauses) {
    if (shape !== "json_object") return null;
    const parts = clause.split(SEMICOLON_RE);
    const match = fullMatchExec(KEY_CLAUSE_RE, parts[0]);
    if (!match) continue;
    const keys = keysFromListing(match.groups.keys);
    if (keys === null) return null;
    for (let i = 1; i < parts.length; i++) {
      const item = fullMatchExec(ITEM_CLAUSE_RE, parts[i]);
      if (item === null) return null;
      if (!keys.includes(stripChars(item.groups.field, "`\""))) return null;
      if (keysFromListing(item.groups.keys) === null) return null;
    }
    sets.push(new Set(keys));
  }
  if (sets.length === 0) return null;
  const first = sets[0];
  for (let i = 1; i < sets.length; i++) {
    if (sets[i].size !== first.size) return null;
    for (const k of first) if (!sets[i].has(k)) return null;
  }
  return Array.from(first).sort();
}
