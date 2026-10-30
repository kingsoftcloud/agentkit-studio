import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeKernel, MemoryRunStore, emptyUsage, admittedToolBudget, canonical } from '@kingsoftcloud/agentkit-harness-core';
import { nativeChildToolDefinitions } from '@kingsoftcloud/agentkit-harness-node/native/child-tools';
import { workspaceToolDefinitions, createNativeWorkspaceTools } from '@kingsoftcloud/agentkit-harness-node/native/workspace-tools';
import { mkdtemp, mkdir, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeWorkspaceContextBinding } from '../src/native/workspace-context.mjs';
import { createStudioNativeChildWorkspaces } from '../src/native/child-workspace-binding.mjs';
import { fixture, scope, digest, verificationReport } from '../../agentkit-harness-core/test/fixtures.mjs';
import { createNativeChildren, nativeChildRoles } from '../src/native/children.mjs';

for (const isolated of [false, true]) test(`child models use current root and discovered scoped guidance in their ${isolated ? 'isolated write' : 'shared read'} workspace`, { timeout: 10000 }, async t => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'child-current-instructions-'));
  const root = join(directory, 'workspace'); await mkdir(join(root, 'pkg'), { recursive: true });
  await writeFile(join(root, 'AGENTS.md'), 'CHILD_ROOT_RULE');
  await writeFile(join(root, 'pkg', 'AGENTS.md'), 'CHILD_NESTED_RULE');
  await writeFile(join(root, 'pkg', 'file.ts'), 'export const value = 1;\n');
  const store = new MemoryRunStore(), roles = nativeChildRoles({ subAgents: [{ name: 'reader',
    instructions: 'Inspect the assigned file.', maxTurns: 4, concurrentSafe: !isolated,
    tools: ['read_workspace_file', ...(isolated ? ['write_workspace_file'] : [])] }] });
  let models = 0, childRoot;
  const contextPolicy = { tokenizerId: 'child', tokenizerDigest: 'child/v1', enabled: false, triggerRatio: .9, targetRatio: .5,
    summaryMaxTokens: 100, maxCompactions: 1, maxCompactionsWithoutProgress: 1, minModelTurnsBetween: 1, maxSummaryRetries: 1 };
  const children = await createNativeChildren({ roles, scope, sessionId: 'session', store, tools: workspaceToolDefinitions(),
    workspaceContext: nativeWorkspaceContextBinding(root, { instructionRoots: [] }),
    fileWorkspaces: createStudioNativeChildWorkspaces({ workspaceRoot: root, stateDir: join(directory, 'isolated') }),
    resolveModel: async () => ({ profile: fixture().config.profile, supportsImages: false, contextPolicy,
      context: { tokens: { tokenizerId: 'child', tokenizerDigest: 'child/v1',
        countText: async ({ text }) => Math.ceil(text.length / 4),
        countRequest: async ({ messages }) => Math.ceil(canonical(messages).length / 4) } },
      model: { generate: async request => {
        models++;
        assert.match(canonical(request.messages), /CHILD_ROOT_RULE/);
        assert.equal(canonical(request.messages).includes('CHILD_NESTED_RULE'), models > 1);
        if (models === 1) return { kind: 'tool_calls', text: '', usage: emptyUsage(),
          toolCalls: [{ callId: 'child-read', name: 'read_workspace_file', arguments: { path: 'pkg/file.ts' } }] };
        return { kind: 'final_candidate', text: 'Inspected.', toolCalls: [], usage: emptyUsage() };
      } } }),
    bindTools: options => {
      childRoot = options.workspaceRoot ?? root;
      const workspace = createNativeWorkspaceTools({ workspaceRoot: childRoot, stateDir: join(directory, 'read-state'), sessionId: options.sessionId });
      return { tools: { execute: request => workspace.execute(request) } };
    },
    verificationFactory: async () => ({ verify: async request => verificationReport(request, { checks: [] }) }),
  });
  t.after(async () => { await children.owner.releaseRun({ scope, runId: 'run' }); await rm(directory, { recursive: true, force: true }); });
  const start = nativeChildToolDefinitions(['reader'])[0];
  const { config, snapshot } = fixture({ tools: [start], childLifecyclePolicy: 'owned-background/v2', limits: { effectTimeoutMs: 130000 } });
  let rounds = 0;
  const kernel = new NativeKernel({ store, digest, owner: 'parent', ports: { children: children.owner,
    tools: { execute: request => children.execute(request) }, model: { generate: async () => ++rounds === 1
      ? { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ callId: 'start', name: start.name,
        arguments: { role: 'reader', task: 'Inspect pkg/file.ts.', background: false } }] }
      : { kind: 'final_candidate', text: 'Delivered.', toolCalls: [], usage: emptyUsage() } } } });
  kernel.start(snapshot, config);
  const done = await kernel.runUntilIdle(scope, 'run');
  assert.equal(done.phase, 'completed', canonical({ reason: done.reason, models }));
  assert.equal(models, 2);
  assert.equal(childRoot === root, !isolated);
  const childScope = { ...scope, agentId: scope.agentId + ':child:reader' };
  const child = store.load(childScope, store.list(childScope)[0].runId);
  assert.equal(child.snapshot.phase, 'completed');
  assert.equal(child.configuration.hostRecoveryBinding.workspaceContext.workspaceRoot, childRoot);
  assert.deepEqual(child.snapshot.context.instructionScopes.directories, ['', 'pkg']);
  assert.doesNotMatch(canonical(child.snapshot.messages), /CHILD_ROOT_RULE|CHILD_NESTED_RULE/);
});

for (const toolExecutionPolicy of [undefined,'owner-execution/v1']) test(`two standalone child admissions freeze parent execution policy (${toolExecutionPolicy??'legacy'}) and child-owned model facts`, { timeout: 10000 }, async t => {
  const policy = 'parent-shared/v1', store = new MemoryRunStore();
  const roles = nativeChildRoles({ subAgents: [{ name: 'reader', instructions: 'Inspect assigned evidence.',
    tools: ['read_workspace_file'] }] }, { childAllocationPolicy: policy });
  let release; const gate = new Promise(resolve => { release = resolve; });
  const children = await createNativeChildren({ roles, scope, sessionId: 'session', store,
    childAllocationPolicy: policy, toolExecutionPolicy, tools: workspaceToolDefinitions(), hasSkills: false, hasMcp: false,
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
    assert.equal(child.configuration.toolExecutionPolicy,toolExecutionPolicy);
    assert.equal(child.configuration.childOwnerBinding.childAllocationPolicy, policy);
    assert.equal(child.configuration.modelSurface.environment.cwd, '/bound/work');
    assert.equal(child.configuration.modelSurface.environment.supportsImages, false);
    assert.equal(child.configuration.modelSurface.environment.commandBackend, 'none');
    assert.equal(child.snapshot.messages.filter(message => message.kind === 'runtime_environment').length, 1);
  }
});
