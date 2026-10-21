import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeKernel, configure, emptyUsage, canonical, CONTEXT_SOURCE_CONTRACT } from '../packages/agentkit-harness-core/dist/index.mjs';
import { fixture, scope, digest, tool } from '../packages/agentkit-harness-core/test/fixtures.mjs';
import { SqliteRunStore } from '../packages/agentkit-harness/src/native/sqlite-store.mjs';
import { SqliteNativeMemoryProvider } from '../packages/agentkit-harness/src/native/memory-store.mjs';
import { memoryDigest, nativeMemoryScopeBindings, nativeUserMemoryCandidate } from '../packages/agentkit-harness/src/native/memory-candidate.mjs';
import { nativeRecoveryBinding } from '../src/providers/native-recovery-binding.mjs';
import { createNativeVerification, nativeGoalContract } from '../src/providers/native-verification.mjs';
import { createStudioNativeMemoryVerification, extendNativeMemoryGoal, MEMORY_VERIFIER_REF } from '../src/providers/native-memory-acceptance.mjs';

const final = text => ({ kind: 'final_candidate', text, toolCalls: [], usage: emptyUsage() });
async function setup(t, { goal = '我喜欢用Emacs，不是Vim', write = true, behavior = 'correct', tamperReceipt = false, stale = false, recall = false, evidenceUnavailable = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'memory-acceptance-')), workspace = join(root, 'workspace'); await mkdir(workspace);
  const store = new SqliteRunStore(join(root, 'runs.sqlite')), provider = new SqliteNativeMemoryProvider(join(root, 'memory.sqlite'), { principal: scope });
  t.after(async () => { provider.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  const seed = nativeUserMemoryCandidate({ text: '记住：我喜欢用Vim', sourceEventId: 'prior-user', ...nativeMemoryScopeBindings(scope)[0] });
  const memoryId = provider.applyCandidate({ candidate: seed, operationKey: 'seed', sourceSessionId: 'prior', sourceDigest: memoryDigest(seed.content) }).memoryId;
  const spec = { runtime: { type: 'harness' }, memory: { enabled: true, scopes: ['user'], write: { mode: write ? 'explicit_only' : 'off' } }, context: { rollout: { memoryWrite: 'enabled' } } };
  const record = { metadata: { id: scope.agentId, local: true, revision: 1 }, spec };
  const definition = tool({ name: behavior === 'read' ? 'read_memory' : 'manage_memory', readOnly: behavior === 'read', concurrentSafe: false });
  const contract = extendNativeMemoryGoal(goal, nativeGoalContract({ sessionId: 'session', goal }), { providerRef: 'local-default' });
  const base = fixture().config;
  const source = { contract: CONTEXT_SOURCE_CONTRACT, sourceId: 'studio.memory-recall', bindingDigest: 'locked-memory/v1',
    priority: 0, timeoutMs: 1000, required: false, maxTokens: 1600, maxBytes: 131072 };
  const config = configure({ ...base, contract, inputMessages: [{ role: 'user', kind: 'user_input', content: goal }], tools: recall ? [] : [definition],
    limits: { ...base.limits, maxRepairs: 0 },
    ...(recall ? { contextSources: [source], contextPolicy: { enabled: true, tokenizerId: 'test', tokenizerDigest: 'test/v1', triggerRatio: .9,
      targetRatio: .45, summaryMaxTokens: 80, maxCompactions: null, maxCompactionsWithoutProgress: 4, minModelTurnsBetween: 2, maxSummaryRetries: 2 } } : {}),
    hostRecoveryBinding: nativeRecoveryBinding({ binding: { agentId: scope.agentId, agentRevision: 1 },
      input: { messages: [{ id: 'user-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: goal }] }] },
      source: { provider: 'fixture', model: 'pinned' }, selection: {}, systemPrompt: base.instructions }) });
  const mutationInput = request => ({ action: 'correct', memoryId, expectedVersion: 1, operationKey: request.operationKey,
    content: '我喜欢用Emacs', sourceEventId: request.call.callId, sourceSessionId: 'session' });
  let models = 0, reads = 0, ownerChecks = 0;
  const baseline = await createNativeVerification({ scope, sessionId: 'session', workspaceRoot: workspace, evidenceDirectory: join(root, 'evidence') });
  if (evidenceUnavailable) {
    await rm(join(root, 'evidence'), { recursive: true, force: true });
    await writeFile(join(root, 'evidence'), 'Evidence directory is unavailable');
  }
  const verification = createStudioNativeMemoryVerification({ record, scope, sessionId: 'session', store, baseline, definitions: [definition],
    memoryOwner: { read: async id => { reads++; return provider.get(id); }, receipt: async request => {
      ownerChecks++; return tamperReceipt ? { committed: true, memoryId: 'forged' }
        : provider.receipt(request.operationKey, provider.mutationRequestDigest(mutationInput(request)));
    } } });
  const ports = { verification, model: { generate: async () => {
    if (++models === 1 && behavior !== 'promise' && !recall) return { ...final(''), kind: 'tool_calls', toolCalls: [{ callId: 'operation', name: definition.name,
      arguments: behavior === 'read' ? { memory_id: memoryId } : { action: 'correct', memory_id: memoryId, expected_version: 1, content: '我喜欢用Emacs' } }] };
    return final('I have remembered it.');
  } }, tools: { execute: async request => {
    if (behavior === 'read') return { status: 'ok', content: { record: provider.get(memoryId) } };
    const result = provider.mutate(mutationInput(request));
    if (stale) provider.mutate({ action: 'correct', memoryId, expectedVersion: 2, operationKey: 'external-correction',
      content: '我喜欢用Nano', sourceEventId: 'other-user', sourceSessionId: 'other-session' });
    return { status: 'ok', content: result };
  } } };
  if (recall) ports.context = { readSource: async () => ({ items: [{ content: '我喜欢用Vim', memoryId }] }),
    tokens: { tokenizerId: 'test', tokenizerDigest: 'test/v1', countRequest: async request => Math.ceil(canonical(request.messages).length / 4),
      countText: async request => Math.ceil(request.text.length / 4) } };
  const kernel = new NativeKernel({ store, ports, digest, owner: 'acceptance-worker' });
  kernel.start({ ...fixture().snapshot, runId: 'run', sessionId: 'session' }, config);
  return { run: () => kernel.runUntilIdle(scope, 'run'), store, provider, memoryId, counts: () => ({ models, reads, ownerChecks }) };
}

test('explicit goals pin a versioned durable-memory verifier without changing unrelated contracts or inventing provenance', () => {
  const goal = '记住：我喜欢用Vim', base = nativeGoalContract({ sessionId: 'session', goal });
  const extended = extendNativeMemoryGoal(goal, base, { providerRef: 'local-default' });
  assert.equal(extended.acceptance[0].verifierRef, MEMORY_VERIFIER_REF); assert.notEqual(extended.revision, base.revision);
  assert.equal(base.acceptance[0].verifierRef, 'studio.delivery-evidence-rejection');
  assert.deepEqual(extendNativeMemoryGoal(goal, base, { providerRef: 'binding://platform-memory-instance' }), base);
  const ordinary = nativeGoalContract({ sessionId: 'session', goal: 'Help me edit a file' });
  assert.deepEqual(extendNativeMemoryGoal(ordinary.objective, ordinary, { providerRef: 'local-default' }), ordinary);
});

test('a real owner receipt and the current SQLite corrected fact qualify the exact explicit goal', async t => {
  const host = await setup(t), result = await host.run();
  assert.equal(result.phase, 'completed'); assert.equal(result.outcome, 'verified', result.reason);
  assert.equal(result.verification.checks[0].status, 'passed'); assert.equal(host.provider.get(host.memoryId).version, 2);
  assert.deepEqual(host.counts(), { models: 2, reads: 1, ownerChecks: 1 });
});

test('a persisted fact cannot override a real baseline evidence storage failure', async t => {
  const host = await setup(t, { evidenceUnavailable: true }), result = await host.run();
  assert.equal(host.provider.get(host.memoryId).version, 2);
  assert.equal(result.phase, 'completed'); assert.notEqual(result.outcome, 'verified');
  assert.equal(result.verification.checks[0].status, 'blocked');
  assert.equal(result.verification.checks[0].verifierId, MEMORY_VERIFIER_REF);
  assert.equal(host.counts().ownerChecks, 0);
});

for (const mode of ['promise', 'tampered-receipt', 'stale-fact']) test(`${mode} cannot qualify persistence from assistant or historical tool claims`, async t => {
  const host = await setup(t, { behavior: mode === 'promise' ? 'promise' : 'correct', tamperReceipt: mode === 'tampered-receipt', stale: mode === 'stale-fact' });
  const result = await host.run();
  assert.equal(result.phase, 'completed'); assert.notEqual(result.outcome, 'verified');
  assert.equal(result.verification.checks[0].status, 'failed');
  assert.equal(result.verification.checks[0].safeSummary.includes('manage_memory'), true);
});

for (const recall of [false, true]) test(`a current ${recall ? 'bound Context recall' : 'explicit read'} proves an already persisted add without write permission`, async t => {
  const host = await setup(t, { goal: '记住：我喜欢用Vim', write: false, behavior: 'read', recall });
  const result = await host.run(); assert.equal(result.outcome, 'verified', result.reason);
  assert.equal(host.provider.get(host.memoryId).version, 1); assert.equal(host.counts().ownerChecks, 0);
});
