import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeKernel, MemoryRunStore, emptyUsage, modelRoom, toolRoom, transition, prepareEffect, contextContinuity } from '../dist/index.mjs';
import { SqliteRunStore } from '../../agentkit-harness/src/native/sqlite-store.mjs';
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
