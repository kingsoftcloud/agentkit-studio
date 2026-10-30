import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeKernel, MemoryRunStore, NativeError, emptyUsage, prepareEffect } from '../dist/index.mjs';
import { SqliteRunStore } from '../../agentkit-harness-node/src/native/sqlite-store.mjs';
import { fixture, tool, scope, digest } from './fixtures.mjs';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const write = { callId: 'write', name: 'write', arguments: {} };
const model = async () => ({ kind: 'tool_calls', text: '', toolCalls: [write], usage: emptyUsage() });
const final = async () => ({ kind: 'final_candidate', text: 'No command executed.', toolCalls: [], usage: emptyUsage() });

for (const native of [false, true]) test(`tool exceptions retain a bounded diagnosis without copying adapter error content (native=${native})`, async () => {
  const store = new MemoryRunStore(), secret = 'PRIVATE_ERROR_CONTENT';
  const { config, snapshot } = fixture({ tools: [tool({ name: 'write', readOnly: false, concurrentSafe: false })] });
  let writes = 0;
  const kernel = new NativeKernel({ store, digest, owner: 'worker', ports: { model: { generate: model },
    tools: { execute: async () => { writes++; throw native ? new NativeError(secret) : Error(secret); } } } });
  kernel.start(snapshot, config); const result = await kernel.runUntilIdle(scope, 'run');
  assert.equal(writes, 1); assert.equal(result.reason, 'effect_outcome_unknown');
  const facts = store.load(scope, 'run').events.filter(event => event.kind === 'tool.failure_observed');
  assert.equal(facts.length, 1); assert.equal(facts[0].payload.cause, native ? 'native_error' : 'effect_port_error');
  assert.equal(facts[0].payload.dispatchEvidence, 'unavailable'); assert.equal(JSON.stringify(facts).includes(secret), false);
});
test('a dispatched write timeout keeps its diagnosis across cold reopen and is never retried', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'native-failure-facts-')), file = join(directory, 'runs.sqlite');
  let store = new SqliteRunStore(file), writes = 0;
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const { config, snapshot } = fixture({ tools: [tool({ name: 'write', readOnly: false, concurrentSafe: false,
    timeoutMs: 10, executionTimeoutPolicy: 'dispatch/v2' })],
    profile: { profileId: 'test', profileVersion: '1', providerFamily: 'fixture', compatibilityDigest: 'fixture/v1', requestTimeoutMs: 100 },
    limits: { effectTimeoutMs: 1000 } });
  const kernel = new NativeKernel({ store, digest, owner: 'first', ports: { model: { generate: model },
    tools: { executionLifecycle: 'dispatch/v1', execute: async (_, lifecycle) => {
      lifecycle.dispatched(); writes++; await pause(50); return { status: 'ok', content: 'late' };
    } } } });
  kernel.start(snapshot, config); const before = await kernel.runUntilIdle(scope, 'run');
  assert.equal(before.reason, 'effect_outcome_unknown'); await pause(60); store.close(); store = new SqliteRunStore(file);
  const original = store.load(scope, 'run'), fact = original.events.find(event => event.kind === 'tool.failure_observed');
  assert.equal(fact.payload.cause, 'tool_timeout'); assert.equal(fact.payload.dispatchEvidence, 'some_dispatched');
  assert.equal(fact.payload.signalAborted, true);
  await new NativeKernel({ store, digest, owner: 'replacement', ports: { model: { generate: model },
    tools: { execute: async () => { writes++; throw Error('must not repeat'); } } } }).runUntilIdle(scope, 'run');
  assert.equal(writes, 1); assert.deepEqual(store.load(scope, 'run').receipts, original.receipts);
});
test('outer permission timeout records actual nondispatch evidence without inventing an executed write', async () => {
  const store = new MemoryRunStore(); let writes = 0, models = 0;
  const { config, snapshot } = fixture({ tools: [tool({ name: 'write', readOnly: false, concurrentSafe: false,
    timeoutMs: 10, executionTimeoutPolicy: 'dispatch/v2' })],
    profile: { profileId: 'test', profileVersion: '1', providerFamily: 'fixture', compatibilityDigest: 'fixture/v1', requestTimeoutMs: 10 },
    limits: { effectTimeoutMs: 20 } });
  const kernel = new NativeKernel({ store, digest, owner: 'worker', ports: {
    model: { generate: request => ++models === 1 ? model(request) : final() },
    tools: { executionLifecycle: 'dispatch/v1', execute: async (_, lifecycle) => {
      await pause(70); lifecycle.dispatched(); writes++; return { status: 'ok', content: 'late' };
    } } } });
  kernel.start(snapshot, config); const result = await kernel.runUntilIdle(scope, 'run'); await pause(80);
  assert.equal(result.phase, 'completed'); assert.equal(writes, 0);
  const facts = store.load(scope, 'run').events.filter(event => event.kind === 'effect.failure_observed');
  assert.equal(facts.length, 1); assert.equal(facts[0].payload.cause, 'effect_timeout');
  assert.equal(facts[0].payload.dispatchEvidence, 'none_dispatched'); assert.equal(facts[0].payload.observedProofs, 1);
  assert.equal(facts[0].payload.dispatchedProofs, 0);
});
test('recovering a lost claim does not invent an observed timeout, exception or lease-loss cause', async () => {
  const store = new MemoryRunStore(), { config, snapshot } = fixture({ tools: [tool({ name: 'write', readOnly: false, concurrentSafe: false })] });
  store.create(config, snapshot); const lease = store.acquire(scope, 'run', 'lost-worker', 1, 1);
  const batch = prepareEffect(snapshot, 'tool', 'executing_tools', { calls: [write], interaction: null },
    { pendingTools: [write], messages: [...snapshot.messages, { role: 'assistant', content: '', toolCalls: [write] }] });
  store.commit(scope, 'run', lease, 1, 0, batch); store.claim(scope, 'run', lease, 1, batch.snapshot.pendingIntent);
  let writes = 0;
  const result = await new NativeKernel({ store, digest, owner: 'replacement', now: () => 100,
    ports: { model: { generate: model }, tools: { execute: async () => { writes++; throw Error('must not repeat'); } } } }).runUntilIdle(scope, 'run');
  assert.equal(writes, 0); assert.equal(result.reason, 'effect_outcome_unknown');
  assert.equal(store.load(scope, 'run').events.some(event => event.kind.endsWith('.failure_observed')), false);
});
