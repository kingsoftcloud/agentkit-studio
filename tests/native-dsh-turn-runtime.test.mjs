import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryRunStore, NativeKernel, prepareEffect, emptyUsage } from '../packages/agentkit-harness-core/dist/index.mjs';
import { fixture, scope, tool, digest } from '../packages/agentkit-harness-core/test/fixtures.mjs';
import { SqliteRunStore } from '../packages/agentkit-harness/src/native/sqlite-store.mjs';
import { createNativeDshTurnExecutor } from '../packages/agentkit-harness/src/native/dsh-turn-runtime.mjs';
import { nativeDeliveryProjection } from '../packages/agentkit-harness/src/native/session-delivery.mjs';

// An actual projection fold with an injectable durable flush. The shipped-SDK
// verification separately checks the public Session and JSONL persistence.
function consumer() {
  const projection = nativeDeliveryProjection();
  let state = projection.init();
  const events = [];
  const session = { id: 'session', append(type, data, options) {
    const event = { type, data: structuredClone(data), ...options, seq: events.length + 1 };
    state = projection.apply(state, event); events.push(event);
  } };
  session.append('turn/start', { turn: 1 });
  return { session, events, projections: { stateOf: () => state }, flush: async () => true };
}
const final = () => ({ kind: 'final_candidate', text: 'Done', toolCalls: [], usage: emptyUsage() });
const call = () => ({ ...final(), kind: 'tool_calls', toolCalls: [{ callId: 'write-1', name: 'write', arguments: {} }] });
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };
function setup(t, sqlite, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'native-dsh-driver-'));
  const store = sqlite ? new SqliteRunStore(join(directory, 'runs.sqlite')) : new MemoryRunStore();
  t.after(() => { store.close?.(); rmSync(directory, { recursive: true, force: true }); });
  const sink = consumer(), controller = new AbortController();
  const input = [{ role: 'user', content: 'Complete the task' }];
  const configuration = fixture({ tools: [tool({ name: 'write', readOnly: false, concurrentSafe: false })], inputMessages: input }).config;
  const calls = { model: 0, write: 0 };
  const binding = { scope, configuration, buildId: 'build', source: { provider: 'fixture', model: 'pinned' }, ports: {
    model: { generate: async () => ++calls.model === 1 ? call() : final() },
    tools: { execute: async () => { calls.write++; return { status: 'ok', content: 'Written' }; } },
  } };
  const payload = { agent: { id: scope.agentId, session: sink.session }, input: { kind: 'enter',
    messages: [{ id: 'input-1', role: 'user', content: [{ type: 'text', text: 'Complete the task' }] }], assembly: {} },
  turn: 1, signal: controller.signal };
  const execute = createNativeDshTurnExecutor({ store, ...sink, resolveTurn: async () => binding, ...overrides });
  const head = () => store.sessionHead(scope, 'session');
  return { store, binding, calls, sink, controller, payload, execute, head };
}
for (const sqlite of [false, true]) {
  const kind = sqlite ? 'SQLite' : 'memory';
  test(`${kind}: full Native turn and same-turn replay do not repeat tools or Session atoms`, async t => {
    const host = setup(t, sqlite);
    assert.deepEqual(await host.execute(host.payload), { reason: { kind: 'completed' } });
    const events = structuredClone(host.sink.events), completed = host.head();
    assert.equal(completed.phase, 'completed'); assert.deepEqual(host.calls, { model: 2, write: 1 });
    assert.deepEqual(await host.execute(host.payload), { reason: { kind: 'completed' } });
    assert.deepEqual(host.sink.events, events); assert.deepEqual(host.calls, { model: 2, write: 1 });
    host.sink.session.append('turn/start', { turn: 2 });
    host.payload.turn = 2; host.payload.input.messages[0].id = 'input-2';
    await host.execute(host.payload);
    assert.equal(host.head().parentRunId, completed.runId);
    assert.ok(host.head().messages.some(message => message.history?.sourceRunId === completed.runId));
  });
  test(`${kind}: approval resumes only with the matching persisted interaction`, async t => {
    let host, observed;
    host = setup(t, sqlite, { onIdle: async (_, snapshot) => {
      observed = structuredClone(snapshot);
      snapshot.goal = 'must not mutate stored state';
      return { commandId: 'allow-1', kind: 'submit_interaction', payload: {
        interactionId: snapshot.pendingInteraction.interactionId, decision: 'allow' } };
    } });
    host.binding.ports.tools.execute = async request => {
      if (!request.interaction) return { status: 'approval_required', content: null, interactionId: 'host-approval' };
      assert.equal(request.interaction.decision, 'allow'); host.calls.write++; return { status: 'ok', content: 'Written' };
    };
    await host.execute(host.payload);
    assert.equal(observed.phase, 'awaiting_interaction'); assert.equal(host.head().goal, 'Complete the task');
    assert.deepEqual(host.calls, { model: 2, write: 1 });
    assert.equal(host.store.events(scope, host.head().runId).filter(event => event.kind === 'approval.resolved').length, 1);
  });
  test(`${kind}: cancellation during a stalled approval is durable and late approval cannot execute`, async t => {
    const entered = gate(), late = gate();
    const host = setup(t, sqlite, { onIdle: async (_, snapshot) => {
      entered.resolve(); await late.promise;
      return { commandId: 'late-allow', kind: 'submit_interaction', payload: { interactionId: snapshot.pendingInteraction.interactionId, decision: 'allow' } };
    } });
    host.binding.ports.tools.execute = async request => {
      if (!request.interaction) return { status: 'approval_required', content: null, interactionId: 'host-approval' };
      host.calls.write++; return { status: 'ok', content: 'Must never run' };
    };
    const running = host.execute(host.payload); await entered.promise;
    const error = new Error('user canceled approval'); host.controller.abort(error);
    await assert.rejects(running, value => value === error);
    assert.equal(host.head().phase, 'canceled'); assert.deepEqual(host.calls, { model: 1, write: 0 });
    late.resolve(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(host.head().phase, 'canceled'); assert.deepEqual(host.calls, { model: 1, write: 0 });
    assert.equal(host.store.load(scope, host.head().runId).commands.some(row => row.command.commandId === 'late-allow'), false);
  });
  test(`${kind}: failed delivery dispatches nothing and the same turn can recover`, async t => {
    let durable = false;
    const host = setup(t, sqlite, { flush: async () => durable });
    await assert.rejects(host.execute(host.payload), { code: 'native_delivery_not_durable' });
    assert.deepEqual(host.calls, { model: 0, write: 0 });
    const runId = host.head().runId; durable = true;
    await host.execute(host.payload);
    assert.equal(host.head().runId, runId); assert.deepEqual(host.calls, { model: 2, write: 1 });
  });
  test(`${kind}: a host failure after committed write resumes without repeating the effect`, async t => {
    let fail = true;
    const host = setup(t, sqlite, { onCheckpoint: async (_, snapshot) => {
      if (fail && snapshot.messages.some(message => message.role === 'tool')) {
        fail = false; throw Error('host interrupted after write');
      }
    } });
    await assert.rejects(host.execute(host.payload), /host interrupted after write/);
    assert.deepEqual(host.calls, { model: 1, write: 1 });
    await host.execute(host.payload);
    assert.deepEqual(host.calls, { model: 2, write: 1 });
    assert.equal(host.sink.events.filter(event => event.type === 'tool/result').length, 1);
  });
  test(`${kind}: cancel during an uncooperative write records uncertainty and cannot repeat it`, async t => {
    const written = gate(), late = gate();
    const host = setup(t, sqlite);
    host.binding.ports.tools.execute = async () => {
      host.calls.write++; written.resolve(); await late.promise;
      return { status: 'ok', content: 'Late write receipt' };
    };
    const running = host.execute(host.payload); await written.promise;
    host.controller.abort(new Error('cancel in-flight write'));
    await assert.rejects(running, /cancel in-flight write/);
    assert.equal(host.head().phase, 'canceled');
    const record = host.store.load(scope, host.head().runId);
    assert.ok(record.receipts.some(receipt => receipt.status === 'uncertain'));
    const before = structuredClone(host.sink.events);
    late.resolve(); await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(host.execute({ ...host.payload, signal: new AbortController().signal }), { code: 'NATIVE_TURN_CANCELED' });
    assert.deepEqual(host.calls, { model: 1, write: 1 }); assert.deepEqual(host.sink.events, before);
    await assert.rejects(host.execute({ ...host.payload, turn: 2, signal: new AbortController().signal }),
      { code: 'NATIVE_RUN_RECOVERY_REQUIRED', nativeRunId: record.snapshot.runId });
    assert.deepEqual(host.calls, { model: 1, write: 1 });
  });
  test(`${kind}: an interrupted write must be reconciled before a new DSH turn`, async t => {
    const host = setup(t, sqlite);
    host.binding.ports.tools.execute = async () => {
      host.calls.write++; return { status: 'uncertain', content: 'Write acknowledgment lost' };
    };
    await assert.rejects(host.execute(host.payload), { code: 'NATIVE_TURN_FAILED', nativePhase: 'interrupted' });
    const head = host.head();
    await assert.rejects(host.execute({ ...host.payload, turn: 2 }),
      { code: 'NATIVE_RUN_RECOVERY_REQUIRED', nativeRunId: head.runId });
    assert.deepEqual(host.calls, { model: 1, write: 1 });
  });
  test(`${kind}: canceling a stalled host checkpoint persists cancellation before any model`, async t => {
    const entered = gate(), late = gate();
    const host = setup(t, sqlite, { onCheckpoint: async () => { entered.resolve(); await late.promise; } });
    const running = host.execute(host.payload); await entered.promise;
    host.controller.abort(new Error('cancel checkpoint'));
    await assert.rejects(running, /cancel checkpoint/);
    assert.equal(host.head().phase, 'canceled'); assert.deepEqual(host.calls, { model: 0, write: 0 });
    late.resolve();
  });
  test(`${kind}: a different DSH turn cannot silently replace an unfinished Native run`, async t => {
    const host = setup(t, sqlite);
    host.binding.ports.tools.execute = async () => ({ status: 'approval_required', content: null, interactionId: 'host-approval' });
    await assert.rejects(host.execute(host.payload), { code: 'NATIVE_TURN_SUSPENDED' });
    const head = host.head();
    host.payload.turn = 2; host.sink.session.append('turn/start', { turn: 2 });
    await assert.rejects(host.execute(host.payload), { code: 'NATIVE_RUN_RECOVERY_REQUIRED', nativeRunId: head.runId });
    assert.equal(host.head().runId, head.runId); assert.equal(host.calls.model, 1);
  });
  test(`${kind}: a completed safe-read recovery permits the next DSH turn without repeating the read`, async t => {
    const host = setup(t, sqlite), recovered = fixture({ tools: [tool({ recoveryPolicy: 'safe-read/v1' })] });
    host.store.create(recovered.config, recovered.snapshot);
    const lease = host.store.acquire(scope, 'run', 'lost-reader', 1, 1);
    const read = { callId: 'read', name: 'read', arguments: {} };
    const prepared = prepareEffect(recovered.snapshot, 'tool', 'executing_tools', { calls: [read], interaction: null }, {
      pendingTools: [read], messages: [...recovered.snapshot.messages, { role: 'assistant', content: '', toolCalls: [read] }],
    });
    host.store.commit(scope, 'run', lease, 1, 0, prepared);
    host.store.claim(scope, 'run', lease, 1, prepared.snapshot.pendingIntent);
    let reads = 0;
    const worker = new NativeKernel({ store: host.store, owner: 'replacement', digest, now: () => 100,
      ports: { model: { generate: async () => final() }, tools: { execute: async () => { reads++; return { status: 'ok', content: 'Read safely' }; } } } });
    const completed = await worker.runUntilIdle(scope, 'run');
    assert.equal(completed.phase, 'completed'); assert.equal(completed.recoveryRetriesUsed, 1);
    assert.equal(host.store.load(scope, 'run').receipts[0].status, 'uncertain');
    host.binding.ports.model.generate = async () => { host.calls.model++; return final(); };
    host.sink.session.append('turn/start', { turn: 2 });
    await host.execute({ ...host.payload, turn: 2 });
    assert.equal(reads, 1); assert.equal(host.head().parentRunId, 'run');
    assert.deepEqual(host.calls, { model: 1, write: 0 });
  });
  test(`${kind}: repeating an already consumed interaction cannot spin indefinitely`, async t => {
    let prompts = 0;
    const host = setup(t, sqlite, { onIdle: async () => {
      prompts++; return { commandId: 'stale-approval', kind: 'submit_interaction', payload: { interactionId: 'wrong-id', decision: 'allow' } };
    } });
    host.binding.ports.tools.execute = async () => ({ status: 'approval_required', content: null, interactionId: 'host-approval' });
    await assert.rejects(host.execute(host.payload), { code: 'native_dsh_command_made_no_progress' });
    assert.equal(prompts, 2); assert.equal(host.head().phase, 'awaiting_interaction');
    assert.deepEqual(host.calls, { model: 1, write: 0 });
  });
  test(`${kind}: concurrent advancement and changed admission cannot repeat a write`, async t => {
    const entered = gate(), release = gate();
    const host = setup(t, sqlite);
    host.binding.ports.model.generate = async () => {
      if (++host.calls.model === 1) { entered.resolve(); await release.promise; return call(); }
      return final();
    };
    const running = host.execute(host.payload); await entered.promise;
    await assert.rejects(host.execute(host.payload), { code: 'native_dsh_session_already_driving' });
    release.resolve(); await running;
    host.payload.input.messages[0].content[0].text = 'Different admitted user task';
    await assert.rejects(host.execute(host.payload), { code: 'run_creation_conflict' });
    assert.deepEqual(host.calls, { model: 2, write: 1 });
  });
}
test('unrelated turns delegate; pre-aborted and late lookups cannot create a run', async t => {
  const host = setup(t, false); let lookups = 0;
  const execute = createNativeDshTurnExecutor({ store: host.store, ...host.sink, resolveTurn: async () => { lookups++; return null; } });
  assert.equal(await execute(host.payload), undefined); assert.equal(host.head(), null);
  host.controller.abort(new Error('canceled before lookup'));
  await assert.rejects(execute(host.payload), /canceled before lookup/); assert.equal(lookups, 1);
  const entered = gate(), late = gate(), controller = new AbortController();
  const lateExecute = createNativeDshTurnExecutor({ store: host.store, ...host.sink, resolveTurn: async () => {
    entered.resolve(); await late.promise; return host.binding;
  } });
  const running = lateExecute({ ...host.payload, signal: controller.signal }); await entered.promise;
  controller.abort(new Error('canceled during lookup')); await assert.rejects(running, /canceled during lookup/);
  late.resolve(); await new Promise(resolve => setImmediate(resolve)); assert.equal(host.head(), null);
});
test('whole-turn binding must explicitly provide the admitted Native messages', async t => {
  const host = setup(t, false); delete host.binding.configuration.inputMessages;
  await assert.rejects(host.execute(host.payload), { code: 'native_dsh_turn_binding_invalid' });
  assert.equal(host.head(), null); assert.deepEqual(host.calls, { model: 0, write: 0 });
});
