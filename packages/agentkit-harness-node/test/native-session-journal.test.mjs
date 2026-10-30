import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { NativeKernel, emptyUsage, transition, canonical } from '@kingsoftcloud/agentkit-harness-core';
import { SqliteRunStore } from '../src/native/sqlite-store.mjs';
import { projectNativeSessionDelivery } from '../src/native/session-delivery-journal.mjs';
import { projectNativeRunObservation } from '../src/native/run-observation.mjs';
import { fixture, scope, digest, tool } from '../../agentkit-harness-core/test/fixtures.mjs';

function measureReads(action) {
  const original = DatabaseSync.prototype.prepare; let bytes = 0;
  DatabaseSync.prototype.prepare = function (...args) {
    const statement = Reflect.apply(original, this, args);
    return new Proxy(statement, { get(target, name) {
      const value = Reflect.get(target, name, target);
      if (typeof value !== 'function') return value;
      return (...parameters) => {
        const result = Reflect.apply(value, target, parameters);
        if (['all', 'get'].includes(name)) for (const row of Array.isArray(result) ? result : [result])
          if (row) for (const item of Object.values(row)) if (typeof item === 'string') bytes += Buffer.byteLength(item);
        return result;
      };
    } });
  };
  try { return { value: action(), get bytes() { return bytes; } }; }
  finally { DatabaseSync.prototype.prepare = original; }
}

function setup(t, label) {
  const root = mkdtempSync(join(tmpdir(), label)), file = join(root, 'runs.sqlite');
  const store = new SqliteRunStore(file);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { store, file };
}

test('every real Kernel checkpoint has the same delivery plan without rereading archived tool bodies', async t => {
  const { store } = setup(t, 'native-delivery-journal-');
  const { config, snapshot } = fixture({ tools: [tool()] });
  let models = 0, checks = 0;
  const kernel = new NativeKernel({ store, digest, owner: 'delivery-journal', onCheckpoint: () => {
    checks++;
    const record = store.load(scope, 'run');
    assert.deepEqual(store.sessionDeliveryState(scope, 'run'), projectNativeSessionDelivery(record));
    assert.deepEqual(store.observation(scope, 'run'), projectNativeRunObservation(record));
  }, ports: {
    model: { generate: async () => ++models <= 3
      ? { kind: 'tool_calls', text: 'Reading.', toolCalls: [{ callId: `read-${models}`, name: 'read', arguments: {} }], usage: emptyUsage() }
      : { kind: 'final_candidate', text: 'Done.', toolCalls: [], usage: emptyUsage() } },
    tools: { execute: async () => ({ status: 'ok', content: { raw: 'PRIVATE_ARCHIVED_RESULT' + 'x'.repeat(2 * 1024 * 1024) },
      context: { content: 'A short authorized model/display observation.' },
      metadata: { nativeTaskDisplay: { contract: 'agentkit.workspace-display/v1', display: { kind: 'file_edit',
        files: [{ path: 'proof.txt', patch: '+visible edit', changeStat: { added: 1, removed: 0 } }], omittedFiles: 0 } } } }) },
  } });
  kernel.start(snapshot, config);
  assert.equal((await kernel.runUntilIdle(scope, 'run')).phase, 'completed');assert.ok(checks > 10);
  const full = measureReads(() => store.load(scope, 'run'));
  const view = measureReads(() => store.sessionDeliveryState(scope, 'run'));
  assert.deepEqual(view.value, projectNativeSessionDelivery(full.value));
  assert.ok(full.bytes > 6 * 1024 * 1024);
  assert.ok(view.bytes < full.bytes / 8, `Delivery must exclude raw history: ${view.bytes}/${full.bytes}`);
  assert.doesNotMatch(JSON.stringify(view.value), /PRIVATE_ARCHIVED_RESULT/);
  assert.equal(view.value.displays.length, 3);
});

test('delivery journal rollback is atomic with its original event and snapshot', t => {
  const { store, file } = setup(t, 'native-delivery-rollback-');
  const { config, snapshot } = fixture();store.create(config, snapshot);
  const db = new DatabaseSync(file);t.after(() => db.close());
  const before = store.load(scope, 'run'), view = store.sessionDeliveryState(scope, 'run');
  const lease = store.acquire(scope, 'run', 'delivery-rollback', Date.now(), 30000);
  const batch = transition(snapshot, {}, [{ kind: 'context.planned', payload: { action: 'compact', compactions: 0 } }]);
  db.exec(`CREATE TRIGGER fail_delivery_append BEFORE INSERT ON native_delivery_items BEGIN SELECT RAISE(ABORT,'injected delivery failure'); END`);
  assert.throws(() => store.commit(scope, 'run', lease, Date.now(), snapshot.revision, batch), /injected delivery failure/);
  assert.deepEqual(store.load(scope, 'run').snapshot, before.snapshot);
  assert.deepEqual(store.load(scope, 'run').events, before.events);
  assert.deepEqual(store.sessionDeliveryState(scope, 'run'), view);
  db.exec('DROP TRIGGER fail_delivery_append');
  store.commit(scope, 'run', lease, Date.now(), snapshot.revision, batch);
  assert.deepEqual(store.sessionDeliveryState(scope, 'run'), projectNativeSessionDelivery(store.load(scope, 'run')));
});

test('a missing or foreign delivery cache rebuilds from its own ledger without changing immutable history', t => {
  const { store, file } = setup(t, 'native-delivery-rebuild-');
  const { config, snapshot } = fixture();store.create(config, snapshot);
  const expected = projectNativeSessionDelivery(store.load(scope, 'run'));
  const db = new DatabaseSync(file);t.after(() => db.close());
  const immutable = () => canonical({
    events: db.prepare('SELECT * FROM native_events ORDER BY rowid').all().map(row => ({ ...row })),
    items: db.prepare('SELECT * FROM native_items ORDER BY rowid').all().map(row => ({ ...row })),
  });
  const original = immutable();
  db.exec('DELETE FROM native_delivery_heads; DELETE FROM native_delivery_items');
  assert.deepEqual(store.sessionDeliveryState(scope, 'run'), expected);assert.equal(immutable(), original);
  db.exec("UPDATE native_delivery_heads SET data=json_set(data,'$.runId','foreign-run')");
  assert.deepEqual(store.sessionDeliveryState(scope, 'run'), expected);assert.equal(immutable(), original);
  const reopened = new SqliteRunStore(file);
  try { assert.deepEqual(reopened.sessionDeliveryState(scope, 'run'), expected); }
  finally { reopened.close(); }
});
