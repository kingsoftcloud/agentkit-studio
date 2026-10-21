import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeKernel, configure, emptyUsage } from '../packages/agentkit-harness-core/dist/index.mjs';
import { fixture, scope, digest } from '../packages/agentkit-harness-core/test/fixtures.mjs';
import { SqliteRunStore } from '../packages/agentkit-harness/src/native/sqlite-store.mjs';
import { SqliteNativeMemoryProvider } from '../packages/agentkit-harness/src/native/memory-store.mjs';
import { memoryDigest } from '../packages/agentkit-harness/src/native/memory-candidate.mjs';
import { nativeRecoveryBinding } from '../src/providers/native-recovery-binding.mjs';
import { bindStudioNativeMemoryFlush } from '../src/providers/native-memory.mjs';
import { bindStudioNativeMemoryTurn, completedTurnMemoryEligible, explicitMemoryTaskOwned } from '../src/providers/native-memory-turn.mjs';

const finish = text => ({ kind: 'final_candidate', text, toolCalls: [], usage: emptyUsage() });
const manageMemoryTool = { name: 'manage_memory', description: 'Manage durable memory',
  parameters: { type: 'object', properties: { content: { type: 'string' }, action: { type: 'string' } },
    required: ['content', 'action'], additionalProperties: false },
  readOnly: false, concurrentSafe: false, permissions: [], timeoutMs: 5000, contextRole: 'none',
  observationRole: 'none', progressObservation: false, contextRetention: 'normal' };

function config(text, source = { kind: 'user' }, extra = {}) {
  const raw = { id: 'input', role: 'user', content: [{ type: 'text', text }], ...(source ? { source } : {}) };
  const base = fixture().config;
  return configure({ ...base, ...extra, instructions: 'Answer the current user.',
    contract: { ...base.contract, objective: text.trim() }, inputMessages: [{ role: 'user', kind: 'user_input', content: text }],
    hostRecoveryBinding: nativeRecoveryBinding({ binding: { agentId: scope.agentId, agentRevision: 1 },
      input: { messages: [raw] }, source: { provider: 'fixture', model: 'model' }, selection: {}, systemPrompt: 'Answer the current user.' }) });
}

function harness(t, policy = 'enabled', { providerFactory, manageMemoryToolNames, explicitMemoryVerifiers, model, tools = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'studio-memory-turn-')), store = new SqliteRunStore(join(root, 'runs.sqlite'));
  const spec = { runtime: { type: 'harness' }, memory: { enabled: true, providerRef: 'local-default',
    scopes: ['user'], write: { mode: policy === 'explicit_only' ? 'explicit_only' : 'candidate',
      flushBeforeCompaction: policy !== 'no_flush', flushAfterTurn: policy !== 'no_after' } },
    context: { rollout: { memoryWrite: ['off', 'shadow'].includes(policy) ? policy : 'enabled' } } };
  const record = { metadata: { id: scope.agentId, local: true, revision: 1 }, spec };
  let summaryModels = 0;
  const ports = { model: model ?? { generate: async request => {
    if (request.messages[0].kind === 'compaction_instructions') { summaryModels++; return finish('Prior inputs were received.'); }
    return finish('Delivered.');
  } }, context: { tokens: { tokenizerId: 'counter', tokenizerDigest: 'counter/v1',
    countRequest: async request => Math.ceil(JSON.stringify({ messages: request.messages, tools: request.tools }).length / 4),
    countText: async request => Math.ceil(request.text.length / 4) } } };
  if (tools.length) ports.tools = { execute: async () => ({ status: 'ok', content: { committed: true, memoryId: 'mem_1', version: 1 } }) };
  const worker = () => new NativeKernel({ store, ports, digest, owner: 'worker' });
  const run = async (id, text, source, small = false) => {
    const base = config(text, source, { tools });
    const hooks = small ? bindStudioNativeMemoryFlush({ record, scope, sessionId: 'session', store,
      storeDir: root, contextWindow: 2400, providerFactory }) : null;
    const configuration = configure({ ...base, hooks: hooks?.definitions ?? [],
      profile: { ...base.profile, contextWindow: small ? 2400 : 16000, maxOutputTokens: 128 },
      contextPolicy: { ...base.contextPolicy, enabled: true, tokenizerId: 'counter', tokenizerDigest: 'counter/v1',
        triggerRatio: .72, targetRatio: .45, summaryMaxTokens: 80, maxCompactions: null,
        maxCompactionsWithoutProgress: 4, minModelTurnsBetween: 2, maxSummaryRetries: 2 } });
    ports.hooks = hooks;
    worker().start({ ...fixture().snapshot, runId: id, parentRunId: null, sessionId: 'session' }, configuration);
    return worker().runUntilIdle(scope, id);
  };
  const bindings = [];
  const binding = (overrides = {}) => { const b = bindStudioNativeMemoryTurn({ record, scope, sessionId: 'session', store,
    storeDir: root, contextWindow: 16000, effectTimeoutMs: 30000, providerFactory, manageMemoryToolNames,
    explicitMemoryVerifiers, ...overrides }); if (b) bindings.push(b); return b; };
  t.after(async () => { bindings.forEach(b => b.close()); store.close(); rmSync(root, { recursive: true, force: true }); });
  const filename = join(root, 'native-harness', 'memory-v1', memoryDigest(scope.tenantId).slice(7), 'memory.sqlite');
  return { root, store, run, record, filename, binding, counts: () => ({ summaryModels }) };
}

