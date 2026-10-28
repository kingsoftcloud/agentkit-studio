import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryRunStore, canonical, emptyUsage } from '@kingsoftcloud/agentkit-harness-core';
import { scope, fixture, tool, digest } from './fixtures/native-core.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { createNativeDshTurnExecutor, freezeNativeDshConfiguration, NATIVE_DSH_TURN_CONTRACT } from '@kingsoftcloud/agentkit-harness-node/native/dsh-turn-runtime';
import { nativeDshOwnership, readNativeDshOwnership } from '@kingsoftcloud/agentkit-harness-node/native/dsh-turn-ownership';
import { nativeDeliveryProjection } from '@kingsoftcloud/agentkit-harness-node/native/session-delivery';

const final = () => ({ kind: 'final_candidate', text: 'Done', toolCalls: [], usage: emptyUsage() });
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };

// Deliberately limited adapter unit double. Real public Agent, persistence and
// process termination are exercised by verify-native-owned-recovery.mjs.
function sink() {
  const projection = nativeDeliveryProjection(), events = [];
  let state = projection.init(), claimed = null;
  const session = { id: 'original-session', append(type, data, options) {
    const event = { type, data: structuredClone(data), ...options, seq: events.length + 1 };
    state = projection.apply(state, event); events.push(event);
  } };
  session.append('turn/start', { turn: 1 });
  const agent = { session, externalTurns: { contract: 'dsh.external-turn-host/v1',
    claim(value) {
      if (claimed) assert.deepEqual(value, claimed);
      else { claimed = structuredClone(value); session.append('turn/owner', value); }
    },
    pending: () => structuredClone(claimed),
    resume: async (engine, execute) => {
      assert.equal(engine, claimed.engine);
      return execute({ ownership: structuredClone(claimed), turn: claimed.turn, signal: new AbortController().signal });
    },
  } };
  return { agent, events, projections: { stateOf: () => state }, flush: async () => true };
}

function setup(t, sqlite) {
  const directory = mkdtempSync(join(tmpdir(), 'native-owned-admission-'));
  const store = sqlite ? new SqliteRunStore(join(directory, 'runs.sqlite')) : new MemoryRunStore();
  t.after(() => { store.close?.(); rmSync(directory, { recursive: true, force: true }); });
  const consumer = sink(), controller = new AbortController(), calls = { model: 0, write: 0 };
  const configuration = fixture({ inputMessages: [{ role: 'user', content: 'Complete the task' }],
    tools: [tool({ name: 'write', readOnly: false, concurrentSafe: false })] }).config;
  const binding = { scope, buildId: 'original-build', configuration, source: { provider: 'fixture', model: 'original-model' }, ports: {
    model: { generate: async () => ++calls.model === 1
      ? { ...final(), kind: 'tool_calls', toolCalls: [{ callId: 'write-1', name: 'write', arguments: {} }] } : final() },
    tools: { execute: async () => { calls.write++; return { status: 'ok', content: 'Written once' }; } },
  } };
  const payload = { agent: consumer.agent, turn: 1, signal: controller.signal,
    input: { kind: 'enter', messages: [{ role: 'user', id: 'original-input', content: [{ type: 'text', text: 'Complete the task' }] }] } };
  const executor = options => createNativeDshTurnExecutor({ store, ...consumer, durableOwnership: true,
    resolveTurn: async () => binding, resolveRecoveryTurn: async () => binding, ...options });
  return { store, consumer, controller, calls, binding, payload, executor };
}

