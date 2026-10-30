import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createInternalA2AControlPlane, preparedA2AOperation, a2aResourceId } from '../src/providers/native-a2a-control-plane.mjs';
import { a2aMessageDigest, normalizeA2AMessage } from '../src/providers/native-a2a-message.mjs';
import { parseNativeJson } from '@kingsoftcloud/agentkit-harness-core';
const agent = 'a2a-agent-11111111111141118111111111111111', version = 'a2a-version-22222222222242228222222222222222';
const task = 'a2a-task-33333333333343338333333333333333', space = 'as-123456789abc';
const prepared = () => ({ A2ATaskId: task, Target: { A2AAgentId: agent, VersionId: version, CardSha256: 'c'.repeat(64) },
  Route: { Kind: 'hosted_gateway', Interface: { Url: 'https://gateway.example/rpc', ProtocolBinding: 'JSONRPC', ProtocolVersion: '1.0' },
    Capabilities: { Streaming: true } }, CallPermit: 'private-call-permit', CallPermitExpiresAt: new Date(Date.now() + 60000).toISOString() });
const authority = fields => ({ ...fields, signal: new AbortController().signal, assertCurrent: () => true });
async function setup(t, handler) {
  const calls = [], tokens = [], server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const call = { action: req.url.split('/').at(-1), path: req.url, headers: req.headers, body: parseNativeJson(raw) }; calls.push(call);
    if (handler) return handler(call, res);
    res.setHeader('Content-Type', 'application/json'); let data = {};
    if (call.action === 'ListA2ASpaceAgents') data = { Agents: [{ A2AAgentId: agent, VersionId: version, Source: 'hosted',
      RouteKind: 'hosted_gateway', Callable: true, AgentCard: { name: 'Research' }, CardSha256: 'c'.repeat(64) }], NextCursor: 'next' };
    if (call.action.startsWith('Prepare')) data = prepared();
    if (call.action === 'ResolveA2ACredential') data = { Injection: { Headers: { 'X-Key': 'external-private-key' },
      Query: { key: 'external-private-query' }, Cookies: { session: 'external-private-cookie' } } };
    res.end(JSON.stringify({ Code: 0, Data: data }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const provider = { binding: { contract: 'fixture-token-provider' }, getToken(request) { request.assertCurrent();
    tokens.push(request.audience); return `${request.audience}-token-${tokens.length}`; } };
  const client = createInternalA2AControlPlane({ baseUrl: `http://127.0.0.1:${server.address().port}/base`, tokenProvider: provider });
  t.after(async () => { client.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { client, calls, tokens, provider };
}
test('actual internal HTTP Actions use fresh audience tokens and exact registry, permit, binding and credential payloads', async t => {
  const h = await setup(t), list = await h.client.listSpaceAgents(authority({ spaceId: space, cursor: 'cursor', includeBlocked: true, pageSize: 100 }));
  assert.equal(list.agents[0].agent_id, agent); assert.equal(list.nextCursor, 'next');
  const send = await h.client.prepareCall(authority({ spaceId: space, agentId: agent, versionId: version,
    messageId: 'message', messageSha256: 'a'.repeat(64), idempotencyToken: 'original-send' }));
  assert.equal(send.taskId, task); assert.equal(send.route.streaming, true);
  await h.client.prepareTaskOperation(authority({ taskId: task, operation: 'get_task' }));
  await h.client.prepareTaskOperation(authority({ taskId: task, operation: 'cancel_task', idempotencyToken: 'original-cancel' }));
  await h.client.bindRemoteTask(authority({ taskId: task, remoteTaskId: 'remote', remoteContextId: 'context', observedAt: '2026-10-24T00:00:00Z' }));
  await h.client.appendTaskEvents(authority({ taskId: task, events: [{ integer: 9007199254740993n }] }));
  const injection = await h.client.resolveCredential(authority({ taskId: task, credentialHandle: 'handle', permit: send.permit }));
  assert.equal(injection.query.key, 'external-private-query'); assert.equal(h.client.gatewayToken(authority({})), 'a2a-gateway-token-8');
  assert.deepEqual(h.tokens, ['a2a-registry', 'a2a-registry', 'a2a-registry', 'a2a-registry', 'a2a-task-sink', 'a2a-task-sink', 'credential-broker', 'a2a-gateway']);
  h.calls.forEach((call, i) => { assert.equal(call.path, '/base/agentengine/internal/v1/a2a/' + call.action);
    assert.equal(call.headers.authorization, `Bearer ${h.tokens[i]}-token-${i + 1}`); });
  assert.deepEqual(h.calls[1].body, { A2ASpaceId: space, TargetA2AAgentId: agent, ExpectedVersionId: version,
    MessageId: 'message', MessageSha256: 'a'.repeat(64), IdempotencyToken: 'original-send' });
  assert.equal(h.calls[5].body.Events[0].integer, 9007199254740993n);
  assert.doesNotMatch(JSON.stringify(h.client.binding), /private|token-\d|\/base/u);
});
test('invalid task operations and unsafe resource aliases never issue HTTP', async t => {
  const h = await setup(t);
  for (const fields of [{ operation: 'cancel_task' }, { operation: 'get_task', idempotencyToken: 'bad' },
    { operation: 'send_message', messageId: 'message', messageSha256: 'a'.repeat(64) }, { operation: 'get_task', messageId: 'bad' }])
    await assert.rejects(h.client.prepareTaskOperation(authority({ taskId: task, ...fields })));
  assert.throws(() => a2aResourceId('a2a-agent-not-a-server-id', 'agent'));
  assert.equal(a2aResourceId(agent.slice('a2a-agent-'.length), 'agent'), agent.slice('a2a-agent-'.length));
  assert.equal(h.calls.length, 0);
});
test('server errors and malformed replies never leak their echoed secrets or fetch causes', async t => {
  const h = await setup(t, (call, res) => { res.statusCode = 503; res.end(JSON.stringify({ Code: 500, Message: 'private-call-permit',
    Data: { Details: { Authorization: call.headers.authorization, key: 'external-private-key' } } })); });
  await assert.rejects(h.client.listSpaceAgents(authority({ spaceId: space })), error => {
    assert.equal(error.code, 'A2A_CONTROL_PLANE_ACTION_FAILED'); assert.doesNotMatch(String(error), /private-call-permit|token-\d|external-private-key/u);
    assert.equal(error.cause, undefined); return true;
  });
});
test('authority failure, asynchronous authority and reentrant mutation cannot enter the control plane', async t => {
  const h = await setup(t);
  for (const verdict of [false, undefined, () => Promise.reject(Error('late'))]) {
    const request = authority({ spaceId: space }); request.assertCurrent = () => typeof verdict === 'function' ? verdict() : verdict;
    await assert.rejects(h.client.listSpaceAgents(request), { code: 'A2A_CONTROL_PLANE_AUTHORITY_LOST' });
  }
  const changed = authority({ spaceId: space }); changed.assertCurrent = () => { changed.spaceId = 'as-ffffffffffff'; return true; };
  await assert.rejects(h.client.listSpaceAgents(changed), { code: 'A2A_CONTROL_PLANE_REQUEST_CHANGED' });
  assert.equal(h.calls.length, 0); await new Promise(resolve => setImmediate(resolve));
});
test('a noncooperative fetch is bounded and a late response is discarded after authority cancellation', async t => {
  // AbortSignal.timeout is unref'ed. This deliberately handle-free fetch
  // double needs test-owned liveness until the real deadline fires.
  const keepAlive = setInterval(() => {}, 1000); t.after(() => clearInterval(keepAlive));
  let settle, canceled = false;
  const client = createInternalA2AControlPlane({ baseUrl: 'https://internal.example', timeoutMs: 40,
    tokenProvider: { getToken: () => 'private' }, fetchImpl: () => new Promise(resolve => { settle = resolve; }) });
  await assert.rejects(client.listSpaceAgents(authority({ spaceId: space })), { name: 'TimeoutError' });
  settle(new Response(new ReadableStream({ cancel() { canceled = true; } })));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(canceled, true); client.close();
});
test('a reentrant asynchronous token provider cannot leak a rejected Promise or enter HTTP', async () => {
  const input = authority({ spaceId: space });
  const client = createInternalA2AControlPlane({ baseUrl: 'https://internal.example',
    tokenProvider: { getToken() { input.spaceId = 'as-ffffffffffff'; return Promise.reject(Error('private-token')); } },
    fetchImpl: () => assert.fail('invalid provider cannot enter HTTP') });
  await assert.rejects(client.listSpaceAgents(input), { code: 'A2A_CONTROL_PLANE_REQUEST_CHANGED' });
  await new Promise(resolve => setImmediate(resolve)); client.close();
});
test('prepared routes reject invalid identity, protocol, capability and remote reference shapes', () => {
  for (const change of [raw => raw.Route.Kind = 'other', raw => raw.Route.Interface.ProtocolVersion = '0.3',
    raw => raw.Route.Capabilities.Streaming = 'true', raw => raw.RemoteTask = 'remote', raw => raw.Target.VersionId = 'version-1']) {
    const raw = prepared(); change(raw); assert.throws(() => preparedA2AOperation(raw));
  }
});
const oracle = JSON.parse(readFileSync(new URL('./fixtures/a2a-message-reference.json', import.meta.url), 'utf8'));
for (const [index, row] of oracle.cases.entries()) test(`message permit hash matches actual reference protobuf and Python JSON case ${index + 1}`, () => {
  const result = a2aMessageDigest(parseNativeJson(row.sourceJson)); assert.equal(result.json, row.json); assert.equal(result.sha256, row.sha256);
});
test('legacy file parts become actual A2A 1.0 URL/raw parts and invalid values fail explicitly', () => {
  assert.deepEqual(normalizeA2AMessage({ messageId: 'm', role: 'ROLE_USER', parts: [{ file: { bytes: 'AP8B', name: 'data.bin' } }] }).parts,
    [{ raw: 'AP8B', filename: 'data.bin' }]);
  for (const part of [{ text: 'a', data: {} }, { raw: '%%%secret' }, { file: { uri: 'https://example.com', bytes: 'AP8B' } }, { data: NaN }])
    assert.throws(() => normalizeA2AMessage({ messageId: 'm', role: 'ROLE_USER', parts: [part] }));
  assert.throws(() => a2aMessageDigest({ messageId: 'm', role: 'ROLE_USER', parts: [{ text: '\ud800' }] }));
});
