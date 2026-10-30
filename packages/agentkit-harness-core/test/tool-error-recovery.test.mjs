import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeKernel, MemoryRunStore, emptyUsage, configure, canonical, contextContinuity, plan,
  refuseUndiagnosedToolAction, advanceObservedProgress, advanceToolErrorStreak } from '../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { fixture, tool, scope, digest, acceptance, verificationReport } from './fixtures.mjs';

const write = tool({ name: 'write', readOnly: false, concurrentSafe: false });
const read = tool({ name: 'read', contextRole: 'workspace_read' });
const replace = tool({ name: 'replace', readOnly: false, concurrentSafe: false });
const action = (id, name = 'write', args = {}) => ({ callId: `call-${id}`, name, arguments: args });
const calls = (...toolCalls) => ({ kind: 'tool_calls', text: '', toolCalls, usage: emptyUsage() });
const final = (text = 'Actual result delivered.') => ({ kind: 'final_candidate', text, toolCalls: [], usage: emptyUsage() });
const errors = () => Array.from({ length: 6 }, (_, i) => calls(action(i, 'write', { text: 'wrong' })));

function setup(t, { sqlite = false, options = {}, script = [], execute, verify, onCheckpoint } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'native-diagnosis-')), filename = join(root, 'run.sqlite'), file = join(root, 'result.txt');
  let store = sqlite ? new SqliteRunStore(filename) : new MemoryRunStore();
  const { config, snapshot } = fixture({ toolErrorRecoveryPolicy: 'diagnose-before-repeat/v1',
    toolErrorRecoveryModelCalls: 3, tools: [write, read, replace],
    limits: { maxModelCalls: 20, maxToolCalls: 20, finalizationReserveModelCalls: 0 }, ...options });
  const requests = [], effects = [];
  const ports = { model: { generate: async request => {
    requests.push(request); const result = script[requests.length - 1]; assert.ok(result, 'Unexpected additional model request');
    return typeof result === 'function' ? result(request) : result;
  } }, tools: { execute: async request => {
    effects.push({ call: request.call, interaction: request.interaction });
    if (execute) return execute(request, { file, effects, requests });
    if (request.call.name === 'read') return { status: 'ok', content: { actual: 'use corrected content' } };
    if (request.call.name === 'replace' || request.call.arguments.text === 'corrected') {
      writeFileSync(file, 'correct'); return { status: 'ok', content: { written: true }, workspaceChangedPaths: ['result.txt'] };
    }
    return { status: 'error', content: { code: 'exact_content_mismatch' } };
  } }, ...(verify ? { verification: { verify: request => verify(request, file) } } : {}) };
  const worker = extra => new NativeKernel({ store, ports, digest, owner: 'diagnosis-worker', ...(onCheckpoint ? { onCheckpoint } : {}), ...extra });
  worker().start(snapshot, config);
  t.after(() => { store.close?.(); rmSync(root, { recursive: true, force: true }); });
  return { config, snapshot, file, ports, requests, effects, worker, get store() { return store; },
    reopen() { store.close(); store = new SqliteRunStore(filename); worker().attach(scope, 'run', config); } };
}
const names = run => run.effects.map(row => row.call.name);
const refusals = snapshot => snapshot.messages.filter(message => message.role === 'tool' && message.content.includes('tool_error_diagnosis_required'));

