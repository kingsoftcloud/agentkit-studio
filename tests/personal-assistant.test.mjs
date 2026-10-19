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
  const services = { sessionController: controller, agents: { withoutInitiator: work => work() }, permissionPresets: { set() {} },
    approval: { setPolicy: (_agent, value, options) => { assert.equal(value, 'never'); assert.deepEqual(options, { actor: 'automation' }); } }, sessions: { flush: async () => flush },
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

test('closing the submit transport before flush cannot cancel accepted cloud work or replay it twice', async t => {
  const f = fixture(), assistant = f.create();
  const started = Promise.withResolvers(), persisted = Promise.withResolvers();
  f.services.sessions.flush = () => { started.resolve(); return persisted.promise; };
  const token = 'fixture-assistant-token-at-least-24-chars';
  let responseRuns = 0;
  const runtime = await startBuildRuntimeHttp({ agentId: 'a', buildId: 'build_0123456789abcdef0123', token,
    runner: async () => { responseRuns++; assert.fail('assistant submission cannot use the Responses runner'); }, assistant, port: 0 });
  t.after(() => runtime.close()); t.after(() => persisted.resolve(true));
  const request = { requestId: 'lost-ack', text: 'finish after the page closes' }, client = new AbortController();
  const pending = fetch(`http://127.0.0.1:${runtime.address.port}/v1/assistant/submit`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(request), signal: client.signal });
  await started.promise;
  assert.equal(f.runs, 1); assert.equal(f.cancelled, 0);
  client.abort(); await assert.rejects(pending, { name: 'AbortError' });
  persisted.resolve(true);
  assert.equal((await assistant('submit', request)).accepted, true);
  f.complete();
  const snapshot = await f.create()('snapshot', { requestId: request.requestId });
  assert.equal(snapshot.status, 'completed'); assert.equal(snapshot.receipt.accepted, true);
  assert.equal(f.runs, 1); assert.equal(f.cancelled, 0); assert.equal(responseRuns, 0);
});

test('closing a native read poll releases that read without cancelling an accepted assistant turn', async t => {
  const f = fixture(), polling = Promise.withResolvers(), disconnected = Promise.withResolvers();
  const nativeCarrier = { dispose() {}, request(_sessionId, operation, _payload, { signal }) {
    assert.equal(operation, 'native-stream-poll');
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { disconnected.resolve(); reject(signal.reason); }, { once: true });
      polling.resolve();
    });
  } };
  const assistant = createPersonalAssistantRuntime({ ctx: { get: key => f.services[key] }, agentId: 'a', buildId: 'b',
    frozen: { spec: { runtime: { type: 'dsh-native' } } }, admit: async () => ({ presetId: 'assistant' }), nativeCarrier });
  await assistant('submit', { requestId: 'read-disconnect', text: 'keep working' });
  const token = 'fixture-assistant-token-at-least-24-chars';
  const runtime = await startBuildRuntimeHttp({ agentId: 'a', buildId: 'build_0123456789abcdef0123', token,
    runner: async () => assert.fail('assistant reads cannot use the Responses runner'), assistant, port: 0 });
  t.after(() => runtime.close());
  const client = new AbortController();
  const pending = fetch(`http://127.0.0.1:${runtime.address.port}/v1/assistant/native-stream-poll`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}', signal: client.signal });
  await polling.promise; client.abort(); await assert.rejects(pending, { name: 'AbortError' }); await disconnected.promise;
  assert.equal(f.cancelled, 0); assert.equal((await assistant('snapshot')).status, 'running');
  f.complete(); assert.equal((await f.create()('snapshot')).status, 'completed');
});

test('failed persistence never acknowledges; cancellation is an explicit command only', async () => {
  const f = fixture(), api = f.create(); f.setFlush(false);
  await assert.rejects(api('submit', { requestId: 'r', text: 'work' }), { code: 'ASSISTANT_PERSISTENCE_UNAVAILABLE' });
  assert.equal(f.cancelled, 0); assert.equal(f.runs, 1);
  f.setFlush(true); await api('submit', { requestId: 'r', text: 'work' }); assert.equal(f.runs, 1);
  await api('cancel'); assert.equal(f.cancelled, 1);
});

