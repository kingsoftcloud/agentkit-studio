import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeKernel, canonical, emptyUsage } from '../packages/agentkit-harness-core/dist/index.mjs';
import { SqliteRunStore } from '../packages/agentkit-harness/src/native/sqlite-store.mjs';
import { createNativeSessionDelivery, nativeDeliveryProjection } from '../packages/agentkit-harness/src/native/session-delivery.mjs';
import { NATIVE_DSH_CONTENT_FORMAT } from '../packages/agentkit-harness/src/native/dsh-turn-contract.mjs';
import { fixture, tool, scope, digest } from '../packages/agentkit-harness-core/test/fixtures.mjs';

// A fault-injectable durable consumer for transport tests; the shipped SDK
// verification separately exercises actual DSH Session validation/persistence.
function consumer(seed = [{ type: 'turn/start', data: { turn: 1 }, seq: 1 }]) {
  const definition = nativeDeliveryProjection();
  let state = definition.init(), events = structuredClone(seed), durable = structuredClone(seed);
  for (const event of events) state = definition.apply(state, event);
  return {
    session: { id: 'session', append(type, data, options) {
      const event = { type, data: structuredClone(data), ...options, seq: events.length + 1 };
      state = definition.apply(state, event); events.push(event);
    } },
    projections: { stateOf: () => state },
    flush: async () => { durable = structuredClone(events); return true; },
    get events() { return events; }, get durable() { return durable; },
  };
}
const source = { provider: 'fixture', model: 'native-model' };
const inputMessages = [{ id: 'user-input', role: 'user', content: [{ type: 'text', text: 'Complete the task' }] }];
const final = () => ({ kind: 'final_candidate', text: 'Delivered', toolCalls: [], usage: { ...emptyUsage(), inputTokens: 3, outputTokens: 4 } });

test('two output retirements preserve original model positions, committed tools and cold delivery deduplication', async t => {
  const f = setup(t, undefined, { outputRecoveryPolicy: 'task-or-delivery/v1', limits: { maxOutputRestarts: 2 },
    profile: { ...fixture().config.profile, maxContinuations: 1, providerReplayMode: 'reasoning_content' } });
  const sink = consumer(); let models = 0, tools = 0;
  const adapter = { input: { prepare: async () => ({ status: 'admitted', messages: [] }) }, model: { generate: async () => {
    models++;
    if (models === 1 || models === 6) return { ...final(), kind: 'tool_calls', text: 'Checking actual state',
      toolCalls: [{ callId: `read-${models}`, name: 'read', arguments: {} }] };
    if (models < 6) return { ...final(), kind: 'output_limit', text: `unfinished ${models}`,
      providerReplay: { compatibilityDigest: 'fixture/v1', reasoning_content: 'private-should-not-be-published' } };
    return final();
  } }, tools: { execute: async () => { tools++; return { status: 'ok', content: `Actual result ${tools}` }; } } };
  const result = await new NativeKernel({ store: f.store, digest, owner: 'output-delivery', ports: adapter,
    onCheckpoint: delivery(f.store, sink) }).runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed'); assert.equal(result.outputRestarts, 2); assert.equal(models, 7); assert.equal(tools, 2);
  assert.equal(sink.events.filter(event => event.type === 'tool/result').length, 2);
  const saved = structuredClone(sink.events);
  f.reopen(); await delivery(f.store, sink)(f.store.load(scope, 'run').snapshot);
  assert.deepEqual(sink.events, saved);
  const coldSink = consumer(); await delivery(f.store, coldSink)(f.store.load(scope, 'run').snapshot);
  assert.deepEqual(coldSink.events, saved);
  assert.equal(coldSink.events.filter(event => event.type === 'assistant/message'
    && event.data.message.content.some(part => part.type === 'text' && part.text === 'Delivered')).length, 1);
  assert.equal(JSON.stringify(f.store.events(scope, 'run').filter(event => event.kind === 'output.restarted')).includes('providerReplay'), false);
  assert.equal(JSON.stringify(coldSink.events).includes('private-should-not-be-published'), false);
});

