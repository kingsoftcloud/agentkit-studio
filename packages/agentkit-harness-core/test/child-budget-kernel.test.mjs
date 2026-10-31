import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeKernel, MemoryRunStore, emptyUsage, modelRoom, toolRoom, transition, prepareEffect, contextContinuity,
  prepareChildLifecycle, childLifecycleRequest, reduceChildLifecycle } from '../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { fixture, scope, digest, tool } from './fixtures.mjs';

const childTools = [tool({ name: 'start_child', concurrentSafe: false, readOnly: false, childBudgetPolicy: 'start/v1' }),
  tool({ name: 'collect_child', concurrentSafe: false, childBudgetPolicy: 'settle/v1' })];
const call = (callId, name) => ({ callId, name, arguments: {} });
const response = toolCalls => ({ kind: toolCalls ? 'tool_calls' : 'final_candidate', text: toolCalls ? '' : 'Done',
  toolCalls: toolCalls ?? [], usage: emptyUsage() });
const reservation = request => ({ childRunId: 'child', childScope: { ...scope, agentId: 'worker-agent' },
  parentOperationKey: request.operationKey, parentToolCallId: request.call.callId,
  childRequestDigest: digest('child-request'), configurationDigest: digest('child-config'),
  maxModelCalls: 2, maxToolCalls: 3, settledUsageDigest: null });

test('a resumed foreground child blocks the next model without waiting for an unrelated running background child', () => {
  const { config, snapshot } = fixture({ childLifecyclePolicy: 'owned-background/v2' });
  const foreground = { ...reservation({ operationKey: 'foreground-op', call: call('fg', 'start_child') }), deliveryMode: 'foreground' };
  const background = { ...reservation({ operationKey: 'background-op', call: call('bg', 'start_child') }), childRunId: 'background' };
  const waiting = { ...snapshot, phase: 'preparing_context', childRunIds: ['child', 'background'], childBudgetReservations: [foreground, background] };
  const batch = prepareChildLifecycle(waiting, config), intent = batch.intents[0];
  const request = childLifecycleRequest(batch.snapshot, intent, new AbortController().signal);
  assert.equal(request.action, 'wait'); assert.deepEqual(request.waitForChildRunIds, ['child']);
  const terminal = { status: 'ok', content: 'Foreground evidence', childRunIds: ['child'], resourceUsage: { ...emptyUsage(), modelCalls: 1 },
    childBudgetSettlement: { childRunId: 'child', parentOperationKey: 'foreground-op', childRequestDigest: foreground.childRequestDigest,
      terminalSnapshotDigest: digest('sealed-child') } };
  const result = { operationKey: request.operationKey, results: [terminal], pendingChildRunIds: ['background'], approvals: [], errorCode: null };
  const completed = reduceChildLifecycle(batch.snapshot, config, request, result, digest);
  assert.equal(completed.phase, 'preparing_context'); assert.equal(completed.childLifecycleFailure, null);
  assert.ok(completed.childBudgetReservations[0].settledUsageDigest);
  assert.equal(completed.childBudgetReservations[1].settledUsageDigest, null);
  assert.equal(completed.descendantUsage.modelCalls, 1);
  assert.throws(() => reduceChildLifecycle(batch.snapshot, config, { ...request, waitForChildRunIds: ['background'] }, result, digest),
    /child_foreground_wait_identity_conflict/);
});

