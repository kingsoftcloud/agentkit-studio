/** A2A Message protobuf-JSON normalization and reference Python digest.
 * Struct/Value numbers use protobuf double semantics, not Native bigint
 * semantics. The permit hashes MessageToDict + Python sorted JSON, NOT raw
 * transport bytes. No protobuf/Python runtime dependency is needed. */
import { createHash } from 'node:crypto';
import { invariant } from '../../packages/agentkit-harness-core/dist/index.mjs';
const plain = value => value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const text = value => {
  invariant(typeof value === 'string', 'A2A_MESSAGE_PROTO_INVALID');
  for (const char of value) { const cp = char.codePointAt(0); invariant(cp < 0xd800 || cp > 0xdfff, 'A2A_MESSAGE_UNICODE_INVALID'); }
  return value;
};
function value(item, depth = 0) {
  invariant(depth <= 100, 'A2A_MESSAGE_DEPTH_LIMIT');
  if (item === null || typeof item === 'boolean') return item;
  if (typeof item === 'string') return text(item);
  if (typeof item === 'number' || typeof item === 'bigint') { const number = Number(item); invariant(Number.isFinite(number), 'A2A_MESSAGE_PROTO_INVALID'); return number; }
  if (Array.isArray(item)) return item.map(child => value(child, depth + 1));
  invariant(plain(item), 'A2A_MESSAGE_PROTO_INVALID');
  return Object.fromEntries(Object.entries(item).map(([key, child]) => [text(key), value(child, depth + 1)]));
}
function struct(item) { invariant(plain(item), 'A2A_MESSAGE_PROTO_INVALID'); return value(item); }
function part(raw) {
  invariant(plain(raw) && Object.keys(raw).every(key => ['text', 'raw', 'url', 'data', 'metadata', 'filename', 'mediaType', 'file'].includes(key)), 'A2A_MESSAGE_PROTO_INVALID');
  const result = {}, contents = ['text', 'raw', 'url', 'data', 'file'].filter(key => Object.hasOwn(raw, key));
  invariant(contents.length === 1, 'A2A_MESSAGE_PROTO_INVALID'); const kind = contents[0];
  if (kind === 'file') {
    invariant(plain(raw.file) && Object.keys(raw.file).every(key => ['uri', 'bytes', 'name', 'mimeType'].includes(key))
      && ['uri', 'bytes'].filter(key => Object.hasOwn(raw.file, key)).length === 1, 'A2A_MESSAGE_PROTO_INVALID');
    return part({ ...(raw.file.uri === undefined ? { raw: raw.file.bytes } : { url: raw.file.uri }),
      ...(raw.file.name ? { filename: raw.file.name } : {}), ...(raw.file.mimeType ? { mediaType: raw.file.mimeType } : {}),
      ...(raw.metadata === undefined ? {} : { metadata: raw.metadata }) });
  }
  if (kind === 'data') result.data = value(raw.data);
  else if (kind === 'raw') {
    const encoded = text(raw.raw); invariant(/^[A-Za-z0-9+/_-]*={0,2}$/u.test(encoded), 'A2A_MESSAGE_PROTO_INVALID');
    const bytes = Buffer.from(encoded, 'base64');
    invariant(bytes.toString('base64url') === encoded.replace(/=+$/u, '').replace(/\+/gu, '-').replace(/\//gu, '_'), 'A2A_MESSAGE_PROTO_INVALID');
    result.raw = bytes.toString('base64');
  } else result[kind] = text(raw[kind]);
  if (raw.metadata !== undefined) result.metadata = struct(raw.metadata);
  for (const key of ['filename', 'mediaType']) if (raw[key] !== undefined && text(raw[key])) result[key] = raw[key];
  return result;
}
export function normalizeA2AMessage(raw) {
  invariant(plain(raw) && Object.keys(raw).every(key => ['messageId', 'contextId', 'taskId', 'role', 'parts', 'metadata', 'extensions', 'referenceTaskIds'].includes(key))
    && ['ROLE_USER', 'ROLE_AGENT'].includes(raw.role) && Array.isArray(raw.parts) && raw.parts.length > 0 && raw.parts.length <= 64, 'A2A_MESSAGE_PROTO_INVALID');
  const result = { role: raw.role, parts: raw.parts.map(part) };
  for (const key of ['messageId', 'contextId', 'taskId']) if (raw[key] !== undefined && text(raw[key])) result[key] = raw[key];
  invariant(result.messageId && result.messageId.length <= 128, 'A2A_MESSAGE_PROTO_INVALID');
  if (raw.metadata !== undefined) result.metadata = struct(raw.metadata);
  for (const key of ['extensions', 'referenceTaskIds']) if (raw[key] !== undefined) {
    invariant(Array.isArray(raw[key]), 'A2A_MESSAGE_PROTO_INVALID'); if (raw[key].length) result[key] = raw[key].map(text);
  }
  return result;
}
const compare = (a, b) => {
  const aa = Array.from(a, char => char.codePointAt(0)), bb = Array.from(b, char => char.codePointAt(0));
  for (let i = 0; i < Math.min(aa.length, bb.length); i++) if (aa[i] !== bb[i]) return aa[i] - bb[i];
  return aa.length - bb.length;
};
function double(number) {
  if (Object.is(number, -0)) return '-0.0';
  const abs = Math.abs(number);
  if (abs && (abs < 1e-4 || abs >= 1e16)) return number.toExponential().replace(/e([+-])(\d+)$/u, (_, sign, exponent) => `e${sign}${exponent.padStart(2, '0')}`);
  return Number.isInteger(number) ? number + '.0' : String(number);
}
export function a2aMessageDigest(raw) {
  const message = normalizeA2AMessage(raw);
  function encode(item) {
    if (typeof item === 'number') return double(item);
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return JSON.stringify(item);
    if (Array.isArray(item)) return '[' + item.map(encode).join(',') + ']';
    return '{' + Object.keys(item).sort(compare).map(key => JSON.stringify(key) + ':' + encode(item[key])).join(',') + '}';
  }
  const json = encode(message); invariant(Buffer.byteLength(json) <= 1024 ** 2, 'A2A_MESSAGE_LIMIT');
  return { message, json, sha256: createHash('sha256').update(json).digest('hex') };
}
