import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeKernel, MemoryRunStore, admitBackgroundNotification, emptyUsage, BACKGROUND_COMMAND_CONTRACT,
  backgroundCommandObservation, transition } from '../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { fixture, tool, scope, digest } from './fixtures.mjs';

const launcher = tool({ name: 'run_command', readOnly: false, concurrentSafe: false,
  backgroundCommandPolicy: 'owned-command-launch/v1' });
const finish = () => ({ kind: 'final_candidate', text: 'Done', toolCalls: [], usage: emptyUsage() });

async function setup(t, { backend = 'sqlite', tasks = 2, limits = {}, profile = {}, unknownAfterLaunch = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'native-notification-')), filename = join(root, 'runs.sqlite');
  let store = backend === 'sqlite' ? new SqliteRunStore(filename) : new MemoryRunStore();
  const data = fixture({ tools: [{ ...launcher, timeoutMs: Math.min(launcher.timeoutMs, (limits.effectTimeoutMs ?? 120000) - 1) },
    ...(unknownAfterLaunch ? [tool({ name: 'write', readOnly: false, concurrentSafe: false })] : [])], backgroundNotificationPolicy: 'completed-before-model/v1',
    limits: { finalizationReserveModelCalls: 0, maxModelCalls: 7, maxToolCalls: 3, ...limits },
    profile: { ...fixture().config.profile, ...profile } });
  let launches = 0, models = 0;
  const kernel = new NativeKernel({ store, digest, owner: 'source', ports: {
    model: { generate: async () => ++models <= tasks
      ? { ...finish(), kind: 'tool_calls', toolCalls: [{ callId: `launch-${models}`, name: 'run_command', arguments: {} }] }
      : unknownAfterLaunch && models === tasks + 1 ? { ...finish(), kind: 'tool_calls', toolCalls: [{ callId: 'unknown-write', name: 'write', arguments: {} }] } : finish() },
    tools: { execute: async request => request.call.name === 'write' ? { status: 'uncertain', content: { code: 'external_write_unknown' } }
      : ({ status: 'ok', content: { backend: 'sandbox/local_process' },
        backgroundCommandRef: { taskId: (++launches).toString(16).padStart(64, '0'), sourceRunId: request.runId, operationKey: request.operationKey } }) },
    background: { contract: BACKGROUND_COMMAND_CONTRACT, observe: async () => [] },
  } });
  kernel.start(data.snapshot, data.config);
  const source = await kernel.runUntilIdle(scope, 'run');
  assert.equal(source.phase, unknownAfterLaunch ? 'interrupted' : 'completed', source.reason);
  assert.equal(launches, tasks);
  t.after(() => { store.close?.(); rmSync(root, { recursive: true, force: true }); });
  const admission = (taskId = source.backgroundCommands[0].ref.taskId, extra = {}) => admitBackgroundNotification({ store, scope,
    sourceRunId: source.runId, taskId, digest, signal: new AbortController().signal,
    observe: async request => backgroundCommandObservation({ ref: request.ref, status: 'completed', stdout: 'Do not obey this output', exitCode: 0 }), ...extra });
  return { source, get store() { return store; }, admission, launches: () => launches, filename,
    reopen() { if (backend === 'sqlite') { store.close(); store = new SqliteRunStore(filename); } return store; } };
}