test('restarted duplicate requests keep completed status without policy changes or fake queued tasks', async () => {
  const f = fixture(), inbox = { 'next-turn': [], 'next-step': [] }, modes = new Map(), policies = new Map();
  let permissionCalls = 0, notices = 0;
  const projections = f.services.sessionController.projections;
  f.services.sessionController.projections = async input => {
    const value = await projections(input); return value && { ...value, values: { inbox } };
  };
  f.services.sessionProjections = { stateOf(session, key) { assert.equal(key, 'sandboxMode'); return modes.get(session.id); } };
  const setPolicy = (agent, policy, actor = 'user') => {
    const previous = policies.get(agent.session.id) || 'ask';
    if (previous === policy) return;
    policies.set(agent.session.id, policy);
    if (actor === 'automation') return;
    notices++;
    const message = { id: `policy-${notices}`, source: { kind: 'user-approval' }, content: [{ type: 'text', text: `Policy changed from ${previous} to ${policy}` }] };
    inbox['next-step'].push(message);
    const events = f.logs.get(agent.session.id);
    events.push({ seq: events.length, type: 'agent/inbox/spliced', data: { target: 'next-step', start: inbox['next-step'].length - 1, inserted: [message] } });
  };
  f.services.permissionPresets.set = (session, preset) => {
    assert.equal(preset, 'read-only'); permissionCalls++;
    modes.set(session.id, 'read-only'); policies.set(session.id, 'ask');
  };
  f.services.commands = { execute() { assert.fail('automation must not execute a user permission command'); } };
  f.services.approval.setPolicy = (agent, policy, options) => {
    assert.equal(policy, 'never'); assert.deepEqual(options, { actor: 'automation' }); setPolicy(agent, policy, options.actor);
  };
  const prompt = f.services.sessionController.prompt;
  f.services.sessionController.prompt = request => { assert.equal(policies.get(request.sessionId), 'never'); return prompt(request); };
  const request = { requestId: 'repeated', text: 'finish once' }, api = f.create();
  const accepted = await api('submit', request); inbox['next-step'].length = 0; f.complete();
  assert.equal((await api('snapshot')).status, 'completed'); assert.equal(permissionCalls, 1); assert.equal(notices, 0);
  // Old runtimes can leave these internal notices durable after the task ended.
  for (let i = 0; i < 2; i++) { setPolicy({ session: { id: accepted.sessionId } }, 'ask'); setPolicy({ session: { id: accepted.sessionId } }, 'never'); }
  const beforeReplay = notices, restarted = f.create();
  for (let i = 0; i < 2; i++) assert.equal((await restarted('submit', request)).accepted, true);
  const snapshot = await restarted('snapshot', { requestId: request.requestId });
  assert.equal(snapshot.status, 'completed'); assert.equal(snapshot.queuedCount, 0); assert.deepEqual(snapshot.queued, []);
  assert.equal(snapshot.receipt.accepted, true); assert.equal(f.runs, 1); assert.equal(permissionCalls, 1); assert.equal(notices, beforeReplay);
  // Recheck durable policy on each call rather than caching a previously safe Agent.
  modes.set(accepted.sessionId, 'danger-full-access');
  await restarted('submit', request);
  assert.equal(permissionCalls, 2); assert.equal(modes.get(accepted.sessionId), 'read-only'); assert.equal(policies.get(accepted.sessionId), 'never');
  assert.equal(f.runs, 1); assert.equal((await restarted('snapshot')).status, 'completed');
});

test('an unavailable or rejected native permission setter rejects the request before model admission', async () => {
  for (const permission of [undefined, {}, { set() { throw new Error('unknown preset'); } }]) {
    const f = fixture();
    f.services.permissionPresets = permission;
    await assert.rejects(f.create()('submit', { requestId: 'rejected', text: 'must not run' }), { code: 'ASSISTANT_PERMISSION_UNAVAILABLE' });
    assert.equal(f.runs, 0); assert.equal(f.requests.size, 0);
  }
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
  f.logs.get(receipt.sessionId).push({ seq: 2, type: 'user/message', data: {
    content: [{ type: 'text', text: 'private model context' }], source: { kind: 'skill-catalog', form: 'catalog' },
  } });
  const snapshot = await api('snapshot');
  assert.deepEqual(snapshot.messages.map(message => message.text), ['hello']);
});

test('a failed tool-only turn exposes one visible failure rather than empty assistant bubbles', async () => {
  const f = fixture(), api = f.create();
  const receipt = await api('submit', { requestId: 'news', text: '查一下今天最新的 AI 新闻' });
  const events = f.logs.get(receipt.sessionId);
  events.push({ seq: 2, type: 'assistant/message', data: { message: { content: [], toolCalls: [{ name: 'web_search' }] } } });
  events.push({ seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { code: 'UNKNOWN', message: 'Authorization: Bearer private-secret' } } } });
  const snapshot = await api('snapshot');
  assert.equal(snapshot.status, 'failed');
  assert.deepEqual(snapshot.messages.map(item => item.role), ['user']);
  assert.equal(snapshot.failure.code, 'ASSISTANT_TURN_FAILED');
  assert.match(snapshot.failure.message, /未完成/);
  assert.ok(!JSON.stringify(snapshot).includes('private-secret'));
  assert.equal(snapshot.retry.text, '查一下今天最新的 AI 新闻');
});

