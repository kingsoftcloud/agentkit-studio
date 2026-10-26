import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, contextMessageRef, emptyUsage, NativeKernel, planNativeContext, validateContextMessages } from '../dist/index.mjs';
import { defaultToolPruningThreshold, projectOldToolResults } from '../dist/context-microcompact.mjs';
import { SqliteRunStore } from '../../agentkit-harness/src/native/sqlite-store.mjs';
import { bindNativeContext } from '../../../src/providers/native-context.mjs';
import { digest, fixture, scope, tool } from './fixtures.mjs';

const policy = { tokenizerId: 'fixture', tokenizerDigest: 'fixture/v1', enabled: true, triggerRatio: .72, targetRatio: .45,
  summaryMaxTokens: 128, maxCompactions: null, maxCompactionsWithoutProgress: 8, minModelTurnsBetween: 2,
  maxSummaryRetries: 1, pruneToolResults: true, pruneKeepRecentBatches: 1, pruneMinSavedTokens: 256 };
const countRequest = async (messages, tools) => Math.ceil(canonical({ messages, tools }).length / 4);
const counters = { countRequest, countText: async text => Math.ceil(text.length / 4), countMessage: async () => 1 };
const final = text => ({ kind: 'final_candidate', text, toolCalls: [], usage: emptyUsage() });
function append(messages, id, name = 'read', content = 'old observation', extra = {}, args = {}) {
  const start = messages.length;
  messages.push({ role: 'assistant', content: '', toolCalls: [{ callId: id, name, arguments: args }] },
    { role: 'tool', callId: id, name, content, toolOutcome: 'ok', ...extra });
  return [start, start + 1];
}
function scenario() {
  return fixture({ tools: [tool()], contextPolicy: policy,
    profile: { ...fixture().config.profile, contextWindow: 8000, maxOutputTokens: 128 } });
}

