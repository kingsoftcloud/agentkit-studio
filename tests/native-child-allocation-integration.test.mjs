import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeKernel, MemoryRunStore, emptyUsage, admittedToolBudget } from '@kingsoftcloud/agentkit-harness-core';
import { nativeChildToolDefinitions } from '@kingsoftcloud/agentkit-harness-node/native/child-tools';
import { workspaceToolDefinitions } from '@kingsoftcloud/agentkit-harness-node/native/workspace-tools';
import { fixture, scope, digest } from '../packages/agentkit-harness-core/test/fixtures.mjs';
import { createStudioNativeChildren, nativeChildRoles } from '../src/providers/native-subagents.mjs';

test('two actual Studio child admissions share the parent ledger, reserve finalization and freeze child-owned model facts', { timeout: 10000 }, async t => {
  const policy = 'parent-shared/v1', store = new MemoryRunStore();
  const roles = nativeChildRoles({ subAgents: [{ name: 'reader', instructions: 'Inspect assigned evidence.',
    tools: ['read_workspace_file'] }] }, { childAllocationPolicy: policy });
  let release; const gate = new Promise(resolve => { release = resolve; });
  const children = await createStudioNativeChildren({ roles, scope, sessionId: 'session', store,
    childAllocationPolicy: policy, tools: workspaceToolDefinitions(), hasSkills: false, hasMcp: false,
    modelSurface: { contract: 'bound-model-surface/v1', environment: { workspaceRoot: '/bound/work', cwd: '/bound/work',
      platform: 'linux', date: '2026-10-28', commandBackend: 'none', supportsImages: true } },
    resolveModel: async () => ({ profile: { ...fixture().config.profile, supportsImages: false, requestTimeoutMs: 60000 }, supportsImages: false,
      model: { generate: async request => { await gate; request.signal.throwIfAborted();
        return { kind: 'final_candidate', text: 'Observed.', toolCalls: [], usage: emptyUsage() }; } } }),
    bindTools: () => ({ tools: { execute: async () => ({ status: 'ok', content: 'Observed.' }) } }),
    verificationFactory: async () => ({ verify: async () => ({ status: 'passed', evidence: [] }) }),
  });
  t.after(async () => { release(); await children.owner.releaseRun({ scope, runId: 'run' }); });
  const start = nativeChildToolDefinitions(['reader'])[0];
  const { config, snapshot } = fixture({ tools: [start], limits: { maxModelCalls: 25, maxToolCalls: 200,
    finalizationReserveModelCalls: 1, effectTimeoutMs: 130000 }, childLifecyclePolicy: 'owned-background/v2' });
  let rounds = 0, paused = false, failure;
  const parent = new NativeKernel({ store, owner: 'allocation-integration', digest,
    ports: { children: children.owner, tools: { execute: async request => {
      try { return await children.owner.start(request); } catch (error) { failure = error.code ?? error.message; throw error; }
    } },
      model: { generate: async () => ({ kind: 'tool_calls', text: '', usage: emptyUsage(),
        toolCalls: [{ callId: `start-${++rounds}`, name: start.name,
          arguments: { role: 'reader', task: `Inspect partition ${rounds}` } }] }) } },
    onCheckpoint: async current => {
      if (!paused && current.childBudgetReservations?.length === 2) {
        paused = true; parent.submit(scope, 'run', { commandId: 'hold-two-reservations', kind: 'pause', payload: {} });
      }
    } });
  parent.start(snapshot, config);
  const held = await parent.runUntilIdle(scope, 'run');
  assert.equal(held.phase, 'paused', JSON.stringify({ reason: held.reason, failure })); assert.equal(rounds, 2);
  assert.deepEqual(held.childBudgetReservations.map(item => item.maxModelCalls), [16, 6]);
  assert.equal(admittedToolBudget(held, config).maxModelCallsRemaining, 0);
  assert.equal(held.usage.modelCalls, 2);
  for (const reservation of held.childBudgetReservations) {
    assert.equal(reservation.settledUsageDigest, null);
    const child = store.load(reservation.childScope, reservation.childRunId);
    assert.equal(child.configuration.childOwnerBinding.childAllocationPolicy, policy);
    assert.equal(child.configuration.modelSurface.environment.cwd, '/bound/work');
    assert.equal(child.configuration.modelSurface.environment.supportsImages, false);
    assert.equal(child.configuration.modelSurface.environment.commandBackend, 'none');
    assert.equal(child.snapshot.messages.filter(message => message.kind === 'runtime_environment').length, 1);
  }
});
