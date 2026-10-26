import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRunStore, NativeKernel, emptyUsage } from '../packages/agentkit-harness-core/dist/index.mjs';
import { fixture, digest, tool } from '../packages/agentkit-harness-core/test/fixtures.mjs';
import { nativeRecoveryBinding } from '../src/providers/native-recovery-binding.mjs';
import { nativeDshOwnership } from '../packages/agentkit-harness/src/native/dsh-turn-ownership.mjs';
import { createStudioNativeConversation, validateNativeConversationRequest } from '../src/host/services/native-conversation.mjs';

// The focused Host double exercises races and failed persistence. The packed
// verifier separately uses actual Agents, Session surfaces, SQLite and HTTP.
async function setup(t, { active = false, model, tools, stopTimeoutMs, configuration = {} } = {}) {
  const scope = { tenantId: 'local', workspaceId: 'workspace', userId: 'local-user', agentId: 'agent' };
  const store = new MemoryRunStore(), lifetime = new AbortController(); t.after(() => lifetime.abort());
  const input = { messages: [{ id: 'input', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Original input' }] }] };
  const binding = { agentId: 'agent', agentRevision: 1, runtime: 'harness', local: true, nativeEngineContract: 'agentkit.native-dsh-turn/v1' };
  const source = { provider: 'fixture', model: 'fixture' };
  const { config, snapshot } = fixture({ ...configuration, hostRecoveryBinding: nativeRecoveryBinding({ binding, input, source, selection: {}, systemPrompt: '' }) });
  const identity = { ...snapshot, scope, turnId: '1', runId: `native-dsh-${digest({ contract: binding.nativeEngineContract, scope, sessionId: 'session', turn: 1 })}` };
  const kernel = new NativeKernel({ store, digest, owner: 'fixture', ports: { model: { generate: model ?? (async () => ({ kind: 'final_candidate',
    text: 'Original answer', toolCalls: [], usage: emptyUsage() })) }, ...(tools ? { tools } : {}) } });
  kernel.start(identity, config);
  const running = kernel.runUntilIdle(scope, identity.runId);
  if (!active) await running;
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'turn/owner', data: nativeDshOwnership({ identity: Object.fromEntries(['scope', 'runId', 'sessionId', 'turnId', 'buildId', 'parentRunId', 'taskChainId'].map(key => [key, identity[key]])), configuration: config, input, source }) },
    { type: 'user/message', data: input.messages[0] },
    { type: 'assistant/message', data: { message: { id: 'answer', role: 'assistant', content: [{ type: 'text', text: 'Original answer' }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ].map((event, seq) => ({ ...event, seq }));
  if (active) events.splice(3);
  const session = { id: 'session', surface: { nodes: active ? [2] : [2, 3] }, snapshotEvents: () => structuredClone(events), isOwnSeq: () => true,
    append(type, data, options) {
      const seq = events.length; events.push({ type, data: structuredClone(data), ...options, seq });
      session.surface.nodes = session.surface.nodes.filter(node => node < options.surfaceOp.startSeq || node > options.surfaceOp.endSeq).concat(seq);
    } };
  const cancels = [];
  const agent = { id: 'host-agent', session, status: active ? 'running' : 'idle', externalTurns: { pending: () => null },
    cancel(cause) { cancels.push({ cause, commands: structuredClone(store.load(scope, identity.runId).commands) }); },
    async whenIdle() { await running; agent.status = 'idle';
      events.push({ seq: events.length, type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } }); } };
  let liveAgent = agent, durable = true, query = async () => binding, projectRecord = value => value, liveControl;
  if (active) liveControl = { scope, sessionId: 'session', runId: identity.runId, kernel };
  const ctx = { get: name => ({ sessionController: { resolveAgent: async () => ({ agent }) }, agents: { get: () => liveAgent },
    sessionProjections: { stateOf: () => 'preset' }, sessions: { flush: async () => durable } })[name] };
  const service = createStudioNativeConversation({ ctx, store: { sessionHead: (...args) => store.sessionHead(...args),
    load: (...args) => projectRecord(store.load(...args)) }, workspaceId: 'workspace', lifetime,
    agentEvents: () => ({ serial: () => query() }), activeControl: () => liveControl, ...(stopTimeoutMs ? { stopTimeoutMs } : {}) });
  return { service, agent, store, scope, events, config, identity, binding, running, cancels, kernel,
    status: { agentId: 'agent', sessionId: 'session' },
    request: { agentId: 'agent', sessionId: 'session', expectedHeadRunId: identity.runId, expectedGeneration: 0, targetMessageId: 'input', commandId: 'rewind' },
    durability(value) { durable = value; }, onQuery(callback) { query = callback; }, replaceAgent(value) { liveAgent = value; },
    control(value) { liveControl = value; },
    projectRecord(callback) { projectRecord = callback; } };
}

function heldModel() {
  const ready = Promise.withResolvers();
  return { ready: ready.promise, generate: async request => { ready.resolve();
    return new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })); } };
}

async function commandSetup(t, options = {}) {
  let step = 0;
  const h = await setup(t, { ...options,
    configuration: { tools: [tool({ name: 'run_command', readOnly: false, concurrentSafe: false,
      backgroundCommandPolicy: 'owned-command-launch/v1' })] },
    model: async () => ({ kind: ++step === 1 ? 'tool_calls' : 'final_candidate', text: step === 1 ? '' : 'Running',
      usage: emptyUsage(), toolCalls: step === 1 ? [{ callId: 'launch', name: 'run_command', arguments: {} }] : [] }),
    tools: { execute: async request => ({ status: 'ok', content: { backend: 'sandbox/local_process' },
      backgroundCommandRef: { taskId: '1'.repeat(64), sourceRunId: request.runId, operationKey: request.operationKey } }) } });
  const calls = [];
  let maintenance = false;
  h.agent.runMaintenance = async job => {
    assert.equal(maintenance, false); maintenance = true;
    try { return await job(new AbortController().signal); } finally { maintenance = false; }
  };
  h.onQuery(() => ({ ...h.binding, nativeTools: { commandBinding: { backend: 'local_process' },
    conversationCommands: () => ({ contract: 'agentkit.native-conversation-command-control/v1',
      async settle(request) {
        assert.equal(maintenance, true, 'cleanup must run under Host maintenance');
        assert.equal(request.assertCurrent(), true); calls.push(request);
        if (options.settle) return options.settle(request);
        return { contract: 'agentkit.native-conversation-command-control/v1', requestDigest: request.requestDigest,
          retained: [], stopped: request.record.snapshot.backgroundCommands.map(row => ({ ref: row.ref, status: 'canceled' })) };
      } }) } }));
  return { ...h, calls };
}

async function workspaceSetup(t, port = {}) {
  const h = await setup(t), calls = { preview: 0, apply: 0 };
  h.agent.runMaintenance = job => job(new AbortController().signal);
  h.onQuery(() => ({ ...h.binding, nativeTools: { conversationWorkspace: () => ({
    preview(_control, options) { assert.equal(options.assertCurrent(), true); calls.preview++;
      return { contract: 'agentkit.native-conversation-workspace-control/v1', canApply: true, previewToken: 'a'.repeat(64), files: [], unsafeFiles: [] }; },
    apply(control, options) { assert.equal(options.assertCurrent(), true); calls.apply++;
      if (port.fail) throw Error('workspace_publication_failed');
      return { contract: control.contract, requestDigest: control.requestDigest, previewToken: control.workspacePreviewToken,
        checkpointId: null, rewoundCheckpointIds: [], changedPaths: [] }; },
  }) } }));
  return { ...h, calls };
}

test('combined workspace preview is read-only and failed branch persistence retries without reapplying files', async t => {
  const h = await workspaceSetup(t), request = { ...h.request, scope: 'both' }, original = h.store.load(h.scope, h.identity.runId);
  const before = structuredClone(h.events);
  const preview = await h.service.previewWorkspace(request); assert.equal(preview.canApply, true);
  assert.deepEqual(h.events, before); assert.equal(h.calls.apply, 0);
  const apply = { ...request, workspacePreviewToken: preview.previewToken };
  h.durability(false); await assert.rejects(h.service.rewind(apply), { code: 'native_conversation_rewind_not_durable' });
  assert.equal(h.calls.apply, 1); h.durability(true);
  assert.equal((await h.service.rewind(apply)).workspaceCleanup.previewToken, preview.previewToken);
  assert.equal(h.calls.apply, 1); assert.deepEqual(h.store.load(h.scope, h.identity.runId), original);
});

test('failed workspace restoration never publishes the conversation branch', async t => {
  const h = await workspaceSetup(t, { fail: true }), before = structuredClone(h.events);
  await assert.rejects(h.service.rewind({ ...h.request, scope: 'both', workspacePreviewToken: 'a'.repeat(64) }), /workspace_publication_failed/);
  assert.deepEqual(h.events, before);
});

test('command cleanup is maintenance-owned and a failed flush retries the same marker without another stop', async t => {
  const h = await commandSetup(t), original = h.store.load(h.scope, h.identity.runId);
  const status = await h.service.status(h.status); assert.equal(status.canRewind, true); assert.equal(status.requiresStop, true);
  h.durability(false);
  await assert.rejects(h.service.rewind(h.request), { code: 'native_conversation_rewind_not_durable' });
  assert.equal(h.calls.length, 1); assert.deepEqual(h.calls[0].retainedRefs, []);
  assert.equal(h.events.at(-1).data.source.nativeRewind.commandCleanup.stopped.length, 1);
  h.durability(true);
  assert.equal((await h.service.rewind(h.request)).state, 'applied'); assert.equal(h.calls.length, 1);
  assert.deepEqual(h.store.load(h.scope, h.identity.runId), original);
});

test('unknown removed-command outcome never publishes a branch cut', async t => {
  const h = await commandSetup(t, { settle() { throw Error('background_command_outcome_unknown'); } });
  const before = structuredClone(h.events);
  await assert.rejects(h.service.rewind(h.request), /background_command_outcome_unknown/);
  assert.deepEqual(h.events, before); assert.equal(h.service.isRewinding(h.status), false);
});

test('cleanup timeout aborts the backend operation and leaves the conversation intact', async t => {
  let cleanupSignal;
  const h = await commandSetup(t, { stopTimeoutMs: 20,
    settle({ signal }) { cleanupSignal = signal; return new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }); } });
  const before = structuredClone(h.events);
  await assert.rejects(h.service.rewind(h.request));
  assert.equal(cleanupSignal.aborted, true); assert.deepEqual(h.events, before);
});

