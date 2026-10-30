/** Tests for A2A gateway identity verifier. Uses Node built-in crypto to generate
 *  real RSA signatures — no Python, no external dependencies. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createA2aGatewayIdentityVerifier } from '../src/providers/native-a2a-ingress-identity.mjs';

// Worker cases are retained. Parent additions below cover parser/prototype
// behavior against the shared strict Native JSON decoder.

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });

const TARGET = {
  accountId: 'account-1', tenantId: 'tenant-1', agentId: 'ar-target',
  runtimeId: 'runtime-target', a2aAgentId: 'a2a-agent-123456781234423482341234567890ab',
};

const NOW_MS = 1000000000000; // milliseconds
const NOW_S = NOW_MS / 1000;
const clock = () => NOW_MS; // returns milliseconds

function b64url(buf) { return buf.toString('base64url'); }

function makeToken(claims, key = privateKey, header = { alg: 'RS256' }) {
  const h = b64url(Buffer.from(JSON.stringify(header)));
  const p = b64url(Buffer.from(JSON.stringify(claims)));
  const sig = sign('rsa-sha256', Buffer.from(`${h}.${p}`, 'ascii'), key);
  return `${h}.${p}.${b64url(sig)}`;
}

/** Make a token with raw JSON payload (for duplicate key / BigInt injection). */
function makeTokenRaw(payloadJson, key = privateKey, header = { alg: 'RS256' }) {
  const h = b64url(Buffer.from(JSON.stringify(header)));
  const p = b64url(Buffer.from(payloadJson, 'utf8'));
  const sig = sign('rsa-sha256', Buffer.from(`${h}.${p}`, 'ascii'), key);
  return `${h}.${p}.${b64url(sig)}`;
}

function baseV1Claims(overrides = {}) {
  return {
    iss: 'agentengine-a2a-gateway', aud: 'a2a-runtime',
    exp: NOW_S + 30, iat: NOW_S - 1, jti: 'assertion-1',
    account_id: 'account-1', tenant_id: 'tenant-1',
    caller_principal_id: 'caller-1', caller_runtime_id: 'runtime-caller',
    target_agent_id: 'ar-target', target_runtime_id: 'runtime-target',
    target_a2a_agent_id: TARGET.a2aAgentId,
    body_sha256: createHash('sha256').update(Buffer.from('{}')).digest('hex'),
    query_sha256: createHash('sha256').update(Buffer.from('')).digest('hex'),
    http_method: 'POST', path: '/a2a/jsonrpc',
    ...overrides,
  };
}

function baseV2Claims(overrides = {}) {
  return {
    schema: 'a2a-forward-identity/v2', iss: 'agentengine-a2a-gateway', aud: 'a2a-runtime',
    exp: NOW_S + 30, iat: NOW_S - 1, jti: 'assertion-v2',
    sub: 'user-1', account_id: 'account-1', tenant_id: 'tenant-1',
    caller_principal_type: 'user', caller_principal_id: 'user-1',
    authn_mode: 'platform_api_key', key_id: 'key-1', sub_account_id: 'sub-1',
    platform_task_id: 'a2a-task-test', target_version_id: 'version-1', operation: 'send_message',
    target_agent_id: 'ar-target', target_runtime_id: 'runtime-target',
    target_a2a_agent_id: TARGET.a2aAgentId,
    body_sha256: createHash('sha256').update(Buffer.from('{}')).digest('hex'),
    query_sha256: createHash('sha256').update(Buffer.from('')).digest('hex'),
    http_method: 'POST', path: '/a2a/jsonrpc',
    ...overrides,
  };
}

function makeRequest(token, { method = 'POST', path = '/a2a/jsonrpc', query = '', body = '{}', headers = {} } = {}) {
  return {
    method, path, query,
    headers: { 'x-agentengine-a2a-assertion': token, 'x-agentengine-route-target': 'ar-target', ...headers },
    body: typeof body === 'string' ? new TextEncoder().encode(body) : body,
  };
}

// ---- v1 valid --------------------------------------------------------------

test('v1 valid assertion with no task binding', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  const identity = v.verify(makeRequest(makeToken(baseV1Claims())));
  assert.equal(identity.callerPrincipalType, 'runtime');
  assert.equal(identity.authnMode, 'workload_permit');
  assert.equal(identity.callerRuntimeId, 'runtime-caller');
  assert.equal(identity.subAccountId, null);
  assert.equal(identity.taskBinding, null);
  assert.equal(identity.targetAgentId, 'ar-target');
  assert.ok(Object.isFrozen(identity));
});

