// Real Native Kernel/SQLite, managed A2A journal and localhost control-plane.
// Only model responses and the explicit control authority are deterministic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { NativeKernel, initialSnapshot, emptyUsage } from '../packages/agentkit-harness-core/dist/index.mjs';
import { fixture, digest } from '../packages/agentkit-harness-core/test/fixtures.mjs';
import { SqliteRunStore } from '../packages/agentkit-harness/src/native/sqlite-store.mjs';
import { createNativeA2aToolPort, nativeA2aToolDefinitions } from '../packages/agentkit-harness/src/native/a2a-tools.mjs';
import { prepareNativeA2AHost } from '../src/providers/native-a2a-host.mjs';
import { createNativeToolAuthority } from '../src/providers/native-tool-authority.mjs';
import { createNativeA2aReceiptObserver, createNativeA2aReceiptWaiter } from '../src/providers/native-a2a-receipt.mjs';
import { internalPeer, scope, spec } from './fixtures/native-a2a-internal-peer.mjs';
import { controlConsent } from './fixtures/native-a2a-control-consent.mjs';

async function setup(t, mode = 'pause') {
  const f = await internalPeer({ mode });
  const path = join(f.root, 'runs.sqlite'); let store = new SqliteRunStore(path), closed = false;
  const a2a = prepareNativeA2AHost({ env: f.env, bindings: [spec] });
  const fields = { a2a, scope, sessionId: 'session', stateRoot: join(f.root, 'state'), workspaceRoot: f.workspaceRoot,
    isClosed: () => closed };
  const authority = createNativeToolAuthority({ scope, sessionId: 'session', store });
  const owner = a2a.forSession({ ...fields, assertCurrent: authority, assertControl: () => true, authorizeControl: controlConsent });
  f.owners.push(owner);
  t.after(async () => { closed = true; await a2a.close(); store.close(); await f.close(); });
  const port = createNativeA2aToolPort({ ...owner, scope, sessionId: 'session', spaceId: spec.space_id,
    authorize: () => 'allow', assertCurrent: authority, receiptObservation: true });
  let modelCalls = 0;
  const kernel = new NativeKernel({ store, digest, owner: 'original-worker', ports: {
    model: { generate: async () => { modelCalls++; return { kind: 'tool_calls', text: '', usage: emptyUsage(),
      toolCalls: [{ callId: 'call', name: 'call_a2a_agent', arguments: { agent: 'research', message: 'original' } }] }; } },
    tools: { execute: request => port.execute(request), observeReceipt: createNativeA2aReceiptObserver({ ...fields, store }) },
  } });
  const { config } = fixture({ tools: nativeA2aToolDefinitions({ receiptObservation: true }) });
  kernel.start(initialSnapshot({ scope, sessionId: 'session', runId: 'run', turnId: 'turn', buildId: 'build',
    parentRunId: null, taskChainId: 'chain' }, config, digest(config)), config);
  const snapshot = await kernel.runUntilIdle(scope, 'run');
  assert.equal(snapshot.phase, 'awaiting_reconciliation');
  const locator = f.record().request.identity;
  const control = async kind => {
    const input = { kind, commandId: `control-${kind}`, operation_locator: locator, authority: {}, signal: new AbortController().signal };
    if (kind === 'continue') {
      const view = await owner.control.execute({ ...input, kind: 'get', commandId: 'inspect' });
      Object.assign(input, { pauseDigest: view.pauseDigest, parts: [{ data: { answer: 1 } }] });
    }
    return owner.control.execute(input);
  };
  return { f, path, a2a, fields, snapshot, kernel, control, modelCalls: () => modelCalls,
    get store() { return store; },
    waiter: () => createNativeA2aReceiptWaiter({ ...fields, store }),
    reopen() { store.close(); store = new SqliteRunStore(path); },
    closeAuthority() { closed = true; },
  };
}

for (const mode of ['pause', 'send-lost']) test(`${mode}: managed calls wait without remote requests; abort withdraws the local waiter`, async t => {
  const f = await setup(t, mode), before = f.f.calls.filter(call => call.wireMethod).length;
  assert.equal(f.f.record().phase, mode === 'pause' ? 'paused' : 'unknown');
  const signal = new AbortController(), pending = f.waiter()({ snapshot: f.snapshot, signal: signal.signal });
  const stopped = assert.rejects(pending, error => error.code === 'ABORT_ERR' && error.cause?.message === 'withdraw-wait');
  await delay(230);
  assert.equal(f.f.calls.filter(call => call.wireMethod).length, before);
  assert.equal(f.store.load(scope, 'run').commands.length, 0);
  assert.equal(f.modelCalls(), 1);
  signal.abort(Error('withdraw-wait')); await stopped;
  if (mode === 'pause') await f.control('cancel');
  assert.equal(f.store.load(scope, 'run').commands.length, 0, 'late completion cannot revive the aborted wait');
});

test('a cold SQLite reopen finds the committed terminal receipt and returns the same deterministic command', async t => {
  const f = await setup(t);
  await f.control('continue');
  const before = f.f.calls.filter(call => call.wireMethod).length, original = f.store.load(scope, 'run');
  const first = await f.waiter()({ snapshot: f.snapshot, signal: new AbortController().signal });
  f.reopen();
  const second = await f.waiter()({ snapshot: f.snapshot, signal: new AbortController().signal });
  assert.deepEqual(first, second);
  assert.equal(first.kind, 'reconcile_tool');
  assert.equal(first.payload.originalOperationKey, f.snapshot.toolReconciliation.operationKey);
  assert.deepEqual(f.store.load(scope, 'run'), original, 'observing does not write a command or forge a receipt');
  assert.equal(f.f.calls.filter(call => call.wireMethod).length, before);
});

