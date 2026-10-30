// Real Node builtin factory, preset hook, private ledger, HTTP/SSE peer and
// product route/UI state. SessionController/events/approval are declared narrow
// doubles here; the mounted Host verifier covers their production composition.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntimeBridge } from '../src/host/runtime-bridge.mjs';
import { apply as applyPreset } from '../src/providers/dsh-runtime-plugin.mjs';
import { createDshNodeBuiltins } from '../src/providers/dsh-node-builtins.mjs';
import { createStudioDshA2aControls } from '../src/host/services/dsh-a2a-control.mjs';
import { createSessionRoutes } from '../src/host/routes/sessions.mjs';
import { createNativeA2aTaskState } from '../src/client/state/native-a2a.mjs';
import { createDshA2aHistoryState } from '../src/client/state/dsh-a2a-history.mjs';
const delay = () => new Promise(resolve => setImmediate(resolve));
async function setup(t, { runtime = 'dsh-native', busy = false, lost = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-dsh-a2a-'))), workspaceRoot = join(root, 'workspace'); mkdirSync(workspaceRoot);
  const counts = { discovery: 0, send: 0, get: 0, continue: 0, cancel: 0, approval: 0 }, errors = [], approvals = [], tasks = new Map(), bodies = [];
  let finishStream, approve = async () => 'allowed-once', lookup, preset = 'original-preset', held;
  const server = createServer((req, res) => void (async () => {
    let raw = ''; for await (const chunk of req) raw += chunk; bodies.push(raw); const body = JSON.parse(raw);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/agentengine/api/v1/ListAToASpaceAgents') {
      counts.discovery++; res.end(JSON.stringify({ Code: 0, Data: { Agents: [{ A2AAgentId: 'remote', VersionId: 'version', AgentCard: {
        capabilities: { streaming: true }, supportedInterfaces: [{ url: origin + '/rpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
      } }] } })); return;
    }
    const wrap = result => ({ jsonrpc: '2.0', id: body.id, result });
    if (body.method === 'SendStreamingMessage') {
      counts.send++; const task = { id: `remote-${counts.send}`, contextId: 'context', status: { state: busy ? 'TASK_STATE_WORKING' : 'TASK_STATE_INPUT_REQUIRED' } };
      tasks.set(task.id, task); res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('id: 1\ndata: ' + JSON.stringify(wrap({ task })) + '\n\n');
      if (busy) finishStream = () => { res.end('id: 2\ndata: ' + JSON.stringify(wrap({ statusUpdate: { taskId: task.id,
        contextId: task.contextId, status: { state: 'TASK_STATE_WORKING' } } })) + '\n\n'); };
      else res.end(); return;
    }
    const task = tasks.get(body.params.id ?? body.params.message?.taskId); assert.ok(task);
    if (body.method === 'SubscribeToTask') {
      assert.equal(req.headers.accept, 'text/event-stream');
      res.setHeader('content-type', 'text/event-stream');
      res.end('id: 1\ndata: ' + JSON.stringify(wrap({ task })) + '\n\n'); return;
    }
    if (body.method === 'GetTask') { counts.get++; res.end(JSON.stringify(wrap(task))); return; }
    if (body.method === 'CancelTask') { counts.cancel++; task.status = { state: 'TASK_STATE_CANCELED' }; }
    else { assert.equal(body.method, 'SendMessage'); counts.continue++;
      assert.equal(body.params.message.contextId, task.contextId); task.status = { state: 'TASK_STATE_COMPLETED' }; }
    if (lost) { res.destroy(); return; }
    res.end(JSON.stringify(wrap(body.method === 'SendMessage' ? { task } : task)));
  })().catch(error => { errors.push(error.message); res.statusCode = 500; res.end('{}'); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${server.address().port}`;
  const binding = { local_name: 'remote', binding_id: 'binding', space_id: 'space', target_agent_id: 'remote', expected_version_id: 'version' };
  const bridge = createRuntimeBridge(), effects = [], listeners = new Map(), registered = new Map(), ports = [];
  const agent = { session: { id: 'session' } };
  const services = { studioRuntimeBridge: bridge, sessions: { flush: async () => true },
    sessionProjections: { stateOf: (_session, name) => name === 'turnBoundary' ? { lastTurn: 1, openTurnStartSeq: 0 } : preset },
    sessionController: { resolveAgent: id => lookup ? lookup(id) : Promise.resolve({ agent }) },
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
    approval: { request: async input => { counts.approval++; approvals.push(input); return approve(input); } } };
  const ctx = { get: name => services[name], on: (name, handler) => { listeners.set(name, handler); },
    effect: install => { const result = install(); if (result) effects.push(result); },
    tools: { register: tool => { registered.set(tool.name, tool); return () => {}; } } };
  bridge.setBuiltinToolsFactory(({ config, isClosed, signal }) => {
    const port = createDshNodeBuiltins({ ctx, workspaceRoot, stateDir: join(root, 'state'), agentId: config.agentId,
      agentRevision: config.agentRevision, buildId: config.buildId, toolBindings: [], a2aBindings: config.a2aBindings,
      isClosed, signal, env: { KSADK_A2A_SERVICE_URL: origin, KSADK_A2A_ALLOW_PRIVATE: 'true' } }); ports.push(port); return port;
  });
  const config = { agentId: 'agent', agentRevision: 3, buildId: 'build', runtime, local: true, a2aBindings: [binding], toolBindings: [] };
  applyPreset(ctx, config);
  const events = (_ctx, actual) => { assert.equal(actual, agent); return { serial: (name, payload) => listeners.get(name)?.(payload) }; };
  const service = createStudioDshA2aControls({ ctx, agentEvents: events, signal: bridge.signal });
  const routes = createSessionRoutes({ getDshA2aControls: async () => service });
  const remote = { dshA2aTaskHistory: async (input, signal) => (await routes('sessions/dsh-a2a-history', input, signal)).value,
    controlDshA2aTask: async (input, signal) => (await routes('sessions/dsh-a2a-control', input, signal)).value };
  const request = { agentId: 'agent', sessionId: 'session', agentRevision: 3, buildId: 'build', callId: 'original-call', operationKey: 'dsh-a2a:original-call' };
  const invoke = (kind, commandId, extra = {}, signal) => remote.controlDshA2aTask({ ...request, kind, commandId, ...extra }, signal);
  const launch = (callId = 'original-call') => {
    const args = { agent: 'remote', message: 'original' };
    return registered.get('call_a2a_agent').execute(args, { agent, name: 'call_a2a_agent', arguments: args, callId, signal: new AbortController().signal });
  };
  const receipts = () => { const rows = [];
    const walk = directory => { for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name); if (entry.isDirectory()) walk(path);
      else if (entry.name === 'record.json') rows.push(readFileSync(path, 'utf8'));
    } }; walk(join(root, 'state')); return rows.sort(); };
  t.after(async () => { bridge.close(); await service.close(); for (const dispose of effects) await dispose(); await Promise.all(ports.map(port => port.close()));
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); assert.deepEqual(errors, []); });
  return { request, invoke, remote, launch, counts, receipts, approvals, bodies, service, services, listeners, agent,
    approve: value => { approve = value; }, preset: value => { preset = value; }, lookup: value => { lookup = value; },
    finish: () => finishStream?.(), ready: async () => { const end = Date.now() + 5000; while (!finishStream) { assert.ok(Date.now() < end); await delay(); } },
    reopen: async () => { for (const port of ports) await port.close(); applyPreset(ctx, config); } };
}
for (const runtime of ['dsh-native', 'codex']) test(`${runtime} product routes observe the original task without approval or replacing sealed receipts`, async t => {
  const f = await setup(t, { runtime }); await f.launch(); const receipts = f.receipts();
  const page = await f.remote.dshA2aTaskHistory({ agentId: 'agent', sessionId: 'session' });
  const state = createNativeA2aTaskState({ task: { ...page.items[0], ownerKind: 'dsh' }, hostRemote: f.remote });
  t.after(() => state.dispose()); await state.watch();
  assert.equal(state.getSnapshot().error, ''); assert.equal(state.getSnapshot().task.state, 'input_required');
  assert.equal(state.getSnapshot().task.subscription.contract, 'agentkit.studio-a2a-task-subscription/v1');
  assert.equal(f.counts.approval, 0); assert.equal(f.counts.send, 1); assert.equal(f.counts.get, 1);
  assert.equal(f.bodies.map(JSON.parse).filter(body => body.method === 'SubscribeToTask').length, 1);
  assert.deepEqual(f.receipts(), receipts); assert.equal('scope' in state.getSnapshot().task.operation_locator, false);
});
for (const runtime of ['dsh-native', 'codex']) for (const kind of ['continue', 'cancel']) test(`${runtime} product controls ${kind} the original call with exact consent and cold duplicate confirmation`, async t => {
  const f = await setup(t, { runtime }); await f.launch(); const receipts = f.receipts(), network = structuredClone(f.counts);
  const page = await f.remote.dshA2aTaskHistory({ agentId: 'agent', sessionId: 'session' }); assert.deepEqual(page.items, [f.request]);
  assert.deepEqual(f.counts, network, 'local inventory never discovers or queries the peer');
  const state = createNativeA2aTaskState({ task: { ...page.items[0], ownerKind: 'dsh' }, hostRemote: f.remote }); t.after(() => state.dispose());
  await state.refresh(); assert.equal(state.getSnapshot().task.state, 'input_required');
  const before = state.getSnapshot().task;
  const extra = kind === 'continue' ? { pauseDigest: before.pauseDigest, json: '{"answer":9007199254740993}' } : {};
  const result = await f.invoke(kind, 'original-command', extra); assert.equal(result.outcome, kind === 'cancel' ? 'remote_cancelled' : 'submitted');
  assert.equal(f.counts.approval, 1); assert.equal(f.approvals[0].agent, f.agent);
  if (kind === 'continue') { assert.match(f.approvals[0].reason, /9007199254740993/); assert.ok(f.bodies.some(body => body.includes('9007199254740993'))); }
  const counts = structuredClone(f.counts); await f.reopen();
  assert.deepEqual(await f.invoke(kind, 'original-command', extra), result); assert.deepEqual(f.counts, counts);
  assert.deepEqual(f.receipts(), receipts, 'remote control cannot rewrite sealed DSH tool receipts');
  assert.equal('scope' in result.operation_locator, false); assert.equal('runId' in result.operation_locator, false);
  assert.equal(f.counts.send, 1);
});
test('DSH product can cancel while the actual original registry call still owns its locks', async t => {
  const f = await setup(t, { busy: true }), running = f.launch(); await f.ready();
  assert.equal((await f.remote.dshA2aTaskHistory({ agentId: 'agent', sessionId: 'session' })).items.length, 1);
  const result = await f.invoke('cancel', 'busy-cancel'); assert.equal(result.outcome, 'remote_cancelled');
  f.finish(); await running; assert.equal(f.counts.send, 1); assert.equal(f.counts.cancel, 1);
});
test('lost DSH control response never resends; an explicit GetTask can observe its result', async t => {
  const f = await setup(t, { lost: true }); await f.launch(); const before = await f.invoke('get', 'inspect');
  const input = { pauseDigest: before.pauseDigest, parts: [{ text: 'answer' }] };
  assert.equal((await f.invoke('continue', 'lost', input)).outcome, 'unknown'); await f.reopen();
  assert.equal((await f.invoke('continue', 'lost', input)).outcome, 'unknown'); assert.equal(f.counts.continue, 1);
  assert.equal((await f.invoke('get', 'observe')).state, 'completed'); assert.equal(f.counts.send, 1);
});
test('DSH controls reject invented Native identity, foreign calls, revision/build drift and unapproved effects', async t => {
  const f = await setup(t); await f.launch(); const before = structuredClone(f.counts);
  for (const extra of [{ runId: 'invented' }, { authority: {} }, { url: 'https://other.invalid' }])
    await assert.rejects(f.invoke('get', 'bad', extra), { code: 'STUDIO_DSH_A2A_REQUEST_INVALID' });
  for (const extra of [{ agentRevision: 4 }, { buildId: 'different' }])
    await assert.rejects(f.invoke('get', 'bad', extra), { code: 'STUDIO_DSH_A2A_BINDING_CHANGED' });
  await assert.rejects(f.invoke('get', 'foreign', { callId: 'other', operationKey: 'dsh-a2a:other' }), { code: 'DSH_A2A_CALL_NOT_OWNED' });
  assert.deepEqual(f.counts, before);
  f.approve(async () => 'denied'); await assert.rejects(f.invoke('cancel', 'denied'), { code: 'A2A_CONTROL_PERMISSION_DENIED' });
  assert.equal(f.counts.cancel, 0); assert.equal(f.counts.approval, 1);
  f.approve(async () => { f.preset('changed'); return 'allowed-once'; });
  await assert.rejects(f.invoke('cancel', 'drift'), { code: 'STUDIO_DSH_A2A_IDENTITY_CONFLICT' }); assert.equal(f.counts.cancel, 0);
});
test('DSH caller cancellation releases an uncooperative lookup and late settlement cannot query', async t => {
  const f = await setup(t); await f.launch(); const entered = Promise.withResolvers(), deferred = Promise.withResolvers();
  f.lookup(() => { entered.resolve(); return deferred.promise; }); const signal = new AbortController();
  const pending = f.invoke('get', 'stop', {}, signal.signal); await entered.promise; signal.abort(); await assert.rejects(pending, { name: 'AbortError' });
  deferred.resolve({ agent: f.agent }); await delay(); assert.equal(f.counts.get, 0);
});
test('DSH inventory pagination retains all original calls and rejects append after inventory drift', async t => {
  const f = await setup(t); for (let n = 0; n < 65; n++) await f.launch(`call-${String(n).padStart(3, '0')}`);
  const state = createDshA2aHistoryState({ hostRemote: f.remote, agentId: 'agent', sessionId: 'session' }); t.after(() => state.dispose());
  const counts = structuredClone(f.counts); await state.refresh(); assert.equal(state.getSnapshot().page.items.length, 64);
  await state.next(); assert.equal(state.getSnapshot().page.items.length, 65); assert.equal(state.getSnapshot().page.complete, true);
  assert.deepEqual(f.counts, counts); await state.refresh(); await f.launch('new-call'); await state.next();
  assert.match(state.getSnapshot().error, /读取失败/); assert.equal(state.getSnapshot().page.items.length, 64);
});

test('DSH task state rejects a foreign revision, Build or invented Native owner before accepting a response', async t => {
  const f = await setup(t); await f.launch();
  for (const alter of [locator => ({ ...locator, agentRevision: 4 }), locator => ({ ...locator, buildId: 'foreign' }),
    locator => ({ ...locator, runId: 'invented' }), locator => ({ ...locator, sessionId: 'foreign' })]) {
    const state = createNativeA2aTaskState({ task: { ...f.request, ownerKind: 'dsh' }, hostRemote: {
      controlDshA2aTask: async input => { const value = await f.remote.controlDshA2aTask(input);
        return { ...value, operation_locator: alter(value.operation_locator) }; },
    } });
    await state.refresh(); assert.equal(state.getSnapshot().task, null); assert.match(state.getSnapshot().error, /核对失败/); state.dispose();
  }
  assert.equal(f.counts.send, 1); assert.equal(f.counts.continue, 0); assert.equal(f.counts.cancel, 0);
});
test('leaving DSH inventory aborts the actual request and ignores late results', async () => {
  let release, signal;
  const state = createDshA2aHistoryState({ agentId: 'agent', sessionId: 'session', hostRemote: {
    dshA2aTaskHistory: (_request, current) => { signal = current; return new Promise(resolve => { release = resolve; }); },
  } });
  const pending = state.refresh(); state.dispose(); assert.equal(signal.aborted, true);
  release({ contract: 'agentkit.studio-dsh-a2a-inventory/v1', agentId: 'agent', sessionId: 'session', applicable: false,
    offset: 0, total: 0, complete: true, items: [] });
  await pending; assert.equal(state.getSnapshot().page, null);
});