test('recovering a lost child collector observes pending children without declaring their wait failed or settling their budget', () => {
  const { config, snapshot } = fixture({ childLifecyclePolicy: 'owned-background/v2' });
  const allocation = reservation({ operationKey: 'start', call: call('start', 'start_child') });
  const waiting = { ...snapshot, phase: 'verifying', childRunIds: ['child'], childBudgetReservations: [allocation] };
  const batch = prepareChildLifecycle(waiting, config), intent = batch.intents[0];
  const request = childLifecycleRequest(batch.snapshot, intent, new AbortController().signal);
  assert.equal(request.action, 'wait');
  const observed = { operationKey: request.operationKey, results: [], pendingChildRunIds: ['child'], approvals: [], errorCode: null };
  const recovered = reduceChildLifecycle(batch.snapshot, config, request, observed, digest, { observationOnly: true });
  assert.equal(recovered.phase, 'verifying'); assert.equal(recovered.pendingIntent, null);
  assert.equal(recovered.childLifecycleFailure, null); assert.deepEqual(recovered.childBudgetReservations, [allocation]);
  const next = prepareChildLifecycle(recovered, config);
  assert.equal(next.intents[0].payload.action, 'wait'); assert.notEqual(next.intents[0].operationKey, intent.operationKey);
  assert.deepEqual(next.intents[0].payload.reservations, [allocation]);
  // Normal execution still must finish its selected wait. A real unavailable
  // receipt remains a failure even when discovered by recovery.
  assert.equal(reduceChildLifecycle(batch.snapshot, config, request, observed, digest).reason, 'background_children_unsettled');
  assert.equal(reduceChildLifecycle(batch.snapshot, config, request, { ...observed, errorCode: 'child_receipt_unavailable' }, digest,
    { observationOnly: true }).reason, 'child_receipt_unavailable');
});

