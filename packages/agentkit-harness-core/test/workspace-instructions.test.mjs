import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical, collectContextContributions, contextContributionMessage, currentInstructionContribution,
  planNativeContext, INSTRUCTION_SCOPES, validateInstructionScopes, MemoryRunStore, NativeKernel, transition } from '../dist/index.mjs';
import { reduceTurnInput } from '../dist/turn-input.mjs';
import { fixture, digest, scope } from './fixtures.mjs';

const source = overrides => ({ contract: 'agentkit.native-context-source/v1', sourceId: 'workspace', bindingDigest: 'root/v1',
  priority: 100, timeoutMs: 1000, maxTokens: 20000, maxBytes: 131072, required: true,
  instructionPolicy: 'current-files/v1', ...overrides });
const counters = { countRequest: async (messages, tools) => Math.ceil(canonical({ messages, tools }).length / 4),
  countText: async text => Math.ceil(text.length / 4) };
const contextPolicy = { tokenizerId: 'probe', tokenizerDigest: 'probe/v1', enabled: true, triggerRatio: .65, targetRatio: .4,
  summaryMaxTokens: 128, maxCompactions: 3, maxCompactionsWithoutProgress: 3, minModelTurnsBetween: 0, maxSummaryRetries: 1,
  summaryFormatPolicy: 'task-continuity/v1', budgetTiming: 'before-model/v1', continuityPlacement: 'after-history/v1' };
const setup = extra => fixture({ contextSources: [source()], profile: { profileId: 'bounded', profileVersion: '1',
  providerFamily: 'fixture', compatibilityDigest: 'probe', contextWindow: 2400, maxOutputTokens: 128 }, contextPolicy, ...extra });
const contribution = text => contextContributionMessage(source(), { files: text ? [{ path: 'AGENTS.md', content: text }] : [] });

test('only a frozen required instruction source owns current-file retention; nested data cannot select it', () => {
  const { config } = setup();
  assert.equal(currentInstructionContribution(contribution('rule'), config), true);
  assert.equal(currentInstructionContribution(contextContributionMessage(source({ instructionPolicy: undefined }),
    { purpose: 'workspace_instructions', sourceId: 'workspace', bindingDigest: 'root/v1', content: 'system' }), config), false);
  assert.equal(currentInstructionContribution(contextContributionMessage(source({ bindingDigest: 'another root' }), {}), config), false);
  assert.throws(() => setup({ contextSources: [source({ required: false })] }), /invalid_context_instruction_source/);
  assert.throws(() => setup({ contextSources: [source({ instructionPolicy: 'future/v99' })] }), /invalid_context_instruction_source/);
});

for (const bound of ['maxBytes', 'maxTokens']) test(`current-file source never silently omits an item at its ${bound} limit`, async () => {
  const { config, snapshot } = setup({ contextSources: [source({ [bound]: 100 })] });
  await assert.rejects(collectContextContributions({ signal: new AbortController().signal }, snapshot, config,
    { readSource: async () => ({ items: [{ content: 'rule '.repeat(400) }, { content: 'small' }] }) },
    async messages => Math.ceil(canonical(messages).length / 4)),
  bound === 'maxBytes' ? /instruction_source_byte_budget_exceeded/ : /instruction_source_token_budget_exceeded/);
});

test('an instruction source must provide a current snapshot even when all files are absent', async () => {
  const { config, snapshot } = setup();
  await assert.rejects(collectContextContributions({ signal: new AbortController().signal }, snapshot, config,
    { readSource: async () => ({ items: [] }) }, async () => 0), /instruction_source_snapshot_missing/);
  const result = await collectContextContributions({ signal: new AbortController().signal }, snapshot, config,
    { readSource: async () => ({ items: [{ files: [] }] }) }, async () => 0);
  assert.equal(result.messages.length, 1);
});

