import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeKernel, MemoryRunStore, emptyUsage, prepareEffect } from '../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { fixture, tool, scope, digest } from './fixtures.mjs';

const call = (name = 'read') => ({ callId: name, name, arguments: {} });
const final = () => ({ kind: 'final_candidate', text: 'Recovered', toolCalls: [], usage: emptyUsage() });
function claimed(store, configuration, kind = 'tool', calls = [call()]) {
  const { config, snapshot } = fixture(configuration); store.create(config, snapshot);
  const lease = store.acquire(scope, 'run', 'lost-worker', 1, 1);
  const batch = kind === 'tool' ? prepareEffect(snapshot, kind, 'executing_tools', { calls, interaction: null }, {
    pendingTools: calls, messages: [...snapshot.messages, { role: 'assistant', content: '', toolCalls: calls }],
  }) : prepareEffect(snapshot, kind, kind === 'model' ? 'requesting_model' : 'preparing_context', {});
  store.commit(scope, 'run', lease, 1, 0, batch); store.claim(scope, 'run', lease, 1, batch.snapshot.pendingIntent);
  return { config, snapshot, oldKey: batch.snapshot.pendingIntent };
}
const worker = (store, ports, owner = 'replacement') => new NativeKernel({ store, ports, digest, owner, now: () => 100 });

test('SQLite uncertainty discovery uses durable receipts until a fresh completed observation supersedes them', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'native-outcome-facts-'));
  const store = new SqliteRunStore(join(directory, 'runs.sqlite'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  claimed(store, { tools: [tool({ name: 'read', recoveryPolicy: 'safe-read/v1' })] });
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), wait = new Promise(resolve => { release = resolve; });
  const run = worker(store, { model: { generate: async () => final() }, tools: { execute: async () => {
    enter(); await wait; return { status: 'ok', content: 'Fresh bytes' };
  } } }).runUntilIdle(scope, 'run');
  await entered;
  try {
    const before = JSON.stringify(store.load(scope, 'run').receipts);
    assert.deepEqual(store.uncertainToolCalls(scope, 'session'), [{ runId: 'run', turnId: 'turn', callId: 'read' }]);
    assert.deepEqual(store.uncertainToolCalls({ ...scope, agentId: 'foreign' }, 'session'), []);
    assert.deepEqual(store.uncertainToolCalls(scope, 'foreign-session'), []);
    assert.equal(JSON.stringify(store.load(scope, 'run').receipts), before, 'Discovery cannot settle or reclassify a receipt');
  } finally { release(); await run; }
  assert.deepEqual(store.uncertainToolCalls(scope, 'session'), [], 'The latest actual read wins over the retained lost-claim receipt');
  assert.ok(store.load(scope, 'run').receipts.some(receipt => receipt.status === 'uncertain'));
});

for (const backend of ['memory', 'sqlite']) {
  function setup(t) {
    const directory = mkdtempSync(join(tmpdir(), 'native-recovery-'));
    const store = backend === 'memory' ? new MemoryRunStore() : new SqliteRunStore(join(directory, 'run.sqlite'));
    t.after(() => { store.close?.(); rmSync(directory, { recursive: true, force: true }); }); return store;
  }
  test(`${backend}: explicit pure-inference takeover charges a new request and records missing provider usage`, async t => {
    const store = setup(t), { oldKey } = claimed(store, { modelRecoveryPolicy: 'pure-inference/v1' }, 'model');
    let requests = 0;
    const result = await worker(store, { model: { generate: async request => {
      requests++; assert.notEqual(request.operationKey, oldKey); return final();
    } }, tools: { execute: async () => { throw Error('No tool is authorized'); } } }).runUntilIdle(scope, 'run');
    assert.equal(requests, 1); assert.equal(result.usage.modelCalls, 2); assert.equal(result.recoveryRetriesUsed, 1);
    assert.equal(result.diagnostics.providerUsageIncomplete, true); assert.equal(result.diagnostics.uncertainModelCalls, 1);
    assert.equal(result.activeElapsedMs, 99); assert.equal(store.load(scope, 'run').receipts[0].status, 'uncertain');
  });
  test(`${backend}: readOnly alone does not authorize replay`, async t => {
    const store = setup(t); claimed(store, { tools: [tool()] }); let executions = 0;
    const result = await worker(store, { model: { generate: async () => final() }, tools: { execute: async () => { executions++; return { status: 'ok', content: '' }; } } })
      .runUntilIdle(scope, 'run');
    assert.equal(executions, 0); assert.equal(result.phase, 'interrupted'); assert.equal(result.reason, 'effect_outcome_unknown');
  });
  test(`${backend}: a Host-declared repeatable read gets a fresh intent and one actual result`, async t => {
    const store = setup(t); const { oldKey } = claimed(store, { tools: [tool({ recoveryPolicy: 'safe-read/v1' })] });
    let reads = 0;
    const result = await worker(store, { model: { generate: async request => {
      assert.equal(request.messages.at(-1).content, '"current contents"'); return final();
    } }, tools: { execute: async request => { reads++; assert.notEqual(request.operationKey, oldKey); return { status: 'ok', content: 'current contents' }; } } })
      .runUntilIdle(scope, 'run');
    assert.equal(result.phase, 'completed'); assert.equal(reads, 1); assert.equal(result.usage.toolCalls, 2);
    assert.equal(result.messages.filter(message => message.role === 'tool').length, 1);
    assert.equal(store.load(scope, 'run').events.filter(event => event.kind === 'effect.recovery_scheduled').length, 1);
  });
  test(`${backend}: a batch containing any operation without replay authority is never repeated`, async t => {
    const store = setup(t); claimed(store, { tools: [tool({ recoveryPolicy: 'safe-read/v1' }), tool({ name: 'write', readOnly: false, concurrentSafe: false })] },
      'tool', [call(), call('write')]); let executions = 0;
    const result = await worker(store, { model: { generate: async () => final() }, tools: { execute: async () => { executions++; return { status: 'ok', content: '' }; } } })
      .runUntilIdle(scope, 'run');
    assert.equal(executions, 0); assert.equal(result.reason, 'effect_outcome_unknown'); assert.equal(result.usage.toolCalls, 2);
  });
}

