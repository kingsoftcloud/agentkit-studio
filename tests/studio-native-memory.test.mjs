import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeKernel, configure, emptyUsage } from '@kingsoftcloud/agentkit-harness-core';
import { fixture, scope, digest } from './fixtures/native-core.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { SqliteNativeMemoryProvider } from '@kingsoftcloud/agentkit-harness-node/native/memory-store';
import { memoryDigest } from '@kingsoftcloud/agentkit-harness-node/native/memory-candidate';
import { nativeRecoveryBinding } from '../src/providers/native-recovery-binding.mjs';
import { bindStudioNativeMemoryFlush, composeStudioNativeHooks, studioOriginalUserMemorySources } from '../src/providers/native-memory.mjs';

const finish = text => ({ kind: 'final_candidate', text, toolCalls: [], usage: emptyUsage() });
function config(text, source = { kind: 'user' }, extra = {}) {
  const raw = { id: 'input', role: 'user', content: [{ type: 'text', text }], ...(source ? { source } : {}) };
  const base = fixture().config;
  return configure({ ...base, ...extra, instructions: 'Answer the current user.',
    contract: { ...base.contract, objective: text.trim() }, inputMessages: [{ role: 'user', kind: 'user_input', content: text }],
    hostRecoveryBinding: nativeRecoveryBinding({ binding: { agentId: scope.agentId, agentRevision: 1 },
      input: { messages: [raw] }, source: { provider: 'fixture', model: 'model' }, selection: {}, systemPrompt: 'Answer the current user.' }) });
}
function harness(t, policy = 'enabled', { providerFactory } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'studio-memory-')), store = new SqliteRunStore(join(root, 'runs.sqlite'));
  const spec = { runtime: { type: 'harness' }, memory: { enabled: true, providerRef: 'local-default',
    scopes: ['user'], write: { mode: policy === 'explicit_only' ? 'explicit_only' : 'candidate', flushBeforeCompaction: policy !== 'no_flush' } },
    context: { rollout: { memoryWrite: ['off', 'shadow'].includes(policy) ? policy : 'enabled' } } };
  const record = { metadata: { id: scope.agentId, local: true, revision: 1 }, spec }, owned = [];
  let taskModels = 0, summaryModels = 0;
  const ports = { model: { generate: async request => {
    if (request.messages[0].kind === 'compaction_instructions') { summaryModels++; return finish('Prior inputs were received.'); }
    taskModels++; return finish('Delivered.');
  } }, context: { tokens: { tokenizerId: 'counter', tokenizerDigest: 'counter/v1',
    countRequest: async request => Math.ceil(JSON.stringify({ messages: request.messages, tools: request.tools }).length / 4),
    countText: async request => Math.ceil(request.text.length / 4) } } };
  const worker = () => new NativeKernel({ store, ports, digest, owner: 'worker' });
  const run = async (id, text, source, small = false) => {
    const base = config(text, source), hooks = small ? bindStudioNativeMemoryFlush({ record, scope, sessionId: 'session', store,
      storeDir: root, contextWindow: 2400, providerFactory }) : null;
    if (hooks) owned.push(hooks);
    const configuration = configure({ ...base, hooks: hooks?.definitions ?? [],
      profile: { ...base.profile, contextWindow: small ? 2400 : 16000, maxOutputTokens: 128 },
      contextPolicy: { ...base.contextPolicy, enabled: true, tokenizerId: 'counter', tokenizerDigest: 'counter/v1',
        triggerRatio: .72, targetRatio: .45, summaryMaxTokens: 80, maxCompactions: null,
        maxCompactionsWithoutProgress: 4, minModelTurnsBetween: 2, maxSummaryRetries: 2 } });
    ports.hooks = hooks;
    worker().start({ ...fixture().snapshot, runId: id, parentRunId: null, sessionId: 'session' }, configuration);
    return worker().runUntilIdle(scope, id);
  };
  t.after(async () => { await Promise.all(owned.map(port => port.close())); store.close(); rmSync(root, { recursive: true, force: true }); });
  const filename = join(root, 'native-harness', 'memory-v1', memoryDigest(scope.tenantId).slice(7), 'memory.sqlite');
  return { root, store, run, record, filename, counts: () => ({ taskModels, summaryModels }) };
}