for (const sqlite of [false, true]) {
  const backend = sqlite ? 'sqlite' : 'memory';
  test(`${backend}: context overflow and actual summary retries consume the original diagnosis allowance`, async t => {
    const run = setup(t, { sqlite, options: {
      profile: { ...fixture().config.profile, contextWindow: 20000, maxOutputTokens: 128, retryInitialDelayMs: 0, maxProviderRetries: 9 },
      contextPolicy: { tokenizerId: 'fixture-counter', tokenizerDigest: 'fixture-count/v1', enabled: true,
        triggerRatio: .95, targetRatio: .45, summaryMaxTokens: 80, maxCompactions: null,
        maxCompactionsWithoutProgress: 4, minModelTurnsBetween: 2, maxSummaryRetries: 9 },
    }, script: [...errors(), { ...final(''), kind: 'context_overflow' },
      { ...final(''), kind: 'provider_retryable_error' }, { ...final(''), kind: 'provider_retryable_error' }, final('must not be requested')] });
    run.ports.context = { tokens: { tokenizerId: 'fixture-counter', tokenizerDigest: 'fixture-count/v1',
      countRequest: async request => Math.ceil(canonical({ messages: request.messages, tools: request.tools }).length / 4),
      countText: async request => Math.ceil(request.text.length / 4) } };
    const result = await run.worker().runUntilIdle(scope, 'run');
    assert.equal(result.reason, 'repeated_tool_error_recovery_exhausted'); assert.equal(result.usage.modelCalls, 9);
    assert.equal(run.effects.length, 6); assert.equal(result.toolErrorRecovery.startedModelCall, 6);
    assert.equal(run.requests.filter(request => request.messages[0]?.kind === 'compaction_instructions').length, 2);
    assert.equal(result.contextState.compaction.providerErrors, 2);
    assert.equal(result.contextState.compaction.errors, 0); assert.equal(result.contextState.history, null);
    assert.match(canonical(contextContinuity(result, run.config)), /original budget|compaction/);
  });
  test(`${backend}: six definite failures permit diagnosis and one actual verified correction`, async t => {
    const run = setup(t, { sqlite, options: { contract: { objective: 'Write and verify', acceptance: [acceptance()] } },
      script: [...errors(), calls(action(6, 'read')), calls(action(7, 'write', { text: 'corrected' })), final()],
      verify: (request, file) => { assert.equal(readFileSync(file, 'utf8'), 'correct'); return verificationReport(request); } });
    const result = await run.worker().runUntilIdle(scope, 'run');
    assert.equal(result.phase, 'completed'); assert.equal(result.outcome, 'verified'); assert.equal(result.usage.modelCalls, 9);
    assert.equal(result.usage.toolCalls, 8); assert.deepEqual(names(run), [...Array(6).fill('write'), 'read', 'write']);
    assert.equal(result.toolErrorRecovery, null); assert.equal(result.toolErrorStreak.count, 0);
    const observation = run.requests[6].messages.find(message => message.kind === 'tool_error_recovery_observation');
    assert.equal(JSON.parse(observation.content).failed_tool, 'write'); assert.equal(JSON.parse(observation.content).diagnosis_is_not_completion, true);
    assert.equal(readFileSync(run.file, 'utf8'), 'correct');
  });
  test(`${backend}: changing write arguments never evades diagnosis or extends its explicit allowance`, async t => {
    const run = setup(t, { sqlite, script: Array.from({ length: 12 }, (_, i) => calls(action(i, 'write', { text: String(i) }))) });
    const result = await run.worker().runUntilIdle(scope, 'run');
    assert.deepEqual(names(run), Array(6).fill('write')); assert.equal(result.usage.modelCalls, 9); assert.equal(result.usage.toolCalls, 6);
    assert.equal(result.reason, 'repeated_tool_error_recovery_exhausted'); assert.equal(existsSync(run.file), false);
    assert.deepEqual(refusals(result).map(message => message.callId), ['call-6', 'call-7', 'call-8']);
    assert.ok(refusals(result).every(message => JSON.parse(message.content).execution_status === 'not_dispatched'));
  });
  for (const alternative of ['read', 'replace']) test(`${backend}: unrelated ${alternative} cannot reset the bounded diagnosis window`, async t => {
    const run = setup(t, { sqlite, script: [...errors(), ...Array.from({ length: 6 }, (_, i) => calls(action(6 + i, alternative, { path: `unrelated-${i}` })))] });
    const result = await run.worker().runUntilIdle(scope, 'run');
    assert.equal(result.reason, 'repeated_tool_error_recovery_exhausted'); assert.equal(result.usage.modelCalls, 9);
    assert.equal(result.usage.toolCalls, 9); assert.equal(result.toolErrorRecovery.startedModelCall, 6);
    assert.equal(result.toolErrorStreak.count, 6); assert.deepEqual(names(run), [...Array(6).fill('write'), ...Array(3).fill(alternative)]);
  });
  test(`${backend}: approval and unknown effects remain separate from diagnostic authority`, async t => {
    const run = setup(t, { sqlite, script: [calls(action(0)), calls(action(1, 'read'))],
      execute: async () => ({ status: 'uncertain', content: { possiblyWritten: true } }) });
    const result = await run.worker().runUntilIdle(scope, 'run');
    assert.equal(result.reason, 'effect_outcome_unknown'); assert.equal(run.effects.length, 1); assert.equal(run.requests.length, 1);
    assert.equal(result.toolErrorRecovery, null);
  });
  test(`${backend}: empty responses spend the same diagnostic allowance`, async t => {
    const run = setup(t, { sqlite, options: { toolErrorRecoveryModelCalls: 2,
      profile: { ...fixture().config.profile, retryInitialDelayMs: 0, maxRetries: 9 } },
    script: [...errors(), { ...final(''), kind: 'empty_response' }, { ...final(''), kind: 'empty_response' }, final('must not be called')] });
    const result = await run.worker().runUntilIdle(scope, 'run');
    assert.equal(result.reason, 'repeated_tool_error_recovery_exhausted'); assert.equal(run.requests.length, 8); assert.equal(run.effects.length, 6);
  });
  test(`${backend}: the original model budget still limits diagnostic work`, async t => {
    const run = setup(t, { sqlite, options: { limits: { maxModelCalls: 7, maxToolCalls: 20, finalizationReserveModelCalls: 0 } },
      script: [...errors(), calls(action(6, 'read')), calls(action(7, 'write', { text: 'corrected' })), final()] });
    const result = await run.worker().runUntilIdle(scope, 'run');
    assert.equal(result.reason, 'model_budget_exhausted'); assert.equal(run.requests.length, 7); assert.equal(run.effects.length, 7);
    assert.equal(JSON.parse(run.requests[6].messages.find(message => message.kind === 'tool_error_recovery_observation').content).remaining_model_calls, 1);
  });
  test(`${backend}: a failed trial cannot acquire a second trial from later observations`, async t => {
    const run = setup(t, { sqlite, options: { toolErrorRecoveryModelCalls: null }, script: [...errors(), calls(action(6, 'read')),
      calls(action(7, 'write', { text: 'still wrong' })), calls(action(8, 'read', { path: 'other' })),
      calls(action(9, 'write', { text: 'corrected' })), calls(action(10, 'replace')), final()] });
    const result = await run.worker().runUntilIdle(scope, 'run');
    assert.equal(result.phase, 'completed'); assert.equal(result.toolErrorRecovery.trialConsumed, true);
    assert.equal(result.usage.modelCalls, 12); assert.equal(result.usage.toolCalls, 10);
    assert.deepEqual(refusals(result).map(message => message.callId), ['call-9']);
    assert.deepEqual(names(run), [...Array(6).fill('write'), 'read', 'write', 'read', 'replace']);
  });
  test(`${backend}: historical identical read data cannot authorize a new trial`, async t => {
    const run = setup(t, { sqlite, script: [calls(action('prior', 'read')), ...errors(), calls(action(6, 'read')),
      calls(action(7, 'write', { text: 'corrected' })), calls(action(8, 'read')), final('must not be dispatched')] });
    const result = await run.worker().runUntilIdle(scope, 'run');
    assert.equal(result.reason, 'repeated_tool_error_recovery_exhausted');
    assert.equal(result.toolErrorRecovery.diagnosticObservationSeen, false);
    assert.equal(result.observedProgressRevision, 1); assert.equal(result.toolErrorRecovery.observationRevision, 1);
    assert.deepEqual(refusals(result).map(message => message.callId), ['call-7']); assert.equal(existsSync(run.file), false);
  });
  test(`${backend}: without the opt-in the legacy six-error stop remains`, async t => {
    const run = setup(t, { sqlite, options: { toolErrorRecoveryPolicy: undefined, toolErrorRecoveryModelCalls: undefined }, script: [...errors(), final()] });
    const result = await run.worker().runUntilIdle(scope, 'run');
    assert.equal(result.reason, 'repeated_tool_error_no_progress'); assert.equal(run.requests.length, 6);
    assert.equal(Object.hasOwn(run.config, 'toolErrorRecoveryPolicy'), false); assert.equal(Object.hasOwn(result, 'toolErrorRecovery'), false);
  });
  for (const decision of ['allow', 'cancel']) test(`${backend}: the one trial still requires actual approval; ${decision}`, async t => {
    let successfulWrites = 0;
    const run = setup(t, { sqlite, script: [...errors(), calls(action(6, 'read')), calls(action(7, 'write', { text: 'corrected' })), final()],
      execute: async (request, { file }) => {
        if (request.call.name === 'read') return { status: 'ok', content: { actual: 'corrected' } };
        if (request.call.arguments.text !== 'corrected') return { status: 'error', content: { code: 'mismatch' } };
        if (!request.interaction) return { status: 'approval_required', interactionId: 'trial-approval', content: {} };
        assert.equal(request.interaction.decision, 'allow'); successfulWrites++; writeFileSync(file, 'correct');
        return { status: 'ok', content: 'written', workspaceChangedPaths: ['result.txt'] };
      } });
    const waiting = await run.worker().runUntilIdle(scope, 'run');
    assert.equal(waiting.phase, 'awaiting_interaction'); assert.equal(waiting.toolErrorRecovery.trialConsumed, true);
    assert.equal(waiting.usage.toolCalls, 7); assert.equal(successfulWrites, 0);
    if (sqlite) run.reopen();
    run.worker().submit(scope, 'run', decision === 'allow' ? { commandId: 'trial-permission', kind: 'submit_interaction',
      payload: { interactionId: waiting.pendingInteraction.interactionId, decision: 'allow' } }
      : { commandId: 'cancel-trial', kind: 'cancel', payload: {} });
    const result = await run.worker().runUntilIdle(scope, 'run');
    assert.equal(result.phase, decision === 'allow' ? 'completed' : 'canceled');
    assert.equal(successfulWrites, decision === 'allow' ? 1 : 0);
    assert.equal(run.requests.length, decision === 'allow' ? 9 : 8);
  });
}

