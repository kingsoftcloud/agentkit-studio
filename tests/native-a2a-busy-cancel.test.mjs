// Real HTTP/SSE peer and private durable files/SQLite locks. Consent/current
// authority are explicit callbacks here; full mounted approval remains separate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareNativeA2AHost, prepareDshA2AHost } from '../src/providers/native-a2a-host.mjs';
import { createNativeA2aTaskState } from '../src/client/state/native-a2a.mjs';
const scope = { tenantId: 'local', workspaceId: 'workspace', userId: 'user', agentId: 'agent' };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { const end = Date.now() + 5000; for (;;) { const result = check(); if (result) return result;
  assert.ok(Date.now() < end, 'busy A2A checkpoint timeout'); await wait(10); } }
async function fixture(t, { dsh = false, protocol = 'JSONRPC', known = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'a2a-busy-cancel-'))), workspaceRoot = join(root, 'workspace'); mkdirSync(workspaceRoot);
  let stream, envelope, running, seq = 0, allow = true, authorized = true, approvalReadOnly = [], state = 'TASK_STATE_WORKING', readGate;
  const counts = { send: 0, get: 0, cancel: 0, discovery: 0 }, failures = [], owners = [];
  const task = () => ({ id: 'busy-task', contextId: 'busy-context', status: { state } });
  const emit = payload => stream.write(`id: ${++seq}\ndata: ${JSON.stringify(envelope(payload))}\n\n`);
  const bind = () => emit({ task: task() });
  const record = () => {
    const directory = join(root, 'state', readdirSync(join(root, 'state'))[0]);
    return JSON.parse(readFileSync(join(directory, readdirSync(directory).find(name => name.endsWith('.json')))));
  };
  const server = createServer((req, res) => void (async () => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    if (req.url === '/agentengine/api/v1/ListAToASpaceAgents') {
      counts.discovery++; res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ Code: 0, Data: { Agents: [{ A2AAgentId: 'remote', VersionId: 'version', AgentCard: {
        capabilities: { streaming: true }, supportedInterfaces: [{ url: origin + '/rpc', protocolBinding: protocol, protocolVersion: '1.0' }],
      } }] } })); return;
    }
    const method = protocol === 'JSONRPC' ? body.method : req.method === 'GET' ? 'GetTask'
      : req.url.endsWith(':cancel') ? 'CancelTask' : 'SendStreamingMessage';
    const wrap = result => protocol === 'JSONRPC' ? { jsonrpc: '2.0', id: body.id, result } : result;
    if (method === 'SendStreamingMessage') {
      counts.send++; assert.equal(counts.send, 1); stream = res; envelope = wrap;
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders();
      if (known) bind(); return;
    }
    const target = protocol === 'JSONRPC' ? body.params.id : decodeURIComponent(req.url.split('/').at(-1).replace(/:cancel$/u, ''));
    assert.equal(target, 'busy-task');
    if (method === 'CancelTask') {
      counts.cancel++;
      const entry = Object.values(record().controls).find(row => row.command.kind === 'cancel');
      assert.equal(entry.phase, 'sending', 'actual cancel intent precedes HTTP');
      state = 'TASK_STATE_CANCELED';
    } else {
      assert.equal(method, 'GetTask'); counts.get++;
      const observed = task(); if (readGate) await readGate(counts.get);
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(wrap(observed))); return;
    }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(wrap(task())));
  })().catch(error => { failures.push(error); res.statusCode = 500; res.end('{}'); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${server.address().port}`;
  const prepared = (dsh ? prepareDshA2AHost : prepareNativeA2AHost)({ env: { KSADK_A2A_SERVICE_URL: origin, KSADK_A2A_ALLOW_PRIVATE: 'true' },
    bindings: [{ local_name: 'remote', binding_id: 'binding', space_id: 'space', target_agent_id: 'remote', expected_version_id: 'version' }] });
  const ownerBinding = dsh ? { agentId: 'agent', agentRevision: 1, buildId: 'build' } : { scope };
  const owner = () => { const value = prepared.forSession({ ...ownerBinding, sessionId: 'session', stateRoot: join(root, 'state'), workspaceRoot,
    assertCurrent: () => true, assertControl: () => authorized, authorizeControl: async ({ readOnly }) => {
      approvalReadOnly.push(readOnly); return allow ? 'allow' : 'deny';
    } }); owners.push(value); return value; };
  t.after(async () => { for (const value of owners) value.close(); await prepared.close(); await running?.catch(() => {});
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); assert.deepEqual(failures, []); });
  const original = owner(), signal = new AbortController().signal;
  const request = await original.invocation.resolve({ agent: 'remote', message: 'initial', signal,
    [dsh ? 'dshRequest' : 'nativeRequest']: { ...ownerBinding, sessionId: 'session', ...(!dsh ? { runId: 'run' } : {}),
      operationKey: 'operation', call: { callId: 'call' } } });
  running = original.invocation.dispatch({ request, signal }); running.catch(() => {});
  await until(() => counts.send === 1); if (known) await until(() => record().projection.taskId);
  const input = (commandId, signal = new AbortController().signal) => ({ kind: 'cancel', commandId, signal,
    operation_locator: request.identity, authority: { source: 'fresh-human-control' } });
  return { counts, record, owner, input, bind, running, approvalReadOnly, readGate: value => { readGate = value; },
    remoteState: value => { state = value; },
    allow: value => { allow = value; }, authority: value => { authorized = value; },
    finish: terminal => { emit({ statusUpdate: { taskId: 'busy-task', contextId: 'busy-context', status: { state: terminal ?? state } } }); stream.end(); } };
}
for (const dsh of [false, true]) for (const protocol of ['JSONRPC', 'HTTP+JSON']) for (const known of [false, true]) {
  test(`${dsh ? 'DSH' : 'Native'} ${protocol} cancel while original stream holds its lock, task ${known ? 'bound' : 'not yet bound'}`, async t => {
    const f = await fixture(t, { dsh, protocol, known }), controller = f.owner();
    const pending = controller.control.execute(f.input('one-cancel')); pending.catch(() => {});
    if (!known) {
      await until(() => Object.values(f.record().controls ?? {}).some(entry => entry.phase === 'queued'));
      assert.equal(f.counts.cancel, 0); assert.equal(f.counts.get, 0); f.bind();
    }
    const result = await pending; assert.equal(result.outcome, 'remote_cancelled'); assert.equal(result.state, 'cancelled');
    assert.equal(f.record().projection.state, 'cancelled');
    f.finish('TASK_STATE_WORKING');
    assert.equal((await f.running).state, 'cancelled', 'late nonterminal stream cannot undo confirmed cancellation');
    assert.deepEqual(await controller.control.execute(f.input('one-cancel')), result);
    assert.deepEqual(f.counts, { send: 1, get: 2, cancel: 1, discovery: 1 });
    assert.equal(Object.values(f.record().controls).filter(row => row.command.kind === 'cancel').length, 1);
    assert.equal(f.record().phase, 'terminal'); assert.equal(f.record().projection.state, 'cancelled');
  });
}
test('queued cancellation survives caller withdrawal; explicit retry needs fresh consent and authority', async t => {
  const f = await fixture(t, { known: false }), signal = new AbortController(), owner = f.owner();
  const pending = owner.control.execute(f.input('queued', signal.signal)); pending.catch(() => {});
  await until(() => Object.values(f.record().controls ?? {}).some(row => row.phase === 'queued'));
  signal.abort(); await assert.rejects(pending, { name: 'AbortError' }); f.bind();
  await until(() => f.record().projection.taskId);
  f.allow(false); await assert.rejects(f.owner().control.execute(f.input('queued')), { code: 'A2A_CONTROL_PERMISSION_DENIED' });
  assert.equal(f.counts.cancel, 0); assert.equal(f.record().controls[Object.keys(f.record().controls)[0]].phase, 'queued');
  f.allow(true); f.authority(false); await assert.rejects(f.owner().control.execute(f.input('queued')), { code: 'A2A_CONTROL_AUTHORITY_LOST' });
  f.authority(true); const result = await f.owner().control.execute(f.input('queued'));
  assert.equal(result.outcome, 'remote_cancelled'); assert.ok(f.approvalReadOnly.every(value => value === false));
  f.finish(); await f.running; assert.equal(f.counts.cancel, 1);
});
test('late contradictory terminal cannot replace an already confirmed remote cancellation', async t => {
  const f = await fixture(t); const result = await f.owner().control.execute(f.input('cancel'));
  assert.equal(result.state, 'cancelled'); f.finish('TASK_STATE_COMPLETED');
  await assert.rejects(f.running, { code: 'A2A_TERMINAL_STATE_CONFLICT' });
  assert.equal(f.record().projection.state, 'cancelled'); assert.equal(f.record().phase, 'terminal');
  assert.equal(f.counts.cancel, 1);
});
for (const sameId of [false, true]) test(`late GetTask ${sameId ? 'cannot replace a different command with the same ID' : 'preserves a concurrent cancellation command and terminal'}`, async t => {
  const f = await fixture(t); f.finish('TASK_STATE_INPUT_REQUIRED'); await f.running;
  const gate = Promise.withResolvers(); f.readGate(n => n === 1 ? gate.promise : undefined);
  t.after(() => gate.resolve());
  const request = { ...f.input(sameId ? 'cancel' : 'get'), kind: 'get' };
  const read = f.owner().control.execute(request); read.catch(() => {});
  await until(() => f.counts.get === 1);
  const canceled = await f.owner().control.execute(f.input('cancel')); assert.equal(canceled.state, 'cancelled');
  gate.resolve();
  if (sameId) await assert.rejects(read, { code: 'A2A_CONTROL_IDEMPOTENCY_CONFLICT' });
  else assert.equal((await read).state, 'cancelled');
  const entries = Object.values(f.record().controls); assert.equal(entries.length, sameId ? 1 : 2);
  assert.equal(entries.find(row => row.command.kind === 'cancel').result.outcome, 'remote_cancelled');
  assert.equal(f.record().projection.state, 'cancelled'); assert.equal(f.counts.cancel, 1);
});
test('actual UI state can inspect an unbound busy call and queue cancellation through the Node control port', async t => {
  const f = await fixture(t, { known: false }), owner = f.owner();
  const task = { agentId: 'agent', sessionId: 'session', runId: 'run', operationKey: 'operation', callId: 'call' };
  const state = createNativeA2aTaskState({ task, hostRemote: {
    controlNativeA2aTask: (request, signal) => owner.control.execute({ kind: request.kind, commandId: request.commandId,
      operation_locator: { scope, sessionId: task.sessionId, runId: task.runId, operationKey: task.operationKey, callId: task.callId }, authority: {}, signal }),
  } }); t.after(() => state.dispose());
  await state.refresh(); assert.equal(state.getSnapshot().error, '');
  assert.equal(state.getSnapshot().task.outcome, 'remote_task_not_bound'); assert.equal(f.counts.get, 0);
  const pending = state.cancel();
  await until(() => Object.values(f.record().controls).some(row => row.phase === 'queued'));
  assert.equal(state.getSnapshot().pending.kind, 'cancel'); f.bind(); await pending;
  assert.equal(state.getSnapshot().outcome, 'remote_cancelled'); assert.equal(state.getSnapshot().pending, null);
  f.finish(); await f.running; assert.equal(f.counts.cancel, 1);
});
test('a queued cancellation prevents a new continuation from entering the network', async t => {
  const f = await fixture(t); f.remoteState('TASK_STATE_INPUT_REQUIRED'); f.finish('TASK_STATE_INPUT_REQUIRED'); await f.running;
  const inspected = await f.owner().control.execute({ ...f.input('inspect'), kind: 'get' });
  const gate = Promise.withResolvers(); t.after(() => gate.resolve()); f.readGate(n => n === 2 ? gate.promise : undefined);
  const pending = f.owner().control.execute(f.input('cancel')); pending.catch(() => {});
  await until(() => f.counts.get === 2);
  await assert.rejects(f.owner().control.execute({ ...f.input('continue'), kind: 'continue', pauseDigest: inspected.pauseDigest,
    parts: [{ text: 'answer' }] }), { code: 'A2A_CANCEL_ALREADY_REQUESTED' });
  gate.resolve(); assert.equal((await pending).state, 'cancelled');
  assert.equal(Object.values(f.record().controls).some(row => row.command.kind === 'continue'), false);
  assert.equal(f.counts.cancel, 1); assert.equal(f.counts.send, 1);
});
