/**
 * Pure helpers for the Native artifact store.
 *
 * No filesystem, no I/O. Everything here must be deterministic and side
 * effect free so it can be unit tested in isolation. The serialization and
 * byte-digest algorithms are intentionally local: they do not need to match
 * the Python oracle's wire format, only the permission, idempotency,
 * integrity and pagination semantics (see contracts.mts ArtifactPort).
 */

import { createHash, randomBytes } from 'node:crypto';
import { parseNativeJson } from '@kingsoftcloud/agentkit-harness-core/model-json';

/** Reject anything that is not a non-empty trimmed string. */
export function assertNonEmptyString(value, code) {
  if (typeof value !== 'string' || value.length === 0 || value.trim().length === 0) {
    throw Object.assign(new Error(code), { code });
  }
}

/** sha256 of a byte buffer, returned as lowercase hex (no prefix). */
export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** sha256 of a string's UTF-8 bytes, returned as lowercase hex (no prefix). */
export function sha256HexOfString(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Canonical JSON for an arbitrary JSON value: sorted keys, no whitespace,
 * no duplicate keys. Throws on non-JSON values (functions, symbols, cycles,
 * non-plain prototypes) so callers cannot smuggle unstructured data.
 */
export function canonicalStringify(value) {
  const seen = new Set();
  const write = (item) => {
    if (item === null) return 'null';
    if (typeof item === 'string') return JSON.stringify(item);
    if (typeof item === 'boolean') return item ? 'true' : 'false';
    if (typeof item === 'bigint') return item.toString();
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw Object.assign(new Error('non_json_number'), { code: 'non_json_number' });
      if (Object.is(item, -0)) return '-0.0';
      if (Number.isInteger(item) && !Number.isSafeInteger(item)) return item.toExponential();
      return JSON.stringify(item);
    }
    if (typeof item !== 'object') {
      throw Object.assign(new Error('non_json_value'), { code: 'non_json_value' });
    }
    if (seen.has(item)) throw Object.assign(new Error('json_cycle'), { code: 'json_cycle' });
    seen.add(item);
    let out;
    if (Array.isArray(item)) {
      out = '[' + item.map(write).join(',') + ']';
    } else {
      const proto = Object.getPrototypeOf(item);
      if (proto !== Object.prototype && proto !== null) {
        throw Object.assign(new Error('non_json_object'), { code: 'non_json_object' });
      }
      const keys = Object.keys(item);
      keys.sort();
      out = '{' + keys.map((k) => JSON.stringify(k) + ':' + write(item[k])).join(',') + '}';
    }
    seen.delete(item);
    return out;
  };
  return write(value);
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * JSON number grammar per RFC 8259: [ minus ] int [ frac ] [ exp ], where int
 * is a single 0 or a non-zero digit followed by digits, frac is a dot followed
 * by one or more digits, and exp is e/E, an optional sign, and one or more
 * digits. This rejects what Number() silently coerces but JSON does not allow:
 * hex (0x10), a leading plus (+1), leading zeros (01), a trailing dot (1.),
 * a leading dot (.1), and an empty exponent (1e). Number() is still applied
 * afterward so an oversized but grammatically valid exponent (1e400) that
 * overflows to Infinity is rejected rather than admitted as non-finite.
 */
const JSON_NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;

/**
 * Validate that a value is a plain JSON object (ObjectValue). Rejects
 * arrays, null, prototype-polluting keys and objects whose prototype was
 * tampered (e.g. via an object literal `__proto__` setter). Used for
 * caller-supplied metadata, which must never reach storage unvalidated.
 */
export function validateMetadataObject(value, code = 'invalid_artifact_metadata') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error(code), { code });
  }
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      const arrProto = Object.getPrototypeOf(node);
      if (arrProto !== Array.prototype) {
        throw Object.assign(new Error(code), { code });
      }
      for (const item of node) walk(item);
      return;
    }
    const proto = Object.getPrototypeOf(node);
    if (proto !== Object.prototype && proto !== null) {
      throw Object.assign(new Error(code), { code });
    }
    for (const key of Object.keys(node)) {
      if (FORBIDDEN_KEYS.has(key)) {
        throw Object.assign(new Error(code), { code });
      }
      walk(node[key]);
    }
  };
  walk(value);
  // Round-trip through canonical JSON to reject non-JSON values found by
  // traversal and normalize to a plain object.
  return parseNativeJson(canonicalStringify(value));
}

/**
 * Strict JSON parser that rejects duplicate keys and prototype-polluting
 * keys. Used when reading our own sidecar metadata, which we wrote, but
 * which a tampered filesystem could have rewritten. Hand-written descent
 * parser so duplicate-key detection is exact; string escapes are delegated
 * to JSON.parse on the raw quoted token so surrogate pairs stay correct.
 */
