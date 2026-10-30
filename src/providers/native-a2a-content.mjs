/** Pure A2A 1.0 protobuf-JSON content → canonical ContentValue converter.
 *
 * Ported from ksadk/events/adapters/_a2a_snapshot.py:_convert_part/_convert_parts
 * (lines 504-581) + _a2a_support.py metadata helpers, against
 * ksadk/events/content.py. No network, no storage, no state machine.
 *
 * Input `owner` is an A2A 1.0 protobuf-JSON Artifact(artifactId,name,parts) or
 * Message(messageId,role,parts). Each Part uses the protobuf JSON field names
 * (json_name): the `content` oneof is expressed as sibling fields text|raw|url|
 * data (exactly one present — mirrors WhichOneof("content")), plus metadata,
 * filename, mediaType. `raw` is TYPE_BYTES → its wire JSON is a base64 string
 * (standard or URL-safe, with or without padding); it is validated and
 * normalized, never silently repaired by Buffer.from.
 *
 * Determinism: stable part_id via the imported `a2aIdentity('part','a2a',
 * item_id, nativePart)`, matching the Python `stable_part_id` 24-char digest.
 *
 * Python str()/repr() semantics: metadata numbers are protobuf double, so
 * `1` → str(1.0) = "1.0", `1e-5` → "1e-05", `1e20` → "1e+20"; bool → "True"/
 * "False"; None → "None"; containers use Python repr ("[]", "{}",
 * "[1, True, None, 'x']", "{'a': 1}") — NOT JS String(object). is_error uses
 * Python bool(x) (empty containers falsy), diverging from JS Boolean([]).
 *
 * IEEE-double / bigint: bigint → finite Number; non-finite numbers rejected.
 * Non-JSON values (undefined, functions, Date, prototype objects) are
 * rejected, never silently coerced to null/{}. Prototype-like object keys
 * remain ordinary own JSON keys through Object.fromEntries.
 * Isolated UTF-16 surrogates in strings are rejected to avoid hash aliases
 * between JS String(value).normalize('NFC') (a2aIdentity) and Python NFC.
 *
 * Errors throw Error with a stable `A2A_CONTENT_*` code and a generic message
 * that never echoes payload bytes, URLs, base64, or credentials.
 */
import { a2aIdentity } from './native-a2a-events.mjs';

const MAX_PARTS = 4096;
const MAX_DEPTH = 100;
// Python str.strip() includes U+0085 and excludes the BOM. JS trim differs.
const strip = value => value.replace(/^[\x09-\x0d\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\x09-\x0d\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu, '');

function fail(code) { const error = new Error(code); error.code = code; return error; }
function reject(code) { throw fail(code); }

/** Python float str() for an IEEE double. Mirrors main native-a2a-message.mjs
 * `double`: -0 → "-0.0"; |x| in (0,1e-4) or >=1e16 → exponential e(+|-)NN
 * (2-digit exponent); integer-valued → "<n>.0"; else String(x). */
function pythonFloatStr(number) {
  if (Object.is(number, -0)) return '-0.0';
  const abs = Math.abs(number);
  if (abs && (abs < 1e-4 || abs >= 1e16)) {
    return number.toExponential().replace(/e([+-])(\d+)$/u, (_m, sign, exp) => `e${sign}${exp.padStart(2, '0')}`);
  }
  return Number.isInteger(number) ? `${number}.0` : String(number);
}

/** Reject isolated UTF-16 surrogates; JS String(value).normalize('NFC') on a
 * lone surrogate does not match Python unicodedata.normalize('NFC', ...) byte
 * identity, which would alias stable ids. */
function rejectIfLoneSurrogate(str) {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF) {
      if (i + 1 >= str.length) reject('A2A_CONTENT_INVALID_STRING');
      const next = str.charCodeAt(i + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) reject('A2A_CONTENT_INVALID_STRING');
      i++;
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      reject('A2A_CONTENT_INVALID_STRING');
    }
  }
}

/** Python str(x) for a metadata value (protobuf Struct value domain:
 * string/number(double)/bool/null, plus nested struct/list). Mirrors
 * _optional_metadata_string's str(value).strip() input.
 * - string → itself (no quotes)
 * - number (double) → pythonFloatStr
 * - bool → "True"/"False"
 * - null/None → "None"
 * - array → Python repr: "[1, True, None, 'x']" (single-quoted strings)
 * - object → Python repr: "{'a': 1}" */
function pythonStr(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? pythonFloatStr(value) : reject('A2A_CONTENT_NON_FINITE');
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (value === null) return 'None';
  if (Array.isArray(value)) return pythonReprList(value);
  if (typeof value === 'object') return pythonReprDict(value);
  reject('A2A_CONTENT_INVALID_METADATA');
}

