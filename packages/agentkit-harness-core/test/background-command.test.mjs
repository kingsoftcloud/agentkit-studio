import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeKernel, MemoryRunStore, emptyUsage, transition, prepareEffect, rememberCommand, commandProbe,
  stageCommandObservations, backgroundCommandRef, backgroundCommandObservation, BACKGROUND_COMMAND_CONTRACT } from '../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { fixture, tool, scope, digest } from './fixtures.mjs';

const launcher = tool({ name: 'run_command', readOnly: false, concurrentSafe: false, backgroundCommandPolicy: 'owned-command-launch/v1' });
const ref = changes => ({ taskId: 'a'.repeat(64), sourceRunId: 'run', operationKey: 'owned-launch', ...changes });
const notice = (reference = ref(), changes = {}) => ({ ref: reference, status: 'completed', stdout: 'untrusted process output', ...changes });
const final = () => ({ kind: 'final_candidate', text: 'Complete', toolCalls: [], usage: emptyUsage() });
function state(configuration = {}, changes = {}) {
  const data = fixture({ tools: [launcher], backgroundNotificationPolicy: 'completed-before-model/v1', ...configuration });
  return { config: data.config, snapshot: { ...data.snapshot, phase: 'preparing_context',
    usage: { ...data.snapshot.usage, toolCalls: 1 }, backgroundCommands: [{ ref: ref(), notified: false }], ...changes } };
}
const messages = snapshot => snapshot.messages.filter(message => message.kind === 'background_command_observation');

