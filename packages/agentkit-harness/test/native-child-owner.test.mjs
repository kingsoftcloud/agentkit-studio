import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NativeKernel, MemoryRunStore, configure, emptyUsage } from '../../agentkit-harness-core/dist/index.mjs';
import { fixture, scope, digest, tool } from '../../agentkit-harness-core/test/fixtures.mjs';
import { SqliteRunStore } from '../src/native/sqlite-store.mjs';
import { createNativeChildOwner } from '../src/native/child-owner.mjs';
import { nativeChildToolDefinitions } from '../src/native/child-tools.mjs';

const childScope = { ...scope, agentId: 'child-agent' };
const startDefinition = tool({ name: 'native_start_child', readOnly: false, concurrentSafe: false, childBudgetPolicy: 'start/v1',
  parameters: { type: 'object', required: ['role', 'task'], properties: { role: { type: 'string' }, task: { type: 'string' } } } });
const childDefinition = tool({ name: 'write_proof', readOnly: false, concurrentSafe: false });
const controlDefinition = nativeChildToolDefinitions(['worker'])[1];
const call = { callId: 'start-1', name: startDefinition.name, arguments: { role: 'worker', task: 'Write the child proof' } };
const response = (text, toolCalls = []) => ({ kind: toolCalls.length ? 'tool_calls' : 'final_candidate', text, toolCalls, usage: emptyUsage() });
const childConfig = () => configure({ profile: fixture().config.profile, contract: { objective: call.arguments.task }, tools: [childDefinition],
  hostBindingDigest: 'child-fixture', limits: { maxModelCalls: 3, maxToolCalls: 2 } });

function setup(t, backend, { approval = false, uncertain = false, hold = false, control = null, foreground = false, delegate = false,
  promotion = false, input = false, holdModel = false, leaseMs = 30000, onChildModel, onContinuation, checkpoint } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'native-child-owner-'));
  const store = backend === 'sqlite' ? new SqliteRunStore(join(dir, 'runs.sqlite')) : new MemoryRunStore();
  let writes = 0, starts = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const childPorts = { model: { generate: async request => {
    await onChildModel?.(request);
    if (control === 'stop' || holdModel) { await gate; request.signal.throwIfAborted(); }
    return request.messages.some(message => message.role === 'tool')
      ? response('Child evidence') : response('', [{ callId: 'child-write', name: childDefinition.name, arguments: {} }]);
  } },
  tools: { execute: async request => {
    if (approval && !request.interaction) return { status: 'approval_required', content: {}, interactionId: 'child-host-approval' };
    if (approval) assert.equal(request.interaction.decision, 'allow');
    await gate;
    request.signal.throwIfAborted();
    writes++; writeFileSync(join(dir, 'proof.txt'), `writes=${writes}`);
    if (uncertain) throw new Error('crash after write');
    return { status: 'ok', content: 'Written' };
  } } };
  const owner = createNativeChildOwner({ scope, childScopes: [childScope], store,
    resolveChild: async () => { starts++; return { scope: childScope, configuration: childConfig(), ports: childPorts }; },
    restoreChild: async () => childPorts });
  t.after(async () => { release(); await owner.releaseRun({ scope, runId: 'run' }); store.close?.(); rmSync(dir, { recursive: true, force: true }); });
  const definition = delegate ? nativeChildToolDefinitions(['worker'])[2] : startDefinition;
  const startCall = { ...call, name: definition.name, arguments: { ...call.arguments, ...(foreground ? { background: false } : {}) } };
  const { config, snapshot } = fixture({ tools: [definition, ...(control ? [controlDefinition] : [])],
    limits: { maxModelCalls: 20, maxToolCalls: 20, effectTimeoutMs: 130000, leaseMs },
    childLifecyclePolicy: 'owned-background/v2', childApprovalPolicy: 'owned-child-approval/v1',
    ...(promotion ? { childPromotionPolicy: 'owned-child-promotion/v1' } : {}),
    ...(input ? { childInputPolicy: 'owned-child-input/v1' } : {}) });
  let rounds = 0, observed = false;
  const kernel = new NativeKernel({ store, digest, owner: 'parent', ports: { children: owner,
    tools: { execute: async request => {
      if (request.call.name === definition.name) return owner.start(request);
      const result = await owner.control(request);
      if (control === 'send') release();
      return result;
    } }, model: { generate: async request => {
      rounds++;
      if (rounds === 1) return response('', [startCall]);
      if (rounds === 2) await onContinuation?.(request);
      if (control && rounds === 2) return response('', [{ callId: 'control-1', name: controlDefinition.name,
        arguments: { child_run_id: store.load(scope, 'run').snapshot.childRunIds[0], action: control,
          ...(control === 'send' ? { message: 'Use this additional child guidance' } : { wait_seconds: 1 }) } }]);
      observed = request.messages.some(message => message.kind === 'background_child_observation'
        || message.role === 'tool' && message.content.includes('Child evidence'));
      return response(observed ? 'Parent used child evidence' : 'Premature parent draft');
    } } }, onCheckpoint: async current => {
      await checkpoint?.(current);
      const intent = store.load(scope, 'run').intents.find(item => item.operationKey === current.pendingIntent);
      if (!approval && !hold && intent?.kind === 'child' && intent.payload.action === 'wait') release();
    } });
  kernel.start(snapshot, config);
  return { dir, store, owner, kernel, release, writes: () => writes, starts: () => starts, observed: () => observed, rounds: () => rounds };
}