test('optional versioned policy/allowance omit old configuration fields; invalid values fail closed', () => {
  const old = fixture().config;
  assert.equal(Object.hasOwn(old, 'toolErrorRecoveryPolicy'), false); assert.equal(Object.hasOwn(old, 'toolErrorRecoveryModelCalls'), false);
  assert.notEqual(digest(old), digest(fixture({ toolErrorRecoveryPolicy: 'diagnose-before-repeat/v1' }).config));
  for (const value of [0, -1, 11, 1.5, true, '3', NaN, Infinity]) assert.throws(() => fixture({ toolErrorRecoveryModelCalls: value }));
  assert.throws(() => fixture({ toolErrorRecoveryPolicy: 'unknown' }), { code: 'invalid_tool_error_recovery_policy' });
  assert.equal(configure({ ...old, toolErrorRecoveryModelCalls: 3 }).toolErrorRecoveryModelCalls, 3);
});

test('pruned or reused call IDs cannot create another diagnostic trial in a later model decision', () => {
  const { snapshot } = fixture();
  Object.assign(snapshot, { usage: { ...snapshot.usage, modelCalls: 9 }, pendingTools: [action('reused')], toolErrorRecovery: {
    action: { name: 'write', argumentsDigest: null }, failureFingerprint: 'failure', startedModelCall: 6, priorModelCallsSpent: 0,
    observationRevision: 0, goalRevision: 0, workspaceRevision: null, diagnosticObservationSeen: true,
    diagnosticModelCall: 7, trialConsumed: true, trialCallId: 'call-reused', trialModelCall: 8 } });
  const rejected = refuseUndiagnosedToolAction(snapshot, snapshot.pendingTools[0], digest);
  assert.equal(rejected.intents.length, 0); assert.match(rejected.snapshot.messages.at(-1).content, /not_dispatched/);
});

