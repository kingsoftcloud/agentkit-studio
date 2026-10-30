// Production NativeKernel/SQLite/gateway/product service/route with a real HTTP
// peer. DSH registry, SessionController and approval are explicit narrow doubles;
// this does not claim the separately required full mounted-Host/UI acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeKernel, emptyUsage, canonical } from '@kingsoftcloud/agentkit-harness-core';
import { fixture, digest } from './fixtures/native-core.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { createNativeDshTools } from '../src/providers/native-dsh-tools.mjs';
import { nativeRecoveryBinding } from '../src/providers/native-recovery-binding.mjs';
import { createStudioNativeA2aControl } from '../src/host/services/native-a2a-control.mjs';
import { createSessionRoutes } from '../src/host/routes/sessions.mjs';
import { createStudioNativeRecovery } from '../src/host/services/native-recovery.mjs';
import { createManagedNativeKernel } from '../src/providers/native-managed-kernel.mjs';
import { createStudioManagedNativeSessionControl } from '../src/host/services/native-managed-kernel.mjs';
import { command as managedCommand, permitIssuer } from './fixtures/native-managed-kernel.mjs';
import { createStudioNativeManagedScopeControl } from '../src/host/services/native-managed-scope-control.mjs';
import { a2aDecisionDigest } from '../src/providers/native-a2a-decision.mjs';
import { DatabaseSync } from 'node:sqlite';

