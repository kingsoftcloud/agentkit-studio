import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { NativeKernel, MemoryRunStore, BACKGROUND_COMMAND_CONTRACT, admitBackgroundNotification,
  backgroundCommandObservation, canonical, emptyUsage } from '@kingsoftcloud/agentkit-harness-core';
import { fixture, tool, scope, digest } from './fixtures/native-core.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { readNativeDshOwnership } from '@kingsoftcloud/agentkit-harness-node/native/dsh-turn-ownership';
import { nativeDshBackgroundOwnership, readNativeDshBackgroundOwnership, verifyNativeDshBackgroundOwnership,
  nativeDshIdleOwnershipHost } from '@kingsoftcloud/agentkit-harness-node/native/dsh-background-ownership';

const final = () => ({ kind: 'final_candidate', text: 'Done', toolCalls: [], usage: emptyUsage() });
const signal = () => new AbortController().signal;
async function setup(t, sqlite = true) {
  const root = mkdtempSync(join(tmpdir(), 'native-background-owner-')), filename = join(root, 'runs.sqlite');
  let store = sqlite ? new SqliteRunStore(filename) : new MemoryRunStore();
  t.after(() => { store?.close?.(); rmSync(root, { force: true, recursive: true }); });
  const data = fixture({ tools: [tool({ name: 'run_command', readOnly: false, concurrentSafe: false,
    backgroundCommandPolicy: 'owned-command-launch/v1' })], backgroundNotificationPolicy: 'completed-before-model/v1',
    inputMessages: [{ role: 'user', content: 'original goal' }],
    limits: { maxModelCalls: 7, maxToolCalls: 3, finalizationReserveModelCalls: 0 } });
  let launches = 0, sourceModels = 0;
  const kernel = new NativeKernel({ store, digest, owner: 'original-source', ports: {
    model: { generate: async () => ++sourceModels === 1 ? { ...final(), kind: 'tool_calls',
      toolCalls: [{ callId: 'launch', name: 'run_command', arguments: {} }] } : final() },
    tools: { execute: async request => { launches++; return { status: 'ok', content: { backend: 'sandbox/local_process' },
      backgroundCommandRef: { taskId: 'a'.repeat(64), sourceRunId: request.runId, operationKey: request.operationKey } }; } },
    background: { contract: BACKGROUND_COMMAND_CONTRACT, observe: async () => [] },
  } });
  kernel.start(data.snapshot, data.config);
  assert.equal((await kernel.runUntilIdle(scope, 'run')).phase, 'completed');
  const source = store.load(scope, 'run');
  const admitted = await admitBackgroundNotification({ store, scope, sourceRunId: 'run', taskId: 'a'.repeat(64),
    signal: signal(), digest, observe: async read => backgroundCommandObservation({ ref: read.ref,
      status: 'completed', exitCode: 0, stdout: 'untrusted terminal output' }) });
  const record = store.load(scope, admitted.snapshot.runId), turn = 17;
  const ownership = nativeDshBackgroundOwnership({ record, turn });
  return { get store() { return store; }, source, record, ownership, root, filename, turn,
    launches: () => launches, sourceModels: () => sourceModels,
    close() { store.close?.(); store = null; },
    verify: (owner = ownership, options = {}) => verifyNativeDshBackgroundOwnership(owner, {
      store, scope, sessionId: 'session', turn, signal: signal(), ...options }) };
}

