import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeKernel, emptyUsage } from '../packages/agentkit-harness-core/dist/index.mjs';
import { SqliteRunStore } from '../packages/agentkit-harness/src/native/sqlite-store.mjs';
import { createNativeSessionDelivery, nativeDeliveryProjection } from '../packages/agentkit-harness/src/native/session-delivery.mjs';
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
function setup(t, options) {
  const directory = mkdtempSync(join(tmpdir(), 'native-delivery-')), filename = join(directory, 'run.sqlite');
  let store = new SqliteRunStore(filename, options);
  const value = { get store() { return store; }, reopen() { store.close(); store = new SqliteRunStore(filename); return store; } };
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const { config, snapshot } = fixture({ tools: [tool({ readOnly: false, concurrentSafe: false })] });
  store.create(config, { ...snapshot, turnId: '1' });
  return value;
}
function delivery(store, sink, overrides = {}) {
  return createNativeSessionDelivery({ store, scope, runId: 'run', session: sink.session, turn: 1,
    projections: sink.projections, flush: sink.flush, systemText: 'Pinned instructions', inputMessages, source, ...overrides });
}
function ports() {
  const calls = { model: 0, write: 0 };
  return { calls, model: { generate: async () => ++calls.model === 1
    ? { ...final(), kind: 'tool_calls', text: 'Publishing', toolCalls: [{ callId: 'publish-1', name: 'read', arguments: {} }] } : final() },
  tools: { execute: async () => { calls.write++; return { status: 'ok', content: 'Published once' }; } } };
}

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
  assert.deepEqual(assistants.map(event => event.data.usage), [{ inputTokens: 3, outputTokens: 4 }, { inputTokens: 3, outputTokens: 4 }]);
  assert.equal(JSON.stringify(sink.events).includes('never-export-this'), false);
  assert.equal(JSON.stringify(sink.events).includes('replayState'), false);
  assert.equal(Object.values(store.load(scope, 'run').projections)[0], result.eventSeq);
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
    rejectAck = false;
    const store = storage.reopen(), restored = consumer(sink.durable);
    const result = await new NativeKernel({ store, digest, owner: 'after', ports: adapters,
      onCheckpoint: delivery(store, restored) }).runUntilIdle(scope, 'run');
    assert.equal(result.phase, 'completed'); assert.equal(adapters.calls.write, 1); assert.equal(adapters.calls.model, 2);
    assert.equal(restored.events.filter(event => event.type === 'tool/result').length, 1);
    assert.equal(restored.events.filter(event => event.type === 'assistant/message').length, 2);
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
