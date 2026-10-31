import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NativeKernel, MemoryRunStore, emptyUsage, BACKGROUND_COMMAND_CONTRACT, NativeError,
} from '@kingsoftcloud/agentkit-harness-core';
import { fixture as coreFixture, scope, digest as coreDigest, tool } from './fixtures/native-core.mjs';
import { LocalCommandStore } from '@kingsoftcloud/agentkit-harness-node/native/local-background';
import { buildScriptEnvironment } from '@kingsoftcloud/agentkit-harness-node/native/local-process';
import { createNativeConversationCommandControl } from '@kingsoftcloud/agentkit-harness-node/native/conversation-command-control';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const READY_MARKER = 'command-control-target-ready';
const RUNNING_COMMAND = `printf '${READY_MARKER}\\n'; exec /bin/sleep 60`;
async function until(predicate, milliseconds = 6000) {
  const end = performance.now() + milliseconds;
  while (performance.now() < end) { const result = predicate(); if (result) return result; await pause(20); }
  assert.fail('condition not met within timeout');
}

// Build a head record whose backgroundCommands carry real local commands and
// committed launch receipts, so ownedCommandReceipt verifies on settle. The
// background port returns no observations so the run keeps requesting the model
// until onCheckpoint pauses after the requested number of launches.
function harness(t, { backend = 'sandbox/local_process', launches = 2, command = RUNNING_COMMAND } = {}) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'cmd-control-'));
  const workspace = join(root, 'workspace'); mkdirSync(workspace);
  const stateRoot = join(root, 'state');
  const localStore = new LocalCommandStore({ stateRoot, workspaceRoot: workspace, sessionId: 'session' });
  const store = new MemoryRunStore();
  const launcher = tool({ name: 'run_command', readOnly: false, concurrentSafe: false, timeoutMs: 3000,
    backgroundCommandPolicy: 'owned-command-launch/v1' });
  const { config, snapshot } = coreFixture({ tools: [launcher], backgroundNotificationPolicy: 'completed-before-model/v1' });
  const handles = [];
  let modelCalls = 0, paused = false;
  const control = createNativeConversationCommandControl({ workspaceRoot: workspace, stateRoot, scope, store, sessionId: 'session' });
  const kernel = new NativeKernel({ store, digest: coreDigest, owner: 'host', now: () => 1,
    onCheckpoint: async state => {
      if (state.backgroundCommands.length >= launches && !paused) {
        paused = true; kernel.submit(scope, 'run', { commandId: 'pause', kind: 'pause', payload: {} });
      }
    },
    ports: {
      model: { generate: async () => {
        modelCalls++;
        if (modelCalls <= launches) return { kind: 'tool_calls', text: '', usage: emptyUsage(),
          toolCalls: [{ callId: `launch${modelCalls}`, name: 'run_command', arguments: {} }] };
        return { kind: 'final_candidate', text: 'done', toolCalls: [], usage: emptyUsage() };
      } },
      tools: { execute: async request => {
        const handle = await localStore.start({ operationKey: request.operationKey, command,
          cwd: workspace, env: buildScriptEnvironment({ PATH: '/bin:/usr/bin' }), settings: { wallSeconds: 120 } });
        handles.push(handle);
        return { status: 'ok', content: { backend, task_id: handle.commandId },
          backgroundCommandRef: { taskId: handle.commandId, sourceRunId: request.runId, operationKey: request.operationKey } };
      } },
      background: { contract: BACKGROUND_COMMAND_CONTRACT, observe: async () => [] },
    } });
  t.after(async () => { for (const h of handles) { try { await h.kill(); } catch { /* bounded by wallSeconds */ } } store.close?.(); rmSync(root, { recursive: true, force: true }); });
  return { root, workspace, stateRoot, localStore, store, control, kernel, handles, config, snapshot,
    async run() {
      kernel.start(snapshot, config);
      const result = await kernel.runUntilIdle(scope, 'run');
      // The running record precedes launcher initialization. These tests cancel
      // active commands: wait for output from the real exec target, not a sleep
      // or an ownership record that cannot prove the target has started yet.
      if (command === RUNNING_COMMAND) await until(() => handles.every(handle => {
        const output = handle.readOutput();
        assert.notEqual(output.status, 'unknown', JSON.stringify(output));
        return output.status === 'running' && output.stdout.includes(READY_MARKER);
      }));
      return result;
    } };
}