test('background policy is explicit, versioned and cannot authorize a read-only or replayable launcher', () => {
  assert.equal(Object.hasOwn(fixture().config, 'backgroundNotificationPolicy'), false);
  assert.throws(() => fixture({ backgroundNotificationPolicy: 'anything' }), { code: 'invalid_background_notification_policy' });
  assert.throws(() => fixture({ tools: [{ ...launcher, backgroundCommandPolicy: 'anything' }] }), { code: 'invalid_background_launcher_policy' });
  assert.throws(() => fixture({ tools: [{ ...launcher, readOnly: true }] }), { code: 'invalid_background_launcher' });
  assert.throws(() => fixture({ tools: [{ ...launcher, recoveryPolicy: 'safe-read/v1' }] }), { code: 'invalid_safe_read_recovery' });
});
test('typed refs and observations reject ambiguous status, out-of-range cursors and oversized Unicode output', () => {
  assert.deepEqual(backgroundCommandRef(ref()), ref());
  for (const change of [{ taskId: 'A'.repeat(64) }, { sourceRunId: '' }, { operationKey: '' }, { unexpected: true }])
    assert.throws(() => backgroundCommandRef(ref(change)), { code: 'invalid_background_command_ref' });
  for (const change of [{ status: 'running' }, { status: ['completed'] }, { stdoutCursor: -1 }, { stderrCursor: 0.5 },
    { exitCode: Number.MAX_SAFE_INTEGER + 1 }, { evidenceIncomplete: 'false' }, { stdout: '🧪'.repeat(8193) }])
    assert.throws(() => backgroundCommandObservation(notice(ref(), change)));
  const normalized = backgroundCommandObservation(notice(ref(), { stdout: '🧪'.repeat(8192) }));
  assert.equal([...normalized.stdout].length, 8192); assert.equal(normalized.stdoutCursor, 0);
  assert.equal(normalized.exitCode, null); assert.equal(normalized.observedExitCode, null);
});
test('only a pinned launcher receipt can introduce a handle; rendered content cannot impersonate it', () => {
  const { snapshot } = state({}, { pendingIntent: 'owned-launch', backgroundCommands: [] });
  assert.deepEqual(rememberCommand(snapshot, { status: 'ok', content: { backgroundCommandRef: ref() } }, launcher), []);
  const result = { status: 'ok', content: {}, backgroundCommandRef: ref() };
  assert.deepEqual(rememberCommand(snapshot, result, launcher), [{ ref: ref(), notified: false }]);
  assert.deepEqual(rememberCommand(snapshot, { ...result, backgroundCommandFinished: true }, launcher), [{ ref: ref(), notified: true }]);
  for (const candidate of [{ ...result, status: 'approval_required' }, { ...result, backgroundCommandRef: ref({ sourceRunId: 'foreign' }) },
    { ...result, backgroundCommandRef: ref({ operationKey: 'foreign' }) }])
    assert.throws(() => rememberCommand(snapshot, candidate, launcher), { code: 'background_command_receipt_identity_conflict' });
  assert.throws(() => rememberCommand(snapshot, result, tool()), { code: 'background_command_receipt_identity_conflict' });
  assert.throws(() => rememberCommand({ ...snapshot, backgroundCommands: [{ ref: ref({ operationKey: 'other' }), notified: false }] }, result, launcher),
    { code: 'background_command_locator_conflict' });
});
test('a probe requires an allowed launcher and a controlled context or unclaimed model boundary', () => {
  const { config, snapshot } = state();
  assert.equal(commandProbe(snapshot, { ...config, backgroundNotificationPolicy: null }), null);
  assert.equal(commandProbe(snapshot, { ...config, contract: { ...config.contract, allowedToolNames: [] } }), null);
  for (const phase of ['paused', 'awaiting_interaction', 'executing_tools', 'completed', 'interrupted'])
    assert.equal(commandProbe({ ...snapshot, phase }, config), null);
  const batch = prepareEffect(snapshot, 'model', 'requesting_model', { finalizationOnly: false }), intent = batch.intents[0];
  assert.ok(commandProbe(batch.snapshot, config, intent));
  assert.equal(commandProbe(batch.snapshot, config, { ...intent, status: 'running' }), null);
  assert.equal(commandProbe(batch.snapshot, config, { ...intent, payload: { purpose: 'delivery_review' } }), null);
  assert.equal(commandProbe(batch.snapshot, config, { ...intent, payload: { purpose: 'compaction' } }), null);
});
test('notice, notified marker and retirement of undispatched model are a single transaction', () => {
  const { config, snapshot } = state(), prepared = prepareEffect(snapshot, 'model', 'requesting_model', { finalizationOnly: false });
  const intent = prepared.intents[0], request = commandProbe(prepared.snapshot, config, intent);
  const batch = stageCommandObservations(prepared.snapshot, config, request, [notice()], intent, 7);
  assert.equal(batch.snapshot.phase, 'preparing_context'); assert.equal(batch.snapshot.pendingIntent, null);
  assert.equal(batch.snapshot.preparedContext, null); assert.equal(batch.snapshot.activeElapsedMs, 7);
  assert.equal(batch.snapshot.backgroundCommands[0].notified, true); assert.equal(messages(batch.snapshot).length, 1);
  assert.match(messages(batch.snapshot)[0].content, /untrusted data/);
  assert.deepEqual(batch.receipts, [{ operationKey: intent.operationKey, status: 'not_dispatched',
    result: { code: 'superseded_by_background_observation', executed: false } }]);
  assert.equal(batch.snapshot.usage.modelCalls, 0); assert.equal(commandProbe(batch.snapshot, config), null);
  assert.equal(JSON.stringify(batch.events).includes('untrusted process output'), false);
  for (const observations of [[notice(), notice()], [notice(ref({ sourceRunId: 'foreign' }))], Array.from({ length: 9 }, () => notice())])
    assert.throws(() => stageCommandObservations(prepared.snapshot, config, request, observations, intent));
});

