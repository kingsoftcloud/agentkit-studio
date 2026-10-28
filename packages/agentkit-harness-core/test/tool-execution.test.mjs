import test from 'node:test';
import assert from 'node:assert/strict';
import { executeTimedTool } from '../dist/tool-execution.mjs';
import { MemoryRunStore, NativeKernel, emptyUsage, prepareEffect } from '../dist/index.mjs';
import { fixture, scope, tool, digest } from './fixtures.mjs';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const options = extra => ({ signal: new AbortController().signal, timeoutMs: 15, dispatchTimed: true,
  lifecycleAvailable: true, now: () => performance.now(), ...extra });

test('throwing or rejecting a failure observer cannot change tool settlement', async () => {
  for (const onFailure of [() => { throw Error('observer failed'); }, async () => { throw Error('observer rejected'); }]) {
    const result = await executeTimedTool(options({ dispatchTimed: false, onFailure,
      execute: async () => { throw Error('actual producer failed'); } }));
    assert.equal(result.status, 'uncertain'); assert.equal(result.content.code, 'tool_outcome_unknown');
  }
  await pause(0);
});

test('permission preflight can outlast execution timeout without claiming a tool result is unknown', async () => {
  let writes = 0;
  const result = await executeTimedTool(options({ execute: async (signal, lifecycle) => {
    await pause(60); signal.throwIfAborted(); lifecycle.dispatched(); writes++;
    return { status: 'ok', content: 'applied once' };
  } }));
  assert.equal(result.status, 'ok'); assert.equal(writes, 1);
});

test('cancelling permission preflight cannot dispatch later and records known non-execution', async () => {
  const controller = new AbortController(); let writes = 0;
  const result = await executeTimedTool(options({ signal: controller.signal, execute: async (signal, lifecycle) => {
    setTimeout(() => controller.abort(), 5);
    await pause(30); lifecycle.dispatched(); writes++;
    return { status: 'ok', content: 'should not happen' };
  } }));
  assert.deepEqual(result, { status: 'error', content: { code: 'tool_preflight_aborted', executed: false } });
  await pause(40); assert.equal(writes, 0);
});

test('a deadline after dispatch stays uncertain and repeated notifications cannot renew it', async () => {
  let writes = 0, live;
  const result = await executeTimedTool(options({ execute: async (signal, lifecycle) => {
    live = signal; lifecycle.dispatched(); writes++;
    await pause(8); lifecycle.dispatched(); await pause(20);
    return { status: 'ok', content: 'late receipt' };
  } }));
  assert.equal(result.status, 'uncertain'); assert.equal(live.aborted, true); assert.equal(writes, 1);
});

test('legacy execution timeouts still include the entire port call', async () => {
  const result = await executeTimedTool(options({ dispatchTimed: false, execute: async () => {
    await pause(60); return { status: 'ok', content: 'late' };
  } }));
  assert.equal(result.status, 'uncertain');
});

test('a missing lifecycle boundary fails before entering a negotiated tool port', async () => {
  let calls = 0;
  const result = await executeTimedTool(options({ lifecycleAvailable: false, execute: async () => { calls++; } }));
  assert.equal(calls, 0); assert.equal(result.content.executed, false);
});

test('Host permission stays in the ledger while a later tool-owned approval reaches that tool', async () => {
  const store = new MemoryRunStore(); let models = 0, executions = 0;
  const { config, snapshot } = fixture({ tools: [tool({ name: 'write', readOnly: false, concurrentSafe: false,
    approvalPolicy: 'durable-preflight/v1' })] });
  const ports = { model: { generate: async () => ++models === 1
    ? { kind: 'tool_calls', text: '', toolCalls: [{ callId: 'call', name: 'write', arguments: {} }], usage: emptyUsage() }
    : { kind: 'final_candidate', text: 'Done', toolCalls: [], usage: emptyUsage() } },
  tools: { approvalPolicy: 'durable-preflight/v1', execute: async request => {
    executions++;
    if (executions === 1) return { status: 'approval_required', interactionId: 'host-permission',
      approvalPolicy: 'durable-preflight/v1', content: 'Host requires permission' };
    if (executions === 2) {
      assert.equal(request.interaction, null, 'A Host grant cannot impersonate a tool interaction');
      return { status: 'approval_required', interactionId: 'tool-question', content: 'Tool asks a second question' };
    }
    assert.deepEqual(request.interaction, { interactionId: 'tool-question', callId: 'call', decision: 'allow' });
    return { status: 'ok', content: 'Applied' };
  } } };
  let kernel = new NativeKernel({ store, digest, owner: 'first', ports }); kernel.start(snapshot, config);
  let result = await kernel.runUntilIdle(scope, 'run');
  assert.equal(result.pendingInteraction.approvalPolicy, 'durable-preflight/v1');
  kernel.submit(scope, 'run', { commandId: 'host-allow', kind: 'submit_interaction',
    payload: { interactionId: result.pendingInteraction.interactionId, decision: 'allow' } });
  kernel = new NativeKernel({ store, digest, owner: 'second', ports });
  result = await kernel.runUntilIdle(scope, 'run');
  assert.equal(result.pendingInteraction.hostInteractionId, 'tool-question');
  assert.equal(result.pendingInteraction.approvalPolicy, undefined);
  kernel.submit(scope, 'run', { commandId: 'tool-allow', kind: 'submit_interaction',
    payload: { interactionId: result.pendingInteraction.interactionId, decision: 'allow' } });
  result = await kernel.runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed'); assert.equal(executions, 3); assert.equal(result.usage.toolCalls, 1);
});