test('a concurrently queued command wakes consumption; an unavailable consumed receipt cannot busy-loop', async t => {
  const f = await setup(t); await f.control('continue');
  const command = await f.waiter()({ snapshot: f.snapshot, signal: new AbortController().signal });
  f.kernel.submit(scope, 'run', command);
  assert.deepEqual(await f.waiter()({ snapshot: f.snapshot, signal: new AbortController().signal }), command,
    'wake the same queued command, without inventing another id or writing state');
  // An explicitly unavailable read port exercises failure after command
  // consumption. All original execution/private A2A facts stay real.
  const kernel = new NativeKernel({ store: f.store, digest, owner: 'unavailable-reader', ports: {
    model: { generate: () => assert.fail('an unavailable receipt cannot run the model') },
    tools: { execute: () => assert.fail('never replay the original effect'), observeReceipt: request => ({
      contract: request.contract, originalOperationKey: request.originalOperationKey, callId: request.call.callId, result: null,
    }) },
  } });
  const snapshot = await kernel.runUntilIdle(scope, 'run');
  assert.equal(snapshot.phase, 'awaiting_reconciliation');
  const signal = new AbortController();
  const pending = f.waiter()({ snapshot, signal: signal.signal });
  const stopped = assert.rejects(pending, { code: 'ABORT_ERR' });
  await delay(210); signal.abort(); await stopped;
  assert.equal(f.store.load(scope, 'run').commands.length, 1);
  assert.equal(f.store.load(scope, 'run').intents.filter(row => row.kind === 'tool_receipt').length, 1);
});

test('stale checkpoint, changed principal, call mismatch and retired host cannot wake a receipt command', async t => {
  const f = await setup(t); await f.control('continue');
  for (const snapshot of [
    { ...f.snapshot, revision: f.snapshot.revision + 1 },
    { ...f.snapshot, sessionId: 'foreign' },
    { ...f.snapshot, scope: { ...scope, workspaceId: 'foreign' } },
    { ...f.snapshot, toolReconciliation: { ...f.snapshot.toolReconciliation, callId: 'foreign' } },
  ]) await assert.rejects(f.waiter()({ snapshot, signal: new AbortController().signal }), /A2A_RECEIPT_WAIT_SOURCE_INVALID/);
  f.closeAuthority();
  await assert.rejects(f.waiter()({ snapshot: f.snapshot, signal: new AbortController().signal }), /A2A_RECEIPT_WAIT_AUTHORITY_LOST/);
  assert.equal(f.store.load(scope, 'run').commands.length, 0);
});

function worker(f, action) {
  const child = fork(new URL('./fixtures/a2a-receipt-wait-worker.mjs', import.meta.url), [],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; const messages = [];
  child.stderr.on('data', bytes => { stderr += bytes; }); child.on('message', value => messages.push(value));
  const exit = new Promise((resolve, reject) => { child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, pid: child.pid, stderr })); });
  child.send({ root: f.f.root, workspaceRoot: f.f.workspaceRoot, env: f.f.env, action });
  return { child, messages, exit };
}
for (const boundary of ['observed', 'queued']) test(`SIGKILL after receipt ${boundary}: cold original Run resumes without remote replay`, { timeout: 15000 }, async t => {
  const f = await setup(t); await f.control('continue'); await f.a2a.close();
  const original = f.store.load(scope, 'run'), before = f.f.calls.filter(call => call.wireMethod).length;
  const first = worker(f, boundary); t.after(() => first.child.kill('SIGKILL'));
  let ready;
  const reached = new Promise(resolve => { ready = resolve; });
  first.child.on('message', value => { if (value.type === 'boundary') ready(value); });
  const observation = await Promise.race([reached, first.exit.then(result => assert.fail(JSON.stringify({ result, messages: first.messages })))]);
  first.child.kill('SIGKILL'); const killed = await first.exit;
  assert.equal(killed.signal, 'SIGKILL');
  const second = worker(f, 'recover'); t.after(() => second.child.kill('SIGKILL'));
  const cold = await second.exit; assert.equal(cold.code, 0, JSON.stringify({ cold, messages: second.messages }));
  assert.notEqual(killed.pid, cold.pid);
  const result = second.messages.find(value => value.type === 'result');
  assert.equal(result.snapshot.phase, 'completed'); assert.equal(result.modelCalls, 1);
  assert.equal(result.snapshot.runId, 'run'); assert.equal(result.snapshot.usage.toolCalls, 1);
  const completed = f.store.load(scope, 'run');
  assert.deepEqual(completed.intents.find(row => row.kind === 'tool'), original.intents.find(row => row.kind === 'tool'));
  assert.deepEqual(completed.receipts.find(row => row.operationKey === f.snapshot.toolReconciliation.operationKey),
    original.receipts.find(row => row.operationKey === f.snapshot.toolReconciliation.operationKey));
  assert.equal(completed.commands.filter(row => row.command.commandId === observation.command.commandId).length, 1);
  assert.equal(completed.intents.filter(row => row.kind === 'tool_receipt').length, 1);
  assert.equal(completed.events.filter(row => row.kind === 'tool.receipt_reconciled').length, 1);
  assert.equal(f.f.calls.filter(call => call.wireMethod).length, before, 'recovery adds zero task HTTP requests');
  t.diagnostic(JSON.stringify({ boundary, killedPid: killed.pid, coldPid: cold.pid, originalRunId: 'run',
    originalToolCalls: 1, receiptIntents: 1, newTaskRequests: 0 }));
});