for (const backend of ['memory', 'sqlite']) {
  function setup(t, configuration = {}, changes = {}) {
    const directory = mkdtempSync(join(tmpdir(), 'native-background-')), filename = join(directory, 'run.sqlite');
    let store = backend === 'sqlite' ? new SqliteRunStore(filename) : new MemoryRunStore();
    const data = state(configuration, changes), initial = fixture(configuration).snapshot;
    store.create(data.config, { ...initial, configDigest: digest(data.config) });
    const before = store.load(scope, 'run').snapshot, lease = store.acquire(scope, 'run', 'seed', 1, 30);
    const batch = transition(before, data.snapshot, [{ kind: 'fixture.owned_command', payload: {} }]);
    store.commit(scope, 'run', lease, 1, 0, batch); store.release(scope, 'run', lease);
    t.after(() => { store.close?.(); rmSync(directory, { recursive: true, force: true }); });
    return { config: data.config, get store() { return store; }, reopen() {
      if (backend === 'sqlite') { store.close(); store = new SqliteRunStore(filename); } return store;
    } };
  }
  const drive = (store, observer, model = async () => final(), options = {}) => new NativeKernel({ store, digest,
    owner: 'driver', now: () => 100, ...options, ports: { model: { generate: model },
      tools: { execute: async () => assert.fail('owned command must never be relaunched') },
      ...(observer ? { background: { contract: BACKGROUND_COMMAND_CONTRACT, observe: observer } } : {}) } });
  test(`${backend}: a completed result is delivered once, survives reopen and cannot revive a stopped run`, async t => {
    const host = setup(t); host.reopen(); let probes = 0, models = 0;
    const kernel = drive(host.store, async request => { probes++; assert.deepEqual(request.refs, [ref()]); return [notice()]; }, async request => {
      models++; assert.equal(request.messages.filter(message => message.kind === 'background_command_observation').length, 1); return final();
    });
    const result = await kernel.runUntilIdle(scope, 'run'); assert.equal(result.phase, 'completed');
    assert.equal(models, 1); assert.equal(probes, 1); assert.equal(messages(result).length, 1);
    const stored = host.reopen().load(scope, 'run'); assert.equal(stored.snapshot.backgroundCommands[0].notified, true);
    assert.deepEqual(await drive(host.store, async () => assert.fail()).runUntilIdle(scope, 'run'), stored.snapshot);
  });
  test(`${backend}: a still-running command adds no notice and does not trap the model in a polling loop`, async t => {
    const host = setup(t); let probes = 0, models = 0;
    const result = await drive(host.store, async () => { probes++; return []; }, async () => { models++; return final(); }).runUntilIdle(scope, 'run');
    assert.equal(result.phase, 'completed'); assert.equal(models, 1); assert.equal(probes, 2);
    assert.equal(messages(result).length, 0); assert.equal(result.backgroundCommands[0].notified, false);
  });
  for (const status of ['unknown', 'unavailable', 'forged-ref', 'duplicate', 'bad-status', 'unbound', 'throws'])
    test(`${backend}: ${status} stops inference without a relaunch or a false completion`, async t => {
      const host = setup(t); let models = 0;
      const observer = status === 'unbound' ? null : async () => {
        if (status === 'throws') throw Error('private supervisor error');
        if (status === 'forged-ref') return [notice(ref({ operationKey: 'foreign' }))];
        if (status === 'duplicate') return [notice(), notice()];
        if (status === 'bad-status') return [notice(ref(), { status: ['completed'] })];
        return [notice(ref(), { status })];
      };
      const result = await drive(host.store, observer, async () => { models++; return final(); }).runUntilIdle(scope, 'run');
      assert.equal(result.phase, 'interrupted'); assert.equal(result.reason, 'effect_outcome_unknown'); assert.equal(models, 0);
      assert.equal(result.backgroundCommands[0].notified, true); assert.equal(messages(result).length, 1);
      assert.equal(JSON.stringify(host.store.events(scope, 'run')).includes('private supervisor error'), false);
    });
  test(`${backend}: known completion retains incomplete evidence for the model without inventing an unknown outcome`, async t => {
    const host = setup(t);
    const result = await drive(host.store, async () => [notice(ref(), { evidenceIncomplete: true, observedExitCode: 137 })], async request => {
      const content = JSON.parse(request.messages.find(message => message.kind === 'background_command_observation').content);
      assert.equal(content.commands[0].evidenceIncomplete, true); assert.equal(content.commands[0].observedExitCode, 137);
      assert.equal(content.commands[0].status, 'completed'); return final();
    }).runUntilIdle(scope, 'run');
    assert.equal(result.phase, 'completed'); assert.equal(result.usage.modelCalls, 1);
  });
  test(`${backend}: an old prepared model is retired before rebuilding context and spending its first claim`, async t => {
    const host = setup(t), snapshot = host.store.load(scope, 'run').snapshot;
    const lease = host.store.acquire(scope, 'run', 'old-worker', 1, 30);
    const batch = prepareEffect(snapshot, 'model', 'requesting_model', { finalizationOnly: false });
    host.store.commit(scope, 'run', lease, 1, snapshot.revision, batch); host.store.release(scope, 'run', lease); host.reopen();
    let dispatched;
    const result = await drive(host.store, async () => [notice()], async request => { dispatched = request.operationKey; return final(); }).runUntilIdle(scope, 'run');
    assert.equal(result.phase, 'completed'); assert.notEqual(dispatched, batch.snapshot.pendingIntent); assert.equal(result.usage.modelCalls, 1);
    const record = host.store.load(scope, 'run'); assert.equal(record.receipts.find(item => item.operationKey === batch.snapshot.pendingIntent).status, 'not_dispatched');
    assert.equal(record.intents.find(item => item.operationKey === batch.snapshot.pendingIntent).status, 'prepared');
  });
  test(`${backend}: cancel wins over a stalled read and fences a late report`, async t => {
    const host = setup(t); let entered, complete;
    const started = new Promise(resolve => { entered = resolve; });
    const kernel = drive(host.store, async () => { entered(); return await new Promise(resolve => { complete = resolve; }); }, async () => assert.fail());
    const running = kernel.runUntilIdle(scope, 'run'); await started;
    kernel.submit(scope, 'run', { commandId: 'cancel', kind: 'cancel', payload: {} });
    const result = await running; assert.equal(result.phase, 'canceled'); assert.equal(messages(result).length, 0);
    const stored = host.store.load(scope, 'run'); complete([notice()]); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(host.store.load(scope, 'run'), stored);
  });
  test(`${backend}: a timed out observation is unavailable and its late result is discarded`, async t => {
    const host = setup(t, { limits: { effectTimeoutMs: 15 }, profile: { ...fixture().config.profile, requestTimeoutMs: 10 },
      tools: [{ ...launcher, timeoutMs: 5 }] }); let complete, signal;
    const result = await drive(host.store, async request => { signal = request.signal; return await new Promise(resolve => { complete = resolve; }); },
      async () => assert.fail()).runUntilIdle(scope, 'run');
    assert.equal(result.reason, 'effect_outcome_unknown'); assert.equal(signal.aborted, true); assert.equal(messages(result).length, 1);
    const stored = host.store.load(scope, 'run'); complete([notice()]); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(host.store.load(scope, 'run'), stored);
  });
  test(`${backend}: an enqueued cancel beats a completed observation before commit`, async t => {
    const host = setup(t);
    const result = await drive(host.store, async () => {
      host.store.enqueue(scope, 'run', { commandId: 'cancel', kind: 'cancel', payload: {} }); return [notice()];
    }, async () => assert.fail()).runUntilIdle(scope, 'run');
    assert.equal(result.phase, 'canceled'); assert.equal(result.backgroundCommands[0].notified, false); assert.equal(messages(result).length, 0);
  });
  test(`${backend}: cancellation arriving inside commit aborts the entire notice transaction`, async t => {
    const host = setup(t), commit = host.store.commit.bind(host.store); let raced = false;
    host.store.commit = (...args) => {
      if (!raced && args.at(-1).events.some(event => event.kind === 'background.commands_observed')) {
        raced = true; host.store.enqueue(scope, 'run', { commandId: 'raced-cancel', kind: 'cancel', payload: {} });
      }
      return commit(...args);
    };
    const result = await drive(host.store, async () => [notice()], async () => assert.fail()).runUntilIdle(scope, 'run');
    assert.equal(raced, true); assert.equal(result.phase, 'canceled'); assert.equal(messages(result).length, 0);
    assert.equal(result.backgroundCommands[0].notified, false);
  });
  test(`${backend}: a forged or incomplete observation cannot retire a prepared or already claimed model`, t => {
    const host = setup(t), before = host.store.load(scope, 'run').snapshot, lease = host.store.acquire(scope, 'run', 'writer', 100, 30);
    const prepared = prepareEffect(before, 'model', 'requesting_model', { finalizationOnly: false });
    host.store.commit(scope, 'run', lease, 100, before.revision, prepared);
    const intent = prepared.intents[0], request = commandProbe(prepared.snapshot, host.config, intent);
    const batch = stageCommandObservations(prepared.snapshot, host.config, request, [notice()], intent);
    const forged = structuredClone(batch); forged.snapshot.backgroundCommands[0].notified = false;
    assert.throws(() => host.store.commit(scope, 'run', lease, 100, prepared.snapshot.revision, forged), { code: 'receipt_without_claim' });
    host.store.claim(scope, 'run', lease, 100, intent.operationKey);
    const claimed = host.store.load(scope, 'run').snapshot;
    const late = transition(claimed, { pendingIntent: null }, [], { receipts: [{ operationKey: intent.operationKey,
      status: 'not_dispatched', result: { code: 'superseded_by_background_observation', executed: false } }] });
    assert.throws(() => host.store.commit(scope, 'run', lease, 100, claimed.revision, late), { code: 'receipt_without_claim' });
  });
  test(`${backend}: observation wall time is charged before inference can claim its budget`, async t => {
    const host = setup(t, { limits: { maxWallMs: 20 } }); let now = 100;
    const result = await drive(host.store, async () => { now += 30; return []; }, async () => assert.fail(), { now: () => now }).runUntilIdle(scope, 'run');
    assert.equal(result.reason, 'execution_budget_exhausted'); assert.equal(result.activeElapsedMs, 30); assert.equal(result.usage.modelCalls, 0);
  });
  test(`${backend}: a new lease fences an old observer before it can append a notice`, async t => {
    const host = setup(t, { limits: { leaseMs: 30 } }); let entered, complete, now = 100;
    const started = new Promise(resolve => { entered = resolve; });
    const kernel = drive(host.store, async () => { entered(); return await new Promise(resolve => { complete = resolve; }); }, async () => assert.fail(), { now: () => now });
    const running = kernel.runUntilIdle(scope, 'run'); await started;
    now = 1_000; const replacement = host.store.acquire(scope, 'run', 'replacement', now, 30);
    complete([notice()]); await assert.rejects(running, { code: 'stale_fence' });
    assert.equal(messages(host.store.load(scope, 'run').snapshot).length, 0); host.store.release(scope, 'run', replacement);
    const result = await drive(host.store, async () => [notice()], async () => final(), { now: () => now }).runUntilIdle(scope, 'run');
    assert.equal(result.phase, 'completed'); assert.equal(messages(result).length, 1);
  });
  test(`${backend}: continuation inherits a still-running handle but observes it in the current session and run`, async t => {
    const host = setup(t); await drive(host.store, async () => []).runUntilIdle(scope, 'run');
    host.reopen(); let requested;
    const kernel = drive(host.store, async request => { requested = request; return [notice()]; });
    const previous = host.store.load(scope, 'run').snapshot;
    kernel.start({ ...previous, runId: 'next', turnId: 'next-turn', parentRunId: 'run' }, host.config, { expectedParentRunId: 'run' });
    const result = await kernel.runUntilIdle(scope, 'next'); assert.equal(result.phase, 'completed');
    assert.equal(requested.runId, 'next'); assert.equal(requested.sessionId, 'session'); assert.equal(requested.refs[0].sourceRunId, 'run');
    assert.equal(messages(result).length, 1); assert.equal(host.store.load(scope, 'run').snapshot.backgroundCommands[0].notified, false);
  });
  test(`${backend}: a real launch receipt owns the handle before its notification reaches the next model`, async t => {
    const host = setup(t, {}, { backgroundCommands: [], usage: emptyUsage(), phase: 'created' }); let calls = 0, launches = 0;
    const kernel = new NativeKernel({ store: host.store, digest, owner: 'whole-loop', ports: {
      model: { generate: async request => {
        if (++calls === 1) return { kind: 'tool_calls', text: '', toolCalls: [{ callId: 'launch', name: 'run_command', arguments: {} }], usage: emptyUsage() };
        assert.equal(request.messages.filter(message => message.kind === 'background_command_observation').length, 1); return final();
      } },
      tools: { execute: async request => { launches++; return { status: 'ok', content: { task_id: 'a'.repeat(64) },
        backgroundCommandRef: ref({ operationKey: request.operationKey }) }; } },
      background: { contract: BACKGROUND_COMMAND_CONTRACT, observe: async request => {
        const record = host.store.load(scope, 'run');
        assert.equal(record.receipts.find(item => item.operationKey === request.refs[0].operationKey).status, 'committed');
        return [notice(request.refs[0])];
      } },
    } });
    const result = await kernel.runUntilIdle(scope, 'run'); assert.equal(result.phase, 'completed');
    assert.equal(launches, 1); assert.equal(calls, 2); assert.equal(result.usage.toolCalls, 1); assert.equal(result.backgroundCommands[0].notified, true);
  });
}
