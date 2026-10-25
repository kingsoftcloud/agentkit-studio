import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeKernel, MemoryRunStore, emptyUsage } from '../packages/agentkit-harness-core/dist/index.mjs';
import { fixture, scope, digest, tool } from '../packages/agentkit-harness-core/test/fixtures.mjs';
import { SqliteRunStore } from '../packages/agentkit-harness/src/native/sqlite-store.mjs';
import { createNativeToolAuthority, createNativeToolReceiptAuthority, createNativeWorkspaceRepairAuthority } from '../src/providers/native-tool-authority.mjs';
import { createNativeHostInteraction } from '../src/providers/native-host-interaction.mjs';

for (const repair of [false, true]) for (const sqlite of [false, true]) test(`${sqlite ? 'SQLite' : 'Memory'}: ${repair ? 'repair' : 'receipt'} authority requires the actual new claim and exact original identity`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'receipt-authority-'));
  const store = sqlite ? new SqliteRunStore(join(root, 'runs.sqlite')) : new MemoryRunStore();
  t.after(() => { store.close?.(); rmSync(root, { recursive: true, force: true }); });
  const definition = tool({ name: repair ? 'write_workspace_file' : 'remote', readOnly: false, concurrentSafe: false, recoveryPolicy: 'receipt-observation/v1',
    ...(repair ? { workspaceCheckpointPolicy: 'file-preimages/v1', workspaceRepairPolicy: 'preimage-compensation/v1' } : {}) });
  const data = fixture({ tools: [definition] });
  let closed = false, observed;
  const authority = (repair ? createNativeWorkspaceRepairAuthority : createNativeToolReceiptAuthority)({ scope, sessionId: 'session', store, isClosed: () => closed });
  const other = (repair ? createNativeToolReceiptAuthority : createNativeWorkspaceRepairAuthority)({ scope, sessionId: 'session', store });
  const execute = createNativeToolAuthority({ scope, sessionId: 'session', store });
  const kernel = new NativeKernel({ store, digest, owner: 'actual-owner', ports: {
    model: { generate: async () => ({ kind: 'tool_calls', text: '', usage: emptyUsage(),
      toolCalls: [{ callId: 'original-call', name: definition.name, arguments: { original: 42 } }] }) },
    tools: { execute: async request => { assert.equal(execute(request), true); assert.equal(authority(request), false);
      return { status: 'uncertain', content: 'delivery unknown' }; },
    [repair ? 'repairWorkspace' : 'observeReceipt']: async request => {
      observed = request; assert.equal(authority(request), true); assert.equal(execute(request), false); assert.equal(other(request), false);
      assert.ok(request.executionFence > request.originalClaimedFence);
      for (const change of [
        { runId: 'other' }, { sessionId: 'other' }, { buildId: 'other' }, { turnId: 'other' }, { parentRunId: 'other' },
        { taskChainId: 'other' }, { scope: { ...scope, agentId: 'other' } }, { contract: 'other' },
        { originalOperationKey: 'other' }, { operationKey: request.originalOperationKey },
        { originalClaimedFence: request.executionFence }, { executionFence: request.originalClaimedFence },
        { call: { ...request.call, callId: 'other' } }, { call: { ...request.call, arguments: { original: 43 } } },
        { definition: { ...request.definition, readOnly: true } }, { signal: AbortSignal.abort() },
      ]) assert.equal(authority({ ...request, ...change }), false, JSON.stringify(change));
      closed = true; assert.equal(authority(request), false); closed = false;
      return { contract: request.contract, originalOperationKey: request.originalOperationKey, callId: request.call.callId, result: null };
    } },
  } });
  kernel.start(data.snapshot, data.config);
  const waiting = await kernel.runUntilIdle(scope, 'run'); assert.equal(waiting.phase, 'awaiting_reconciliation');
  const interact = createNativeHostInteraction({ store, ctx: { get: () => assert.fail('waiting must not ask for tool approval') } });
  await assert.rejects(interact({ agent: { session: { id: 'foreign' } }, signal: new AbortController().signal }, waiting), /session_mismatch/);
  await assert.rejects(interact({ agent: { session: { id: 'session' } }, signal: new AbortController().signal },
    { ...waiting, revision: waiting.revision + 1 }), /checkpoint_stale/);
  const wake = new AbortController(), idle = interact({ agent: { session: { id: 'session' } }, signal: wake.signal }, waiting);
  const woken = assert.rejects(idle, /wake-original/); wake.abort(Error('wake-original')); await woken;
  kernel.submit(scope, 'run', { commandId: 'query', kind: repair ? 'repair_workspace' : 'reconcile_tool',
    payload: { originalOperationKey: waiting.toolReconciliation.operationKey } });
  assert.equal((await kernel.runUntilIdle(scope, 'run')).phase, 'awaiting_reconciliation');
  assert.ok(observed); assert.equal(authority(observed), false, 'a completed query cannot authorize a later request');
});
