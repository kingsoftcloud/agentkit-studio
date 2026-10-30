import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeKernel, MemoryRunStore, emptyUsage, canonical, configure, reduceDeliveryReview, reviewSubject,
  projectSessionHistory, scheduleDeliveryReview, reduceCommand } from '../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { fixture, tool, scope, digest, acceptance, verificationReport } from './fixtures.mjs';

const write = tool({ name: 'write', readOnly: false, concurrentSafe: false });
const read = tool({ name: 'read', contextRole: 'workspace_read', recoveryPolicy: 'safe-read/v1' });
const call = (name, id = name, args = {}) => ({ kind: 'tool_calls', text: '',
  toolCalls: [{ callId: id, name, arguments: args }], usage: emptyUsage() });
const final = (text = 'Candidate.') => ({ kind: 'final_candidate', text, toolCalls: [], usage: emptyUsage() });
const finding = { issue: 'The zero balance case was omitted.', recommended_check: 'Inspect the implementation and add the zero case.' };
const suggestion = (findings = []) => ({ requirements: [{ requirement: 'Keep zero accounts.', implementation_evidence: 'ledger.ts',
  verification_evidence: 'No host semantic verifier available.' }], findings });
const review = (findings = []) => call('submit_delivery_review', 'review', suggestion(findings));

function setup(t, { sqlite = false, options = {}, script = [], noVerifier = false, passed = false, onCheckpoint, context = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'native-review-')), file = join(root, 'ledger.ts'), filename = join(root, 'run.sqlite');
  let store = sqlite ? new SqliteRunStore(filename) : new MemoryRunStore(), seen = null;
  const { config, snapshot } = fixture({ tools: [write, read], deliveryReviewPolicy: { pathSuffixes: ['.ts'] },
    contract: { objective: 'Keep zero accounts and test it.', acceptance: [acceptance({ verificationMethod: passed ? 'deterministic' : 'human' })] },
    limits: { maxModelCalls: 20, maxToolCalls: 20, maxRepairs: 3, finalizationReserveModelCalls: 0 },
    ...(context ? { contextPolicy: { tokenizerId: 'review-counter', tokenizerDigest: 'fixture-count/v1', enabled: true,
      triggerRatio: .95, targetRatio: .45, summaryMaxTokens: 80, maxCompactions: null,
      maxCompactionsWithoutProgress: 4, minModelTurnsBetween: 2, maxSummaryRetries: 2 },
      profile: { ...fixture().config.profile, contextWindow: 20000, maxOutputTokens: 128 } } : {}), ...options });
  const requests = [], effects = [], streams = []; let verifies = 0;
  const ports = { model: { generate: async (request, emit) => {
    requests.push(request); emit({ kind: 'text', text: request.purpose === 'delivery_review' ? 'PRIVATE_REVIEW_STREAM' : 'provisional' });
    const result = script[requests.length - 1]; assert.ok(result, 'Unexpected additional model call');
    return typeof result === 'function' ? result(request) : result;
  } }, tools: { execute: async request => {
    effects.push(request.call);
    if (request.call.name === 'read') return { status: 'ok', content: { text: readFileSync(file, 'utf8') } };
    writeFileSync(file, request.call.arguments.text ?? 'original'); return { status: 'ok', content: 'written', workspaceChangedPaths: ['ledger.ts'] };
  } }, workspace: { observe: async () => {
    const revision = digest(existsSync(file) ? readFileSync(file, 'utf8') : null);
    const changedPaths = seen !== null && seen !== revision ? ['ledger.ts'] : []; seen = revision;
    return { status: 'ok', revision, changedPaths };
  } }, ...(!noVerifier ? { verification: { verify: async request => {
    verifies++;
    return verificationReport(request, passed ? {} : { status: 'unverified', checks: [{ id: 'test', status: 'not_run', verifierId: 'fixture',
      verifierVersion: '1', verificationMethod: 'human', safeSummary: 'No host semantic verifier available.', evidenceRefs: ['fixture://public-test'] }] });
  } } } : {}), ...(context ? { context: { tokens: { tokenizerId: 'review-counter', tokenizerDigest: 'fixture-count/v1',
    countRequest: async request => Math.ceil(canonical({ messages: request.messages, tools: request.tools }).length / 4),
    countText: async request => Math.ceil(request.text.length / 4) } } } : {}) };
  const worker = extra => new NativeKernel({ store, ports, digest, owner: 'review-worker', onStream: (_, event) => streams.push(event),
    ...(onCheckpoint ? { onCheckpoint } : {}), ...extra });
  worker().start(snapshot, config);
  t.after(() => { store.close?.(); rmSync(root, { recursive: true, force: true }); });
  return { config, snapshot, file, ports, requests, effects, streams, worker, get store() { return store; }, get verifies() { return verifies; },
    reopen() { store.close(); store = new SqliteRunStore(filename); worker().attach(scope, 'run', config); } };
}

