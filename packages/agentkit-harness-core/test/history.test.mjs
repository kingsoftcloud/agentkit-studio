import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeKernel, MemoryRunStore, emptyUsage, initialSnapshot, projectSessionHistory,
  normalizeToolIdentities, transition } from '../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { fixture, scope, digest, tool } from './fixtures.mjs';

for (const backend of ['memory', 'sqlite']) {
  const setup = t => {
    const dir = mkdtempSync(join(tmpdir(), 'native-history-'));
    const filename = join(dir, 'ledger.sqlite');
    const store = backend === 'memory' ? new MemoryRunStore() : new SqliteRunStore(filename);
    t.after(() => { store.close?.(); rmSync(dir, { recursive: true, force: true }); });
    return { store, filename };
  };
  test(`${backend}: a later user turn retains paired observations once and admits no second active turn`, async t => {
    const { store } = setup(t), { config, snapshot } = fixture({ tools: [tool()], instructions: 'Current system' });
    let models = 0, tools = 0;
    const kernel = new NativeKernel({ store, owner: 'worker', digest, ports: {
      model: { generate: async request => {
        models++;
        if (request.runId === 'run' && models === 1) return { kind: 'tool_calls', text: '', usage: emptyUsage(),
          toolCalls: [{ callId: 'provider-local-id', name: 'read', arguments: {} }] };
        return { kind: 'final_candidate', text: request.runId === 'run' ? 'First answer' : 'Next answer', toolCalls: [], usage: emptyUsage() };
      } },
      tools: { execute: async () => { tools++; return { status: 'ok', content: 'Actual file contents' }; } },
    } });
    kernel.start(snapshot, config);
    const nextIdentity = { ...snapshot, runId: 'next', turnId: 'turn-2' };
    assert.throws(() => kernel.start(nextIdentity, config), { code: 'session_already_active' });
    const first = await kernel.runUntilIdle(scope, 'run');
    const nextConfig = { ...config, contract: { ...config.contract, objective: 'Follow-up question' } };
    assert.throws(() => kernel.start(nextIdentity, nextConfig, { expectedParentRunId: null }), { code: 'session_head_conflict' });
    const next = kernel.start(nextIdentity, nextConfig, { expectedParentRunId: 'run' });
    assert.equal(next.parentRunId, 'run');
    assert.equal(next.messages.filter(message => message.role === 'system').length, 1);
    assert.deepEqual(next.messages.filter(message => message.role === 'user').map(message => message.content), ['Complete the task', 'Follow-up question']);
    assert.equal(next.messages.filter(message => message.content === 'First answer').length, 1);
    const call = next.messages.find(message => message.toolCalls)?.toolCalls[0];
    const observation = next.messages.find(message => message.role === 'tool');
    assert.match(call.callId, /^hist_[a-f0-9]{32}$/);
    assert.equal(observation.callId, call.callId);
    assert.equal(observation.content, '"Actual file contents"');
    assert.deepEqual(kernel.start(nextIdentity, nextConfig), next);
    assert.equal(tools, 1);
    await kernel.runUntilIdle(scope, 'next');
    const third = kernel.start({ ...nextIdentity, runId: 'third', turnId: 'turn-3' }, config);
    assert.equal(third.messages.filter(message => message.content === '"Actual file contents"').length, 1);
    assert.equal(third.messages.find(message => message.toolCalls)?.toolCalls[0].callId, call.callId);
    assert.deepEqual(store.load(scope, 'run').snapshot, first);
  });
  test(`${backend}: session-head compare-and-swap rejects a stale parent without creating an orphan`, t => {
    const { store, filename } = setup(t), { config, snapshot } = fixture();
    store.create(config, snapshot);
    const lease = store.acquire(scope, 'run', 'worker', 1, 100);
    store.commit(scope, 'run', lease, 2, 0, transition(snapshot, { phase: 'completed', outcome: 'unverified' }));
    const other = backend === 'sqlite' ? new SqliteRunStore(filename) : store;
    if (other !== store) t.after(() => other.close());
    const stale = initialSnapshot({ ...snapshot, runId: 'stale', turnId: 'stale', parentRunId: 'run' }, config, digest(config));
    store.create(config, { ...stale, runId: 'winner', turnId: 'winner' });
    assert.throws(() => other.create(config, stale), { code: 'session_head_conflict' });
    assert.equal(other.sessionHead(scope, 'session').runId, 'winner');
    assert.throws(() => other.load(scope, 'stale'), { code: 'run_not_found' });
    assert.equal(other.sessionHead({ ...scope, userId: 'another-user' }, 'session'), null);
  });
}