/** Python repr() for a JSON array: "[<items joined ', '>]" where each item is
 * Python repr — numbers float-formatted, bool "True"/"False", None, strings
 * single-quoted with minimal escaping, nested containers recursed. */
function pythonReprList(list) {
  const parts = [];
  for (const item of list) parts.push(pythonRepr(item));
  return `[${parts.join(', ')}]`;
}

/** Python repr() for a JSON object: "{'k': v, ...}" with single-quoted keys. */
function pythonReprDict(dict) {
  const parts = [];
  for (const [key, val] of Object.entries(dict)) {
    if (typeof key !== 'string') reject('A2A_CONTENT_INVALID_METADATA');
    parts.push(`${pythonReprString(key)}: ${pythonRepr(val)}`);
  }
  return `{${parts.join(', ')}}`;
}

/** Python repr() dispatch matching Python str()/repr() for metadata coercion. */
function pythonRepr(value) {
  if (typeof value === 'string') return pythonReprString(value);
  if (typeof value === 'number') return Number.isFinite(value) ? pythonFloatStr(value) : reject('A2A_CONTENT_NON_FINITE');
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (value === null) return 'None';
  if (Array.isArray(value)) return pythonReprList(value);
  if (typeof value === 'object') return pythonReprDict(value);
  reject('A2A_CONTENT_INVALID_METADATA');
}

/** Python repr() of a string: single-quoted with backslash escaping of
 * backslash and single-quote; other control chars rejected to keep repr
 * stable (Python repr escapes them, but the metadata domain is JSON). */
function pythonReprString(str) {
  rejectIfLoneSurrogate(str);
  const quote = str.includes("'") && !str.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (ch === '\\' || ch === quote) out += '\\' + ch;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (cp !== 32 && /[\p{C}\p{Z}]/u.test(ch)) out += cp <= 255 ? '\\x' + cp.toString(16).padStart(2, '0')
      : cp <= 65535 ? '\\u' + cp.toString(16).padStart(4, '0') : '\\U' + cp.toString(16).padStart(8, '0');
    else out += ch;
  }
  out += quote;
  return out;
}

/** Python truthiness for JSON-domain values (bool(x)). Python falsy:
 * None, False, 0, 0.0, "", [], {}; everything else truthy. */
function pythonBool(value) {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0;
  if (typeof value === 'bigint') return value !== 0n;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  if (typeof value === 'boolean') return value;
  reject('A2A_CONTENT_INVALID_METADATA'); // functions/symbols not JSON
}

/** Recursively reduce a JSON value to the IEEE-double / canonical domain.
 * bigint → finite Number (rejected if non-finite). Non-finite numbers
 * rejected. Non-JSON values (undefined, function, Date, symbol) rejected.
 * Prototype-like names remain ordinary own JSON keys, without assignment to
 * a prototype setter. Isolated UTF-16 surrogates
 * in strings rejected. Depth-bounded. Never drops structure. */
function toDoubleDomain(value, depth) {
  if (depth > MAX_DEPTH) reject('A2A_CONTENT_DEPTH_LIMIT');
  if (value === null) return null;
  if (value === undefined) reject('A2A_CONTENT_INVALID_DATA');
  const type = typeof value;
  if (type === 'boolean') return value;
  if (type === 'string') { rejectIfLoneSurrogate(value); return value; }
  if (type === 'number') return Number.isFinite(value) ? value : reject('A2A_CONTENT_NON_FINITE');
  if (type === 'bigint') {
    const n = Number(value);
    return Number.isFinite(n) ? n : reject('A2A_CONTENT_NON_FINITE');
  }
  if (Array.isArray(value)) return Array.from(value, item => toDoubleDomain(item, depth + 1));
  if (type === 'object') {
    // Reject non-plain objects (Date, Map, class instances, etc.) — not JSON.
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) reject('A2A_CONTENT_INVALID_DATA');
    return Object.fromEntries(Object.entries(value).map(([key, child]) => {
      rejectIfLoneSurrogate(key); return [key, toDoubleDomain(child, depth + 1)];
    }));
  }
  // function / symbol / unknown — not JSON.
  reject('A2A_CONTENT_INVALID_DATA');
}

/** _metadata(struct): None → {}; else a plain object (protobuf Struct → dict).
 * Rejects non-object (array/primitive) structs. */
function normalizeMetadata(struct) {
  if (struct === null || struct === undefined) return {};
  if (typeof struct !== 'object' || Array.isArray(struct)) reject('A2A_CONTENT_INVALID_METADATA');
  return toDoubleDomain(struct, 0);
}