test('two real local background tasks: only the removed task is canceled, the retained task stays alive', async t => {
  const f = harness(t);
  await f.run();
  const record = f.store.load(scope, 'run');
  const [ref1, ref2] = record.snapshot.backgroundCommands.map(row => row.ref);
  assert.equal(record.snapshot.backgroundCommands.length, 2, JSON.stringify({ reason: record.snapshot.reason,
    receipts: record.receipts.map(receipt => ({ status: receipt.status, result: receipt.result })) }));
  const result = await f.control.settle({ record, retainedRefs: [ref1], requestDigest: 'd1',
    signal: new AbortController().signal, assertCurrent: () => true });
  assert.equal(result.contract, 'agentkit.native-conversation-command-control/v1');
  assert.equal(result.requestDigest, 'd1');
  assert.deepEqual(result.retained, [{ ref: ref1, notified: false }]);
  assert.equal(result.stopped.length, 1);
  assert.deepEqual(result.stopped[0].ref, ref2);
  assert.equal(result.stopped[0].status, 'canceled');
  // Retained task is still alive; removed task is dead.
  assert.equal(f.localStore.connect(ref1.taskId).readOutput().status, 'running');
  assert.equal(f.localStore.connect(ref2.taskId).readOutput().status, 'canceled');
});

test('retry is idempotent: the durable cancel and terminal record mean no relaunch and the same partition', async t => {
  const f = harness(t);
  await f.run();
  const record = f.store.load(scope, 'run');
  const [ref1, ref2] = record.snapshot.backgroundCommands.map(row => row.ref);
  const signal = new AbortController().signal;
  const first = await f.control.settle({ record, retainedRefs: [ref1], requestDigest: 'd2', signal, assertCurrent: () => true });
  assert.equal(first.stopped[0].status, 'canceled');
  const second = await f.control.settle({ record, retainedRefs: [ref1], requestDigest: 'd2', signal, assertCurrent: () => true });
  assert.deepEqual(second.retained, [{ ref: ref1, notified: false }]);
  assert.equal(second.stopped.length, 1);
  assert.deepEqual(second.stopped[0].ref, ref2);
  assert.equal(second.stopped[0].status, 'canceled'); // already terminal, no relaunch
  assert.equal(f.localStore.connect(ref1.taskId).readOutput().status, 'running');
  assert.equal(f.localStore.connect(ref2.taskId).readOutput().status, 'canceled');
});

test('a foreign retained ref is rejected and performs no cancel', async t => {
  const f = harness(t);
  await f.run();
  const record = f.store.load(scope, 'run');
  const [ref1] = record.snapshot.backgroundCommands.map(row => row.ref);
  const foreign = { taskId: 'f'.repeat(64), sourceRunId: 'run', operationKey: 'forged' };
  await assert.rejects(f.control.settle({ record, retainedRefs: [ref1, foreign], requestDigest: 'd3',
    signal: new AbortController().signal, assertCurrent: () => true }), { code: 'conversation_command_foreign_ref' });
  // Both tasks are still alive — nothing was stopped.
  assert.equal(f.localStore.connect(ref1.taskId).readOutput().status, 'running');
});

test('a duplicate retained ref is rejected before any stop', async t => {
  const f = harness(t);
  await f.run();
  const record = f.store.load(scope, 'run');
  const [ref1, ref2] = record.snapshot.backgroundCommands.map(row => row.ref);
  await assert.rejects(f.control.settle({ record, retainedRefs: [ref1, ref1], requestDigest: 'd4',
    signal: new AbortController().signal, assertCurrent: () => true }), { code: 'conversation_command_duplicate_ref' });
  assert.equal(f.localStore.connect(ref1.taskId).readOutput().status, 'running');
  assert.equal(f.localStore.connect(ref2.taskId).readOutput().status, 'running');
});

test('an unsupported (e2b) backend fails closed with no cancel', async t => {
  const f = harness(t, { backend: 'sandbox/e2b', launches: 1 });
  await f.run();
  const record = f.store.load(scope, 'run');
  const [ref1] = record.snapshot.backgroundCommands.map(row => row.ref);
  await assert.rejects(f.control.settle({ record, retainedRefs: [], requestDigest: 'd5',
    signal: new AbortController().signal, assertCurrent: () => true }), { code: 'conversation_command_unsupported_backend' });
  // The real local task (launched by the tool executor) is still alive.
  assert.equal(f.localStore.connect(ref1.taskId).readOutput().status, 'running');
});