export function safeJsonParse(text, code = 'invalid_artifact_record') {
  if (typeof text !== 'string') {
    throw Object.assign(new Error(code), { code });
  }
  let pos = 0;
  const fail = () => { throw Object.assign(new Error(code), { code }); };
  const skipWs = () => {
    while (pos < text.length) {
      const c = text.charCodeAt(pos);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) pos += 1;
      else break;
    }
  };
  const parseValue = () => {
    skipWs();
    if (pos >= text.length) fail();
    const c = text[pos];
    if (c === '{') return parseObject();
    if (c === '[') return parseArray();
    if (c === '"') return parseString();
    return parseLiteral();
  };
  const parseObject = () => {
    pos += 1; // {
    const obj = Object.create(null);
    const seen = new Set();
    skipWs();
    if (pos < text.length && text[pos] === '}') { pos += 1; return obj; }
    while (true) {
      skipWs();
      if (pos >= text.length || text[pos] !== '"') fail();
      const key = parseString();
      if (FORBIDDEN_KEYS.has(key)) fail();
      if (seen.has(key)) fail();
      seen.add(key);
      skipWs();
      if (pos >= text.length || text[pos] !== ':') fail();
      pos += 1; // :
      obj[key] = parseValue();
      skipWs();
      if (pos >= text.length) fail();
      if (text[pos] === ',') { pos += 1; continue; }
      if (text[pos] === '}') { pos += 1; break; }
      fail();
    }
    return obj;
  };
  const parseArray = () => {
    pos += 1; // [
    const arr = [];
    skipWs();
    if (pos < text.length && text[pos] === ']') { pos += 1; return arr; }
    while (true) {
      arr.push(parseValue());
      skipWs();
      if (pos >= text.length) fail();
      if (text[pos] === ',') { pos += 1; continue; }
      if (text[pos] === ']') { pos += 1; break; }
      fail();
    }
    return arr;
  };
  const parseString = () => {
    if (text[pos] !== '"') fail();
    let end = pos + 1;
    while (end < text.length) {
      const c = text.charCodeAt(end);
      if (c === 0x5c) { end += 2; continue; } // skip escaped char
      if (c === 0x22) break; // closing quote
      end += 1;
    }
    if (end >= text.length) fail();
    const token = text.slice(pos, end + 1);
    pos = end + 1;
    // Delegate unescaping to JSON.parse on the raw quoted token (surrogate
    // pairs in \uXXXX stay correct), but coerce any escape it rejects (e.g.
    // \z, \x41, a truncated \u00) into the stable `code` rather than letting
    // a bare SyntaxError escape this parser without an error code.
    try {
      return JSON.parse(token);
    } catch {
      fail();
    }
  };
  const parseLiteral = () => {
    const start = pos;
    while (pos < text.length && !' \t\n\r{}[],:"'.includes(text[pos])) pos += 1;
    const chunk = text.slice(start, pos);
    if (chunk === 'true') return true;
    if (chunk === 'false') return false;
    if (chunk === 'null') return null;
    // Enforce the JSON number grammar (see JSON_NUMBER) instead of trusting
    // Number(), which coerces 0x10/+1/01/1./.1 into numbers JSON.parse rejects.
    if (chunk === '' || !JSON_NUMBER.test(chunk)) fail();
    if (!/[.eE]/.test(chunk) && !Number.isSafeInteger(Number(chunk))) {
      if (chunk.replace(/^-/, '').length > 4300) fail();
      return BigInt(chunk);
    }
    if (!Number.isFinite(Number(chunk))) fail();
    return Number(chunk);
  };
  const root = parseValue();
  skipWs();
  if (pos !== text.length) fail(); // trailing garbage
  return root;
}

/**
 * Validate a RunScope and return its four string values. The four fields
 * are required and must exactly match the trusted factory binding on every
 * request; they are never concatenated into a path directly.
 */
export function validateScope(scope) {
  if (!scope || typeof scope !== 'object') {
    throw Object.assign(new Error('invalid_scope'), { code: 'invalid_scope' });
  }
  const names = ['tenantId', 'workspaceId', 'userId', 'agentId'];
  const values = names.map((p) => scope[p]);
  if (Object.keys(scope).length !== 4 || values.some((v) => typeof v !== 'string' || v.length === 0 || v.trim().length === 0)) {
    throw Object.assign(new Error('invalid_scope'), { code: 'invalid_scope' });
  }
  return values;
}

/** True when two RunScope objects are exactly equal across all four fields. */
export function scopeEquals(a, b) {
  return !!(a && b && a.tenantId === b.tenantId && a.workspaceId === b.workspaceId && a.userId === b.userId && a.agentId === b.agentId);
}

/** Hex digest for a scope, used as the scope directory name. */
export function scopeDigest(scope) {
  return sha256HexOfString(canonicalStringify(validateScope(scope)));
}