for (const sqlite of [false, true]) {
  const backend = sqlite ? 'sqlite' : 'memory';
  test(`${backend}: private diagnosis repairs actual files but never supplies human acceptance`, async t => {
    const run = setup(t, { sqlite, script: [call('write'), final(), review([finding]), call('write', 'repair', { text: 'fixed zero case' }), final('Repaired.'), review()] });
    const result = await run.worker().runUntilIdle(scope, 'run');
    assert.equal(readFileSync(run.file, 'utf8'), 'fixed zero case'); assert.equal(result.finalText, 'Repaired.');
    assert.equal(result.usage.modelCalls, 6); assert.equal(result.usage.toolCalls, 2); assert.equal(result.repairs, 1);
    assert.equal(result.outcome, 'unverified'); assert.equal(result.reason, 'required_verification_incomplete');
    assert.equal(result.deliveryReview.rounds, 2); assert.equal(result.deliveryReview.status, 'observed'); assert.ok(run.verifies >= 3);
    assert.equal(run.requests[2].purpose, 'delivery_review'); assert.equal(run.requests[2].messages.at(-1).kind, 'delivery_review_request');
    assert.ok(run.requests[2].tools.every(definition => definition.name !== 'write'));
    assert.ok(run.streams.every(event => !event.text.includes('PRIVATE_REVIEW')));
    assert.ok(!canonical(run.store.events(scope, 'run')).includes('PRIVATE_REVIEW'));
    assert.ok(run.requests[3].messages.every(message => !['delivery_review_request', 'delivery_review_candidate', 'continuation_fragment'].includes(message.kind)));
    assert.equal(run.store.events(scope, 'run').filter(event => event.kind === 'completion.delivery_review_completed').length, 2);
  });
  for (const bad of [final('All requirements passed.'), call('write', 'unauthorized', { text: 'forbidden' }),
    call('submit_delivery_review', 'forged', { ...suggestion(), verified: true })]) test(`${backend}: invalid review ${bad.kind}/${bad.toolCalls[0]?.name ?? 'text'} cannot replace the candidate or execute writes`, async t => {
    const run = setup(t, { sqlite, script: [call('write'), final(), bad] });
    const result = await run.worker().runUntilIdle(scope, 'run');
    assert.equal(result.usage.modelCalls, 3); assert.equal(result.usage.toolCalls, 1); assert.equal(run.effects.length, 1);
    assert.equal(readFileSync(run.file, 'utf8'), 'original'); assert.equal(result.finalText, 'Candidate.');
    assert.equal(result.outcome, 'unverified'); assert.equal(result.deliveryReview.status, 'unavailable');
  });
  test(`${backend}: an admitted last-budget source read executes through the original tool pipeline`, async t => {
    const run = setup(t, { sqlite, options: { limits: { maxModelCalls: 6, maxToolCalls: 20, maxRepairs: 3, finalizationReserveModelCalls: 0 } },
      script: [call('write'), final(), call('read'), review()] });
    const result = await run.worker().runUntilIdle(scope, 'run');
    assert.equal(result.usage.modelCalls, 4); assert.equal(result.usage.toolCalls, 2);
    assert.ok(run.requests[2].tools.some(definition => definition.name === 'read'));
    assert.deepEqual(run.requests[3].tools.map(definition => definition.name), ['submit_delivery_review']);
    assert.ok(run.requests[3].messages.some(message => message.role === 'tool' && message.content.includes('original')));
    assert.deepEqual(run.effects.map(effect => effect.name), ['write', 'read']); assert.equal(result.outcome, 'unverified');
    const history = projectSessionHistory(run.store.load(scope, 'run'), run.config, digest);
    assert.ok(history.some(message => message.kind === 'delivery_review_source' && message.toolCalls?.length));
    assert.ok(history.every(message => !message.kind?.startsWith('delivery_review_') || message.kind === 'delivery_review_source'));
  });
  test(`${backend}: bounded private suffix survives SQLite reopen before a repair`, async t => {
    const whole = '```json\n' + canonical(suggestion([finding])) + '\n```'; let stopped = false;
    const run = setup(t, { sqlite, script: [call('write'), final(), { ...final(whole.slice(0, 100)), kind: 'output_limit', textCommitVersion: 'provider-finished-text/v1' },
      final(whole.slice(100)), call('write', 'repair', { text: 'fixed' }), final('Repaired.'), review()],
    onCheckpoint: snapshot => { if (!stopped && snapshot.deliveryReview?.continuationMessages.length) { stopped = true; throw Error('review-checkpoint'); } } });
    await assert.rejects(run.worker().runUntilIdle(scope, 'run'), /review-checkpoint/);
    assert.equal(run.effects.length, 1); assert.equal(run.store.load(scope, 'run').snapshot.deliveryReview.status, 'pending');
    if (sqlite) run.reopen();
    const result = await run.worker({ now: () => Date.now() + 60000 }).runUntilIdle(scope, 'run');
    assert.equal(result.finalText, 'Repaired.'); assert.equal(result.usage.modelCalls, 7); assert.equal(result.usage.toolCalls, 2);
    assert.equal(result.repairs, 1); assert.equal(readFileSync(run.file, 'utf8'), 'fixed');
    assert.equal(run.requests[3].messages.at(-1).continuationMode, 'suffix');
  });
}