for (const policy of ['dispatch/v1', 'dispatch/v2']) test(`whole Kernel: ${policy} outer timeout during permission preflight`, async () => {
  const store = new MemoryRunStore(); let models = 0, writes = 0;
  const { config, snapshot } = fixture({ tools: [tool({ name: 'write', readOnly: false, concurrentSafe: false,
    timeoutMs: 10, executionTimeoutPolicy: policy })],
    profile: { profileId: 'test', profileVersion: '1', providerFamily: 'fixture', compatibilityDigest: 'fixture/v1', requestTimeoutMs: 25 },
    limits: { effectTimeoutMs: 50 } });
  const kernel = new NativeKernel({ store, digest, owner: 'worker', ports: {
    model: { generate: async () => ++models === 1
      ? { kind: 'tool_calls', text: '', toolCalls: [{ callId: 'write', name: 'write', arguments: {} }], usage: emptyUsage() }
      : { kind: 'final_candidate', text: 'The write did not execute.', toolCalls: [], usage: emptyUsage() } },
    tools: { executionLifecycle: 'dispatch/v1', execute: async (_request, lifecycle) => {
      await pause(100); lifecycle.dispatched(); writes++; return { status: 'ok', content: 'unexpected' };
    } },
  } });
  kernel.start(snapshot, config);
  const result = await kernel.runUntilIdle(scope, 'run');
  await pause(110); assert.equal(writes, 0, 'A late permission callback cannot start an effect');
  const receipt = store.load(scope, 'run').receipts.find(row => row.operationKey.endsWith(':tool'));
  if (policy === 'dispatch/v1') {
    assert.equal(result.reason, 'effect_outcome_unknown'); assert.equal(receipt.status, 'uncertain');
  } else {
    assert.equal(result.phase, 'completed'); assert.equal(receipt.status, 'committed');
    assert.deepEqual(receipt.result.results, [{ status: 'error', content: { code: 'tool_preflight_aborted', executed: false } }]);
    assert.equal(result.usage.toolCalls, 1); assert.equal(models, 2);
  }
});

test('whole Kernel: dispatch/v2 never treats an already-started write as unexecuted', async () => {
  const store = new MemoryRunStore(); let writes = 0;
  const { config, snapshot } = fixture({ tools: [tool({ name: 'write', readOnly: false, concurrentSafe: false,
    timeoutMs: 10, executionTimeoutPolicy: 'dispatch/v2' })],
    profile: { profileId: 'test', profileVersion: '1', providerFamily: 'fixture', compatibilityDigest: 'fixture/v1', requestTimeoutMs: 25 },
    limits: { effectTimeoutMs: 50 } });
  const kernel = new NativeKernel({ store, digest, owner: 'worker', ports: {
    model: { generate: async () => ({ kind: 'tool_calls', text: '', toolCalls: [{ callId: 'write', name: 'write', arguments: {} }], usage: emptyUsage() }) },
    tools: { executionLifecycle: 'dispatch/v1', execute: async (_request, lifecycle) => {
      lifecycle.dispatched(); writes++; await pause(100); return { status: 'ok', content: 'late' };
    } },
  } });
  kernel.start(snapshot, config); const result = await kernel.runUntilIdle(scope, 'run');
  assert.equal(writes, 1); assert.equal(result.reason, 'effect_outcome_unknown');
  assert.ok(store.load(scope, 'run').receipts.some(row => row.result.results?.some(result => result.status === 'uncertain')));
});

test('dispatch/v2 crash takeover has no live proof and cannot replay a claimed write', async () => {
  const store = new MemoryRunStore(); let writes = 0;
  const { config, snapshot } = fixture({ tools: [tool({ readOnly: false, concurrentSafe: false, executionTimeoutPolicy: 'dispatch/v2' })] });
  const kernel = new NativeKernel({ store, digest, owner: 'survivor', ports: {
    model: { generate: async () => assert.fail('No model should run') },
    tools: { executionLifecycle: 'dispatch/v1', execute: async () => { writes++; return { status: 'ok', content: '' }; } },
  } });
  kernel.start(snapshot, config); const lease = store.acquire(scope, 'run', 'dead', 0, 1);
  const batch = prepareEffect(snapshot, 'tool', 'executing_tools', { calls: [{ callId: 'write', name: 'read', arguments: {} }] });
  store.commit(scope, 'run', lease, 0, 0, batch); store.claim(scope, 'run', lease, 0, batch.snapshot.pendingIntent);
  const result = await kernel.runUntilIdle(scope, 'run');
  assert.equal(result.reason, 'effect_outcome_unknown'); assert.equal(writes, 0);
});