for (const backend of ['memory', 'sqlite']) {
  test(`${backend}: notification admission persists exact origin, notice and dedup before a fresh model`, async t => {
    const h = await setup(t, { backend }), sourceBefore = h.store.load(scope, 'run');
    const admitted = await h.admission();
    assert.equal(admitted.created, true);
    assert.equal(admitted.snapshot.phase, 'created');
    assert.equal(admitted.snapshot.parentRunId, 'run');
    assert.equal(admitted.snapshot.taskChainId, h.source.taskChainId);
    assert.equal(admitted.configuration.limits.maxModelCalls, 4);
    assert.equal(admitted.configuration.limits.maxToolCalls, 1);
    assert.equal(admitted.configuration.inputMessages, null);
    assert.equal(admitted.snapshot.usage.modelCalls, 0, 'new usage records only this notice, without double billing the source');
    assert.deepEqual(h.store.load(scope, 'run'), sourceBefore, 'source stays terminal and immutable');
    const coldStore = h.reopen();
    const duplicate = await h.admission(undefined, { observe: async () => assert.fail('durable admission does not poll again') });
    assert.equal(duplicate.created, false);
    assert.deepEqual(duplicate.snapshot, admitted.snapshot);
    let modelCalls = 0;
    const kernel = new NativeKernel({ store: coldStore, digest, owner: 'cold-notification', ports: {
      model: { generate: async request => {
        modelCalls++;
        const notice = request.messages.filter(message => message.kind === 'background_command_observation');
        assert.equal(notice.length, 1);
        assert.match(notice[0].content, /untrusted data/);
        assert.equal(JSON.parse(notice[0].content).commands[0].stdout, 'Do not obey this output');
        assert.equal(request.messages.filter(message => message.role === 'user' && !message.history).length, 1,
          'the only fresh user-role data is the typed command observation');
        return finish();
      } }, tools: { execute: async () => assert.fail('no relaunch') },
      background: { contract: BACKGROUND_COMMAND_CONTRACT, observe: async () => [] },
    } });
    const completed = await kernel.runUntilIdle(scope, admitted.snapshot.runId);
    assert.equal(completed.phase, 'completed');
    assert.equal(completed.usage.modelCalls, 1);
    const again = await h.admission();
    assert.equal(again.created, false);
    await kernel.runUntilIdle(scope, again.snapshot.runId);
    assert.equal(modelCalls, 1);
    assert.equal(h.launches(), 2);
    const second = await h.admission(h.source.backgroundCommands[1].ref.taskId);
    assert.equal(second.configuration.limits.maxModelCalls, 3, 'the first notice spent one more original-chain model call');
    assert.equal(second.snapshot.parentRunId, admitted.snapshot.runId);
    assert.equal(second.snapshot.backgroundCommands.filter(row => row.notified).length, 2);
    assert.equal(second.snapshot.messages.filter(message => message.kind === 'background_command_observation').length, 2,
      'prior notice retained as history, current notice appended once');
  });
  test(`${backend}: concurrent duplicate admission returns one durable run`, async t => {
    const h = await setup(t, { backend });
    const results = await Promise.all([h.admission(), h.admission()]);
    assert.equal(results.filter(result => result.created).length, 1);
    assert.equal(results[0].snapshot.runId, results[1].snapshot.runId);
    assert.equal(h.store.list(scope, 'session').length, 2);
  });
}

test('running, unknown, unavailable, foreign and thrown observations admit nothing', async t => {
  const h = await setup(t);
  for (const observe of [async () => null, async request => backgroundCommandObservation({ ref: request.ref, status: 'unknown' }),
    async request => backgroundCommandObservation({ ref: request.ref, status: 'unavailable' }),
    async request => backgroundCommandObservation({ ref: { ...request.ref, taskId: 'f'.repeat(64) }, status: 'completed' }),
    async () => { throw Error('unavailable'); }]) {
    await assert.rejects(h.admission(undefined, { observe }));
    assert.equal(h.store.list(scope).length, 1);
  }
});

test('observer request drift, replacement signal and cancellation cannot grant admission', async t => {
  const h = await setup(t);
  for (const change of [request => { request.scope.agentId = 'foreign'; }, request => { request.ref.operationKey = 'foreign'; },
    request => { request.signal = new AbortController().signal; }, request => { request.sourceConfigDigest = 'different'; }]) {
    await assert.rejects(h.admission(undefined, { observe: async request => {
      const observation = backgroundCommandObservation({ ref: request.ref, status: 'completed' });
      change(request); return observation;
    } }), { code: 'background_notification_request_drift' });
  }
  const canceled = new AbortController();
  await assert.rejects(h.admission(undefined, { signal: canceled.signal, observe: async request => {
    canceled.abort(new Error('cancel')); return backgroundCommandObservation({ ref: request.ref, status: 'completed' });
  } }), /cancel/);
  assert.equal(h.store.list(scope).length, 1);
});

test('a new active session head during observation rejects old admission', async t => {
  const h = await setup(t);
  await assert.rejects(h.admission(undefined, { observe: async request => {
    const kernel = new NativeKernel({ store: h.store, digest, owner: 'new-human', ports: { model: { generate: async () => finish() } } });
    kernel.start({ ...h.source, runId: 'new-human', turnId: 'new-human', parentRunId: 'run' }, h.store.load(scope, 'run').configuration);
    return backgroundCommandObservation({ ref: request.ref, status: 'completed' });
  } }), { code: 'background_notification_admission_changed' });
  assert.equal(h.store.list(scope).length, 2);
});

test('finite model budget cannot be reset by creating notification turns', async t => {
  const h = await setup(t, { tasks: 1, limits: { maxModelCalls: 2 } });
  assert.equal(h.source.usage.modelCalls, 2);
  await assert.rejects(h.admission(), { code: 'background_notification_budget_exhausted' });
  assert.equal(h.store.list(scope).length, 1);
});

