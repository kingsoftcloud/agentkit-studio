import { createServer } from 'node:http';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { canonical, parseNativeJson } from '@kingsoftcloud/agentkit-harness-core';
import { createA2aGatewayIdentityVerifier } from '../../src/providers/native-a2a-ingress-identity.mjs';
import { createInternalA2AControlPlane } from '../../src/providers/native-a2a-control-plane.mjs';
import { createA2aInboundAdmission } from '../../src/providers/native-a2a-inbound-admission.mjs';

export const targetBinding = { accountId: 'account', tenantId: 'tenant', agentId: 'ar-target', runtimeId: 'runtime-target',
  a2aAgentId: 'a2a-agent-11111111111141118111111111111111' };
export const platformTaskId = 'a2a-task-22222222222242228222222222222222';
export const targetVersionId = 'a2a-version-33333333333343338333333333333333';
const sha = value => createHash('sha256').update(value).digest('hex');
const b64 = value => Buffer.from(value).toString('base64url');
export function ingressSigner() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  return { publicKeyPem, request(operation, { messageId = 'original-message', product = false, claims: changes = {}, body, query = '',
    httpMethod = 'POST', path = '/a2a/jsonrpc' } = {}) {
    const method = { send_message: 'SendMessage', get_task: 'GetTask', subscribe_to_task: 'SubscribeToTask', cancel_task: 'CancelTask' }[operation];
    body ??= canonical({ jsonrpc: '2.0', id: 'request', method, params: operation === 'send_message'
      ? { message: { message_id: messageId, parts: [{ text: '原始消息😀' }], metadata: { integer: 9007199254740993n }, extra: 'preserved' } }
      : { id: 'remote-original' } });
    const bytes = Buffer.from(body);
    const claims = { iss: 'agentengine-a2a-gateway', aud: 'a2a-runtime', exp: Date.now() / 1000 + 120,
      iat: Date.now() / 1000 - 1, jti: randomUUID(), account_id: targetBinding.accountId, tenant_id: targetBinding.tenantId,
      target_agent_id: targetBinding.agentId, target_runtime_id: targetBinding.runtimeId, target_a2a_agent_id: targetBinding.a2aAgentId,
      caller_principal_id: product ? 'user' : 'caller', ...(product
        ? { schema: 'a2a-forward-identity/v2', caller_principal_type: 'user', authn_mode: 'platform_api_key', sub: 'user', sub_account_id: 'sub', key_id: 'key' }
        : { schema: 'a2a-forward-identity/v1', caller_runtime_id: 'runtime-caller' }),
      platform_task_id: platformTaskId, target_version_id: targetVersionId, operation,
      body_sha256: sha(bytes), query_sha256: sha(query), http_method: httpMethod, path, ...changes };
    const first = b64(JSON.stringify({ alg: 'RS256' })) + '.' + b64(JSON.stringify(claims));
    const token = first + '.' + sign('RSA-SHA256', Buffer.from(first), privateKey).toString('base64url');
    return { method: httpMethod, path, query, body: bytes,
      headers: { 'x-agentengine-a2a-assertion': token, 'x-agentengine-route-target': targetBinding.agentId } };
  } };
}
export const input = request => ({ request, remoteTaskId: 'remote-original', remoteContextId: 'context-original', signal: new AbortController().signal });
export const ipcRequest = request => ({ ...request, body: undefined, bodyBase64: Buffer.from(request.body).toString('base64') });
export function kernelFact(seq, fields = {}) {
  return { schema_version: 1, event_id: randomUUID(), session_id: 'a2a-kernel-original', seq,
    timestamp: '2026-10-24T00:00:00Z', family: 'control', family_version: 1, event_type: 'control.run_transition',
    run_id: 'run-original', payload: { run_id: 'run-original', state: 'running' }, ...fields };
}
export async function inboundFixture(t, { eventRows = [], respond, assertCurrent = () => true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'a2a-inbound-'))), signer = ingressSigner(), calls = [], admitted = new Map();
  let hook, beforeAdmit;
  const server = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const call = { action: request.url.split('/').at(-1), authorization: request.headers.authorization, body: parseNativeJson(raw) };
      calls.push(call); assert.equal(call.authorization, call.action === 'AppendA2AProductKernelFacts' ? 'Bearer task-sink-workload' : 'Bearer registry-workload');
      if (call.action === 'AppendA2AProductKernelFacts') {
        await hook?.(call, null); await respond?.(call, null, response);
        if (!response.writableEnded && !response.destroyed) response.end(canonical({ Code: 0, Data: {} })); return;
      }
      if (await beforeAdmit?.(call) === false) { response.destroy(); return; }
      const id = `${call.action}:${call.body.A2ATaskId}:${call.body.Message?.message_id ?? call.body.Message?.messageId ?? call.body.RunId}`;
      let original = admitted.get(id), duplicate = Boolean(original);
      if (!original) { original = { command: randomUUID(), messageId: randomUUID() }; admitted.set(id, original); }
      const data = { SessionId: 'a2a-kernel-original', AgentId: targetBinding.agentId, CommandId: original.command,
        Receipt: { schema_version: 1, command_id: original.command, status: duplicate ? 'duplicate' : 'accepted', message_id: original.messageId,
          run_id: 'run-original', accepted_seq: 1000 } };
      await hook?.(call, data); await respond?.(call, data, response);
      if (!response.writableEnded && !response.destroyed) response.end(canonical({ Code: 0, Data: data }));
    } catch { if (!response.destroyed && !response.writableEnded) { response.statusCode = 500; response.end('{}'); } }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const client = createInternalA2AControlPlane({ baseUrl, tokenProvider: { getToken({ audience, assertCurrent }) {
    assertCurrent(); assert.ok(['a2a-registry', 'a2a-task-sink'].includes(audience)); return audience === 'a2a-registry' ? 'registry-workload' : 'task-sink-workload'; } } });
  const verifier = createA2aGatewayIdentityVerifier({ publicKeyPem: signer.publicKeyPem, targetBinding });
  const eventCalls = [], events = { async *subscribe(sessionId, cursor) {
    eventCalls.push({ sessionId, cursor }); for (const fact of eventRows) yield structuredClone(fact);
  } };
  const directory = join(root, 'private');
  const service = createA2aInboundAdmission({ directory, verifier, controlPlane: client, events, assertCurrent });
  t.after(async () => { service.close(); client.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true }); });
  return { root, directory, signer, client, verifier, service, baseUrl, calls, admitted, events, eventCalls,
    setHook: value => { hook = value; },
    setBeforeAdmit: value => { beforeAdmit = value; },
    record() { const path = readdirSync(directory).find(name => name.endsWith('.json')); return path ? parseNativeJson(readFileSync(join(directory, path), 'utf8')) : null; },
  };
}