test('completed_turn_memory_eligible mirrors the reference verified/unverified conditions', () => {
  assert.equal(completedTurnMemoryEligible({ outcome: 'verified' }), true);
  assert.equal(completedTurnMemoryEligible({ outcome: 'unverified', reason: 'verification_report_missing', verification: null }), true);
  assert.equal(completedTurnMemoryEligible({ outcome: 'unverified', reason: 'required_acceptance_empty', verification: { checks: [] } }), true);
  assert.equal(completedTurnMemoryEligible({ outcome: 'unverified', reason: 'required_verification_incomplete',
    verification: { checks: [{ status: 'not_run' }, { status: 'passed' }] } }), true);
  assert.equal(completedTurnMemoryEligible({ outcome: 'unverified', reason: 'required_verification_incomplete',
    verification: { checks: [{ status: 'passed' }, { status: 'failed' }] } }), false);
  assert.equal(completedTurnMemoryEligible({ outcome: 'unverified', reason: 'required_verification_incomplete',
    verification: { checks: [{ status: 'passed' }, { status: 'blocked' }] } }), false);
  assert.equal(completedTurnMemoryEligible({ outcome: 'unverified', reason: 'required_verification_incomplete', verification: null }), false);
  assert.equal(completedTurnMemoryEligible({ outcome: 'blocked', reason: 'required_acceptance_blocked' }), false);
  assert.equal(completedTurnMemoryEligible({ outcome: 'partial', reason: 'qualified_evidence_missing' }), false);
  assert.equal(completedTurnMemoryEligible({ outcome: 'unverified', reason: 'required_acceptance_failed' }), false);
});

test('explicit_memory_task_owned excludes explicit durable-Memory goals and contract items', () => {
  assert.equal(explicitMemoryTaskOwned({ goal: '记住：我喜欢用Vim' }), true);
  assert.equal(explicitMemoryTaskOwned({ goal: 'remember that I prefer Vim' }), true);
  assert.equal(explicitMemoryTaskOwned({ goal: '我喜欢用Vim，而不是Emacs' }), true);
  assert.equal(explicitMemoryTaskOwned({ goal: '我喜欢用Vim' }), false);
  assert.equal(explicitMemoryTaskOwned({ goal: 'Deliver the report.' }), false);
  assert.equal(explicitMemoryTaskOwned({ goal: 'any', taskContract: { acceptance: [
    { verifierRef: 'studio.explicit-durable-memory', verifierVersion: '2' }] } }), true);
  assert.equal(explicitMemoryTaskOwned({ goal: 'any', taskContract: { acceptance: [
    { verifierRef: 'studio.delivery-evidence-rejection', verifierVersion: '1' }] } }), false);
  assert.equal(explicitMemoryTaskOwned({ goal: 'any' }, { explicitMemoryVerifiers: [
    { verifierRef: 'studio.custom-memory', verifierVersion: '1' }] }), false);
});