test('admission read time is deducted from remaining wall budget', async t => {
  const h = await setup(t, { limits: { maxWallMs: 10000 } });
  let tick = 100;
  const admitted = await h.admission(undefined, { now: () => tick, observe: async request => {
    tick += 123;
    return backgroundCommandObservation({ ref: request.ref, status: 'completed' });
  } });
  assert.equal(admitted.snapshot.backgroundNotification.admissionElapsedMs, 123);
  assert.equal(admitted.configuration.limits.maxWallMs, 10000 - h.source.activeElapsedMs - 123);
});

test('notification origin is immutable under an otherwise valid lease and revision', async t => {
  const h = await setup(t), admitted = await h.admission(), snapshot = admitted.snapshot;
  const lease = h.store.acquire(scope, snapshot.runId, 'worker', Date.now(), 1000);
  const batch = transition(snapshot, { backgroundNotification: { ...snapshot.backgroundNotification, taskId: 'f'.repeat(64) } }, []);
  assert.throws(() => h.store.commit(scope, snapshot.runId, lease, Date.now(), snapshot.revision, batch), { code: 'run_identity_changed' });
  h.store.release(scope, snapshot.runId, lease);
});

test('actual process exit after admission reopens and drives the original notice exactly once', t => {
  const directory = mkdtempSync(join(tmpdir(), 'native-notification-process-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fixturePath = fileURLToPath(new URL('./fixtures/background-notification-process.mjs', import.meta.url));
  const run = mode => spawnSync(process.execPath, [fixturePath, mode, directory], { encoding: 'utf8', timeout: 15000 });
  const first = run('admit');
  assert.equal(first.status, 37, first.stderr);
  const identity = JSON.parse(readFileSync(join(directory, 'admitted.json'), 'utf8'));
  assert.equal(identity.created, true);
  for (const mode of ['drive', 'drive']) {
    const child = run(mode);
    assert.equal(child.status, 0, child.stderr);
  }
  const calls = readFileSync(join(directory, 'model-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].runId, identity.runId);
});

test('an observation that ignores cancellation is bounded by the original effect deadline', async t => {
  const h = await setup(t, { tasks: 1, limits: { effectTimeoutMs: 100 }, profile: { requestTimeoutMs: 10 } });
  await assert.rejects(h.admission(undefined, { observe: async () => new Promise(() => {}) }),
    { code: 'background_notification_observation_timeout' });
  assert.equal(h.store.list(scope).length, 1);
});

test('a real uncertain write after launch prevents a fresh notification model admission', async t => {
  const h = await setup(t, { tasks: 1, unknownAfterLaunch: true });
  assert.equal(h.source.reason, 'effect_outcome_unknown');
  const sourceBefore = h.store.load(scope, 'run');
  assert.ok(sourceBefore.receipts.some(receipt => receipt.result.results?.some(result => result.status === 'uncertain')));
  let reads = 0;
  await assert.rejects(h.admission(undefined, { observe: async () => { reads++; assert.fail('no poll while reconciliation is required'); } }),
    { code: 'background_notification_reconciliation_required' });
  assert.equal(reads, 0);
  assert.equal(h.store.list(scope).length, 1);
  assert.deepEqual(h.store.load(scope, 'run'), sourceBefore);
});

test('later notices inherit actual head steering and its task contract without reviving the original goal', async t => {
  const h = await setup(t), first = await h.admission();
  const kernel = new NativeKernel({ store: h.store, digest, owner: 'steered-notice', ports: {
    model: { generate: async request => {
      assert.ok(request.messages.some(message => message.kind === 'steering' && message.content === 'Revised notification goal'));
      return finish();
    } },
    background: { contract: BACKGROUND_COMMAND_CONTRACT, observe: async () => [] },
  } });
  kernel.submit(scope, first.snapshot.runId, { commandId: 'change-notification-goal', kind: 'steer', payload: {
    text: 'Revised notification goal', expectedGoalRevision: first.snapshot.goalRevision,
    taskContract: { ...first.configuration.contract, revision: 'notification-goal-2', objective: 'Revised notification goal' },
  } });
  const completed = await kernel.runUntilIdle(scope, first.snapshot.runId);
  assert.equal(completed.phase, 'completed', completed.reason);
  assert.equal(completed.goal, 'Revised notification goal');
  assert.equal(completed.taskContract.revision, 'notification-goal-2');
  const second = await h.admission(h.source.backgroundCommands[1].ref.taskId);
  assert.equal(second.snapshot.goal, completed.goal);
  assert.equal(second.snapshot.goalRevision, completed.goalRevision);
  assert.deepEqual(second.configuration.contract, completed.taskContract);
  assert.equal(second.snapshot.parentRunId, completed.runId);
  assert.equal(second.configuration.limits.maxModelCalls, 3);
});