test('v1 valid assertion with task binding', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  const identity = v.verify(makeRequest(makeToken(baseV1Claims({
    platform_task_id: 'a2a-task-test', target_version_id: 'version-1', operation: 'send_message',
  }))));
  assert.deepEqual(identity.taskBinding, { platformTaskId: 'a2a-task-test', targetVersionId: 'version-1', operation: 'send_message' });
  assert.ok(Object.isFrozen(identity.taskBinding));
});

// ---- v2 valid --------------------------------------------------------------

test('v2 valid product key assertion', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  const identity = v.verify(makeRequest(makeToken(baseV2Claims())));
  assert.equal(identity.callerPrincipalType, 'user');
  assert.equal(identity.authnMode, 'api_key');
  assert.equal(identity.callerRuntimeId, null);
  assert.equal(identity.subAccountId, 'sub-1');
  assert.deepEqual(identity.taskBinding, { platformTaskId: 'a2a-task-test', targetVersionId: 'version-1', operation: 'send_message' });
});

// ---- probe -----------------------------------------------------------------

test('probe accepts valid v1 without caller/task requirements', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  v.verifyProbe(makeRequest(makeToken(baseV1Claims())));
});

test('probe rejects invalid signature', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  const { privateKey: other } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(() => v.verifyProbe(makeRequest(makeToken(baseV1Claims(), other))), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

test('probe rejects body tampering', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  assert.throws(() => v.verifyProbe(makeRequest(makeToken(baseV1Claims()), { body: 'tampered' })), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

test('probe rejects path mismatch', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  assert.throws(() => v.verifyProbe(makeRequest(makeToken(baseV1Claims()), { path: '/a2a/v1/tasks' })), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

test('probe rejects targetBinding mismatch (runtimeId)', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  assert.throws(() => v.verifyProbe(makeRequest(makeToken(baseV1Claims({ target_runtime_id: 'wrong' })))), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

test('probe rejects agentId mismatch (target_agent_id != configured agentId)', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  // claim says ar-other but route target header also says ar-other — self-consistent
  // but does NOT match configured agentId 'ar-target'
  const claims = baseV1Claims({ target_agent_id: 'ar-other' });
  const token = makeToken(claims);
  assert.throws(() => v.verifyProbe(makeRequest(token, { headers: { 'x-agentengine-route-target': 'ar-other' } })), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

// ---- tampering: body/query/path/header/target ------------------------------

test('tampered body rejected', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  assert.throws(() => v.verify(makeRequest(makeToken(baseV1Claims()), { body: '{"different":true}' })), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

test('tampered query rejected', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  const claims = baseV1Claims({ query_sha256: createHash('sha256').update(Buffer.from('foo=bar')).digest('hex') });
  assert.throws(() => v.verify(makeRequest(makeToken(claims), { query: 'different=1' })), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

test('tampered path rejected', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  assert.throws(() => v.verify(makeRequest(makeToken(baseV1Claims()), { path: '/a2a/v1/tasks' })), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

test('tampered route target header rejected', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  assert.throws(() => v.verify(makeRequest(makeToken(baseV1Claims()), { headers: { 'x-agentengine-route-target': 'ar-other' } })), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

test('missing route target header rejected', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  assert.throws(() => v.verify(makeRequest(makeToken(baseV1Claims()), { headers: { 'x-agentengine-route-target': '' } })), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

test('tampered target_runtime_id rejected', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  assert.throws(() => v.verify(makeRequest(makeToken(baseV1Claims({ target_runtime_id: 'wrong' })))), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

test('tampered target_a2a_agent_id rejected', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  assert.throws(() => v.verify(makeRequest(makeToken(baseV1Claims({ target_a2a_agent_id: 'a2a-agent-wrong' })))), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

test('target_agent_id mismatch with configured agentId rejected (self-consistent attack)', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  const claims = baseV1Claims({ target_agent_id: 'ar-other' });
  assert.throws(() => v.verify(makeRequest(makeToken(claims), { headers: { 'x-agentengine-route-target': 'ar-other' } })), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

// ---- expiry / iat ----------------------------------------------------------

test('expired token rejected', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  assert.throws(() => v.verify(makeRequest(makeToken(baseV1Claims({ exp: NOW_S - 1 })))), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

test('iat in future rejected', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  assert.throws(() => v.verify(makeRequest(makeToken(baseV1Claims({ iat: NOW_S + 10 })))), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

test('iat >= exp rejected', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  assert.throws(() => v.verify(makeRequest(makeToken(baseV1Claims({ iat: NOW_S + 10, exp: NOW_S + 5 })))), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

test('missing jti rejected', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  const claims = baseV1Claims(); delete claims.jti;
  assert.throws(() => v.verify(makeRequest(makeToken(claims))), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

// ---- schema validation -----------------------------------------------------

test('v2 with caller_runtime_id rejected', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  assert.throws(() => v.verify(makeRequest(makeToken(baseV2Claims({ caller_runtime_id: 'forged' })))), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

test('v2 with caller_principal_type=runtime rejected', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  assert.throws(() => v.verify(makeRequest(makeToken(baseV2Claims({ caller_principal_type: 'runtime' })))), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

test('v2 with authn_mode=workload_permit rejected', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  assert.throws(() => v.verify(makeRequest(makeToken(baseV2Claims({ authn_mode: 'workload_permit' })))), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

test('v2 with sub != caller_principal_id rejected', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  assert.throws(() => v.verify(makeRequest(makeToken(baseV2Claims({ sub: 'another' })))), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

test('v2 without task binding rejected', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  const claims = baseV2Claims(); delete claims.platform_task_id; delete claims.target_version_id; delete claims.operation;
  assert.throws(() => v.verify(makeRequest(makeToken(claims))), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

test('v2 with empty key_id rejected', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  assert.throws(() => v.verify(makeRequest(makeToken(baseV2Claims({ key_id: '' })))), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

test('unsupported schema v3 rejected', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  assert.throws(() => v.verify(makeRequest(makeToken(baseV2Claims({ schema: 'a2a-forward-identity/v3' })))), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

// ---- partial task binding --------------------------------------------------

test('partial task binding rejected', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  const claims = baseV1Claims({ platform_task_id: 'a2a-task-test', operation: 'send_message' });
  delete claims.target_version_id;
  assert.throws(() => v.verify(makeRequest(makeToken(claims))), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

test('invalid operation rejected', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  assert.throws(() => v.verify(makeRequest(makeToken(baseV1Claims({ platform_task_id: 'a2a-task-test', target_version_id: 'v1', operation: 'enqueue' })))), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

test('empty platform_task_id rejected', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  assert.throws(() => v.verify(makeRequest(makeToken(baseV1Claims({ platform_task_id: 'a2a-task-', target_version_id: 'v1', operation: 'send_message' })))), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

// ---- algorithm confusion / invalid signature -------------------------------

test('non-RS256 algorithm rejected', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  assert.throws(() => v.verify(makeRequest(makeToken(baseV1Claims(), privateKey, { alg: 'HS256' }))), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

test('invalid signature rejected', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  const { privateKey: other } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(() => v.verify(makeRequest(makeToken(baseV1Claims(), other))), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

// ---- malformed JWT / bounds ------------------------------------------------

test('missing assertion header rejected', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  assert.throws(() => v.verify(makeRequest('', { headers: { 'x-agentengine-a2a-assertion': '' } })), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

test('malformed JWT (2 parts) rejected', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  assert.throws(() => v.verify(makeRequest('a.b')), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

test('malformed base64url rejected', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  assert.throws(() => v.verify(makeRequest('!!!.bbb.ccc')), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

test('body over 2 MiB rejected', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  const big = new Uint8Array(2 * 1024 * 1024 + 1);
  assert.throws(() => v.verify(makeRequest(makeToken(baseV1Claims({ body_sha256: createHash('sha256').update(big).digest('hex') })), { body: big })), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

test('non-Uint8Array body rejected', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  assert.throws(() => v.verify({ method: 'POST', path: '/a2a/jsonrpc', query: '', headers: { 'x-agentengine-a2a-assertion': makeToken(baseV1Claims()), 'x-agentengine-route-target': 'ar-target' }, body: '{}' }), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

// ---- non-string headers get fixed error code -------------------------------

test('non-string assertion header rejected with fixed code', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  assert.throws(() => v.verify({ method: 'POST', path: '/a2a/jsonrpc', query: '', headers: { 'x-agentengine-a2a-assertion': ['array'], 'x-agentengine-route-target': 'ar-target' }, body: new Uint8Array(2) }), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
  assert.throws(() => v.verify({ method: 'POST', path: '/a2a/jsonrpc', query: '', headers: { 'x-agentengine-a2a-assertion': { obj: true }, 'x-agentengine-route-target': 'ar-target' }, body: new Uint8Array(2) }), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

test('non-string route target header rejected with fixed code', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  assert.throws(() => v.verify({ method: 'POST', path: '/a2a/jsonrpc', query: '', headers: { 'x-agentengine-a2a-assertion': makeToken(baseV1Claims()), 'x-agentengine-route-target': ['array'] }, body: new TextEncoder().encode('{}') }), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

// ---- duplicate keys in JWT payload -----------------------------------------

test('duplicate keys in JWT claims rejected', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  // Craft raw JSON with duplicate "aud" key
  const claims = baseV1Claims();
  const json = JSON.stringify(claims);
  // Inject duplicate key by appending after the opening brace
  const dupJson = '{"aud":"a2a-runtime",' + json.slice(1);
  assert.throws(() => v.verify(makeRequest(makeTokenRaw(dupJson))), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

test('duplicate keys in JWT header rejected', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  // Craft header with duplicate "alg" key
  const headerJson = '{"alg":"none","alg":"RS256"}';
  const payload = b64url(Buffer.from(JSON.stringify(baseV1Claims())));
  const headerB64 = b64url(Buffer.from(headerJson));
  const sig = sign('rsa-sha256', Buffer.from(`${headerB64}.${payload}`, 'ascii'), privateKey);
  assert.throws(() => v.verify(makeRequest(`${headerB64}.${payload}.${b64url(sig)}`)), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

// ---- BigInt / unsafe integer in exp/iat rejected ----------------------------

test('BigInt-sized integer in exp rejected', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  // exp as a number that exceeds Number.MAX_SAFE_INTEGER — would be BigInt in faithful parser
  const bigExp = '9999999999999999999'; // > MAX_SAFE_INTEGER
  const claimsJson = JSON.stringify(baseV1Claims()).replace(/"exp":[0-9.e+-]+/, `"exp":${bigExp}`);
  assert.throws(() => v.verify(makeRequest(makeTokenRaw(claimsJson))), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

// ---- identity frozen + JSON + no leak --------------------------------------

test('identity is frozen and JSON-serializable, no token/body in JSON', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  const token = makeToken(baseV1Claims());
  const identity = v.verify(makeRequest(token));
  assert.ok(Object.isFrozen(identity));
  const json = JSON.stringify(identity);
  assert.ok(!json.includes(token), 'token leaked');
  assert.ok(!json.includes('{}'), 'body leaked');
  for (const field of ['accountId','tenantId','callerPrincipalType','callerPrincipalId','callerRuntimeId','subAccountId','targetAgentId','targetRuntimeId','targetA2aAgentId','authnMode','taskBinding','verifiedBodySha256']) {
    assert.ok(field in identity, `missing: ${field}`);
  }
});

// ---- error code fixed + no cause -------------------------------------------

test('error code always A2A_INGRESS_IDENTITY_INVALID, no cause', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  try { v.verify(makeRequest('bad')); assert.fail('should throw'); }
  catch (e) { assert.equal(e.code, 'A2A_INGRESS_IDENTITY_INVALID'); assert.equal(e.cause, undefined); }
});

// ---- constructor validation -----------------------------------------------

test('invalid publicKeyPem rejected', () => {
  assert.throws(() => createA2aGatewayIdentityVerifier({ publicKeyPem: '', targetBinding: TARGET, clock }), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

test('invalid targetBinding rejected', () => {
  assert.throws(() => createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: null, clock }), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
  assert.throws(() => createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: { accountId: '', tenantId: 't', agentId: 'a', runtimeId: 'r', a2aAgentId: 'x' }, clock }), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

test('non-function clock rejected', () => {
  assert.throws(() => createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock: 'not-a-function' }), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

test('clock returning non-number rejected', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock: () => 'not-a-number' });
  assert.throws(() => v.verify(makeRequest(makeToken(baseV1Claims()))), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

test('clock returning NaN rejected', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock: () => NaN });
  assert.throws(() => v.verify(makeRequest(makeToken(baseV1Claims()))), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

// ---- v1 with explicit schema + wrong caller type ---------------------------

test('v1 with explicit schema=v1 accepted', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  assert.equal(v.verify(makeRequest(makeToken(baseV1Claims({ schema: 'a2a-forward-identity/v1' })))).callerPrincipalType, 'runtime');
});

test('v1 with caller_principal_type=user rejected', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  assert.throws(() => v.verify(makeRequest(makeToken(baseV1Claims({ caller_principal_type: 'user' })))), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

// ---- account/tenant mismatch ----------------------------------------------

test('account_id mismatch rejected', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  assert.throws(() => v.verify(makeRequest(makeToken(baseV1Claims({ account_id: 'wrong' })))), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

test('tenant_id mismatch rejected', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  assert.throws(() => v.verify(makeRequest(makeToken(baseV1Claims({ tenant_id: 'wrong' })))), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

// ---- v2 sub_account_id limits ----------------------------------------------

test('v2 with empty sub_account_id rejected', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  assert.throws(() => v.verify(makeRequest(makeToken(baseV2Claims({ sub_account_id: '' })))), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

test('v2 with sub_account_id over 64 chars rejected', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  assert.throws(() => v.verify(makeRequest(makeToken(baseV2Claims({ sub_account_id: 'x'.repeat(65) })))), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

test('signed prototype fields cannot supply inherited JWT claims or an inherited algorithm', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  const payload = JSON.stringify({ ['__proto__']: baseV1Claims() });
  assert.throws(() => v.verify(makeRequest(makeTokenRaw(payload))), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
  const h = b64url(Buffer.from('{"__proto__":{"alg":"RS256"}}')), p = b64url(Buffer.from(JSON.stringify(baseV1Claims())));
  const token = `${h}.${p}.${b64url(sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey))}`;
  assert.throws(() => v.verifyProbe(makeRequest(token)), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

test('task fields explicitly set to null are invalid provenance rather than absent legacy fields', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  for (const fields of [{ platform_task_id: null }, { platform_task_id: null, target_version_id: null, operation: null }])
    assert.throws(() => v.verify(makeRequest(makeToken(baseV1Claims(fields)))), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

test('signed invalid UTF-8 and escape-equivalent duplicate keys reject before any identity is returned', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  const h = b64url(Buffer.from('{"alg":"RS256"}'));
  const raw = Buffer.concat([Buffer.from(JSON.stringify(baseV1Claims()).slice(0, -1) + ',"extra":"'), Buffer.from([0xff]), Buffer.from('"}')]);
  const p = b64url(raw), token = `${h}.${p}.${b64url(sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey))}`;
  assert.throws(() => v.verify(makeRequest(token)), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
  const duplicate = JSON.stringify(baseV1Claims()).replace('{', '{"\\u0061ud":"a2a-runtime",');
  assert.throws(() => v.verify(makeRequest(makeTokenRaw(duplicate))), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

test('unknown critical JWS extensions and unencoded-payload declarations fail closed', () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  for (const extra of [{ crit: ['custom'] }, { b64: false }])
    assert.throws(() => v.verify(makeRequest(makeToken(baseV1Claims(), privateKey, { alg: 'RS256', ...extra }))), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});

test('malformed request and throwing or rejected async clocks expose only the fixed code with no unhandled rejection', async () => {
  const v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock });
  for (const request of [undefined, null, [], { headers: null }])
    assert.throws(() => v.verify(request), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
  for (const custom of [() => { throw Error('private clock'); }, () => Promise.reject(Error('private clock'))]) {
    const invalid = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: TARGET, clock: custom });
    assert.throws(() => invalid.verify(makeRequest(makeToken(baseV1Claims()))), error => {
      assert.equal(error.code, 'A2A_INGRESS_IDENTITY_INVALID'); assert.equal(error.cause, undefined);
      assert.doesNotMatch(String(error), /private clock/); return true;
    });
  }
  await new Promise(resolve => setImmediate(resolve));
});

test('configured destination is copied and must identify a real A2A resource', () => {
  const target = { ...TARGET }, v = createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: target, clock });
  target.agentId = 'ar-another'; assert.equal(v.verify(makeRequest(makeToken(baseV1Claims()))).targetAgentId, TARGET.agentId);
  assert.throws(() => createA2aGatewayIdentityVerifier({ publicKeyPem: publicPem, targetBinding: { ...TARGET, a2aAgentId: 'alias' }, clock }),
    { code: 'A2A_INGRESS_IDENTITY_INVALID' });
});
