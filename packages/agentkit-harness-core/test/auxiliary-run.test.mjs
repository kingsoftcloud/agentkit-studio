import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryRunStore, NativeKernel, NATIVE_AUXILIARY_RUN, emptyUsage,
  executeNativeAuxiliaryRun, assertNativeAuxiliaryToolExecution,
  assertNativeAuxiliaryReceiptObservation } from '../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { fixture, scope, digest, tool } from './fixtures.mjs';

const final = () => ({ kind: 'final_candidate', text: 'Finished', toolCalls: [], usage: emptyUsage() });
const toolResult = name => ({ kind: 'tool_calls', text: '',
  toolCalls: [{ name, callId: 'call-1', arguments: {} }], usage: emptyUsage() });
const runFor = (data, overrides = {}) => ({ contract: NATIVE_AUXILIARY_RUN,
  identity: { ...data.snapshot, runId: 'auxiliary', sessionId: 'auxiliary-session', turnId: 'auxiliary-turn', parentRunId: null },
  configuration: data.config, ...overrides });
const options = (run, store, ports, extra = {}) => ({ run, store, ports, owner: 'capability-owner', digest,
  signal: new AbortController().signal, assertSourceCurrent() {}, countRequest: () => 10, ...extra });

for (const backend of ['memory', 'sqlite']) {
  test(`${backend}: a capability uses the same durable kernel without modifying its parent Session`, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'native-auxiliary-'));
    let store = backend === 'memory' ? new MemoryRunStore() : new SqliteRunStore(join(directory, 'runs.sqlite'));
    t.after(() => { store.close?.(); rmSync(directory, { recursive: true, force: true }); });
    const data = fixture({ tools: [tool()] });
    const parent = new NativeKernel({ store, owner: 'parent', digest,
      ports: { model: { generate: async () => final() }, tools: { execute: async () => { throw Error('unexpected parent tool'); } } } });
    parent.start(data.snapshot, data.config);
    await parent.runUntilIdle(scope, 'run');
    const originalParent = store.load(scope, 'run'), originalHead = store.sessionHead(scope, 'session');
    const run = runFor(data); let models = 0, effects = 0, captured;
    const ports = { model: { generate: async () => ++models === 1 ? toolResult('read') : final() },
      tools: { execute: async request => {
        captured = request;
        assertNativeAuxiliaryToolExecution({ store, run, request });
        for (const changed of [
          { sessionId: 'parent-session' }, { executionFence: request.executionFence + 1 },
          { operationKey: request.operationKey + ':forged' },
          { call: { ...request.call, arguments: { forged: true } } },
          { definition: { ...request.definition, readOnly: false } },
        ]) assert.throws(() => assertNativeAuxiliaryToolExecution({ store, run, request: { ...request, ...changed } }));
        assert.throws(() => assertNativeAuxiliaryToolExecution({ store, run, request,
          now: store.load(scope, run.identity.runId).lease.expiresAt + 1 }));
        effects++; return { status: 'ok', content: 'actual capability result' };
      } } };
    const completed = await executeNativeAuxiliaryRun(options(run, store, ports));
    assert.equal(completed.status, 'success');
    assert.equal(completed.snapshot.usage.modelCalls, 2);
    assert.equal(completed.snapshot.usage.toolCalls, 1);
    assert.deepEqual(store.load(scope, 'run'), originalParent);
    assert.deepEqual(store.sessionHead(scope, 'session'), originalHead);
    assert.equal(store.load(scope, 'auxiliary').receipts.length, 3);
    assert.throws(() => assertNativeAuxiliaryToolExecution({ store, run, request: captured }));
    if (backend === 'sqlite') { store.close(); store = new SqliteRunStore(join(directory, 'runs.sqlite')); }
    const resumed = await executeNativeAuxiliaryRun(options(run, store, ports));
    assert.equal(resumed.status, 'success');
    assert.equal(effects, 1); assert.equal(models, 2);
  });
}

