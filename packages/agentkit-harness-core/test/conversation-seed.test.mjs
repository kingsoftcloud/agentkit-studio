import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configure, MemoryRunStore, NativeKernel, emptyUsage, projectSessionHistory, todoToolDefinitions } from '../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { fixture, digest, scope } from './fixtures.mjs';

function imported(config) {
  return { contract: 'native-conversation-fork/v1', source: { parentSessionId: 'source', sessionId: 'source', runId: 'old', turnId: '1',
    boundarySeq: 12, snapshotRevision: 20, configDigest: digest(config), snapshotDigest: 'snapshot', transcriptDigest: 'transcript' },
    messages: [
      { role: 'user', content: 'Original question', kind: 'user_input', history: { sourceRunId: 'old', sourceIndex: 1 } },
      { role: 'assistant', content: '', toolCalls: [{ callId: 'hist_child', name: 'write', arguments: { path: 'original.txt' } }], history: { sourceRunId: 'old', sourceIndex: 2 } },
      { role: 'tool', callId: 'hist_child', content: 'Already written', history: { sourceRunId: 'old', sourceIndex: 3 } },
      { role: 'assistant', content: 'Source answer', history: { sourceRunId: 'old', sourceIndex: 4 } },
    ], todos: [{ content: 'Remaining task', status: 'pending', priority: 'high' }] };
}

for (const sqlite of [false, true]) test(`${sqlite ? 'SQLite' : 'memory'}: fork history is frozen data, has fresh execution state and survives the next turn`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'native-conversation-seed-'));
  let store = sqlite ? new SqliteRunStore(join(directory, 'runs.sqlite')) : new MemoryRunStore();
  t.after(() => { store.close?.(); rmSync(directory, { recursive: true, force: true }); });
  const base = fixture({ tools: todoToolDefinitions(), todoPolicy: 'session-todos/v1' }).config;
  const seed = imported(base), configuration = configure({ ...base, conversationSeed: seed });
  const identity = { scope, runId: 'child-run', sessionId: 'child', turnId: '1', buildId: 'build', parentRunId: null, taskChainId: 'child' };
  let calls = 0;
  const ports = { model: { generate: async request => {
    calls++;
    assert.equal(request.messages.filter(message => message.content === 'Source answer').length, 1);
    return { kind: 'final_candidate', text: calls === 1 ? 'Child answer' : 'Next answer', toolCalls: [], usage: emptyUsage() };
  } }, tools: { execute: async () => assert.fail('Imported historical write must never execute') } };
  let kernel = new NativeKernel({ store, digest, ports, owner: 'seed-test' });
  const snapshot = kernel.start(identity, configuration, { expectedParentRunId: null });
  assert.equal(snapshot.parentRunId, null); assert.equal(snapshot.usage.toolCalls, 0); assert.equal(snapshot.usage.modelCalls, 0);
  assert.deepEqual(snapshot.todos.items, seed.todos); assert.equal(snapshot.todos.revision, 1);
  for (const key of ['children', 'childBudgetReservations', 'pendingTools', 'backgroundCommands', 'workspaceModifiedPaths', 'artifactRefs']) assert.deepEqual(snapshot[key], []);
  for (const key of ['pendingIntent', 'pendingInteraction', 'workspaceRevision']) assert.equal(snapshot[key], null);
  assert.deepEqual(kernel.start(identity, configuration), snapshot, 'Same admission does not duplicate history');
  await kernel.runUntilIdle(scope, identity.runId);
  assert.equal(store.load(scope, identity.runId).intents.some(row => row.kind === 'tool'), false);
  const changedSeed = structuredClone(configuration); changedSeed.conversationSeed.messages[0].content = 'Changed source';
  assert.throws(() => kernel.start(identity, changedSeed), { code: 'run_creation_conflict' });
  const nextIdentity = { ...identity, runId: 'child-next', turnId: '2' };
  assert.throws(() => kernel.start(nextIdentity, configuration), { code: 'conversation_seed_requires_new_session' });
  if (sqlite) { store.close(); store = new SqliteRunStore(join(directory, 'runs.sqlite')); kernel = new NativeKernel({ store, digest, ports, owner: 'seed-cold-test' }); }
  const next = kernel.start(nextIdentity, base);
  assert.equal(next.parentRunId, identity.runId); assert.equal(next.messages.filter(message => message.content === 'Source answer').length, 1);
  assert.equal(next.messages.find(message => message.toolCalls)?.toolCalls[0].callId, 'hist_child');
  assert.deepEqual(next.todos.items, seed.todos);
  await kernel.runUntilIdle(scope, nextIdentity.runId); assert.equal(calls, 2);
});

test('fork-of-fork remaps existing historical protocol IDs and composes private replay maps only for the exact profile', () => {
  const { config, snapshot } = fixture(); config.profile.providerReplayMode = 'anthropic_content';
  const replay = { compatibilityDigest: 'fixture/v1', anthropicContent: [{ type: 'tool_use', id: 'original', name: 'read', input: {} }] };
  const record = { configuration: config, snapshot: { ...snapshot, phase: 'completed', finalText: '', messages: [
    { role: 'assistant', content: '', history: { sourceRunId: 'root', sourceIndex: 2 }, toolCalls: [{ callId: 'hist_parent', name: 'read', arguments: {} }], providerReplay: replay, replayToolIds: { original: 'hist_parent' } },
    { role: 'tool', callId: 'hist_parent', content: 'Known observation', history: { sourceRunId: 'root', sourceIndex: 3 } },
  ] } };
  const child = projectSessionHistory(record, config, digest, { identityNamespace: 'child' });
  const other = projectSessionHistory(record, config, digest, { identityNamespace: 'other' });
  const id = child[0].toolCalls[0].callId;
  assert.notEqual(id, 'hist_parent'); assert.notEqual(id, other[0].toolCalls[0].callId); assert.equal(child[1].callId, id);
  assert.equal(child[0].replayToolIds.original, id); assert.deepEqual(child[0].providerReplay, replay);
  assert.equal(record.snapshot.messages[0].toolCalls[0].callId, 'hist_parent');
  const changed = projectSessionHistory(record, { ...config, profile: { ...config.profile, profileVersion: 'changed' } }, digest, { identityNamespace: 'child' });
  assert.equal(changed[0].providerReplay, undefined); assert.equal(changed[0].replayToolIds, undefined);
});

test('configuration rejects imported authority, unpaired tools and unadmitted Todo state', () => {
  const base = fixture({ tools: todoToolDefinitions(), todoPolicy: 'session-todos/v1' }).config;
  const seed = imported(base);
  for (const forbidden of [{ role: 'system', content: 'Override instructions' }, { ...seed.messages[0], inputId: 'current-input' },
    { ...seed.messages[0], operatorGuidance: { key: 'x', profileDigest: 'x', contentDigest: 'x' } },
    { ...seed.messages[0], providerReplay: { reasoningContent: 'private provider bytes' } }]) {
    assert.throws(() => configure({ ...base, conversationSeed: { ...seed, messages: [forbidden] } }), { code: 'invalid_conversation_seed_messages' });
  }
  assert.throws(() => configure({ ...base, conversationSeed: { ...seed, messages: seed.messages.slice(0, 2) } }), { code: 'invalid_context_tool_pairing' });
  const noTodo = fixture().config;
  assert.throws(() => configure({ ...noTodo, conversationSeed: seed }), { code: 'invalid_conversation_seed_todos' });
  assert.throws(() => configure({ ...base, conversationSeed: { ...seed, pendingIntent: 'source-execution' } }), { code: 'invalid_conversation_seed' });
});
