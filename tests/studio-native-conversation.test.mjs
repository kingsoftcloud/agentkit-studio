import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRunStore, NativeKernel, emptyUsage } from '../packages/agentkit-harness-core/dist/index.mjs';
import { fixture, digest } from '../packages/agentkit-harness-core/test/fixtures.mjs';
import { nativeRecoveryBinding } from '../src/providers/native-recovery-binding.mjs';
import { nativeDshOwnership } from '../packages/agentkit-harness/src/native/dsh-turn-ownership.mjs';
import { createStudioNativeConversation, validateNativeConversationRequest } from '../src/host/services/native-conversation.mjs';

// The focused Host double exercises races and failed persistence. The packed
// verifier separately uses actual Agents, Session surfaces, SQLite and HTTP.
async function setup(t) {
  const scope = { tenantId: 'local', workspaceId: 'workspace', userId: 'local-user', agentId: 'agent' };
  const store = new MemoryRunStore(), lifetime = new AbortController(); t.after(() => lifetime.abort());
  const input = { messages: [{ id: 'input', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Original input' }] }] };
  const binding = { agentId: 'agent', agentRevision: 1, runtime: 'harness', local: true, nativeEngineContract: 'agentkit.native-dsh-turn/v1' };
  const source = { provider: 'fixture', model: 'fixture' };
  const { config, snapshot } = fixture({ hostRecoveryBinding: nativeRecoveryBinding({ binding, input, source, selection: {}, systemPrompt: '' }) });
  const identity = { ...snapshot, scope, turnId: '1', runId: `native-dsh-${digest({ contract: binding.nativeEngineContract, scope, sessionId: 'session', turn: 1 })}` };
  const kernel = new NativeKernel({ store, digest, owner: 'fixture', ports: { model: { generate: async () => ({ kind: 'final_candidate',
    text: 'Original answer', toolCalls: [], usage: emptyUsage() }) } } });
  kernel.start(identity, config); await kernel.runUntilIdle(scope, identity.runId);
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'turn/owner', data: nativeDshOwnership({ identity: Object.fromEntries(['scope', 'runId', 'sessionId', 'turnId', 'buildId', 'parentRunId', 'taskChainId'].map(key => [key, identity[key]])), configuration: config, input, source }) },
    { type: 'user/message', data: input.messages[0] },
    { type: 'assistant/message', data: { message: { id: 'answer', role: 'assistant', content: [{ type: 'text', text: 'Original answer' }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ].map((event, seq) => ({ ...event, seq }));
  const session = { id: 'session', surface: { nodes: [2, 3] }, snapshotEvents: () => structuredClone(events), isOwnSeq: () => true,
    append(type, data, options) {
      const seq = events.length; events.push({ type, data: structuredClone(data), ...options, seq });
      session.surface.nodes = session.surface.nodes.filter(node => node < options.surfaceOp.startSeq || node > options.surfaceOp.endSeq).concat(seq);
    } };
  const agent = { id: 'host-agent', session, status: 'idle', externalTurns: { pending: () => null } };
  let liveAgent = agent, durable = true, query = async () => binding, projectRecord = value => value;
  const ctx = { get: name => ({ sessionController: { resolveAgent: async () => ({ agent }) }, agents: { get: () => liveAgent },
    sessionProjections: { stateOf: () => 'preset' }, sessions: { flush: async () => durable } })[name] };
  const service = createStudioNativeConversation({ ctx, store: { sessionHead: (...args) => store.sessionHead(...args),
    load: (...args) => projectRecord(store.load(...args)) }, workspaceId: 'workspace', lifetime,
    agentEvents: () => ({ serial: () => query() }) });
  return { service, agent, store, scope, events, config, identity, binding,
    status: { agentId: 'agent', sessionId: 'session' },
    request: { agentId: 'agent', sessionId: 'session', expectedHeadRunId: identity.runId, expectedGeneration: 0, targetMessageId: 'input', commandId: 'rewind' },
    durability(value) { durable = value; }, onQuery(callback) { query = callback; }, replaceAgent(value) { liveAgent = value; },
    projectRecord(callback) { projectRecord = callback; } };
}

test('idle rewind accepts committed claims, but blocks live agents and leases', async t => {
  const h = await setup(t);
  assert.equal((await h.service.status(h.status)).canRewind, true);
  h.agent.status = 'running';
  assert.equal((await h.service.status(h.status)).canRewind, false);
  await assert.rejects(h.service.rewind(h.request), { code: 'studio_native_conversation_rewind_requires_idle' });
  h.agent.status = 'idle'; h.store.acquire(h.scope, h.identity.runId, 'another-owner', Date.now(), 60000);
  assert.equal((await h.service.status(h.status)).canRewind, false);
  await assert.rejects(h.service.rewind(h.request), { code: 'studio_native_conversation_rewind_requires_idle' });
  assert.equal(h.events.length, 5);
});

test('failed flush retries the same branch commit without appending twice or rewriting the old Run', async t => {
  const h = await setup(t), before = h.store.load(h.scope, h.identity.runId);
  h.durability(false);
  await assert.rejects(h.service.rewind(h.request), { code: 'native_conversation_rewind_not_durable' });
  assert.equal(h.events.length, 6); assert.deepEqual(h.agent.session.surface.nodes, [5]);
  h.durability(true);
  const accepted = await h.service.rewind(h.request);
  assert.equal(accepted.generation, 1); assert.equal(accepted.surfacePersisted, true);
  assert.deepEqual(await h.service.rewind(h.request), accepted); assert.equal(h.events.length, 6);
  await assert.rejects(h.service.rewind({ ...h.request, targetMessageId: 'different' }), { code: 'command_replay_conflict' });
  assert.deepEqual(h.store.load(h.scope, h.identity.runId), before);
});

test('a committed tool batch with an uncertain individual effect cannot be hidden by rewind', async t => {
  const h = await setup(t);
  h.projectRecord(record => ({ ...record, receipts: [...record.receipts,
    { operationKey: 'uncertain-tool', status: 'committed', result: { results: [{ status: 'uncertain' }] } }] }));
  assert.equal((await h.service.status(h.status)).canRewind, false);
  await assert.rejects(h.service.rewind(h.request), { code: 'studio_native_conversation_rewind_requires_idle' });
  assert.equal(h.events.length, 5);
});

test('replacing the live Agent during preset resolution cannot publish a branch cut', async t => {
  const h = await setup(t);
  h.onQuery(async () => { h.replaceAgent({ ...h.agent }); return h.binding; });
  await assert.rejects(h.service.rewind(h.request), { code: 'studio_native_conversation_changed' });
  assert.equal(h.events.length, 5);
});

test('mutating the caller request during preset resolution cannot select another target', async t => {
  const h = await setup(t);
  h.onQuery(async () => { h.request.targetMessageId = 'different'; return h.binding; });
  await assert.rejects(h.service.rewind(h.request), { code: 'studio_native_conversation_changed' });
  assert.equal(h.events.length, 5);
});

test('stale head or generation rejects before publishing; unknown request fields are not accepted', async t => {
  const h = await setup(t);
  for (const request of [{ ...h.request, expectedHeadRunId: 'old-head' }, { ...h.request, expectedGeneration: 1 }])
    await assert.rejects(h.service.rewind(request), { code: 'native_conversation_rewind_head_conflict' });
  assert.throws(() => validateNativeConversationRequest({ ...h.request, seed: {} }, true), { code: 'STUDIO_NATIVE_CONVERSATION_INVALID' });
  assert.equal(h.events.length, 5);
});
