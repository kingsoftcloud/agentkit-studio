import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeKernel, MemoryRunStore, advertisedTools, advanceInteractionObservation, browserTaskMessages,
  deliveryTaskMessages, emptyUsage, invalidatesBrowserObservation, reduceCommand, reduceModel, reduceTools,
  webObservationDue, webVerificationOnly, validateBrowserObservation, validateBrowserSessionRef } from '../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { canonical } from '../dist/index.mjs';
import { fixture, tool, scope, digest } from './fixtures.mjs';

const browser = tool({ name: 'browser', readOnly: false, concurrentSafe: false, observationRole: 'browser' });
const edit = tool({ name: 'edit', readOnly: false, concurrentSafe: false });
const policy = { role: 'browser', pathSuffixes: ['.html', '.css', '.js'] };
const configured = (overrides = {}) => fixture({ tools: [edit, tool(), browser], workspaceObservationPolicy: policy,
  limits: { maxModelCalls: 10, verificationReserveModelCalls: 5 }, ...overrides });
const state = (snapshot, changes = {}, models = 0) => ({ ...snapshot, ...changes,
  usage: { ...snapshot.usage, ...changes.usage, modelCalls: models } });
const names = (snapshot, config) => advertisedTools(snapshot, config).map(tool => tool.name);
const call = (name, callId = name) => ({ callId, name, arguments: {} });
const response = (...calls) => ({ kind: 'tool_calls', text: '', toolCalls: calls, usage: emptyUsage() });
const failure = { status: 'error', content: { entry_path: 'index.html', page_errors: ['button failed'] } };
const sticky = { toolName: 'browser', entryPath: 'index.html', toolCall: 4, error: 'button failed', digest: 'failure' };
const successful = (actions, changes = {}) => ({ status: 'ok', content: {
  entry_path: 'index.html', ok: true, actions_ok: true, actions, ...changes } });
const ref = validateBrowserSessionRef({ sessionId: 'page', scope, runId: 'run', runtimeId: 'owner', workspaceRevision: 'source' });
const observed = () => validateBrowserObservation({ sessionRef: ref, actionId: 'capture', actionSeq: 1,
  status: 'ok', complete: true, retryability: 'safe', viewport: [1280, 720], text: 'Page observed',
  screenshot: { contentRef: 'host:screenshot', width: 1280, height: 720,
    contentBlock: { type: 'image_url', image_url: { url: 'data:image/png;base64,cG5n' } } } });

test('workspace observation policy is explicit, pinned, case insensitive and inactive by default', () => {
  const { config, snapshot } = configured();
  assert.equal(invalidatesBrowserObservation({ status: 'error', content: {}, workspaceChangedPaths: ['APP.HTML'] }, config), true);
  for (const path of ['notes.md', 'app.html.bak', 'script.py']) assert.equal(invalidatesBrowserObservation({
    status: 'ok', content: {}, workspaceChangedPaths: [path] }, config), false);
  const plain = configured({ workspaceObservationPolicy: null });
  const late = state(snapshot, { lastWebMutationToolCall: 2 }, 8);
  assert.deepEqual(names(late, plain.config), ['edit', 'read', 'browser']);
  assert.equal(invalidatesBrowserObservation({ status: 'ok', content: {}, workspaceChangedPaths: ['index.html'] }, plain.config), false);
  for (const pathSuffixes of [[], ['HTML'], ['.HTML'], ['.a/b'], Array(65).fill('.html')]) {
    assert.throws(() => configured({ workspaceObservationPolicy: { role: 'browser', pathSuffixes } }),
      { code: 'invalid_workspace_observation_policy' });
  }
  for (const key of ['verificationReserveModelCalls', 'browserObservationIntervalToolCalls']) {
    for (const value of [-1, .5, NaN]) assert.throws(() => configured({ limits: { [key]: value } }));
  }
});

for (const [models, due, verification, expected] of [
  [4, false, false, ['edit', 'read', 'browser']],
  [5, true, false, ['browser']], [6, true, false, ['browser']],
  [8, true, true, ['browser']], [9, false, false, []],
]) test(`model reserve boundary: ${10 - models} remaining`, () => {
  const { config, snapshot } = configured();
  const current = state(snapshot, { lastWebMutationToolCall: 2, usage: { toolCalls: 2 } }, models);
  assert.equal(webObservationDue(current, config), due);
  assert.equal(webVerificationOnly(current, config), verification);
  assert.deepEqual(names(current, config), expected);
});

