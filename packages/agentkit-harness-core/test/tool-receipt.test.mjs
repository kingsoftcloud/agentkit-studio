import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeKernel, MemoryRunStore, emptyUsage, canonical, prepareEffect, hookResult } from '../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { fixture, tool, scope, digest } from './fixtures.mjs';
const contract = 'agentkit.tool-receipt-observation/v1';
const definition = () => tool({ name: 'remote', readOnly: false, concurrentSafe: false, recoveryPolicy: 'receipt-observation/v1' });
const final = () => ({ kind: 'final_candidate', text: 'Finished', toolCalls: [], usage: emptyUsage() });
for (const backend of ['memory', 'sqlite']) {
  async function setup(t, overrides = {}) {
    const directory = mkdtempSync(join(tmpdir(), 'native-tool-receipt-')), path = join(directory, 'run.sqlite');
    let store = backend === 'memory' ? new MemoryRunStore() : new SqliteRunStore(path);
    let executions = 0, queries = 0, models = 0; const executedNames = [];
    let result = { status: 'ok', content: { originalRemoteResult: 42 } }, observe;
    const { initialResult, initialCalls = [{ callId: 'original', name: 'remote', arguments: { input: 'original' } }], ...configOverrides } = overrides;
    const data = fixture({ tools: [definition()], ...configOverrides });
    const ports = { model: { generate: async request => {
      models++;
      if (models === 1) return { kind: 'tool_calls', text: '', usage: emptyUsage(),
        toolCalls: initialCalls };
      assert.equal(request.messages.filter(message => message.role === 'tool').length, initialCalls.length);
      return final();
    } }, tools: { execute: async request => { executions++; executedNames.push(request.call.name);
      if (request.call.name !== 'remote') return { status: 'ok', content: 'ordinary read' };
      return initialResult ?? { status: 'uncertain', content: { code: 'remote_still_running' } }; },
      observeReceipt: async request => { queries++; return observe ? observe(request) : {
        contract, originalOperationKey: request.originalOperationKey, callId: request.call.callId, result }; } } };
    let kernel = new NativeKernel({ store, ports, digest, owner: 'original' });
    kernel.start(data.snapshot, data.config);
    const waiting = await kernel.runUntilIdle(scope, 'run');
    assert.equal(waiting.phase, 'awaiting_reconciliation');
    const originalKey = waiting.toolReconciliation.operationKey;
    const originalIntent = canonical(store.load(scope, 'run').intents.find(intent => intent.operationKey === originalKey));
    const originalReceipt = canonical(store.load(scope, 'run').receipts.find(receipt => receipt.operationKey === originalKey));
    t.after(() => { store.close?.(); rmSync(directory, { recursive: true, force: true }); });
    const f = { waiting, originalKey, ports, executedNames,
      kernel: () => kernel, store: () => store, counts: () => ({ executions, queries, models }),
      setResult(value) { result = value; }, setObserver(value) { observe = value; },
      async reconcile(id = 'observe') { kernel.reconcileTool(scope, 'run', originalKey, id); return kernel.runUntilIdle(scope, 'run'); },
      intact() {
        const current = store.load(scope, 'run');
        assert.equal(canonical(current.intents.find(intent => intent.operationKey === originalKey)), originalIntent);
        assert.equal(canonical(current.receipts.find(receipt => receipt.operationKey === originalKey)), originalReceipt);
      },
      reopen() {
        if (backend === 'sqlite') { store.close(); store = new SqliteRunStore(path); }
        kernel = new NativeKernel({ store, ports, digest, owner: 'replacement' });
      } };
    return f;
  }
  test(`${backend}: original run waits without replay and explicitly admits an original receipt once`, async t => {
    const f = await setup(t); await f.kernel().runUntilIdle(scope, 'run');
    assert.deepEqual(f.counts(), { executions: 1, queries: 0, models: 1 });
    const waiting = f.waiting;
    f.setObserver(request => {
      assert.equal(request.contract, contract); assert.equal(request.originalOperationKey, f.originalKey);
      assert.notEqual(request.operationKey, f.originalKey); assert.equal(request.call.callId, waiting.toolReconciliation.callId);
      assert.deepEqual(request.call.arguments, { input: 'original' });
      assert.ok(request.executionFence > request.originalClaimedFence);
      const ledger = f.store().load(scope, 'run');
      assert.equal(ledger.intents.at(-1).kind, 'tool_receipt'); assert.equal(ledger.intents.at(-1).status, 'running');
      return { contract, originalOperationKey: request.originalOperationKey, callId: request.call.callId,
        result: { status: 'ok', content: { originalRemoteResult: 42 } } };
    });
    f.reopen(); const done = await f.reconcile();
    assert.equal(done.phase, 'completed'); assert.equal(done.runId, waiting.runId); assert.equal(done.usage.toolCalls, 1);
    assert.equal(done.messages.filter(message => message.role === 'tool').length, 1);
    assert.deepEqual(JSON.parse(done.messages.find(message => message.role === 'tool').content), { originalRemoteResult: 42 });
    assert.equal(done.toolReconciliation, null); f.intact();
    assert.equal(f.kernel().reconcileTool(scope, 'run', f.originalKey, 'observe').status, 'duplicate');
    await f.kernel().runUntilIdle(scope, 'run');
    assert.deepEqual(f.counts(), { executions: 1, queries: 1, models: 2 });
    assert.equal(f.store().load(scope, 'run').events.filter(event => event.kind === 'tool.receipt_reconciled').length, 1);
  });
  test(`${backend}: unavailable read is durable, cold duplicate never repeats it, a new read can continue`, async t => {
    const f = await setup(t); f.setResult(null);
    assert.equal((await f.reconcile()).phase, 'awaiting_reconciliation'); f.intact();
    f.reopen(); f.setResult({ status: 'ok', content: 'known now' });
    assert.equal((await f.reconcile()).phase, 'awaiting_reconciliation');
    assert.equal(f.counts().queries, 1);
    assert.equal((await f.reconcile('observe-again')).phase, 'completed');
    assert.deepEqual(f.counts(), { executions: 1, queries: 2, models: 2 }); f.intact();
  });
  for (const mode of ['wrong-operation', 'wrong-call', 'unknown-result', 'fabricated-child', 'fabricated-background', 'oversized-utf8']) {
    test(`${backend}: ${mode} cannot become a successful original receipt`, async t => {
      const f = await setup(t);
      f.setObserver(request => ({ contract, originalOperationKey: mode === 'wrong-operation' ? 'another' : request.originalOperationKey,
        callId: mode === 'wrong-call' ? 'another' : request.call.callId,
        result: mode === 'unknown-result' ? { status: 'uncertain', content: null }
          : mode === 'fabricated-child' ? { status: 'ok', content: 'claimed', childRunIds: ['not-owned'] }
            : mode === 'fabricated-background' ? { status: 'ok', content: 'claimed', backgroundCommandRef: { taskId: 'not-owned' } }
            : { status: 'ok', content: mode === 'oversized-utf8' ? '中'.repeat(30000) : 'claimed' } }));
      const result = await f.reconcile(); assert.equal(result.phase, 'awaiting_reconciliation');
      assert.equal(result.messages.some(message => message.role === 'tool'), false);
      assert.deepEqual(f.counts(), { executions: 1, queries: 1, models: 1 }); f.intact();
    });
  }
  test(`${backend}: caller cannot inject results or replace original operation with a reconcile command`, async t => {
    const f = await setup(t);
    for (const payload of [{ originalOperationKey: 'another' }, { originalOperationKey: f.originalKey, result: { status: 'ok', content: 'forged' } }]) {
      f.kernel().submit(scope, 'run', { kind: 'reconcile_tool', commandId: digest(payload), payload });
      assert.equal((await f.kernel().runUntilIdle(scope, 'run')).phase, 'awaiting_reconciliation');
    }
    assert.equal(f.counts().queries, 0); f.intact();
  });
  test(`${backend}: steering and boundary guidance cannot bypass a pending original effect`, async t => {
    const f = await setup(t, { guidancePolicy: 'boundary-guide/v1' });
    for (const kind of ['steer', 'guide']) {
      f.kernel().submit(scope, 'run', { kind, commandId: kind, payload: { text: 'replace goal' } });
      const result = await f.kernel().runUntilIdle(scope, 'run');
      assert.equal(result.phase, 'awaiting_reconciliation'); assert.equal(result.goal, f.waiting.goal);
    }
    f.kernel().submit(scope, 'run', { kind: 'pause', commandId: 'pause', payload: {} });
    assert.equal((await f.kernel().runUntilIdle(scope, 'run')).phase, 'paused');
    assert.equal((await f.reconcile('paused-read')).phase, 'paused'); assert.equal(f.counts().queries, 0);
    f.kernel().submit(scope, 'run', { kind: 'resume', commandId: 'resume', payload: {} });
    assert.equal((await f.kernel().runUntilIdle(scope, 'run')).phase, 'awaiting_reconciliation'); f.intact();
  });
  test(`${backend}: cancellation during an uncooperative receipt lookup prevents late revival`, async t => {
    const f = await setup(t), entered = Promise.withResolvers(), delayed = Promise.withResolvers();
    f.setObserver(request => { entered.resolve(request); return delayed.promise; });
    const running = f.reconcile(); const request = await entered.promise;
    f.kernel().submit(scope, 'run', { kind: 'cancel', commandId: 'cancel', payload: {} });
    assert.equal((await running).phase, 'canceled');
    delayed.resolve({ contract, originalOperationKey: request.originalOperationKey, callId: request.call.callId,
      result: { status: 'ok', content: 'late' } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.store().load(scope, 'run').snapshot.phase, 'canceled');
    assert.equal(f.store().load(scope, 'run').events.some(event => event.kind === 'tool.receipt_reconciled'), false);
    assert.deepEqual(f.counts(), { executions: 1, queries: 1, models: 1 }); f.intact();
  });
  test(`${backend}: a stolen lease fences a late receipt and a replacement retires the original read`, async t => {
    const f = await setup(t), entered = Promise.withResolvers(), delayed = Promise.withResolvers();
    f.setObserver(request => { entered.resolve(request); return delayed.promise; });
    const running = f.reconcile(); const request = await entered.promise;
    const stolen = f.store().acquire(scope, 'run', 'takeover', Date.now() + 1000000, 1);
    f.store().release(scope, 'run', stolen);
    delayed.resolve({ contract, originalOperationKey: request.originalOperationKey, callId: request.call.callId,
      result: { status: 'ok', content: 'stale' } });
    await assert.rejects(running, { code: 'stale_fence' });
    assert.equal(f.store().load(scope, 'run').snapshot.messages.some(message => message.role === 'tool'), false);
    f.reopen(); assert.equal((await f.kernel().runUntilIdle(scope, 'run')).phase, 'awaiting_reconciliation');
    assert.equal(f.counts().queries, 1); f.intact();
  });
  test(`${backend}: a resolved error is an original tool response without another execution`, async t => {
    const f = await setup(t); f.setResult({ status: 'error', content: { code: 'remote_failed' },
      resourceUsage: { ...emptyUsage(), inputTokens: 12, modelCalls: 1 }, resourceUsageReported: false });
    const done = await f.reconcile(); assert.equal(done.phase, 'completed');
    assert.equal(done.descendantUsage.inputTokens, 12); assert.equal(done.descendantUsage.modelCalls, 1);
    assert.equal(done.diagnostics.descendantUsageIncomplete, true); assert.equal(done.usage.toolCalls, 1);
    assert.equal(f.store().load(scope, 'run').events.filter(event => event.kind === 'usage.unavailable'
      && event.payload.requestId.endsWith(':tool_receipt')).length, 1);
    f.intact();
  });
  test(`${backend}: known original usage and newly observed usage are distinct additive deltas`, async t => {
    const f = await setup(t, { initialResult: { status: 'uncertain', content: null,
      resourceUsage: { ...emptyUsage(), inputTokens: 5 }, resourceUsageReported: true } });
    assert.equal(f.waiting.descendantUsage.inputTokens, 5);
    f.setResult({ status: 'ok', content: 'resolved', resourceUsage: { ...emptyUsage(), inputTokens: 7 }, resourceUsageReported: true });
    const result = await f.reconcile(); assert.equal(result.descendantUsage.inputTokens, 12);
    const facts = f.store().load(scope, 'run').events.filter(event => event.kind === 'usage.reported' && event.payload.source === 'tool_resources');
    assert.deepEqual(facts.map(event => event.payload.usage.inputTokens), [5, 7]); f.intact();
  });
  test(`${backend}: post-tool hooks run once after the verified result and retain original call identity`, async t => {
    const f = await setup(t, { hooks: [{ hookId: 'post', sourceRef: 'host://post', bindingDigest: `sha256:${'a'.repeat(64)}`,
      executionPolicyDigest: `sha256:${'b'.repeat(64)}`, readOnly: true, events: ['PostToolUse'], timeoutMs: 100,
      maxInputBytes: 64000, maxOutputBytes: 64000, failureMode: 'block' }] });
    let hooks = 0;
    f.ports.hooks = { invoke: async request => {
      hooks++; assert.equal(request.input.call.callId, f.waiting.toolReconciliation.callId);
      return hookResult(request, 'ok', { action: 'continue', additionalContext: [], updatedArguments: null });
    } };
    const result = await f.reconcile(); assert.equal(result.phase, 'completed'); assert.equal(hooks, 1); f.intact();
  });
  for (const readFirst of [false, true]) test(`${backend}: mixed model tool calls isolate receipt recovery (${readFirst ? 'read first' : 'remote first'})`, async t => {
    const remote = { callId: 'remote-call', name: 'remote', arguments: {} }, read = { callId: 'read-call', name: 'read', arguments: {} };
    const f = await setup(t, { tools: [definition(), tool()], initialCalls: readFirst ? [read, remote] : [remote, read] });
    assert.equal(f.waiting.pendingTools[0].name, 'remote');
    const done = await f.reconcile(); assert.equal(done.phase, 'completed');
    assert.equal(done.usage.toolCalls, 2); assert.equal(done.messages.filter(message => message.role === 'tool').length, 2);
    assert.deepEqual(f.executedNames, readFirst ? ['read', 'remote'] : ['remote', 'read']);
    assert.ok(f.store().load(scope, 'run').intents.filter(intent => intent.kind === 'tool').every(intent => intent.payload.calls.length === 1));
    f.intact();
  });
  test(`${backend}: missing receipt port stays explicit without falling back to execute`, async t => {
    const f = await setup(t); delete f.ports.tools.observeReceipt;
    assert.equal((await f.reconcile()).phase, 'awaiting_reconciliation');
    assert.equal(f.counts().executions, 1); f.intact();
  });
  test(`${backend}: lost read claim retires separately and never replays the original effect or query`, async t => {
    const f = await setup(t); const lease = f.store().acquire(scope, 'run', 'lost', 1, 1);
    const current = f.store().load(scope, 'run').snapshot;
    const batch = prepareEffect(current, 'tool_receipt', 'reconciling_tool', { contract, originalOperationKey: f.originalKey,
      originalClaimedFence: f.store().load(scope, 'run').intents.find(intent => intent.operationKey === f.originalKey).claimedFence,
      callId: current.toolReconciliation.callId });
    f.store().commit(scope, 'run', lease, 1, current.revision, batch);
    f.store().claim(scope, 'run', lease, 1, batch.snapshot.pendingIntent); f.reopen();
    const recovery = new NativeKernel({ store: f.store(), ports: f.ports, digest, owner: 'clocked-recovery', now: () => 100 });
    const recovered = await recovery.runUntilIdle(scope, 'run');
    assert.equal(recovered.phase, 'awaiting_reconciliation');
    assert.equal(recovered.activeElapsedMs, current.activeElapsedMs + 99, 'lost query time remains charged');
    assert.deepEqual(f.counts(), { executions: 1, queries: 0, models: 1 });
    assert.equal((await f.reconcile()).phase, 'completed'); f.intact();
  });
}
test('receipt recovery policy rejects parallel or independently owned lifecycle tools', () => {
  for (const change of [{ concurrentSafe: true, readOnly: true }, { childBudgetPolicy: 'start/v1' },
    { backgroundCommandPolicy: 'owned-command-launch/v1' }, { observationRole: 'browser' }]) {
    assert.throws(() => fixture({ tools: [{ ...definition(), ...change }] }));
  }
});