test('only older trusted successful text receipts are cleared; protected observations and complete protocol pairs survive', () => {
  const messages = [], groups = [], definitions = [tool(), tool({ name: 'plan', contextRole: 'task_planning' }),
    tool({ name: 'browser', observationRole: 'browser' }), tool({ name: 'skill', contextRetention: 'persistent' }),
    tool({ name: 'child', delegatedReadOnly: true })];
  groups.push(append(messages, 'clear', 'read', 'trusted text', { presentation: { format: 'text', content: [] } }));
  for (const [id, name, extra, content] of [
    ['error','read',{ toolOutcome: 'error' }], ['approval','read',{ toolOutcome: 'approval_required' }],
    ['unknown-outcome','read',{ toolOutcome: undefined }, '{"status":"ok","content":"untrusted"}'],
    ['unknown-tool','unknown',{}], ['media','read',{ media: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AQ==' } }] }],
    ['persistent-message','read',{ persistent: true }], ['plan','plan',{}], ['browser','browser',{}],
    ['skill','skill',{}], ['child','child',{}], ['structured-failure','read',{}, '{"ok":false}'],
    ['wrapped-failure','read',{}, '{"status":"ok","content":{"ok":false}}'], ['source','read',{}],
  ]) {
    groups.push(append(messages, id, name, content ?? 'preserved', extra));
    if (Object.hasOwn(extra, 'toolOutcome') && extra.toolOutcome === undefined) delete messages.at(-1).toolOutcome;
  }
  groups.push(append(messages, 'recent'));
  messages.push({ role: 'assistant', content: 'Following prose must not consume tool batch recency' });
  groups.push([messages.length - 1]);
  const original = structuredClone(messages), refs = messages.map((message, index) => contextMessageRef(message, index, digest));
  const source = messages.findIndex(message => message.callId === 'source');
  const result = projectOldToolResults(messages, refs, groups, definitions, new Set([source]), 1, digest);
  assert.deepEqual(result.clearedCallIds, ['clear']); assert.deepEqual(result.clearedIndexes, [1]);
  assert.deepEqual(JSON.parse(result.messages[1].content), { type: 'historical_tool_result_cleared',
    source_message_ref: refs[1], payload_digest: digest(original[1].content) });
  assert.equal(result.messages[1].presentation, undefined);
  assert.deepEqual(result.messages.slice(2), original.slice(2));
  validateContextMessages(result.messages); assert.deepEqual(messages, original);
});

test('planner uses the full request counter and preserves fresh sources even above source token ceilings', async () => {
  const { config, snapshot } = scenario();
  append(snapshot.messages, 'old', 'read', 'OLD_EVIDENCE:'.repeat(1800));
  append(snapshot.messages, 'recent');
  const planned = await planNativeContext(snapshot, config, config.tools, counters, digest, false, true);
  assert.equal(planned.reason, 'historical_tool_results_within_budget');
  assert.equal(planned.state.compactions, 0); assert.equal(planned.toolResultPruning.savedTokens,
    planned.toolResultPruning.preInputTokens - planned.toolResultPruning.postInputTokens);
  assert.ok(snapshot.messages.find(message => message.callId === 'old').content.startsWith('OLD_EVIDENCE:'));
  const refused = await planNativeContext(snapshot, config, config.tools, { ...counters,
    countRequest: async (messages, tools) => await countRequest(messages, tools)
      + (messages.some(message => message.content.includes('historical_tool_result_cleared')) ? 20000 : 0) }, digest, false, true);
  assert.notEqual(refused.reason, 'historical_tool_results_within_budget'); assert.equal(refused.toolResultPruning, undefined);
  const sourceConfig = { ...config, tools: [tool(), tool({ name: 'source', contextRole: 'workspace_read' })],
    contextPolicy: { ...policy, readWorkingSetCount: 8, readWorkingSetMaxTokens: 1, readWorkingSetTotalMaxTokens: 1 } };
  snapshot.workspaceRevision = 'workspace-1';
  snapshot.messages.splice(1);
  append(snapshot.messages, 'old', 'read', 'OLD_EVIDENCE:'.repeat(1800));
  append(snapshot.messages, 'source', 'source', canonical({ status: 'ok', content: { ok: true, path: 'source.ts',
    content: 'source text', read_range: { start: 1, end: 1 } } }), {}, { path: 'source.ts' });
  append(snapshot.messages, 'recent');
  const protectedPlan = await planNativeContext(snapshot, sourceConfig, sourceConfig.tools, counters, digest, false, true);
  assert.deepEqual(protectedPlan.toolResultPruning.toolCallIds, ['old']);
  assert.ok(protectedPlan.messages.find(message => message.callId === 'source').content.includes('source text'));
});

test('Kernel seals the pruned view, reopens SQLite, and continues without replaying tools or spending a summary call', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'native-microcompact-')), filename = join(directory, 'run.sqlite');
  let store = new SqliteRunStore(filename);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const { config, snapshot } = scenario(); store.create(config, snapshot);
  let turns = 0, toolCalls = 0;
  const ports = { context: { tokens: { tokenizerId: 'fixture', tokenizerDigest: 'fixture/v1',
    countRequest: request => countRequest(request.messages, request.tools), countText: async request => Math.ceil(request.text.length / 4) } },
  tools: { execute: async request => { toolCalls++; return { status: 'ok', content: request.call.callId === 'old'
    ? 'OLD_EVIDENCE:'.repeat(1800) : 'recent observation' }; } },
  model: { generate: async request => {
    assert.equal(request.purpose ?? 'task', 'task');
    if (++turns <= 2) return { ...final(''), kind: 'tool_calls', toolCalls: [{ callId: turns === 1 ? 'old' : 'recent', name: 'read', arguments: {} }] };
    assert.equal(JSON.parse(request.messages.find(message => message.callId === 'old').content).type, 'historical_tool_result_cleared');
    assert.ok(request.messages.find(message => message.callId === 'recent').content.includes('recent observation'));
    return final('Completed with original execution evidence');
  } } };
  const interrupted = await new NativeKernel({ store, ports, digest, owner: 'before-reopen', onCheckpoint: async next => {
    if (next.preparedContext?.toolResultPruning) throw Error('delivery interrupted after durable context commit');
  } }).runUntilIdle(scope, 'run').catch(error => error);
  assert.match(interrupted.message ?? canonical({ phase: interrupted.phase, reason: interrupted.reason, turns, toolCalls,
    messages: interrupted.messages.map(message => ({ role: message.role, length: message.content.length,
      outcome: message.toolOutcome ?? null, callId: message.callId ?? null })) }), /delivery interrupted/);
  assert.equal(turns, 2); assert.equal(toolCalls, 2);
  const committed = store.load(scope, 'run').snapshot;
  assert.deepEqual(committed.preparedContext.toolResultPruning.toolCallIds, ['old']);
  assert.equal(committed.messages.find(message => message.callId === 'old').toolOutcome, 'ok');
  assert.ok(committed.messages.find(message => message.callId === 'old').content.includes('OLD_EVIDENCE:'));
  store.close(); store = new SqliteRunStore(filename);
  const end = await new NativeKernel({ store, ports, digest, owner: 'after-reopen' }).runUntilIdle(scope, 'run');
  assert.equal(end.phase, 'completed'); assert.equal(turns, 3); assert.equal(toolCalls, 2);
  assert.equal(end.contextState.compactions, 0);
  assert.ok(store.events(scope, 'run').some(event => event.kind === 'context.tool_results_pruned'
    && event.payload.toolCallIds[0] === 'old' && event.payload.savedTokens >= 256));
});