function enableScopedCancel(f) {
  f.services.agents.get = sessionId => f.logs.has(sessionId) ? { session: { id: sessionId } } : undefined;
  f.services.sessionProjections = { stateOf(session, key) {
    if (key === 'sandboxMode') return undefined;
    assert.equal(key, 'turnBoundary');
    const boundary = f.logs.get(session.id).findLast(event => event.type === 'turn/start' || event.type === 'turn/end');
    return { lastTurn: boundary?.data.turn, openTurnStartSeq: boundary?.type === 'turn/start' ? boundary.seq : null };
  } };
}

test('scoped cancellation rejects stale A after B starts without cancelling B', async () => {
  const f = fixture(); enableScopedCancel(f); const api = f.create();
  await api('submit', { requestId: 'A', text: 'first task' });
  const first = await api('snapshot'); assert.equal(first.currentTurn, 1); assert.equal(first.capabilities.execution.scopedCancel, true); assert.equal(api.scopedCancelSupported, true);
  f.complete(); await api('submit', { requestId: 'B', text: 'second task' });
  assert.equal((await api('snapshot')).currentTurn, 2);
  assert.deepEqual(await api('cancel-turn', { turn: first.currentTurn, turnStartSeq: first.turnStartSeq }), { accepted: false, reason: 'turn-changed' });
  assert.equal(f.cancelled, 0); assert.equal((await api('snapshot')).currentTurn, 2);
  const second = await api('snapshot');
  assert.deepEqual(await api('cancel-turn', { turn: second.currentTurn, turnStartSeq: second.turnStartSeq }), { accepted: true }); assert.equal(f.cancelled, 1);
});

test('scoped cancellation checks and cancels atomically before any queued microtask can switch turns', async () => {
  const f = fixture(); enableScopedCancel(f); const api = f.create();
  const receipt = await api('submit', { requestId: 'A', text: 'first task' });
  let state = { lastTurn: 1, openTurnStartSeq: 0 }, cancelledTurn;
  f.services.sessionProjections.stateOf = session => {
    assert.equal(session.id, receipt.sessionId);
    queueMicrotask(() => { state = { lastTurn: 2, openTurnStartSeq: 10 }; });
    return state;
  };
  f.services.sessionController.cancel = ({ sessionId }) => { assert.equal(sessionId, receipt.sessionId); cancelledTurn = state.lastTurn; return { accepted: true }; };
  assert.deepEqual(await api('cancel-turn', { turn: 1, turnStartSeq: 0 }), { accepted: true });
  assert.equal(cancelledTurn, 1); assert.equal(state.lastTurn, 2);
});

test('scoped cancellation never activates a cold session or falls back without native projection service', async () => {
  const f = fixture(), unsupported = f.create();
  assert.equal(unsupported.scopedCancelSupported, false); assert.equal((await unsupported('snapshot')).capabilities.execution.scopedCancel, false);
  await assert.rejects(unsupported('cancel-turn', { turn: 1, turnStartSeq: 0 }), { code: 'ASSISTANT_CANCEL_UNAVAILABLE' });
  enableScopedCancel(f); const api = f.create();
  f.services.sessionController.resolveAgent = async () => { throw new Error('must not activate'); };
  assert.deepEqual(await api('cancel-turn', { turn: 1, turnStartSeq: 0 }), { accepted: false, reason: 'turn-changed' });
  await assert.rejects(api('cancel-turn', { turn: 1 }), { code: 'ASSISTANT_CANCEL_TARGET_INVALID' });
  assert.equal(f.cancelled, 0); assert.equal(f.runs, 0);
});

test('scoped cancellation requires both exact turn number and start sequence', async () => {
  const f = fixture(); enableScopedCancel(f); const api = f.create();
  await api('submit', { requestId: 'A', text: 'work' });
  assert.deepEqual(await api('cancel-turn', { turn: 1, turnStartSeq: 1 }), { accepted: false, reason: 'turn-changed' });
  assert.deepEqual(await api('cancel-turn', { turn: 2, turnStartSeq: 0 }), { accepted: false, reason: 'turn-changed' });
  f.complete();
  assert.deepEqual(await api('cancel-turn', { turn: 1, turnStartSeq: 0 }), { accepted: false, reason: 'turn-changed' });
  assert.equal(f.cancelled, 0);
});