test('private review usage and source reads survive cold Session delivery without publishing critique or drafts', async t => {
  const f = setup(t, undefined, { deliveryReviewPolicy: { pathSuffixes: ['.ts'] },
    tools: [tool({ name: 'write', readOnly: false, concurrentSafe: false }), tool({ name: 'read', contextRole: 'workspace_read' })],
    limits: { maxModelCalls: 20, maxToolCalls: 20, finalizationReserveModelCalls: 0 } });
  const sink = consumer(), calls = []; let models = 0, writes = 0, seen = 0;
  const data = findings => ({ requirements: [{ requirement: 'PRIVATE_REVIEW_JSON', implementation_evidence: 'ledger.ts', verification_evidence: 'Missing semantics.' }], findings });
  const result = await new NativeKernel({ store: f.store, digest, owner: 'review-delivery', onCheckpoint: delivery(f.store, sink), ports: {
    model: { generate: async (request, emit) => {
      const count = ++models; emit({ kind: 'text', text: request.purpose === 'delivery_review' ? 'PRIVATE_REVIEW_STREAM' : 'provisional' });
      if ([1, 3, 5].includes(count)) return { ...final(), kind: 'tool_calls', text: count === 3 ? 'PRIVATE_REVIEW_SOURCE_PROSE' : '',
        toolCalls: [{ callId: `call-${count}`, name: count === 3 ? 'read' : 'write', arguments: {} }] };
      if ([4, 7].includes(count)) return { ...final(), kind: 'tool_calls', text: '', toolCalls: [{ callId: `submit-${count}`, name: 'submit_delivery_review',
        arguments: data(count === 4 ? [{ issue: 'PRIVATE_REVIEW_FINDING', recommended_check: 'Inspect source and repair.' }] : []) }] };
      return { ...final(), text: count === 2 ? 'Candidate.' : 'Delivered' };
    } }, tools: { execute: async request => { calls.push(request.call.name); if (request.call.name === 'read') return { status: 'ok', content: 'Current source.' };
      writes++; return { status: 'ok', content: 'Written.', workspaceChangedPaths: ['ledger.ts'] }; } },
    workspace: { observe: async () => { const changedPaths = seen !== writes ? ['ledger.ts'] : []; seen = writes;
      return { status: 'ok', revision: `revision-${writes}`, changedPaths }; } },
  } }).runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed'); assert.equal(result.finalText, 'Delivered'); assert.equal(result.outcome, 'unverified');
  assert.deepEqual(calls, ['write', 'read', 'write']); assert.equal(models, 7); assert.equal(result.usage.modelCalls, 7);
  assert.equal(sink.events.filter(event => event.type === 'tool/result').length, 3);
  assert.equal(JSON.stringify(sink.events).includes('PRIVATE_REVIEW'), false);
  const messages = sink.events.filter(event => event.type === 'assistant/message').map(event => event.data);
  assert.equal(messages.filter(message => message.usage).length, 7);
  assert.equal(messages.reduce((sum, message) => sum + (message.usage?.inputTokens ?? 0), 0), 21);
  const saved = structuredClone(sink.events); f.reopen();
  await delivery(f.store, sink)(f.store.load(scope, 'run').snapshot); assert.deepEqual(sink.events, saved);
  const cold = consumer(); await delivery(f.store, cold)(f.store.load(scope, 'run').snapshot); assert.deepEqual(cold.events, saved);
});
test('host-wide delivery projection admits multiple standard DSH attempts within one step', () => {
  const projection = nativeDeliveryProjection();
  let state = projection.init();
  for (let seq = 1; seq <= 2; seq++) state = projection.apply(state, { seq, type: 'assistant/attempt',
    data: { turn: 1, step: 1, stream: [{ type: 'chunk', time: seq,
      chunk: { type: 'text-delta', index: 0, text: `Failed attempt ${seq}` } }] } });
  assert.equal(Object.keys(state.atoms).length, 2);
  assert.equal(projection.stateSchema.parse(state), state);
  assert.throws(() => projection.stateSchema.parse({ ...state, seqs: {} }), { code: 'native_delivery_state_invalid' });
});
function setup(t, options, configuration = {}, turnId = '1') {
  const directory = mkdtempSync(join(tmpdir(), 'native-delivery-')), filename = join(directory, 'run.sqlite');
  let store = new SqliteRunStore(filename, options);
  const value = { get store() { return store; }, reopen() { store.close(); store = new SqliteRunStore(filename); return store; } };
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const { config, snapshot } = fixture({ tools: [tool({ readOnly: false, concurrentSafe: false })], ...configuration });
  store.create(config, { ...snapshot, turnId });
  return value;
}
function delivery(store, sink, overrides = {}) {
  return createNativeSessionDelivery({ store, scope, runId: 'run', session: sink.session, turn: 1,
    projections: sink.projections, flush: sink.flush, systemText: 'Pinned instructions', inputMessages, source, ...overrides });
}
function ports() {
  const calls = { model: 0, write: 0 };
  return { calls, model: { generate: async (_, emit) => {
    const first = ++calls.model === 1;
    emit({ kind: 'text', text: first ? 'Publishing' : 'Delivered' });
    if (first) emit({ kind: 'tool_delta', text: '{}', metadata: { index: 0, callId: 'publish-1', name: 'read' } });
    return first ? { ...final(), kind: 'tool_calls', text: 'Publishing', toolCalls: [{ callId: 'publish-1', name: 'read', arguments: {} }] } : final();
  } },
  tools: { execute: async () => { calls.write++; return { status: 'ok', content: 'Published once' }; } } };
}