test('active rewind persists cancel with the real kernel, waits for closure, then commits once', async t => {
  const model = heldModel(), h = await setup(t, { active: true, model: model.generate }); await model.ready;
  const before = h.store.load(h.scope, h.identity.runId);
  assert.equal((await h.service.status(h.status)).requiresStop, true);
  const first = h.service.rewind(h.request), duplicate = h.service.rewind({ ...h.request });
  const result = await first;
  assert.deepEqual(await duplicate, result); assert.equal(h.cancels.length, 1);
  assert.deepEqual(h.cancels[0].cause, { kind: 'user' });
  assert.equal(h.cancels[0].commands.at(-1).command.kind, 'cancel', 'durable before host abort');
  const after = h.store.load(h.scope, h.identity.runId);
  assert.equal(after.snapshot.phase, 'canceled');
  assert.equal(after.receipts[0].status, 'uncertain', 'unknown provider usage remains in the old ledger');
  assert.equal(before.snapshot.phase === 'canceled', false);
  assert.equal(h.events.filter(event => event.data.source?.nativeRewind).length, 1);
  assert.equal(h.events.at(-2).type, 'turn/end', 'closure precedes branch commit');
  assert.deepEqual(await h.service.rewind(h.request), result);
});

test('invalid active targets and stale heads do not cancel the running task', async t => {
  const model = heldModel(), h = await setup(t, { active: true, model: model.generate }); await model.ready;
  for (const [overrides, code] of [[{ targetMessageId: 'missing' }, 'native_conversation_rewind_target_not_active'],
    [{ expectedHeadRunId: 'stale' }, 'native_conversation_rewind_head_conflict']])
    await assert.rejects(h.service.rewind({ ...h.request, ...overrides }), { code });
  assert.equal(h.cancels.length, 0);
  h.kernel.submit(h.scope, h.identity.runId, { commandId: 'cleanup', kind: 'cancel', payload: {} });
  await h.running;
});