/** Python str(value).strip() for a single metadata value, mirroring
 * _optional_metadata_string's coercion. Exported so the parent's canonical
 * adapter can reuse the exact Python metadata-string conversion without
 * duplicating it. Returns null when the key is absent or the coerced string
 * is empty after strip (matching _optional_metadata_string's skip semantics). */
export function a2aMetadataString(metadata, ...keys) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  for (const key of keys) {
    if (!Object.hasOwn(metadata, key)) continue;
    const raw = toDoubleDomain(metadata[key], 0);
    if (raw === null) continue;
    const text = strip(pythonStr(raw));
    if (text) return text;
  }
  return null;
}

/** _optional_metadata_string: first key whose str(value) is non-empty after
 * strip. (Internal wrapper around the exported a2aMetadataString.) */
function optionalMetadataString(metadata, ...keys) {
  return a2aMetadataString(metadata, ...keys);
}

/** _required_metadata_string: optional-or-fail with a stable code. */
function requiredMetadataString(metadata, key, code) {
  const value = optionalMetadataString(metadata, key);
  if (value === null) reject(code || 'A2A_CONTENT_MISSING_METADATA');
  return value;
}

/** File content references retain the raw owner identity, as _convert_part
 * does; the caller separately normalizes its canonical item identity. */
function requiredString(value, code) {
  if (typeof value !== 'string') reject(code);
  rejectIfLoneSurrogate(value);
  if (!strip(value)) reject(code);
  return value;
}

/** Validate and normalize a base64 string (standard or URL-safe, with or
 * without padding) into canonical padded standard base64. Rejects invalid
 * characters rather than letting Buffer.from silently drop them. */