test('Studio exposes optional pruning configuration while default and restored bindings keep original absence', () => {
  const description = { protocol: 'openai-chat', modelName: 'test', contextWindow: 32000, maxOutputTokens: 1000 };
  assert.equal(Object.hasOwn(bindNativeContext({ description }).policy, 'pruneToolResults'), false);
  const bound = bindNativeContext({ description, context: { compaction: { pruneToolResults: true } } });
  assert.deepEqual([bound.policy.pruneToolResults, bound.policy.pruneKeepRecentBatches, bound.policy.pruneMinSavedTokens], [true, 5, 256]);
  assert.throws(() => fixture({ contextPolicy: { ...policy, pruneKeepRecentBatches: 0 } }), /invalid_context_pruning_policy/);
});

test('ZCode-style independent local cleanup threshold saves tokens before a summary is needed', async () => {
  const { config, snapshot } = scenario();
  append(snapshot.messages, 'old', 'read', 'OLD_EVIDENCE:'.repeat(650));
  append(snapshot.messages, 'recent');
  snapshot.messages.push({ role: 'assistant', content: 'Keep working' });
  const original = structuredClone(snapshot.messages);
  const legacy = await planNativeContext(snapshot, config, config.tools, counters, digest, false, true);
  assert.equal(legacy.reason, 'context_within_budget');
  assert.equal(legacy.toolResultPruning, undefined);
  const threshold = Math.floor(legacy.admission.countedInputTokens / 2);
  const earlyConfig = fixture({ ...config, contextPolicy: { ...config.contextPolicy, pruneThresholdTokens: threshold } }).config;
  const early = await planNativeContext(snapshot, earlyConfig, earlyConfig.tools, counters, digest, false, true);
  assert.equal(early.reason, 'historical_tool_results_within_budget');
  assert.equal(early.state.compactions, 0);
  assert.deepEqual(early.toolResultPruning.toolCallIds, ['old']);
  assert.ok(early.toolResultPruning.savedTokens >= 256);
  assert.deepEqual(snapshot.messages, original);
  validateContextMessages(early.messages);
  const disabledConfig = { ...earlyConfig, contextPolicy: { ...earlyConfig.contextPolicy, pruneToolResults: false } };
  const disabled = await planNativeContext(snapshot, disabledConfig, disabledConfig.tools, counters, digest, false, true);
  assert.equal(disabled.toolResultPruning, undefined);
});