test('native binding opens only after durable Session creation and scopes every callback to its conversation', async () => {
  const f = fixture(); let opened, disposed = 0;
  const carrier = { open(options) { opened = options; return { carrierId: 'memory-handle', sessionId: options.sessionId }; },
    request(sessionId, operation, payload, options) { return { sessionId, operation, payload, signal: options.signal }; },
    dispose() { disposed++; } };
  const api = createPersonalAssistantRuntime({ ctx: { get: key => f.services[key] }, agentId: 'a', buildId: 'b',
    frozen: { spec: { runtime: { type: 'dsh-native' } } }, admit: async () => ({ presetId: 'assistant' }), nativeCarrier: carrier });
  f.setFlush(false);
  await assert.rejects(api('native-open', { conversation: 'own' }), { code: 'ASSISTANT_PERSISTENCE_UNAVAILABLE' });
  assert.equal(opened, undefined);
  f.setFlush(true);
  const binding = await api('native-open', { conversation: 'own' });
  assert.ok(f.logs.has(binding.sessionId)); assert.equal(f.runs, 0);
  await opened.runAssistant('submit', { conversation: 'foreign', requestId: 'bound-request', text: 'only current cloud session' });
  assert.equal(f.logs.size, 1); assert.equal(f.logs.get(binding.sessionId).filter(event => event.type === 'user/message').length, 1);
  assert.throws(() => opened.runAssistant('cancel', {}), { code: 'ASSISTANT_OPERATION_INVALID' });
  await assert.rejects(api('native-open', { conversation: 'own', sessionId: 'foreign' }), { code: 'ASSISTANT_INPUT_INVALID' });
  const signal = new AbortController().signal;
  const request = await api('native-stream-poll', { conversation: 'own', carrierId: binding.carrierId }, { signal });
  assert.equal(request.sessionId, binding.sessionId); assert.equal(request.signal, signal);
  const foreign = await api('native-call', { conversation: 'different', carrierId: binding.carrierId });
  assert.notEqual(foreign.sessionId, binding.sessionId, 'carrier receives authoritative current conversation, never caller sessionId');
  assert.equal(api.nativeCarrierSupported, true); api.dispose(); assert.equal(disposed, 1);
  assert.equal(f.cancelled, 0);
});

test('unavailable native carrier never creates a Session or advertises a binding', async () => {
  const f = fixture(), api = f.create();
  await assert.rejects(api('native-open', {}), { code: 'ASSISTANT_NATIVE_UNAVAILABLE' });
  assert.equal(api.nativeCarrierSupported, false); assert.equal(f.logs.size, 0);
});

test('new managed workspace creation is explicit while stored legacy sessions retain their previous policy', async () => {
  const f = fixture(), applied = [], creates = [];
  let fallbackPresets = 0, fallbackPolicies = 0;
  const create = f.services.sessionController.create;
  f.services.sessionController.create = input => { creates.push(input); return create(input); };
  f.services.permissionPresets.set = (_session, preset) => { assert.equal(preset, 'read-only'); fallbackPresets++; };
  f.services.approval.setPolicy = (_agent, policy, options) => { assert.equal(policy, 'never'); assert.deepEqual(options, { actor: 'automation' }); fallbackPolicies++; };
  const profile = { profile: 'workspace-managed/v1', managed: true, permission: 'workspace-write', approval: 'ask' };
  const permissionModel = { enabled: true, newSessionCwd: async () => '/controlled-runtime/assistant-workspaces/owned/files',
    ensure: async (agent, created) => { applied.push({sessionId:agent.session.id,created}); return profile; },
    snapshot: () => profile, policyOf: () => 'ask', dispose() {} };
  const api = createPersonalAssistantRuntime({ ctx: {get:key=>f.services[key]}, agentId:'a',buildId:'b',
    frozen:{spec:{runtime:{type:'dsh-native'}}},admit:async()=>({presetId:'assistant'}),permissionModel });
  await api('submit',{requestId:'managed-one',text:'write a workspace note'});
  await api('submit',{requestId:'managed-two',text:'read the note'});
  assert.equal(creates.length,1); assert.equal(creates[0].cwd,'/controlled-runtime/assistant-workspaces/owned/files');
  assert.deepEqual(applied.map(item=>item.created),[true,false]);
  assert.equal(fallbackPresets,0); assert.equal(fallbackPolicies,0);
  assert.equal((await api('snapshot')).capabilities.execution.permission,'workspace-write');
  assert.equal(api.managedPermissionsSupported,false,'interactive capability also needs the scoped native presence service');
  permissionModel.ensure = async () => ({managed:false});
  await api('submit',{requestId:'legacy',text:'keep original confinement'});
  assert.equal(fallbackPresets,1); assert.equal(fallbackPolicies,1);
});
