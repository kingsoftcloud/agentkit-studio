import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeKernel, MemoryRunStore, emptyUsage, projectSessionHistory, configure, initialSnapshot } from '@kingsoftcloud/agentkit-harness-core';
import { fixture, digest, tool } from './fixtures/native-core.mjs';
import { nativeDshOwnership } from '@kingsoftcloud/agentkit-harness-node/native/dsh-turn-ownership';
import { nativeConversationRetainedCommands } from '../src/providers/native-conversation-tasks.mjs';

async function history() {
  const scope = { tenantId: 'local', workspaceId: 'workspace', userId: 'local-user', agentId: 'agent' }, store = new MemoryRunStore();
  const sources = [], events = [];
  for (const turn of [1, 2]) {
    const messages = [{ id: `input-${turn}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `Input ${turn}` }] }];
    const { config, snapshot } = fixture({ inputMessages: [{ role: 'user', content: `Input ${turn}` }],
      tools: [tool({ name: 'run_command', readOnly: false, concurrentSafe: false, backgroundCommandPolicy: 'owned-command-launch/v1' })] });
    const identity = { ...snapshot, scope, turnId: String(turn), runId: `native-dsh-${digest({ contract: 'agentkit.native-dsh-turn/v1', scope, sessionId: 'session', turn })}` };
    let calls = 0;
    const kernel = new NativeKernel({ store, digest, owner: `turn-${turn}`, ports: {
      model: { generate: async () => ({ kind: ++calls === 1 ? 'tool_calls' : 'final_candidate', text: calls === 1 ? '' : `Answer ${turn}`,
        toolCalls: calls === 1 ? [{ callId: `launch-${turn}`, name: 'run_command', arguments: {} }] : [], usage: emptyUsage() }) },
      tools: { execute: async request => ({ status: 'ok', content: { backend: 'sandbox/local_process' },
        backgroundCommandRef: { taskId: String(turn).repeat(64), sourceRunId: request.runId, operationKey: request.operationKey } }) } } });
    kernel.start(identity, config); await kernel.runUntilIdle(scope, identity.runId);
    const record = store.load(scope, identity.runId); sources.push(record);
    for (const event of [{ type: 'turn/start', data: { turn } },
      { type: 'turn/owner', data: nativeDshOwnership({ identity: Object.fromEntries(['scope', 'runId', 'sessionId', 'turnId', 'buildId', 'parentRunId', 'taskChainId']
        .map(key => [key, record.snapshot[key]])), configuration: config, input: { messages }, source: { provider: 'fixture', model: 'fixture' } }) },
      { type: 'user/message', data: messages[0] }, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } }]) events.push({ ...event, seq: events.length });
  }
  const [first, head] = sources, prefix = events.slice(0, 6);
  const seed = { contract: 'native-conversation-fork/v1', source: { parentSessionId: 'session', sessionId: 'session', runId: first.snapshot.runId,
    turnId: '1', boundarySeq: 6, snapshotRevision: first.snapshot.revision, configDigest: first.snapshot.configDigest,
    snapshotDigest: digest(first.snapshot), transcriptDigest: 'prefix' }, messages: projectSessionHistory(first, first.configuration, digest, { identityNamespace: 'rewind' }) };
  return { scope, store, sources, first, head, prefix, seed, events };
}

test('command retention follows committed launch receipts and kept actual turn boundaries, including pruned history', async () => {
  const h = await history(), select = (seed = h.seed, prefix = h.prefix) => nativeConversationRetainedCommands({ store: h.store, scope: h.scope,
    record: h.head, seed, prefix, sourceEvents: h.events });
  assert.deepEqual(select(), [h.first.snapshot.backgroundCommands[0].ref]);
  assert.deepEqual(select({ ...h.seed, messages: [] }), select(), 'a closed kept turn retains its task even when model history was compacted');
  assert.deepEqual(select({ ...h.seed, messages: [] }, h.events.slice(0, 2)), [], 'before first input keeps no task');
  assert.deepEqual(select(h.seed, h.events.slice(0, 3)), select(), 'a partial turn keeps only a published original launch call/result');
  assert.throws(() => nativeConversationRetainedCommands({ store: h.store, scope: h.scope, record: h.head,
    seed: h.seed, prefix: h.prefix, sourceEvents: [] }), { code: 'native_conversation_command_source_unavailable' });
});

test('rewind retains only exact already-owned background rows and the next ordinary turn inherits them', async () => {
  const h = await history(), retained = [h.first.snapshot.backgroundCommands[0]], identity = { ...h.head.snapshot, runId: 'replacement', turnId: '3', parentRunId: h.head.snapshot.runId };
  const rewind = { contract: 'native-conversation-rewind/v1', commandId: 'rewind', expectedHeadRunId: h.head.snapshot.runId, generation: 1,
    markerDigest: 'marker', retainedBackgroundCommands: retained };
  const config = configure({ ...h.head.configuration, conversationSeed: h.seed, conversationRewind: rewind });
  const kernel = new NativeKernel({ store: h.store, digest, owner: 'replacement', ports: { model: { generate: async () => ({ kind: 'final_candidate',
    text: 'Replacement', toolCalls: [], usage: emptyUsage() }) } } });
  const wrong = configure({ ...config, conversationRewind: { ...rewind, retainedBackgroundCommands: [{ ...retained[0], ref: { ...retained[0].ref, taskId: 'f'.repeat(64) } }] } });
  assert.throws(() => kernel.start(identity, wrong), { code: 'conversation_rewind_command_not_owned' });
  const forged = initialSnapshot(identity, config, digest(config)); forged.conversationBranch = { commandId: 'rewind', generation: 1 };
  assert.throws(() => h.store.create(config, forged), { code: 'conversation_rewind_command_not_owned' });
  assert.deepEqual(kernel.start(identity, config).backgroundCommands, retained);
  await kernel.runUntilIdle(h.scope, identity.runId);
  assert.deepEqual(kernel.start({ ...identity, runId: 'follow', turnId: '4', parentRunId: identity.runId }, h.head.configuration).backgroundCommands, retained);
  assert.deepEqual(h.store.load(h.scope, h.head.snapshot.runId), h.head, 'old source ledger remains unchanged');
});