test('diagnosis facts survive compaction and the original allowance fences summary inference too', () => {
  const { config, snapshot } = fixture({ toolErrorRecoveryPolicy: 'diagnose-before-repeat/v1', toolErrorRecoveryModelCalls: 3 });
  Object.assign(snapshot, { phase: 'compacting', usage: { ...snapshot.usage, modelCalls: 9 }, toolErrorRecovery: {
    action: { name: 'write', argumentsDigest: null }, failureFingerprint: 'original-error', startedModelCall: 6, priorModelCallsSpent: 0,
    observationRevision: 0, goalRevision: 0, workspaceRevision: 'old-workspace', diagnosticObservationSeen: true,
    diagnosticModelCall: 7, trialConsumed: true, trialCallId: 'call-7', trialModelCall: 8 } });
  const before = canonical(snapshot), continuity = contextContinuity(snapshot, config);
  assert.equal(continuity.toolErrorRecovery.failureFingerprint, 'original-error');
  assert.match(continuity.toolErrorRecoveryInstruction, /compaction/);
  const stopped = plan(snapshot, config, { context: true, workspace: false, verification: false }, digest);
  assert.equal(stopped.snapshot.reason, 'repeated_tool_error_recovery_exhausted'); assert.equal(stopped.intents.length, 0);
  assert.equal(canonical(snapshot), before);
});