test('an unknown command status fails closed instead of stopping', async t => {
  const f = harness(t, { launches: 1, command: '/bin/sleep 1' });
  await f.run();
  const record = f.store.load(scope, 'run');
  const [ref1] = record.snapshot.backgroundCommands.map(row => row.ref);
  const handle = f.localStore.connect(ref1.taskId);
  process.kill(handle.processId, 'SIGKILL');
  await until(() => handle.readOutput().status === 'unknown');
  await assert.rejects(f.control.settle({ record, retainedRefs: [], requestDigest: 'd6',
    signal: new AbortController().signal, assertCurrent: () => true }), { code: 'background_command_outcome_unknown' });
});

test('caller cancellation aborts settle before any stop', async t => {
  const f = harness(t, { launches: 1 });
  await f.run();
  const record = f.store.load(scope, 'run');
  const [ref1] = record.snapshot.backgroundCommands.map(row => row.ref);
  const controller = new AbortController(); controller.abort(Error('caller cancel'));
  await assert.rejects(f.control.settle({ record, retainedRefs: [], requestDigest: 'd7',
    signal: controller.signal, assertCurrent: () => true }), /caller cancel/);
  // No cancel was issued; the task is still running.
  assert.equal(f.localStore.connect(ref1.taskId).readOutput().status, 'running');
});

test('authority loss (assertCurrent false) rejects before any stop', async t => {
  const f = harness(t, { launches: 1 });
  await f.run();
  const record = f.store.load(scope, 'run');
  const [ref1] = record.snapshot.backgroundCommands.map(row => row.ref);
  await assert.rejects(f.control.settle({ record, retainedRefs: [], requestDigest: 'd8',
    signal: new AbortController().signal, assertCurrent: () => false }), { code: 'conversation_command_authority_lost' });
  assert.equal(f.localStore.connect(ref1.taskId).readOutput().status, 'running');
});

test('a thenable assertCurrent is rejected, not awaited', async t => {
  const f = harness(t, { launches: 1 });
  await f.run();
  const record = f.store.load(scope, 'run');
  const [ref1] = record.snapshot.backgroundCommands.map(row => row.ref);
  await assert.rejects(f.control.settle({ record, retainedRefs: [], requestDigest: 'd9',
    signal: new AbortController().signal, assertCurrent: () => Promise.resolve(true) }),
    { code: 'conversation_command_authority_thenable' });
  assert.equal(f.localStore.connect(ref1.taskId).readOutput().status, 'running');
});

test('head drift (a new run advanced the session head) is rejected', async t => {
  const f = harness(t, { launches: 1 });
  await f.run();
  const record = f.store.load(scope, 'run');
  const staleSnapshot = record.snapshot;
  f.kernel.submit(scope, 'run', { commandId: 'cancel-head', kind: 'cancel', payload: {} });
  await f.kernel.runUntilIdle(scope, 'run');
  // Advance the session head with a terminal follow-up run.
  const followup = { ...f.snapshot, runId: 'run-2', sessionId: 'session' };
  f.kernel.start(followup, f.config);
  await f.kernel.runUntilIdle(scope, 'run-2');
  await assert.rejects(f.control.settle({ record: { ...record, snapshot: staleSnapshot }, retainedRefs: [],
    requestDigest: 'd10', signal: new AbortController().signal, assertCurrent: () => true }),
    { code: 'conversation_command_head_mismatch' });
});

test('scope and session mismatch are rejected', async t => {
  const f = harness(t, { launches: 1 });
  await f.run();
  const record = f.store.load(scope, 'run');
  const foreignScope = { ...scope, agentId: 'other-agent' };
  const foreignControl = createNativeConversationCommandControl({ workspaceRoot: f.workspace, stateRoot: f.stateRoot,
    scope: foreignScope, store: f.store, sessionId: 'session' });
  const [ref1] = record.snapshot.backgroundCommands.map(row => row.ref);
  await assert.rejects(foreignControl.settle({ record, retainedRefs: [], requestDigest: 'd11',
    signal: new AbortController().signal, assertCurrent: () => true }), { code: 'conversation_command_scope_mismatch' });
  assert.equal(f.localStore.connect(ref1.taskId).readOutput().status, 'running');
});