test('Studio pins an explicit local cleanup threshold without adding one to restored legacy policy', () => {
  const description = { protocol: 'openai-chat', modelName: 'test', contextWindow: 32000, maxOutputTokens: 1000 };
  const context = { compaction: { pruneToolResults: true, pruneThresholdTokens: 12000 } };
  const bound = bindNativeContext({ description, context });
  assert.equal(bound.policy.pruneThresholdTokens, 12000);
  assert.equal(Object.hasOwn(bindNativeContext({ description, context: { compaction: { pruneToolResults: true } } }).policy,
    'pruneThresholdTokens'), false);
  for (const value of [0, -1, 1.5, '12000', null])
    assert.throws(() => fixture({ contextPolicy: { ...policy, pruneThresholdTokens: value } }), /invalid_context_pruning_policy/);
  for (const value of [NaN, Infinity])
    assert.throws(() => fixture({ contextPolicy: { ...policy, pruneThresholdTokens: value } }), /non_json_number/);
});

test('new admitted defaults use the reference earlier boundary, preserving legacy and explicit thresholds', async () => {
  assert.deepEqual([100000, 8000, 2000, 1000].map(defaultToolPruningThreshold), [90000, 6000, 0, 0]);
  const { config, snapshot } = scenario();
  append(snapshot.messages, 'old', 'read', 'OLD_EVIDENCE:'.repeat(1300)); append(snapshot.messages, 'recent');
  snapshot.messages.push({ role: 'assistant', content: 'Continue the task.' });
  const original = structuredClone(snapshot.messages);
  const legacy = await planNativeContext(snapshot, config, config.tools, counters, digest, false, true);
  const full = (config.profile.contextWindow - config.profile.maxOutputTokens) * policy.triggerRatio;
  assert.ok(legacy.admission.countedInputTokens < full && legacy.admission.countedInputTokens >= defaultToolPruningThreshold(full));
  assert.equal(legacy.toolResultPruning, undefined);
  const current = fixture({ ...config, contextPolicy: { ...config.contextPolicy, pruneThresholdPolicy: 'zcode-local/v1' } }).config;
  const early = await planNativeContext(snapshot, current, current.tools, counters, digest, false, true);
  assert.equal(early.reason, 'historical_tool_results_within_budget'); assert.deepEqual(early.toolResultPruning.toolCallIds, ['old']);
  assert.deepEqual(snapshot.messages, original);
  const explicit = { ...current, contextPolicy: { ...current.contextPolicy, pruneThresholdTokens: 100000 } };
  assert.equal((await planNativeContext(snapshot, explicit, explicit.tools, counters, digest, false, true)).toolResultPruning, undefined);
  const description = { protocol: 'openai-chat', modelName: 'test', contextWindow: 32000, maxOutputTokens: 1000 };
  const bind = (raw = {}, enabled = true) => bindNativeContext({ description, context: { compaction: raw }, pruningThresholdDefaults: enabled }).policy;
  assert.equal(bind({ pruneToolResults: true }).pruneThresholdPolicy, 'zcode-local/v1');
  assert.equal(bind({ pruneToolResults: true }, false).pruneThresholdPolicy, undefined);
  assert.equal(bind({ pruneToolResults: true, pruneThresholdTokens: 12000 }).pruneThresholdPolicy, undefined);
  assert.equal(bind().pruneThresholdPolicy, undefined, 'new timing does not enable pruning itself');
  assert.equal(bind({ pruneToolResults: false }).pruneThresholdPolicy, undefined);
  assert.throws(() => fixture({ contextPolicy: { ...policy, pruneThresholdPolicy: 'unknown' } }), /invalid_context_pruning_policy/);
  const small = fixture({ tools: config.tools, profile: { ...config.profile, contextWindow: 2000 },
    contextPolicy: current.contextPolicy });
  append(small.snapshot.messages, 'small-old', 'read', 'data '.repeat(400)); append(small.snapshot.messages, 'small-recent');
  const smallPlan = await planNativeContext(small.snapshot, small.config, small.config.tools, counters, digest, false, true);
  assert.deepEqual(smallPlan.toolResultPruning.toolCallIds, ['small-old'], 'zero derived threshold immediately triggers eligible cleanup');
});

