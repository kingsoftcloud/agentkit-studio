import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeKernel, MemoryRunStore, BACKGROUND_COMMAND_CONTRACT, admitBackgroundNotification,
  backgroundCommandObservation, emptyUsage } from '@kingsoftcloud/agentkit-harness-core';
import { fixture, tool, scope, digest } from './fixtures/native-core.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { nativeDshBackgroundOwnership } from '@kingsoftcloud/agentkit-harness-node/native/dsh-background-ownership';
import { createNativeDshTurnExecutor } from '@kingsoftcloud/agentkit-harness-node/native/dsh-turn-runtime';
import { nativeDeliveryProjection, createNativeSessionDelivery } from '@kingsoftcloud/agentkit-harness-node/native/session-delivery';

const final = () => ({ kind: 'final_candidate', text: 'Background result handled', toolCalls: [],
  usage: { ...emptyUsage(), inputTokens: 3, outputTokens: 5 } });
const gate = () => Promise.withResolvers();
// Transport fault double over the actual delivery projection. It is not the
// public DSH Agent or JSONL writer; the maintained-SDK proof covers that seam.
function consumer(ownership, seed) {
  const projection = nativeDeliveryProjection(), events = structuredClone(seed ?? [
    { type: 'turn/start', data: { turn: ownership.turn }, seq: 1 },
    { type: 'turn/owner', data: ownership, seq: 2 },
  ]);
  let state = projection.init(), owner = structuredClone(ownership), durable = structuredClone(events);
  for (const event of events) state = projection.apply(state, event);
  const session = { id: 'session', append(type, data, options = {}) {
    const event = { type, data: structuredClone(data), ...options, seq: events.length + 1 };
    state = projection.apply(state, event); events.push(event);
  } };
  const agent = { session, externalTurns: { contract: 'dsh.external-turn-host/v1',
    pending: () => structuredClone(owner), claim: value => assert.deepEqual(value, owner),
    resume: async (engine, execute) => { assert.equal(engine, owner.engine);
      return execute({ ownership: structuredClone(owner), turn: owner.turn, signal: new AbortController().signal }); },
  } };
  return { agent, events, projections: { stateOf: () => state }, get durable() { return durable; },
    flush: async () => { durable = structuredClone(events); return true; },
    clearOwner() { owner = null; } };
}
async function setup(t, sqlite, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'native-background-runtime-')), filename = join(root, 'runs.sqlite');
  let store = sqlite ? new SqliteRunStore(filename) : new MemoryRunStore();
  t.after(() => { store.close?.(); rmSync(root, { recursive: true, force: true }); });
  const launch = tool({ name: 'run_command', readOnly: false, concurrentSafe: false,
    backgroundCommandPolicy: 'owned-command-launch/v1' });
  const data = fixture({ tools: [launch, tool({ name: 'write', readOnly: false, concurrentSafe: false })],
    inputMessages: [{ role: 'user', content: 'Original task' }], backgroundNotificationPolicy: 'completed-before-model/v1',
    hostRecoveryBinding: { source: { provider: 'fixture', model: 'original-model' } },
    limits: { maxModelCalls: 7, maxToolCalls: 4, finalizationReserveModelCalls: 0 } });
  let sourceModels = 0, launches = 0;
  const original = new NativeKernel({ store, digest, owner: 'source', ports: {
    model: { generate: async () => ++sourceModels === 1 ? { ...final(), kind: 'tool_calls',
      toolCalls: [{ callId: 'launch', name: launch.name, arguments: {} }] } : final() },
    tools: { execute: async request => { launches++; return { status: 'ok', content: { backend: 'sandbox/local_process' },
      backgroundCommandRef: { taskId: 'a'.repeat(64), sourceRunId: request.runId, operationKey: request.operationKey } }; } },
    background: { contract: BACKGROUND_COMMAND_CONTRACT, observe: async () => [] },
  } });
  original.start(data.snapshot, data.config); await original.runUntilIdle(scope, 'run');
  const source = store.load(scope, 'run');
  const admitted = await admitBackgroundNotification({ store, scope, sourceRunId: 'run', taskId: 'a'.repeat(64),
    digest, signal: new AbortController().signal, observe: async request => backgroundCommandObservation({ ref: request.ref,
      status: 'completed', exitCode: 0, stdout: 'Terminal output is not a user instruction' }) });
  const runId = admitted.snapshot.runId, turn = 17;
  const ownership = nativeDshBackgroundOwnership({ record: store.load(scope, runId), turn });
  let sink = consumer(ownership), controller = new AbortController(), models = 0, flushes = 0, releases = 0;
  const binding = { scope, buildId: 'build', taskChainId: 'chain', configuration: admitted.configuration,
    source: { provider: 'fixture', model: 'original-model' }, releaseResources: () => { releases++; }, ports: {
      model: { generate: async request => { models++;
        assert.ok(flushes > 0, 'owner flushed before any model effect');
        assert.equal(request.messages.filter(message => message.kind === 'background_command_observation' && !message.history).length, 1);
        return final(); } },
      tools: { execute: async () => assert.fail('no relaunch') },
      background: { contract: BACKGROUND_COMMAND_CONTRACT, observe: async () => [] },
    } };
  const executor = extra => {
    const { flush = () => sink.flush(), ...overrides } = { ...options, ...extra };
    return createNativeDshTurnExecutor({ store, projections: sink.projections,
    flush: async session => { flushes++; return flush(session); }, durableOwnership: true,
    resolveTurn: async () => assert.fail('background must not resolve a normal user turn'),
    resolveBackgroundTurn: async (_payload, verified) => {
      assert.deepEqual(verified.source, source);
      assert.equal(verified.record.snapshot.runId, runId);
      assert.equal(verified.admission.identity.turnId, runId);
      return binding;
    }, ...overrides });
  };
  return { get store() { return store; }, source, runId, ownership, turn, binding, executor,
    get sink() { return sink; }, get controller() { return controller; },
    payload: () => ({ agent: sink.agent, ownership, turn, signal: controller.signal }),
    head: () => store.load(scope, runId),
    counts: () => ({ models, launches, sourceModels, flushes, releases }),
    reopen() { if (sqlite) { store.close(); store = new SqliteRunStore(filename); }
      sink = consumer(ownership, sink.durable); controller = new AbortController(); },
  };
}