test('an active rewind cannot hide unknown tool effects or unfinished tasks', async t => {
  for (const unresolved of ['tool', 'child', 'child-usage', 'background']) {
    const model = heldModel(), h = await setup(t, { active: true, model: model.generate }); await model.ready;
    h.projectRecord(record => {
      if (record.snapshot.phase !== 'canceled') return record;
      if (unresolved === 'tool') return { ...record, intents: [...record.intents, { kind: 'tool', operationKey: 'unknown', status: 'running' }],
        receipts: [...record.receipts, { operationKey: 'unknown', status: 'uncertain', result: {} }] };
      return { ...record, snapshot: { ...record.snapshot, ...(unresolved === 'child' ? { children: [{ state: 'running' }] }
        : unresolved === 'child-usage' ? { childBudgetReservations: [{ settledUsageDigest: null }] }
          : { backgroundCommands: [{ notified: false }] }) } };
    });
    await assert.rejects(h.service.rewind(h.request), { code: 'native_conversation_rewind_stop_unsettled' });
    assert.equal(h.cancels.length, 1); assert.equal(h.events.some(event => event.data.source?.nativeRewind), false);
  }
});

test('foreign controls and an aborted caller cannot interrupt the actual owner', async t => {
  const model = heldModel(), h = await setup(t, { active: true, model: model.generate }); await model.ready;
  const real = { scope: h.scope, sessionId: 'session', runId: h.identity.runId, kernel: h.kernel };
  h.control({ ...real, scope: { ...h.scope, tenantId: 'another' } });
  assert.equal((await h.service.status(h.status)).canRewind, false);
  await assert.rejects(h.service.rewind(h.request), { code: 'studio_native_conversation_rewind_requires_idle' });
  h.control(real);
  const stopped = new AbortController(); stopped.abort(Error('caller left'));
  await assert.rejects(h.service.rewind(h.request, stopped.signal), /caller left/);
  assert.equal(h.cancels.length, 0);
  h.kernel.submit(h.scope, h.identity.runId, { commandId: 'cleanup', kind: 'cancel', payload: {} }); await h.running;
});

