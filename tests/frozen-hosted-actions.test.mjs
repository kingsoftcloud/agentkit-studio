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
  const suffix = await hosted.dispatch('ListSessionEvents', { ...request, Limit: 3 }, headers, signal);
  const prefix = await hosted.dispatch('ListSessionEvents', { ...request, Limit: 3, BeforeSeqId: suffix.NextCursor,
    HistoryEpoch: suffix.HistoryEpoch, SnapshotSeqId: suffix.SnapshotSeqId }, headers, signal);
  assert.deepEqual([...prefix.Events, ...suffix.Events].map(x => x.SeqId), events.Events.map(x => x.SeqId), 'small backward pages must retain the run-start before its user header');
  await assert.rejects(hosted.dispatch('ListSessionMessages', request, { ...headers, 'x-agentengine-subject-id': 'foreign' }, signal));
  assert.throws(() => hosted.responsesInput({ SessionId: 'sess-cold', InvocationId: 'same', ResponsesInput: 'hello', UserId: 'owner' }, headers), { code: 'RUNTIME_RUN_INPUT_UNSUPPORTED' });
  await assert.rejects(hosted.dispatch('ListSessionMessages', { ...request, HistoryEpoch: 'foreign' }, headers, signal), { code: 'HISTORY_RELOAD_REQUIRED' });
  assert.ok(flushes > 0); assert.equal(disposals, 6);
});

import { readFrozenSessionEvents } from '../src/frozen-session-history.mjs';
test('Hosted UI Offset pages and forward session_seq acknowledgements cover every native event once', async () => {
  // One long invocation exceeds Hosted UI's 64-event initial page.
  const types = ['turn/start', 'user/message', ...Array(70).fill('assistant/message'), 'turn/end'];
  const events = types.map((type, seq) => ({ type, seq, time: 1700000000000 + seq,
    data: type === 'user/message' ? { source: { rpcId: 'native-run' }, content: [{ type: 'text', text: 'hello' }] }
      : type === 'assistant/message' ? { message: { content: [{ type: 'text', text: `answer-${seq}` }] } }
        : { reason: { kind: 'completed' } } }));
  const options = { handle: { read: async (offset, length) => ({ events: events.slice(offset, offset + length) }) },
    session: { sessionId: 'public', nativeSessionId: 'native', epoch: 'epoch-one' }, latestSeq: events.length,
    invocationId: async () => 'public-invocation', signal: AbortSignal.timeout(10000) };
  const read = request => readFrozenSessionEvents({ ...options, request });
  const newest = await read({ Offset: 0, Limit: 64 });
  assert.equal(newest.Total, 73);
  assert.deepEqual(newest.Events.map(x => x.SeqId), Array.from({ length: 64 }, (_, i) => i + 10));
  const oldest = await read({ Offset: newest.Events.length, Limit: 64, HistoryEpoch: newest.HistoryEpoch, SnapshotSeqId: newest.SnapshotSeqId });
  assert.equal(oldest.Total, 73);
  assert.deepEqual([...oldest.Events, ...newest.Events].map(x => x.SeqId), events.map(x => x.seq + 1));
  assert.equal(oldest.HasMore, false);
  const first = await read({ EventOrder: 'session_seq', Limit: 3 });
  assert.equal(first.EventOrder, 'session_seq');
  assert.equal(first.NextCursor, 3);
  assert.equal(first.HasMore, true);
  let page = first, all = [...first.Events];
  while (page.HasMore) {
    page = await read({ EventOrder: 'session_seq', Limit: 3, AfterSeqId: page.NextCursor,
      HistoryEpoch: page.HistoryEpoch, SnapshotSeqId: page.SnapshotSeqId });
    assert.ok(Number.isSafeInteger(page.NextCursor)); all.push(...page.Events);
  }
  assert.deepEqual(all.map(x => x.SeqId), events.map(x => x.seq + 1));
  const empty = await read({ EventOrder: 'session_seq', AfterSeqId: page.NextCursor,
    HistoryEpoch: page.HistoryEpoch, SnapshotSeqId: page.SnapshotSeqId });
  assert.equal(empty.NextCursor, 73);
  assert.equal(empty.HasMore, false);
});


test('session_seq honors an exclusive BeforeSeqId with or without a lower bound', async () => {
  const events = ['turn/start', 'user/message', ...Array(8).fill('assistant/message'), 'turn/end'].map((type, seq) => ({ type, seq, time: 1700000000000 + seq,
    data: type === 'user/message' ? { source: { rpcId: 'native-run' }, content: [] } : { message: { content: [] }, reason: { kind: 'completed' } } }));
  const options = { handle: { read: async (offset, length) => ({ events: events.slice(offset, offset + length) }) },
    session: { sessionId: 'public', nativeSessionId: 'native', epoch: 'fixed-epoch' }, latestSeq: events.length,
    invocationId: async () => 'invocation', signal: AbortSignal.timeout(10000) };
  for (const after of [undefined, 3]) {
    const page = await readFrozenSessionEvents({ ...options, request: { EventOrder: 'session_seq', BeforeSeqId: 7,
      ...(after === undefined ? {} : { AfterSeqId: after }), HistoryEpoch: 'fixed-epoch', SnapshotSeqId: events.length, Limit: 20 } });
    assert.deepEqual(page.Events.map(x => x.SeqId), Array.from({ length: 6 - (after ?? 0) }, (_, i) => i + 1 + (after ?? 0)));
    assert.equal(page.NextCursor, 6); assert.equal(page.HasMore, false); assert.equal(page.SnapshotSeqId, events.length);
  }
});