test('verification window allows reads only with fresh successful evidence and no unresolved interaction', () => {
  const { config, snapshot } = configured({ limits: { maxModelCalls: 10, verificationReserveModelCalls: 3 } });
  const late = state(snapshot, { lastWebMutationToolCall: 2, lastBrowserAttemptToolCall: 3,
    lastBrowserObservation: { toolCall: 3 } }, 8);
  assert.equal(webVerificationOnly(late, config), true);
  assert.deepEqual(names(late, config), ['read', 'browser']);
  for (const change of [{ lastBrowserObservation: null }, { lastBrowserObservation: { toolCall: 1 } },
    { unresolvedInteractionObservation: sticky }]) assert.deepEqual(names({ ...late, ...change }, config), ['browser']);
});

test('interval attempts unlock repairs without becoming successful evidence; later changes become due again', () => {
  const { config, snapshot } = configured({ limits: { browserObservationIntervalToolCalls: 3 } });
  const current = { ...snapshot, lastWebMutationToolCall: 1, usage: { ...snapshot.usage, toolCalls: 3 } };
  assert.equal(webObservationDue(current, config), true);
  for (const changed of [{ lastBrowserAttemptToolCall: 3 }, { unresolvedInteractionObservation: sticky },
    { lastBrowserObservation: { toolCall: 3 } }]) assert.equal(webObservationDue({ ...current, ...changed }, config), false);
  const repair = { ...current, lastBrowserAttemptToolCall: 3, lastWebMutationToolCall: 4,
    usage: { ...current.usage, toolCalls: 6 } };
  assert.equal(webObservationDue(repair, config), true);
});

test('descendant claims share the reserve and contract scope cannot be bypassed by a registered browser', () => {
  const { config, snapshot } = configured();
  const late = state(snapshot, { lastWebMutationToolCall: 2, descendantUsage: { ...emptyUsage(), modelCalls: 4 } }, 1);
  assert.equal(webObservationDue(late, config), true);
  const restricted = { ...config, contract: { ...config.contract, allowedToolNames: ['edit', 'read'] } };
  assert.equal(webObservationDue(late, restricted), false);
  assert.deepEqual(names(late, restricted), ['edit', 'read']);
  assert.deepEqual(names(late, { ...restricted, contract: { ...restricted.contract, allowedToolNames: [] } }), []);
});

test('structured final submission remains available during observation and finalization turns', () => {
  const { config, snapshot } = configured({ contract: { objective: 'Return a result',
    finalSubmissionSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
    finalSubmissionPayloadKey: 'answer' } });
  assert.deepEqual(names(state(snapshot, { lastWebMutationToolCall: 2 }, 5), config), ['browser', 'submit_final_output']);
  assert.deepEqual(names(state(snapshot, { lastWebMutationToolCall: 2 }, 9), config), ['submit_final_output']);
});

test('exhausted tool budget takes priority; a deadline quote preserves due browser observation', () => {
  const { config, snapshot } = configured(), current = state(snapshot, { lastWebMutationToolCall: 2 }, 5);
  for (const limits of [{ maxToolCalls: 0 }]) {
    const exhausted = { ...config, limits: { ...config.limits, ...limits } };
    assert.deepEqual(names(current, exhausted), []);
    assert.deepEqual(browserTaskMessages(current, exhausted, []), []);
  }
  // Python tool_budget.model_tool_surface prioritizes an observation already
  // due over wall delivery. The old TS assertion incorrectly treated the wall
  // reserve as unconditional tool exhaustion; hard expiry is tested in Kernel.
  const wall = { ...config, limits: { ...config.limits, maxWallMs: 100, finalizationReserveWallMs: 100 } };
  const quoted = { ...current, executionBudgetObservation: { policy: 'prepared-execution-budget/v1', runId: current.runId,
    goalRevision: current.goalRevision, sourceRevision: current.revision, modelCallsClaimed: 0, toolCallsClaimed: 0, wallMsRemaining: 50 } };
  assert.deepEqual(names(quoted, wall), ['browser']);
  assert.equal(browserTaskMessages(quoted, wall, [])[0].kind, 'browser_task_policy');
  assert.deepEqual(deliveryTaskMessages(quoted, wall, []), []);
});