test('repeated lost claims have a durable retry cap across SQLite reopen and replacement owners', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'native-recovery-cap-')), filename = join(directory, 'run.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let store = new SqliteRunStore(filename);
  claimed(store, { tools: [tool({ recoveryPolicy: 'safe-read/v1' })], limits: { maxRecoveryRetries: 2 } }); store.close();
  for (let attempt = 1; attempt <= 2; attempt++) {
    store = new SqliteRunStore(filename); const claim = store.claim.bind(store);
    store.claim = (...args) => { claim(...args); throw Error('Lost process after durable claim'); };
    await assert.rejects(worker(store, { model: { generate: async () => final() }, tools: { execute: async () => { throw Error('Must not execute'); } } }, `worker-${attempt}`)
      .runUntilIdle(scope, 'run'), /Lost process/);
    assert.equal(store.load(scope, 'run').snapshot.recoveryRetriesUsed, attempt); store.close();
  }
  store = new SqliteRunStore(filename); t.after(() => store.close()); let executions = 0;
  const result = await worker(store, { model: { generate: async () => final() }, tools: { execute: async () => { executions++; return { status: 'ok', content: '' }; } } }, 'final-worker')
    .runUntilIdle(scope, 'run');
  assert.equal(executions, 0); assert.equal(result.phase, 'interrupted'); assert.equal(result.reason, 'recovery_retry_exhausted');
  assert.equal(result.recoveryRetriesUsed, 2); assert.equal(store.load(scope, 'run').receipts.length, 3);
});

test('recovery does not replenish a spent tool allowance or extend the wall budget', async () => {
  for (const limits of [{ maxToolCalls: 1 }, { maxWallMs: 50 }]) {
    const store = new MemoryRunStore(); claimed(store, { tools: [tool({ recoveryPolicy: 'safe-read/v1' })], limits });
    let reads = 0;
    const result = await worker(store, { model: { generate: async () => final() }, tools: { execute: async () => { reads++; return { status: 'ok', content: '' }; } } })
      .runUntilIdle(scope, 'run');
    assert.equal(reads, 0); assert.equal(result.usage.toolCalls, 1);
    if (limits.maxWallMs) assert.equal(result.reason, 'execution_budget_exhausted');
    else assert.ok(result.messages.some(message => message.role === 'tool' && message.content.includes('tool_budget_exhausted')));
  }
});

test('configuration rejects replay authority on mutating, delegated and browser tools', () => {
  for (const definition of [
    tool({ readOnly: false, concurrentSafe: false }), tool({ delegatedReadOnly: true }), tool({ concurrentSafe: false, observationRole: 'browser' }),
  ]) assert.throws(() => fixture({ tools: [{ ...definition, recoveryPolicy: 'safe-read/v1' }] }), { code: 'invalid_safe_read_recovery' });
});
