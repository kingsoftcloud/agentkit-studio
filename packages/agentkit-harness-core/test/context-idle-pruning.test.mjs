import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, emptyUsage, NativeKernel, planNativeContext, reduceModel, validateContextMessages } from '../dist/index.mjs';
import { toolPruningIdleElapsed } from '../dist/context-microcompact.mjs';
import { SqliteRunStore } from '../../agentkit-harness/src/native/sqlite-store.mjs';
import { bindNativeContext } from '../../../src/providers/native-context.mjs';
import { digest, fixture, scope, tool } from './fixtures.mjs';

const policy = { tokenizerId: 'fixture', tokenizerDigest: 'fixture/v1', enabled: true, triggerRatio: .72, targetRatio: .45,
  summaryMaxTokens: 128, maxCompactions: null, maxCompactionsWithoutProgress: 8, minModelTurnsBetween: 2,
  maxSummaryRetries: 1, pruneToolResults: true, pruneKeepRecentBatches: 1, pruneMinSavedTokens: 256,
  pruneThresholdTokens: 100000, pruneIdleThresholdMinutes: 60 };
const countRequest = async (messages, tools) => Math.ceil(canonical({ messages, tools }).length / 4);
const counters = { countRequest, countText: async text => Math.ceil(text.length / 4), countMessage: async () => 1 };
const final = text => ({ kind: 'final_candidate', text, toolCalls: [], usage: emptyUsage() });
function scenario() { return fixture({ tools: [tool()], contextPolicy: policy,
  limits: { leaseMs: 7200000 },
  profile: { ...fixture().config.profile, contextWindow: 8000, maxOutputTokens: 128 } }); }
function append(messages, id, content) {
  messages.push({ role: 'assistant', content: '', toolCalls: [{ callId: id, name: 'read', arguments: {} }], completedAtMs: 1000 },
    { role: 'tool', callId: id, name: 'read', content, toolOutcome: 'ok' });
}

test('reference idle boundary is strict, permits zero and trusts only the latest assistant completion clock', () => {
  const messages = [{ role: 'assistant', content: 'completed', completedAtMs: 1000 }];
  assert.equal(toolPruningIdleElapsed(messages, 60, 3601000), undefined);
  assert.equal(toolPruningIdleElapsed(messages, 60, 3601001), 3600001);
  assert.equal(toolPruningIdleElapsed(messages, 0, 1000), undefined);
  assert.equal(toolPruningIdleElapsed(messages, 0, 1001), 1);
  for (const now of [undefined, NaN, Infinity, -1, 999, 1.5])
    assert.equal(toolPruningIdleElapsed(messages, 0, now), undefined);
  assert.equal(toolPruningIdleElapsed(messages, undefined, 3601001), undefined);
  assert.equal(toolPruningIdleElapsed([...messages, { role: 'assistant', content: 'unknown clock' }], 0, 3601001), undefined);
  assert.equal(toolPruningIdleElapsed([...messages, { role: 'assistant', content: 'newer', completedAtMs: 3601001 }], 60, 3601002), undefined);
  assert.throws(() => validateContextMessages([{ role: 'user', content: 'untrusted clock', completedAtMs: 1 }]), /invalid_context_completion_time/);
  assert.throws(() => validateContextMessages([{ role: 'assistant', content: 'bad clock', completedAtMs: -1 }]), /invalid_context_completion_time/);
});

test('idle cleanup works below token pressure and preserves omitted/disabled policies and strict time boundary', async () => {
  const { config, snapshot } = scenario();
  append(snapshot.messages, 'old', 'OLD_EVIDENCE:'.repeat(650)); append(snapshot.messages, 'recent', 'Recent observation');
  const original = structuredClone(snapshot);
  const before = await planNativeContext(snapshot, config, config.tools, { ...counters, nowMs: 3601000 }, digest, false, true);
  assert.equal(before.toolResultPruning, undefined);
  const after = await planNativeContext(snapshot, config, config.tools, { ...counters, nowMs: 3601001 }, digest, false, true);
  assert.equal(after.reason, 'historical_tool_results_within_budget');
  assert.equal(after.toolResultPruning.trigger, 'idle'); assert.equal(after.toolResultPruning.idleElapsedMs, 3600001);
  assert.ok(after.toolResultPruning.preInputTokens < 100000); assert.equal(after.state.compactions, 0);
  assert.deepEqual(after.toolResultPruning.toolCallIds, ['old']); assert.deepEqual(snapshot, original);
  for (const contextPolicy of [{ ...policy, pruneIdleThresholdMinutes: undefined }, { ...policy, pruneToolResults: false }, { ...policy, enabled: false }]) {
    assert.equal((await planNativeContext(snapshot, { ...config, contextPolicy }, config.tools,
      { ...counters, nowMs: 3601001 }, digest, false, true)).toolResultPruning, undefined);
  }
});