/** Hex digest for a run within a scope, used as the run directory name. */
export function runDigest(scope, runId) {
  assertNonEmptyString(runId, 'invalid_run_id');
  return sha256HexOfString(canonicalStringify([validateScope(scope), runId]));
}

/**
 * Hex digest for an operation identity (operationKey within a scope+run).
 * Same identity + same content/type/metadata is idempotent; same identity
 * with different content/type/metadata is a conflict.
 */
export function identityDigest(scope, runId, operationKey) {
  assertNonEmptyString(runId, 'invalid_run_id');
  assertNonEmptyString(operationKey, 'invalid_operation_key');
  return sha256HexOfString(canonicalStringify([validateScope(scope), runId, operationKey]));
}

/** Validate mediaType: non-empty, <=160 chars, no CR/LF (matches source). */
export function validateMediaType(mediaType) {
  if (typeof mediaType !== 'string' || mediaType.length === 0 || mediaType.length > 160) {
    throw Object.assign(new Error('invalid_artifact_media_type'), { code: 'invalid_artifact_media_type' });
  }
  if (/[\r\n]/.test(mediaType)) {
    throw Object.assign(new Error('invalid_artifact_media_type'), { code: 'invalid_artifact_media_type' });
  }
  return mediaType;
}

/** Validate an ArtifactRef's shape (used on read). Exact match is enforced later. */
export function validateRef(ref) {
  if (!ref || typeof ref !== 'object') {
    throw Object.assign(new Error('invalid_artifact_ref'), { code: 'invalid_artifact_ref' });
  }
  const { uri, digest, mediaType, sizeBytes, metadata } = ref;
  if (typeof uri !== 'string' || uri.length === 0 || uri.length > 2048 || !/^artifact:\/\/\S+$/.test(uri)) {
    throw Object.assign(new Error('invalid_artifact_ref'), { code: 'invalid_artifact_ref' });
  }
  if (typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw Object.assign(new Error('invalid_artifact_ref'), { code: 'invalid_artifact_ref' });
  }
  validateMediaType(mediaType);
  if (!Number.isInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > Number.MAX_SAFE_INTEGER) {
    throw Object.assign(new Error('invalid_artifact_ref'), { code: 'invalid_artifact_ref' });
  }
  if (metadata === undefined || metadata === null) {
    throw Object.assign(new Error('invalid_artifact_ref'), { code: 'invalid_artifact_ref' });
  }
  validateMetadataObject(metadata, 'invalid_artifact_ref');
  return ref;
}

/** Parse artifact://{scopeDigest}/{runDigest}/{identityDigest} safely. */
export function parseArtifactUri(uri) {
  const match = /^artifact:\/\/([0-9a-f]{64})\/([0-9a-f]{64})\/([0-9a-f]{64})$/.exec(uri);
  if (!match) {
    throw Object.assign(new Error('invalid_artifact_uri'), { code: 'invalid_artifact_uri' });
  }
  return { scopeDigest: match[1], runDigest: match[2], identityDigest: match[3] };
}

/** Build the canonical URI for a sealed artifact. */
export function buildArtifactUri(scopeDigestValue, runDigestValue, identityDigestValue) {
  return `artifact://${scopeDigestValue}/${runDigestValue}/${identityDigestValue}`;
}

/**
 * True when text contains an unpaired UTF-16 surrogate: a high surrogate
 * (U+D800–U+DBFF) not followed by a low surrogate, or a low surrogate
 * (U+DC00–U+DFFF) not preceded by a high surrogate. Buffer.from(text,'utf8')
 * silently replaces every unpaired surrogate with U+FFFD, so a store
 * write/read would change the user's bytes without any error. Detecting this
 * before encoding lets us reject the content rather than corrupt it. Valid
 * surrogate pairs (astral characters such as U+1D400) pass untouched.
 */
function hasUnpairedSurrogate(text) {
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF) {
      // High surrogate must be immediately followed by a low surrogate.
      if (i + 1 >= text.length) return true; // high at end of string
      const next = text.charCodeAt(i + 1);
      if (next < 0xDC00 || next > 0xDFFF) return true; // high without low
      i += 1; // consume the paired low surrogate
    } else if (c >= 0xDC00 && c <= 0xDFFF) {
      return true; // low surrogate without a preceding high
    }
  }
  return false;
}

/** UTF-8 encode without truncation or replacement; reject unpaired surrogates. */
export function encodeUtf8(text) {
  if (typeof text !== 'string') {
    throw Object.assign(new Error('invalid_artifact_content'), { code: 'invalid_artifact_content' });
  }
  if (hasUnpairedSurrogate(text)) {
    throw Object.assign(new Error('invalid_artifact_content'), { code: 'invalid_artifact_content' });
  }
  return Buffer.from(text, 'utf8');
}

