// Production NativeKernel/SQLite/gateway/product service/route with a real HTTP
// peer. DSH registry, SessionController and approval are explicit narrow doubles;
// this does not claim the separately required full mounted-Host/UI acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeKernel, emptyUsage, canonical } from '../packages/agentkit-harness-core/dist/index.mjs';
import { fixture, digest } from '../packages/agentkit-harness-core/test/fixtures.mjs';
import { SqliteRunStore } from '../packages/agentkit-harness/src/native/sqlite-store.mjs';
import { createNativeDshTools } from '../src/providers/native-dsh-tools.mjs';
import { nativeRecoveryBinding } from '../src/providers/native-recovery-binding.mjs';
import { createStudioNativeA2aControl } from '../src/host/services/native-a2a-control.mjs';
import { createSessionRoutes } from '../src/host/routes/sessions.mjs';
import { createStudioNativeRecovery } from '../src/host/services/native-recovery.mjs';

async function setup(t, { expectedAnswer = 42 } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-a2a-control-'))), workspaceRoot = join(root, 'workspace'); mkdirSync(workspaceRoot);
  const scope = { tenantId: 'local', workspaceId: 'workspace', userId: 'local-user', agentId: 'agent' };
  const task = { id: 'remote-original', contextId: 'context-original', status: { state: 'TASK_STATE_INPUT_REQUIRED' } };
  let sends = 0, gets = 0, continues = 0, cancels = 0, approvals = 0, modelCalls = 0, decision = 'allowed-once', revision = 1;
  const approvalRequests = [], registry = new Map(), failures = [], peerBodies = [];
  const server = createServer((req, res) => void (async () => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString('utf8'), body = JSON.parse(rawBody); peerBodies.push(rawBody);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/agentengine/api/v1/ListAToASpaceAgents') {
      res.end(JSON.stringify({ Code: 0, Data: { Agents: [{ A2AAgentId: 'remote', VersionId: 'version', AgentCard: {
        supportedInterfaces: [{ url: origin + '/rpc', protocolVersion: '1.0', protocolBinding: 'JSONRPC' }],
      } }] } })); return;
    }
    let result;
    if (body.method === 'GetTask') { gets++; assert.equal(body.params.id, task.id); result = task; }
    else if (body.method === 'CancelTask') { cancels++; assert.equal(body.params.id, task.id); task.status.state = 'TASK_STATE_CANCELED'; result = task; }
    else {
      assert.equal(body.method, 'SendMessage');
      if (body.params.message.taskId) {
        continues++; assert.equal(body.params.message.taskId, task.id); assert.equal(body.params.message.contextId, task.contextId);
        assert.deepEqual(body.params.message.parts, [{ data: { answer: expectedAnswer } }]); task.status.state = 'TASK_STATE_COMPLETED';
      } else sends++;
      result = { task };
    }
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  })().catch(error => { failures.push(error); res.statusCode = 500; res.end('{}'); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${server.address().port}`;
  const agent = { session: { id: 'session' } }, lifetime = new AbortController(), active = new Set();
  const ctx = { effect: install => install(), get: name => services[name], tools: {
    register(tool) { registry.set(tool.name, tool); return () => registry.delete(tool.name); },
    async execute(exec) { const tool = registry.get(exec.name), value = await tool.execute(exec.arguments, exec);
      return { isError: false, value, content: tool.output.render(exec.arguments, value) }; },
  } };
  const services = { sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
    sessions: { flush: async () => true },
    sessionProjections: { stateOf: (_session, name) => name === 'turnBoundary' ? { lastTurn: 1, openTurnStartSeq: 0 } : 'actual-preset' },
    sessionController: { resolveAgent: async id => { assert.equal(id, 'session'); return { agent }; } },
    approval: { request: async request => { approvals++; approvalRequests.push(request); return decision; } } };
  const config = { agentId: 'agent', a2aBindings: [{ local_name: 'remote', binding_id: 'binding', space_id: 'space',
    target_agent_id: 'remote', expected_version_id: 'version' }] };
  let store = new SqliteRunStore(join(root, 'runs.sqlite')), gateway, control;
  const binding = { agentId: 'agent', agentRevision: 1, runtime: 'harness', local: true, nativeEngineContract: 'agentkit.native-dsh-turn/v1' };
  function bind() {
    gateway = createNativeDshTools({ ctx, config, workspaceRoot, stateDir: join(root, 'state'),
      commandEnvironment: { KSADK_A2A_SERVICE_URL: origin, KSADK_A2A_ALLOW_PRIVATE: 'true' } });
    binding.nativeTools = gateway;
    control = createStudioNativeA2aControl({ ctx, store, workspaceId: 'workspace', lifetime, active,
      agentEvents: () => ({ serial: async name => { assert.equal(name, 'agentkit/native-recovery-binding'); return { ...binding, agentRevision: revision }; } }) });
  }
  t.after(async () => {
    lifetime.abort(); await Promise.allSettled([...active]); await gateway.close(); store.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); assert.deepEqual(failures, []);
  });
  bind();
  const capsule = nativeRecoveryBinding({ binding, input: { messages: [{ id: 'user', role: 'user', content: [{ type: 'text', text: 'call remote' }] }] },
    source: { provider: 'fixture', model: 'fixture' }, selection: {}, systemPrompt: 'fixture' });
  const data = fixture({ tools: gateway.definitions(agent, [...registry.values()]), hostRecoveryBinding: capsule });
  const kernel = new NativeKernel({ store, digest, owner: 'original', ports: { ...gateway.forAgent(agent, { scope, store }), model: {
    generate: async () => { modelCalls++; return { kind: 'tool_calls', text: '', usage: emptyUsage(),
      toolCalls: [{ callId: 'actual-call', name: 'call_a2a_agent', arguments: { agent: 'remote', message: 'initial' } }] }; },
  } } });
  kernel.start({ ...data.snapshot, scope }, data.config); const snapshot = await kernel.runUntilIdle(scope, 'run');
  assert.equal(snapshot.phase, 'awaiting_reconciliation');
  const intent = store.load(scope, 'run').intents.find(intent => intent.kind === 'tool');
  const request = { agentId: 'agent', sessionId: 'session', runId: 'run', operationKey: intent.operationKey, callId: 'actual-call' };
  const route = createSessionRoutes({ getNativeHost: async () => ({ controlA2aTask: (...args) => control(...args) }) });
  const invoke = async (kind, commandId, more = {}) => (await route('sessions/native-a2a-control', { ...request, kind, commandId, ...more })).value;

  return { request, invoke, route, approvalRequests, services, peerBodies,
    status: () => createStudioNativeRecovery({ ctx, store, workspaceId: 'workspace', lifetime, active, controls: new Map(),
      controlKey: () => 'key', execute: {} }).status(request),
    count: () => ({ sends, gets, continues, cancels, approvals, modelCalls }),
    ledger: () => canonical(store.load(scope, 'run')), deny: () => { decision = 'denied'; }, drift: () => { revision++; },
    async reopen() { await gateway.close(); store.close(); store = new SqliteRunStore(join(root, 'runs.sqlite')); bind(); } };
}
test('Studio control route reopens the original Native task, approves exact data input and never re-enters the Native loop', async t => {
  const f = await setup(t), ledger = f.ledger(); await f.reopen();
  assert.deepEqual((await f.status()).a2aTasks, [{ runId: 'run', operationKey: f.request.operationKey, callId: 'actual-call' }]);
  assert.equal(f.count().gets, 0, 'opening the task inventory never contacts a remote agent');
  const observed = await f.invoke('get', 'read'); assert.equal(observed.state, 'input_required');
  assert.equal(f.count().approvals, 0);
  const parts = [{ data: { answer: 42 } }];
  const result = await f.invoke('continue', 'reply', { parts, pauseDigest: observed.pauseDigest });
  assert.equal(result.state, 'completed'); assert.equal(result.outcome, 'submitted');
  assert.equal(f.approvalRequests[0].agent.session.id, 'session');
  assert.deepEqual(JSON.parse(f.approvalRequests[0].reason).parts, parts);
  assert.equal(JSON.parse(f.approvalRequests[0].reason).remoteTaskId, 'remote-original');
  assert.equal(f.ledger(), ledger, 'remote observation does not forge a Native receipt or resume an interrupted Run');
  assert.equal(f.count().modelCalls, 1); assert.equal(f.count().sends, 1); assert.equal(f.count().continues, 1);
  await f.reopen(); assert.deepEqual(await f.invoke('continue', 'reply', { parts, pauseDigest: observed.pauseDigest }), result);
  assert.equal(f.count().continues, 1); assert.equal(f.count().approvals, 1, 'receipt confirmation is a read, not another approval or effect');
});
test('Studio structured input keeps unsafe integer JSON bytes through approval, wire and cold command confirmation', async t => {
  const f = await setup(t, { expectedAnswer: 9007199254740992 }), before = await f.invoke('get', 'read');
  const json = '{"answer":9007199254740993}', more = { json, pauseDigest: before.pauseDigest };
  const result = await f.invoke('continue', 'exact-json', more);
  assert.equal(result.outcome, 'submitted');
  assert.ok(f.peerBodies.some(body => body.includes('"answer":9007199254740993')));
  assert.ok(f.approvalRequests[0].reason.includes('"answer":9007199254740993'));
  await f.reopen(); assert.deepEqual(await f.invoke('continue', 'exact-json', more), result);
  assert.equal(f.count().continues, 1);
});
test('Studio caller cancellation stops an uncooperative Session lookup and does not revive it later', async t => {
  const f = await setup(t), entered = Promise.withResolvers(), delayed = Promise.withResolvers();
  f.services.sessionController.resolveAgent = () => { entered.resolve(); return delayed.promise; };
  const controller = new AbortController();
  const pending = f.route('sessions/native-a2a-control', { ...f.request, kind: 'get', commandId: 'cancelled-lookup' }, controller.signal);
  await entered.promise; controller.abort(Object.assign(new Error('caller stopped'), { code: 'TEST_ABORT' }));
  await assert.rejects(pending, { code: 'TEST_ABORT' }); delayed.resolve({ agent: { session: { id: 'session' } } });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.count().gets, 0);
});
test('Studio cancellation requires fresh approval even under workspace-write; denial does not cancel remotely', async t => {
  const f = await setup(t); f.deny();
  await assert.rejects(f.invoke('cancel', 'denied'), { code: 'A2A_CONTROL_PERMISSION_DENIED' });
  assert.equal(f.count().cancels, 0); assert.equal(f.count().approvals, 1); assert.equal(f.count().modelCalls, 1);
});
test('Studio approved remote cancellation confirms the original task without fabricating a Native terminal', async t => {
  const f = await setup(t), original = f.ledger();
  const result = await f.invoke('cancel', 'approved-cancel');
  assert.equal(result.outcome, 'remote_cancelled'); assert.equal(result.state, 'cancelled');
  assert.equal(f.count().approvals, 1); assert.equal(f.count().cancels, 1); assert.equal(f.count().gets, 2);
  assert.equal(f.ledger(), original); assert.equal(f.count().modelCalls, 1);
});
test('Studio rejects changed preset, another call and caller-supplied authority/URL before remote controls', async t => {
  const f = await setup(t);
  await assert.rejects(f.route('sessions/native-a2a-control', { ...f.request, kind: 'get', commandId: 'bad', authority: {} }), { code: 'STUDIO_NATIVE_A2A_CONTROL_INVALID' });
  await assert.rejects(f.route('sessions/native-a2a-control', { ...f.request, kind: 'get', commandId: 'bad', url: 'https://other.invalid' }), { code: 'STUDIO_NATIVE_A2A_CONTROL_INVALID' });
  await assert.rejects(f.route('sessions/native-a2a-control', { ...f.request, callId: 'another-call', kind: 'get', commandId: 'bad' }), { code: 'STUDIO_NATIVE_A2A_CALL_NOT_FOUND' });
  f.drift(); await assert.rejects(f.invoke('get', 'changed'), { code: 'studio_native_recovery_preset_changed' });
  assert.equal(f.count().gets, 0); assert.equal(f.count().continues, 0); assert.equal(f.count().cancels, 0);
});
for (const change of ['preset', 'revision']) test(`Studio ${change} change while approval waits cannot authorize the old task control`, async t => {
  const f = await setup(t);
  f.services.approval.request = async () => {
    if (change === 'preset') f.services.sessionProjections.stateOf = () => 'another-preset';
    else f.drift();
    return 'allowed-once';
  };
  await assert.rejects(f.invoke('cancel', 'changed-during-approval'), { code: change === 'preset'
    ? 'STUDIO_NATIVE_A2A_PRESET_CHANGED' : 'studio_native_recovery_preset_changed' });
  assert.equal(f.count().gets, 0); assert.equal(f.count().cancels, 0);
});