async function childStarted(store) {
  for (let tries = 0; tries < 500; tries++) {
    const children = store.list(childScope);
    if (children.some(child => store.load(childScope, child.runId).intents.some(intent => intent.kind === 'tool' && intent.status === 'running'))) return children[0];
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail('child never entered its real tool effect');
}

for (const position of ['inside', 'after']) test(`SQLite process exit ${position} child control commit preserves one atomic delivery`, async t => {
  const requests = [];
  const f = setup(t, 'sqlite', { foreground: true, hold: true, approval: true, input: true, leaseMs: 5000, onChildModel: request => requests.push(request) });
  const waiting = await f.kernel.runUntilIdle(scope, 'run'); assert.equal(waiting.phase, 'awaiting_interaction');
  const childId = waiting.childApproval.childRunId;
  f.kernel.sendChildInput(scope, 'run', childId, 'Guidance across a real process crash', 0, 'crash-input');
  const worker = fileURLToPath(new URL('./fixtures/native-child-control-crash-worker.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [worker, join(f.dir, 'runs.sqlite'), position], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, position === 'inside' ? 77 : 78, result.stderr);
  const reopened = new SqliteRunStore(join(f.dir, 'runs.sqlite'));
  try {
    assert.equal(reopened.load(scope, 'run').commands.find(row => row.command.commandId === 'crash-input').consumed, position === 'after');
    assert.equal(reopened.load(childScope, childId).commands.filter(row => row.command.kind === 'guide').length, position === 'after' ? 1 : 0);
  } finally { reopened.close(); }
  await new Promise(resolve => setTimeout(resolve, Math.max(0, f.store.load(scope, 'run').lease.expiresAt - Date.now() + 20)));
  assert.ok(f.store.load(scope, 'run').lease.expiresAt <= Date.now(), 'recovery waits for the real crashed lease to expire');
  f.release();
  f.kernel.submit(scope, 'run', { commandId: 'allow-after-control-crash', kind: 'submit_interaction', payload: {
    interactionId: waiting.pendingInteraction.interactionId, decision: 'allow' } });
  const final = await f.kernel.runUntilIdle(scope, 'run');
  assert.equal(final.phase, 'completed'); assert.equal(f.writes(), 1); assert.equal(f.starts(), 1);
  assert.equal(f.store.load(childScope, childId).commands.filter(row => row.command.kind === 'guide').length, 1);
  assert.equal(f.store.events(scope, 'run').filter(event => event.kind === 'child.input_queued').length, 1);
  assert.equal(requests.filter(request => request.messages.some(message => message.content === 'Guidance across a real process crash')).length, 1);
  assert.ok(final.childBudgetReservations[0].settledUsageDigest);
});

for (const backend of ['memory', 'sqlite']) {
  for (const target of ['parent', 'child']) test(`${backend}: pending ${target} steering preempts child guidance in the delivery transaction`, async t => {
    let rejecting = false;
    const f = setup(t, backend, { foreground: true, hold: true, approval: true, input: true, checkpoint: snapshot => {
      if (target === 'parent' && f.store.events(scope, 'run').some(event => event.payload.reason === 'parent_control_preempts_child_control')) {
        rejecting = true; f.kernel.submit(scope, 'run', { commandId: 'end-after-preemption', kind: 'cancel', payload: {} });
      }
    } });
    const waiting = await f.kernel.runUntilIdle(scope, 'run'), childId = waiting.childApproval.childRunId;
    f.store.enqueue(target === 'parent' ? scope : childScope, target === 'parent' ? 'run' : childId,
      { commandId: 'steer-before-child-input', kind: 'steer', payload: { text: 'New approved objective', expectedGoalRevision: 0 } });
    f.kernel.sendChildInput(scope, 'run', childId, 'obsolete guidance', 0, 'preempted-input');
    const result = await f.kernel.runUntilIdle(scope, 'run');
    assert.equal(result.phase, target === 'parent' ? 'canceled' : 'awaiting_interaction');
    assert.equal(f.store.events(scope, 'run').find(event => event.payload.commandId === 'preempted-input').payload.reason,
      target === 'parent' ? 'parent_control_preempts_child_control' : 'child_control_preempts_input');
    assert.equal(f.store.load(childScope, childId).commands.filter(row => row.command.kind === 'guide').length, 0);
    assert.equal(f.writes(), 0); if (target === 'parent') assert.equal(rejecting, true);
  });
  test(`${backend}: child input needs its explicit policy and foreign locators grant no controls`, async t => {
    const f = setup(t, backend, { foreground: true, hold: true });
    const running = f.kernel.runUntilIdle(scope, 'run'), child = await childStarted(f.store);
    assert.equal(f.kernel.childTasks(scope, 'run')[0].canSendInput, false);
    assert.throws(() => f.kernel.sendChildInput(scope, 'run', child.runId, 'unsupported', 0, 'no-policy'), /child_controls_unavailable/);
    assert.throws(() => f.kernel.cancelChild(scope, 'run', 'guessed-child', 'foreign-stop'), /child_control_not_owned/);
    assert.equal(f.store.load(scope, 'run').commands.length, 0); f.release(); assert.equal((await running).phase, 'completed');
  });
  test(`${backend}: Host guidance before the startup receipt reaches the same child exactly once`, async t => {
    const requests = [];
    const f = setup(t, backend, { foreground: true, hold: true, input: true, onChildModel: request => requests.push(request) });
    const running = f.kernel.runUntilIdle(scope, 'run'), child = await childStarted(f.store);
    assert.equal(f.store.load(scope, 'run').snapshot.childRunIds.length, 0, 'start receipt is still pending');
    assert.equal(f.kernel.childTasks(scope, 'run')[0].goalRevision, 0);
    const args = [scope, 'run', child.runId, 'Inspect the actual write', 0, 'host-guidance'];
    assert.equal(f.kernel.sendChildInput(...args).status, 'accepted');
    assert.equal(f.kernel.sendChildInput(...args).status, 'duplicate');
    assert.throws(() => f.kernel.sendChildInput(scope, 'run', child.runId, 'changed payload', 0, 'host-guidance'), /command_replay_conflict/);
    for (let tries = 0; tries < 500 && !f.store.load(childScope, child.runId).commands.some(row => row.command.kind === 'guide'); tries++)
      await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(f.store.load(childScope, child.runId).commands.filter(row => row.command.kind === 'guide').length, 1);
    assert.equal(f.rounds(), 1); f.release();
    const result = await running; assert.equal(result.phase, 'completed'); assert.equal(f.writes(), 1); assert.equal(f.starts(), 1);
    assert.equal(requests.filter(request => request.messages.some(message => message.kind === 'guidance'
      && message.content === 'Inspect the actual write')).length, 1);
    assert.equal(f.store.events(scope, 'run').filter(event => event.kind === 'child.input_queued').length, 1);
    assert.equal(f.kernel.sendChildInput(...args).status, 'duplicate');
  });

  test(`${backend}: a stale child revision is a known refusal without a child inbox write`, async t => {
    const f = setup(t, backend, { foreground: true, hold: true, input: true });
    const running = f.kernel.runUntilIdle(scope, 'run'), child = await childStarted(f.store);
    f.kernel.sendChildInput(scope, 'run', child.runId, 'stale guidance', 1, 'stale-input');
    for (let tries = 0; tries < 500 && !f.store.load(scope, 'run').commands.some(row => row.command.commandId === 'stale-input' && row.consumed); tries++)
      await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(f.store.events(scope, 'run').find(event => event.payload.commandId === 'stale-input').payload.reason, 'stale_child_goal_revision');
    assert.equal(f.store.load(childScope, child.runId).commands.some(row => row.command.kind === 'guide'), false);
    f.release(); assert.equal((await running).phase, 'completed'); assert.equal(f.writes(), 1);
  });

  test(`${backend}: Host cancellation before startup settlement interrupts the original child without stopping its parent`, async t => {
    const f = setup(t, backend, { foreground: true, hold: true, holdModel: true, input: true });
    const running = f.kernel.runUntilIdle(scope, 'run'); let child;
    for (let tries = 0; tries < 500 && !child; tries++) {
      child = f.store.list(childScope).find(row => row.phase === 'requesting_model');
      if (!child) await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert.ok(child); assert.equal(f.kernel.cancelChild(scope, 'run', child.runId, 'host-stop').status, 'accepted');
    assert.equal(f.kernel.cancelChild(scope, 'run', child.runId, 'host-stop').status, 'duplicate');
    const result = await running;
    assert.equal(result.phase, 'completed'); assert.equal(f.store.load(childScope, child.runId).snapshot.phase, 'canceled');
    assert.equal(f.starts(), 1); assert.equal(f.writes(), 0); assert.ok(result.childBudgetReservations[0].settledUsageDigest);
    assert.equal(f.store.events(scope, 'run').filter(event => event.kind === 'child.cancel_requested').length, 1);
  });

  test(`${backend}: canceling an approval-waiting child withdraws its original approval without granting the tool`, async t => {
    const f = setup(t, backend, { foreground: true, hold: true, approval: true, input: true });
    const waiting = await f.kernel.runUntilIdle(scope, 'run'); assert.equal(waiting.phase, 'awaiting_interaction');
    const childRunId = waiting.childApproval.childRunId;
    f.kernel.cancelChild(scope, 'run', childRunId, 'cancel-pending-approval');
    const result = await f.kernel.runUntilIdle(scope, 'run');
    assert.equal(result.phase, 'completed'); assert.equal(result.pendingInteraction, null); assert.equal(result.childApproval, null);
    assert.equal(f.store.load(childScope, childRunId).snapshot.phase, 'canceled'); assert.equal(f.writes(), 0);
    assert.equal(f.store.load(childScope, childRunId).commands.some(row => row.command.kind === 'submit_interaction'), false);
    assert.ok(f.store.events(scope, 'run').some(event => event.kind === 'approval.resolved' && event.payload.decision === 'canceled'));
  });
  test(`${backend}: foreground promotion is unavailable without its explicit policy`, async t => {
    const f = setup(t, backend, { foreground: true, hold: true });
    const running = f.kernel.runUntilIdle(scope, 'run'), child = await childStarted(f.store);
    assert.equal(f.kernel.childTasks(scope, 'run')[0].canPromote, false);
    assert.throws(() => f.kernel.promoteChild(scope, 'run', child.runId, 'unsupported'), /child_promotion_unavailable/);
    assert.equal(f.rounds(), 1); f.release(); assert.equal((await running).phase, 'completed');
    assert.equal(f.store.events(scope, 'run').filter(event => event.kind === 'child.promoted').length, 0);
  });

  test(`${backend}: a promoted child remains owned when the parent is canceled`, async t => {
    const f = setup(t, backend, { foreground: true, hold: true, promotion: true,
      onContinuation: async () => { f.kernel.submit(scope, 'run', { commandId: 'cancel-promoted-parent', kind: 'cancel', payload: {} }); } });
    const running = f.kernel.runUntilIdle(scope, 'run'), child = await childStarted(f.store);
    f.kernel.promoteChild(scope, 'run', child.runId, 'before-cancel');
    const result = await running;
    assert.equal(result.phase, 'canceled'); assert.deepEqual(result.childRunIds, [child.runId]);
    assert.deepEqual(result.promotedChildRunIds, [child.runId]); assert.equal(result.childBudgetReservations.length, 1);
    f.release(); await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(f.writes(), 0); assert.equal(f.starts(), 1); assert.equal(f.store.load(childScope, child.runId).snapshot.phase, 'canceled');
  });
  test(`${backend}: promotion during an approved child effect preserves the original decision exactly once`, { timeout: 10000 }, async t => {
    const f = setup(t, backend, { foreground: true, hold: true, approval: true, promotion: true,
      onContinuation: async () => { assert.equal(f.writes(), 0); f.release(); } });
    const pending = await f.kernel.runUntilIdle(scope, 'run'); assert.equal(pending.phase, 'awaiting_interaction');
    f.kernel.submit(scope, 'run', { commandId: 'allow-running-child', kind: 'submit_interaction', payload: {
      interactionId: pending.pendingInteraction.interactionId, decision: 'allow' } });
    const running = f.kernel.runUntilIdle(scope, 'run'), childId = pending.childRunIds[0];
    let approved = false;
    for (let index = 0; index < 500; index++) {
      const child = f.store.load(childScope, childId);
      const intent = child.intents.find(item => item.operationKey === child.snapshot.pendingIntent);
      if (intent?.kind === 'tool' && intent.status === 'running' && intent.payload.interaction?.decision === 'allow') { approved = true; break; }
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert.equal(approved, true);
    f.kernel.promoteChild(scope, 'run', childId, 'after-allow');
    const result = await running;
    assert.equal(result.phase, 'completed'); assert.equal(f.writes(), 1); assert.equal(f.starts(), 1);
    assert.deepEqual(result.promotedChildRunIds, [childId]); assert.ok(result.childBudgetReservations[0].settledUsageDigest);
    const child = f.store.load(childScope, childId);
    assert.equal(child.commands.filter(row => row.command.kind === 'submit_interaction').length, 1);
  });
  test(`${backend}: a foreign promotion cannot release foreground waiting; promotion can wake its resumed collector`, { timeout: 10000 }, async t => {
    let continued = false;
    const f = setup(t, backend, { foreground: true, hold: true, promotion: true, onContinuation: async () => {
      continued = true; assert.equal(f.writes(), 0); f.release();
    } });
    let running = f.kernel.runUntilIdle(scope, 'run'); const child = await childStarted(f.store);
    f.kernel.promoteChild(scope, 'run', 'another-parents-child', 'foreign');
    for (let index = 0; index < 500 && !f.store.load(scope, 'run').commands.find(row => row.command.commandId === 'foreign')?.consumed; index++)
      await new Promise(resolve => setTimeout(resolve, 2));
    assert.ok(f.store.events(scope, 'run').some(event => event.kind === 'command.applied'
      && event.payload.commandId === 'foreign' && event.payload.reason === 'foreground_child_unavailable'));
    assert.equal(f.rounds(), 1); assert.equal(continued, false); assert.equal(f.writes(), 0);
    assert.deepEqual(f.store.load(scope, 'run').snapshot.promotedChildRunIds, []);
    f.kernel.promoteChild(scope, 'run', child.runId, 'real');
    const result = await running;
    assert.equal(result.phase, 'completed'); assert.equal(continued, true); assert.equal(f.starts(), 1); assert.equal(f.writes(), 1);
    assert.deepEqual(result.promotedChildRunIds, [child.runId]);
    assert.equal(f.store.events(scope, 'run').filter(event => event.kind === 'child.promoted').length, 1);
  });

  test(`${backend}: promotion supersedes a prepared foreground wait after approval without starting another child`, { timeout: 10000 }, async t => {
    let promoted = false;
    const f = setup(t, backend, { foreground: true, hold: true, approval: true, promotion: true,
      onContinuation: async () => { assert.equal(promoted, true); assert.equal(f.writes(), 0); f.release(); },
      checkpoint: async current => {
        const intent = f.store.load(scope, 'run').intents.find(item => item.operationKey === current.pendingIntent);
        if (!promoted && intent?.kind === 'child' && intent.status === 'prepared' && intent.payload.action === 'wait'
          && intent.payload.interaction?.decision === 'allow') {
          promoted = true; f.kernel.promoteChild(scope, 'run', current.childRunIds[0], 'prepared-wait');
        }
      } });
    const pending = await f.kernel.runUntilIdle(scope, 'run'); assert.equal(pending.phase, 'awaiting_interaction');
    f.kernel.submit(scope, 'run', { commandId: 'allow', kind: 'submit_interaction', payload: {
      interactionId: pending.pendingInteraction.interactionId, decision: 'allow' } });
    const result = await f.kernel.runUntilIdle(scope, 'run');
    assert.equal(result.phase, 'completed'); assert.equal(promoted, true); assert.equal(f.writes(), 1); assert.equal(f.starts(), 1);
    assert.equal(result.childRunIds.length, 1); assert.deepEqual(result.promotedChildRunIds, result.childRunIds);
  });
  test(`${backend}: promotion commits before parent continuation and keeps the same active child and budget`, { timeout: 10000 }, async t => {
    let continued = false;
    const f = setup(t, backend, { foreground: true, hold: true, promotion: true, onContinuation: async () => {
      const parent = f.store.load(scope, 'run').snapshot;
      assert.deepEqual(parent.promotedChildRunIds, [parent.childRunIds[0]]);
      assert.equal(f.store.load(childScope, parent.childRunIds[0]).snapshot.phase, 'executing_tools');
      assert.equal(f.writes(), 0); continued = true; f.release();
    } });
    const running = f.kernel.runUntilIdle(scope, 'run'), child = await childStarted(f.store);
    const tasks = f.kernel.childTasks(scope, 'run');
    assert.equal(tasks.length, 1); assert.equal(tasks[0].childRunId, child.runId);
    assert.equal(tasks[0].delivery, 'foreground'); assert.equal(tasks[0].canPromote, true);
    assert.equal(f.kernel.promoteChild(scope, 'run', child.runId, 'promote').status, 'accepted');
    assert.equal(f.kernel.promoteChild(scope, 'run', child.runId, 'promote').status, 'duplicate');
    const result = await running;
    assert.equal(result.phase, 'completed'); assert.equal(continued, true); assert.equal(f.starts(), 1); assert.equal(f.writes(), 1);
    assert.deepEqual(result.childRunIds, [child.runId]); assert.equal(result.childBudgetReservations.length, 1);
    assert.equal(result.childBudgetReservations[0].deliveryMode, 'foreground'); assert.ok(result.childBudgetReservations[0].settledUsageDigest);
    assert.deepEqual([result.descendantUsage.modelCalls, result.descendantUsage.toolCalls], [2, 1]);
    const events = f.store.events(scope, 'run'), promoted = events.filter(event => event.kind === 'child.promoted');
    assert.equal(promoted.length, 1);
    assert.ok(promoted[0].seq < events.find(event => event.kind === 'tool.completed' && event.payload.callId === 'start-1').seq);
    assert.equal(events.filter(event => event.kind === 'usage.reported' && event.payload.source === 'descendant_runs').length, 1);
    const after = f.kernel.childTasks(scope, 'run')[0];
    assert.equal(after.delivery, 'background'); assert.equal(after.canPromote, false);
    assert.equal(after.canCancel, false); assert.equal(after.canSendInput, false);
    assert.equal(f.kernel.promoteChild(scope, 'run', child.runId, 'late').status, 'rejected');
  });
  test(`${backend}: canceling foreground startup stops its actual child before a late write`, async t => {
    const f = setup(t, backend, { foreground: true, hold: true });
    const running = f.kernel.runUntilIdle(scope, 'run'), child = await childStarted(f.store);
    f.kernel.submit(scope, 'run', { commandId: 'foreground-cancel', kind: 'cancel', payload: {} });
    const canceled = await running;
    assert.equal(canceled.phase, 'canceled');
    assert.deepEqual(canceled.childRunIds, [child.runId]);
    assert.equal(canceled.childBudgetReservations[0].deliveryMode, 'foreground');
    f.release(); await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(f.writes(), 0); assert.equal(f.rounds(), 1); assert.equal(f.starts(), 1);
    const record = f.store.load(childScope, child.runId);
    assert.equal(record.snapshot.phase, 'canceled');
    assert.ok(record.commands.some(row => row.command.kind === 'cancel'));
    assert.ok(f.store.load(scope, 'run').receipts.some(receipt => receipt.result.recoveryPolicy === 'owned-child-start/v1'));
  });

  test(`${backend}: an uncertain foreground write stays reserved and is never replayed or returned as findings`, async t => {
    const f = setup(t, backend, { foreground: true, hold: true, uncertain: true });
    const running = f.kernel.runUntilIdle(scope, 'run'); await childStarted(f.store); f.release();
    const result = await running;
    assert.notEqual(result.phase, 'completed'); assert.equal(result.reason, 'child_receipt_unavailable');
    assert.equal(result.childBudgetReservations[0].deliveryMode, 'foreground');
    assert.equal(result.childBudgetReservations[0].settledUsageDigest, null);
    assert.equal(f.writes(), 1); assert.equal(f.starts(), 1); assert.equal(f.rounds(), 1);
    assert.equal(f.observed(), false);
    assert.deepEqual(await f.kernel.runUntilIdle(scope, 'run'), result); assert.equal(f.writes(), 1);
  });
  for (const delegate of [false, true]) test(`${backend}: ${delegate ? 'native_delegate' : 'background=false'} returns one original foreground delivery and settles budget atomically`, async t => {
    const f = setup(t, backend, { foreground: true, delegate, hold: true });
    const running = f.kernel.runUntilIdle(scope, 'run');
    const child = await childStarted(f.store);
    assert.equal(f.rounds(), 1); assert.equal(f.writes(), 0);
    assert.equal(f.store.load(scope, 'run').snapshot.childRunIds.length, 0);
    f.release(); const result = await running;
    assert.equal(result.phase, 'completed'); assert.equal(result.finalText, 'Parent used child evidence');
    assert.equal(f.starts(), 1); assert.equal(f.rounds(), 2); assert.equal(f.writes(), 1);
    assert.equal(result.childRunIds[0], child.runId); assert.equal(result.childBudgetReservations[0].deliveryMode, 'foreground');
    assert.ok(result.childBudgetReservations[0].settledUsageDigest);
    assert.deepEqual([result.descendantUsage.modelCalls, result.descendantUsage.toolCalls], [2, 1]);
    assert.equal(result.messages.filter(message => message.kind === 'background_child_observation').length, 0);
    assert.equal(f.store.events(scope, 'run').filter(event => event.kind === 'usage.reported' && event.payload.source === 'descendant_runs').length, 1);
  });

  test(`${backend}: foreground approval preserves one child and blocks the next parent model until its result`, async t => {
    const f = setup(t, backend, { foreground: true, approval: true, hold: true });
    const pending = await f.kernel.runUntilIdle(scope, 'run');
    assert.equal(pending.phase, 'awaiting_interaction'); assert.equal(f.rounds(), 1);
    assert.equal(pending.childBudgetReservations[0].deliveryMode, 'foreground');
    f.kernel.submit(scope, 'run', { commandId: 'foreground-allow', kind: 'submit_interaction', payload: {
      interactionId: pending.pendingInteraction.interactionId, decision: 'allow' } });
    const running = f.kernel.runUntilIdle(scope, 'run');
    await childStarted(f.store); assert.equal(f.rounds(), 1);
    f.release(); const result = await running;
    assert.equal(result.phase, 'completed'); assert.equal(f.rounds(), 2); assert.equal(f.starts(), 1); assert.equal(f.writes(), 1);
    assert.ok(result.childBudgetReservations[0].settledUsageDigest);
  });

  test(`${backend}: pausing foreground startup preserves its original child and resume waits on that child`, async t => {
    const f = setup(t, backend, { foreground: true, hold: true });
    const running = f.kernel.runUntilIdle(scope, 'run'); const child = await childStarted(f.store);
    f.kernel.submit(scope, 'run', { commandId: 'foreground-pause', kind: 'pause', payload: {} });
    const paused = await running;
    assert.equal(paused.phase, 'paused'); assert.equal(paused.childRunIds[0], child.runId); assert.equal(f.rounds(), 1);
    f.kernel.submit(scope, 'run', { commandId: 'foreground-resume', kind: 'resume', payload: {} });
    const resumed = f.kernel.runUntilIdle(scope, 'run');
    await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(f.rounds(), 1); assert.equal(f.starts(), 1);
    f.release(); const final = await resumed;
    assert.equal(final.phase, 'completed'); assert.equal(f.writes(), 1); assert.equal(f.starts(), 1);
    assert.ok(final.childBudgetReservations[0].settledUsageDigest);
  });
  for (const action of ['send', 'stop']) test(`${backend}: model-visible child control ${action} acts on the original owned child`, { timeout: 10000 }, async t => {
    const { store, kernel, writes, starts, release } = setup(t, backend, { control: action, hold: true });
    const result = await kernel.runUntilIdle(scope, 'run');
    assert.equal(result.phase, 'completed'); assert.equal(starts(), 1);
    const reservation = result.childBudgetReservations[0], child = store.load(reservation.childScope, reservation.childRunId);
    assert.ok(reservation.settledUsageDigest);
    if (action === 'send') {
      assert.equal(writes(), 1); assert.equal(child.snapshot.phase, 'completed');
      assert.ok(child.snapshot.messages.some(message => message.kind === 'guidance' && message.content === 'Use this additional child guidance'));
    } else {
      assert.equal(writes(), 0); assert.equal(child.snapshot.phase, 'canceled');
      assert.equal(result.diagnostics.descendantUsageIncomplete, true);
      assert.equal(store.events(scope, 'run').findLast(event => event.kind === 'run.terminal').payload.usageComplete, false);
      release(); await new Promise(resolve => setImmediate(resolve)); assert.equal(writes(), 0);
    }
  });
  test(`${backend}: a real child Kernel executes its tool once; parent waits and reconsiders its premature candidate`, { timeout: 10000 }, async t => {
    const { store, kernel, dir, writes, starts, observed } = setup(t, backend);
    const result = await kernel.runUntilIdle(scope, 'run');
    assert.equal(result.phase, 'completed'); assert.equal(result.finalText, 'Parent used child evidence');
    assert.equal(writes(), 1); assert.equal(starts(), 1); assert.equal(observed(), true);
    assert.equal(readFileSync(join(dir, 'proof.txt'), 'utf8'), 'writes=1');
    assert.equal(result.usage.toolCalls, 1); assert.equal(result.descendantUsage.modelCalls, 2); assert.equal(result.descendantUsage.toolCalls, 1);
    const usage = store.events(scope, 'run').filter(event => event.kind === 'usage.reported' && event.payload.source === 'descendant_runs');
    assert.equal(usage.length, 1); assert.equal(usage[0].payload.usage.modelCalls, 2);
    assert.equal(result.children.length, 1); assert.equal(result.children[0].state, 'completed'); assert.equal(result.children[0].notified, true);
    assert.match(result.childBudgetReservations[0].settledUsageDigest, /^[0-9a-f]{64}$/);
    const record = store.load(childScope, result.childRunIds[0]);
    assert.equal(record.configuration.childOwnerBinding.parent.runId, 'run');
    assert.equal(record.configuration.delegationDepth, 1);
    assert.equal(record.configuration.limits.maxModelCalls, 3);
    assert.equal(record.configuration.limits.maxToolCalls, 2);
    assert.equal(record.snapshot.parentRunId, null);
  });

  test(`${backend}: a child approval is bridged to the parent and rejects a stale interaction`, { timeout: 10000 }, async t => {
    const { store, kernel, release, writes } = setup(t, backend, { approval: true });
    const pending = await kernel.runUntilIdle(scope, 'run');
    assert.equal(pending.phase, 'awaiting_interaction'); assert.equal(writes(), 0);
    assert.equal(pending.childApproval.toolCall.name, childDefinition.name);
    assert.ok(store.events(scope, 'run').some(event => event.kind === 'approval.requested' && event.payload.source === 'child_tool'));
    kernel.submit(scope, 'run', { commandId: 'stale', kind: 'submit_interaction', payload: { interactionId: 'wrong', decision: 'allow' } });
    assert.equal((await kernel.runUntilIdle(scope, 'run')).phase, 'awaiting_interaction');
    assert.equal(writes(), 0);
    release();
    kernel.submit(scope, 'run', { commandId: 'allow-child', kind: 'submit_interaction', payload: {
      interactionId: pending.pendingInteraction.interactionId, decision: 'allow' } });
    const result = await kernel.runUntilIdle(scope, 'run');
    assert.equal(result.phase, 'completed'); assert.equal(writes(), 1);
    assert.equal(result.descendantUsage.toolCalls, 1);
  });

  test(`${backend}: an uncertain child write is never retried or accepted as a complete child result`, { timeout: 10000 }, async t => {
    const { kernel, writes } = setup(t, backend, { uncertain: true });
    const result = await kernel.runUntilIdle(scope, 'run');
    assert.notEqual(result.phase, 'completed'); assert.equal(writes(), 1);
    assert.equal(result.reason, 'child_receipt_unavailable');
    assert.equal(result.childBudgetReservations[0].settledUsageDigest, null);
    assert.deepEqual(await kernel.runUntilIdle(scope, 'run'), result); assert.equal(writes(), 1);
  });

  test(`${backend}: pausing the parent's active child wait leaves the child owned and resume collects it once`, { timeout: 10000 }, async t => {
    const { kernel, store, release, writes } = setup(t, backend, { hold: true });
    const running = kernel.runUntilIdle(scope, 'run');
    for (let tries = 0; tries < 500; tries++) {
      const parent = store.load(scope, 'run'), intent = parent.intents.find(item => item.operationKey === parent.snapshot.pendingIntent);
      if (intent?.kind === 'child' && intent.payload.action === 'wait' && intent.status === 'running') break;
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    kernel.submit(scope, 'run', { commandId: 'pause-wait', kind: 'pause', payload: {} });
    const paused = await running;
    assert.equal(paused.phase, 'paused'); assert.equal(writes(), 0);
    assert.equal(paused.childBudgetReservations[0].settledUsageDigest, null);
    assert.ok(store.load(scope, 'run').receipts.some(receipt => receipt.result.reason === 'child_observation_paused'));
    release();
    kernel.submit(scope, 'run', { commandId: 'resume-wait', kind: 'resume', payload: {} });
    const final = await kernel.runUntilIdle(scope, 'run');
    assert.equal(final.phase, 'completed'); assert.equal(writes(), 1); assert.equal(final.descendantUsage.toolCalls, 1);
  });

  test(`${backend}: parent cancellation stops an active child and a late tool cannot write`, { timeout: 10000 }, async t => {
    const { kernel, store, release, writes } = setup(t, backend, { hold: true });
    const running = kernel.runUntilIdle(scope, 'run');
    for (let tries = 0; tries < 500; tries++) {
      const parent = store.load(scope, 'run'), intent = parent.intents.find(item => item.operationKey === parent.snapshot.pendingIntent);
      if (intent?.kind === 'child' && intent.payload.action === 'wait' && intent.status === 'running') break;
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    kernel.submit(scope, 'run', { commandId: 'cancel-parent', kind: 'cancel', payload: {} });
    const canceled = await running;
    assert.equal(canceled.phase, 'canceled'); assert.equal(writes(), 0);
    release(); await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(writes(), 0);
    const child = store.load(childScope, canceled.childRunIds[0]);
    assert.equal(child.snapshot.phase, 'canceled');
    assert.ok(store.load(scope, 'run').intents.some(intent => intent.kind === 'child' && intent.payload.action === 'cancel'));
  });
}

for (const boundary of ['startup', 'collection', 'foreground']) test(`Node process death before parent ${boundary} receipt reconciles the same sealed child`, { timeout: 15000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'native-child-process-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const worker = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/native-child-crash-worker.mjs', import.meta.url)), dir, boundary],
    { encoding: 'utf8', timeout: 10000 });
  assert.equal(worker.status, 0, worker.stderr);
  const store = new SqliteRunStore(join(dir, 'runs.sqlite'));
  t.after(() => store.close());
  let starts = 0;
  const owner = createNativeChildOwner({ scope, childScopes: [childScope], store,
    resolveChild: async () => { starts++; throw new Error('must not restart'); } });
  const kernel = new NativeKernel({ store, owner: 'replacement-parent', digest, ports: { children: owner,
    tools: { execute: async () => { throw new Error('must not dispatch startup again'); } },
    model: { generate: async request => {
      assert.ok(request.messages.some(message => boundary === 'foreground'
        ? message.role === 'tool' && message.content.includes('Child evidence') : message.kind === 'background_child_observation'));
      return response('Recovered parent');
    } } } });
  const result = await kernel.runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed'); assert.equal(result.finalText, 'Recovered parent');
  assert.equal(starts, 0); assert.equal(readFileSync(join(dir, 'proof.txt'), 'utf8'), 'one write');
  assert.equal(result.childRunIds.length, 1); assert.equal(result.descendantUsage.modelCalls, 2); assert.equal(result.descendantUsage.toolCalls, 1);
  assert.equal(result.usage.toolCalls, 1);
  assert.equal(store.events(scope, 'run').filter(event => event.kind === 'usage.reported' && event.payload.source === 'descendant_runs').length, 1);
  assert.ok(store.load(scope, 'run').receipts.some(receipt => receipt.result.recoveryPolicy === (boundary === 'collection'
    ? 'owned-child-observation/v1' : 'owned-child-start/v1')));
  if (boundary === 'foreground') {
    assert.equal(result.childBudgetReservations[0].deliveryMode, 'foreground');
    assert.equal(result.messages.filter(message => message.kind === 'background_child_observation').length, 0);
  }
});

test('a process crash after promotion preserves background delivery and the original child session', { timeout: 15000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'native-child-promotion-crash-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const worker = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/native-child-promotion-crash-worker.mjs', import.meta.url)), dir],
    { encoding: 'utf8', timeout: 10000 });
  assert.equal(worker.status, 0, worker.stderr);
  const store = new SqliteRunStore(join(dir, 'runs.sqlite'));
  let owner;
  t.after(async () => { await owner?.releaseRun({ scope, runId: 'run' }); store.close(); });
  const before = store.load(scope, 'run').snapshot, childBefore = store.load(childScope, before.childRunIds[0]).snapshot;
  assert.deepEqual(before.promotedChildRunIds, before.childRunIds); assert.equal(childBefore.phase, 'requesting_model');
  await new Promise(resolve => setTimeout(resolve, Math.max(0, store.load(scope, 'run').lease.expiresAt - Date.now()) + 25));
  let starts = 0, writes = 0;
  owner = createNativeChildOwner({ scope, childScopes: [childScope], store,
    resolveChild: async () => { starts++; throw Error('must not launch another child'); },
    restoreChild: async () => ({ model: { generate: async request => request.messages.some(message => message.role === 'tool')
      ? response('Recovered child evidence') : response('', [{ callId: 'child-write', name: 'write_proof', arguments: {} }]) },
    tools: { execute: async () => { writes++; writeFileSync(join(dir, 'proof.txt'), 'one recovered write'); return { status: 'ok', content: 'Written' }; } } }),
  });
  const kernel = new NativeKernel({ store, digest, owner: 'replacement', ports: { children: owner,
    tools: { execute: async () => { throw Error('must not repeat startup'); } },
    model: { generate: async () => response('Recovered parent') } } });
  const result = await kernel.runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed'); assert.equal(starts, 0); assert.equal(writes, 1);
  assert.deepEqual(result.promotedChildRunIds, before.promotedChildRunIds); assert.deepEqual(result.childRunIds, before.childRunIds);
  const childAfter = store.load(childScope, before.childRunIds[0]).snapshot;
  assert.equal(childAfter.sessionId, childBefore.sessionId); assert.equal(childAfter.phase, 'completed');
  assert.equal(result.descendantUsage.modelCalls, 3); assert.equal(result.descendantUsage.toolCalls, 1);
  assert.ok(result.childBudgetReservations[0].settledUsageDigest);
  assert.equal(store.events(scope, 'run').filter(event => event.kind === 'child.promoted').length, 1);
  assert.equal(store.events(scope, 'run').filter(event => event.kind.startsWith('usage.') && event.payload.source === 'descendant_runs').length, 1);
});

