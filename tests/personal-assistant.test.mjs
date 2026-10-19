import test from 'node:test';
import assert from 'node:assert/strict';
import { createPersonalAssistantRuntime } from '../src/personal-assistant-runtime.mjs';
import { startBuildRuntimeHttp } from '../src/build-runtime-http.mjs';
import { createAssistantRoutes } from '../src/host/routes/assistant.mjs';

function fixture() {
  const logs = new Map(), requests = new Map(), timers = new Map(); let flush = true, cancelled = 0, runs = 0;
  const append = (id, type, data) => logs.get(id).push({ seq: logs.get(id).length, type, data });
  const controller = {
    projections: async ({ sessionId }) => logs.has(sessionId) ? { asOfSeq: logs.get(sessionId).length - 1 } : null,
    create: async ({ sessionId }) => logs.set(sessionId, []), selectModel: async () => {},
    resolveAgent: async id => ({ agent: { session: { id } } }),
    prompt: async ({ sessionId, requestId, requestFingerprint, content }) => {
      if (requests.has(requestId)) { assert.equal(requests.get(requestId), requestFingerprint); return; }
      requests.set(requestId, requestFingerprint); runs++;
      append(sessionId, 'turn/start', { turn: runs });
      append(sessionId, 'user/message', { content, source: { kind: 'user', rpcId: requestId } });
    },
    cancel: ({ sessionId }) => { cancelled++; append(sessionId, 'turn/end', { reason: { kind: 'aborted' } }); return { accepted: true }; },
    page: async ({ address }) => ({ records: logs.get(address.sessionId).map(event => ({ type: 'event', event })), hasMore: false }),
  };
  const services = { sessionController: controller, agents: { withoutInitiator: work => work() }, commands: { execute: async () => ({}) },
    approval: { setPolicy: (_agent, value) => assert.equal(value, 'never') }, sessions: { flush: async () => flush },
    schedule: { catalog: async () => [...timers.values()], create: async (sessionId, spec) => { const row = { ...spec, id: `task-${timers.size}`, sessionId }; timers.set(row.id, row); return row; },
      delete: async ({ sessionId, id }) => { assert.equal(timers.get(id).sessionId, sessionId); timers.delete(id); return { deleted: true }; } } };
  const calls = [], memories = [{ id: 'memory-a', text: 'prefer concise responses' }];
  const resources = async () => ({ listMemory: async (...args) => { calls.push(args); return { items: memories }; },
    writeMemory: async (...args) => { calls.push(args); return { accepted: true }; },
    deleteMemory: async (...args) => { calls.push(args); return { accepted: true }; } });
  const create = () => createPersonalAssistantRuntime({ ctx: { get: name => services[name] }, agentId: 'a', buildId: 'b',
    frozen: { spec: { runtime: { type: 'dsh-native' }, bindings: { plugins: [{ config: { binding: { resource: { kind: 'memory-instance', id: 'collection-a' } } } }] } } },
    admit: async () => ({ presetId: 'assistant' }), resources });
  return { create, logs, calls, services, requests, setFlush: value => { flush = value; }, get cancelled() { return cancelled; }, get runs() { return runs; },
    complete() { for (const id of logs.keys()) { append(id, 'assistant/message', { message: { content: [{ type: 'text', text: 'finished in cloud' }] } }); append(id, 'turn/end', { reason: { kind: 'completed' } }); } } };
}

test('cloud acceptance is durable and independent from client; fresh facade restores native history', async t => {
  const f = fixture(), assistant = f.create();
  const token = 'fixture-assistant-token-at-least-24-chars';
  const runtime = await startBuildRuntimeHttp({ agentId: 'a', buildId: 'build_0123456789abcdef0123', token, runner: async () => {}, assistant, port: 0 });
  t.after(() => runtime.close());
  const url = `http://127.0.0.1:${runtime.address.port}/v1/assistant/submit`;
  const client = new AbortController();
  const reply = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: 'request-a', text: 'continue after closing' }), signal: client.signal });
  assert.equal(reply.status, 202); assert.equal((await reply.json()).accepted, true);
  client.abort();
  assert.equal((await assistant('snapshot')).status, 'running'); assert.equal(f.cancelled, 0);
  f.complete();
  const reopened = await f.create()('snapshot');
  assert.equal(reopened.status, 'completed'); assert.equal(reopened.messages[1].text, 'finished in cloud');
  await assistant('submit', { requestId: 'request-a', text: 'continue after closing' }); assert.equal(f.runs, 1);
  assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 401);
});

