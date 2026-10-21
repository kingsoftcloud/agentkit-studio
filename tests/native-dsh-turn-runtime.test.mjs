import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryRunStore, NativeKernel, prepareEffect, emptyUsage } from '../packages/agentkit-harness-core/dist/index.mjs';
import { acceptance, fixture, scope, tool, digest } from '../packages/agentkit-harness-core/test/fixtures.mjs';
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
// This adapter accepts a trusted Host factory without depending on Studio's
// product compiler. Product contract compilation is covered by its own tests.
const taskContractFor = ({ sessionId, parentRunId, goal }) => ({ objective: goal,
  revision: digest({ sessionId, parentRunId, goal }), acceptance: [acceptance()] });
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
  const backend = sqlite ? 'SQLite' : 'memory';
  test(`${backend}: adding a recovery locator cannot rewrite an older same-turn Run or authorize configuration drift`, async t => {
    const host = setup(t, sqlite);
    await host.execute(host.payload);
    const original = host.store.load(scope, host.head().runId), calls = structuredClone(host.calls);
    host.binding.configuration.hostRecoveryBinding = { contract: 'host-locator/v1', revision: 1 };
    await host.execute(host.payload);
    assert.deepEqual(host.store.load(scope, host.head().runId).configuration, original.configuration);
    assert.deepEqual(host.calls, calls); assert.equal(host.store.list(scope).length, 1);
    host.binding.configuration.instructions += '\nChanged execution policy';
    await assert.rejects(host.execute(host.payload), /run_creation_conflict/);
    assert.deepEqual(host.store.load(scope, host.head().runId).configuration, original.configuration);
    assert.deepEqual(host.calls, calls);
  });
  test(`${backend}: an existing recovery binding cannot be replaced on same-turn redelivery`, async t => {
    const host = setup(t, sqlite);
    host.binding.configuration.hostRecoveryBinding = { contract: 'host-locator/v1', revision: 1 };
    await host.execute(host.payload);
    const original = host.store.load(scope, host.head().runId), calls = structuredClone(host.calls);
    host.binding.configuration.hostRecoveryBinding.revision = 2;
    await assert.rejects(host.execute(host.payload), /run_creation_conflict/);
    assert.deepEqual(host.store.load(scope, host.head().runId).configuration, original.configuration);
    assert.deepEqual(host.calls, calls);
  });
  test(`${backend}: goal contracts pin parent facts without recompiling a superseded turn against a later parent`, async t => {
    const host = setup(t, sqlite), facts = [], firstConfig = structuredClone(host.binding.configuration);
    host.binding.taskContractFactory = input => {
      facts.push(structuredClone({ ...input, signal: null }));
      if (input.parentContract) input.parentContract.acceptance.push({ id: 'mutated-host-copy' });
      return taskContractFor(input);
    };
    await host.execute(host.payload); const first = host.head(), firstStored = host.store.load(scope, first.runId);
    host.sink.session.append('turn/start', { turn: 2 });
    await host.execute({ ...host.payload, turn: 2 }); const second = host.head();
    assert.equal(facts[0].parentRunId, null); assert.equal(facts[1].parentRunId, first.runId);
    assert.equal(facts[1].parentGoal, first.goal);
    assert.equal(host.store.load(scope, first.runId).configuration.contract.acceptance.length, 1);
    assert.equal(host.store.load(scope, second.runId).configuration.contract.revision,
      taskContractFor({ sessionId: 'session', parentRunId: first.runId, goal: first.goal }).revision);
    assert.equal(host.store.load(scope, second.runId).snapshot.parentRunId, first.runId);
    assert.notEqual(firstStored.configuration.contract.revision, host.store.load(scope, second.runId).configuration.contract.revision);
    const calls = structuredClone(host.calls);
    host.binding.configuration = firstConfig;
    await assert.rejects(host.execute(host.payload), /native_delivery_run_superseded/);
    assert.deepEqual(host.calls, calls); assert.equal(facts.at(-1).parentRunId, null);
    assert.equal(host.head().runId, second.runId);
  });
  test(`${backend}: asynchronous contract compilation cannot attach a new goal to a changed session head`, async t => {
    const host = setup(t, sqlite), entered = gate(), release = gate();
    host.binding.taskContractFactory = async input => { entered.resolve(); await release.promise; return taskContractFor(input); };
    const first = host.execute(host.payload);
    await entered.promise;
    const other = createNativeDshTurnExecutor({ store: host.store, ...host.sink,
      resolveTurn: async () => ({ ...host.binding, taskContractFactory: undefined }) });
    host.sink.session.append('turn/start', { turn: 2 });
    await other({ ...host.payload, turn: 2 }); const winner = host.head().runId;
    const calls = structuredClone(host.calls);
    release.resolve(); await assert.rejects(first, /session_head_conflict/);
    assert.equal(host.head().runId, winner); assert.deepEqual(host.calls, calls);
    assert.equal(host.store.list(scope).length, 1);
  });
  test(`${backend}: canceled or invalid contract compilation cannot create a Run`, async t => {
    const host = setup(t, sqlite), entered = gate(), release = gate();
    host.binding.taskContractFactory = async input => { entered.resolve(); await release.promise; return taskContractFor(input); };
    const execution = host.execute(host.payload);
    await entered.promise; host.controller.abort(new Error('canceled contract compilation'));
    await assert.rejects(execution, /canceled contract compilation/); release.resolve();
    assert.equal(host.head(), null); assert.equal(host.calls.model, 0);
    const invalid = setup(t, sqlite); invalid.binding.taskContractFactory = () => null;
    await assert.rejects(invalid.execute(invalid.payload), /native_dsh_task_contract_invalid/);
    assert.equal(invalid.head(), null); assert.equal(invalid.calls.model, 0);
  });
}
for (const sqlite of [false, true]) {
  const kind = sqlite ? 'SQLite' : 'memory';
  test(`${kind}: public frames precede completion and settle to the exact durable stream`, async t => {
    const frames = [], entered = gate(), finish = gate();
    const host = setup(t, sqlite, { publishStreamFrame: (_, frame) => frames.push(frame) });
    host.binding.ports.model.generate = async (_, emit) => {
      host.calls.model++;
      emit({ kind: 'thinking', text: 'Checking' }); emit({ kind: 'text', text: 'Live ' });
      entered.resolve(); await finish.promise;
      emit({ kind: 'text', text: 'result' }); return { ...final(), text: 'Live result' };
    };
    const running = host.execute(host.payload); await entered.promise;
    assert.equal(frames[0].type, 'start'); assert.equal(frames[0].step, 1);
    assert.equal(frames.some(frame => frame.type === 'end'), false);
    assert.equal(host.sink.events.some(event => event.type === 'assistant/message'), false);
    finish.resolve(); await running;
    const chunks = frames.filter(frame => frame.type === 'chunk'), end = frames.at(-1);
    assert.deepEqual(chunks.map(frame => frame.index), chunks.map((_, i) => i));
    const committed = host.sink.events.find(event => event.seq === end.outcome.seq);
    assert.equal(end.outcome.eventType, 'assistant/message'); assert.equal(end.outcome.kind, 'committed');
    assert.equal(end.index, chunks.length);
    assert.deepEqual(committed.data.stream, chunks.map(({ time, chunk }) => ({ type: 'chunk', time, chunk })));
    const before = structuredClone(frames); await host.execute(host.payload); assert.deepEqual(frames, before);
    assert.equal(host.calls.model, 1);
    host.sink.session.append('turn/start', { turn: 2 });
    await host.execute({ ...host.payload, turn: 2 });
    assert.deepEqual(frames.filter(frame => frame.type === 'start').map(frame => frame.revision), [1, 2]);
  });
  test(`${kind}: failed streamed tool fragments settle as an attempt and never dispatch`, async t => {
    const frames = [];
    const host = setup(t, sqlite, { publishStreamFrame: (_, frame) => frames.push(frame) });
    host.binding.configuration.profile.retryInitialDelayMs = 0;
    host.binding.ports.model.generate = async (_, emit) => {
      if (++host.calls.model === 1) {
        emit({ kind: 'tool_delta', text: '{"path":', metadata: { index: 0, name: 'write', callId: 'incomplete-provider-id' } });
        return { ...final(), kind: 'provider_retryable_error', text: 'Unsealed private prefix', usageReported: false };
      }
      emit({ kind: 'text', text: 'Recovered' }); return { ...final(), text: 'Recovered' };
    };
    await host.execute(host.payload);
    assert.equal(host.calls.write, 0); assert.equal(host.sink.events.some(event => event.type === 'tool/call'), false);
    const ends = frames.filter(frame => frame.type === 'end');
    assert.deepEqual(ends.map(frame => frame.outcome.eventType), ['assistant/attempt', 'assistant/message']);
    assert.equal(host.sink.events.find(event => event.seq === ends[0].outcome.seq).type, 'assistant/attempt');
    assert.deepEqual(frames.filter(frame => frame.type === 'start').map(frame => frame.step), [1, 2]);
    assert.equal(JSON.stringify(host.sink.events).includes('Unsealed private prefix'), false);
  });
  test(`${kind}: cancel closes a durable prefix and fences late streamed callbacks`, async t => {
    const frames = [], entered = gate(); let lateEmit;
    const host = setup(t, sqlite, { publishStreamFrame: (_, frame) => frames.push(frame) });
    host.binding.ports.model.generate = async (_, emit) => {
      lateEmit = emit; emit({ kind: 'text', text: 'Before cancellation' }); entered.resolve(); await new Promise(() => {});
    };
    const running = host.execute(host.payload); await entered.promise;
    host.controller.abort(Error('cancel live stream')); await assert.rejects(running, /cancel live stream/);
    assert.equal(host.head().phase, 'canceled');
    assert.equal(frames.at(-1).outcome.eventType, 'assistant/attempt');
    assert.equal(frames.at(-1).outcome.kind, 'committed');
    const count = frames.length; lateEmit({ kind: 'text', text: 'late' }); assert.equal(frames.length, count);
  });
  test(`${kind}: failed durable flush abandons live frames and replay delivers once without another model`, async t => {
    const frames = []; let failFlush = true, host;
    host = setup(t, sqlite, { publishStreamFrame: (_, frame) => frames.push(frame), flush: async () => {
      if (failFlush && host.sink.events.some(event => event.type === 'assistant/message')) throw Error('stream flush failed');
      return true;
    } });
    host.binding.ports.model.generate = async (_, emit) => { host.calls.model++; emit({ kind: 'text', text: 'Committed' }); return final(); };
    await assert.rejects(host.execute(host.payload), /stream flush failed/);
    assert.equal(frames.at(-1).outcome.kind, 'abandoned');
    const before = structuredClone(host.sink.events), frameCount = frames.length;
    failFlush = false; await host.execute(host.payload);
    assert.equal(host.calls.model, 1); assert.equal(frames.length, frameCount);
    assert.deepEqual(host.sink.events.filter(event => event.type !== 'step/end'), before.filter(event => event.type !== 'step/end'));
  });
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
  test(`${kind}: a Host control wakes the idle driver and withdraws its stale approval waiter`, async t => {
    const entered = gate(), late = gate(); let control, approvalSignal;
    const host = setup(t, sqlite, { onActive: (_payload, active) => { control = active; }, onIdle: async ({ signal }, snapshot) => {
      approvalSignal = signal; entered.resolve(); await late.promise;
      return { commandId: 'late-after-wake', kind: 'submit_interaction', payload: { interactionId: snapshot.pendingInteraction.interactionId, decision: 'allow' } };
    } });
    host.binding.ports.tools.execute = async () => ({ status: 'approval_required', content: null, interactionId: 'wake-approval' });
    const running = host.execute(host.payload); await entered.promise;
    control.kernel.submit(scope, control.runId, { commandId: 'cancel-from-control', kind: 'cancel', payload: {} }); control.wake();
    await assert.rejects(running, { code: 'NATIVE_TURN_CANCELED' });
    assert.equal(approvalSignal.aborted, true); assert.equal(host.head().phase, 'canceled'); assert.equal(host.calls.write, 0);
    late.resolve(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(host.store.load(scope, control.runId).commands.some(row => row.command.commandId === 'late-after-wake'), false);
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
  test(`${kind}: a canceled parent with unsettled children cannot start a new DSH turn`, async t => {
    const host = setup(t, sqlite), held = fixture();
    held.snapshot.childBudgetReservations = [{ childRunId: 'unsettled-child', childScope: scope,
      parentOperationKey: 'original-start', parentToolCallId: 'start-call', childRequestDigest: digest('request'),
      configurationDigest: digest('configuration'), maxModelCalls: 2, maxToolCalls: 1, settledUsageDigest: null }];
    held.snapshot.childRunIds = ['unsettled-child'];
    host.store.create(held.config, held.snapshot);
    const worker = new NativeKernel({ store: host.store, owner: 'cancel-held-parent', digest, ports: host.binding.ports });
    worker.submit(scope, 'run', { commandId: 'cancel', kind: 'cancel', payload: {} });
    assert.equal((await worker.runUntilIdle(scope, 'run')).phase, 'canceled');
    await assert.rejects(host.execute(host.payload), { code: 'NATIVE_RUN_RECOVERY_REQUIRED', nativeRunId: 'run' });
    assert.deepEqual(host.calls, { model: 0, write: 0 });
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
  test(`${kind}: a canceled crashed write without any receipt still requires reconciliation before a new turn`, async t => {
    const host = setup(t, sqlite), lost = fixture({ tools: [tool({ name: 'write', readOnly: false, concurrentSafe: false })] });
    host.store.create(lost.config, lost.snapshot);
    const lease = host.store.acquire(scope, 'run', 'lost-writer', 1, 1);
    const write = { callId: 'write-lost', name: 'write', arguments: {} };
    const prepared = prepareEffect(lost.snapshot, 'tool', 'executing_tools', { calls: [write], interaction: null }, {
      pendingTools: [write], messages: [...lost.snapshot.messages, { role: 'assistant', content: '', toolCalls: [write] }],
    });
    host.store.commit(scope, 'run', lease, 1, 0, prepared);
    host.store.claim(scope, 'run', lease, 1, prepared.snapshot.pendingIntent);
    const worker = new NativeKernel({ store: host.store, owner: 'cancel-lost-writer', digest, now: () => 100, ports: host.binding.ports });
    worker.submit(scope, 'run', { commandId: 'cancel', kind: 'cancel', payload: {} });
    assert.equal((await worker.runUntilIdle(scope, 'run')).phase, 'canceled');
    const record = host.store.load(scope, 'run');
    assert.ok(record.intents.some(intent => intent.kind === 'tool' && intent.status === 'running'));
    assert.equal(record.receipts.length, 0, 'Cancellation is not proof of the write result');
    await assert.rejects(host.execute(host.payload), { code: 'NATIVE_RUN_RECOVERY_REQUIRED', nativeRunId: 'run' });
    assert.deepEqual(host.calls, { model: 0, write: 0 });
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
test('a canceled Host input claim fences the next turn and a late receipt', async t => {
  const entered = gate(), late = gate(), host = setup(t, true);
  host.binding.ports.input = { prepare: async () => { entered.resolve(); await late.promise; return { status: 'admitted', messages: [] }; } };
  const running = host.execute(host.payload);
  const rejected = assert.rejects(running, /Canceled input claim/);
  await entered.promise; host.controller.abort(new Error('Canceled input claim')); await rejected;
  const run = host.head(); assert.equal(run.phase, 'canceled');
  const record = host.store.load(scope, run.runId);
  assert.ok(record.receipts.some(receipt => receipt.status === 'uncertain'
    && record.intents.find(intent => intent.operationKey === receipt.operationKey)?.kind === 'input'));
  await assert.rejects(host.execute({ ...host.payload, turn: 2, signal: new AbortController().signal }),
    { code: 'NATIVE_RUN_RECOVERY_REQUIRED', nativeRunId: run.runId });
  late.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(host.store.load(scope, run.runId), record);
});
test('plain Host-admitted guidance is delivered once when no display envelope is provided', async t => {
  const host = setup(t, false);
  host.binding.ports.input = { prepare: async ({ step }) => ({ status: 'admitted',
    messages: step === 2 ? [{ content: 'Plain live guidance' }] : [] }) };
  await host.execute(host.payload);
  assert.deepEqual(host.calls, { model: 2, write: 1 });
  const delivered = host.sink.events.filter(event => event.type === 'user/message' && event.data.content[0]?.text === 'Plain live guidance');
  assert.equal(delivered.length, 1); assert.deepEqual(delivered[0].data.source, { kind: 'user' });
  const before = structuredClone(host.sink.events);
  await host.execute(host.payload); assert.deepEqual(host.sink.events, before);
});
test('activation cleanup drains before another drive and redelivery does not repeat a tool effect', async t => {
  const host = setup(t, true), entered = gate(), release = gate(), cleanups = [];
  host.binding.releaseResources = async identity => {
    cleanups.push(identity); entered.resolve(); await release.promise;
  };
  const running = host.execute(host.payload);
  await entered.promise;
  assert.equal(host.head().phase, 'completed');
  assert.deepEqual(cleanups[0], { scope, sessionId: 'session', runId: host.head().runId });
  await assert.rejects(host.execute(host.payload), /native_dsh_session_already_driving/);
  release.resolve(); await running;
  const effects = { ...host.calls };
  await host.execute(host.payload);
  assert.equal(cleanups.length, 2); assert.deepEqual(host.calls, effects);
});
test('suspension and cancellation release activation resources after durable settlement', async t => {
  const suspended = setup(t, true), phases = [];
  suspended.binding.releaseResources = () => { phases.push(suspended.head().phase); };
  suspended.binding.ports.tools.execute = async () => ({ status: 'approval_required', content: null, interactionId: 'approval' });
  await assert.rejects(suspended.execute(suspended.payload), { code: 'NATIVE_TURN_SUSPENDED' });
  assert.deepEqual(phases, ['awaiting_interaction']);
  const canceled = setup(t, true), entered = gate();
  canceled.binding.ports.model.generate = async () => { entered.resolve(); return new Promise(() => {}); };
  canceled.binding.releaseResources = () => { phases.push(canceled.head().phase); };
  const running = canceled.execute(canceled.payload); await entered.promise;
  canceled.controller.abort(new Error('release-cancel'));
  await assert.rejects(running, /release-cancel/);
  assert.deepEqual(phases, ['awaiting_interaction', 'canceled']);
});
test('cleanup reports both the drive error and cleanup error without changing durable state', async t => {
  const host = setup(t, false);
  host.binding.releaseResources = () => { throw new Error('cleanup failed'); };
  host.binding.ports.tools.execute = async () => ({ status: 'approval_required', content: null, interactionId: 'approval' });
  await assert.rejects(host.execute(host.payload), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0].code, 'NATIVE_TURN_SUSPENDED');
    assert.equal(error.errors[1].message, 'cleanup failed');
    return true;
  });
  assert.equal(host.head().phase, 'awaiting_interaction');
});
