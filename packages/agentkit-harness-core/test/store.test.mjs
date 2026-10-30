import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MemoryRunStore, transition, prepareEffect, reduceCommand, canonical } from '../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { fixture, scope } from './fixtures.mjs';

for (const backend of ['memory', 'sqlite']) {
  const setup = t => {
    const dir = mkdtempSync(join(tmpdir(), 'native-ledger-'));
    const filename = join(dir, 'run.sqlite');
    const store = backend === 'memory' ? new MemoryRunStore() : new SqliteRunStore(filename);
    t.after(() => { store.close?.(); rmSync(dir, { recursive: true, force: true }); });
    const { config, snapshot } = fixture();
    store.create(config, snapshot);
    return { store, filename, config, snapshot, lease: store.acquire(scope, 'run', 'worker', 10, 100) };
  };
  test(`${backend}: lease fences all writes and takeover cannot claim a running effect`, t => {
    const { store, snapshot, lease } = setup(t);
    assert.throws(() => store.acquire(scope, 'run', 'other', 20, 100), { code: 'lease_busy' });
    const batch = prepareEffect(snapshot, 'tool', 'executing_tools', { name: 'write' });
    store.commit(scope, 'run', lease, 20, 0, batch);
    store.claim(scope, 'run', lease, 20, batch.snapshot.pendingIntent);
    const next = store.acquire(scope, 'run', 'other', 111, 100);
    assert.equal(next.fence, 2);
    assert.throws(() => store.commit(scope, 'run', lease, 112, 0, batch), { code: 'stale_fence' });
    assert.throws(() => store.claim(scope, 'run', next, 112, batch.snapshot.pendingIntent), { code: 'effect_already_claimed' });
    assert.throws(() => store.release(scope, 'run', lease), { code: 'stale_fence' });
  });
  test(`${backend}: atomic receipt, snapshot and events; identical commit replay only`, t => {
    const { store, snapshot, lease } = setup(t);
    const intent = prepareEffect(snapshot, 'model', 'requesting_model', {});
    const started = store.commit(scope, 'run', lease, 20, 0, intent);
    assert.equal(started.usage.modelCalls, 0);
    store.claim(scope, 'run', lease, 21, started.pendingIntent);
    const claimed = store.load(scope, 'run').snapshot;
    assert.equal(claimed.usage.modelCalls, 1);
    const done = transition(claimed, { phase: 'verifying', pendingIntent: null }, [{ kind: 'model.completed', payload: { text: 'done' } }],
      { receipts: [{ operationKey: started.pendingIntent, status: 'committed', result: { kind: 'final_candidate' } }] });
    const saved = store.commit(scope, 'run', lease, 22, 1, done);
    assert.deepEqual(store.commit(scope, 'run', lease, 23, 1, done), saved);
    assert.throws(() => store.commit(scope, 'run', lease, 24, 1, { ...done, snapshot: { ...done.snapshot, finalText: 'different' } }), { code: 'commit_replay_conflict' });
    const data = store.load(scope, 'run');
    assert.equal(data.receipts.length, 1);
    assert.deepEqual(data.events.map(event => event.seq), [1, 2]);
    assert.equal(data.snapshot.revision, 2);
  });
  test(`${backend}: invalid batches cannot partially mutate the ledger`, t => {
    const { store, snapshot, lease } = setup(t);
    const batch = transition(snapshot, { phase: 'preparing_context' }, [{ kind: 'run.started', payload: {} }],
      { receipts: [{ operationKey: 'missing', status: 'committed', result: {} }] });
    assert.throws(() => store.commit(scope, 'run', lease, 20, 0, batch), { code: 'receipt_without_claim' });
    assert.equal(store.load(scope, 'run').snapshot.revision, 0);
    assert.deepEqual(store.events(scope, 'run'), []);
    const valid = transition(snapshot, { phase: 'preparing_context' });
    valid.snapshot.buildId = 'other';
    assert.throws(() => store.commit(scope, 'run', lease, 20, 0, valid), { code: 'run_identity_changed' });
  });
  test(`${backend}: commands are scoped, durable, deduplicated and cancellation wins finalization`, t => {
    const { store, snapshot, lease } = setup(t);
    const command = { commandId: 'cancel-1', kind: 'cancel', payload: {} };
    assert.equal(store.enqueue(scope, 'run', command).status, 'accepted');
    assert.equal(store.enqueue(scope, 'run', command).status, 'duplicate');
    assert.throws(() => store.enqueue(scope, 'run', { ...command, kind: 'pause' }), { code: 'command_replay_conflict' });
    const completed = transition(snapshot, { phase: 'completed', outcome: 'unverified' });
    assert.throws(() => store.commit(scope, 'run', lease, 20, 0, completed), { code: 'pending_command_conflict' });
    const canceled = store.commit(scope, 'run', lease, 20, 0, reduceCommand(snapshot, command));
    assert.equal(canceled.phase, 'canceled');
    assert.equal(store.enqueue(scope, 'run', { ...command, commandId: 'late' }).status, 'rejected');
    assert.throws(() => store.load({ ...scope, userId: 'other' }, 'run'), { code: 'run_not_found' });
    assert.throws(() => store.commit(scope, 'run', lease, 21, 1, { ...completed, commitId: 'late-terminal-change' }), { code: 'terminal_immutable' });
  });
  test(`${backend}: detached snapshots cannot mutate stored authority or projection cursors`, t => {
    const { store, snapshot, lease } = setup(t);
    const saved = store.commit(scope, 'run', lease, 20, 0,
      transition(snapshot, { phase: 'preparing_context' }, [{ kind: 'run.started', payload: {} }]));
    saved.scope.agentId = 'other';
    store.load(scope, 'run').configuration.tools.push({ name: 'injected' });
    assert.equal(store.load(scope, 'run').configuration.tools.length, 0);
    store.acknowledge(scope, 'run', 'dsh', 1);
    assert.throws(() => store.acknowledge(scope, 'run', 'dsh', 0), { code: 'invalid_projection_cursor' });
    assert.throws(() => store.acknowledge(scope, 'run', 'dsh', 2), { code: 'invalid_projection_cursor' });
    assert.equal(store.load(scope, 'run').snapshot.scope.agentId, 'agent');
  });
  test(`${backend}: discovery heads are scoped, detached and exclude transcript payloads`, t => {
    const { store, config, snapshot, lease } = setup(t);
    const foreign = { ...scope, agentId: 'other-agent' };
    store.create(config, { ...snapshot, scope: foreign });
    const batch = transition(snapshot, { phase: 'preparing_context', messages: [...snapshot.messages,
      { role: 'user', content: 'large private observation '.repeat(20000) },
    ] });
    store.commit(scope, 'run', lease, 20, 0, batch);
    const heads = store.listHeads(scope);
    assert.equal(heads.length, 1); assert.deepEqual(heads[0].scope, scope);
    assert.equal(heads[0].lease.fence, lease.fence);
    assert.equal('messages' in heads[0], false); assert.equal('configuration' in heads[0], false);
    assert.ok(JSON.stringify(heads).length < 2000);
    assert.deepEqual(store.listHeads(scope, 'other-session'), []);
    assert.deepEqual(store.list(scope).map(row => row.scope), [scope]);
    heads[0].scope.agentId = 'changed'; heads[0].lease.fence = 999;
    assert.deepEqual(store.listHeads(scope)[0].scope, scope);
    assert.equal(store.listHeads(scope)[0].lease.fence, lease.fence);
    assert.deepEqual(store.listHeads(foreign).map(row => row.scope), [foreign]);
  });
}
test('SQLite: legacy commit fingerprints compact on reopen and retain replay conflict detection', t => {
  const dir = mkdtempSync(join(tmpdir(), 'native-legacy-commit-')), filename = join(dir, 'run.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { config, snapshot } = fixture(), store = new SqliteRunStore(filename);
  store.create(config, snapshot);
  const lease = store.acquire(scope, 'run', 'worker', 10, 100);
  const batch = transition(snapshot, { phase: 'preparing_context' }, [{ kind: 'run.started', payload: { text: 'x'.repeat(100_000) } }]);
  store.commit(scope, 'run', lease, 20, 0, batch);
  store.close();
  const db = new DatabaseSync(filename);
  const row = db.prepare("SELECT rowid,data FROM native_items WHERE collection='commits'").get();
  const legacy = JSON.parse(row.data); legacy.fingerprint = canonical(batch);
  db.prepare('UPDATE native_items SET data=? WHERE rowid=?').run(JSON.stringify(legacy), row.rowid);
  db.exec('UPDATE native_schema SET version=1'); db.close();
  const reopened = new SqliteRunStore(filename); t.after(() => reopened.close());
  const compact = reopened.load(scope, 'run').commits[0];
  assert.match(compact.fingerprint, /^sha256\/v1:[0-9a-f]{64}$/);
  assert.equal(reopened.commit(scope, 'run', lease, 21, 0, batch).revision, 1);
  assert.throws(() => reopened.commit(scope, 'run', lease, 22, 0, { ...batch, events: [] }), { code: 'commit_replay_conflict' });
  const check = new DatabaseSync(filename, { readOnly: true });
  assert.equal(check.prepare('SELECT version FROM native_schema').get().version, 2);
  assert.ok(check.prepare("SELECT length(data) AS n FROM native_items WHERE collection='commits'").get().n < 1000);
  check.close();
});
test('SQLite: reopened instances retain claims and events; stale revisions have one winner', t => {
  const dir = mkdtempSync(join(tmpdir(), 'native-reopen-')), filename = join(dir, 'run.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { config, snapshot } = fixture();
  const first = new SqliteRunStore(filename);
  first.create(config, snapshot);
  const lease = first.acquire(scope, 'run', 'one', 1, 100);
  const batch = prepareEffect(snapshot, 'tool', 'executing_tools', { name: 'write' });
  first.commit(scope, 'run', lease, 2, 0, batch);
  first.claim(scope, 'run', lease, 3, batch.snapshot.pendingIntent);
  first.close();
  const second = new SqliteRunStore(filename), third = new SqliteRunStore(filename);
  t.after(() => { second.close(); third.close(); });
  assert.equal(second.load(scope, 'run').intents[0].status, 'running');
  const replacement = second.acquire(scope, 'run', 'two', 102, 100);
  const canceled = reduceCommand(batch.snapshot, { commandId: 'cancel', kind: 'cancel', payload: {} });
  second.enqueue(scope, 'run', { commandId: 'cancel', kind: 'cancel', payload: {} });
  second.commit(scope, 'run', replacement, 103, 1, canceled);
  assert.throws(() => third.commit(scope, 'run', lease, 103, 1, canceled), { code: 'stale_fence' });
  assert.equal(third.load(scope, 'run').snapshot.phase, 'canceled');
});
test('SQLite: database failure after writes rolls back the whole commit without rewriting historical events', t => {
  const dir = mkdtempSync(join(tmpdir(), 'native-rollback-')), filename = join(dir, 'run.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let crash = false;
  const store = new SqliteRunStore(filename, { beforeCommit: () => { if (crash) throw new Error('injected failure'); } });
  t.after(() => store.close());
  const { config, snapshot } = fixture();
  store.create(config, snapshot);
  const lease = store.acquire(scope, 'run', 'one', 1, 100);
  const first = store.commit(scope, 'run', lease, 2, 0, transition(snapshot, { phase: 'preparing_context' }, [{ kind: 'first', payload: {} }]));
  const db = new DatabaseSync(filename);
  db.exec("CREATE TRIGGER immutable_events BEFORE UPDATE ON native_events BEGIN SELECT RAISE(ABORT,'history rewritten'); END");
  db.close();
  crash = true;
  const batch = prepareEffect(first, 'tool', 'executing_tools', { name: 'write' });
  assert.throws(() => store.commit(scope, 'run', lease, 3, 1, batch), /injected failure/);
  assert.equal(store.load(scope, 'run').snapshot.revision, 1);
  assert.equal(store.load(scope, 'run').intents.length, 0);
  crash = false;
  store.commit(scope, 'run', lease, 3, 1, batch);
  assert.equal(store.events(scope, 'run').length, 2);
});
