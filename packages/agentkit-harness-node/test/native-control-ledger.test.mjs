import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteRunStore } from '../src/native/sqlite-store.mjs';
import { projectNativeRunObservation } from '../src/native/run-observation.mjs';
import { prepareEffect, runKey } from '@kingsoftcloud/agentkit-harness-core';
import { fixture, scope } from '../../agentkit-harness-core/test/fixtures.mjs';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'native-control-ledger-'));
  const file = join(root, 'runs.sqlite'), store = new SqliteRunStore(file), db = new DatabaseSync(file);
  t.after(async () => { db.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  const { config, snapshot } = fixture(); store.create(config, snapshot);
  const lease = store.acquire(scope, 'run', 'owner', 0, 1000);
  const batch = prepareEffect(snapshot, 'model', 'requesting_model', {});
  store.commit(scope, 'run', lease, 1, 0, batch);
  return { store, db, file, lease, batch, key: runKey(scope, 'run') };
}
const guide = { commandId: 'guide', kind: 'guide', payload: { text: 'Continue the original task.' } };

test('control transactions preserve full observation semantics for claims, commands and delivery cursors', async t => {
  const { store, lease, batch, file } = await setup(t);
  store.acknowledge(scope, 'run', 'sdk.position.with.dots', 0);
  assert.ok(Object.hasOwn(store.projectionCursors(scope, 'run'), 'sdk.position.with.dots'));
  store.claim(scope, 'run', lease, 2, batch.snapshot.pendingIntent);
  store.acknowledge(scope, 'run', 'display', batch.snapshot.eventSeq);
  store.enqueue(scope, 'run', guide);
  assert.deepEqual(store.observation(scope, 'run'), projectNativeRunObservation(store.load(scope, 'run')));
  const state = store.drivingState(scope, 'run');
  assert.equal(state.snapshot.usage.modelCalls, 1);
  assert.equal(state.pendingIntent.status, 'running');
  assert.deepEqual(state.pendingCommands, [guide]);
  assert.equal('receipts' in state, false); assert.equal('events' in state, false);
  state.pendingCommands[0].payload.text = 'forged'; state.pendingIntent.claimedFence = 100;
  assert.deepEqual(store.drivingState(scope, 'run').pendingCommands, [guide]);
  assert.equal(store.drivingState(scope, 'run').pendingIntent.claimedFence, lease.fence);
  const reader = new SqliteRunStore(file);
  try { assert.deepEqual(reader.drivingState(scope, 'run'), store.drivingState(scope, 'run')); }
  finally { reader.close(); }
});

test('historical receipt bodies are outside control transactions; missing observation migrates from original evidence', async t => {
  const { store, db, lease, batch, key } = await setup(t);
  db.prepare('INSERT INTO native_items VALUES (?,?,?,?)').run(key, 'receipts', 'old-evidence', 'NOT JSON');
  store.acknowledge(scope, 'run', 'display', batch.snapshot.eventSeq);
  store.claim(scope, 'run', lease, 2, batch.snapshot.pendingIntent);
  assert.equal(store.enqueue(scope, 'run', guide).status, 'accepted');
  assert.equal(store.enqueue(scope, 'run', guide).status, 'duplicate');
  assert.equal(store.drivingState(scope, 'run').pendingIntent.status, 'running');
  assert.throws(() => store.load(scope, 'run'), 'explicit reconciliation/audit still reads original evidence');
  const before = db.prepare('SELECT data FROM native_runs WHERE key=?').get(key).data;
  db.prepare('DELETE FROM native_run_observations WHERE run_key=?').run(key);
  assert.throws(() => store.acknowledge(scope, 'run', 'new-display', 0), 'cold migration cannot invent a view from corrupt original evidence');
  assert.equal(db.prepare('SELECT data FROM native_runs WHERE key=?').get(key).data, before);
});

test('control claims retain fencing, pending receipt and command checks', async t => {
  const { store, db, lease, batch, key } = await setup(t), operation = batch.snapshot.pendingIntent;
  assert.throws(() => store.claim(scope, 'run', lease, 1000, operation), { code: 'stale_fence' });
  assert.throws(() => store.claim(scope, 'run', lease, 2, 'foreign-operation'), { code: 'effect_already_claimed' });
  db.prepare('INSERT INTO native_items VALUES (?,?,?,?)').run(key, 'receipts', operation, 'unreadable-original-receipt');
  assert.throws(() => store.claim(scope, 'run', lease, 2, operation), { code: 'effect_already_claimed' });
  db.prepare("DELETE FROM native_items WHERE run_key=? AND collection='receipts'").run(key);
  store.enqueue(scope, 'run', { commandId: 'cancel', kind: 'cancel', payload: {} });
  assert.throws(() => store.claim(scope, 'run', lease, 2, operation), { code: 'pending_command_conflict' });
  assert.equal(store.drivingState(scope, 'run').snapshot.usage.modelCalls, 0);
  assert.throws(() => store.drivingState({ ...scope, userId: 'foreign' }, 'run'), { code: 'run_not_found' });
  assert.throws(() => store.acknowledge(scope, 'run', 'display', batch.snapshot.eventSeq + 1), { code: 'invalid_projection_cursor' });
  assert.throws(() => store.enqueue(scope, 'run', { commandId: 'cancel', kind: 'pause', payload: {} }), { code: 'command_replay_conflict' });
});

test('control write and display projection roll back atomically on SQLite failure', async t => {
  const { store, db, lease, batch, key } = await setup(t);
  const before = store.load(scope, 'run');
  db.exec(`CREATE TRIGGER reject_control_projection BEFORE UPDATE ON native_run_observations
    BEGIN SELECT RAISE(ABORT,'injected projection failure'); END;`);
  for (const action of [() => store.claim(scope, 'run', lease, 2, batch.snapshot.pendingIntent),
    () => store.enqueue(scope, 'run', guide), () => store.acknowledge(scope, 'run', 'display', 0)]) {
    assert.throws(action, /injected projection failure/);
    assert.deepEqual(store.load(scope, 'run'), before);
  }
  db.exec('DROP TRIGGER reject_control_projection');
  store.claim(scope, 'run', lease, 2, batch.snapshot.pendingIntent);
  const after = store.load(scope, 'run');
  assert.equal(after.snapshot.usage.modelCalls, 1);
  assert.deepEqual(after.receipts, before.receipts); assert.deepEqual(after.events, before.events);
  assert.equal(db.prepare('SELECT count(*) AS n FROM native_items WHERE run_key=? AND collection=?').get(key, 'receipts').n, 0);
});