const BASE64_CHARS = /^[A-Za-z0-9+/_-]*={0,2}$/u;
function normalizeBase64(raw) {
  if (typeof raw !== 'string') reject('A2A_CONTENT_INVALID_BYTES');
  rejectIfLoneSurrogate(raw);
  if (!BASE64_CHARS.test(raw)) reject('A2A_CONTENT_INVALID_BYTES');
  if ((raw.replace(/=/gu, '').length % 4) === 1) reject('A2A_CONTENT_INVALID_BYTES');
  // URL-safe → standard alphabet, then decode+re-encode to canonical padded
  // base64. Decoding through Buffer validates the whole string atomically;
  // invalid padding/length above already guards the char set.
  let decoded;
  try {
    decoded = Buffer.from(raw.replace(/-/gu, '+').replace(/_/gu, '/'), 'base64');
  } catch { reject('A2A_CONTENT_INVALID_BYTES'); }
  // Confirm round-trip to catch any residue Buffer accepted leniently.
  const canonical = decoded.toString('base64');
  // Re-deriving the input from canonical must match the normalized input
  // (padding restored). This rejects inputs Buffer silently mangled.
  const renormalized = canonical.replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
  if (renormalized !== raw.replace(/=+$/u, '').replace(/\+/gu, '-').replace(/\//gu, '_')) reject('A2A_CONTENT_INVALID_BYTES');
  return canonical;
}

/** Detect the content oneof. Exactly one of text|data|url|raw must be present
 * and non-null; mirrors protobuf WhichOneof("content"). Returns the kind or
 * null (→ empty_part). More than one → conflict. */
function detectOneof(part) {
  const fields = ['text', 'data', 'url', 'raw'];
  let present = null, count = 0;
  for (const field of fields) {
    if (Object.hasOwn(part, field) && (field === 'data' || part[field] !== undefined && part[field] !== null)) { count++; present = field; }
  }
  if (count === 0) return null;
  if (count > 1) reject('A2A_CONTENT_ONEOF_CONFLICT');
  return present;
}

function convertPart(owner, isArtifact, part, itemId, index) {
  if (!part || typeof part !== 'object' || Array.isArray(part)) reject('A2A_CONTENT_INVALID_PART');
  const metadata = part.metadata !== undefined ? normalizeMetadata(part.metadata) : {};
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) reject('A2A_CONTENT_INVALID_METADATA');

  const kind = optionalMetadataString(metadata, 'kind', 'ksadk_kind');
  const contentKind = detectOneof(part);

  if (contentKind === 'text') {
    if (typeof part.text !== 'string') reject('A2A_CONTENT_INVALID_TEXT');
    rejectIfLoneSurrogate(part.text);
    const nativePart = optionalMetadataString(metadata, 'part_id') || `text:${index}`;
    const partId = a2aIdentity('part', 'a2a', itemId, nativePart);
    return { content_type: 'text', part_id: partId, text: part.text };
  }

  if (contentKind === 'data') {
    const nativeKind = kind || 'data';
    const nativePart = optionalMetadataString(metadata, 'part_id') || `${nativeKind}:${index}`;
    const partId = a2aIdentity('part', 'a2a', itemId, nativePart);
    const value = toDoubleDomain(part.data, 0);
    if (value === undefined) reject('A2A_CONTENT_INVALID_DATA');
    if (nativeKind === 'tool_call') {
      return { content_type: 'tool_call', part_id: partId,
        call_id: requiredMetadataString(metadata, 'call_id', 'A2A_CONTENT_MISSING_CALL_ID'),
        name: requiredMetadataString(metadata, 'name', 'A2A_CONTENT_MISSING_NAME'),
        arguments: value };
    }
    if (nativeKind === 'tool_result') {
      const isError = Object.hasOwn(metadata, 'is_error') ? pythonBool(metadata.is_error) : false;
      return { content_type: 'tool_result', part_id: partId,
        call_id: requiredMetadataString(metadata, 'call_id', 'A2A_CONTENT_MISSING_CALL_ID'),
        result: value, is_error: isError };
    }
    if (nativeKind !== 'data') reject('A2A_CONTENT_UNKNOWN_KIND');
    return { content_type: 'data', part_id: partId, data: value };
  }

  if (contentKind === 'url' || contentKind === 'raw') {
    const nativePart = optionalMetadataString(metadata, 'part_id') || `file:${index}`;
    const partId = a2aIdentity('part', 'a2a', itemId, nativePart);
    const artifactId = isArtifact
      ? requiredString(owner.artifactId, 'A2A_CONTENT_MISSING_ARTIFACT_ID')
      : `message:${requiredString(owner.messageId, 'A2A_CONTENT_MISSING_MESSAGE_ID')}:part:${index}`;
    const filename = typeof part.filename === 'string' ? part.filename : '';
    const fallbackName = isArtifact
      ? (typeof owner.name === 'string' ? owner.name : '')
      : 'attachment';
    const name = filename || fallbackName;
    if (!name) reject('A2A_CONTENT_MISSING_NAME');
    rejectIfLoneSurrogate(name);
    let data = null;
    if (contentKind === 'raw') {
      // raw is TYPE_BYTES: its wire JSON is a base64 string (standard or
      // URL-safe, with or without padding). Validate + normalize; reject
      // invalid rather than silently repairing via Buffer.from.
      data = { base64: normalizeBase64(part.raw) };
    }
    const mediaType = typeof part.mediaType === 'string' ? part.mediaType : null;
    if (mediaType) rejectIfLoneSurrogate(mediaType);
    if (contentKind === 'url' && typeof part.url === 'string') rejectIfLoneSurrogate(part.url);
    return { content_type: 'artifact', part_id: partId, artifact_id: artifactId, name,
      mime_type: mediaType || null,
      uri: contentKind === 'url' ? (typeof part.url === 'string' ? part.url : reject('A2A_CONTENT_INVALID_URL')) : null,
      data };
  }

  // No supported payload → empty_part.
  reject('A2A_CONTENT_EMPTY_PART');
}

/**
 * Convert an A2A 1.0 protobuf-JSON Artifact or Message into canonical
 * ContentValue[]. Pure; no I/O. `owner` is {artifactId,name,parts} or
 * {messageId,role,parts}. `itemId` is the canonical item id (caller-supplied,
 * e.g. a2aIdentity('item',...)). `startIndex` offsets part indexing like
 * Python's _convert_parts(start_index=), affecting stable part_id and the
 * message-attachment artifact_id (`message:{id}:part:{index}`).
 */
export function convertA2AContent(owner, itemId, { startIndex = 0 } = {}) {
  if (!owner || typeof owner !== 'object' || Array.isArray(owner)) reject('A2A_CONTENT_INVALID_OWNER');
  if (typeof itemId !== 'string' || !itemId.trim()) reject('A2A_CONTENT_INVALID_ITEM_ID');
  if (!Number.isSafeInteger(startIndex) || startIndex < 0) reject('A2A_CONTENT_INVALID_START_INDEX');
  if (!Array.isArray(owner.parts)) reject('A2A_CONTENT_INVALID_PARTS');
  if (owner.parts.length === 0) reject('A2A_CONTENT_EMPTY_PARTS');
  if (owner.parts.length > MAX_PARTS) reject('A2A_CONTENT_PARTS_LIMIT');
  const isArtifact = Object.hasOwn(owner, 'artifactId');
  if (!isArtifact && !Object.hasOwn(owner, 'messageId')) reject('A2A_CONTENT_INVALID_OWNER');

  const converted = [];
  const seen = new Set();
  for (let i = 0; i < owner.parts.length; i++) {
    const index = startIndex + i;
    const value = convertPart(owner, isArtifact, owner.parts[i], itemId, index);
    if (seen.has(value.part_id)) reject('A2A_CONTENT_DUPLICATE_PART_ID');
    seen.add(value.part_id);
    converted.push(value);
  }
  return converted;
}