test('disabled rollouts return null and never bind a consumer', () => {
  const record = (write, rollout, memory = { enabled: true, providerRef: 'local-default', scopes: ['user'], write }) =>
    ({ metadata: { id: scope.agentId, local: true, revision: 1 },
      spec: { runtime: { type: 'harness' }, memory, context: { rollout: { memoryWrite: rollout } } } });
  const base = { scope, sessionId: 'session', store: { load: () => null }, storeDir: '/tmp', contextWindow: 16000 };
  assert.equal(bindStudioNativeMemoryTurn({ record: record({ mode: 'candidate', flushAfterTurn: true }, 'off'), ...base }), null);
  assert.equal(bindStudioNativeMemoryTurn({ record: record({ mode: 'candidate', flushAfterTurn: false }, 'enabled'), ...base }), null);
  assert.equal(bindStudioNativeMemoryTurn({ record: record({ mode: 'off', flushAfterTurn: true }, 'enabled'), ...base }), null);
  assert.equal(bindStudioNativeMemoryTurn({ record: record({ mode: 'candidate', flushAfterTurn: true }, 'enabled',
    { enabled: true, providerRef: 'remote', scopes: ['user'], write: { mode: 'candidate', flushAfterTurn: true } }), ...base }), null);
  assert.equal(bindStudioNativeMemoryTurn({ record: record({ mode: 'candidate', flushAfterTurn: true }, 'enabled',
    { enabled: true, providerRef: 'local-default', scopes: ['workspace'], write: { mode: 'candidate', flushAfterTurn: true } }), ...base }), null);
});

test('enabled: completed turn consumes only current original user inputs', async t => {
  const h = harness(t, 'enabled'), binding = h.binding();
  for (const id of ['one', 'two']) {
    const result = await h.run(id, '我喜欢用Vim');
    assert.equal(result.phase, 'completed', result.reason);
    assert.equal((await binding.consume(h.store.load(scope, id).snapshot))?.status, 'evaluated');
  }
  const provider = new SqliteNativeMemoryProvider(h.filename, { principal: scope });
  try {
    const records = provider.list();
    assert.equal(records.length, 1);
    assert.equal(records[0].content, '我喜欢用Vim');
    assert.equal(records[0].version, 1);
    const ids = records[0].sourceEventIds;
    assert.equal(ids.length, 2);
    assert.ok(ids.some(id => id.startsWith('native-message://one#')), ids.join(','));
    assert.ok(ids.some(id => id.startsWith('native-message://two#')), ids.join(','));
  } finally { provider.close(); }
});

test('two independent original sources with different content do not conflate', async t => {
  const h = harness(t, 'enabled'), binding = h.binding();
  for (const id of ['vim-1', 'vim-2']) { await h.run(id, '我喜欢用Vim'); await binding.consume(h.store.load(scope, id).snapshot); }
  for (const id of ['apple-1', 'apple-2']) { await h.run(id, '我喜欢吃苹果'); await binding.consume(h.store.load(scope, id).snapshot); }
  const provider = new SqliteNativeMemoryProvider(h.filename, { principal: scope });
  try {
    const records = provider.list();
    assert.equal(records.length, 2);
    assert.deepEqual(new Set(records.map(record => record.content)), new Set(['我喜欢用Vim', '我喜欢吃苹果']));
    const vim = records.find(r => r.content === '我喜欢用Vim'), apple = records.find(r => r.content === '我喜欢吃苹果');
    assert.equal(vim.sourceEventIds.length, 2);
    assert.ok(vim.sourceEventIds.every(id => id.startsWith('native-message://vim-')));
    assert.equal(apple.sourceEventIds.length, 2);
    assert.ok(apple.sourceEventIds.every(id => id.startsWith('native-message://apple-')));
  } finally { provider.close(); }
});

