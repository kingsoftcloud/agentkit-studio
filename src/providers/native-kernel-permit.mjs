/** Server-issued AgentControlPermit/v1. Verification is deliberately separate
 * from durable nonce consumption, which must commit with command admission. */
import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { canonical, copy, invariant } from '../../packages/agentkit-harness-core/dist/index.mjs';

const code = 'NATIVE_KERNEL_PERMIT_INVALID';
const check = value => invariant(value, code);
const string = value => typeof value === 'string' && value.trim() && value.length <= 4096 && !value.includes('\0')
  && [...value].every(c => c.codePointAt(0) < 0xd800 || c.codePointAt(0) > 0xdfff);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const operations = new Set(['enqueue', 'steer', 'inject', 'interrupt', 'pause', 'resume', 'submit_interaction', 'get_status', 'subscribe_events']);
function timestamp(value) {
  check(typeof value === 'string');
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,6}))?(Z|[+-]\d\d:\d\d)?$/u.exec(value);
  check(match);
  const [, year, month, day, hour, minute, second, fraction = '', zone = 'Z'] = match;
  const end = new Date(0); end.setUTCFullYear(Number(year), Number(month), 0);
  check(Number(year) >= 1 && Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= end.getUTCDate()
    && Number(hour) < 24 && Number(minute) < 60 && Number(second) < 60);
  const time = Date.parse(value + (zone === 'Z' && !value.endsWith('Z') ? 'Z' : ''));
  check(Number.isFinite(time));
  return { milliseconds: time, microseconds: BigInt(time) * 1000n + BigInt(fraction.padEnd(6, '0').slice(3)) };
}
// Python signs UTC second-normalized timestamps, even when the wire carries
// offsets or microseconds. The verifier still checks the original expiry.
export function nativeKernelPermitBytes(value) {
  const data = copy(value); delete data.signature;
  for (const name of ['issued_at', 'expires_at']) data[name] = new Date(timestamp(data[name]).milliseconds).toISOString().replace(/\.\d{3}Z$/u, 'Z');
  // Known v1 fields have ASCII keys; additive string-keyed objects use Python's
  // Unicode code-point ordering rather than JavaScript UTF-16 ordering.
  const order = (a, b) => {
    const left = [...a], right = [...b];
    for (let i = 0; i < Math.min(left.length, right.length); i++) {
      const difference = left[i].codePointAt(0) - right[i].codePointAt(0); if (difference) return difference;
    }
    return left.length - right.length;
  };
  const encode = item => Array.isArray(item) ? '[' + item.map(encode).join(',') + ']'
    : object(item) ? '{' + Object.keys(item).sort(order).map(key => JSON.stringify(key) + ':' + encode(item[key])).join(',') + '}' : canonical(item);
  return Buffer.from(encode(data));
}

export function createNativeKernelPermitVerifier({ verificationKeys, target, clock = Date.now } = {}) {
  check(typeof verificationKeys === 'function' && object(target) && string(target.tenantId) && string(target.agentInstanceId)
    && typeof clock === 'function');
  const binding = Object.freeze({ tenantId: target.tenantId, agentInstanceId: target.agentInstanceId });
  return Object.freeze({ async verify(raw, request, operation) {
    try {
      // Copy before awaiting a rotating key provider. Caller mutation cannot
      // change the command/permit that was actually authenticated.
      const permit = copy(raw), expected = copy(request);
      check(object(permit) && permit.schema_version === 1 && permit.alg === 'Ed25519' && operations.has(operation));
      for (const name of ['permit_id', 'subject_ref', 'tenant_id', 'agent_instance_id', 'nonce', 'key_id', 'claims_digest', 'signature']) check(string(permit[name]));
      check(permit.session_id === null || string(permit.session_id));
      check(Array.isArray(permit.allowed_operations) && permit.allowed_operations.length > 0
        && permit.allowed_operations.every(item => operations.has(item)) && permit.allowed_operations.includes(operation));
      check(expected.authorization_ref === permit.permit_id && expected.tenant_id === binding.tenantId
        && expected.agent_instance_id === binding.agentInstanceId && permit.tenant_id === expected.tenant_id
        && permit.agent_instance_id === expected.agent_instance_id
        && (permit.session_id === null || permit.session_id === expected.session_id));
      const issued = timestamp(permit.issued_at).microseconds, expires = timestamp(permit.expires_at).microseconds, now = clock();
      check(Number.isSafeInteger(now));
      const current = BigInt(now) * 1000n;
      check(issued <= current && expires > current && expires > issued && expires - issued <= 300_000_000n);
      const keys = await verificationKeys(), pem = keys instanceof Map ? keys.get(permit.key_id)
        : object(keys) && Object.hasOwn(keys, permit.key_id) ? keys[permit.key_id] : null;
      check(typeof pem === 'string' && Buffer.byteLength(pem) <= 64 * 1024);
      const key = createPublicKey(pem), signature = Buffer.from(permit.signature, 'base64url');
      check(key.asymmetricKeyType === 'ed25519' && signature.length === 64 && signature.toString('base64url') === permit.signature
        && verifySignature(null, nativeKernelPermitBytes(permit), key, signature));
      const checkedAt = clock(); check(Number.isSafeInteger(checkedAt) && BigInt(checkedAt) * 1000n < expires);
      return Object.freeze({ permitId: permit.permit_id, subjectRef: permit.subject_ref, claimsDigest: permit.claims_digest,
        nonce: permit.nonce, keyId: permit.key_id, operation });
    } catch { invariant(false, code); }
  } });
}