for (const modelLimit of [2, 3]) test(`model limit ${modelLimit} reserves repair room without scheduling a review`, async t => {
  const run = setup(t, { options: { limits: { maxModelCalls: modelLimit, finalizationReserveModelCalls: 0 } }, script: [call('write'), final()] });
  const result = await run.worker().runUntilIdle(scope, 'run'); assert.equal(result.usage.modelCalls, 2); assert.equal(result.deliveryReview, null);
});
for (const context of [false, true]) test(`clean review with ${context ? 'counted' : 'direct'} context cannot verify or reschedule the same subject`, async t => {
  const run = setup(t, { context, script: [call('write'), final(), review()] });
  const result = await run.worker().runUntilIdle(scope, 'run'); assert.equal(result.usage.modelCalls, 3);
  assert.equal(result.finalText, 'Candidate.'); assert.equal(result.outcome, 'unverified'); assert.equal(result.deliveryReview.rounds, 1);
});
test('review cannot compact an oversized private projection into the public task history', async t => {
  const run = setup(t, { context: true, script: [call('write'), final()] });
  const original = run.ports.context.tokens.countRequest;
  run.ports.context.tokens.countRequest = request => request.purpose === 'delivery_review' ? 100000 : original(request);
  const result = await run.worker().runUntilIdle(scope, 'run'); assert.equal(result.usage.modelCalls, 2);
  assert.equal(result.deliveryReview.reason, 'review_context_budget_unavailable'); assert.equal(result.contextState.history, null);
  assert.equal(result.finalText, 'Candidate.'); assert.equal(result.outcome, 'unverified');
});
test('a verified candidate and an unchanged readonly task skip review', async t => {
  for (const changed of [true, false]) {
    const run = setup(t, { passed: true, script: [...(changed ? [call('write')] : []), final()] });
    const result = await run.worker().runUntilIdle(scope, 'run'); assert.equal(result.outcome, 'verified');
    assert.equal(result.usage.modelCalls, changed ? 2 : 1); assert.equal(result.deliveryReview, null);
  }
});
for (const budget of [2, 3, 5]) test(`missing verifier with budget ${budget} can diagnose without becoming acceptance`, async t => {
  const run = setup(t, { noVerifier: true, options: { limits: { maxModelCalls: budget, finalizationReserveModelCalls: 0 } }, script: [call('write'), final(), review()] });
  const result = await run.worker().runUntilIdle(scope, 'run'); assert.equal(result.usage.modelCalls, budget === 5 ? 3 : 2);
  assert.equal(result.reason, 'verification_report_missing'); assert.equal(result.finalText, 'Candidate.'); assert.equal(result.outcome, 'unverified');
});
test('configuration omission and strict review policy validation', () => {
  const base = fixture().config; assert.equal(Object.hasOwn(base, 'deliveryReviewPolicy'), false); assert.deepEqual(configure(base), base);
  for (const policy of [{ pathSuffixes: [] }, { pathSuffixes: ['TS'] }, { pathSuffixes: ['.TS'] }, { pathSuffixes: ['.ts'], maxRounds: 5 },
    { pathSuffixes: ['.ts'], maxReadRounds: -1 }, { pathSuffixes: ['.ts'], reviewUnknownPaths: 'yes' }, { pathSuffixes: ['.ts'], extra: true }])
    assert.throws(() => fixture({ deliveryReviewPolicy: policy }), /invalid_delivery_review_policy/);
  assert.equal(fixture({ tools: [tool({ name: 'submit_delivery_review' })] }).config.tools[0].name, 'submit_delivery_review');
  assert.throws(() => fixture({ tools: [tool({ name: 'submit_delivery_review' })], deliveryReviewPolicy: { pathSuffixes: ['.ts'] } }), /reserved_delivery_review_tool/);
});