test('managed ownership delivers the sealed user/media, tools and usage at an independent SDK turn and deduplicates a lost flush', async t => {
  const messages = [{ id: 'remote-command', role: 'user', source: { kind: 'user', rpcId: 'remote-command' }, content: [
    { type: 'text', text: 'Complete the task' }, { type: 'image', attachment: { attachmentId: 'sealed-image' } },
    { type: 'file', attachment: { attachmentId: 'sealed-file', name: 'original.txt' } },
  ] }];
  const f = setup(t, undefined, { instructions: 'Pinned instructions', hostRecoveryBinding: {
    messages, source, systemPrompt: 'Pinned instructions',
  } }, 'remote-command');
  const record = f.store.load(scope, 'run');
  const identity = Object.fromEntries(['scope', 'runId', 'sessionId', 'turnId', 'buildId', 'parentRunId', 'taskChainId']
    .map(key => [key, record.snapshot[key]]));
  const contract = 'agentkit.native-managed-dsh-turn/v1';
  const managedOwnership = { engine: contract, contract: 'dsh.external-turn/v1', turn: 1,
    binding: canonical({ contract, identity, configDigest: record.snapshot.configDigest }) };
  const sink = consumer(), adapters = ports();
  let failFlush = true;
  const deliver = () => delivery(f.store, sink, { managedOwnership, inputMessages: messages,
    flush: async () => { if (failFlush) throw new Error('Host flush interrupted'); return sink.flush(); } });
  await assert.rejects(deliver()(record.snapshot), /Host flush interrupted/u);
  assert.deepEqual(sink.events.filter(event => event.type === 'user/message').map(event => event.data), messages);
  assert.equal(Object.values(f.store.load(scope, 'run').projections)[0], 0);
  failFlush = false;
  const worker = new NativeKernel({ store: f.store, digest, owner: 'worker', ports: adapters, onCheckpoint: deliver() });
  const result = await worker.runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed');
  assert.equal(sink.events.filter(event => event.type === 'user/message').length, 1);
  assert.equal(sink.events.filter(event => event.type === 'tool/result').length, 1);
  assert.equal(sink.events.filter(event => event.type === 'assistant/message' && event.data.usage).length, 2);
  const durable = structuredClone(sink.durable);
  f.reopen(); await deliver()(f.store.load(scope, 'run').snapshot);
  assert.deepEqual(sink.durable, durable); assert.deepEqual(adapters.calls, { model: 2, write: 1 });
  const before = structuredClone(sink.events);
  await assert.rejects(delivery(f.store, sink, { managedOwnership, inputMessages: [{ ...messages[0], content: [] }] })(result),
    { code: 'native_delivery_managed_admission_invalid' });
  const changed = { ...managedOwnership, binding: canonical({ contract, identity, configDigest: 'f'.repeat(64) }) };
  await assert.rejects(delivery(f.store, sink, { managedOwnership: changed, inputMessages: messages })(result),
    { code: 'native_delivery_managed_admission_invalid' });
  assert.deepEqual(sink.events, before);
});