for (const policy of ['enabled', 'shadow', 'off', 'no_flush', 'explicit_only']) test(`${policy}: real compaction calls production Memory port with original independent user sources`, async t => {
  const run = harness(t, policy), original = ' '.repeat(2500) + '我喜欢用Vim';
  for (const id of ['one', 'two']) assert.equal((await run.run(id, original)).phase, 'completed');
  const result = await run.run('three', 'Deliver current response.', undefined, true);
  assert.equal(result.phase, 'completed', result.reason); assert.ok(run.counts().summaryModels > 0);
  const stored = run.store.load(scope, 'three'), receipts = stored.receipts.filter(receipt => receipt.result.schemaVersion === 'agentkit.native-hook-result/v1');
  assert.equal(receipts.length, ['off', 'no_flush'].includes(policy) ? 0 : 1);
  if (policy === 'enabled') {
    const provider = new SqliteNativeMemoryProvider(run.filename, { principal: scope });
    try {
      const records = provider.list(); assert.equal(records.length, 1);
      assert.equal(records[0].content, '我喜欢用Vim'); assert.equal(records[0].version, 1);
      assert.deepEqual(new Set(records[0].sourceEventIds), new Set(['native-message://one#message=1', 'native-message://two#message=3']));
    } finally { provider.close(); }
    assert.ok(stored.snapshot.messages.some(message => message.kind === 'hook_context' && message.content.includes('currentFactVerification')));
    // A different lifecycle projection of the same original sources is not a
    // second observation or a fresh write. Full original Run owners are reused.
    assert.equal((await run.run('four', 'Deliver the next response.', undefined, true)).phase, 'completed');
    const reopened = new SqliteNativeMemoryProvider(run.filename, { principal: scope });
    try { assert.equal(reopened.list().length, 1); assert.equal(reopened.list()[0].version, 1); } finally { reopened.close(); }
  } else assert.equal(existsSync(run.filename), false, 'disabled/shadow/empty evaluation cannot even open a memory database');
});

test('schedules in a user model role cannot become original human Memory observations', async t => {
  const run = harness(t), original = ' '.repeat(2500) + '我喜欢用Vim';
  for (const id of ['one', 'two']) assert.equal((await run.run(id, original, { kind: 'schedule' })).phase, 'completed');
  assert.equal((await run.run('three', 'Deliver current response.', undefined, true)).phase, 'completed');
  assert.equal(existsSync(run.filename), false);
  const receipt = run.store.load(scope, 'three').receipts.find(receipt => receipt.result.schemaVersion === 'agentkit.native-hook-result/v1');
  assert.match(JSON.stringify(receipt.result), /empty/u);
});

test('a post-commit lost callback result interrupts before summary, preserving the fact without re-execution', async t => {
  let effects = 0;
  const run = harness(t, 'enabled', { providerFactory: (filename, options) => {
    const provider = new SqliteNativeMemoryProvider(filename, options);
    return { close: () => provider.close(), applyCandidate: request => {
      const result = provider.applyCandidate(request); effects++;
      if (result.committed) throw new Error('fixture-private-post-commit-diagnostic'); return result;
    } };
  } });
  const original = ' '.repeat(2500) + '我喜欢用Vim';
  await run.run('one', original); await run.run('two', original);
  const before = run.counts(), result = await run.run('three', 'Deliver current response.', undefined, true);
  assert.equal(result.phase, 'interrupted'); assert.equal(result.reason, 'effect_outcome_unknown');
  assert.deepEqual(run.counts(), before); assert.equal(effects, 2);
  assert.doesNotMatch(JSON.stringify(result), /fixture-private-post-commit-diagnostic/u);
  const provider = new SqliteNativeMemoryProvider(run.filename, { principal: scope });
  try { assert.equal(provider.list().length, 1); assert.equal(provider.list()[0].version, 1); } finally { provider.close(); }
  const worker = new NativeKernel({ store: run.store, ports: {}, digest, owner: 'recovery' });
  assert.equal((await worker.runUntilIdle(scope, 'three')).phase, 'interrupted'); assert.equal(effects, 2);
});

test('source bytes, historical indices and current projection refs must match the canonical Host admissions', async t => {
  const run = harness(t); await run.run('one', '记住：我喜欢用Vim');
  const original = run.store.load(scope, 'one').snapshot.messages[1];
  const args = { store: run.store, scope, runId: 'one', messages: [original], messageRefs: ['message:1:' + digest(original)] };
  const result = studioOriginalUserMemorySources(args);
  assert.equal(result.observations.length, 1); assert.equal(result.observations[0].content, '记住：我喜欢用Vim');
  assert.throws(() => studioOriginalUserMemorySources({ ...args, messages: [{ ...original, content: '记住：different' }] }), /projection_unbound/);
  assert.throws(() => studioOriginalUserMemorySources({ ...args, messageRefs: ['message:0:' + digest(original)] }), /projection_unbound/);
});

test('Memory-only Hook composition preserves a registered nonzero Stop cap and rejects duplicate identities', () => {
  const port = (id, event, limit) => ({ definitions: [{ hookId: id, events: [event] }], stopContinuationLimit: limit,
    requiredEffectTimeoutMs: 100, invoke: async () => ({}), close: async () => {} });
  const registered = port('governance', 'Stop', 3), memory = port('memory', 'PreCompact', 0);
  assert.equal(composeStudioNativeHooks(registered, memory).stopContinuationLimit, 3);
  assert.throws(() => composeStudioNativeHooks(registered, port('governance', 'PreCompact', 0)), /id_duplicate/);
  assert.throws(() => composeStudioNativeHooks(registered, port('other', 'Stop', 2)), /stop_policy_conflict/);
});