for (const sqlite of [false, true]) {
  const backend = sqlite ? 'SQLite' : 'memory';
  test(`${backend}: original notice identity and reduced budgets survive independent numeric delivery positions`, async t => {
    const h = await setup(t, sqlite), before = h.store.load(scope, h.record.snapshot.runId);
    const parsed = readNativeDshBackgroundOwnership(h.ownership, { sessionId: 'session', turn: h.turn });
    assert.equal(parsed.identity.turnId, parsed.identity.runId);
    assert.notEqual(parsed.identity.turnId, String(h.turn));
    assert.equal(parsed.configuration.limits.maxModelCalls, 5);
    assert.equal(parsed.configuration.limits.maxToolCalls, 2);
    assert.equal(parsed.configuration.inputMessages, null);
    assert.equal(Object.hasOwn(parsed, 'messages'), false, 'no invented user request');
    assert.equal(Object.hasOwn(parsed, 'ports'), false, 'no persisted execution authority');
    const changedPosition = nativeDshBackgroundOwnership({ record: h.record, turn: h.turn + 1 });
    assert.equal(changedPosition.binding, h.ownership.binding, 'crash before owner flush does not recreate a Native notice');
    assert.equal(changedPosition.turn, h.turn + 1);
    assert.deepEqual((await h.verify()).record, before);
    assert.deepEqual(h.store.load(scope, 'run'), h.source);
    assert.deepEqual(h.store.load(scope, h.record.snapshot.runId), before);
    assert.throws(() => readNativeDshOwnership(h.ownership, { sessionId: 'session', turn: h.turn }), /ownership_invalid/,
      'a notice cannot be resumed as a normal user turn');
    assert.equal(h.launches(), 1); assert.equal(h.sourceModels(), 2);
  });

  test(`${backend}: wire configuration, origin and complete identity cannot replace persisted admission`, async t => {
    const h = await setup(t, sqlite);
    for (const mutate of [value => { value.identity.buildId = 'foreign-build'; },
      value => { value.identity.parentRunId = 'foreign-parent'; },
      value => { value.identity.taskChainId = 'foreign-chain'; },
      value => { value.notification.requestDigest = 'b'.repeat(64); },
      value => { value.notification.sourceConfigDigest = 'b'.repeat(64); },
      value => { value.notification.admissionElapsedMs++; },
      value => { value.configuration.limits.maxModelCalls++; value.configDigest = digest(value.configuration); }]) {
      const admission = readNativeDshBackgroundOwnership(h.ownership, { sessionId: 'session', turn: h.turn });
      mutate(admission);
      await assert.rejects(h.verify({ ...h.ownership, binding: canonical(admission) }),
        { code: 'native_dsh_background_stored_admission_changed' });
    }
    await assert.rejects(h.verify(h.ownership, { scope: { ...scope, userId: 'foreign-user' } }),
      { code: 'native_dsh_background_scope_mismatch' });
    assert.throws(() => readNativeDshBackgroundOwnership(h.ownership, { sessionId: 'foreign-session', turn: h.turn }), /identity_invalid/);
    assert.throws(() => readNativeDshBackgroundOwnership(h.ownership, { sessionId: 'session', turn: h.turn + 1 }), /ownership_invalid/);
    const before = h.store.list(scope);
    const canceled = new AbortController(); canceled.abort(Error('canceled recovery'));
    await assert.rejects(h.verify(h.ownership, { signal: canceled.signal }), /canceled recovery/);
    await assert.rejects(h.verify(h.ownership, { signal: undefined }), /signal_required/);
    assert.deepEqual(h.store.list(scope), before);
  });

  test(`${backend}: strict versioned decoding rejects malformed or noncanonical records`, async t => {
    const h = await setup(t, sqlite);
    for (const mutate of [value => { value.contract = 'future/v2'; }, value => { value.jsonCodec = 'future/v2'; },
      value => { value.identity.turnId = String(h.turn); }, value => { value.notification.taskId = 'not-a-task'; },
      value => { value.notification.admissionElapsedMs = -1; }, value => { value.notification.extra = true; },
      value => { value.configuration.inputMessages = [{ role: 'user', content: 'new goal' }]; value.configDigest = digest(value.configuration); },
      value => { value.configuration.instructions = 'changed'; }, value => { value.messages = []; },
      value => { value.ports = {}; }]) {
      const admission = readNativeDshBackgroundOwnership(h.ownership, { sessionId: 'session', turn: h.turn });
      mutate(admission);
      assert.throws(() => readNativeDshBackgroundOwnership({ ...h.ownership, binding: canonical(admission) },
        { sessionId: 'session', turn: h.turn }));
    }
    assert.throws(() => readNativeDshBackgroundOwnership({ ...h.ownership, binding: h.ownership.binding + ' ' },
      { sessionId: 'session', turn: h.turn }), /admission_invalid/);
    for (const turn of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
      assert.throws(() => nativeDshBackgroundOwnership({ record: h.record, turn }), /ownership_invalid/);
  });

  test(`${backend}: the admitted live notice reserves the session against competing human work`, async t => {
    const h = await setup(t, sqlite);
    const kernel = new NativeKernel({ store: h.store, digest, owner: 'new-head', ports: {} });
    assert.throws(() => kernel.start({ ...h.record.snapshot, runId: 'new-human', turnId: 'human', parentRunId: h.record.snapshot.runId,
      backgroundNotification: null }, h.record.configuration), { code: 'session_already_active' });
    assert.equal((await h.verify()).record.snapshot.runId, h.record.snapshot.runId);
    assert.equal(h.store.list(scope).length, 2);
    assert.equal(h.store.load(scope, h.record.snapshot.runId).snapshot.phase, 'created');
    assert.equal(h.launches(), 1);
  });

  test(`${backend}: a well-formed owner cannot recreate a missing notice or mint launch authority`, async t => {
    const h = await setup(t, sqlite);
    const forged = structuredClone(h.record);
    forged.snapshot.backgroundNotification.taskId = 'b'.repeat(64);
    forged.snapshot.runId = 'wake_' + digest({ contract: forged.snapshot.backgroundNotification.contract, scope,
      sourceRunId: 'run', taskId: 'b'.repeat(64) });
    forged.snapshot.turnId = forged.snapshot.runId;
    const owner = nativeDshBackgroundOwnership({ record: forged, turn: h.turn });
    assert.equal(readNativeDshBackgroundOwnership(owner, { sessionId: 'session', turn: h.turn }).identity.runId, forged.snapshot.runId);
    const before = h.store.list(scope);
    await assert.rejects(h.verify(owner), { code: 'run_not_found' });
    assert.deepEqual(h.store.list(scope), before);
    assert.equal(h.launches(), 1); assert.equal(h.sourceModels(), 2);
  });

  test(`${backend}: completed redelivery validates the original launch without model execution or relaunch`, async t => {
    const h = await setup(t, sqlite); let models = 0;
    const verified = await h.verify();
    const kernel = new NativeKernel({ store: h.store, digest, owner: 'notice', ports: {
      model: { generate: async request => { models++;
        assert.equal(request.messages.filter(message => message.kind === 'background_command_observation').length, 1);
        return final(); } }, tools: { execute: async () => assert.fail('notice must not relaunch') },
      background: { contract: BACKGROUND_COMMAND_CONTRACT, observe: async () => [] },
    } });
    assert.equal((await kernel.runUntilIdle(scope, verified.record.snapshot.runId)).phase, 'completed');
    const before = h.store.load(scope, h.record.snapshot.runId);
    assert.equal((await h.verify()).record.snapshot.phase, 'completed');
    await kernel.runUntilIdle(scope, h.record.snapshot.runId);
    assert.equal(models, 1); assert.equal(h.launches(), 1);
    assert.deepEqual(h.store.load(scope, h.record.snapshot.runId), before);
    assert.deepEqual(h.store.load(scope, 'run'), h.source);
  });
}

test('idle admission requires both provider advertisement and an implemented method', () => {
  const base = { contract: 'dsh.external-turn-host/v1', claim() {}, pending() {}, resume() {} };
  for (const externalTurns of [base, { ...base, start() {} }, { ...base, idleAdmissionContract: 'dsh.external-turn-start/v1' },
    { ...base, idleAdmissionContract: 'future/v2', start() {} }])
    assert.throws(() => nativeDshIdleOwnershipHost({ externalTurns }), /idle_ownership_host_required/);
  const current = { ...base, idleAdmissionContract: 'dsh.external-turn-start/v1', start() {} };
  assert.equal(nativeDshIdleOwnershipHost({ externalTurns: current }), current);
});

test('separate SQLite processes revalidate ownership and drive an existing notice once', async t => {
  const h = await setup(t), ownerPath = join(h.root, 'ownership.json');
  writeFileSync(ownerPath, canonical(h.ownership));
  h.close();
  const worker = fileURLToPath(new URL('./fixtures/native-background-owner-process.mjs', import.meta.url));
  const runs = [1, 0].map(expectedModels => {
    const result = spawnSync(process.execPath, [worker, h.filename, ownerPath], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.models, expectedModels); assert.equal(output.phase, 'completed');
    assert.equal(output.sourcePhase, 'completed');
    return output;
  });
  assert.equal(runs[0].runId, runs[1].runId);
  assert.equal(runs[0].sourceDigest, runs[1].sourceDigest);
});
