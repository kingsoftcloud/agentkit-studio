import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { NativeKernel, emptyUsage, transition, prepareEffect, canonical } from '@kingsoftcloud/agentkit-harness-core';
import { SqliteRunStore } from '../src/native/sqlite-store.mjs';
import { projectNativeRunObservation } from '../src/native/run-observation.mjs';
import { fixture, scope, digest, tool } from '../../agentkit-harness-core/test/fixtures.mjs';

async function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'native-commit-')), file = join(root, 'runs.sqlite');
  const store = new SqliteRunStore(file);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const { config, snapshot } = fixture({ tools: [tool()] });
  let calls = 0;
  const stop = new Error('checkpoint-ready');
  const kernel = new NativeKernel({ store, owner: 'fixture', digest, onCheckpoint: state => {
    assert.deepEqual(store.observation(scope, 'run'), projectNativeRunObservation(store.load(scope, 'run')),
      'Incremental read model must agree with explicit full history reconstruction');
    if (state.phase === 'preparing_context' && state.pendingIntent === null && state.usage.toolCalls === 4) throw stop;
  }, ports: {
    model: { generate: async () => ({ kind: 'tool_calls', text: '', usage: emptyUsage(),
      toolCalls: [{ callId: `read-${++calls}`, name: 'read', arguments: {} }] }) },
    tools: { execute: async () => ({ status: 'ok', content: { archive: 'x'.repeat(1024 * 1024) },
      context: { content: 'Small model-visible observation' } }) },
  } });
  kernel.start(snapshot, config);
  await assert.rejects(kernel.runUntilIdle(scope, 'run'), error => error === stop);
  return { store, file };
}