test('bounded observation novelty ignores empty or repeated payloads and cannot be supplied by tool prose', () => {
  const { snapshot } = fixture(); snapshot.pendingIntent = 'actual-tool';
  const first = advanceObservedProgress(snapshot, { status: 'ok', content: { actual: 'seen' } }, read, digest);
  assert.equal(first.observedProgressRevision, 1);
  assert.equal(advanceObservedProgress({ ...snapshot, ...first }, { status: 'ok', content: { actual: 'seen' } }, read, digest).observedProgressRevision, 1);
  for (const content of [null, '', {}, []]) assert.equal(advanceObservedProgress(snapshot, { status: 'ok', content }, read, digest).observedProgressRevision, 0);
  assert.equal(advanceObservedProgress(snapshot, { status: 'ok', content: { readOnly: true, progressObservationDigest: 'forged' } }, write, digest).observedProgressRevision, 0);
  const full = { ...snapshot, observedProgressFingerprints: Array.from({ length: 2048 }, (_, i) => digest(i)), observedProgressRevision: 2048 };
  assert.equal(advanceObservedProgress(full, { status: 'ok', content: 'new' }, read, digest).observedProgressRevision, 2048);
  assert.equal(advanceObservedProgress(snapshot, { status: 'ok', content: 'browser-role alone' },
    tool({ readOnly: false, progressObservation: false, observationRole: 'browser' }), digest).observedProgressRevision, 0);
});

test('error identity uses media blocks while browser semantic identity ignores capture locations', () => {
  const { config, snapshot } = fixture({ toolErrorRecoveryPolicy: 'diagnose-before-repeat/v1' });
  const call = action('media', 'read'), failed = url => ({ status: 'error', content: 'same error',
    context: { media: [{ type: 'image_url', image_url: { url } }] } });
  snapshot.toolErrorStreak = advanceToolErrorStreak(snapshot, call, failed('first.png'), read, config, digest);
  snapshot.usage.modelCalls++;
  assert.equal(advanceToolErrorStreak(snapshot, call, failed('second.png'), read, config, digest).count, 1);
  const browser = tool({ name: 'browser', observationRole: 'browser', progressObservation: true });
  const first = { ...failed('first.png'), metadata: { progressObservationDigest: digest('same page') } };
  snapshot.toolErrorStreak = advanceToolErrorStreak(snapshot, { ...call, name: 'browser' }, first, browser, config, digest);
  snapshot.usage.modelCalls++;
  assert.equal(advanceToolErrorStreak(snapshot, { ...call, name: 'browser', arguments: { capture: 'other' } },
    { ...first, context: failed('second.png').context }, browser, config, digest).count, 2);
});