/**
 * UTF-8 decode in fatal mode (never substitute replacement characters) while
 * preserving a leading BOM. The default TextDecoder consumes a leading U+FEFF,
 * so a stored BOM would not round-trip; ignoreBOM keeps it in the output,
 * matching Python's strict payload.decode('utf-8') and the workspace-editing
 * reader. Invalid byte sequences still throw artifact_content_not_utf8.
 */
export function decodeUtf8Fatal(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    throw Object.assign(new Error('artifact_content_not_utf8'), { code: 'artifact_content_not_utf8' });
  }
}

/** Count Unicode code points (aligns with Python len(str) / offset_chars). */
export function codePointLength(text) {
  let count = 0;
  for (const _ of text) count += 1; // eslint-disable-line no-unused-vars
  return count;
}

/**
 * Slice text by Unicode code point index, aligning with Python
 * text[offset:offset+limit]. Returns { content, nextOffset } where nextOffset
 * is null when the page reached the end. Rejects negative / fractional /
 * out-of-bounds offsets and non-positive / oversized limits.
 */
export function sliceByCodePoints(text, offset, limit, maxLimit) {
  if (!Number.isInteger(offset) || offset < 0) {
    throw Object.assign(new Error('invalid_artifact_offset'), { code: 'invalid_artifact_offset' });
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
    throw Object.assign(new Error('invalid_artifact_limit'), { code: 'invalid_artifact_limit' });
  }
  const total = codePointLength(text);
  if (offset > total) {
    throw Object.assign(new Error('artifact_offset_beyond_content'), { code: 'artifact_offset_beyond_content' });
  }
  const end = Math.min(offset + limit, total);
  const chars = Array.from(text);
  const content = chars.slice(offset, end).join('');
  const nextOffset = end >= total ? null : end;
  return { content, nextOffset };
}

/** Validate a positive integer option with a default and upper bound. */
export function validateLimitOption(value, name, defaultValue, max) {
  if (value === undefined || value === null) return defaultValue;
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw Object.assign(new Error(`invalid_${name}`), { code: `invalid_${name}` });
  }
  return value;
}

/** Validate a byte-size limit option (positive integer). */
export function validateBytesOption(value, name, defaultValue, max) {
  if (value === undefined || value === null) return defaultValue;
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw Object.assign(new Error(`invalid_${name}`), { code: `invalid_${name}` });
  }
  return value;
}

/** True when two JSON values are structurally equal under canonical form. */
export function jsonEquals(a, b) {
  return canonicalStringify(a) === canonicalStringify(b);
}

/** Short random hex nonce for unique temp file names across processes. */
export function tempNonce() {
  return randomBytes(9).toString('hex') + process.pid.toString(36);
}

/**
 * Strict validator for a durable sidecar record read back from disk. Every
 * field is type-checked without coercion (no Number()/String()), and the
 * uri/digest/mediaType/sizeBytes/metadata shape must match the contract.
 * The caller additionally asserts that the uri's scope/run/identity match
 * the on-disk path. Returns the validated, plain-prototype record.
 *
 * @param {string} text  Raw sidecar text.
 * @param {string} code  Error code to throw on any failure.
 * @returns {{ uri: string, digest: string, mediaType: string, sizeBytes: number, metadata: object, createdAt?: string }}
 */
export function validateDurableRecord(text, code = 'invalid_artifact_record') {
  const meta = safeJsonParse(text, code);
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    throw Object.assign(new Error(code), { code });
  }
  const { uri, digest, mediaType, sizeBytes, metadata, createdAt } = meta;
  if (typeof uri !== 'string') {
    throw Object.assign(new Error(code), { code });
  }
  const m = /^artifact:\/\/([0-9a-f]{64})\/([0-9a-f]{64})\/([0-9a-f]{64})$/.exec(uri);
  if (!m) throw Object.assign(new Error(code), { code });
  if (typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw Object.assign(new Error(code), { code });
  }
  if (typeof mediaType !== 'string' || mediaType.length === 0 || mediaType.length > 160 || /[\r\n]/.test(mediaType)) {
    throw Object.assign(new Error(code), { code });
  }
  if (typeof sizeBytes !== 'number' || !Number.isInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > Number.MAX_SAFE_INTEGER) {
    throw Object.assign(new Error(code), { code });
  }
  if (metadata === undefined || metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw Object.assign(new Error(code), { code });
  }
  // Reject prototype-polluting / non-plain metadata in a stored record.
  validateMetadataObject(metadata, code);
  if (createdAt !== undefined && (typeof createdAt !== 'string' || createdAt.length === 0 || createdAt.length > 64)) {
    throw Object.assign(new Error(code), { code });
  }
  return { uri, digest, mediaType, sizeBytes, metadata, createdAt };
}

/** True when two JSON values are structurally equal under canonical form. */