test('typed Host tool blocks and deferred context replay to Session without JSON envelopes', async t => {
  const { store } = setup(t), sink = consumer(), adapters = ports();
  const toolBlocks = [{ type: 'text', text: 'Visible tool receipt' }], extraBlocks = [{ type: 'text', text: 'Loaded skill instructions' }];
  adapters.tools.execute = async () => ({ status: 'ok', content: { privateReceipt: 'not display text' },
    context: { content: 'Visible tool receipt', presentation: { format: 'agentkit.dsh-content/v1', content: toolBlocks } },
    additionalContexts: [{ content: 'Loaded skill instructions', presentation: { format: 'agentkit.dsh-content/v1',
      content: extraBlocks, source: { kind: 'tool', callId: 'publish-1' } } }] });
  const onCheckpoint = delivery(store, sink), worker = new NativeKernel({ store, digest, owner: 'worker', ports: adapters, onCheckpoint });
  const completed = await worker.runUntilIdle(scope, 'run');
  const receipt = sink.events.find(event => event.type === 'tool/result').data.message;
  assert.deepEqual(receipt.content, toolBlocks);
  const extra = sink.events.find(event => event.type === 'user/message' && event.data.source?.kind === 'tool');
  assert.deepEqual(extra.data.content, extraBlocks); assert.equal(extra.data.source.callId, receipt.toolCallId);
  assert.ok(sink.events.indexOf(extra) > sink.events.findIndex(event => event.type === 'tool/result'));
  assert.equal(JSON.stringify(sink.events).includes('privateReceipt'), false);
  const before = structuredClone(sink.events);
  await onCheckpoint(completed); await worker.runUntilIdle(scope, 'run');
  assert.deepEqual(sink.events, before);
});

test('committed transcript, usage and step boundaries replay without duplicate appends', async t => {
  const { store } = setup(t), sink = consumer(), adapters = ports();
  const onCheckpoint = delivery(store, sink, { source: { ...source, apiKey: 'never-export-this', replayState: { secret: true } } });
  const worker = new NativeKernel({ store, digest, owner: 'worker', ports: adapters, onCheckpoint });
  const result = await worker.runUntilIdle(scope, 'run');
  const before = structuredClone(sink.events);
  await onCheckpoint(result); await worker.runUntilIdle(scope, 'run');
  assert.deepEqual(sink.events, before); assert.equal(adapters.calls.write, 1); assert.equal(adapters.calls.model, 2);
  const types = sink.events.map(event => event.type);
  assert.equal(types.filter(type => type === 'system/message').length, 1);
  assert.equal(types.filter(type => type === 'step/start').length, 2);
  assert.equal(types.filter(type => type === 'step/end').length, 2);
  assert.ok(types.indexOf('tool/result') < types.lastIndexOf('assistant/message'));
  const assistants = sink.events.filter(event => event.type === 'assistant/message');
  assert.deepEqual(assistants.map(event => event.data.usage), [{ inputTokens: 3, outputTokens: 4, totalTokens: 7 }, { inputTokens: 3, outputTokens: 4, totalTokens: 7 }]);
  assert.equal(JSON.stringify(sink.events).includes('never-export-this'), false);
  assert.equal(JSON.stringify(sink.events).includes('replayState'), false);
  assert.equal(Object.values(store.load(scope, 'run').projections)[0], result.eventSeq);
});

test('inclusive cache usage becomes disjoint Session buckets and survives cold delivery exactly once', async t => {
  const f = setup(t), sink = consumer(); let models = 0;
  const worker = new NativeKernel({ store: f.store, digest, owner: 'cache-usage', onCheckpoint: delivery(f.store, sink), ports: {
    model: { generate: async () => {
      models++;
      return { ...final(), usage: { ...emptyUsage(), inputTokens: 19, outputTokens: 5,
        cachedInputTokens: 2, cacheWriteInputTokens: 7, reasoningTokens: 3 }, usageReported: true };
    } },
  } });
  const result = await worker.runUntilIdle(scope, 'run');
  assert.equal(result.usage.inputTokens, 19); assert.equal(result.usage.cacheWriteInputTokens, 7);
  assert.deepEqual(sink.events.filter(event => event.type === 'assistant/message').map(event => event.data.usage), [
    { inputTokens: 10, outputTokens: 5, totalTokens: 24, cacheReadTokens: 2, cacheWriteTokens: 7, reasoningTokens: 3 },
  ]);
  const saved = structuredClone(sink.events); f.reopen();
  assert.equal(f.store.load(scope, 'run').snapshot.usage.cacheWriteInputTokens, 7);
  await delivery(f.store, sink)(f.store.load(scope, 'run').snapshot);
  assert.deepEqual(sink.events, saved);
  const cold = consumer(); await delivery(f.store, cold)(f.store.load(scope, 'run').snapshot);
  assert.deepEqual(cold.events, saved); assert.equal(models, 1);
});