async function setup(t, { expectedAnswer = 42, managed = false, scoped = false, strict = false, unknownCancel = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-a2a-control-'))), workspaceRoot = join(root, 'workspace'); mkdirSync(workspaceRoot);
  const scope = { tenantId: managed ? 'managed-tenant' : 'local', workspaceId: 'workspace',
    userId: managed ? 'managed-user' : 'local-user', agentId: 'agent' };
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
    else if (body.method === 'CancelTask') { cancels++; assert.equal(body.params.id, task.id); task.status.state = 'TASK_STATE_CANCELED';
      if (unknownCancel) { res.destroy(); return; } result = task; }
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
    target_agent_id: 'remote', expected_version_id: 'version', ...(strict ? { policy_ref: 'policy://a2a/strict' } : {}) }] };
  let store = new SqliteRunStore(join(root, 'runs.sqlite')), gateway, control, runtime, managedConfig, managedLocalStore, managedIssuer, scopedControl;
  const binding = { agentId: 'agent', agentRevision: 1, runtime: 'harness', local: true, nativeEngineContract: 'agentkit.native-dsh-turn/v1' };
  function bind() {
    gateway = createNativeDshTools({ ctx, config, workspaceRoot, stateDir: join(root, 'state'),
      commandEnvironment: { KSADK_A2A_SERVICE_URL: origin, KSADK_A2A_ALLOW_PRIVATE: 'true' } });
    binding.nativeTools = gateway;
    control = createStudioNativeA2aControl({ ctx, store: managedLocalStore ?? store, workspaceId: 'workspace', lifetime, active,
      agentEvents: () => ({ serial: async name => { assert.equal(name, 'agentkit/native-recovery-binding'); return { ...binding, agentRevision: revision }; } }) });
    scopedControl = createStudioNativeManagedScopeControl({ ctx, workspaceId: 'workspace', lifetime, active,
      agentEvents: () => ({ serial: async () => ({ ...binding, agentRevision: revision }) }),
      readChildren: request => services.studioManagedNativeSessionControl.childHistory(request) });
  }
  t.after(async () => {
    lifetime.abort(); await Promise.allSettled([...active]); await runtime?.close(); await gateway.close(); store.close(); managedLocalStore?.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); assert.deepEqual(failures, []);
  });
  bind();
  const capsule = nativeRecoveryBinding({ binding, input: { messages: [{ id: 'user', role: 'user', content: [{ type: 'text', text: 'call remote' }] }] },
    source: { provider: 'fixture', model: 'fixture' }, selection: {}, systemPrompt: 'fixture' });
  const data = fixture({ tools: gateway.definitions(agent, [...registry.values()]), hostRecoveryBinding: capsule });
  const ports = () => ({ ...gateway.forAgent(agent, { scope, store }), model: {
    generate: async () => { modelCalls++;
      if (scoped && modelCalls > 1) return { kind: 'final_candidate', text: 'Root continued after scoped cancellation', toolCalls: [], usage: emptyUsage() };
      return { kind: 'tool_calls', text: '', usage: emptyUsage(),
      toolCalls: [{ callId: 'actual-call', name: 'call_a2a_agent', arguments: { agent: 'remote', message: 'initial' } }] }; },
  } });
  let runId = 'run';
  const installManagedControl = () => { services.studioManagedNativeSessionControl = createStudioManagedNativeSessionControl({
    runtime, target: { tenantId: scope.tenantId, agentInstanceId: scope.agentId }, principal: { userId: scope.userId } }); };
  if (managed) {
    const target = { tenantId: scope.tenantId, agentInstanceId: scope.agentId }, issuer = permitIssuer({ target }); managedIssuer = issuer;
    managedConfig = { directory: join(root, 'receiver'), target, permitVerifier: issuer.verifier, assertCurrent: () => true,
      autoStart: false, ...(scoped ? { scopedControl: { prepare: input => scopedControl.prepare(input), execute: input => scopedControl.execute(input) } } : {}),
      resolveBinding: () => ({ scope, buildId: data.snapshot.buildId,
        configuration: { ...data.config, inputMessages: [{ role: 'user', content: 'call remote' }] }, ports: ports() }) };
    await gateway.close(); runtime = createManagedNativeKernel(managedConfig); managedLocalStore = store;
    store = new SqliteRunStore(join(root, 'receiver/runs.sqlite')); bind(); installManagedControl();
    const cmd = managedCommand({ tenant_id: scope.tenantId, agent_instance_id: scope.agentId, session_id: 'session' });
    runId = (await runtime.receive(cmd, issuer.issue(cmd))).run_id; await runtime.drain('session');
  } else {
    const kernel = new NativeKernel({ store, digest, owner: 'original', ports: ports() });
    kernel.start({ ...data.snapshot, scope }, data.config); await kernel.runUntilIdle(scope, runId);
  }
  const snapshot = store.load(scope, runId).snapshot;
  assert.equal(snapshot.phase, 'awaiting_reconciliation');
  const intent = store.load(scope, runId).intents.find(intent => intent.kind === 'tool');
  const request = { agentId: 'agent', sessionId: 'session', runId, operationKey: intent.operationKey, callId: 'actual-call' };
  const route = createSessionRoutes({ getNativeHost: async () => ({ controlA2aTask: (...args) => control(...args) }) });
  const invoke = async (kind, commandId, more = {}) => (await route('sessions/native-a2a-control', { ...request, kind, commandId, ...more })).value;

  return { request, invoke, route, approvalRequests, services, peerBodies,
    scopedCommand: (changes = {}) => managedCommand({ tenant_id: scope.tenantId, agent_instance_id: scope.agentId, session_id: 'session',
      command_type: 'interrupt', payload: { run_id: runId, scope_id: `a2a-${a2aDecisionDigest({ scope, sessionId: 'session', runId,
        operationKey: request.operationKey, callId: request.callId })}` }, ...changes }),
    receiveScoped: cmd => runtime.receive(cmd, managedIssuer.issue(cmd)),
    scopedRow: id => { const db = new DatabaseSync(join(root, 'receiver/commands.sqlite'));
      try { return db.prepare('SELECT * FROM managed_scoped_controls WHERE command_id=?').get(id); } finally { db.close(); } },
    get record() { return store.load(scope, runId); },
    async reconcile() {
      // This narrow binding has no SDK whole-turn onIdle owner. Use the actual
      // receipt waiter to request its separately fenced read; the mounted SDK
      // verifier covers the automatic production owner path.
      const bound = ports(), command = await bound.tools.waitForReceipt({ snapshot: store.load(scope, runId).snapshot, signal: lifetime.signal });
      assert.equal(command.kind, 'reconcile_tool');
      assert.equal(new NativeKernel({ store, digest, owner: 'receipt-request', ports: bound }).submit(scope, runId, command).status, 'accepted');
    },
    drain: () => runtime.drain('session'),
    status: () => createStudioNativeRecovery({ ctx, store: managedLocalStore ?? store, workspaceId: 'workspace', lifetime, active, controls: new Map(),
      controlKey: () => 'key', execute: {} }).status(request),
    count: () => ({ sends, gets, continues, cancels, approvals, modelCalls }),
    ledger: () => canonical(store.load(scope, runId)), localRuns: () => managedLocalStore?.list(scope) ?? [],
    deny: () => { decision = 'denied'; }, drift: () => { revision++; },
    async reopen() { await gateway.close(); await runtime?.close(); store.close();
      if (managed) { runtime = createManagedNativeKernel(managedConfig); store = new SqliteRunStore(join(root, 'receiver/runs.sqlite')); installManagedControl(); }
      else store = new SqliteRunStore(join(root, 'runs.sqlite'));
      bind(); } };
}

