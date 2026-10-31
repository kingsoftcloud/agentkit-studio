import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeKernel, MemoryRunStore, configure, emptyUsage, projectSessionHistory, initialSnapshot } from '../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { fixture, scope, digest } from './fixtures.mjs';

for (const backend of ['memory', 'sqlite']) test(`${backend}: rewind rebases the same Session without rewriting its execution chain and survives the next cold turn`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'native-conversation-rewind-'));
  let store = backend === 'sqlite' ? new SqliteRunStore(join(root, 'runs.sqlite')) : new MemoryRunStore();
  t.after(() => { store.close?.(); rmSync(root, { recursive: true, force: true }); });
  const { config, snapshot } = fixture({ inputMessages: [{ role: 'user', content: 'Kept input' }] });
  const model = { generate: async request => ({ kind: 'final_candidate', text: `${request.runId} answer`, toolCalls: [], usage: emptyUsage() }) };
  let kernel = new NativeKernel({ store, digest, owner: 'before', ports: { model } });
  kernel.start(snapshot, config); await kernel.runUntilIdle(scope, 'run');
  const first = store.load(scope, 'run');
  const laterConfig = configure({ ...config, inputMessages: [{ role: 'user', content: 'Removed input' }] });
  kernel.start({ ...snapshot, runId: 'later', turnId: '2' }, laterConfig); await kernel.runUntilIdle(scope, 'later');
  const later = store.load(scope, 'later');
  const seed = { contract: 'native-conversation-fork/v1', source: { parentSessionId: 'session', sessionId: 'session', runId: 'run',
    turnId: '1', boundarySeq: 4, snapshotRevision: first.snapshot.revision, configDigest: first.snapshot.configDigest,
    snapshotDigest: digest(first.snapshot), transcriptDigest: 'selected-prefix' },
    messages: projectSessionHistory(first, config, digest, { identityNamespace: 'rewind-one' }) };
  const rewind = { contract: 'native-conversation-rewind/v1', commandId: 'rewind-one', expectedHeadRunId: 'later', generation: 1, markerDigest: 'marker-one' };
  const nextConfig = configure({ ...config, inputMessages: [{ role: 'user', content: 'Replacement input' }], conversationSeed: seed, conversationRewind: rewind });
  const identity = { ...snapshot, runId: 'replacement', turnId: '3' };
  assert.throws(() => kernel.start(identity, configure({ ...nextConfig, conversationRewind: { ...rewind, expectedHeadRunId: 'run' } })),
    { code: 'conversation_rewind_head_conflict' });
  const next = kernel.start(identity, nextConfig);
  assert.equal(next.parentRunId, 'later'); assert.equal(next.taskChainId, snapshot.taskChainId);
  assert.deepEqual(next.conversationBranch, { commandId: 'rewind-one', generation: 1 });
  for (const content of ['Kept input', 'run answer', 'Replacement input']) assert.ok(next.messages.some(message => message.content === content));
  assert.doesNotMatch(JSON.stringify(next.messages), /Removed input|later answer/);
  assert.deepEqual(next.usage, emptyUsage()); assert.deepEqual(next.children, []); assert.deepEqual(next.backgroundCommands, []);
  await kernel.runUntilIdle(scope, 'replacement');
  assert.deepEqual(store.load(scope, 'run'), first); assert.deepEqual(store.load(scope, 'later'), later);
  if (backend === 'sqlite') { store.close(); store = new SqliteRunStore(join(root, 'runs.sqlite')); }
  kernel = new NativeKernel({ store, digest, owner: 'after', ports: { model } });
  assert.equal(kernel.attach(scope, 'replacement').conversationBranch.generation, 1);
  const follow = kernel.start({ ...identity, runId: 'follow', turnId: '4' }, config);
  assert.deepEqual(follow.conversationBranch, next.conversationBranch);
  assert.match(JSON.stringify(follow.messages), /replacement answer/); assert.doesNotMatch(JSON.stringify(follow.messages), /Removed input|later answer/);
  await kernel.runUntilIdle(scope, 'follow');
  const rootConfig = configure({ ...nextConfig, conversationSeed: { ...seed, messages: [] },
    conversationRewind: { ...rewind, commandId: 'rewind-root', expectedHeadRunId: 'follow', generation: 2 } });
  const rebasedRoot = kernel.start({ ...identity, runId: 'root', turnId: '5' }, rootConfig);
  assert.doesNotMatch(JSON.stringify(rebasedRoot.messages), /Kept input|run answer|replacement answer|Removed input/);
  assert.equal(rebasedRoot.conversationBranch.generation, 2);
  assert.throws(() => store.create(config, initialSnapshot({ ...identity, runId: 'forged', parentRunId: 'root' }, config, digest(config))),
    { code: 'session_already_active' });
  await kernel.runUntilIdle(scope, 'root');
  assert.throws(() => store.create(config, initialSnapshot({ ...identity, runId: 'forged', parentRunId: 'root' }, config, digest(config))),
    { code: 'conversation_rewind_head_conflict' });
  assert.throws(() => kernel.start({ ...identity, runId: 'stale-generation', turnId: '6' }, configure({ ...rootConfig,
    conversationRewind: { ...rootConfig.conversationRewind, expectedHeadRunId: 'root' } })),
  { code: 'conversation_rewind_head_conflict' });
  const badConfig = configure({ ...rootConfig, conversationRewind: { ...rootConfig.conversationRewind,
    expectedHeadRunId: 'root', commandId: 'next', generation: 3 } });
  const forged = initialSnapshot({ ...identity, runId: 'forged-branch', parentRunId: 'root' }, badConfig, digest(badConfig));
  forged.conversationBranch = { commandId: 'different-command', generation: 3 };
  assert.throws(() => store.create(badConfig, forged), { code: 'conversation_rewind_head_conflict' });
});

test('rewind metadata cannot be configured without its data-only seed', () => {
  assert.throws(() => configure({ ...fixture().config, conversationRewind: { contract: 'native-conversation-rewind/v1',
    commandId: 'command', expectedHeadRunId: 'head', generation: 1, markerDigest: 'digest' } }), { code: 'invalid_conversation_rewind' });
});