test('an expired parent cannot start a child after a slow Host binding lookup', { timeout: 10000 }, async t => {
  const store = new MemoryRunStore();
  let enter, release, childModels = 0;
  const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const owner = createNativeChildOwner({ scope, childScopes: [childScope], store, resolveChild: async () => {
    enter(); await gate;
    return { scope: childScope, configuration: childConfig(), ports: {
      model: { generate: async () => { childModels++; return response('Must not run'); } }, tools: { execute: async () => ({ status: 'ok', content: {} }) },
    } };
  } });
  t.after(async () => owner.releaseRun({ scope, runId: 'run' }));
  const { config, snapshot } = fixture({ tools: [startDefinition], childLifecyclePolicy: 'owned-background/v2' });
  const kernel = new NativeKernel({ store, owner: 'stale-parent', digest, ports: {
    model: { generate: async () => response('', [call]) }, tools: { execute: request => owner.start(request) }, children: owner,
  } });
  kernel.start(snapshot, config);
  const running = kernel.runUntilIdle(scope, 'run');
  await entered;
  store.acquire(scope, 'run', 'replacement', Date.now() + 200000, 10000);
  release();
  await assert.rejects(running, /stale_fence|lease_lost/);
  assert.equal(childModels, 0); assert.deepEqual(store.list(childScope), []);
});