test('failed persistence never acknowledges; cancellation is an explicit command only', async () => {
  const f = fixture(), api = f.create(); f.setFlush(false);
  await assert.rejects(api('submit', { requestId: 'r', text: 'work' }), { code: 'ASSISTANT_PERSISTENCE_UNAVAILABLE' });
  assert.equal(f.cancelled, 0); assert.equal(f.runs, 1);
  f.setFlush(true); await api('submit', { requestId: 'r', text: 'work' }); assert.equal(f.runs, 1);
  await api('cancel'); assert.equal(f.cancelled, 1);
});

test('official schedules are scoped to the cloud conversation', async () => {
  const f = fixture(), api = f.create();
  await api('schedule-create', { spec: { title: 'probe', prompt: 'work', after_seconds: 30 } });
  assert.equal((await api('schedule-list')).items.length, 1);
  assert.equal((await api('schedule-list', { conversation: 'other' })).items.length, 0);
  await api('schedule-delete', { id: 'task-0' }); assert.equal((await api('schedule-list')).items.length, 0);
  delete f.services.schedule;
  await assert.rejects(api('schedule-create', { spec: {} }), { code: 'ASSISTANT_SCHEDULE_UNAVAILABLE' });
});

test('memory reuses bound resource and partition; foreign IDs fail before mutation', async () => {
  const f = fixture(), api = f.create();
  await api('memory-save', { text: 'concise answers' });
  assert.equal(f.calls[0][0], 'collection-a'); assert.equal(f.calls[0][1], 'studio-anonymous');
  assert.equal(f.calls[0][3].agentId, 'a'); assert.equal(f.calls[0][3].flush, true);
  await assert.rejects(api('memory-delete', { id: 'foreign' }), { code: 'ASSISTANT_MEMORY_NOT_FOUND' });
  await api('memory-delete', { id: 'memory-a' }); assert.equal(f.calls.at(-1)[2], 'memory-a');
  await assert.rejects(api('submit', { text: '', requestId: 'r' }), { code: 'ASSISTANT_INPUT_INVALID' });
  await assert.rejects(api('snapshot', { conversation: '../other' }), { code: 'ASSISTANT_CONVERSATION_INVALID' });
});

test('Host rejects old images and non-DSH agents before sending anything', async () => {
  let connected = { agent: { spec: { runtime: { type: 'dsh-native' } } }, capabilities: [] }, calls = 0;
  const route = createAssistantRoutes({ deployments: async () => ({ agents: { connect: async () => connected } }), fetchImpl: async () => { calls++; } });
  await assert.rejects(route('assistant/execute', { agentId: 'a', operation: 'submit', input: {} }), { code: 'ASSISTANT_IMAGE_UPGRADE_REQUIRED' });
  connected.agent.spec.runtime.type = 'codex';
  await assert.rejects(route('assistant/execute', { agentId: 'a', operation: 'snapshot' }), { code: 'ASSISTANT_RUNTIME_INVALID' });
  await assert.rejects(route('assistant/execute', { operation: '../other' }), { code: 'ASSISTANT_OPERATION_INVALID' });
  assert.equal(calls, 0);
});


test('assistant transcript does not present injected instructions as human messages', async () => {
  const f = fixture(), api = f.create();
  const receipt = await api('submit', { requestId: 'r', text: 'hello' });
  f.logs.get(receipt.sessionId).push({ seq: 9, type: 'user/message', data: {
    content: [{ type: 'text', text: 'private model context' }], source: { kind: 'skill-catalog', form: 'catalog' },
  } });
  const snapshot = await api('snapshot');
  assert.deepEqual(snapshot.messages.map(message => message.text), ['hello']);
});

test('a failed tool-only turn exposes one visible failure rather than empty assistant bubbles', async () => {
  const f = fixture(), api = f.create();
  const receipt = await api('submit', { requestId: 'news', text: '查一下今天最新的 AI 新闻' });
  const events = f.logs.get(receipt.sessionId);
  events.push({ seq: 10, type: 'assistant/message', data: { message: { content: [], toolCalls: [{ name: 'web_search' }] } } });
  events.push({ seq: 12, type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { code: 'UNKNOWN', message: 'Authorization: Bearer private-secret' } } } });
  const snapshot = await api('snapshot');
  assert.equal(snapshot.status, 'failed');
  assert.deepEqual(snapshot.messages.map(item => item.role), ['user']);
  assert.equal(snapshot.failure.code, 'ASSISTANT_TURN_FAILED');
  assert.match(snapshot.failure.message, /未完成/);
  assert.ok(!JSON.stringify(snapshot).includes('private-secret'));
  assert.equal(snapshot.retry.text, '查一下今天最新的 AI 新闻');
});
