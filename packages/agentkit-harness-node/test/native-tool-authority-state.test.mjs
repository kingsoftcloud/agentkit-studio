import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MemoryRunStore, prepareEffect, runKey, projectRunToolAuthority } from '@kingsoftcloud/agentkit-harness-core';
import { SqliteRunStore } from '../src/native/sqlite-store.mjs';
import { createNativeToolAuthority, createNativeToolAuthorityReader } from '../src/native/tool-authority.mjs';
import { fixture, scope, digest, tool } from '../../agentkit-harness-core/test/fixtures.mjs';

function setup(t, sqlite, modelSurface = false) {
  const root = mkdtempSync(join(tmpdir(), 'native-tool-authority-')), file = join(root, 'runs.sqlite');
  const store = sqlite ? new SqliteRunStore(file) : new MemoryRunStore();
  t.after(() => { store.close?.(); rmSync(root, { recursive: true, force: true }); });
  const definition = tool(), call = { callId: 'original', name: definition.name, arguments: {} };
  const { config, snapshot } = fixture({ tools: [definition], ...(modelSurface ? { modelSurface: {
    contract: 'bound-model-surface/v1', environment: { workspaceRoot: '/work', cwd: '/work', platform: 'linux',
      date: '2026-10-29', commandBackend: 'local_process', commandCwd: '/work', environmentNames: ['PATH'], supportsImages: true },
  } } : {}) });
  store.create(config, snapshot);
  const lease = store.acquire(scope, 'run', 'owner', Date.now(), 30000);
  const batch = prepareEffect(snapshot, 'tool', 'executing_tools', { calls: [call], interaction: null });
  store.commit(scope, 'run', lease, Date.now(), 0, batch); store.claim(scope, 'run', lease, Date.now(), batch.snapshot.pendingIntent);
  const request = { scope, runId: 'run', sessionId: 'session', turnId: 'turn', buildId: 'build', parentRunId: null, taskChainId: 'chain',
    signal: new AbortController().signal, executionFence: lease.fence, operationKey: batch.snapshot.pendingIntent,
    call, definition, interaction: null };
  return { store, request, file, lease };
}

for (const sqlite of [false, true]) for (const modelSurface of [false, true]) test(`${sqlite ? 'SQLite' : 'memory'} tool authority keeps exact dispatch checks without exposing history (${modelSurface ? 'split' : 'legacy'} observation)`, t => {
  const { store, request, lease } = setup(t, sqlite, modelSurface), read = createNativeToolAuthorityReader({ store, scope, sessionId: 'session' });
  const allow = createNativeToolAuthority({ store, scope, sessionId: 'session' });
  const view = store.toolAuthority(scope, 'run');
  assert.deepEqual(view, projectRunToolAuthority(store.authority(scope, 'run')));
  assert.equal(allow(request), true); assert.equal(read(request).pendingIntent.claimedFence, lease.fence);
  assert.equal(view.snapshot.messages, undefined); assert.equal(view.configuration.inputMessages, undefined);
  assert.equal(view.configuration.modelSurface, undefined); assert.equal(view.splitModelObservation, modelSurface);
  assert.equal(view.receipts, undefined); assert.equal(view.events, undefined); assert.equal(view.sourceReadMessage, null);
  view.snapshot.phase = 'failed'; view.configuration.tools[0].description = 'caller mutation';
  assert.equal(allow(request), true, 'detached projection cannot mutate ledger authority');
  for (const changed of [{ executionFence: lease.fence + 1 }, { operationKey: 'other' }, { buildId: 'other' },
    { sessionId: 'other' }, { scope: { ...scope, userId: 'other' } }, { call: { ...request.call, arguments: { injected: true } } },
    { definition: { ...request.definition, description: 'changed schema' } }, { planMode: 'session-plan/v1' },
    { resultGovernance: 'runtime-artifacts/v1' }, { sourceReadBudget: { maxSourceUnits: 999999 } }]) {
    assert.equal(read({ ...request, ...changed }), null); assert.equal(allow({ ...request, ...changed }), false);
  }
  const canceled = new AbortController(); canceled.abort(); assert.equal(allow({ ...request, signal: canceled.signal }), false);
  store.release(scope, 'run', lease); assert.equal(read(request), null, 'an earlier view never authorizes a later lost lease');
});

test('SQLite tool authority excludes unrelated receipt/event bodies; explicit historical reads still detect corruption', t => {
  const { store, request, file } = setup(t, true), db = new DatabaseSync(file);
  t.after(() => db.close()); const key = runKey(scope, 'run');
  db.prepare('INSERT INTO native_items VALUES (?,?,?,?)').run(key, 'receipts', 'unrelated-old-effect', 'NOT JSON');
  const read = createNativeToolAuthorityReader({ store, scope, sessionId: 'session' });
  assert.ok(read(request)); assert.throws(() => store.load(scope, 'run'));
  const before = store.toolAuthority(scope, 'run');
  db.prepare("UPDATE native_items SET data=json_set(data,'$.claimedFence',999) WHERE run_key=? AND collection='intents' AND item_key=?")
    .run(key, request.operationKey);
  assert.equal(read(request), null, 'current intent fencing is always re-read');
  assert.equal(before.pendingIntent.claimedFence, request.executionFence);
});

for (const sqlite of [false, true]) test(`${sqlite ? 'SQLite' : 'memory'} current tool authority binds the original execution resource without reading its recovery capsule`, t => {
  const { store, request } = setup(t, sqlite);
  const original = store.toolAuthority(scope, 'run').configuration.hostBindingDigest;
  const read = createNativeToolAuthorityReader({ store, scope, sessionId: 'session', expectedHostBindingDigest: original });
  assert.ok(read(request));
  assert.equal(createNativeToolAuthority({ store, scope, sessionId: 'session', expectedHostBindingDigest: original + '-other' })(request), false);
  assert.equal(store.toolAuthority(scope, 'run').configuration.hostRecoveryBinding, undefined);
  const release = store.load.bind(store); store.load = () => assert.fail('a publication guard must not hydrate full history');
  assert.ok(read(request)); store.load = release;
});
