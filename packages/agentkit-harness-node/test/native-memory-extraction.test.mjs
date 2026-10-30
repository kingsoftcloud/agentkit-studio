import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRunStore, emptyUsage, canonical } from '../../agentkit-harness-core/dist/index.mjs';
import { fixture, digest, scope } from '../../agentkit-harness-core/test/fixtures.mjs';
import { prepareMemoryExtractionRun, executeMemoryExtractionRun } from '../src/native/memory-extraction-run.mjs';
import { nativeMemoryExtractionToolDefinitions, createNativeMemoryExtractionTools } from '../src/native/memory-extraction-tools.mjs';
import { SqliteNativeMemoryProvider } from '../src/native/memory-store.mjs';
import { memoryDigest, nativeMemoryScopeBindings } from '../src/native/memory-candidate.mjs';

const policy = rollout => ({ enabled: true, providerRef: 'local-default', scopes: ['user'],
  recall: { enabled: true, maxTokens: 1600, topK: 8, minScore: .45 },
  write: { mode: 'candidate', flushBeforeCompaction: true, flushAfterTurn: true }, rollout });
const parent = { scope, runId: 'parent', sessionId: 'user-session', turnId: 'parent-turn',
  buildId: 'frozen-build', parentRunId: null, taskChainId: 'parent-chain' };
const source = { boundaryId: 'human-1', sourceDigest: memoryDigest('trusted conversation window'),
  parent: { ...parent, revision: 10, goalRevision: 0, goalDigest: memoryDigest('parent goal') },
  messages: [{ id: 'human-1', role: 'user', text: 'Our invoices use UTC timestamps.',
    providerReplay: { privateSignature: 'PRIVATE_PROTOCOL' }, media: [{ bytes: 'PRIVATE_MEDIA' }] }],
  sources: [{ sourceEventId: 'human-1', sourceSessionId: parent.sessionId,
    content: 'Our invoices use UTC timestamps.', sourceDigest: memoryDigest('Our invoices use UTC timestamps.') }] };
const finish = () => ({ kind: 'final_candidate', text: 'Nothing else to save.', toolCalls: [], usage: emptyUsage() });
const mutation = (args = {}) => ({ action: 'remember', scope: 'user', content: 'Invoices use UTC timestamps.',
  memory_type: 'fact', source_event_ids: ['human-1'], ...args });
const call = (name, args, callId) => ({ kind: 'tool_calls', text: '', usage: emptyUsage(),
  toolCalls: [{ name, arguments: args, callId }] });

function setup(t, rollout = 'enabled') {
  const selected = policy(rollout), policyDigest = memoryDigest(canonical(selected));
  const store = new MemoryRunStore(), provider = new SqliteNativeMemoryProvider(':memory:', { principal: scope, scopes: ['user'] });
  t.after(() => provider.close());
  const definitions = nativeMemoryExtractionToolDefinitions({ policy: selected, policyDigest });
  const input = { parent, source, manifest: [], profile: fixture().config.profile,
    tools: definitions, policyDigest, digest };
  const run = prepareMemoryExtractionRun(input);
  let current = true;
  const assertSourceCurrent = () => { assert.equal(current, true, 'source revoked'); };
  const tools = createNativeMemoryExtractionTools({ run, store, provider, policy: selected, source,
    assertSourceCurrent, planner: { countMessage: message => Math.ceil(canonical(message).length / 4) } });
  const execute = generate => executeMemoryExtractionRun({ run, store, ports: { tools, model: { generate } },
    owner: 'memory-owner', digest, signal: new AbortController().signal, assertSourceCurrent, countRequest: () => 500 });
  return { input, run, store, provider, tools, execute, revoke: () => { current = false; } };
}

test('Memory policy stays in its module and only public conversation data enters the independent bounded Run', t => {
  const { input, run } = setup(t);
  assert.notEqual(run.identity.sessionId, parent.sessionId);
  assert.equal(run.identity.buildId, parent.buildId);
  assert.equal(run.configuration.limits.maxModelCalls, 5);
  assert.equal(run.configuration.limits.maxSubagentDepth, 0);
  assert.equal(run.configuration.profile.maxContinuations, 0);
  assert.doesNotMatch(canonical(run.configuration.inputMessages), /PRIVATE_PROTOCOL|PRIVATE_MEDIA|privateSignature|providerReplay/);
  assert.deepEqual(prepareMemoryExtractionRun(input), run);
  assert.throws(() => prepareMemoryExtractionRun({ ...input,
    tools: [{ ...input.tools[0], name: 'run_command' }] }), { code: 'memory_extraction_tool_not_allowed' });
  assert.throws(() => nativeMemoryExtractionToolDefinitions({ policy: policy('off'), policyDigest: input.policyDigest }),
    { code: 'native_memory_extraction_policy_disabled' });
});

