import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { MemoryRunStore, prepareEffect } from '../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { fixture, scope } from './fixtures.mjs';

for (const backend of ['memory', 'sqlite']) test(`${backend}: authority is atomic, detached and follows lease takeover without an audit-history dependency`, t => {
  const root = mkdtempSync(join(tmpdir(), 'authority-view-')), filename = join(root, 'runs.sqlite');
  const store = backend === 'sqlite' ? new SqliteRunStore(filename) : new MemoryRunStore();
  t.after(() => { store.close?.(); rmSync(root, { recursive: true, force: true }); });
  const { config, snapshot } = fixture(); store.create(config, snapshot);
  const lease = store.acquire(scope, 'run', 'first', 10, 100);
  const prepared = prepareEffect(snapshot, 'tool', 'executing_tools', { calls: [{ callId: 'read', name: 'read', arguments: {} }] });
  store.commit(scope, 'run', lease, 20, 0, prepared);
  store.claim(scope, 'run', lease, 21, prepared.snapshot.pendingIntent);
  store.acknowledge(scope, 'run', 'sdk-position', prepared.snapshot.eventSeq);
  if (backend === 'sqlite') {
    // If authority accidentally materializes the audit journal this malformed
    // unrelated historical payload will fail decoding. It is never live authority.
    const db = new DatabaseSync(filename);
    const key = db.prepare('SELECT key FROM native_runs').get().key;
    db.prepare('INSERT INTO native_items VALUES (?,?,?,?)').run(key, 'receipts', 'old-audit-page', 'not-json');
    db.close();
  }
  const current = store.authority(scope, 'run');
  const positions = store.projectionCursors(scope, 'run');
  assert.equal(positions['sdk-position'], prepared.snapshot.eventSeq);
  positions['sdk-position'] = 999;
  assert.equal(store.projectionCursors(scope, 'run')['sdk-position'], prepared.snapshot.eventSeq);
  assert.throws(() => store.projectionCursors({ ...scope, userId: 'foreign' }, 'run'), { code: 'run_not_found' });
  assert.equal(current.pendingIntent.operationKey, prepared.snapshot.pendingIntent);
  assert.equal(current.pendingIntent.status, 'running');
  assert.equal(current.pendingIntent.claimedFence, lease.fence);
  assert.equal('receipts' in current, false); assert.equal('events' in current, false);
  current.pendingIntent.claimedFence = 999; current.lease.fence = 999; current.snapshot.goal = 'forged';
  assert.equal(store.authority(scope, 'run').lease.fence, 1);
  const next = store.acquire(scope, 'run', 'second', 111, 100);
  assert.equal(store.authority(scope, 'run').lease.fence, next.fence);
  assert.equal(store.authority(scope, 'run').pendingIntent.claimedFence, lease.fence);
  assert.throws(() => store.authority({ ...scope, userId: 'foreign' }, 'run'), { code: 'run_not_found' });
});