for (const backend of ['memory', 'sqlite']) {
  test(`${backend}: cancellation and compaction cannot discard allocations; the store fences model claims`, t => {
    const dir = mkdtempSync(join(tmpdir(), 'native-child-budget-ledger-'));
    const store = backend === 'memory' ? new MemoryRunStore() : new SqliteRunStore(join(dir, 'run.sqlite'));
    t.after(() => { store.close?.(); rmSync(dir, { recursive: true, force: true }); });
    const { config, snapshot } = fixture({ limits: { maxModelCalls: 2 } });
    const allocation = reservation({ operationKey: 'parent-start', call: call('start', 'start_child') });
    const held = { ...snapshot, childBudgetReservations: [allocation], childRunIds: ['child'] };
    store.create(config, held);
    const lease = store.acquire(scope, 'run', 'worker', 10, 1000);
    for (const changes of [{ childBudgetReservations: [] }, { childRunIds: [] },
      { childBudgetReservations: [{ ...allocation, maxModelCalls: 1 }] }]) {
      assert.throws(() => store.commit(scope, 'run', lease, 20, 0, transition(held, changes)),
        /child_budget_reservation_is_immutable|child_run_ids_are_append_only/);
      assert.deepEqual(store.load(scope, 'run').snapshot, held);
    }
    const continuity = contextContinuity(held, config);
    assert.deepEqual(continuity.childBudgetReservations, [allocation]);
    assert.deepEqual(continuity.childRunIds, ['child']);
    const planned = prepareEffect(held, 'model', 'requesting_model', {});
    store.commit(scope, 'run', lease, 20, 0, planned);
    assert.throws(() => store.claim(scope, 'run', lease, 21, planned.snapshot.pendingIntent), { code: 'model_budget_exhausted' });
    assert.equal(store.load(scope, 'run').snapshot.usage.modelCalls, 0);
    assert.equal(store.load(scope, 'run').intents[0].status, 'prepared');
  });

  test(`${backend}: child reservation survives parent worker replacement; repeated collection charges actual usage once`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'native-child-budget-')), filename = join(dir, 'run.sqlite');
    let store = backend === 'memory' ? new MemoryRunStore() : new SqliteRunStore(filename);
    t.after(() => { store.close?.(); rmSync(dir, { recursive: true, force: true }); });
    const { config, snapshot } = fixture({ tools: childTools, limits: { maxModelCalls: 10, maxToolCalls: 12 } });
    let models = 0, starts = 0, collections = 0, allocated;
    const ports = { model: { generate: async () => {
      models++;
      if (models === 1) return response([call('start', 'start_child')]);
      if (models === 2) return response([call('collect-1', 'collect_child'), call('collect-2', 'collect_child')]);
      return response();
    } }, tools: { execute: async request => {
      if (request.call.name === 'start_child') {
        starts++;
        assert.deepEqual(request.budget, { maxModelCallsRemaining: 8, parentFinalizationReserved: true,
          maxToolCallsRemaining: 11, depth: 0, maxDepth: 3 });
        allocated = reservation(request);
        return { status: 'ok', content: { started: true }, childBudgetReservation: allocated };
      }
      collections++;
      assert.equal(request.budget.maxModelCallsRemaining, collections === 1 ? 5 : 6);
      return { status: 'ok', content: 'child complete', resourceUsage: { ...emptyUsage(), modelCalls: 1,
        toolCalls: 2, inputTokens: 11, outputTokens: 7, cachedInputTokens: 3, cost: 0.25 }, childRunIds: ['child'],
      childBudgetSettlement: { childRunId: 'child', parentOperationKey: allocated.parentOperationKey,
        childRequestDigest: allocated.childRequestDigest, terminalSnapshotDigest: digest('terminal-child') } };
    } } };
    let paused = false;
    const first = new NativeKernel({ store, ports, owner: 'worker-1', digest, onCheckpoint: async current => {
      if (!paused && current.childBudgetReservations.length) {
        paused = true;
        first.submit(scope, 'run', { commandId: 'pause-after-reservation', kind: 'pause', payload: {} });
      }
    } });
    first.start(snapshot, config);
    const held = await first.runUntilIdle(scope, 'run');
    assert.equal(held.phase, 'paused');
    assert.equal(held.childBudgetReservations.length, 1);
    assert.deepEqual(held.childRunIds, ['child']);
    assert.equal(modelRoom(held, config), 7);
    assert.equal(toolRoom(held, config), 8);
    if (backend === 'sqlite') { store.close(); store = new SqliteRunStore(filename); }
    const replacement = new NativeKernel({ store, ports, owner: 'worker-2', digest });
    replacement.submit(scope, 'run', { commandId: 'resume-parent', kind: 'resume', payload: {} });
    const final = await replacement.runUntilIdle(scope, 'run');
    assert.equal(final.phase, 'completed');
    assert.equal(starts, 1); assert.equal(collections, 2);
    assert.equal(final.usage.modelCalls, 3); assert.equal(final.usage.toolCalls, 3);
    assert.deepEqual(final.descendantUsage, { ...emptyUsage(), modelCalls: 1, toolCalls: 2,
      inputTokens: 11, outputTokens: 7, cachedInputTokens: 3, cost: 0.25 });
    assert.match(final.childBudgetReservations[0].settledUsageDigest, /^[0-9a-f]{64}$/);
    assert.equal(modelRoom(final, config), 6); assert.equal(toolRoom(final, config), 7);
  });

  test(`${backend}: an owner that exceeds its admitted allowance is interrupted without a second launch`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'native-child-budget-invalid-'));
    const store = backend === 'memory' ? new MemoryRunStore() : new SqliteRunStore(join(dir, 'run.sqlite'));
    t.after(() => { store.close?.(); rmSync(dir, { recursive: true, force: true }); });
    const { config, snapshot } = fixture({ tools: childTools, limits: { maxModelCalls: 4, maxToolCalls: 5 } });
    let starts = 0, models = 0;
    const kernel = new NativeKernel({ store, owner: 'worker', digest, ports: {
      model: { generate: async () => { models++; return response([call('start', 'start_child')]); } },
      tools: { execute: async request => {
        starts++;
        return { status: 'ok', content: {}, childBudgetReservation: { ...reservation(request), maxModelCalls: 3 } };
      } },
    } });
    kernel.start(snapshot, config);
    const result = await kernel.runUntilIdle(scope, 'run');
    assert.equal(result.phase, 'interrupted'); assert.equal(result.reason, 'effect_outcome_unknown');
    assert.equal(result.childBudgetReservations.length, 0);
    assert.equal(store.load(scope, 'run').receipts.at(-1).result.code, 'child_budget_start_exceeds_admission');
    assert.deepEqual(await kernel.runUntilIdle(scope, 'run'), result);
    assert.equal(starts, 1); assert.equal(models, 1);
  });
}