test('rounds cap changed subjects while preserving the final implementing candidate', async t => {
  const run = setup(t, { script: [call('write', 'v1', { text: 'v1' }), final('candidate1'), review([finding]),
    call('write', 'v2', { text: 'v2' }), final('candidate2'), review([finding]), call('write', 'v3', { text: 'v3' }), final('candidate3')] });
  const result = await run.worker().runUntilIdle(scope, 'run');
  assert.equal(result.usage.modelCalls, 8); assert.equal(result.usage.toolCalls, 3); assert.equal(result.repairs, 2);
  assert.equal(result.deliveryReview.rounds, 2); assert.equal(result.finalText, 'candidate3'); assert.equal(result.outcome, 'unverified');
});
for (const command of ['cancel', 'steer']) test(`${command} takes precedence at the committed review boundary`, async t => {
  let stopped = false;
  const run = setup(t, { script: [call('write'), final()], onCheckpoint: snapshot => {
    if (!stopped && snapshot.deliveryReview?.status === 'pending') { stopped = true; throw Error('pending-review'); }
  } });
  await assert.rejects(run.worker().runUntilIdle(scope, 'run'), /pending-review/);
  const snapshot = run.store.load(scope, 'run').snapshot;
  if (command === 'cancel') {
    run.worker().submit(scope, 'run', { commandId: 'cancel-review', kind: 'cancel', payload: {} });
    const result = await run.worker().runUntilIdle(scope, 'run'); assert.equal(result.phase, 'canceled'); assert.equal(run.requests.length, 2);
  } else {
    const changed = reduceCommand(snapshot, { commandId: 'new-goal', kind: 'steer', payload: { text: 'Answer a new question.', expectedGoalRevision: 0 } });
    assert.equal(changed.snapshot.goalRevision, 1); assert.equal(changed.snapshot.deliveryReview, null); assert.equal(changed.snapshot.candidate, null);
  }
});
test('a changed review subject rejects findings without spending repair authority', async t => {
  let stopped = false;
  const run = setup(t, { script: [call('write'), final()], onCheckpoint: snapshot => {
    if (!stopped && snapshot.deliveryReview?.status === 'pending') { stopped = true; throw Error('pending-review'); }
  } });
  await assert.rejects(run.worker().runUntilIdle(scope, 'run'), /pending-review/);
  const before = run.store.load(scope, 'run').snapshot, stale = { ...before, workspaceRevision: 'host-changed-content' };
  assert.notEqual(reviewSubject(stale, digest), before.deliveryReview.subjectDigest);
  const changes = reduceDeliveryReview(stale, review([finding]), run.config, digest, 'original-effect');
  assert.equal(changes.deliveryReview.reason, 'review_subject_changed'); assert.equal(changes.candidate, undefined);
  assert.equal(changes.repairs, undefined); assert.equal(changes.phase, 'verifying');
  assert.equal(scheduleDeliveryReview({ ...before, deliveryReview: null }, { ...run.config,
    contract: { ...run.config.contract, allowedToolNames: [] } }, 'required_verification_incomplete', digest), null);
});
test('review read rounds and mixed batches cannot grant unadvertised writes', async t => {
  for (const response of [call('read'), { ...call('read'), toolCalls: [...call('read').toolCalls, ...call('write', 'smuggled').toolCalls] }]) {
    const run = setup(t, { options: { deliveryReviewPolicy: { pathSuffixes: ['.ts'], maxReadRounds: 0 } }, script: [call('write'), final(), response] });
    const result = await run.worker().runUntilIdle(scope, 'run'); assert.equal(result.usage.toolCalls, 1);
    assert.equal(result.deliveryReview.status, 'unavailable'); assert.equal(readFileSync(run.file, 'utf8'), 'original');
  }
});
test('uncommitted truncated review text is unavailable without retiring the implementing candidate', async t => {
  const run = setup(t, { script: [call('write'), final(), { ...final('uncommitted review'), kind: 'output_limit' }] });
  const result = await run.worker().runUntilIdle(scope, 'run'); assert.equal(result.finalText, 'Candidate.');
  assert.equal(result.deliveryReview.reason, 'review_provider_commit_missing'); assert.equal(result.outcome, 'unverified');
});

test('review control preserves the reference escaped-JSON limit and Unicode string bounds', async t => {
  const unicode = '😀'.repeat(2048), data = { requirements: [{ requirement: unicode, implementation_evidence: unicode, verification_evidence: unicode }], findings: [] };
  for (const response of [call('submit_delivery_review', 'unicode', data), final(JSON.stringify(data))]) {
    const run = setup(t, { script: [call('write'), final(), response] });
    const result = await run.worker().runUntilIdle(scope, 'run'); assert.equal(result.finalText, 'Candidate.');
    assert.equal(result.deliveryReview.status, response.kind === 'tool_calls' ? 'unavailable' : 'observed'); assert.equal(result.outcome, 'unverified');
  }
});
