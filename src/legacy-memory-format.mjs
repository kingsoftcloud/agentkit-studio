/**
 * Bounded independent Node helper for legacy Memory formatting and SDK response
 * parsing. This module has NO imports from Native core, DSH, stores, cloud
 * clients or credentials, and performs NO I/O. The parent owns service/backend
 * configuration, actual user/Session identity, permission pipeline, durable
 * write intents, Host composition, SDK/HTTP calls and all recovery.
 *
 * This is NOT a replacement for Native read_memory/search_memory/manage_memory.
 * It is a pure formatting/parsing helper for the legacy cloud LTM (long-term
 * memory) QueryMemorySdk response shape and the display format used by the old
 * Python `load_memory` platform builtin.
 *
 * Reference: ksadk/memory/service.py:format_memory_entries @355059d (lines 27-45)
 *   and ksadk/memory/adk/backends/sdk_ltm_backend.py:_parse_query_response /
 *   _parse_memory_item (lines 887-972).
 */

// ---- Python truthiness and str() semantics in the JSON domain -------------

/**
 * Python truthiness for JSON-domain values. Python's `or` operator treats
 * empty containers as falsy, unlike JS where `[]` and `{}` are truthy.
 *
 * Python-falsy: None, False, 0, 0.0, "", empty list [], empty dict {}, NaN.
 * Python-truthy: everything else, including non-empty containers and "0".
 */
function pythonTruthy(value) {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'number') return !Number.isNaN(value) && value !== 0;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true; // functions, symbols, etc. — not reachable from JSON
}

/**
 * Python `or` chain: return the first truthy value, or the last value if all
 * are falsy (Python returns the last operand as-is, not a boolean).
 */
function pythonOr(...values) {
  for (let i = 0; i < values.length; i++) {
    if (pythonTruthy(values[i])) return values[i];
  }
  return values[values.length - 1];
}

/**
 * Python `str()` for JSON-domain scalar values. The reference only calls
 * `str()` on non-container values (dict/list go through `json.dumps`).
 *
 * Python str() vs JS String() differences:
 *   - Python str(True) → "True",  JS String(true) → "true"
 *   - Python str(False) → "False", JS String(false) → "false"
 *   - Python str(None) → "None",  JS String(null) → "null"
 *   - Numbers: str(42) → "42", str(3.14) → "3.14" — same as JS for finite values.
 *
 * This function is called for non-string, non-container values that the
 * reference passes through `str()`. For booleans and null, it produces the
 * Python repr. For numbers, JS and Python agree on finite integer and float
 * string forms within JSON's numeric domain.
 */
function pythonStr(value) {
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (value === null) return 'None';
  // Numbers: JS String(42) === Python str(42); JS String(3.14) === Python str(3.14).
  // Python str(float('inf')) → 'inf', JS String(Infinity) → 'Infinity' — a
  // difference, but Infinity/NaN are not valid JSON and unreachable here.
  return String(value);
}

// ---- formatLegacyMemoryEntries --------------------------------------------

/**
 * formatLegacyMemoryEntries(entries): string[] -> string
 *
 * Reproduces ksadk/memory/service.py:format_memory_entries (lines 27-45):
 *   - Empty array → "" (not "未找到")
 *   - For each entry (1-indexed): try JSON.parse; if the result is a dict
 *     with a truthy `parts` (Python truthy — empty array is falsy) whose
 *     first element is a dict, display `str(parts[0].text or original)`.
 *     The Python `or` falls back to the original entry string when `text`
 *     is falsy (empty string, 0, false, None, [], {}).
 *   - Join with "\n\n"
 *
 * Rejects non-array input or non-string entries with `legacy_memory_entries_invalid`.
 *
 * Python str() vs JS String() for `parts[0].text`: when `text` is truthy and
 * is a boolean, Python str(True) → "True" while JS String(true) → "true".
 * This helper uses pythonStr() to produce the Python repr. When `text` is a
 * truthy object/array, the reference calls str() which produces a Python
 * dict/list repr — not a JSON string. This helper rejects that case as
 * malformed non-string text (the wire format uses string text values) rather
 * than producing a divergent "[object Object]" representation.
 */
