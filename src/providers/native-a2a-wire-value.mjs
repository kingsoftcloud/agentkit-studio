/** Normalize remote protobuf-JSON values before identity/collision checks.
 * This is a Node wire adapter, with no SDK, Host or Python dependency. Empty
 * proto3 scalars/lists are absent; explicitly present empty messages survive.
 * Struct/Value contents retain their own null/default values and double domain. */
import { invariant } from '@kingsoftcloud/agentkit-harness-core';
import { a2aState } from './native-a2a-protocol.mjs';
const plain = value => value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function text(value) {
  invariant(typeof value === 'string', 'A2A_CANONICAL_VALUE_INVALID');
  for (const char of value) { const cp = char.codePointAt(0); invariant(cp < 0xd800 || cp > 0xdfff, 'A2A_CANONICAL_UNICODE_INVALID'); }
  return value;
}
export function a2aJsonValue(value, depth = 0) {
  invariant(depth <= 100, 'A2A_CANONICAL_DEPTH_LIMIT');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return text(value);
  if (typeof value === 'number' || typeof value === 'bigint') {
    const number = Number(value); invariant(Number.isFinite(number), 'A2A_CANONICAL_VALUE_INVALID'); return number;
  }
  if (Array.isArray(value)) return Array.from(value, child => a2aJsonValue(child, depth + 1));
  invariant(plain(value), 'A2A_CANONICAL_VALUE_INVALID');
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [text(key), a2aJsonValue(child, depth + 1)]));
}
const schemas = {
  message: { messageId: 'string', contextId: 'string', taskId: 'string', role: 'role', parts: ['part'], metadata: 'struct', extensions: ['string'], referenceTaskIds: ['string'] },
  artifact: { artifactId: 'string', name: 'string', description: 'string', parts: ['part'], metadata: 'struct', extensions: ['string'] },
  part: { text: 'oneof', raw: 'bytes', url: 'oneof', data: 'value', metadata: 'struct', filename: 'string', mediaType: 'string' },
  task: { id: 'string', contextId: 'string', status: 'status', artifacts: ['artifact'], history: ['message'], metadata: 'struct' },
  status: { state: 'state', message: 'message', timestamp: 'timestamp' },
  statusUpdate: { taskId: 'string', contextId: 'string', status: 'status', metadata: 'struct' },
  artifactUpdate: { taskId: 'string', contextId: 'string', artifact: 'artifact', append: 'bool', lastChunk: 'bool', metadata: 'struct' },
  response: { task: 'task', message: 'message', statusUpdate: 'statusUpdate', artifactUpdate: 'artifactUpdate' },
};
function normalize(type, raw, depth) {
  invariant(depth <= 100, 'A2A_CANONICAL_DEPTH_LIMIT');
  if (type === 'value') return a2aJsonValue(raw, depth);
  if (type === 'struct') { invariant(plain(raw), 'A2A_CANONICAL_METADATA_INVALID'); return a2aJsonValue(raw, depth); }
  if (type === 'bool') { invariant(typeof raw === 'boolean', 'A2A_CANONICAL_VALUE_INVALID'); return raw; }
  if (['string', 'oneof'].includes(type)) return text(raw);
  if (type === 'role') { invariant(['ROLE_USER', 'ROLE_AGENT'].includes(raw), 'A2A_CANONICAL_MESSAGE_ROLE_INVALID'); return raw; }
  if (type === 'state') return 'TASK_STATE_' + a2aState(raw).toUpperCase().replace('CANCELLED', 'CANCELED');
  if (type === 'bytes') {
    const encoded = text(raw); invariant(/^[A-Za-z0-9+/_-]*={0,2}$/u.test(encoded), 'A2A_CANONICAL_BYTES_INVALID');
    const bytes = Buffer.from(encoded, 'base64');
    invariant(bytes.toString('base64url') === encoded.replace(/=+$/u, '').replace(/\+/gu, '-').replace(/\//gu, '_'), 'A2A_CANONICAL_BYTES_INVALID');
    return bytes.toString('base64');
  }
  if (type === 'timestamp') {
    const match = text(raw).match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$/u);
    invariant(match && Number.isFinite(Date.parse(match[1] + match[3])), 'A2A_CANONICAL_TIMESTAMP_INVALID');
    const second = new Date(Date.parse(match[1] + match[3])).toISOString().replace('.000Z', '');
    const nanos = (match[2] ?? '').replace(/0+$/u, ''); return second + (nanos ? '.' + nanos : '') + 'Z';
  }
  invariant(plain(raw) && Object.keys(raw).every(key => Object.hasOwn(schemas[type], key)), 'A2A_CANONICAL_WIRE_INVALID');
  const result = {};
  for (const [field, kind] of Object.entries(schemas[type])) {
    const value = raw[field];
    if (value === undefined || value === null && kind !== 'value') continue;
    if (Array.isArray(kind)) {
      invariant(Array.isArray(value) && value.length <= 4096, 'A2A_CANONICAL_PARTS_LIMIT');
      if (value.length) result[field] = value.map(child => normalize(kind[0], child, depth + 1));
    } else {
      const converted = normalize(kind, value, depth + 1);
      if (!(kind === 'string' && converted === '' || kind === 'bool' && converted === false)) result[field] = converted;
    }
  }
  if (type === 'part') invariant(['text', 'raw', 'url', 'data'].filter(key => Object.hasOwn(result, key)).length === 1, 'A2A_CANONICAL_PART_ONEOF_INVALID');
  if (type === 'response') invariant(Object.keys(result).length === 1, 'A2A_WIRE_PAYLOAD_AMBIGUOUS');
  return result;
}
export const normalizeA2AObservation = (payload, method) => normalize(['GetTask', 'CancelTask'].includes(method) ? 'task' : 'response', payload, 0);