test('model admission uses the pre-call reserve; a mixed batch with a withheld tool dispatches nothing', () => {
  const { config, snapshot } = configured();
  const claimed = state(snapshot, { lastWebMutationToolCall: 1 }, 5);
  assert.equal(webObservationDue(claimed, config), true);
  // The fifth model request was admitted with six calls remaining.
  assert.equal(reduceModel(claimed, response(call('edit')), config, 0, 0).phase, 'executing_tools');
  const refused = reduceModel(state(snapshot, { lastWebMutationToolCall: 1 }, 6),
    response(call('browser'), call('edit')), config, 0, 0);
  assert.equal(refused.phase, 'preparing_context'); assert.deepEqual(refused.pendingTools, []);
  assert.equal(refused.modelErrors, 0);
  assert.equal(refused.messages.filter(message => message.role === 'tool').length, 2);
  assert.ok(refused.messages.filter(message => message.role === 'tool').every(message => message.content.includes('tool_not_advertised')));
});

test('receipt reduction persists mutation cursors even on errors; approval has no attempt or mutation', () => {
  const { config, snapshot } = configured(), current = { ...snapshot, phase: 'executing_tools', pendingTools: [call('edit')] };
  const intent = { operationKey: 'effect' };
  const changed = reduceTools(current, [{ status: 'error', content: {}, workspaceChangedPaths: ['INDEX.HTML'] }], current.pendingTools, intent, config, digest);
  assert.equal(changed.lastWebMutationToolCall, 1);
  const pending = { ...current, pendingTools: [call('browser')] };
  const approval = reduceTools(pending, [{ status: 'approval_required', content: {}, interactionId: 'ask' }], pending.pendingTools, intent, config, digest);
  assert.equal(approval.lastBrowserAttemptToolCall, undefined); assert.equal(approval.lastWebMutationToolCall, undefined);
  const failed = reduceTools(pending, [failure], pending.pendingTools, intent, config, digest);
  assert.equal(failed.lastBrowserAttemptToolCall, 1); assert.equal(failed.lastBrowserObservation, null);
  assert.equal(failed.unresolvedInteractionObservation.error, 'button failed');
});

test('interaction failures are host role bound, ordered and code point bounded', () => {
  const result = { status: 'error', content: { entry_path: 'index.html', page_errors: ['', '😀'.repeat(400)],
    console_errors: ['second'], request_failures: ['third'] } };
  const observation = advanceInteractionObservation(null, browser, 4, result, digest);
  assert.equal(Array.from(observation.error).length, 300); assert.equal(observation.error, '😀'.repeat(300));
  assert.equal(observation.toolCall, 4); assert.ok(observation.digest);
  assert.equal(advanceInteractionObservation(null, tool(), 4, result, digest), null);
  assert.equal(advanceInteractionObservation(null, browser, 4, { ...result, status: 'ok' }, digest), null);
});

for (const [label, result, definition] of [
  ['screenshot', successful([])], ['host-only reload', successful([], { reloaded: true })],
  ['pointer move', successful([{ type: 'move' }])], ['scroll', successful([{ type: 'scroll' }])],
  ['incomplete actions', successful([{ type: 'click' }], { actions_ok: false })],
  ['different page', successful([{ type: 'click' }], { entry_path: 'another.html' })],
  ['different tool', successful([{ type: 'click' }]), { ...browser, name: 'other' }],
]) test(`${label} cannot clear an earlier interaction failure`, () => {
  assert.deepEqual(advanceInteractionObservation(sticky, definition ?? browser, 5, result, digest), sticky);
});
for (const type of ['click', 'fill', 'press', 'reload']) test(`successful same-page ${type} clears the sticky failure`, () => {
  assert.equal(advanceInteractionObservation(sticky, browser, 5, successful([{ type }]), digest), null);
});

test('a real steer invalidates goal evidence, while guidance retains interaction failures', () => {
  const { snapshot } = configured(), current = { ...snapshot, unresolvedInteractionObservation: sticky,
    lastBrowserObservation: { toolCall: 4 }, browserSessionRefs: [ref] };
  const steered = reduceCommand(current, { commandId: 'steer', kind: 'steer', payload: { text: 'New goal', expectedGoalRevision: current.goalRevision } }).snapshot;
  assert.equal(steered.unresolvedInteractionObservation, null); assert.equal(steered.lastBrowserObservation, null);
  assert.deepEqual(steered.browserSessionRefs, [ref]);
  const guided = reduceCommand(current, { commandId: 'guide', kind: 'guide', payload: { text: 'More context' } }).snapshot;
  assert.deepEqual(guided.unresolvedInteractionObservation, sticky);
});

