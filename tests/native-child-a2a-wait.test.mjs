// Local discovery only: real Kernel/owner/Memory or SQLite ledgers. The A2A
// tool returns a declared unknown receipt; no remote transport or Host authority
// is supplied. Mounted automatic adoption is verified separately.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configure, MemoryRunStore, emptyUsage, prepareEffect, transition, admittedToolBudget, reduceTools,
  settle, prepareChildLifecycle } from '../packages/agentkit-harness-core/dist/index.mjs';
import { fixture, scope, digest, tool } from '../packages/agentkit-harness-core/test/fixtures.mjs';
import { SqliteRunStore } from '../packages/agentkit-harness/src/native/sqlite-store.mjs';
import { createNativeChildOwner } from '../packages/agentkit-harness/src/native/child-owner.mjs';
import { nativeA2aToolDefinitions } from '../packages/agentkit-harness/src/native/a2a-tools.mjs';
import { nativeA2aReceiptWaitSource } from '../src/providers/native-a2a-receipt.mjs';
import { nativeChildA2aWaitSource, NATIVE_CHILD_A2A_WAIT } from '../src/providers/native-child-a2a-wait.mjs';
import { createStudioNativeRecovery } from '../src/host/services/native-recovery.mjs';
const childScope = { ...scope, agentId: 'child-agent' };
async function until(check) {
  for (let i = 0; i < 500; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw Error('Kernel did not reach the expected child checkpoint');
}
async function setup(t, backend, mixed = false) {
  const dir = mkdtempSync(join(tmpdir(), 'native-child-discovery-'));
  const store = backend === 'sqlite' ? new SqliteRunStore(join(dir, 'runs.sqlite')) : new MemoryRunStore();
  const definition = tool({ name: 'native_start_child', readOnly: false, concurrentSafe: false, childBudgetPolicy: 'start/v1' });
  const { config, snapshot } = fixture({ tools: [definition], childLifecyclePolicy: 'owned-background/v2',
    limits: { maxModelCalls: 20, maxToolCalls: 20 } });
  store.create(config, snapshot); const lease = store.acquire(scope, 'run', 'expired-parent', 10, 100);
  let idleCalls = 0, effects = 0;
  const owner = createNativeChildOwner({ scope, childScopes: [childScope], store, now: () => 22,
    canWaitForReceipt: record => !!nativeA2aReceiptWaitSource(record),
    waitForIdle: ({ signal }) => { idleCalls++; return new Promise(resolve => signal.addEventListener('abort', () => resolve(null), { once: true })); },
    resolveChild: async request => ({ scope: childScope,
      configuration: configure({ profile: config.profile, contract: { objective: request.task }, hostBindingDigest: 'discovery-fixture',
        tools: request.task === 'finished' ? [] : nativeA2aToolDefinitions({ receiptObservation: true }) }),
      ports: { model: { generate: async () => ({ kind: request.task === 'finished' ? 'final_candidate' : 'tool_calls', text: 'Child findings',
        toolCalls: request.task === 'finished' ? [] : [{ callId: 'original-a2a', name: 'call_a2a_agent', arguments: { agent: 'remote', message: 'original' } }], usage: emptyUsage() }) },
      tools: { execute: async () => { effects++; return { status: 'uncertain', content: { code: 'unknown' } }; } } } }),
  });
  t.after(async () => { await owner.releaseRun({ scope, runId: 'run' }); store.close?.(); rmSync(dir, { recursive: true, force: true }); });
  for (const task of mixed ? ['finished', 'waiting'] : ['waiting']) {
    const before = store.load(scope, 'run').snapshot;
    const call = { callId: task, name: definition.name, arguments: { role: 'worker', task } };
    const executing = store.commit(scope, 'run', lease, 22, before.revision, transition(before, { phase: 'executing_tools', pendingTools: [call],
      messages: [...before.messages, { role: 'assistant', content: '', toolCalls: [call] }] }));
    const batch = prepareEffect(executing, 'tool', 'executing_tools', { calls: [call], interaction: null });
    store.commit(scope, 'run', lease, 22, executing.revision, batch);
    const intent = store.claim(scope, 'run', lease, 22, batch.snapshot.pendingIntent), parent = store.load(scope, 'run').snapshot;
    const receipt = await owner.start({ ...Object.fromEntries(['scope', 'runId', 'sessionId', 'turnId', 'buildId', 'parentRunId', 'taskChainId'].map(key => [key, parent[key]])),
      operationKey: intent.operationKey, executionFence: lease.fence, signal: new AbortController().signal,
      call, definition, interaction: null, budget: admittedToolBudget(parent, config) });
    store.commit(scope, 'run', lease, 22, parent.revision, settle(parent, intent, { operationKey: intent.operationKey, status: 'committed', result: { results: [receipt] } },
      reduceTools(parent, [receipt], [call], intent, config, digest), 0));
    await until(() => store.load(childScope, receipt.childBudgetReservation.childRunId).snapshot.phase === (task === 'finished' ? 'completed' : 'awaiting_reconciliation'));
  }
  await until(() => idleCalls === 1);
  const before = store.load(scope, 'run').snapshot;
  const verifying = store.commit(scope, 'run', lease, 22, before.revision, transition(before, { phase: 'verifying',
    candidate: { candidateId: 'candidate', text: 'Parent draft', goalRevision: 0, workspaceRevision: null } }));
  const observation = prepareChildLifecycle(verifying, config); store.commit(scope, 'run', lease, 22, verifying.revision, observation);
  store.claim(scope, 'run', lease, 22, observation.snapshot.pendingIntent);
  return { store, record: () => store.load(scope, 'run'), effects: () => effects };
}

for (const backend of ['memory', 'sqlite']) {
  for (const mixed of [false, true]) test(`${backend}: original collector discovers ${mixed ? 'sealed terminal plus waiting children' : 'its sealed child A2A wait'} without advancing either ledger`, async t => {
    const f = await setup(t, backend, mixed), parent = f.record();
    const before = JSON.stringify(parent), children = parent.snapshot.childRunIds.map(id => JSON.stringify(f.store.load(childScope, id)));
    const source = nativeChildA2aWaitSource({ store: f.store, record: parent });
    assert.equal(source.contract, NATIVE_CHILD_A2A_WAIT); assert.equal(source.children.length, 1);
    assert.equal(source.operationKey, parent.snapshot.pendingIntent); assert.equal(f.effects(), 1);
    assert.equal(JSON.stringify(f.record()), before);
    assert.deepEqual(parent.snapshot.childRunIds.map(id => JSON.stringify(f.store.load(childScope, id))), children);
  });

  test(`${backend}: changed causal facts, live owners and unrelated unknown effects cannot become an automatic child wait`, async t => {
    const f = await setup(t, backend), original = f.record(), childId = original.snapshot.childRunIds[0], originalChild = f.store.load(childScope, childId);
    const cases = {
      'parent live lease': ({ parent }) => { parent.lease.expiresAt = Date.now() + 60000; },
      'child live lease': ({ child }) => { child.lease = { owner: 'other', fence: child.fence, expiresAt: Date.now() + 60000 }; },
      'direct child adoption': ({ parent }) => { parent.configuration.childOwnerBinding = originalChild.configuration.childOwnerBinding; },
      'parent configuration drift': ({ parent }) => { parent.configuration.instructions += 'changed'; },
      'unclaimed collector': ({ parent }) => { parent.intents.find(row => row.operationKey === parent.snapshot.pendingIntent).status = 'prepared'; },
      'foreign collector reservation': ({ parent }) => { parent.intents.find(row => row.operationKey === parent.snapshot.pendingIntent).payload.reservations = []; },
      'cancel collector': ({ parent }) => { parent.intents.find(row => row.operationKey === parent.snapshot.pendingIntent).payload.action = 'cancel'; },
      'ordinary child approval': ({ parent }) => { parent.intents.find(row => row.operationKey === parent.snapshot.pendingIntent).payload.childApproval = { childRunId: childId }; },
      'missing committed start': ({ parent }) => { parent.receipts = parent.receipts.filter(row => row.operationKey !== parent.snapshot.childBudgetReservations[0].parentOperationKey); },
      'foreign parent binding': ({ child }) => { child.configuration.childOwnerBinding.parent.sessionId = 'other'; },
      'child configuration drift': ({ child }) => { child.configuration.instructions += 'changed'; },
      'unrelated unknown effect': ({ child }) => { child.snapshot.phase = 'interrupted'; },
      'wrong original call': ({ child }) => { child.snapshot.toolReconciliation.callId = 'foreign'; },
      'missing original receipt': ({ child }) => { child.receipts = []; },
      'superseded child head': state => { state.head = { runId: 'replacement' }; },
      'already settled allocation': ({ parent }) => { parent.snapshot.childBudgetReservations[0].settledUsageDigest = 'settled'; },
    };
    for (const [name, change] of Object.entries(cases)) {
      const state = { parent: structuredClone(original), child: structuredClone(originalChild), head: f.store.sessionHead(childScope, originalChild.snapshot.sessionId) };
      change(state);
      const view = { load: (_scope, id) => structuredClone(id === childId ? state.child : state.parent), sessionHead: () => state.head };
      assert.equal(nativeChildA2aWaitSource({ store: view, record: state.parent }), null, name);
    }
    assert.equal(f.effects(), 1); assert.deepEqual(f.record(), original);
  });
}

test('automatic discovery never opens an absent, archived, delegated or busy Session handle', async () => {
  const root = { id: 'session', session: { id: 'session' }, status: 'idle' };
  for (const condition of ['absent', 'archived', 'delegated', 'stale', 'busy']) {
    const live = { ...root, status: condition === 'busy' ? 'running' : 'idle' };
    let lookups = 0;
    const services = { workspaceRegistry: { archivedSessionIds: condition === 'archived' ? ['session'] : [] },
      agents: { roots: () => ['absent', 'delegated'].includes(condition) ? [] : [live], get: () => ['absent', 'stale'].includes(condition) ? undefined : live },
      sessionController: { resolveAgent() { lookups++; throw Error('must not acquire a second Session write handle'); } } };
    const recovery = createStudioNativeRecovery({ ctx: { get: name => services[name] }, store: {}, workspaceId: 'workspace',
      lifetime: new AbortController(), active: new Set(), controls: new Map(), controlKey: (a, s) => a + s, execute: {} });
    const work = recovery.automatic({ agentId: 'agent', sessionId: 'session', runId: 'run' });
    if (condition === 'delegated') await assert.rejects(work, { code: 'studio_native_recovery_live_root_required' });
    else assert.deepEqual(await work, { status: 'deferred' }, condition);
    assert.equal(lookups, 0, condition);
  }
});
