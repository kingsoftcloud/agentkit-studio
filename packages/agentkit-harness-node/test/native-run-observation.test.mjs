import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteRunStore } from '../src/native/sqlite-store.mjs';
import { projectNativeRunObservation } from '../src/native/run-observation.mjs';
import { prepareEffect, runKey } from '@kingsoftcloud/agentkit-harness-core';
import { fixture, scope } from '../../agentkit-harness-core/test/fixtures.mjs';

async function setup(t, options) {
  const root = await mkdtemp(join(tmpdir(), 'native-observation-'));
  const file = join(root, 'runs.sqlite'), store = new SqliteRunStore(file, options);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const { config, snapshot } = fixture();store.create(config, snapshot);
  return { store, file, config, snapshot };
}

test('SQLite observation follows claims, live leases, acknowledgments and cold readers without exposing journals', async t => {
  const { store, file, config, snapshot } = await setup(t);
  const lease = store.acquire(scope, 'run', 'owner', 0, 1000);
  const prepared = prepareEffect(snapshot, 'model', 'requesting_model', {});
  store.commit(scope, 'run', lease, 1, 0, prepared);
  const before = store.observation(scope, 'run');
  assert.equal(store.sessionHeadView(scope, snapshot.sessionId).runId, 'run');
  assert.equal(store.sessionHeadView(scope, snapshot.sessionId).messages, undefined);
  assert.equal(before.facts.pendingEffect.status, 'prepared');assert.equal(before.snapshot.usage.modelCalls, 0);
  store.claim(scope, 'run', lease, 2, prepared.snapshot.pendingIntent);
  const claimed = store.observation(scope, 'run');
  assert.equal(claimed.snapshot.revision, before.snapshot.revision, 'claim does not increment revision');
  assert.equal(claimed.snapshot.usage.modelCalls, 1);assert.equal(claimed.facts.pendingEffect.status, 'running');
  const renewed = store.renew(scope, 'run', lease, 3, 2000);
  store.acknowledge(scope, 'run', 'display', prepared.snapshot.eventSeq);
  assert.equal(store.observation(scope, 'run').lease.expiresAt, renewed.expiresAt);
  assert.equal(store.observation(scope, 'run').projections.display, prepared.snapshot.eventSeq);
  for (const key of ['configuration', 'intents', 'receipts', 'events', 'commands', 'commits']) assert.equal(claimed[key], undefined);
  for (const key of ['messages', 'preparedContext', 'contextState']) assert.equal(claimed.snapshot[key], undefined);
  assert.equal(claimed.facts.pendingEffect.payload, undefined);
  claimed.facts.toolNames.push('forged');assert.deepEqual(store.observation(scope, 'run').facts.toolNames, config.tools.map(t => t.name));
  const reader = new SqliteRunStore(file);try { assert.deepEqual(reader.observation(scope, 'run'), store.observation(scope, 'run')); }
  finally { reader.close(); }
  assert.throws(() => store.observation({ ...scope, agentId: 'foreign' }, 'run'), { code: 'run_not_found' });
});

test('cached observation does not hydrate receipts; old ledgers rebuild once and keep authority separate', async t => {
  const { store, file } = await setup(t), key = runKey(scope, 'run');
  const expected = store.observation(scope, 'run'), db = new DatabaseSync(file);
  try {
    db.prepare('DELETE FROM native_run_observations WHERE run_key=?').run(key);
    assert.deepEqual(store.observation(scope, 'run'), expected, 'lazy backfill from complete old ledger');
    db.prepare('INSERT INTO native_items VALUES (?,?,?,?)').run(key, 'receipts', 'broken', 'NOT JSON');
    assert.deepEqual(store.observation(scope, 'run'), expected, 'warm view reads no receipts');
    assert.deepEqual(store.uncertainToolCalls(scope, 'session'), [], 'session polling also avoids unrelated receipt data');
    assert.throws(() => store.load(scope, 'run'), 'execution still reads its original journal');
    db.prepare('DELETE FROM native_run_observations WHERE run_key=?').run(key);
    assert.throws(() => store.observation(scope, 'run'), 'missing view cannot be invented from corrupt authority');
    assert.equal(db.prepare('SELECT count(*) AS n FROM native_run_observations').get().n, 0);
    db.prepare("DELETE FROM native_items WHERE run_key=? AND item_key='broken'").run(key);
    assert.deepEqual(store.observation(scope, 'run'), expected);
  } finally { db.close(); }
});