test('still-needed summaries use authenticated cleaned sources, preserving legacy source and rejecting changed manifests', async () => {
  const { config, snapshot } = scenario();
  append(snapshot.messages, 'old', 'read', 'OLD_EVIDENCE:'.repeat(1800));
  append(snapshot.messages, 'recent', 'read', 'RECENT_EVIDENCE:'.repeat(2200));
  const original = structuredClone(snapshot);
  const legacy = await planNativeContext(snapshot, config, config.tools, counters, digest, false, true);
  assert.equal(legacy.action, 'compact'); assert.ok(legacy.state.compaction.sourceText.includes('OLD_EVIDENCE:'));
  const current = fixture({ ...config, contextPolicy: { ...policy, pruneSummaryPolicy: 'zcode-local/v1' } }).config;
  const plan = await planNativeContext(snapshot, current, current.tools, counters, digest, false, true);
  assert.equal(plan.action, 'compact'); assert.ok(plan.toolResultPruning.postInputTokens > current.profile.contextWindow);
  assert.equal(plan.state.compaction.sourceText.includes('OLD_EVIDENCE:'), false);
  assert.ok(plan.state.compaction.sourceText.includes('historical_tool_result_cleared'));
  assert.ok(plan.state.compaction.sourceText.includes('RECENT_EVIDENCE:'));
  const oldEntry = JSON.parse(plan.state.compaction.sourceText).find(entry => entry.message.callId === 'old');
  const oldIndex = snapshot.messages.findIndex(message => message.callId === 'old');
  assert.equal(oldEntry.ref, contextMessageRef(snapshot.messages[oldIndex], oldIndex, digest));
  assert.equal(oldEntry.payloadDigest, digest(snapshot.messages[oldIndex]));
  assert.equal(JSON.parse(oldEntry.message.content).payload_digest, digest(snapshot.messages[oldIndex].content));
  assert.deepEqual(plan.state.compaction.prunedToolResultRefs, plan.toolResultPruning.sourceMessageRefs);
  assert.deepEqual(snapshot, original);
  const resumed = { ...snapshot, contextState: plan.state };
  assert.equal((await planNativeContext(resumed, current, current.tools, counters, digest, false, true)).action, 'compact');
  for (const refs of [[plan.state.compaction.prunedToolResultRefs[0], plan.state.compaction.prunedToolResultRefs[0]],
    ['unknown'], [contextMessageRef(snapshot.messages.at(-1), snapshot.messages.length - 1, digest)]]) {
    const changed = structuredClone(resumed); changed.contextState.compaction.prunedToolResultRefs = refs;
    await assert.rejects(planNativeContext(changed, current, current.tools, counters, digest, false, true), /context_summary_pruning_manifest_invalid|context_compaction_manifest_changed/);
  }
  const changed = structuredClone(resumed); changed.messages[2].content += 'changed receipt';
  await assert.rejects(planNativeContext(changed, current, current.tools, counters, digest, false, true), /context_compaction_source_changed/);
});