test('admission retains the exact scoped Run and lossless numeric inputs, without live capabilities', t => {
  const host = setup(t, false), configuration = freezeNativeDshConfiguration(host.binding, host.payload.input);
  const identity = { scope, sessionId: host.consumer.agent.session.id, turnId: '1', buildId: host.binding.buildId,
    taskChainId: 'original-chain', parentRunId: null };
  identity.runId = `native-dsh-${digest({ contract: NATIVE_DSH_TURN_CONTRACT, scope, sessionId: identity.sessionId, turn: 1 })}`;
  const input = structuredClone(host.payload.input);
  input.messages[0].content.push({ type: 'fixture-numeric', integer: 9007199254740993n, float: -0 });
  const ownership = nativeDshOwnership({ identity, configuration, input, source: host.binding.source });
  const read = () => readNativeDshOwnership(ownership, { sessionId: identity.sessionId, turn: 1 });
  assert.equal(read().messages[0].content[1].integer, 9007199254740993n);
  assert.ok(Object.is(read().messages[0].content[1].float, -0));
  assert.deepEqual(read().identity, identity);
  assert.equal(read().configDigest, digest(configuration));
  assert.equal(Object.hasOwn(read(), 'ports'), false);
  assert.throws(() => readNativeDshOwnership(ownership, { sessionId: 'other-session', turn: 1 }), /identity_invalid/);
  assert.throws(() => readNativeDshOwnership({ ...ownership, turn: 2 }, { sessionId: identity.sessionId, turn: 1 }), /ownership_invalid/);
  for (const change of [admission => { admission.identity.runId = 'other-run'; },
    admission => { admission.identity.scope.agentId = 'other-agent'; },
    admission => { admission.configuration.instructions = 'changed'; },
    admission => { admission.source.model = ''; },
    admission => { admission.ports = {}; }]) {
    const admission = read(); change(admission);
    assert.throws(() => readNativeDshOwnership({ ...ownership, binding: canonical(admission) },
      { sessionId: identity.sessionId, turn: 1 }));
  }
  assert.throws(() => readNativeDshOwnership({ ...ownership, binding: ownership.binding + ' ' },
    { sessionId: identity.sessionId, turn: 1 }), /admission_invalid/);
});

