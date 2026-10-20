import test from 'node:test';
import assert from 'node:assert/strict';
import { startBuildRuntimeHttp } from '../src/build-runtime-http.mjs';

const token = 'frozen-runtime-token-for-hosted-tests';
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json',
  'x-agentengine-identity-namespace': 'kscloud-iam', 'x-agentengine-business-tenant-id': 'tenant',
  'x-agentengine-subject-type': 'user', 'x-agentengine-subject-id': 'owner' };
test('generic Hosted Actions share the frozen Responses ingress and require verified identity', async t => {
  const calls = [];
  const hosted = {
    prepareRun: async () => {}, flushRun: async () => {},
    responsesInput(request, carrier) {
      assert.equal(carrier['x-agentengine-subject-id'], 'owner');
      return { input: request.ResponsesInput, sessionId: request.SessionId, requestId: request.InvocationId, runId: 'run_' + 'a'.repeat(32), responseId: 'resp_test', stream: request.Stream };
    },
    async dispatch(action, request, carrier) { calls.push({ action, request, carrier }); return { Session: { SessionId: request.SessionId }, RuntimeSync: 'synced' }; },
  };
  const server = await startBuildRuntimeHttp({ agentId: 'local-frozen', buildId: 'build_0123456789abcdef0123', token, hosted,
    runner: async request => ({ output: request.input, sessionId: request.sessionId }), port: 0 });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address.port}`;
  const post = (action, body, extra = {}) => fetch(`${base}/agentengine/api/v1/${action}`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  const created = await post('CreateSession', { SessionId: 'sess-one' });
  assert.equal(created.status, 200);
  assert.deepEqual((await created.json()).Data, { Session: { SessionId: 'sess-one' }, RuntimeSync: 'synced' });
  const response = await post('RunAgent', { SessionId: 'sess-one', InvocationId: 'run-one', ResponsesInput: '你好', Stream: true });
  const stream = await response.text();
  assert.equal(response.status, 200); assert.match(stream, /response.completed/); assert.match(stream, /你好/);
  assert.equal((await post('CreateSession', {}, { authorization: 'Bearer bad' })).status, 401);
  assert.equal((await post('CreateSession', {}, { origin: 'https://untrusted' })).status, 401);
  assert.equal(calls.length, 1);
});

import { createFrozenHostedActions } from '../src/frozen-hosted-actions.mjs';
import { createRuntimeResponsesContract } from '../src/runtime-responses-contract.mjs';

test('cold Hosted history reads only native persisted facts, with owner/build isolation and stable epochs', async t => {
  const native = new Map(); let flushes = 0;
  const controller = {
    projections: async ({ sessionId }) => native.has(sessionId) ? { asOfSeq: native.get(sessionId).length - 1 } : null,
    create: async ({ sessionId }) => { native.set(sessionId, []); return { sessionId }; },
    selectModel: async () => {},
    resolveAgent: async id => ({ agent: { session: { snapshotEvents: () => native.get(id), append(type, data) {
      native.get(id).push({ type, data, seq: native.get(id).length, time: Date.now() });
    } } } }),
  };
  let disposals = 0;
  const services = { sessionController: controller, agents: { withoutInitiator: work => work() },
    sessions: { get: id => native.has(id) ? { id } : null, flush: async () => { flushes++; return true; } },
    sessionQuery: { observeSession: async id => {
      if (!native.has(id)) throw Object.assign(new Error('not found'), { code: 'session/not-found' });
      const events = native.get(id);
      return { header: { createdAt: 1700000000000 }, events, cursor: events.length - 1, [Symbol.dispose]: () => disposals++ };
    } },
  };
  const options = { agentId: 'local-frozen', buildId: 'build_0123456789abcdef0123', token, frozen: {},
    ctx: { get: name => services[name] }, admit: async () => ({ presetId: 'one' }), model: 'frozen-model', models: ['frozen-model'], bundleSha256: 'a'.repeat(64) };
  const make = () => createFrozenHostedActions({ ...options, responses: createRuntimeResponsesContract(options) });
  let hosted = make();
  const signal = AbortSignal.timeout(10000);
  await hosted.dispatch('CreateSession', { SessionId: 'sess-cold' }, headers, signal);
  const input = hosted.responsesInput({ SessionId: 'sess-cold', InvocationId: 'public-invocation', ResponsesInput: 'hello', Stream: true }, headers);
  await hosted.prepareRun(input);
  const log = native.get(input.sessionId);
  for (const [type, data] of [
    ['turn/start', { turn: 1 }], ['user/message', { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user', rpcId: input.runId } }],
    ['assistant/message', { message: { content: [{ type: 'text', text: 'cloud answer' }, { type: 'reasoning', text: 'hidden' }] } }],
    ['turn/end', { turn: 1, reason: { kind: 'completed' } }],
  ]) log.push({ type, data, seq: log.length, time: Date.now() });
  const request = { SessionId: 'sess-cold', Limit: 50, IncludeReasoning: true };
  const first = await hosted.dispatch('ListSessionMessages', request, headers, signal);
  assert.deepEqual(first.Messages.map(x => x.Content.text), ['hello', 'cloud answer']);
  assert.ok(first.Messages.every(x => x.InvocationId === 'public-invocation'));
  assert.ok(!JSON.stringify(first).includes('hidden'));
  hosted = make(); // All service-local state is discarded; DSH remains the only history owner.
  const restored = await hosted.dispatch('ListSessionMessages', request, headers, signal);
  assert.deepEqual(restored, first);
  const events = await hosted.dispatch('ListSessionEvents', { ...request, Offset: 0, EventOrder: 'session_seq' }, headers, signal);
  assert.deepEqual(events.Events.map(x => x.EventType), ['run_status', 'user_message', 'assistant_message', 'run_status']);
  await assert.rejects(hosted.dispatch('ListSessionMessages', request, { ...headers, 'x-agentengine-subject-id': 'foreign' }, signal));
  assert.throws(() => hosted.responsesInput({ SessionId: 'sess-cold', InvocationId: 'same', ResponsesInput: 'hello', UserId: 'owner' }, headers), { code: 'RUNTIME_RUN_INPUT_UNSUPPORTED' });
  await assert.rejects(hosted.dispatch('ListSessionMessages', { ...request, HistoryEpoch: 'foreign' }, headers, signal), { code: 'HISTORY_RELOAD_REQUIRED' });
  assert.ok(flushes > 0); assert.equal(disposals, 4);
});
