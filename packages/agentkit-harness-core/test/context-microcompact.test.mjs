import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, contextMessageRef, emptyUsage, NativeKernel, planNativeContext, validateContextMessages } from '../dist/index.mjs';
import { projectOldToolResults } from '../dist/context-microcompact.mjs';
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