for (const sqlite of [false, true]) test(`${sqlite ? 'sqlite' : 'memory'}: reserve gate, durable failure, reopen and counted instructions`, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'native-web-policy-')), filename = join(dir, 'run.sqlite');
  let store = sqlite ? new SqliteRunStore(filename) : new MemoryRunStore(), cut = false, lastQuote;
  t.after(() => { store.close?.(); rmSync(dir, { recursive: true, force: true }); });
  const { config, snapshot } = configured({ limits: { maxModelCalls: 8, verificationReserveModelCalls: 5 },
    contextPolicy: { tokenizerId: 'counter', tokenizerDigest: 'counter/v1', enabled: false,
      triggerRatio: .9, targetRatio: .5, summaryMaxTokens: 80, maxCompactions: null,
      maxCompactionsWithoutProgress: 4, minModelTurnsBetween: 2, maxSummaryRetries: 2 } });
  store.create(config, snapshot);
  let models = 0, browserCalls = 0, edits = 0, modelAssertion;
  const surfaces = [], ports = {
    context: { tokens: { tokenizerId: 'counter', tokenizerDigest: 'counter/v1', countText: async () => 1,
      countRequest: async request => { lastQuote = request; return Math.ceil(canonical(request.messages).length / 4); } } },
    model: { generate: async request => {
      models++; surfaces.push(request.tools.map(tool => tool.name));
      try {
        assert.deepEqual(request.messages, lastQuote.messages);
        assert.equal(request.messages.filter(message => message.kind === 'browser_task_policy').length,
          [4, 5, 7].includes(models) ? 1 : 0);
      } catch (error) { modelAssertion = error; throw error; }
      if (models === 4) return response(call('browser', 'forbidden-browser'), call('edit', 'forbidden-edit'));
      if ([5, 7].includes(models)) return response(call('browser', `browser-${models}`));
      return models === 8 ? { kind: 'final_candidate', text: 'Done', toolCalls: [], usage: emptyUsage() }
        : response(call('edit', `edit-${models}`));
    } },
    tools: { execute: async ({ call: called }) => {
      if (called.name === 'edit') { edits++; return { status: 'ok', content: {}, workspaceChangedPaths: ['index.html'] }; }
      browserCalls++;
      return browserCalls === 1 ? failure : { ...successful([{ type: 'click' }]), browserSessionRef: ref, browserObservation: observed() };
    } },
  };
  const worker = checkpoint => new NativeKernel({ store, ports, digest, owner: 'worker', ...(checkpoint ? { onCheckpoint: checkpoint } : {}) });
  let interrupted;
  try { await worker(async snapshot => {
    if (!cut && snapshot.unresolvedInteractionObservation) { cut = true; throw Error('delivery interrupted'); }
  }).runUntilIdle(scope, 'run'); } catch (error) { interrupted = error; }
  const stopped = store.load(scope, 'run').snapshot;
  assert.ifError(modelAssertion);
  assert.match(interrupted?.message ?? canonical({ models, edits, browserCalls, surfaces, phase: stopped.phase,
    reason: stopped.reason, diagnostics: stopped.diagnostics }), /delivery interrupted/);
  if (sqlite) { store.close(); store = new SqliteRunStore(filename); }
  const restored = store.load(scope, 'run').snapshot;
  assert.equal(restored.unresolvedInteractionObservation.error, 'button failed');
  assert.equal(restored.lastWebMutationToolCall, 3); assert.equal(restored.lastBrowserAttemptToolCall, 4);
  const done = await worker().runUntilIdle(scope, 'run');
  assert.ifError(modelAssertion);
  assert.equal(done.phase, 'completed'); assert.equal(done.outcome, 'unverified');
  assert.equal(models, 8); assert.equal(edits, 4); assert.equal(browserCalls, 2);
  assert.equal(done.unresolvedInteractionObservation, null); assert.equal(done.lastWebMutationToolCall, 5);
  assert.equal(done.lastBrowserObservation.toolCall, 6);
  assert.deepEqual(surfaces[3], ['browser']); assert.deepEqual(surfaces[5], ['edit', 'read', 'browser']);
  assert.deepEqual(surfaces[6], ['browser']); assert.deepEqual(surfaces[7], []);
  assert.equal(done.messages.some(message => message.kind === 'browser_task_policy'), false);
  assert.equal(browserTaskMessages(done, config, []).length, 0);
});