test('schedules are not original human Memory observations', async t => {
  const h = harness(t, 'enabled'), binding = h.binding();
  const result = await h.run('one', '我喜欢用Vim', { kind: 'schedule' });
  assert.equal(result.phase, 'completed', result.reason);
  const consumed = await binding.consume(h.store.load(scope, 'one').snapshot);
  assert.equal(consumed.status, 'empty');
  assert.equal(existsSync(h.filename), false);
});

test('explicit_only write mode does not auto-extract implicit preferences', async t => {
  const h = harness(t, 'explicit_only'), binding = h.binding();
  await h.run('one', '我喜欢用Vim');
  const consumed = await binding.consume(h.store.load(scope, 'one').snapshot);
  assert.equal(consumed.status, 'empty');
  assert.equal(existsSync(h.filename), false);
});

test('shadow rollout only evaluates candidates and never opens the memory database', async t => {
  const h = harness(t, 'shadow'), binding = h.binding();
  const result = await h.run('one', '我喜欢用Vim');
  assert.equal(result.phase, 'completed', result.reason);
  const consumed = await binding.consume(h.store.load(scope, 'one').snapshot);
  assert.equal(consumed.status, 'shadow');
  assert.ok(consumed.proposed >= 1);
  assert.equal(existsSync(h.filename), false);
});

test('an explicit durable-Memory task is not re-extracted after its turn', async t => {
  const h = harness(t, 'enabled'), binding = h.binding();
  const result = await h.run('one', '记住：我喜欢用Vim');
  assert.equal(result.phase, 'completed', result.reason);
  const consumed = await binding.consume(h.store.load(scope, 'one').snapshot);
  assert.equal(consumed.status, 'explicit_memory_task_owned');
  assert.equal(existsSync(h.filename), false);
});

test('a direct manage_memory write skips completed-turn reextraction', async t => {
  for (const [label, directWriteReceipt, expected] of [
    ['confirmed', async () => ({ committed: true, memoryId: 'mem_1', version: 1 }), 'direct_write_already_committed'],
    ['not_confirmed', async () => null, 'memory_mutation_not_confirmed'],
    ['missing', undefined, 'direct_write_verification_missing'],
  ]) {
    let calls = 0;
    const model = { generate: async request => {
      if (request.messages[0].kind === 'compaction_instructions') return finish('Prior inputs were received.');
      calls++;
      if (calls === 1) return { kind: 'tool_calls', text: '', toolCalls: [{ callId: 'c1', name: 'manage_memory',
        arguments: { content: '我喜欢用Vim', action: 'remember' } }], usage: emptyUsage() };
      return finish('Memory operation inspected.');
    } };
    const h = harness(t, 'enabled', { model, tools: [manageMemoryTool] }), binding = h.binding();
    const result = await h.run('run-' + label, '我喜欢用Vim');
    assert.equal(result.phase, 'completed', result.reason);
    const consumed = await binding.consume(h.store.load(scope, 'run-' + label).snapshot, { directWriteReceipt });
    assert.equal(consumed.status, expected);
    assert.equal(existsSync(h.filename), false, 'no auto-extraction after a direct manage_memory write');
  }
});

test('PreCompact flush and completed-turn consumer share idempotent receipts for the same original source', async t => {
  const h = harness(t, 'enabled'), binding = h.binding();
  const original = ' '.repeat(2500) + '我喜欢用Vim';
  for (const id of ['one', 'two']) {
    const result = await h.run(id, original);
    assert.equal(result.phase, 'completed', result.reason);
    assert.equal((await binding.consume(h.store.load(scope, id).snapshot))?.status, 'evaluated');
  }
  // The third run compacts the projected history from the first two. Its PreCompact
  // flush re-encounters the same original sources and, sharing the source-derived
  // operation key, must not double-count them as a second observation.
  const compacted = await h.run('three', 'Deliver current response.', undefined, true);
  assert.equal(compacted.phase, 'completed', compacted.reason);
  assert.ok(h.counts().summaryModels > 0, 'compaction produced a summary model call');
  const consumed = await binding.consume(h.store.load(scope, 'three').snapshot);
  assert.ok(consumed === undefined || ['empty', 'evaluated', 'shadow'].includes(consumed.status));
  const provider = new SqliteNativeMemoryProvider(h.filename, { principal: scope });
  try {
    const records = provider.list();
    assert.equal(records.length, 1);
    assert.equal(records[0].content, '我喜欢用Vim');
    assert.equal(records[0].version, 1);
    const ids = records[0].sourceEventIds;
    assert.equal(ids.length, 2, 'PreCompact did not add a third observation');
    assert.ok(ids.every(id => id.startsWith('native-message://one#') || id.startsWith('native-message://two#')), ids.join(','));
  } finally { provider.close(); }
});