test('Host pre-step sees a durable preceding step end before admitting scoped context', async t => {
  const f = setup(t), sink = consumer(); let models = 0, preparations = 0;
  const adapters = ports();
  const worker = new NativeKernel({ store: f.store, digest, owner: 'input-boundary', onCheckpoint: delivery(f.store, sink), ports: {
    tools: adapters.tools,
    input: { prepare: async () => {
      preparations++;
      const boundary = sink.durable.filter(event => ['step/start', 'step/end'].includes(event.type)).at(-1);
      assert.equal(boundary.type, 'step/end', 'file-touch observers must run before the next model request');
      return { status: 'admitted', messages: preparations === 1 ? [{ content: 'Scoped project rule', retention: 'normal',
        presentation: { format: NATIVE_DSH_CONTENT_FORMAT, content: [{ type: 'text', text: 'Scoped project rule' }],
          source: { kind: 'agent-instructions', form: 'instructions', changes: [] } } }] : [] };
    } },
    model: { generate: async (...args) => {
      models++;
      if (models === 2) assert.ok(args[0].messages.some(message => message.content === 'Scoped project rule'));
      return adapters.model.generate(...args);
    } },
  } });
  const result = await worker.runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed'); assert.equal(models, 2); assert.ok(preparations > 0);
  const rule = sink.events.findIndex(event => event.type === 'user/message' && event.data.source?.kind === 'agent-instructions');
  assert.ok(rule >= 0, 'scoped context retains its instruction source');
  assert.ok(rule > sink.events.findIndex(event => event.type === 'step/end' && event.data.step === 1));
  assert.ok(rule < sink.events.findIndex(event => event.type === 'assistant/message' && event.data.step === 2));
  const saved = structuredClone(sink.events); f.reopen();
  const cold = consumer(); await delivery(f.store, cold)(f.store.load(scope, 'run').snapshot);
  assert.deepEqual(cold.events, saved);
  assert.equal(adapters.calls.write, 1);
});

test('inconsistent provider cache subtypes do not inflate delivered Session totals', async t => {
  const f = setup(t), sink = consumer();
  await new NativeKernel({ store: f.store, digest, owner: 'cache-usage', onCheckpoint: delivery(f.store, sink), ports: {
    model: { generate: async () => ({ ...final(), usage: { ...emptyUsage(), inputTokens: 3, outputTokens: 4,
      cachedInputTokens: 2, cacheWriteInputTokens: 2 } }) },
  } }).runUntilIdle(scope, 'run');
  assert.deepEqual(sink.events.find(event => event.type === 'assistant/message').data.usage,
    { inputTokens: 3, outputTokens: 4, totalTokens: 7 });
  assert.equal(f.store.load(scope, 'run').snapshot.usage.cacheWriteInputTokens, 2,
    'the raw provider counter remains in the Native ledger for diagnosis');
});

test('context summary usage is delivered once without publishing private summary prose', async t => {
  const { store } = setup(t, undefined, { contextPolicy: { tokenizerId: 'fixture', tokenizerDigest: 'fixture/v1', enabled: true,
    triggerRatio: .72, targetRatio: .45, summaryMaxTokens: 80, maxCompactions: null,
    maxCompactionsWithoutProgress: 4, minModelTurnsBetween: 2, maxSummaryRetries: 1 },
  profile: { profileId: 'test', profileVersion: '1', providerFamily: 'fixture', compatibilityDigest: 'fixture/v1',
    contextWindow: 2400, maxOutputTokens: 128 } });
  const sink = consumer(), live = []; let taskModels = 0, summaries = 0;
  const adapters = { model: { generate: async (request, emit) => {
    if (request.messages[0]?.kind === 'compaction_instructions') {
      emit({ kind: 'text', text: 'PRIVATE SUMMARY PROSE' });
      summaries++; return { ...final(), text: 'PRIVATE SUMMARY PROSE', usage: { ...emptyUsage(), inputTokens: 7, outputTokens: 2 } };
    }
    return ++taskModels === 1 ? { ...final(), kind: 'tool_calls', toolCalls: [{ callId: 'call', name: 'read', arguments: {} }] } : final();
  } }, tools: { execute: async () => ({ status: 'ok', content: 'Observed '.repeat(1300) }) },
  context: { tokens: { tokenizerId: 'fixture', tokenizerDigest: 'fixture/v1',
    countRequest: async request => Math.ceil(canonical({ messages: request.messages, tools: request.tools }).length / 4),
    countText: async request => Math.ceil(request.text.length / 4) } } };
  const onCheckpoint = delivery(store, sink);
  const worker = new NativeKernel({ store, digest, owner: 'worker', ports: adapters, onCheckpoint,
    onStream: (_, event) => live.push(event) });
  const result = await worker.runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed'); assert.ok(summaries > 1);
  const assistants = sink.events.filter(event => event.type === 'assistant/message');
  assert.equal(assistants.length, summaries + 2);
  assert.equal(assistants.reduce((total, event) => total + (event.data.usage?.inputTokens ?? 0), 0), result.usage.inputTokens);
  assert.equal(assistants.reduce((total, event) => total + (event.data.usage?.outputTokens ?? 0), 0), result.usage.outputTokens);
  assert.equal(JSON.stringify(sink.events).includes('PRIVATE SUMMARY PROSE'), false);
  assert.equal(JSON.stringify(live).includes('PRIVATE SUMMARY PROSE'), false);
  assert.equal(JSON.stringify(store.load(scope, 'run').receipts.map(receipt => receipt.result.displayStream)).includes('PRIVATE SUMMARY PROSE'), false);
  const before = structuredClone(sink.events); await onCheckpoint(result); await worker.runUntilIdle(scope, 'run');
  assert.deepEqual(sink.events, before);
});