test('bounded Memory model work persists a separately attributed fact through real tools and SQLite', async t => {
  const f = setup(t); let calls = 0;
  const result = await f.execute(async request => {
    calls++;
    if (calls === 1) return call('search_memory', { query: 'invoice timestamps' }, 'search');
    if (calls === 2) return call('manage_memory', mutation(), 'remember');
    assert.equal(request.messages.at(-1).role, 'tool');
    return finish();
  });
  assert.equal(result.status, 'success'); assert.equal(result.snapshot.usage.modelCalls, 3);
  const [record] = f.provider.list();
  assert.equal(record.content, 'Invoices use UTC timestamps.');
  assert.equal(record.memoryType, 'fact'); assert.equal(record.confidence, .8);
  assert.equal(record.metadata.extractionPolicy, 'native-model-memory/v1');
  assert.equal(record.metadata.sourceWindowDigest, source.sourceDigest);
  assert.deepEqual(record.sourceEventIds, ['human-1']);
  const before = canonical(f.store.load(scope, f.run.identity.runId));
  assert.equal((await f.execute(async () => { throw Error('completed Run must not call model'); })).status, 'success');
  assert.equal(f.provider.list().length, 1);
  assert.equal(canonical(f.store.load(scope, f.run.identity.runId)), before);
});

test('automatic Memory rejects fabricated citations and cannot modify manually confirmed facts', async t => {
  const f = setup(t), binding = nativeMemoryScopeBindings(scope, ['user'])[0];
  const receipt = f.provider.applyMutation({ action: 'remember', scope: binding.scope, scopeId: binding.scopeId,
    content: 'User confirmed billing timezone.', operationKey: 'manual', requestDigest: memoryDigest('manual'),
    authority: 'explicit_user', sourceSessionId: parent.sessionId, sourceEventId: 'manual-source',
    sourceGoalRevision: '0', sourceGoalDigest: memoryDigest('manual goal') });
  const [original] = f.provider.list();
  assert.equal(original.writePolicy, 'user_confirm');
  let calls = 0;
  const result = await f.execute(async request => {
    calls++;
    if (calls === 1) return call('manage_memory', mutation({ source_event_ids: ['assistant-claim'] }), 'forged-source');
    if (calls === 2) {
      assert.match(request.messages.at(-1).content, /memory_extraction_source_not_in_window/);
      return call('manage_memory', mutation({ action: 'correct', memory_id: original.memoryId,
        expected_version: original.version, memory_type: 'profile' }), 'overwrite-manual');
    }
    assert.match(request.messages.at(-1).content, /memory_extraction_target_requires_consent/);
    return finish();
  });
  assert.equal(result.status, 'success');
  assert.deepEqual(f.provider.list(), [original]);
  assert.ok(receipt);
});

test('shadow automatic Memory runs the bounded policy without writing or requiring an alternative execution engine', async t => {
  const f = setup(t, 'shadow'); let calls = 0;
  const result = await f.execute(async request => {
    if (++calls === 1) return call('manage_memory', mutation(), 'shadow');
    assert.match(request.messages.at(-1).content, /"decision":"shadow"/);
    return finish();
  });
  assert.equal(result.status, 'success'); assert.equal(result.snapshot.usage.toolCalls, 1);
  assert.deepEqual(f.provider.list(), []);
});

test('revoking the admitted source before dispatch prevents an automatic Memory mutation', async t => {
  const f = setup(t);
  const result = await f.execute(async () => { f.revoke(); return call('manage_memory', mutation(), 'late'); });
  assert.equal(result.status, 'error'); assert.deepEqual(f.provider.list(), []);
});

test('Memory owner rejects invalid extraction provenance and protects manual records independently of its tool adapter', t => {
  const f = setup(t), binding = nativeMemoryScopeBindings(scope, ['user'])[0];
  const input = { action: 'remember', scope: binding.scope, scopeId: binding.scopeId,
    content: 'Project fact.', operationKey: 'model', requestDigest: memoryDigest('model'), authority: 'candidate',
    sourceSessionId: parent.sessionId, sourceEventId: 'human-1', sourceGoalRevision: '10', sourceGoalDigest: source.sourceDigest,
    extraction: { policy: 'native-model-memory/v1', memoryType: 'fact', sourceWindowDigest: source.sourceDigest,
      sourceEventIds: ['human-1'] } };
  assert.throws(() => f.provider.applyMutation({ ...input, authority: 'explicit_user' }),
    { code: 'native_memory_extraction_provenance_invalid' });
  assert.throws(() => f.provider.applyMutation({ ...input, extraction: { ...input.extraction, sourceEventIds: ['foreign'] } }),
    { code: 'native_memory_extraction_provenance_invalid' });
  const { extraction, ...manualInput } = input;
  f.provider.applyMutation({ ...manualInput, authority: 'explicit_user' });
  const [manual] = f.provider.list();
  assert.throws(() => f.provider.applyMutation({ ...input, operationKey: 'automatic-correction', action: 'correct',
    memoryId: manual.memoryId, expectedVersion: 1, extraction: { ...input.extraction, memoryType: 'profile' } }),
  { code: 'native_memory_slot_locked' });
  assert.deepEqual(f.provider.list(), [manual]);
});
