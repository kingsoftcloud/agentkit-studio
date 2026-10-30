import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteRunStore } from '../src/native/sqlite-store.mjs';
import { fixture } from '../../agentkit-harness-core/test/fixtures.mjs';

test('cold SQLite recovery discovers distinct original scopes within the Host principal', t => {
  const root = mkdtempSync(join(tmpdir(), 'native-recovery-scopes-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const filename = join(root, 'runs.sqlite'), { config, snapshot } = fixture();
  const principal = { tenantId: 'tenant', workspaceId: 'workspace', userId: 'user' };
  let store = new SqliteRunStore(filename);
  try {
    for (const [index, scope] of [snapshot.scope, snapshot.scope, { ...snapshot.scope, agentId: 'deleted-agent' },
      { ...snapshot.scope, tenantId: 'other' }, { ...snapshot.scope, workspaceId: 'other' },
      { ...snapshot.scope, userId: 'other' }].entries()) {
      store.create(config, { ...structuredClone(snapshot), scope, runId: `run-${index}`, sessionId: `session-${index}` });
    }
    store.close(); store = new SqliteRunStore(filename);
    const rows = store.listScopes(principal);
    assert.deepEqual(rows, [snapshot.scope, { ...snapshot.scope, agentId: 'deleted-agent' }]);
    assert.equal(rows.length, 2, 'multiple Runs must not cause duplicate scans');
    rows[0].agentId = 'mutated';
    assert.equal(store.listScopes(principal)[0].agentId, 'agent');
    assert.deepEqual(store.listScopes({ ...principal, userId: 'absent' }), []);
    assert.deepEqual(Object.keys(store.listScopes(principal)[0]).sort(), ['agentId', 'tenantId', 'userId', 'workspaceId']);
  } finally { store.close(); }
});

test('scope discovery rejects incomplete, extra and closed principals', () => {
  const store = new SqliteRunStore(':memory:');
  try {
    const principal = { tenantId: 'tenant', workspaceId: 'workspace', userId: 'user' };
    for (const value of [null, [], {}, { ...principal, agentId: '*' }, { ...principal, userId: ' ' }]) {
      assert.throws(() => store.listScopes(value), { code: 'invalid_recovery_principal' });
    }
    assert.deepEqual(store.listScopes(principal), []);
    store.close();
    assert.throws(() => store.listScopes(principal), { code: 'store_closed' });
  } finally { store.close(); }
});