test('history closes unanswered calls as unknown and quotes orphan receipts without dispatch or transient prose', () => {
  const { config, snapshot } = fixture();
  const parent = { configuration: config, snapshot: { ...snapshot, phase: 'interrupted', finalText: '', messages: [
    { role: 'system', content: 'Old control frame' },
    { role: 'user', content: 'Task' },
    { role: 'assistant', content: 'incomplete', kind: 'continuation_fragment' },
    { role: 'assistant', content: '', toolCalls: [{ callId: 'lost', name: 'write', arguments: {} }] },
    { role: 'user', kind: 'model_feedback', content: 'Old retry instruction' },
    { role: 'user', content: 'Later steering', kind: 'guidance' },
    { role: 'tool', callId: 'orphan', content: 'A separate historical receipt' },
    { role: 'assistant', content: 'Rejected candidate', kind: 'final_candidate' },
  ] } };
  const messages = projectSessionHistory(parent, config, digest);
  assert.equal(messages.filter(message => message.role === 'tool').length, 1);
  assert.equal(JSON.parse(messages.find(message => message.role === 'tool').content).executionStatus, 'unknown');
  assert.ok(messages.some(message => message.kind === 'historical_tool_observation' && message.content.includes('historical receipt')));
  assert.ok(messages.some(message => message.content === 'Later steering'));
  assert.doesNotMatch(JSON.stringify(messages), /Old control frame|Old retry instruction|Rejected candidate|incomplete"/);
  assert.deepEqual(parent.snapshot.messages[3].toolCalls[0].callId, 'lost');
});

test('history binds private replay to the exact profile and carries a separate protocol-id map', () => {
  const { config, snapshot } = fixture();
  config.profile.providerReplayMode = 'anthropic_content';
  const privateReplay = { compatibilityDigest: 'fixture/v1', anthropicContent: [{ type: 'tool_use', id: 'old', name: 'read', input: {} }] };
  const parent = { configuration: config, snapshot: { ...snapshot, phase: 'completed', messages: [
    { role: 'assistant', content: '', toolCalls: [{ callId: 'old', name: 'read', arguments: {} }], providerReplay: privateReplay },
    { role: 'tool', callId: 'old', content: 'result' },
  ] } };
  const messages = projectSessionHistory(parent, config, digest);
  assert.deepEqual(messages[0].providerReplay, privateReplay);
  assert.equal(messages[0].replayToolIds.old, messages[0].toolCalls[0].callId);
  const changed = { ...config, profile: { ...config.profile, profileVersion: '2' } };
  const projected = projectSessionHistory(parent, changed, digest);
  assert.equal(projected[0].providerReplay, undefined);
  assert.equal(projected[0].replayToolIds, undefined);
});

test('a reused provider call id gets a stable fresh id without altering its sealed raw response', () => {
  const { snapshot } = fixture();
  snapshot.messages.push({ role: 'assistant', content: '', toolCalls: [{ callId: 'same', name: 'read', arguments: {} }] });
  const result = { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ callId: 'same', name: 'write', arguments: {} }],
    providerReplay: { compatibilityDigest: 'fixture/v1', reasoningContent: 'private' } };
  const projected = normalizeToolIdentities(snapshot, result, digest);
  assert.match(projected.toolCalls[0].callId, /^call_[a-f0-9]{32}$/);
  assert.equal(projected.replayToolIds.same, projected.toolCalls[0].callId);
  assert.deepEqual(normalizeToolIdentities(snapshot, result, digest), projected);
  assert.equal(result.toolCalls[0].callId, 'same');
  assert.throws(() => normalizeToolIdentities(snapshot, { ...result, toolCalls: [...result.toolCalls, ...result.toolCalls] }, digest), { code: 'invalid_tool_call' });
});