for (const boundary of ['before-flush', 'after-flush-before-ack']) {
  test(`SQLite reopen at ${boundary} replays display and never repeats the committed write`, async t => {
    let rejectAck = boundary === 'after-flush-before-ack', tripped = false;
    const storage = setup(t, { beforeCommit: ({ record }) => {
      if (rejectAck && !tripped && record.events.some(event => event.kind === 'tool.completed')
        && Object.values(record.projections).includes(record.snapshot.eventSeq)) {
        tripped = true; throw Error('Native acknowledgment interrupted');
      }
    } });
    const sink = consumer(), adapters = ports();
    const onCheckpoint = delivery(storage.store, sink, { flush: async session => {
      if (boundary === 'before-flush' && storage.store.events(scope, 'run').some(event => event.kind === 'tool.completed')) {
        tripped = true; throw Error('Session flush interrupted');
      }
      return sink.flush(session);
    } });
    await assert.rejects(new NativeKernel({ store: storage.store, digest, owner: 'before', ports: adapters, onCheckpoint })
      .runUntilIdle(scope, 'run'), /interrupted/);
    assert.equal(tripped, true); assert.equal(adapters.calls.write, 1); assert.equal(adapters.calls.model, 1);
    const beforeStream = sink.events.find(event => event.type === 'assistant/message').data.stream;
    assert.ok(beforeStream.some(record => record.chunk.type === 'tool-call-delta'));
    rejectAck = false;
    const store = storage.reopen(), restored = consumer(sink.durable);
    const result = await new NativeKernel({ store, digest, owner: 'after', ports: adapters,
      onCheckpoint: delivery(store, restored) }).runUntilIdle(scope, 'run');
    assert.equal(result.phase, 'completed'); assert.equal(adapters.calls.write, 1); assert.equal(adapters.calls.model, 2);
    assert.equal(restored.events.filter(event => event.type === 'tool/result').length, 1);
    assert.equal(restored.events.filter(event => event.type === 'assistant/message').length, 2);
    assert.deepEqual(restored.events.find(event => event.type === 'assistant/message').data.stream, beforeStream);
  });
}

test('a non-durable Session cannot acknowledge Native events or dispatch a model', async t => {
  const { store } = setup(t), sink = consumer(), adapters = ports();
  await assert.rejects(new NativeKernel({ store, digest, owner: 'worker', ports: adapters,
    onCheckpoint: delivery(store, sink, { flush: async () => false }) }).runUntilIdle(scope, 'run'), { code: 'native_delivery_not_durable' });
  assert.equal(adapters.calls.model, 0); assert.equal(adapters.calls.write, 0);
  assert.deepEqual(Object.values(store.load(scope, 'run').projections), [0]);
});

test('admission is pinned before appending and cannot be replaced on retry', async t => {
  const { store } = setup(t), sink = consumer(), state = store.load(scope, 'run').snapshot;
  await assert.rejects(delivery(store, sink, { flush: async () => false })(state));
  const before = structuredClone(sink.events);
  await assert.rejects(delivery(store, sink, { inputMessages: [{ ...inputMessages[0], id: 'new-request' }] })(state),
    { code: 'native_delivery_admission_changed' });
  assert.deepEqual(sink.events, before);
});

