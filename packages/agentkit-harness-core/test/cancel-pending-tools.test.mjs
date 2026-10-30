import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeKernel, MemoryRunStore, emptyUsage } from '../dist/index.mjs';
import { reduceCommand } from '../dist/transitions.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { fixture, tool, scope, digest } from './fixtures.mjs';

for (const backend of ['memory', 'sqlite']) for (const kind of ['cancel', 'policy_revoked'])
  test(`${backend}: ${kind} closes approval-gated and queued calls without inventing an execution`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'native-cancel-queue-')), file = join(root, 'run.sqlite');
    let store = backend === 'sqlite' ? new SqliteRunStore(file) : new MemoryRunStore();
    t.after(() => { store.close?.(); rmSync(root, { recursive: true, force: true }); });
    const { config, snapshot } = fixture({ tools: [tool({ name: 'write', readOnly: false, concurrentSafe: false })] });
    const calls = ['approval', 'queued'].map(callId => ({ callId, name: 'write', arguments: {} }));
    let models = 0, attempts = 0;
    const ports = { model: { generate: async () => {
      assert.equal(++models, 1);return { kind: 'tool_calls', text: '', toolCalls: calls, usage: emptyUsage() };
    } }, tools: { execute: async () => {
      assert.equal(++attempts, 1);return { status: 'approval_required', interactionId: 'original-approval', content: null };
    } } };
    let kernel = new NativeKernel({ store, digest, owner: 'original', ports });kernel.start(snapshot, config);
    assert.equal((await kernel.runUntilIdle(scope, 'run')).phase, 'awaiting_interaction');
    const before = structuredClone(store.load(scope, 'run').receipts);
    if (backend === 'sqlite') { store.close();store = new SqliteRunStore(file); }
    kernel = new NativeKernel({ store, digest, owner: 'replacement', ports });
    kernel.submit(scope, 'run', { commandId: 'stop', kind, payload: {} });
    const result = await kernel.runUntilIdle(scope, 'run'), record = store.load(scope, 'run');
    assert.equal(result.phase, kind === 'cancel' ? 'canceled' : 'failed');assert.equal(result.usage.toolCalls, 0);
    assert.equal(models, 1);assert.equal(attempts, 1);assert.deepEqual(record.receipts, before);
    assert.deepEqual(record.events.filter(event => event.kind === 'tool.not_dispatched').map(event => event.payload.callId), ['approval', 'queued']);
    assert.equal(record.events.some(event => event.kind === 'approval.resolved'), false);
    const results = result.messages.filter(message => message.role === 'tool');assert.equal(results.length, 2);
    for (const message of results) assert.deepEqual(JSON.parse(message.content), {
      status: 'not_dispatched', reason: kind === 'cancel' ? 'user_canceled' : 'policy_revoked', executed: false });
    if (backend === 'sqlite') assert.deepEqual(store.observation(scope, 'run').facts.toolStates.idle.calls.map(call => call.status),
      ['not_dispatched', 'not_dispatched'], 'The incremental display observation consumes committed facts, not the old approval preview');
  });

test('cancellation does not label a claimed effect or receipt reconciliation as undispatched', () => {
  const { snapshot } = fixture();
  const call = { callId: 'unknown', name: 'write', arguments: {} };
  for (const extra of [{ pendingIntent: 'running-tool' }, { toolReconciliation: { originalOperationKey: 'original' } }]) {
    const source = { ...snapshot, phase: 'executing_tools', pendingTools: [call], ...extra };
    const pending = source.pendingIntent ? { kind: 'tool', operationKey: source.pendingIntent,
      status: 'running', payload: { calls: [call] } } : null;
    const reduced = reduceCommand(source, { commandId: 'stop', kind: 'cancel', payload: {} }, pending);
    assert.equal(reduced.events.some(event => event.kind === 'tool.not_dispatched'), false);
    assert.deepEqual(reduced.snapshot.messages, snapshot.messages);
  }
});