export function formatLegacyMemoryEntries(entries) {
  if (!Array.isArray(entries)) throw error('legacy_memory_entries_invalid', 'entries must be an array');
  if (entries.length === 0) return '';
  const formatted = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (typeof entry !== 'string') throw error('legacy_memory_entries_invalid', `entry at index ${index} is not a string`);
    let text = entry;
    let payload;
    try { payload = JSON.parse(entry); } catch { payload = null; }
    if (isPlainObject(payload)) {
      // Python: payload.get("parts") or [] — empty array is falsy in Python.
      const rawParts = pythonTruthy(payload.parts) ? payload.parts : [];
      if (pythonTruthy(rawParts) && isPlainObject(rawParts[0])) {
        // Python: str(parts[0].get("text") or text) — Python `or` truthiness.
        const inner = pythonOr(rawParts[0].text, text);
        if (typeof inner === 'string') {
          text = inner;
        } else if (isPlainObject(inner) || Array.isArray(inner)) {
          // Python str({}) → "{'key': ...}" — not reproducible in JS. The wire
          // format uses string text; reject this as malformed.
          throw error('legacy_memory_entries_invalid', `entry at index ${index} has a non-string parts[0].text`);
        } else {
          text = pythonStr(inner);
        }
      }
    }
    formatted.push(`[${index + 1}] ${text}`);
  }
  return formatted.join('\n\n');
}

// ---- parseLegacySdkMemoryEntries -------------------------------------------

/**
 * parseLegacySdkMemoryEntries(payload): string | object -> string[]
 *
 * Parses a QueryMemorySdk response (the `data` field from the cloud reply, not
 * ListMemories and not fabricated structured record IDs). Strict version of
 * sdk_ltm_backend.py:_parse_query_response (lines 887-948) and
 * _parse_memory_item (lines 955-972).
 *
 * Key difference from Python: this parser throws `legacy_memory_response_invalid`
 * on malformed JSON, service error, unrecognized envelope, or malformed entry,
 * so the parent can distinguish backend failure from real empty results. The
 * Python `_parse_query_response` returns [] in all those cases.
 *
 * Supported envelope shapes (exact field names — always "Memories"):
 *   1. { "Memories": [...] } — top-level Memories array
 *   2. { "Data": [...] } — Data array; each item may nest Memories
 *   3. { "Results": [...] } — Results array
 *
 * Item extraction uses Python truthy `or` (not JS nullish ??), so falsy values
 * like "", 0, false, [], {} fall through to the next field. Empty arrays and
 * empty objects are falsy in Python but truthy in JS — this helper uses
 * pythonTruthy to match the reference exactly.
 *
 * For non-string truthy text values:
 *   - dict/list → JSON.stringify (matching Python json.dumps)
 *   - boolean → pythonStr (True/False, not true/false)
 *   - number → String (same as Python str for finite JSON numbers)
 *
 * Preserves content bytes/text and ordering. No truncation or count/size caps.
 */
export function parseLegacySdkMemoryEntries(payload) {
  let data = payload;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { throw error('legacy_memory_response_invalid', 'response is not valid JSON'); }
  }
  if (!isPlainObject(data)) throw error('legacy_memory_response_invalid', 'response is not a JSON object');

  if ('Code' in data && !validCode(data.Code)) throw error('legacy_memory_response_invalid', 'response has a rejected Code');
  if (pythonTruthy(data.Error)) throw error('legacy_memory_response_invalid', 'response has a top-level Error');
  if (data.ResponseMetadata !== undefined) {
    if (!isPlainObject(data.ResponseMetadata)) throw error('legacy_memory_response_invalid', 'ResponseMetadata is not an object');
    if (pythonTruthy(data.ResponseMetadata.Error)) throw error('legacy_memory_response_invalid', 'response has a ResponseMetadata Error');
  }

  if ('Memories' in data) return parseMemoriesArray(data.Memories);
  if ('Data' in data && Array.isArray(data.Data)) return parseDataArray(data.Data);
  if ('Results' in data) return parseResultsArray(data.Results);

  throw error('legacy_memory_response_invalid', 'unrecognized response envelope');
}