test('a stalled Session flush is bounded and cannot advance the Native cursor', async t => {
  const { store } = setup(t), sink = consumer();
  await assert.rejects(delivery(store, sink, { flush: () => new Promise(() => {}), flushTimeoutMs: 10 })
    (store.load(scope, 'run').snapshot), { code: 'native_delivery_flush_timeout' });
  assert.deepEqual(Object.values(store.load(scope, 'run').projections), [0]);
});

test('turn changes and unavailable projection state fail before appending', async t => {
  const { store } = setup(t), sink = consumer(), state = store.load(scope, 'run').snapshot;
  const count = sink.events.length;
  await assert.rejects(delivery(store, sink, { projections: { stateOf: () => undefined } })(state), { code: 'native_delivery_projection_missing' });
  await assert.rejects(delivery(store, sink, { turn: 2 })(state), { code: 'native_delivery_identity_mismatch' });
  assert.equal(sink.events.length, count);
});

test('canceling an undispatched tool closes the displayed pair with a definite non-execution result', async t => {
  const { store } = setup(t), sink = consumer(), adapters = ports();
  const deliver = delivery(store, sink);
  let worker;
  worker = new NativeKernel({ store, digest, owner: 'worker', ports: adapters, onCheckpoint: async state => {
    await deliver(state);
    if (state.pendingTools.length && state.pendingIntent) {
      worker.submit(scope, 'run', { commandId: 'cancel-before-tool', kind: 'cancel', payload: {} });
    }
  } });
  const result = await worker.runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'canceled'); assert.equal(adapters.calls.write, 0);
  const output = sink.events.find(event => event.type === 'tool/result');
  assert.equal(output.data.message.isError, true);
  assert.equal(JSON.parse(output.data.message.content[0].text).status, 'not_dispatched');
});

test('an uncertain per-call result in an acknowledged batch retains its actual public evidence on cold delivery', async t => {
  const storage = setup(t);
  const sink = consumer();
  const unknownBlocks = [{ type: 'text', text: 'Remote outcome unknown; reconcile task original-task before retrying.' }];
  const knownBlocks = [{ type: 'text', text: 'The independent operation completed.' }];
  let models = 0, effects = 0;
  const adapters = { model: { generate: async () => {
    models++;
    return { ...final(), kind: 'tool_calls', toolCalls: [
      { callId: models === 1 ? 'known-call' : 'unknown-call', name: 'read', arguments: {} },
    ] };
  } }, tools: { execute: async request => {
    effects++;
    const unknown = request.call.callId === 'unknown-call';
    return { status: unknown ? 'uncertain' : 'ok', content: { privateReceipt: 'not public execution context' },
      context: { content: unknown ? 'Remote outcome unknown' : 'Independent operation completed',
        presentation: { format: 'agentkit.dsh-content/v1', content: unknown ? unknownBlocks : knownBlocks } } };
  } } };
  const deliver = delivery(storage.store, sink);
  const snapshot = await new NativeKernel({ store: storage.store, digest, owner: 'before', ports: adapters, onCheckpoint: deliver })
    .runUntilIdle(scope, 'run');
  assert.equal(snapshot.phase, 'interrupted'); assert.equal(snapshot.reason, 'effect_outcome_unknown');
  const record = storage.store.load(scope, 'run');
  const batch = record.receipts.find(receipt => receipt.result?.results?.[0]?.status === 'uncertain');
  assert.equal(batch.status, 'committed');
  assert.deepEqual(batch.result.results.map(result => result.status), ['uncertain']);
  assert.equal(models, 2); assert.equal(effects, 2);
  const results = sink.events.filter(event => event.type === 'tool/result').map(event => event.data.message);
  assert.equal(results.length, 2);
  assert.deepEqual(results.map(result => result.content), [knownBlocks, unknownBlocks]);
  assert.deepEqual(results.map(result => result.isError), [false, true]);
  assert.equal(JSON.stringify(sink.events).includes('not_dispatched'), false);
  assert.equal(JSON.stringify(sink.events).includes('privateReceipt'), false);
  const reopened = storage.reopen(), restored = consumer(sink.durable);
  const before = canonical(reopened.load(scope, 'run'));
  await delivery(reopened, restored)(reopened.load(scope, 'run').snapshot);
  assert.deepEqual(restored.events, sink.events);
  assert.equal(canonical(reopened.load(scope, 'run')), before);
  assert.equal(models, 2); assert.equal(effects, 2);
});