test('malformed inputs are rejected before any verification', async t => {
  const f = harness(t, { launches: 1 });
  await f.run();
  const record = f.store.load(scope, 'run');
  const [ref1] = record.snapshot.backgroundCommands.map(row => row.ref);
  for (const [label, bad] of [
    ['missing record', { record: null, retainedRefs: [], requestDigest: 'd', signal: new AbortController().signal, assertCurrent: () => true }],
    ['missing signal', { record, retainedRefs: [], requestDigest: 'd', signal: null, assertCurrent: () => true }],
    ['missing assertCurrent', { record, retainedRefs: [], requestDigest: 'd', signal: new AbortController().signal }],
    ['non-string digest', { record, retainedRefs: [], requestDigest: 5, signal: new AbortController().signal, assertCurrent: () => true }],
    ['non-array retainedRefs', { record, retainedRefs: 'x', requestDigest: 'd', signal: new AbortController().signal, assertCurrent: () => true }],
  ]) {
    await assert.rejects(f.control.settle(bad), NativeError, `rejected: ${label}`);
  }
  assert.equal(f.localStore.connect(ref1.taskId).readOutput().status, 'running');
});

test('a closed controller rejects settlement', async t => {
  const f = harness(t, { launches: 1 });
  await f.run();
  const record = f.store.load(scope, 'run');
  const [ref1] = record.snapshot.backgroundCommands.map(row => row.ref);
  let closed = false;
  const closedControl = createNativeConversationCommandControl({ workspaceRoot: f.workspace, stateRoot: f.stateRoot,
    scope, store: f.store, sessionId: 'session', isClosed: () => closed });
  closed = true;
  await assert.rejects(closedControl.settle({ record, retainedRefs: [], requestDigest: 'd12',
    signal: new AbortController().signal, assertCurrent: () => true }), { code: 'conversation_command_control_closed' });
  assert.equal(f.localStore.connect(ref1.taskId).readOutput().status, 'running');
});

test('a forged background partition at the same revision is rejected before cancel', async t => {
  const f = harness(t);
  await f.run();
  const record = f.store.load(scope, 'run');
  const forged = structuredClone(record);
  forged.snapshot.backgroundCommands.pop();
  await assert.rejects(f.control.settle({ record: forged, retainedRefs: [], requestDigest: 'forged',
    signal: new AbortController().signal, assertCurrent: () => true }), { code: 'conversation_command_record_mismatch' });
  for (const row of record.snapshot.backgroundCommands) assert.equal(f.localStore.connect(row.ref.taskId).readOutput().status, 'running');
});

test('authority callback cannot mutate the requested partition before cancel', async t => {
  const f = harness(t);
  await f.run();
  const record = f.store.load(scope, 'run'), retainedRefs = [record.snapshot.backgroundCommands[0].ref];
  await assert.rejects(f.control.settle({ record, retainedRefs, requestDigest: 'mutated',
    signal: new AbortController().signal, assertCurrent: () => { retainedRefs.pop(); return true; } }),
  { code: 'conversation_command_input_changed' });
  for (const row of record.snapshot.backgroundCommands) assert.equal(f.localStore.connect(row.ref.taskId).readOutput().status, 'running');
});

test('authority loss after a real stop prevents a second stop and successful settlement', async t => {
  const f = harness(t);
  await f.run();
  const record = f.store.load(scope, 'run');
  const [first, second] = record.snapshot.backgroundCommands.map(row => row.ref);
  await assert.rejects(f.control.settle({ record, retainedRefs: [], requestDigest: 'late-loss',
    signal: new AbortController().signal,
    assertCurrent: () => f.localStore.connect(first.taskId).readOutput().status !== 'canceled' }),
  { code: 'conversation_command_authority_lost' });
  assert.equal(f.localStore.connect(first.taskId).readOutput().status, 'canceled');
  assert.equal(f.localStore.connect(second.taskId).readOutput().status, 'running');
  assert.deepEqual(f.store.load(scope, 'run'), record);
});