test('an auxiliary capability cannot call its model when the actual request exceeds the context budget', async () => {
  const store = new MemoryRunStore(), data = fixture(), run = runFor(data); let calls = 0;
  const result = await executeNativeAuxiliaryRun(options(run, store, {
    model: { generate: async () => { calls++; return final(); } },
    tools: { execute: async () => { throw Error('unexpected tool'); } },
  }, { countRequest: () => data.config.profile.contextWindow }));
  assert.equal(result.status, 'error');
  assert.equal(calls, 0);
  assert.notEqual(result.snapshot.phase, 'completed');
});

test('revoked capability input cannot reach a tool or authorize successful completion', async () => {
  const store = new MemoryRunStore(), data = fixture({ tools: [tool()] }), run = runFor(data);
  let current = true, effects = 0;
  const result = await executeNativeAuxiliaryRun(options(run, store, {
    model: { generate: async () => { current = false; return toolResult('read'); } },
    tools: { execute: async () => { effects++; return { status: 'ok', content: 'forbidden' }; } },
  }, { assertSourceCurrent() { assert.equal(current, true, 'input revoked'); } }));
  assert.equal(result.status, 'error'); assert.equal(effects, 0);
});

test('canceling an auxiliary model aborts its port and records cancellation through NativeKernel', async () => {
  const store = new MemoryRunStore(), run = runFor(fixture()), controller = new AbortController();
  let started; const ready = new Promise(resolve => { started = resolve; });
  let aborted = false;
  const pending = executeNativeAuxiliaryRun(options(run, store, {
    model: { generate: async request => {
      started();
      return new Promise((_, reject) => request.signal.addEventListener('abort', () => {
        aborted = true; reject(Error('cancelled model'));
      }, { once: true }));
    } }, tools: { execute: async () => { throw Error('unexpected tool'); } },
  }, { signal: controller.signal }));
  await ready; controller.abort();
  const result = await pending;
  assert.equal(aborted, true); assert.equal(result.status, 'aborted');
  assert.equal(result.snapshot.phase, 'canceled');
});

test('cold auxiliary recovery observes the original owner receipt without executing the side effect twice', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'native-auxiliary-receipt-'));
  const path = join(directory, 'runs.sqlite'), receipt = join(directory, 'effect.json');
  let store = new SqliteRunStore(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const run = runFor(fixture({ tools: [tool({ name: 'remote', readOnly: false,
    concurrentSafe: false, recoveryPolicy: 'receipt-observation/v1' })] }));
  let models = 0, executions = 0, observations = 0;
  const ports = { model: { generate: async () => ++models === 1 ? toolResult('remote') : final() },
    tools: { execute: async request => {
      executions++;
      writeFileSync(receipt, JSON.stringify({ key: request.operationKey, result: { status: 'ok', content: 'committed once' } }));
      return { status: 'uncertain', content: { code: 'response_lost_after_commit' } };
    } } };
  const waiting = await executeNativeAuxiliaryRun(options(run, store, ports));
  assert.equal(waiting.status, 'error'); assert.equal(waiting.snapshot.phase, 'awaiting_reconciliation');
  store.close(); store = new SqliteRunStore(path);
  ports.tools.observeReceipt = async request => {
    observations++;
    assertNativeAuxiliaryReceiptObservation({ store, run, request });
    for (const changed of [{ originalOperationKey: 'forged' }, { originalClaimedFence: 999999 },
      { executionFence: request.executionFence + 1 }, { call: { ...request.call, arguments: { forged: true } } }]) {
      assert.throws(() => assertNativeAuxiliaryReceiptObservation({ store, run, request: { ...request, ...changed } }));
    }
    const original = JSON.parse(readFileSync(receipt, 'utf8'));
    assert.equal(request.originalOperationKey, original.key);
    return { contract: request.contract, originalOperationKey: original.key,
      callId: request.call.callId, result: original.result };
  };
  const recovered = await executeNativeAuxiliaryRun(options(run, store, ports));
  assert.equal(recovered.status, 'success'); assert.equal(recovered.snapshot.phase, 'completed');
  assert.equal(recovered.snapshot.usage.toolCalls, 1);
  assert.equal(executions, 1); assert.equal(observations, 1); assert.equal(models, 2);
});