for (const sqlite of [false, true]) {
  const backend = sqlite ? 'SQLite' : 'memory';
  test(`${backend}: an owned notice uses the full Native loop and delivers one typed notice without synthetic user input`, async t => {
    const h = await setup(t, sqlite), execute = h.executor();
    assert.deepEqual(await execute.background(h.payload()), { reason: { kind: 'completed' } });
    assert.equal(h.head().snapshot.phase, 'completed');
    assert.equal(h.head().snapshot.turnId, h.runId);
    assert.equal(h.head().configuration.limits.maxModelCalls, 5);
    assert.equal(h.head().snapshot.usage.modelCalls, 1);
    const notices = h.sink.events.filter(event => event.type === 'user/message');
    assert.equal(notices.length, 1);
    assert.equal(notices[0].data.source.kind, 'agentkit-native-background-notification');
    assert.equal(notices[0].data.source.form, 'notice');
    assert.equal(notices[0].data.source.sourceRunId, 'run');
    assert.equal(notices[0].data.source.taskId, 'a'.repeat(64));
    assert.match(notices[0].data.content[0].text, /Terminal output/);
    assert.equal(h.sink.events.some(event => event.type === 'user/message' && event.data.source.kind === 'user'), false);
    const events = structuredClone(h.sink.events);
    await execute.background(h.payload());
    assert.deepEqual(h.sink.events, events);
    assert.equal(h.counts().models, 1); assert.equal(h.counts().launches, 1);
    assert.deepEqual(h.store.load(scope, 'run'), h.source);
    assert.equal(h.counts().releases, 2);
  });

  test(`${backend}: rebinding a changed configuration, Build or chain fails before effects`, async t => {
    const h = await setup(t, sqlite), execute = h.executor();
    for (const [key, value] of [['buildId', 'foreign'], ['taskChainId', 'foreign'],
      ['configuration', { ...h.binding.configuration, limits: { ...h.binding.configuration.limits, maxModelCalls: 7 } }]]) {
      const before = h.binding[key]; h.binding[key] = value;
      await assert.rejects(execute.background(h.payload()), /native_dsh_recovery_(identity_mismatch|configuration_changed)/);
      h.binding[key] = before;
    }
    assert.equal(h.counts().models, 0); assert.equal(h.counts().launches, 1);
    assert.equal(h.head().snapshot.phase, 'created');
    assert.equal(h.counts().releases, 3);
  });

  test(`${backend}: owner and resolver capabilities are required before background execution`, async t => {
    const h = await setup(t, sqlite);
    await assert.rejects(h.executor({ resolveBackgroundTurn: undefined }).background(h.payload()), /background_resolver_required/);
    h.sink.clearOwner();
    await assert.rejects(h.executor().background(h.payload()), /background_owner_required/);
    assert.equal(h.counts().models, 0); assert.equal(h.head().snapshot.phase, 'created');
  });

  test(`${backend}: background model attribution must match the original persisted Host source`, async t => {
    const h = await setup(t, sqlite);
    h.binding.source = { provider: 'foreign-provider', model: 'foreign-model' };
    await assert.rejects(h.executor().background(h.payload()), /background_source_changed/);
    assert.equal(h.counts().models, 0); assert.equal(h.counts().releases, 1);
    assert.equal(h.sink.events.length, 2);
  });

  test(`${backend}: competing background drivers cannot allocate a second port binding`, async t => {
    const h = await setup(t, sqlite), entered = gate(), late = gate(); let bindings = 0, models = 0;
    h.binding.ports.model.generate = async () => { models++; entered.resolve(); await late.promise; return final(); };
    const execute = h.executor({ resolveBackgroundTurn: async () => { bindings++; return h.binding; } });
    const running = execute.background(h.payload());
    await entered.promise;
    await assert.rejects(execute.background(h.payload()), /session_already_driving/);
    assert.equal(bindings, 1); assert.equal(models, 1);
    late.resolve(); await running;
    assert.equal(h.counts().releases, 1);
  });

  test(`${backend}: a failed ownership barrier cannot dispatch, then cold recovery retains the original reduced budget`, async t => {
    const h = await setup(t, sqlite);
    await assert.rejects(h.executor({ flush: async () => false }).background(h.payload()), /ownership_not_durable/);
    assert.equal(h.counts().models, 0); assert.equal(h.head().snapshot.phase, 'created');
    h.reopen();
    assert.deepEqual(await h.executor().resumeBackground({ agent: h.sink.agent }), { reason: { kind: 'completed' } });
    assert.equal(h.counts().models, 1); assert.equal(h.counts().launches, 1);
    assert.equal(h.head().configuration.limits.maxModelCalls, 5);
  });

  test(`${backend}: append-before-flush failure replays the same transcript without a second model or notice`, async t => {
    const h = await setup(t, sqlite); let faulted = false;
    const execute = h.executor({ flush: async () => {
      await h.sink.flush();
      if (!faulted && h.head().events.some(event => event.kind === 'model.completed')) {
        faulted = true; throw Error('crash after committed model and Session append');
      }
      return true;
    } });
    await assert.rejects(execute.background(h.payload()), /crash after committed/);
    assert.equal(h.counts().models, 1);
    const events = structuredClone(h.sink.durable);
    h.reopen();
    await h.executor().resumeBackground({ agent: h.sink.agent });
    assert.equal(h.counts().models, 1); assert.equal(h.counts().launches, 1);
    assert.equal(h.sink.events.filter(event => event.type === 'user/message').length, 1);
    assert.deepEqual(h.sink.events.filter(event => event.type === 'assistant/message'), events.filter(event => event.type === 'assistant/message'));
  });

  test(`${backend}: cancellation during the ownership barrier is durable and recovery cannot start a model`, async t => {
    const h = await setup(t, sqlite), entered = gate(), late = gate();
    const running = h.executor({ flush: async () => { entered.resolve(); return late.promise; } }).background(h.payload());
    await entered.promise;
    h.controller.abort({ kind: 'user' });
    await assert.rejects(running, error => error.kind === 'user');
    assert.equal(h.head().commands.some(row => row.command.kind === 'cancel'), true);
    h.reopen();
    assert.deepEqual(await h.executor().resumeBackground({ agent: h.sink.agent }), { reason: { kind: 'aborted', reason: { kind: 'user' } } });
    assert.equal(h.head().snapshot.phase, 'canceled');
    assert.equal(h.counts().models, 0); assert.equal(h.counts().launches, 1);
    late.resolve(true);
  });

  for (const timing of ['before-rebinding', 'during-rebinding']) test(`${backend}: ${timing} cancellation cannot be lost before ports exist`, async t => {
    const h = await setup(t, sqlite), entered = gate(), late = gate();
    const execute = h.executor({ resolveBackgroundTurn: async () => {
      entered.resolve(); await late.promise; return h.binding;
    } });
    if (timing === 'before-rebinding') h.controller.abort({ kind: 'user' });
    const running = execute.background(h.payload());
    if (timing === 'during-rebinding') { await entered.promise; h.controller.abort({ kind: 'user' }); }
    await assert.rejects(running, error => error.kind === 'user');
    assert.equal(h.head().commands.some(row => row.command.kind === 'cancel' && row.command.payload.dshCancelReason.kind === 'user'), true);
    late.resolve();
    h.reopen();
    assert.deepEqual(await h.executor().resumeBackground({ agent: h.sink.agent }),
      { reason: { kind: 'aborted', reason: { kind: 'user' } } });
    assert.equal(h.counts().models, 0); assert.equal(h.counts().launches, 1);
  });

  test(`${backend}: notification tool approval shares the ordinary durable interaction loop`, async t => {
    const h = await setup(t, sqlite); let models = 0, writes = 0, approvals = 0;
    h.binding.ports.model.generate = async () => ++models === 1 ? { ...final(), kind: 'tool_calls',
      toolCalls: [{ callId: 'write', name: 'write', arguments: {} }] } : final();
    h.binding.ports.tools.execute = async request => {
      if (!request.interaction) return { status: 'approval_required', content: null, interactionId: 'notice-write' };
      assert.equal(request.interaction.decision, 'allow'); writes++; return { status: 'ok', content: 'Written once' };
    };
    const execute = h.executor({ onIdle: async (_payload, snapshot) => { approvals++;
      return { commandId: 'allow-notice-write', kind: 'submit_interaction',
        payload: { interactionId: snapshot.pendingInteraction.interactionId, decision: 'allow' } }; } });
    assert.deepEqual(await execute.background(h.payload()), { reason: { kind: 'completed' } });
    await execute.background(h.payload());
    assert.equal(models, 2); assert.equal(writes, 1); assert.equal(approvals, 1);
    assert.equal(h.head().snapshot.usage.toolCalls, 1);
    assert.equal(h.head().events.filter(event => event.kind === 'approval.resolved').length, 1);
    assert.equal(h.counts().launches, 1);
  });

  test(`${backend}: an ordinary delivery consumer cannot claim the notice's stable Native identity`, async t => {
    const h = await setup(t, sqlite);
    const deliver = createNativeSessionDelivery({ store: h.store, scope, runId: h.runId, session: h.sink.agent.session,
      turn: h.turn, projections: h.sink.projections, flush: h.sink.flush, source: h.binding.source,
      inputMessages: [], systemText: h.binding.configuration.instructions });
    await assert.rejects(deliver(h.head().snapshot), /native_delivery_identity_mismatch/);
    assert.equal(h.sink.events.length, 2);
  });
}