async function scopedDelivery(f, cmd) {
  const deadline = Date.now() + 8000;
  for (;;) {
    const row = f.scopedRow(cmd.command_id);
    if (row && row.state !== 'queued') return row;
    assert.ok(Date.now() < deadline, `scoped delivery did not settle: ${JSON.stringify(row)}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
for (const unknownCancel of [false, true]) test(`signed Server scoped A2A cancellation keeps the root and original journal (unknown=${unknownCancel})`, async t => {
  const f = await setup(t, { managed: true, scoped: true, unknownCancel }), cancel = f.scopedCommand();
  const before = f.count(); assert.equal((await f.receiveScoped(cancel)).status, 'accepted');
  const row = await scopedDelivery(f, cancel); assert.equal(row.state, 'delivered');
  const result = JSON.parse(row.result); assert.equal(result.outcome, unknownCancel ? 'unknown' : 'remote_cancelled');
  assert.equal(f.count().cancels, 1); assert.equal(f.count().continues, 0); assert.equal(f.count().approvals, before.approvals);
  assert.equal(f.record.snapshot.phase, 'awaiting_reconciliation');
  assert.ok(!f.record.commands.some(row => row.command.kind === 'cancel'));
  assert.equal((await f.receiveScoped(cancel)).status, 'duplicate');
  const after = f.count(); await f.reopen();
  assert.equal((await f.receiveScoped(cancel)).status, 'duplicate'); assert.deepEqual(f.count(), after);
  if (unknownCancel) { const view = await f.invoke('get', 'confirm-original-cancel'); assert.equal(view.state, 'cancelled'); }
  await f.reconcile(); await f.drain(); assert.equal(f.record.snapshot.phase, 'completed');
  assert.equal(f.record.snapshot.finalText, 'Root continued after scoped cancellation');
  assert.equal(f.count().cancels, 1); assert.equal(f.count().sends, 1); assert.equal(f.count().modelCalls, 2);
});
test('Server scope routing refuses another invocation, session or frozen preset without root or remote effects', async t => {
  const f = await setup(t, { managed: true, scoped: true }), before = f.count();
  const wrong = f.scopedCommand({ payload: { run_id: f.request.runId, scope_id: 'a2a-unowned' } });
  assert.equal((await f.receiveScoped(wrong)).error.code, 'native_child_scope_not_found');
  const foreign = f.scopedCommand({ session_id: 'other' });
  assert.equal((await f.receiveScoped(foreign)).error.code, 'native_child_scope_not_found');
  f.drift();
  await assert.rejects(f.receiveScoped(f.scopedCommand()), { code: 'studio_native_recovery_preset_changed' });
  assert.deepEqual(f.count(), before); assert.equal(f.record.snapshot.phase, 'awaiting_reconciliation');
});
test('Server signature cannot replace original invocation consent after Host switches to read-only', async t => {
  const f = await setup(t, { managed: true, scoped: true }), before = f.count();
  f.services.sandboxPolicy = { resolve: () => ({ mode: 'read-only' }) };
  const cmd = f.scopedCommand(); assert.equal((await f.receiveScoped(cmd)).status, 'accepted');
  const row = await scopedDelivery(f, cmd); assert.equal(row.state, 'rejected');
  assert.deepEqual(f.count(), before); assert.equal(f.record.snapshot.phase, 'awaiting_reconciliation');
});
test('a preset changed after scoped admission permanently retires delivery before any remote cancellation', async t => {
  const f = await setup(t, { managed: true, scoped: true }), entered = Promise.withResolvers(), release = Promise.withResolvers();
  const resolve = f.services.sessionController.resolveAgent; let resolutions = 0;
  f.services.sessionController.resolveAgent = async id => {
    if (++resolutions === 2) { entered.resolve(); await release.promise; }
    return resolve(id);
  };
  const before = f.count(), cmd = f.scopedCommand(); assert.equal((await f.receiveScoped(cmd)).status, 'accepted');
  await entered.promise; f.drift(); release.resolve();
  assert.equal((await scopedDelivery(f, cmd)).state, 'rejected');
  assert.deepEqual(f.count(), before); assert.equal(f.record.snapshot.phase, 'awaiting_reconciliation');
  assert.equal((await f.receiveScoped(cmd)).status, 'duplicate');
});
test('strict bound invocation cannot use a standing workspace grant or Server signature as its approval', async t => {
  const f = await setup(t, { managed: true, scoped: true, strict: true });
  assert.equal(f.count().approvals, 1, 'original dispatch must request exact-call approval under strict binding');
  const before = f.count(), cmd = f.scopedCommand(); await f.receiveScoped(cmd);
  // This narrow Host double has no SDK durable audit; an approval return value
  // alone cannot stand in for the required original approval ledger.
  assert.equal((await scopedDelivery(f, cmd)).state, 'rejected'); assert.deepEqual(f.count(), before);
});

for (const kind of ['continue', 'cancel']) test(`managed A2A ${kind} selects the original receiver ledger and confirms after reopen without another effect`, async t => {
  const f = await setup(t, { managed: true }), original = f.ledger();
  assert.deepEqual((await f.status()).a2aTasks, [{ runId: f.request.runId, operationKey: f.request.operationKey, callId: f.request.callId }]);
  assert.deepEqual(f.localRuns(), []);
  const observed = await f.invoke('get', 'managed-read'); assert.equal(observed.state, 'input_required');
  const more = kind === 'continue' ? { parts: [{ data: { answer: 42 } }], pauseDigest: observed.pauseDigest } : {};
  const result = await f.invoke(kind, 'managed-original-control', more);
  assert.equal(result.outcome, kind === 'continue' ? 'submitted' : 'remote_cancelled');
  assert.equal(f.count().approvals, 1); assert.equal(f.count().modelCalls, 1); assert.equal(f.ledger(), original);
  const counts = f.count(); await f.reopen();
  assert.deepEqual(await f.invoke(kind, 'managed-original-control', more), result);
  assert.deepEqual(f.count(), counts); assert.equal(f.ledger(), original); assert.deepEqual(f.localRuns(), []);
});
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
for (const managed of [false, true]) for (const change of ['preset', 'revision']) test(`${managed ? 'managed' : 'Studio'} ${change} change while approval waits cannot authorize the old task control`, async t => {
  const f = await setup(t, { managed });
  f.services.approval.request = async () => {
    if (change === 'preset') f.services.sessionProjections.stateOf = () => 'another-preset';
    else f.drift();
    return 'allowed-once';
  };
  await assert.rejects(f.invoke('cancel', 'changed-during-approval'), { code: change === 'preset'
    ? 'STUDIO_NATIVE_A2A_PRESET_CHANGED' : 'studio_native_recovery_preset_changed' });
  assert.equal(f.count().gets, 0); assert.equal(f.count().cancels, 0);
});

test('managed trusted ledger binding replacement while approval waits withdraws remote control authority', async t => {
  const f = await setup(t, { managed: true }), before = f.ledger();
  f.services.approval.request = async () => {
    f.services.studioManagedNativeSessionControl = { ...f.services.studioManagedNativeSessionControl };
    return 'allowed-once';
  };
  await assert.rejects(f.invoke('cancel', 'binding-replaced'), { code: 'STUDIO_NATIVE_A2A_IDENTITY_CONFLICT' });
  assert.equal(f.count().gets, 0); assert.equal(f.count().cancels, 0); assert.equal(f.ledger(), before);
});