// ---- internals ------------------------------------------------------------

function error(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validCode(code) {
  return code === 0 || code === 200 || code === '0' || code === '200';
}

/**
 * Convert a truthy extracted text value to a string.
 * - string → as-is
 * - dict/list → JSON.stringify (Python json.dumps)
 * - boolean → pythonStr ("True"/"False")
 * - number → String (same as Python str for finite JSON numbers)
 * - null → pythonStr ("None") — only reachable if the `or` chain returns None
 *   as the last (all-falsy) operand, which the reference would append as-is.
 */
function textToString(value) {
  if (typeof value === 'string') return value;
  if (isPlainObject(value) || Array.isArray(value)) return JSON.stringify(value);
  return pythonStr(value);
}

/** Format 1: top-level "Memories" array (sdk_ltm_backend.py:906-920). */
function parseMemoriesArray(rawMemories) {
  if (!Array.isArray(rawMemories)) throw error('legacy_memory_response_invalid', 'Memories is not an array');
  const memories = [];
  for (const item of rawMemories) {
    if (typeof item === 'string') {
      memories.push(item);
    } else if (isPlainObject(item)) {
      // Python: Content or Text or Memory or Data or json.dumps(item)
      // Python `or` truthiness: "", 0, false, [], {} are falsy → fall through.
      const text = pythonOr(item.Content, item.Text, item.Memory, item.Data, JSON.stringify(item));
      memories.push(textToString(text));
    } else {
      throw error('legacy_memory_response_invalid', 'memory item is not a string or object');
    }
  }
  return memories;
}

/** Format 2: "Data" array (sdk_ltm_backend.py:923-925 → _parse_memory_item). */
function parseDataArray(items) {
  const memories = [];
  for (const item of items) {
    memories.push(...parseMemoryItem(item));
  }
  return memories;
}

/** Format 3: "Results" array (sdk_ltm_backend.py:928-939). */
function parseResultsArray(rawResults) {
  if (!Array.isArray(rawResults)) throw error('legacy_memory_response_invalid', 'Results is not an array');
  const memories = [];
  for (const item of rawResults) {
    if (typeof item === 'string') {
      memories.push(item);
    } else if (isPlainObject(item)) {
      // Python: Content or Text or Memory or json.dumps(item) — note: no Data
      const text = pythonOr(item.Content, item.Text, item.Memory, JSON.stringify(item));
      memories.push(textToString(text));
    } else {
      throw error('legacy_memory_response_invalid', 'result item is not a string or object');
    }
  }
  return memories;
}

/** _parse_memory_item (sdk_ltm_backend.py:955-972). Recurses into nested Memories. */
function parseMemoryItem(item) {
  if (typeof item === 'string') return [item];
  if (!isPlainObject(item)) throw error('legacy_memory_response_invalid', 'memory item is not a string or object');

  // Nested Memories list → recurse (line 961-965)
  if (Array.isArray(item.Memories)) {
    const parsed = [];
    for (const memory of item.Memories) {
      parsed.push(...parseMemoryItem(memory));
    }
    return parsed;
  }

  // Python: Content or Text or Memory or Data (line 967) — Python `or` truthiness.
  const text = pythonOr(item.Content, item.Text, item.Memory, item.Data);
  // Python: if text is None: return [] (line 968-969). After the `or` chain, the
  // only way text is None is if ALL fields are missing (undefined → None in the
  // last position). Python's `item.get("Data")` returns None when absent. In
  // JS, undefined is the equivalent. If all four are undefined, pythonOr
  // returns the last (undefined). We check for undefined/null (Python None).
  if (text === undefined || text === null) {
    throw error('legacy_memory_response_invalid', 'memory item has no extractable text field');
  }
  // Python: if isinstance(text, (dict, list)): return [json.dumps(text)] (line 970-971)
  if (isPlainObject(text) || Array.isArray(text)) return [JSON.stringify(text)];
  // Python: return [str(text)] (line 972)
  return [pythonStr(text)];
}