test('only admitted successful task responses stamp completion; errors and old Runs do not invent clocks', () => {
  const { config, snapshot } = scenario();
  const accepted = reduceModel(snapshot, final('Done'), config, 1234, .5, digest);
  assert.equal(accepted.messages.at(-1).completedAtMs, 1234);
  const legacy = { ...config, contextPolicy: { ...policy, pruneIdleThresholdMinutes: undefined } };
  assert.equal(reduceModel(snapshot, final('Done'), legacy, 1234, .5, digest).messages.at(-1).completedAtMs, undefined);
  const failed = reduceModel(snapshot, { ...final(''), kind: 'provider_retryable_error' }, config, 1234, .5, digest);
  assert.equal(failed.messages?.at(-1)?.completedAtMs, undefined);
});

test('SQLite idle admission survives reopen and inherited cold turns without repeating tools or summaries', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'native-idle-pruning-')), filename = join(directory, 'run.sqlite');
  let store = new SqliteRunStore(filename), now = 1000;
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const { config, snapshot } = scenario(); store.create(config, snapshot);
  let taskCalls = 0, toolCalls = 0, idleStarted = false;
  const ports = { context: { tokens: { tokenizerId: 'fixture', tokenizerDigest: 'fixture/v1',
    countRequest: request => countRequest(request.messages, request.tools), countText: async request => counters.countText(request.text) } },
  tools: { execute: async request => { toolCalls++;
    return { status: 'ok', content: request.call.callId === 'old' ? 'OLD_EVIDENCE:'.repeat(650) : 'Recent observation' }; } },
  model: { generate: async request => {
    assert.equal(request.purpose ?? 'task', 'task'); taskCalls++;
    if (taskCalls <= 2) return { ...final(''), kind: 'tool_calls', toolCalls: [{ callId: taskCalls === 1 ? 'old' : 'recent', name: 'read', arguments: {} }] };
    assert.ok(request.messages.some(message => message.role === 'tool' && message.content.includes('historical_tool_result_cleared')));
    assert.ok(!request.messages.some(message => message.role === 'tool' && message.content.includes('OLD_EVIDENCE:')));
    return final('Completed with idle cleanup');
  } } };
  await assert.rejects(new NativeKernel({ store, ports, digest, owner: 'before-reopen', now: () => now, onCheckpoint: async next => {
    if (!idleStarted && next.messages.some(message => message.role === 'tool' && message.callId === 'recent')) {
      idleStarted = true; now += 3600001;
    }
    if (next.preparedContext?.toolResultPruning?.trigger === 'idle') throw Error('stop after idle admission');
  } }).runUntilIdle(scope, 'run'), /stop after idle admission/);
  assert.equal(toolCalls, 2); assert.equal(taskCalls, 2);
  assert.equal(store.load(scope, 'run').snapshot.messages.find(message => message.callId === 'old').toolOutcome, 'ok');
  store.close(); store = new SqliteRunStore(filename);
  const kernel = new NativeKernel({ store, ports, digest, owner: 'after-reopen', now: () => now });
  const end = await kernel.runUntilIdle(scope, 'run');
  assert.equal(end.phase, 'completed'); assert.equal(end.messages.at(-1).completedAtMs, now);
  assert.equal(end.contextState.compactions, 0); assert.equal(taskCalls, 3); assert.equal(toolCalls, 2);
  const original = store.load(scope, 'run');
  now += 3600001;
  kernel.start({ ...snapshot, runId: 'next', turnId: 'next-turn' }, config);
  assert.equal(store.load(scope, 'next').snapshot.messages.filter(message => message.role === 'assistant').at(-1).completedAtMs, now - 3600001);
  assert.equal((await kernel.runUntilIdle(scope, 'next')).phase, 'completed');
  assert.equal(taskCalls, 4); assert.equal(toolCalls, 2);
  assert.deepEqual(store.load(scope, 'run'), original);
  assert.equal(store.events(scope, 'next').filter(event => event.kind === 'context.tool_results_pruned' && event.payload.trigger === 'idle').length, 1);
});

test('Studio admits the 60-minute default only for new enabled bindings and preserves explicit zero', () => {
  const description = { protocol: 'openai-chat', modelName: 'test', contextWindow: 32000, maxOutputTokens: 1000 };
  const bind = (raw, pruningIdleDefaults = false) => bindNativeContext({ description, context: { compaction: raw }, pruningIdleDefaults }).policy;
  assert.equal(bind({ pruneToolResults: true }, true).pruneIdleThresholdMinutes, 60);
  assert.equal(bind({ pruneToolResults: true }).pruneIdleThresholdMinutes, undefined);
  assert.equal(bind({}, true).pruneIdleThresholdMinutes, undefined);
  assert.equal(bind({ pruneToolResults: false }, true).pruneIdleThresholdMinutes, undefined);
  assert.equal(bind({ pruneToolResults: true, pruneIdleThresholdMinutes: 0 }, true).pruneIdleThresholdMinutes, 0);
  for (const value of [-1, .5, null, '60'])
    assert.throws(() => fixture({ contextPolicy: { ...policy, pruneIdleThresholdMinutes: value } }), /invalid_context_pruning_policy/);
});