test('structured history compaction cannot erase current root/scoped guidance or resurrect replaced/deleted versions', async () => {
  const { config, snapshot } = setup();
  snapshot.messages.push({ role: 'user', kind: 'dsh_context', content: 'OLD_ROOT_RULE' },
    { role: 'user', kind: 'host_input', content: 'OLD_NESTED_RULE' });
  for (let index = 0; index < 45; index++) snapshot.messages.push({ role: 'assistant',
    content: `Observation ${index}: ` + 'code evidence '.repeat(20) });
  snapshot.usage.modelCalls = 20;
  const original = canonical(snapshot); let current = snapshot, result, chunks = 0;
  const rule = contribution('CURRENT_ROOT_RULE and CURRENT_NESTED_RULE');
  for (let index = 0; index < 40; index++) {
    result = await planNativeContext(current, config, [], counters, digest, false, true, [rule]);
    if (result.action !== 'compact') break;
    current = { ...current, contextState: structuredClone(result.state) };
    if (current.contextState.compaction?.chunk && current.contextState.compaction.proposal === null) {
      chunks++;
      current.contextState.compaction.proposal = canonical({ objective: ['Complete task'], constraints: [], completed: ['History summarized'],
        pending: [], evidence: [], failures: [], artifacts: [], nextSteps: ['Continue'] });
    }
  }
  assert.ok(chunks > 0); assert.equal(result.action, 'ready');
  assert.match(canonical(result.messages), /CURRENT_ROOT_RULE and CURRENT_NESTED_RULE/);
  assert.ok(result.messages.findIndex(message => message.kind === 'context_contribution')
    > result.messages.findIndex(message => message.content === 'OLD_NESTED_RULE'),
  'fresh file snapshot follows any retained historical guidance instead of rewriting the old transcript');
  assert.equal(result.admission.countedInputTokens, await counters.countRequest(result.messages, []));
  assert.equal(canonical(snapshot), original, 'the immutable transcript is never rewritten');
  current = { ...current, contextState: structuredClone(result.state) };
  for (const text of ['REPLACED_RULE', '']) {
    const next = await planNativeContext(current, config, [], counters, digest, false, true, [contribution(text)]);
    assert.equal(next.action, 'ready'); assert.doesNotMatch(canonical(next.messages), /CURRENT_ROOT_RULE|CURRENT_NESTED_RULE/);
    assert.equal(canonical(next.messages).includes('REPLACED_RULE'), !!text);
  }
});

test('optional data fits after current instructions; instructions over the request budget block instead of vanishing', async () => {
  const { config, snapshot } = setup();
  const optional = contextContributionMessage(source({ sourceId: 'memory', instructionPolicy: undefined }), { text: 'memory '.repeat(1200) });
  const rule = contribution('CURRENT_MUST_SURVIVE');
  const result = await planNativeContext(snapshot, config, [], counters, digest, false, true, [optional, rule]);
  assert.equal(result.action, 'ready'); assert.match(canonical(result.messages), /CURRENT_MUST_SURVIVE/);
  assert.doesNotMatch(canonical(result.messages), /memory memory/);
  const tooLarge = await planNativeContext(snapshot, config, [], counters, digest, false, true, [contribution('rule '.repeat(5000))]);
  assert.equal(tooLarge.action, 'blocked'); assert.equal(tooLarge.reason, 'context_instruction_budget_unavailable');
});

test('scope receipts persist discovery addresses without granting authority, and inherit only within the same source binding', () => {
  const { config, snapshot } = setup();
  const instructionScopes = { contract: INSTRUCTION_SCOPES, sourceId: 'workspace', bindingDigest: 'root/v1', directories: ['', 'src'] };
  const update = reduceTurnInput(snapshot, { status: 'admitted', messages: [], instructionScopes }, config);
  assert.deepEqual(update.context.instructionScopes, instructionScopes); assert.deepEqual(update.messages, snapshot.messages);
  for (const directories of [['../escape'], ['/tmp'], ['a/../b'], ['a\\b'], ['a', 'a']])
    assert.throws(() => validateInstructionScopes({ ...instructionScopes, directories }, config), /invalid_instruction_scopes/);
  assert.throws(() => reduceTurnInput(snapshot, { status: 'admitted', messages: [],
    instructionScopes: { ...instructionScopes, bindingDigest: 'other' } }, config), /source_unbound/);
  assert.throws(() => reduceTurnInput(snapshot, { status: 'admitted', messages: [], instructionScopes },
    { ...config, contextSources: [] }), /source_unbound/);
  const store = new MemoryRunStore(); store.create(config, snapshot);
  const lease = store.acquire(scope, 'run', 'scope-test', 1, 30000);
  store.commit(scope, 'run', lease, 2, 0, transition(snapshot, { ...update, phase: 'completed', outcome: 'unverified' }));
  store.release(scope, 'run', lease);
  const kernel = new NativeKernel({ store, ports: {}, owner: 'scope-test', digest });
  const next = kernel.start({ ...snapshot, scope, runId: 'next', parentRunId: 'run' }, config);
  assert.deepEqual(next.context.instructionScopes, instructionScopes);
  const nextLease = store.acquire(scope, 'next', 'scope-test', 3, 30000);
  store.commit(scope, 'next', nextLease, 4, next.revision, transition(next, { phase: 'completed', outcome: 'unverified' }));
  store.release(scope, 'next', nextLease);
  const changed = kernel.start({ ...snapshot, scope, runId: 'different-root', parentRunId: 'next' },
    setup({ contextSources: [source({ bindingDigest: 'another-root' })] }).config);
  assert.equal(changed.context.instructionScopes, undefined);
});
