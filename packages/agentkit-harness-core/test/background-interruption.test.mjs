import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeKernel, MemoryRunStore, emptyUsage, reviewableBackgroundInterruption,
  reviewedBackgroundInterruption, BACKGROUND_COMMAND_CONTRACT } from '../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { fixture, tool, scope, digest } from './fixtures.mjs';

async function interrupted(t, sqlite) {
  const directory = mkdtempSync(join(tmpdir(), 'native-background-review-')), file = join(directory, 'runs.sqlite');
  let store = sqlite ? new SqliteRunStore(file) : new MemoryRunStore();
  t.after(() => { store.close?.(); rmSync(directory, { recursive: true, force: true }); });
  const { config, snapshot } = fixture({ tools: [tool({ name: 'run_command', readOnly: false,
    concurrentSafe: false, backgroundCommandPolicy: 'owned-command-launch/v1' })],
  backgroundNotificationPolicy: 'completed-before-model/v1' });
  let models = 0, launches = 0;
  const kernel = new NativeKernel({ store, digest, owner: 'test', ports: {
    model: { generate: async () => { assert.equal(++models, 1); return { kind: 'tool_calls', text: '', usage: emptyUsage(),
      toolCalls: [{ callId: 'launch', name: 'run_command', arguments: {} }] }; } },
    tools: { execute: async request => { launches++; return { status: 'ok', content: {}, backgroundCommandRef: {
      taskId: 'a'.repeat(64), sourceRunId: request.runId, operationKey: request.operationKey } }; } },
    background: { contract: BACKGROUND_COMMAND_CONTRACT, observe: async request => request.refs.map(ref => ({ ref, status: 'unknown' })) },
  } });
  store.create(config, snapshot); await kernel.runUntilIdle(scope, 'run');
  assert.equal(models, 1); assert.equal(launches, 1);
  return { get store() { return store; }, reopen() { if (sqlite) { store.close(); store = new SqliteRunStore(file); } },
    review: { contract: 'agentkit.background-interruption-review/v1', commandId: 'operator-1',
      eventSeq: store.load(scope, 'run').snapshot.eventSeq, confirmedStopped: true } };
}

for (const sqlite of [false, true]) {
  test(`${sqlite ? 'SQLite' : 'memory'}: operator review survives reopen without changing the terminal verdict or effect journal`, async t => {
    const host = await interrupted(t, sqlite), before = host.store.load(scope, 'run');
    assert.equal(reviewableBackgroundInterruption(before), true);
    assert.equal(reviewedBackgroundInterruption(before), false);
    host.store.reviewBackgroundInterruption(scope, 'run', host.review, Date.now()); host.reopen();
    const after = host.store.load(scope, 'run');
    assert.deepEqual(after, { ...before, backgroundInterruptionReview: host.review });
    assert.equal(reviewedBackgroundInterruption(after), true);
    host.store.reviewBackgroundInterruption(scope, 'run', host.review, Date.now());
    assert.deepEqual(host.store.load(scope, 'run'), after);
    assert.throws(() => host.store.reviewBackgroundInterruption(scope, 'run', { ...host.review, commandId: 'different' }, Date.now()), { code: 'command_replay_conflict' });
  });
  test(`${sqlite ? 'SQLite' : 'memory'}: stale, foreign, active-owner and unconfirmed reviews grant no release`, async t => {
    const host = await interrupted(t, sqlite), before = host.store.load(scope, 'run');
    for (const review of [{ ...host.review, eventSeq: host.review.eventSeq - 1 }, { ...host.review, confirmedStopped: false },
      { ...host.review, extra: 'authority' }]) assert.throws(() => host.store.reviewBackgroundInterruption(scope, 'run', review, Date.now()));
    assert.throws(() => host.store.reviewBackgroundInterruption({ ...scope, userId: 'other' }, 'run', host.review, Date.now()), { code: 'run_not_found' });
    const lease = host.store.acquire(scope, 'run', 'other-owner', Date.now(), 30_000);
    assert.throws(() => host.store.reviewBackgroundInterruption(scope, 'run', host.review, Date.now()), { code: 'background_interruption_still_owned' });
    host.store.release(scope, 'run', lease);
    assert.deepEqual(host.store.load(scope, 'run').snapshot, before.snapshot);
    assert.equal(host.store.load(scope, 'run').backgroundInterruptionReview, undefined);
  });
}

test('review cannot forgive unknown writes, missing receipts, descendants, foreign handles or unobserved commands', async t => {
  const host = await interrupted(t, false), record = host.store.load(scope, 'run');
  const changed = change => { const copy = structuredClone(record); change(copy); return copy; };
  for (const item of [
    changed(r => { r.receipts.find(x => x.result.results)?.result.results.push({ status: 'uncertain' }); }),
    changed(r => { r.receipts = r.receipts.filter(x => x.operationKey !== r.snapshot.backgroundCommands[0].ref.operationKey); }),
    changed(r => { r.snapshot.backgroundCommands[0].notified = false; }),
    changed(r => { r.snapshot.children.push({ state: 'running' }); }),
    changed(r => { r.snapshot.childBudgetReservations.push({ settledUsageDigest: null }); }),
    changed(r => { r.snapshot.pendingIntent = 'in-flight'; }),
    changed(r => { r.snapshot.runId = 'different'; }),
  ]) assert.equal(reviewableBackgroundInterruption(item), false);
});