function measureReads(action) {
  const original = DatabaseSync.prototype.prepare;
  let bytes = 0;
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

test('ordinary SQL append does not reread archived effect bodies; replay and stale revisions retain their invariants', async t => {
  const { store } = await setup(t);
  const original = store.load(scope, 'run'), snapshot = original.snapshot;
  const full = measureReads(() => store.load(scope, 'run'));
  assert.ok(full.bytes > 4 * 1024 * 1024, 'The fixture really contains large archived receipts');
  const lease = store.acquire(scope, 'run', 'next', Date.now(), 30000);
  const batch = transition(snapshot, { phase: 'preparing_context' });
  const append = measureReads(() => store.commit(scope, 'run', lease, Date.now(), snapshot.revision, batch));
  assert.ok(append.bytes < full.bytes / 10, `Unrelated history must stay out of the append: ${append.bytes}/${full.bytes}`);
  assert.deepEqual(store.commit(scope, 'run', lease, Date.now(), snapshot.revision, batch), append.value,
    'An exact commit replay has no extra events or receipts');
  const current = store.load(scope, 'run');
  for (const field of ['receipts', 'intents', 'events']) assert.deepEqual(current[field], original[field]);
  assert.throws(() => store.commit(scope, 'run', lease, Date.now(), snapshot.revision,
    { ...batch, snapshot: { ...batch.snapshot, goal: 'Conflicting replay' } }), { code: 'commit_replay_conflict' });
  assert.throws(() => store.commit(scope, 'run', lease, Date.now(), snapshot.revision,
    { ...batch, commitId: 'different-commit' }), { code: 'revision_conflict' });
  store.release(scope, 'run', lease);
});

test('a failing append rolls back metadata, events and derived indexes together', async t => {
  const { store, file } = await setup(t), db = new DatabaseSync(file);
  t.after(() => db.close());
  const before = store.load(scope, 'run'), lease = store.acquire(scope, 'run', 'next', Date.now(), 30000);
  const admitted = store.load(scope, 'run');
  const batch = transition(before.snapshot, { phase: 'preparing_context' }, [{ kind: 'fixture.append', payload: {} }]);
  db.exec("CREATE TRIGGER fixture_fail BEFORE INSERT ON native_events BEGIN SELECT RAISE(ABORT,'fixture append failure'); END");
  assert.throws(() => store.commit(scope, 'run', lease, Date.now(), before.snapshot.revision, batch), /fixture append failure/);
  assert.equal(canonical(store.load(scope, 'run')), canonical(admitted));
  assert.equal(db.prepare('SELECT count(*) AS n FROM native_open_intents').get().n, 0);
  db.exec('DROP TRIGGER fixture_fail');
  store.commit(scope, 'run', lease, Date.now(), before.snapshot.revision, batch);
  assert.deepEqual(store.observation(scope, 'run'), projectNativeRunObservation(store.load(scope, 'run')));
  store.release(scope, 'run', lease);
});

test('an existing ledger rebuilds the open-effect index without reading or rewriting historical payloads', async t => {
  const { store, file } = await setup(t), db = new DatabaseSync(file);
  t.after(() => db.close());
  const before = store.authority(scope, 'run').snapshot;
  const lease = store.acquire(scope, 'run', 'prepare', Date.now(), 30000);
  const batch = prepareEffect(before, 'tool', 'executing_tools', { calls: [{ callId: 'next', name: 'read', arguments: {} }], interaction: null });
  store.commit(scope, 'run', lease, Date.now(), before.revision, batch); store.release(scope, 'run', lease);
  const archived = db.prepare("SELECT data FROM native_items WHERE collection='receipts' ORDER BY item_key").all();
  db.exec('DROP TRIGGER native_intent_open; DROP TRIGGER native_intent_settled; DROP TABLE native_open_intents');
  const reopened = new SqliteRunStore(file); t.after(() => reopened.close());
  assert.equal(db.prepare('SELECT count(*) AS n FROM native_open_intents').get().n, 1);
  const nextLease = reopened.acquire(scope, 'run', 'restored', Date.now(), 30000);
  assert.equal(reopened.claim(scope, 'run', nextLease, Date.now(), batch.snapshot.pendingIntent).status, 'running');
  assert.deepEqual(db.prepare("SELECT data FROM native_items WHERE collection='receipts' ORDER BY item_key").all(), archived);
  reopened.release(scope, 'run', nextLease);
});

test('a mismatched display cache rebuilds from its own ledger rather than carrying foreign tool facts into a commit', async t => {
  const { store, file } = await setup(t), db = new DatabaseSync(file); t.after(() => db.close());
  db.prepare("UPDATE native_run_observations SET data=json_set(data,'$.snapshot.scope.agentId','other-agent')").run();
  const before = store.authority(scope, 'run').snapshot, lease = store.acquire(scope, 'run', 'next', Date.now(), 30000);
  store.commit(scope, 'run', lease, Date.now(), before.revision, transition(before, {}));
  assert.deepEqual(store.observation(scope, 'run'), projectNativeRunObservation(store.load(scope, 'run')));
  store.release(scope, 'run', lease);
});

test('incremental display retains actual compaction anchors and admission facts across every commit', async t => {
  const root = mkdtempSync(join(tmpdir(), 'native-commit-context-')), store = new SqliteRunStore(join(root, 'runs.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const { config, snapshot } = fixture({ tools: [tool()], contextPolicy: {
    tokenizerId: 'fixture-counter', tokenizerDigest: 'fixture-count/v1', enabled: true,
    triggerRatio: .72, targetRatio: .45, summaryMaxTokens: 80, maxCompactions: null, maxCompactionsWithoutProgress: 4,
    minModelTurnsBetween: 2, maxSummaryRetries: 2 },
    profile: { profileId: 'test', profileVersion: '1', providerFamily: 'fixture', compatibilityDigest: 'fixture/v1',
      contextWindow: 2400, maxOutputTokens: 128, retryInitialDelayMs: 0 } });
  let tasks = 0, summaries = 0;
  const final = text => ({ kind: 'final_candidate', text, toolCalls: [], usage: emptyUsage() });
  const kernel = new NativeKernel({ store, owner: 'context', digest, onCheckpoint: () => {
    assert.deepEqual(store.observation(scope, 'run'), projectNativeRunObservation(store.load(scope, 'run')));
  }, ports: {
    model: { generate: async request => {
      if (request.messages[0].kind === 'compaction_instructions') { summaries++; return final('Observed historical notes.'); }
      if (++tasks === 1) return { ...final(''), kind: 'tool_calls', toolCalls: [{ callId: 'read', name: 'read', arguments: {} }] };
      return final('Complete');
    } },
    tools: { execute: async () => ({ status: 'ok', content: 'Observed '.repeat(1300) }) },
    context: { tokens: { tokenizerId: 'fixture-counter', tokenizerDigest: 'fixture-count/v1',
      countRequest: async request => Math.ceil(canonical({ messages: request.messages, tools: request.tools }).length / 4),
      countText: async request => Math.ceil(request.text.length / 4) } },
  } });
  kernel.start(snapshot, config); const done = await kernel.runUntilIdle(scope, 'run');
  assert.equal(done.phase, 'completed'); assert.ok(summaries > 1); assert.equal(done.contextState.compactions, 1);
  assert.equal(store.observation(scope, 'run').facts.contextStatus.idle.markers[0].status, 'completed');
});