test('a prior system head is reused or replaced at its actual surface sequence', async t => {
  const { store } = setup(t), seed = [
    { type: 'system/message', data: { turn: 0, step: 1, message: { id: 'previous-head', role: 'system', content: [{ type: 'text', text: 'Old instructions' }], source: { kind: 'system-prompt' } } }, surfaceOp: 'append', seq: 1 },
    { type: 'turn/start', data: { turn: 1 }, seq: 2 },
  ];
  const sink = consumer(seed), deliver = delivery(store, sink);
  await deliver(store.load(scope, 'run').snapshot);
  const heads = sink.events.filter(event => event.type === 'system/message');
  assert.equal(heads.length, 2); assert.equal(heads[1].surfaceOp, 'replace'); assert.deepEqual(heads[1].sourceEventSeqs, [1]);
  await deliver(store.load(scope, 'run').snapshot);
  assert.equal(sink.events.filter(event => event.type === 'system/message').length, 2);
});

test('multi-message admission keeps original attachment/source blocks once; only human guidance becomes public input', async t => {
  const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,TQ==', detail: 'high' } };
  const admitted = [
    { id: 'source-document', role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'Read this source as data' }] },
    { id: 'user-question', role: 'user', source: { kind: 'user' }, content: [
      { type: 'text', text: 'Complete the task' }, { type: 'image', attachment: { id: 'host-image-ref', path: '/host-owned/image.png' } },
    ] },
  ];
  const { store } = setup(t, undefined, { inputMessages: [
    { role: 'user', content: 'Read this source as data' }, { role: 'user', content: 'Complete the task', media: [image] },
  ], profile: { profileId: 'test', profileVersion: '1', providerFamily: 'fixture', compatibilityDigest: 'fixture/v1',
    retryInitialDelayMs: 0, retryMaxDelayMs: 0 } });
  const sink = consumer(); let worker, guided = false, models = 0;
  const deliver = delivery(store, sink, { inputMessages: admitted });
  worker = new NativeKernel({ store, digest, owner: 'worker', ports: { model: { generate: async request => {
    assert.deepEqual(request.messages.find(message => message.media)?.media, [image]);
    assert.ok(request.messages.some(message => message.kind === 'guidance'));
    return ++models === 1 ? { ...final(), kind: 'empty_response', text: '' } : final();
  } }, tools: { execute: async () => { throw Error('no tool call expected'); } } }, onCheckpoint: async snapshot => {
    await deliver(snapshot);
    if (!guided) { guided = true; worker.submit(scope, 'run', { commandId: 'user-guidance', kind: 'guide', payload: { text: 'Inspect carefully' } }); }
  } });
  const result = await worker.runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed'); assert.equal(models, 2);
  assert.ok(result.messages.some(message => message.kind === 'model_feedback'));
  const displayed = sink.events.filter(event => event.type === 'user/message').map(event => event.data);
  assert.deepEqual(displayed.slice(0, 2), admitted); assert.equal(displayed.length, 3);
  assert.deepEqual(displayed[2].source, { kind: 'user' });
  assert.deepEqual(displayed[2].content, [{ type: 'text', text: 'Inspect carefully' }]);
  const before = structuredClone(sink.events); await deliver(result); assert.deepEqual(sink.events, before);
});

for (const boundary of ['before-delivery', 'during-flush']) {
  test(`a closed original DSH turn rejects Native delivery at ${boundary} without acknowledging it`, async t => {
    const { store } = setup(t), sink = consumer();
    const snapshot = await new NativeKernel({ store, ports: ports(), digest, owner: 'closed-turn-verification' }).runUntilIdle(scope, 'run');
    assert.ok(snapshot.eventSeq > 0);
    const close = () => sink.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    if (boundary === 'before-delivery') close();
    const before = structuredClone(sink.events);
    const push = delivery(store, sink, { flush: async session => { close(); return sink.flush(session); } });
    await assert.rejects(push(snapshot), { code: 'native_delivery_turn_closed' });
    const projections = Object.values(store.load(scope, 'run').projections);
    assert.ok(projections.every(cursor => cursor === 0));
    if (boundary === 'before-delivery') { assert.deepEqual(sink.events, before); assert.equal(projections.length, 0); }
    assert.equal(sink.projections.stateOf().openTurn, false);
  });
}