for (const sqlite of [false, true]) {
  const backend = sqlite ? 'SQLite' : 'memory';
  test(`${backend}: the complete owner is durable before Run creation or any dispatch`, async t => {
    const host = setup(t, sqlite), entered = gate(), release = gate(); let flushed = false;
    const execute = host.executor({ flush: async () => {
      if (!flushed) { entered.resolve(); await release.promise; flushed = true; }
      return true;
    } });
    const running = execute(host.payload); await entered.promise;
    const admission = readNativeDshOwnership(host.consumer.agent.externalTurns.pending(), { sessionId: 'original-session', turn: 1 });
    assert.deepEqual(admission.configuration.inputMessages, host.binding.configuration.inputMessages);
    assert.equal(host.store.list(scope).length, 0); assert.deepEqual(host.calls, { model: 0, write: 0 });
    release.resolve(); assert.deepEqual(await running, { reason: { kind: 'completed' } });
    assert.deepEqual(host.calls, { model: 2, write: 1 });
    const [run] = host.store.list(scope);
    assert.equal(run.runId, admission.identity.runId); assert.equal(run.configDigest, admission.configDigest);
    assert.equal(host.consumer.events.filter(event => event.type === 'turn/owner').length, 1);
  });

  test(`${backend}: missing lifecycle capability refuses before Run creation`, async t => {
    const host = setup(t, sqlite); delete host.payload.agent.externalTurns;
    await assert.rejects(host.executor()(host.payload), /native_dsh_ownership_host_required/);
    assert.equal(host.store.list(scope).length, 0); assert.deepEqual(host.calls, { model: 0, write: 0 });
  });

  for (const fail of ['false', 'throw', 'timeout']) test(`${backend}: ${fail} ownership flush cannot dispatch, including a late success`, async t => {
    const host = setup(t, sqlite), late = gate();
    const execute = host.executor({ ownershipFlushTimeoutMs: 10, flush: async () => {
      if (fail === 'throw') throw Error('Session disk failure');
      if (fail === 'false') return false;
      await late.promise; return true;
    } });
    await assert.rejects(execute(host.payload), /ownership_not_durable|disk failure|ownership_flush_timeout/);
    late.resolve(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(host.store.list(scope).length, 0); assert.deepEqual(host.calls, { model: 0, write: 0 });
    assert.ok(host.consumer.agent.externalTurns.pending());
  });

  test(`${backend}: admission-only recovery creates the original Run with the original contract exactly once`, async t => {
    const host = setup(t, sqlite); let compilations = 0;
    host.binding.taskContractFactory = () => ({ ...host.binding.configuration.contract, revision: `compiled-${++compilations}` });
    await assert.rejects(host.executor({ flush: async () => false })(host.payload), /ownership_not_durable/);
    const owner = host.consumer.agent.externalTurns.pending();
    const admission = readNativeDshOwnership(owner, { sessionId: 'original-session', turn: 1 });
    const execute = host.executor({ resolveTurn: () => { throw Error('Must use recovery resolver'); },
      resolveRecoveryTurn: async (payload, original) => {
        assert.deepEqual(original, admission); assert.deepEqual(payload.input.messages, admission.messages);
        original.identity.runId = 'mutated-copy'; return host.binding;
      } });
    assert.deepEqual(await execute.resume({ agent: host.consumer.agent }), { reason: { kind: 'completed' } });
    assert.deepEqual(await execute.resume({ agent: host.consumer.agent }), { reason: { kind: 'completed' } });
    const [run] = host.store.list(scope);
    assert.equal(host.store.list(scope).length, 1); assert.equal(run.runId, admission.identity.runId);
    assert.equal(run.configDigest, admission.configDigest); assert.equal(compilations, 1);
    assert.equal(host.store.load(scope, run.runId).configuration.contract.revision, 'compiled-1');
    assert.deepEqual(host.calls, { model: 2, write: 1 });
  });

  test(`${backend}: recovery refuses missing or changed trusted bindings before creating a Run`, async t => {
    const host = setup(t, sqlite);
    await assert.rejects(host.executor({ flush: async () => false })(host.payload), /ownership_not_durable/);
    await assert.rejects(host.executor({ resolveRecoveryTurn: async () => null }).resume({ agent: host.consumer.agent }), /recovery_binding_unavailable/);
    host.binding.configuration.instructions = 'Changed current policy';
    await assert.rejects(host.executor().resume({ agent: host.consumer.agent }), /recovery_configuration_changed/);
    assert.equal(host.store.list(scope).length, 0); assert.deepEqual(host.calls, { model: 0, write: 0 });
  });

  for (const cause of [{ kind: 'user' }, { kind: 'parent' }, { kind: 'disposed' }, { kind: 'hook', reason: 'Governance stopped this turn' }])
  test(`${backend}: ${cause.kind} cancellation during a stuck ownership flush survives recovery without effects`, async t => {
    const host = setup(t, sqlite), entered = gate(), late = gate();
    const running = host.executor({ flush: async () => { entered.resolve(); await late.promise; return true; } })(host.payload);
    await entered.promise; host.controller.abort(cause);
    await assert.rejects(running, error => error.kind === cause.kind);
    const [run] = host.store.list(scope), record = host.store.load(scope, run.runId);
    assert.ok(record.commands.some(row => row.command.kind === 'cancel' && !row.consumed
      && canonical(row.command.payload.dshCancelReason) === canonical(cause)));
    assert.deepEqual(host.calls, { model: 0, write: 0 });
    late.resolve(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(await host.executor().resume({ agent: host.consumer.agent }), { reason: { kind: 'aborted', reason: cause } });
    assert.equal(host.store.load(scope, run.runId).snapshot.phase, 'canceled');
    assert.equal(host.store.list(scope).length, 1); assert.deepEqual(host.calls, { model: 0, write: 0 });
  });

  test(`${backend}: checkpoint recovery continues the original Run without repeating its committed model`, async t => {
    const host = setup(t, sqlite); let stopped = false;
    await assert.rejects(host.executor({ onCheckpoint: async (_, snapshot) => {
      const record = host.store.load(scope, snapshot.runId);
      if (!stopped && record.receipts.some(row => row.status === 'committed'
        && record.intents.some(intent => intent.operationKey === row.operationKey && intent.kind === 'model'))) {
        stopped = true; throw Error('Injected worker interruption');
      }
    } })(host.payload), /Injected worker interruption/);
    assert.equal(host.calls.model, 1); assert.equal(host.calls.write, 0);
    const [before] = host.store.list(scope);
    await host.executor().resume({ agent: host.consumer.agent });
    assert.deepEqual(host.calls, { model: 2, write: 1 });
    assert.equal(host.store.list(scope).length, 1);
    assert.equal(host.store.list(scope)[0].runId, before.runId);
    assert.equal(host.store.list(scope)[0].configDigest, before.configDigest);
  });
}
