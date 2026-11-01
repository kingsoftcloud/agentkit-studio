import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeKernel, MemoryRunStore, configure, emptyUsage } from '@kingsoftcloud/agentkit-harness-core';
import { fixture, scope, digest, tool } from './fixtures/native-core.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { createNativeChildOwner } from '@kingsoftcloud/agentkit-harness-node/native/child-owner';
import { createNativeHostInteraction } from '../src/providers/native-host-interaction.mjs';

const childScope = { ...scope, agentId: 'child' };
const start = tool({ name: 'native_start_child', childBudgetPolicy: 'start/v1', readOnly: false, concurrentSafe: false,
  parameters: { type: 'object', required: ['role', 'task'], properties: { role: { type: 'string' }, task: { type: 'string' } } } });
const write = tool({ name: 'child_write', readOnly: false, concurrentSafe: false });
const response = (text, toolCalls = []) => ({ kind: toolCalls.length ? 'tool_calls' : 'final_candidate', text, toolCalls, usage: emptyUsage() });
function setup(t, sqlite) {
  const dir = mkdtempSync(join(tmpdir(), 'native-host-child-approval-'));
  const store = sqlite ? new SqliteRunStore(join(dir, 'runs.sqlite')) : new MemoryRunStore();
  let writes = 0;
  const owner = createNativeChildOwner({ scope, childScopes: [childScope], store, resolveChild: async request => ({
    scope: childScope, configuration: configure({ profile: fixture().config.profile, hostBindingDigest: 'approved-child',
      contract: { objective: request.call.arguments.task }, tools: [write], limits: { maxModelCalls: 3, maxToolCalls: 2 } }),
    ports: { model: { generate: async request => request.messages.some(message => message.role === 'tool') ? response('Child finished')
      : response('', [{ callId: 'child-write', name: write.name, arguments: {} }]) }, tools: { execute: async request => {
      if (!request.interaction) return { status: 'approval_required', interactionId: 'child-host-decision', content: null };
      if (request.interaction.decision !== 'allow') return { status: 'error', content: 'Denied' };
      writes++; return { status: 'ok', content: 'Written' };
    } } },
  }) });
  t.after(async () => { await owner.releaseRun({ scope, runId: 'run' }); store.close?.(); rmSync(dir, { recursive: true, force: true }); });
  const { config, snapshot } = fixture({ tools: [start], childLifecyclePolicy: 'owned-background/v2', childApprovalPolicy: 'owned-child-approval/v1',
    limits: { maxModelCalls: 12, maxToolCalls: 12, effectTimeoutMs: 120000 } });
  const kernel = new NativeKernel({ store, digest, owner: 'parent', ports: { children: owner,
    tools: { execute: request => owner.start(request) }, model: { generate: async request => request.messages.some(message => message.role === 'tool')
      ? response('Parent result') : response('', [{ callId: 'start', name: start.name, arguments: { role: 'worker', task: 'Bounded child task' } }]) } } });
  kernel.start(snapshot, config);
  return { store, kernel, writes: () => writes };
}
for (const sqlite of [false, true]) {
  for (const decision of ['allowed-once', 'rejected']) {
    test(`${sqlite ? 'sqlite' : 'memory'}: Host ${decision} resumes the exact ledger-owned child approval`, { timeout: 10000 }, async t => {
      const { store, kernel, writes } = setup(t, sqlite);
      const pending = await kernel.runUntilIdle(scope, 'run');
      assert.equal(pending.phase, 'awaiting_interaction'); assert.ok(pending.childApproval); assert.equal(writes(), 0);
      let asks = 0;
      const agent = { session: { id: pending.sessionId } }, signal = new AbortController().signal;
      const interact = createNativeHostInteraction({ store, ctx: { get: () => ({ request: async request => {
        asks++; assert.equal(request.agent, agent); assert.equal(request.signal, signal);
        assert.equal(request.callId, pending.pendingInteraction.hostInteractionId); assert.equal(request.toolName, write.name);
        assert.match(request.reason, new RegExp(pending.childApproval.childRunId)); return decision;
      } }) } });
      await assert.rejects(interact({ agent: { session: { id: 'other' } }, signal }, pending), /approval_session_mismatch/);
      const forged = structuredClone(pending); forged.childApproval.definitionDigest = '0'.repeat(64);
      await assert.rejects(interact({ agent, signal }, forged), /approval_checkpoint_stale/);
      assert.equal(asks, 0);
      const command = await interact({ agent, signal }, pending);
      assert.equal(command.kind, 'submit_interaction');
      assert.equal(command.payload.interactionId, pending.pendingInteraction.interactionId);
      assert.equal(command.payload.decision, decision === 'allowed-once' ? 'allow' : 'deny');
      kernel.submit(scope, 'run', command);
      const result = await kernel.runUntilIdle(scope, 'run');
      assert.equal(result.phase, 'completed'); assert.equal(writes(), decision === 'allowed-once' ? 1 : 0); assert.equal(asks, 1);
      assert.ok(result.childBudgetReservations.every(item => item.settledUsageDigest !== null));
      await assert.rejects(interact({ agent, signal }, pending), /approval_checkpoint_stale/);
      assert.equal(asks, 1);
    });
  }
  test(`${sqlite ? 'sqlite' : 'memory'}: an approval reply cannot authorize a child after cancellation`, { timeout: 10000 }, async t => {
    const { store, kernel, writes } = setup(t, sqlite);
    const pending = await kernel.runUntilIdle(scope, 'run');
    const interact = createNativeHostInteraction({ store, ctx: { get: () => ({ request: async () => {
      kernel.submit(scope, 'run', { commandId: 'cancel-during-approval', kind: 'cancel', payload: {} });
      await kernel.runUntilIdle(scope, 'run'); return 'allowed-once';
    } }) } });
    await assert.rejects(interact({ agent: { session: { id: pending.sessionId } }, signal: new AbortController().signal }, pending), /approval_checkpoint_stale/);
    assert.equal(store.load(scope, 'run').snapshot.phase, 'canceled'); assert.equal(writes(), 0);
  });
}