test('uncertain-call read model honors latest reconciled facts, lost replies and principal boundaries', async t => {
  const { store, file } = await setup(t), db = new DatabaseSync(file), key = runKey(scope, 'run');
  try {
    for (const callId of ['reconciled', 'lost']) {
      db.prepare('INSERT INTO native_items VALUES (?,?,?,?)').run(key, 'intents', callId, JSON.stringify({
        operationKey: callId, kind: 'tool', status: 'running', payload: { calls: [{ callId, name: 'read', arguments: {} }] } }));
      db.prepare('INSERT INTO native_items VALUES (?,?,?,?)').run(key, 'receipts', callId, JSON.stringify({
        operationKey: callId, status: 'uncertain', result: { code: 'effect_outcome_unknown' } }));
    }
    for (const [seq, status] of [[1, 'uncertain'], [2, 'ok']]) db.prepare('INSERT INTO native_events VALUES (?,?,?,?)')
      .run(key, seq, 'event-' + seq, JSON.stringify({ seq, eventId: 'event-' + seq, kind: 'tool.completed', payload: { callId: 'reconciled', status } }));
    db.prepare('DELETE FROM native_run_observations WHERE run_key=?').run(key);
    assert.deepEqual(store.uncertainToolCalls(scope, 'session'), [{ runId: 'run', turnId: 'turn', callId: 'lost' }]);
    const originalView = db.prepare('SELECT data FROM native_run_observations WHERE run_key=?').get(key).data;
    db.prepare("UPDATE native_run_observations SET data=json_set(data,'$.snapshot.sessionId','foreign-session') WHERE run_key=?").run(key);
    assert.throws(() => store.uncertainToolCalls(scope, 'session'), { code: 'observation_identity_mismatch' });
    db.prepare('UPDATE native_run_observations SET data=? WHERE run_key=?').run(originalView, key);
    assert.deepEqual(store.uncertainToolCalls(scope, 'foreign-session'), []);
    assert.deepEqual(store.uncertainToolCalls({ ...scope, userId: 'foreign-user' }, 'session'), []);
    db.prepare('UPDATE native_items SET data=? WHERE run_key=? AND collection=? AND item_key=?').run('NOT JSON', key, 'receipts', 'lost');
    assert.deepEqual(store.uncertainToolCalls(scope, 'session'), [{ runId: 'run', turnId: 'turn', callId: 'lost' }]);
  } finally { db.close(); }
});

test('ledger and materialized observation roll back together on a failed commit', async t => {
  let fail = false;
  const { store, snapshot } = await setup(t, { beforeCommit: () => { if (fail) throw Error('injected'); } });
  const lease = store.acquire(scope, 'run', 'owner', 0, 1000);
  const before = store.observation(scope, 'run'), batch = prepareEffect(snapshot, 'model', 'requesting_model', {});
  fail = true;
  assert.throws(() => store.commit(scope, 'run', lease, 1, 0, batch), /injected/);
  assert.deepEqual(store.observation(scope, 'run'), before);assert.equal(store.load(scope, 'run').snapshot.revision, 0);
  fail = false;store.commit(scope, 'run', lease, 2, 0, batch);
  assert.equal(store.observation(scope, 'run').snapshot.revision, 1);
});

test('scoped session outcome facts retain non-dispatch without reading historical receipt bodies after migration', async t => {
  const { store, file } = await setup(t), db = new DatabaseSync(file), key = runKey(scope, 'run');
  try {
    db.prepare('INSERT INTO native_events VALUES (?,?,?,?)').run(key, 1, 'not-dispatched', JSON.stringify({
      seq: 1, eventId: 'not-dispatched', kind: 'tool.not_dispatched', payload: { callId: 'proposed', name: 'browser', reason: 'browser_context_invalidated' } }));
    const value = db.prepare('SELECT data FROM native_run_observations WHERE run_key=?').get(key).data;
    db.prepare("UPDATE native_run_observations SET data=json_remove(?,'$.facts.toolOutcomes') WHERE run_key=?").run(value, key);
    assert.deepEqual(store.sessionToolOutcomes(scope, 'session'), [{ runId: 'run', turnId: 'turn', callId: 'proposed', status: 'not_dispatched' }]);
    assert.equal(store.observation(scope, 'run').facts.toolStates.idle.calls[0].status, 'not_dispatched');
    assert.deepEqual(store.uncertainToolCalls(scope, 'session'), []);
    db.prepare('INSERT INTO native_items VALUES (?,?,?,?)').run(key, 'receipts', 'unrelated', 'NOT JSON');
    assert.equal(store.sessionToolOutcomes(scope, 'session')[0].status, 'not_dispatched');
    assert.deepEqual(store.sessionToolOutcomes({ ...scope, userId: 'foreign' }, 'session'), []);
  } finally { db.close(); }
});

test('projection retains display facts while omitting transcript, tool output, replay and invocation parameters', async t => {
  const { store } = await setup(t), record = store.load(scope, 'run');
  record.snapshot.messages.push({ role: 'user', content: 'PRIVATE_TRANSCRIPT', media: [{ image: 'PRIVATE_PIXELS' }] });
  record.intents.push({ operationKey: 'op', kind: 'tool', status: 'running', payload: {
    calls: [{ callId: 'c', name: 'read', arguments: { secret: 'PRIVATE_ARGUMENT' } }] } });
  record.receipts.push({ operationKey: 'op', status: 'committed', result: { results: [
    { status: 'error', content: { private: 'PRIVATE_OUTPUT' } }] } });
  const view = projectNativeRunObservation(record);
  assert.doesNotMatch(JSON.stringify(view), /PRIVATE_TRANSCRIPT|PRIVATE_PIXELS|PRIVATE_ARGUMENT|PRIVATE_OUTPUT/);
  assert.deepEqual(view.facts.toolStates.idle.calls.map(c => c.status), ['failed']);
  assert.equal(view.facts.controlHints.closeReadInterruption, false);
});
