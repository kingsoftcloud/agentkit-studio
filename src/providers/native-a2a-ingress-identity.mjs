/** RS256 request-bound Gateway identities, based on platform.py and identity.py
 * @355059d. Verification grants no local execution permit. Pure Node crypto;
 * token/body contents and crypto/parser failures never become diagnostics. */
import { constants, createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { parseNativeJson } from '../../packages/agentkit-harness-core/dist/index.mjs';

const code = 'A2A_INGRESS_IDENTITY_INVALID';
const fail = () => { const error = new Error(code); error.code = code; throw error; };
const check = condition => { if (!condition) fail(); };
const fixed = work => { try { return work(); } catch { fail(); } };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const sha = value => createHash('sha256').update(value).digest('hex');
const claim = (claims, name, max = 256) => {
  const value = claims[name]; check(typeof value === 'string' && value.trim() && value.length <= max && !value.includes('\0'));
  for (const character of value) check(character.codePointAt(0) < 0xd800 || character.codePointAt(0) > 0xdfff);
  return value;
};
const resource = value => /^(?:a2a-agent-)?[a-f0-9]{12}4[a-f0-9]{3}[89ab][a-f0-9]{15}$/u.test(value);
function decode(value) {
  check(typeof value === 'string' && /^[A-Za-z0-9_-]+$/u.test(value));
  const bytes = Buffer.from(value, 'base64url'); check(bytes.toString('base64url') === value); return bytes;
}
const json = value => parseNativeJson(new TextDecoder('utf-8', { fatal: true }).decode(decode(value)));
const header = (headers, name) => { check(typeof headers[name] === 'string'); return headers[name].trim(); };

export function createA2aGatewayIdentityVerifier(options = {}) {
  return fixed(() => {
    const { publicKeyPem, targetBinding, clock = Date.now } = options;
    check(typeof publicKeyPem === 'string' && Buffer.byteLength(publicKeyPem) <= 64 * 1024 && object(targetBinding) && typeof clock === 'function');
    const target = Object.fromEntries(['accountId', 'tenantId', 'agentId', 'runtimeId', 'a2aAgentId']
      .map(key => [key, claim(targetBinding, key, 64)]));
    check(target.agentId.startsWith('ar-') && resource(target.a2aAgentId));
    const key = createPublicKey(publicKeyPem); check(key.asymmetricKeyType === 'rsa');
    function claimsFor(request) {
      check(object(request) && typeof request.method === 'string' && typeof request.path === 'string' && typeof request.query === 'string'
        && object(request.headers) && request.body instanceof Uint8Array && request.body.byteLength <= 2 * 1024 ** 2);
      const token = header(request.headers, 'x-agentengine-a2a-assertion'); check(Buffer.byteLength(token) <= 64 * 1024);
      const parts = token.split('.'); check(parts.length === 3);
      const protectedHeader = json(parts[0]), claims = json(parts[1]);
      check(object(protectedHeader) && protectedHeader.alg === 'RS256' && !Object.hasOwn(protectedHeader, 'crit')
        && !Object.hasOwn(protectedHeader, 'b64') && object(claims));
      check(verifySignature('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1], 'ascii'),
        { key, padding: constants.RSA_PKCS1_PADDING }, decode(parts[2])));
      check(claims.iss === 'agentengine-a2a-gateway' && claims.aud === 'a2a-runtime');
      const now = clock();
      if (now && typeof now.then === 'function') void Promise.resolve(now).catch(() => {});
      check(typeof now === 'number' && Number.isFinite(now));
      check(typeof claims.exp === 'number' && Number.isFinite(claims.exp) && claims.exp > now / 1000
        && typeof claims.iat === 'number' && Number.isFinite(claims.iat) && claims.iat <= now / 1000 + 5 && claims.iat < claims.exp);
      claim(claims, 'jti');
      check(claims.body_sha256 === sha(request.body) && claims.query_sha256 === sha(Buffer.from(request.query, 'utf8'))
        && claims.http_method === request.method && claims.path === request.path);
      check(header(request.headers, 'x-agentengine-route-target') === target.agentId);
      for (const [wire, local] of [['account_id', 'accountId'], ['tenant_id', 'tenantId'], ['target_agent_id', 'agentId'],
        ['target_runtime_id', 'runtimeId'], ['target_a2a_agent_id', 'a2aAgentId']]) check(claim(claims, wire, 64) === target[local]);
      return claims;
    }
    return Object.freeze({
      verify(request) { return fixed(() => {
        const claims = claimsFor(request), taskFields = ['platform_task_id', 'target_version_id', 'operation'];
        let taskBinding = null;
        if (taskFields.some(field => Object.hasOwn(claims, field))) {
          const platformTaskId = claim(claims, 'platform_task_id', 64), targetVersionId = claim(claims, 'target_version_id', 64),
            operation = claim(claims, 'operation');
          check(platformTaskId.startsWith('a2a-task-') && platformTaskId.length > 'a2a-task-'.length
            && ['send_message', 'get_task', 'subscribe_to_task', 'cancel_task'].includes(operation));
          taskBinding = Object.freeze({ platformTaskId, targetVersionId, operation });
        }
        const product = claims.schema === 'a2a-forward-identity/v2';
        if (product) {
          check(claims.caller_principal_type === 'user' && claims.authn_mode === 'platform_api_key'
            && !['caller_agent_id', 'caller_runtime_id', 'permit_jti'].some(field => Object.hasOwn(claims, field))
            && claims.sub === claim(claims, 'caller_principal_id', 128) && taskBinding);
          claim(claims, 'key_id');
        } else {
          check((claims.schema == null || claims.schema === 'a2a-forward-identity/v1')
            && (claims.caller_principal_type === undefined || claims.caller_principal_type === 'runtime')
            && (claims.authn_mode === undefined || claims.authn_mode === 'workload_permit'));
        }
        return Object.freeze({ accountId: target.accountId, tenantId: target.tenantId,
          callerPrincipalType: product ? 'user' : 'runtime', callerPrincipalId: claim(claims, 'caller_principal_id', 128),
          callerRuntimeId: product ? null : claim(claims, 'caller_runtime_id', 64), subAccountId: product ? claim(claims, 'sub_account_id', 64) : null,
          targetAgentId: target.agentId, targetRuntimeId: target.runtimeId, targetA2aAgentId: target.a2aAgentId,
          authnMode: product ? 'api_key' : 'workload_permit', taskBinding, verifiedBodySha256: claims.body_sha256 });
      }); },
      verifyProbe(request) { return fixed(() => { claimsFor(request); }); },
    });
  });
}