test('a post-commit lost callback result yields an unknown outcome without a blind retry', async t => {
  let effects = 0;
  const providerFactory = (filename, options) => {
    const provider = new SqliteNativeMemoryProvider(filename, options);
    return { close: () => provider.close(), applyCandidate: request => {
      const result = provider.applyCandidate(request); effects++;
      if (result.committed) throw new Error('fixture-private-post-commit-diagnostic');
      return result;
    } };
  };
  const h = harness(t, 'enabled', { providerFactory }), binding = h.binding();
  await h.run('one', '我喜欢用Vim');
  assert.equal((await binding.consume(h.store.load(scope, 'one').snapshot))?.status, 'evaluated');
  await h.run('two', '我喜欢用Vim');
  const consumed = await binding.consume(h.store.load(scope, 'two').snapshot);
  assert.equal(consumed, undefined);
  assert.equal(effects, 2);
  const provider = new SqliteNativeMemoryProvider(h.filename, { principal: scope });
  try { assert.equal(provider.list().length, 1); assert.equal(provider.list()[0].version, 1); } finally { provider.close(); }
});

test('a closed binding, an aborted signal and a stale runId yield an unknown outcome without writing', async t => {
  const h = harness(t, 'enabled');
  await h.run('one', '我喜欢用Vim');
  const snapshot = h.store.load(scope, 'one').snapshot;
  const closed = h.binding(); closed.close();
  assert.equal(await closed.consume(snapshot), undefined);
  const binding = h.binding();
  const aborted = new AbortController(); aborted.abort();
  assert.equal(await binding.consume(snapshot, { signal: aborted.signal }), undefined);
  assert.equal(await binding.consume({ ...snapshot, runId: 'never-existed' }), undefined);
  assert.equal(existsSync(h.filename), false);
});

test('a deadline during owner receipt verification yields an unknown outcome without a blind retry', async t => {
  let calls = 0;
  const model = { generate: async request => {
    if (request.messages[0].kind === 'compaction_instructions') return finish('Prior inputs were received.');
    calls++;
    if (calls === 1) return { kind: 'tool_calls', text: '', toolCalls: [{ callId: 'c1', name: 'manage_memory',
      arguments: { content: '我喜欢用Vim', action: 'remember' } }], usage: emptyUsage() };
    return finish('Memory operation inspected.');
  } };
  const h = harness(t, 'enabled', { model, tools: [manageMemoryTool] });
  await h.run('one', '我喜欢用Vim');
  const snapshot = h.store.load(scope, 'one').snapshot;
  const binding = h.binding({ effectTimeoutMs: 20 });
  const consumed = await binding.consume(snapshot, { directWriteReceipt: async () => new Promise(() => {}) });
  assert.equal(consumed, undefined);
  assert.equal(existsSync(h.filename), false);
});

test('consume never alters the main terminal state, answer, usage or verification', async t => {
  const h = harness(t, 'enabled'), binding = h.binding();
  const result = await h.run('one', '我喜欢用Vim');
  const before = h.store.load(scope, 'one');
  const consumed = await binding.consume(before.snapshot);
  assert.ok(consumed && consumed.status === 'evaluated');
  const after = h.store.load(scope, 'one');
  assert.deepEqual(after.snapshot, before.snapshot);
  assert.equal(after.snapshot.phase, 'completed');
  assert.equal(after.snapshot.finalText, result.finalText);
  assert.deepEqual(after.snapshot.usage, before.snapshot.usage);
  assert.deepEqual(after.snapshot.verification, before.snapshot.verification);
});