test('SQLite resume keeps cleanup before chunked summaries without replaying commands or completed summary chunks', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'native-pruning-summary-')), filename = join(directory, 'run.sqlite');
  let store = new SqliteRunStore(filename);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const { config, snapshot } = fixture({ tools: [tool()], contextPolicy: { ...policy, pruneSummaryPolicy: 'zcode-local/v1' },
    profile: { ...fixture().config.profile, contextWindow: 8000, maxOutputTokens: 128 } });
  store.create(config, snapshot);
  let taskCalls = 0, tools = 0, summaryCalls = 0;
  const offsets = new Set();
  const ports = { context: { tokens: { tokenizerId: 'fixture', tokenizerDigest: 'fixture/v1',
    countRequest: request => countRequest(request.messages, request.tools), countText: async request => counters.countText(request.text) } },
  tools: { execute: async request => { tools++; return { status: 'ok', content: request.call.callId === 'old'
    ? 'OLD_EVIDENCE:'.repeat(1800) : 'RECENT_EVIDENCE:'.repeat(2200) }; } },
  model: { generate: async request => {
    if (request.purpose === 'compaction') {
      summaryCalls++; const source = JSON.parse(request.messages[1].content).source;
      assert.ok(!source.text.includes('OLD_EVIDENCE:'));
      assert.ok(!offsets.has(source.start), 'A completed summary fragment must not be reissued after SQLite reopen');
      offsets.add(source.start); return final('Recent evidence observed; original commands have completed.');
    }
    taskCalls++;
    if (taskCalls <= 2) return { ...final(''), kind: 'tool_calls', toolCalls: [{ callId: taskCalls === 1 ? 'old' : 'recent', name: 'read', arguments: {} }] };
    assert.ok(!canonical(request.messages).includes('OLD_EVIDENCE:'));
    assert.ok(request.messages.some(message => message.kind === 'compaction_summary'));
    return final('Completed after cleaned summary');
  } } };
  await assert.rejects(new NativeKernel({ store, ports, digest, owner: 'before-summary', onCheckpoint: async next => {
    if (next.contextState?.compaction?.prunedToolResultRefs) throw Error('stop after source commit');
  } }).runUntilIdle(scope, 'run'), /stop after source commit/);
  assert.equal(summaryCalls, 0); assert.equal(tools, 2);
  store.close(); store = new SqliteRunStore(filename);
  await assert.rejects(new NativeKernel({ store, ports, digest, owner: 'after-source', onCheckpoint: async next => {
    if (next.contextState?.compaction?.proposal !== null && next.contextState?.compaction?.proposal !== undefined)
      throw Error('stop after summary receipt');
  } }).runUntilIdle(scope, 'run'), /stop after summary receipt/);
  assert.equal(summaryCalls, 1);
  store.close(); store = new SqliteRunStore(filename);
  const end = await new NativeKernel({ store, ports, digest, owner: 'after-summary-receipt' }).runUntilIdle(scope, 'run');
  assert.equal(end.phase, 'completed'); assert.equal(end.finalText, 'Completed after cleaned summary');
  assert.equal(tools, 2); assert.equal(taskCalls, 3); assert.ok(summaryCalls >= 2 && summaryCalls <= 8);
  assert.equal(end.contextState.compactions, 1);
  assert.ok(end.messages.find(message => message.callId === 'old').content.includes('OLD_EVIDENCE:'));
  assert.equal(store.events(scope, 'run').filter(event => event.kind === 'context.tool_results_pruned').length, 1);
});

test('Studio admits cleaned summary sources only for new enabled bindings', () => {
  const description = { protocol: 'openai-chat', modelName: 'test', contextWindow: 32000, maxOutputTokens: 1000 };
  const bind = (raw, pruningSummaryDefaults = false) => bindNativeContext({ description,
    context: { compaction: raw }, pruningSummaryDefaults }).policy;
  assert.equal(bind({ pruneToolResults: true }).pruneSummaryPolicy, undefined);
  assert.equal(bind({}, true).pruneSummaryPolicy, undefined);
  assert.equal(bind({ pruneToolResults: false }, true).pruneSummaryPolicy, undefined);
  assert.equal(bind({ pruneToolResults: true }, true).pruneSummaryPolicy, 'zcode-local/v1');
  assert.throws(() => fixture({ contextPolicy: { ...policy, pruneSummaryPolicy: 'unknown' } }), /invalid_context_pruning_policy/);
});