test('a changed retained prefix during cancellation never commits a cut', async t => {
  const model = heldModel(), h = await setup(t, { active: true, model: model.generate }); await model.ready;
  const wait = h.agent.whenIdle;
  h.agent.whenIdle = async () => { await wait(); h.events[0].data.turn = 2; };
  await assert.rejects(h.service.rewind(h.request), { code: 'studio_native_conversation_changed' });
  assert.equal(h.events.some(event => event.data.source?.nativeRewind), false);
});

test('canceling a real claimed write keeps its uncertain receipt and refuses the branch cut', async t => {
  const ready = Promise.withResolvers(); let writes = 0;
  const h = await setup(t, { active: true, configuration: { tools: [tool({ name: 'write', readOnly: false, concurrentSafe: false })] },
    model: async () => ({ kind: 'tool_calls', text: '', toolCalls: [{ callId: 'write-call', name: 'write', arguments: {} }], usage: emptyUsage() }),
    tools: { execute: async request => { writes++; ready.resolve();
      return new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })); } } });
  await ready.promise;
  await assert.rejects(h.service.rewind(h.request), { code: 'native_conversation_rewind_stop_unsettled' });
  const ended = h.store.load(h.scope, h.identity.runId);
  assert.equal(ended.snapshot.phase, 'canceled'); assert.equal(ended.receipts.at(-1).status, 'uncertain');
  assert.equal(ended.intents.at(-1).kind, 'tool'); assert.equal(writes, 1);
  assert.equal(h.events.some(event => event.data.source?.nativeRewind), false);
  await assert.rejects(h.service.rewind(h.request), { code: 'studio_native_conversation_rewind_requires_idle' });
  assert.equal(writes, 1, 'retry cannot replay a possibly completed write');
});

test('waiting for host cleanup is bounded; a retry confirms the same canceled run', async t => {
  const model = heldModel(), h = await setup(t, { active: true, model: model.generate, stopTimeoutMs: 20 }); await model.ready;
  const wait = h.agent.whenIdle, hold = setTimeout(() => {}, 200); t.after(() => clearTimeout(hold));
  h.agent.whenIdle = () => new Promise(() => {});
  const pending = h.service.rewind(h.request);
  await assert.rejects(h.service.rewind({ ...h.request, targetMessageId: 'other' }), { code: 'command_replay_conflict' });
  await assert.rejects(h.service.rewind({ ...h.request, commandId: 'other' }), { code: 'native_conversation_rewind_in_progress' });
  await assert.rejects(pending, { name: 'TimeoutError' });
  assert.equal(h.events.some(event => event.data.source?.nativeRewind), false);
  await wait();
  assert.equal((await h.service.rewind(h.request)).state, 'applied'); assert.equal(h.cancels.length, 1);
});

test('a terminal kernel still closing its Host turn is awaited without submitting another cancel', async t => {
  const h = await setup(t), before = h.store.load(h.scope, h.identity.runId);
  let waits = 0;
  h.agent.status = 'running';
  h.control({ scope: h.scope, sessionId: 'session', runId: h.identity.runId, kernel: h.kernel });
  h.agent.whenIdle = async () => { waits++; h.agent.status = 'idle'; };
  assert.equal((await h.service.rewind(h.request)).state, 'applied');
  assert.equal(waits, 1, 'running Host cleanup must still finish even when the kernel is terminal');
  assert.equal(h.cancels.length, 0); assert.deepEqual(h.store.load(h.scope, h.identity.runId), before);
});

test('a durable cancel from a prior unconfirmed attempt still binds the exact rewind request', async t => {
  const model = heldModel(), h = await setup(t, { active: true, model: model.generate, stopTimeoutMs: 20 }); await model.ready;
  const wait = h.agent.whenIdle, hold = setTimeout(() => {}, 200); t.after(() => clearTimeout(hold));
  h.agent.whenIdle = () => new Promise(() => {});
  await assert.rejects(h.service.rewind(h.request), { name: 'TimeoutError' }); await wait();
  h.projectRecord(record => ({ ...record, commands: record.commands.map(row => ({ ...row, command: { ...row.command,
    payload: { ...row.command.payload, nativeConversationRewindRequestDigest: 'another-request' } } })) }));
  await assert.rejects(h.service.rewind(h.request), { code: 'command_replay_conflict' });
  assert.equal(h.events.some(event => event.data.source?.nativeRewind), false);
});

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
