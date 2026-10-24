import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createManagedNativeKernel } from '../src/providers/native-managed-kernel.mjs';
import { permitIssuer, command, target, scope, binding, response, tool } from './fixtures/native-managed-kernel.mjs';

const spec = Object.freeze({ grant_id: 'occurrence/member', tenant_id: target.tenantId, agent_instance_id: target.agentInstanceId,
  session_id: 'a2a-kernel-managed', owner_ref: 'trusted-host/team/member', attempt_epoch: null });
const timed = Object.freeze({ ...spec, attempt_epoch: 7 });
const governed = (s = spec, fields = {}) => command({ session_id: s.session_id, ...fields,
  payload: { content: 'Original governed work', execution_grant_id: s.grant_id,
    ...(s.attempt_epoch === null ? {} : { execution_grant_attempt_epoch: s.attempt_epoch }), ...fields.payload } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(t, options = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'managed-grants-'))), issuer = permitIssuer();
  let wall = Date.now(), mono = 10000, models = 0, lookups = 0, failCommit = false;
  const config = { directory, target, permitVerifier: issuer.verifier, assertCurrent: () => true, autoStart: false,
    clock: () => wall, monotonic: () => mono,
    beforeCommit() { if (failCommit) throw Error('injected transaction failure'); },
    resolveBinding(request) {
      lookups++;
      return binding(request.command, { model: { generate: async () => { models++; return response(); } },
        tools: { execute: async () => assert.fail('unexpected tool') } });
    }, ...options };
  let runtime = createManagedNativeKernel(config);
  const others = [];
  t.after(async () => { for (const owner of others) await owner.close(); await runtime.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, issuer, config, get runtime() { return runtime; }, get grants() { return runtime.executionGrants; },
    get models() { return models; }, get lookups() { return lookups; },
    set failCommit(value) { failCommit = value; },
    advance({ wallMs = 0, monoMs = 0 }) { wall += wallMs; mono += monoMs; },
    deadline(ms = 60000) { return new Date(wall + ms).toISOString(); },
    receive: cmd => runtime.receive(cmd, issuer.issue(cmd)),
    async reopen() { await runtime.close(); runtime = createManagedNativeKernel(config); return runtime; },
    another(options = {}) { const owner = createManagedNativeKernel({ ...config, ...options }); others.push(owner); return owner; },
    inspect(receipt) { return runtime.inspectSession({ scope, sessionId: spec.session_id, runId: receipt.run_id }); },
    rows(table) { const db = new DatabaseSync(join(directory, 'commands.sqlite'), { readOnly: true });
      try { return db.prepare(`SELECT * FROM ${table}`).all(); } finally { db.close(); } },
  };
}

test('only trusted composition creates grants; signed commands require exact existing tenant/session/epoch', async t => {
  const f = fixture(t), first = governed();
  assert.equal(f.runtime.capabilities.executionGrants, true);
  assert.equal((await f.receive(first)).error.code, 'execution_grant_not_found'); assert.equal(f.lookups, 0);
  f.grants.ensure(spec);
  assert.throws(() => f.grants.ensure({ ...spec, owner_ref: 'other' }), { code: 'execution_grant_scope_mismatch' });
  assert.throws(() => f.grants.ensure({ ...spec, tenant_id: 'other' }), { code: 'execution_grant_scope_mismatch' });
  assert.throws(() => f.grants.ensure({ ...spec, caller_policy: true }), { code: 'execution_grant_spec_invalid' });
  const wrong = governed({ ...spec, session_id: 'foreign' });
  assert.equal((await f.receive(wrong)).error.code, 'execution_grant_scope_mismatch');
  assert.equal((await f.receive(governed(spec, { payload: { execution_grant_attempt_epoch: 2 } }))).error.code,
    'execution_grant_attempt_epoch_mismatch');
  const receipt = await f.receive(first); assert.equal(receipt.status, 'accepted');
  assert.deepEqual(f.grants.get(spec).queued_message_ids, [receipt.message_id]);
  await f.runtime.drain(first.session_id); assert.equal(f.models, 1);
  assert.deepEqual(f.grants.get(spec).settled_message_ids, [receipt.message_id]);
  assert.equal(f.grants.get(spec).commands[0].run_id, receipt.run_id);
});

test('invalid grant locators and attempt epoch without an id are rejected before resource lookup', async t => {
  const f = fixture(t);
  for (const payload of [{ execution_grant_id: ' spaced ' }, { execution_grant_id: '' },
    { execution_grant_id: 'x'.repeat(513) }, { execution_grant_attempt_epoch: 1 }]) {
    await assert.rejects(f.receive(command({ payload: { content: 'x', ...payload } })), /execution_grant_/u);
  }
  await assert.rejects(f.receive(command({ command_type: 'interrupt', payload: { execution_grant_id: 'x' } })),
    { code: 'execution_grant_id_invalid' });
  assert.equal(f.lookups, 0);
});

test('suspension preserves original FIFO admissions; later grant cannot skip blocked head', async t => {
  const f = fixture(t), later = { ...spec, grant_id: 'later-occurrence' };
  f.grants.ensure(spec); f.grants.ensure(later);
  f.grants.setState(spec, 'suspended', { expected_revision: 1, idempotency_key: 'suspend' });
  const one = await f.receive(governed()), two = await f.receive(governed(later));
  assert.equal(one.status, 'accepted'); assert.equal(two.status, 'accepted');
  await assert.rejects(f.runtime.drain(spec.session_id), { code: 'execution_grant_suspended' }); assert.equal(f.models, 0);
  assert.equal(f.rows('managed_command_claims').length, 0);
  f.grants.setState(spec, 'active', { expected_revision: 2, idempotency_key: 'resume' });
  await f.runtime.drain(spec.session_id); assert.equal(f.models, 2);
  assert.deepEqual(f.grants.get(spec).settled_message_ids, [one.message_id]);
  assert.deepEqual(f.grants.get(later).settled_message_ids, [two.message_id]);
});

test('revocation atomically discards only unqualified original commands and never revives them', async t => {
  const f = fixture(t), next = { ...spec, grant_id: 'next-occurrence' }; f.grants.ensure(spec); f.grants.ensure(next);
  const cmd = governed(), one = await f.receive(cmd), two = await f.receive(governed(next));
  const barrier = f.grants.setState(spec, 'revoked', { expected_revision: 1, idempotency_key: 'stop' });
  assert.deepEqual(barrier.discarded_message_ids, [one.message_id]); assert.equal(f.inspect(one).commandState, 'discarded');
  assert.equal(f.inspect(one).retryable, false);
  assert.throws(() => f.grants.setState(spec, 'active', { expected_revision: 2, idempotency_key: 'revive' }), { code: 'execution_grant_irreversible' });
  assert.equal((await f.receive(governed())).error.code, 'execution_grant_revoked');
  const duplicate = await f.receive(cmd); assert.equal(duplicate.status, 'duplicate'); assert.equal(duplicate.message_id, one.message_id);
  await f.runtime.drain(spec.session_id); assert.equal(f.models, 1);
  assert.deepEqual(f.grants.get(next).settled_message_ids, [two.message_id]);
  await f.reopen(); assert.deepEqual(f.grants.lookup(spec, { idempotency_key: 'stop' }), barrier);
  assert.deepEqual(f.grants.setState(spec, 'revoked', { expected_revision: 1, idempotency_key: 'stop' }), barrier);
});

for (const state of ['revoked', 'suspended', 'admission_paused']) test(`legacy qualification precedes async binding and survives ${state}`, async t => {
  const entered = deferred(), release = deferred(); let models = 0;
  const f = fixture(t, { resolveBinding: async request => {
    if (request.stage === 'execute') { entered.resolve(); await release.promise; }
    return binding(request.command, { model: { generate: async () => { models++; return response(); } } });
  } });
  t.after(() => release.resolve()); f.grants.ensure(spec);
  const cmd = governed(), receipt = await f.receive(cmd), work = f.runtime.drain(cmd.session_id); await entered.promise;
  assert.deepEqual(f.grants.get(spec).in_flight_message_ids, [receipt.message_id]);
  if (state === 'admission_paused') f.grants.setAdmission(spec, false, { expected_revision: 1, idempotency_key: 'stop' });
  else f.grants.setState(spec, state, { expected_revision: 1, idempotency_key: 'stop' });
  assert.deepEqual(f.grants.get(spec).discarded_message_ids, []);
  release.resolve(); await work; assert.equal(models, 1);
  assert.deepEqual(f.grants.get(spec).settled_message_ids, [receipt.message_id]);
});

test('grant revocation during asynchronous admission lookup is rechecked in the admission transaction', async t => {
  const entered = deferred(), release = deferred();
  const f = fixture(t, { resolveBinding: async request => { entered.resolve(); await release.promise; return binding(request.command); } });
  t.after(() => release.resolve()); f.grants.ensure(spec);
  const receiving = f.receive(governed()); await entered.promise;
  f.another().executionGrants.setState(spec, 'revoked', { expected_revision: 1, idempotency_key: 'race' });
  release.resolve(); assert.equal((await receiving).error.code, 'execution_grant_revoked');
  assert.equal(f.rows('managed_commands').length, 0); assert.equal(f.rows('managed_runs').length, 0);
});

test('admission pause has independent revision, preserves in-flight eligibility and original mutation receipts', async t => {
  const f = fixture(t); f.grants.ensure(timed, { expires_at: f.deadline() });
  const pause = f.grants.setAdmission(timed, false, { expected_revision: 1, idempotency_key: 'pause' });
  assert.equal(pause.grant.revision, 1); assert.equal(pause.grant.admission_revision, 2);
  const receipt = await f.receive(governed(timed));
  await assert.rejects(f.runtime.drain(timed.session_id), { code: 'execution_grant_admission_paused' });
  assert.equal(f.grants.require(timed).state, 'active');
  const renewal = f.grants.renew(timed, { expected_revision: 1, expires_at: f.deadline(120000), renewal_id: 'renew' });
  assert.equal(renewal.grant.revision, 2); assert.equal(renewal.grant.admission_revision, 2);
  assert.throws(() => f.grants.setAdmission(timed, true, { expected_revision: 1, idempotency_key: 'stale' }),
    { code: 'execution_grant_admission_revision_conflict' });
  f.grants.setAdmission(timed, true, { expected_revision: 2, idempotency_key: 'resume' });
  await f.runtime.drain(timed.session_id); assert.equal(f.models, 1);
  assert.deepEqual(f.grants.get(timed).settled_message_ids, [receipt.message_id]);
  assert.deepEqual(f.grants.setAdmission(timed, false, { expected_revision: 1, idempotency_key: 'pause' }), pause,
    'a lost acknowledgement returns the original barrier, not a new current barrier');
  assert.throws(() => f.grants.setAdmission(timed, true, { expected_revision: 1, idempotency_key: 'pause' }),
    { code: 'execution_grant_idempotency_conflict' });
});

test('failed grant mutation rolls back state, discard barrier and idempotency receipt together', async t => {
  const f = fixture(t); f.grants.ensure(spec); const one = await f.receive(governed());
  f.failCommit = true;
  assert.throws(() => f.grants.setState(spec, 'revoked', { expected_revision: 1, idempotency_key: 'stop' }), /injected transaction failure/u);
  f.failCommit = false;
  assert.equal(f.grants.require(spec).revision, 1); assert.equal(f.grants.lookup(spec, { idempotency_key: 'stop' }), null);
  assert.deepEqual(f.grants.get(spec).queued_message_ids, [one.message_id]);
  const stopped = f.grants.setState(spec, 'revoked', { expected_revision: 1, idempotency_key: 'stop' });
  assert.deepEqual(stopped.discarded_message_ids, [one.message_id]);
});

test('claim and revoke across independent SQLite receivers have one transaction order', async t => {
  const f = fixture(t); f.grants.ensure(spec); const one = await f.receive(governed());
  const other = f.another(); other.executionGrants.setState(spec, 'revoked', { expected_revision: 1, idempotency_key: 'first-revoke' });
  await f.runtime.drain(spec.session_id); assert.equal(f.models, 0); assert.equal(f.rows('managed_command_claims').length, 0);
  assert.deepEqual(f.grants.get(spec).discarded_message_ids, [one.message_id]);
  const s = { ...spec, grant_id: 'qualified-second' }; f.grants.ensure(s);
  const receipt = await f.receive(governed(s)); await f.runtime.drain(spec.session_id);
  const barrier = other.executionGrants.setState(s, 'revoked', { expected_revision: 1, idempotency_key: 'after-claim' });
  assert.deepEqual(barrier.settled_message_ids, [receipt.message_id]); assert.equal(f.models, 1);
  assert.throws(() => f.grants.setState(s, 'revoked', { expected_revision: 1, idempotency_key: 'loser' }),
    { code: 'execution_grant_revision_conflict' });
});

test('absolute expiry and local monotonic deadline block claims after wall clock rollback; duplicate admission survives', async t => {
  const f = fixture(t); f.grants.ensure(timed, { expires_at: f.deadline() }); const cmd = governed(timed), receipt = await f.receive(cmd);
  f.advance({ wallMs: -3600000, monoMs: 60000 });
  await assert.rejects(f.runtime.drain(cmd.session_id), { code: 'execution_grant_expired' });
  assert.throws(() => f.grants.require(timed), { code: 'execution_grant_expired' });
  assert.throws(() => f.grants.renew(timed, { expected_revision: 1, expires_at: f.deadline(7200000), renewal_id: 'too-late' }),
    { code: 'execution_grant_expired' });
  assert.equal((await f.receive(governed(timed))).error.code, 'execution_grant_expired');
  assert.equal((await f.receive(cmd)).message_id, receipt.message_id); assert.equal(f.models, 0);
});

test('cold restart, existing ensure, lookup and duplicate renewal cannot reconstruct execution authority', async t => {
  const f = fixture(t), expiry = f.deadline(120000); f.grants.ensure(timed, { expires_at: f.deadline() });
  const original = f.grants.renew(timed, { expected_revision: 1, expires_at: expiry, renewal_id: 'lost-ack' });
  const cmd = governed(timed), receipt = await f.receive(cmd); await f.reopen();
  assert.equal(f.grants.ensure(timed).expires_at, expiry);
  assert.deepEqual(f.grants.lookup(timed, { idempotency_key: 'lost-ack' }), original);
  assert.deepEqual(f.grants.renew(timed, { expected_revision: 1, expires_at: expiry, renewal_id: 'lost-ack', remaining_ttl_seconds: 10000 }), original);
  assert.throws(() => f.grants.require(timed), { code: 'execution_grant_clock_unverified' });
  await assert.rejects(f.runtime.drain(cmd.session_id), { code: 'execution_grant_clock_unverified' }); assert.equal(f.models, 0);
  f.grants.renew(timed, { expected_revision: 2, expires_at: f.deadline(180000), renewal_id: 'fresh-authorized' });
  assert.equal(f.grants.require(timed).revision, 3);
  await f.runtime.drain(cmd.session_id); assert.equal(f.models, 1);
  assert.deepEqual(f.grants.get(timed).settled_message_ids, [receipt.message_id]);
});

test('trusted remaining TTL caps clock skew and counts transaction delay without extending on replay', async t => {
  const f = fixture(t); f.grants.ensure(timed, { expires_at: f.deadline(3600000), remaining_ttl_seconds: 2 });
  const receipt = await f.receive(governed(timed)); f.advance({ monoMs: 2000 });
  assert.throws(() => f.grants.require(timed), { code: 'execution_grant_expired' });
  assert.equal(f.grants.get(timed).queued_message_ids[0], receipt.message_id);
  for (const value of [-1, Infinity, NaN, '10', true]) {
    assert.throws(() => f.grants.ensure({ ...timed, grant_id: 'invalid' }, { expires_at: f.deadline(), remaining_ttl_seconds: value }),
      { code: 'execution_grant_ttl_invalid' });
  }
});

test('expiry requires an immutable positive epoch and timezone-aware absolute deadline', async t => {
  const f = fixture(t);
  assert.throws(() => f.grants.ensure(spec, { expires_at: f.deadline() }), { code: 'execution_grant_epoch_expiry_required' });
  assert.throws(() => f.grants.ensure(timed), { code: 'execution_grant_epoch_expiry_required' });
  assert.throws(() => f.grants.ensure(timed, { expires_at: '2026-10-25T12:00:00' }), { code: 'execution_grant_expiry_invalid' });
  for (const value of ['2026-02-30T12:00:00Z', '2026-10-25T24:00:00Z'])
    assert.throws(() => f.grants.ensure(timed, { expires_at: value }), { code: 'execution_grant_expiry_invalid' });
  for (const epoch of [0, -1, true, 1.2, '7']) assert.throws(() => f.grants.ensure({ ...timed, attempt_epoch: epoch },
    { expires_at: f.deadline() }), { code: 'execution_grant_spec_invalid' });
  f.grants.ensure(timed, { expires_at: f.deadline() });
  assert.throws(() => f.grants.ensure({ ...timed, attempt_epoch: 8 }), { code: 'execution_grant_scope_mismatch' });
});

test('ordinary grantless commands remain executable and Teams/policy metadata remain explicitly unsupported', async t => {
  const f = fixture(t); await f.receive(command()); await f.runtime.drain(spec.session_id); assert.equal(f.models, 1);
  for (const key of ['teams_context_ref', 'execution_policy_ref']) {
    assert.equal((await f.receive(command({ payload: { content: 'x', [key]: 'caller-chosen' } }))).status, 'unsupported');
  }
  assert.equal(f.runtime.capabilities.teamsContext, false); assert.equal(f.runtime.capabilities.executionPolicy, false);
});

test('remaining TTL is consumed while the grant commit waits; failed renewals never alter the old anchor', async t => {
  let f, advanceOnCommit = false;
  f = fixture(t, { beforeCommit() { if (advanceOnCommit) f.advance({ monoMs: 3000 }); } });
  advanceOnCommit = true;
  f.grants.ensure(timed, { expires_at: f.deadline(3600000), remaining_ttl_seconds: 2 });
  advanceOnCommit = false;
  assert.throws(() => f.grants.require(timed), { code: 'execution_grant_expired' });
  const second = { ...timed, grant_id: 'renewal-rollback' };
  f.grants.ensure(second, { expires_at: f.deadline(60000), remaining_ttl_seconds: 10 });
  const failed = f.another({ beforeCommit() { throw Error('renewal transaction failed'); } });
  assert.throws(() => failed.executionGrants.renew(second, { expected_revision: 1, expires_at: f.deadline(120000),
    renewal_id: 'rollback', remaining_ttl_seconds: 1000 }), /renewal transaction failed/u);
  assert.equal(f.grants.require(second).revision, 1); assert.equal(f.grants.lookup(second, { idempotency_key: 'rollback' }), null);
  f.advance({ monoMs: 10000 }); assert.throws(() => f.grants.require(second), { code: 'execution_grant_expired' });
});

test('queue suspension does not block a signed interrupt for the already active original Run', async t => {
  const entered = deferred(); let models = 0;
  const f = fixture(t, { resolveBinding: request => binding(request.command, { model: { generate: async ({ signal }) => {
    models++; entered.resolve(); await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } } }) });
  f.grants.ensure(spec); const one = await f.receive(governed());
  const work = f.runtime.drain(spec.session_id); void work.catch(() => {}); await entered.promise;
  f.grants.setState(spec, 'suspended', { expected_revision: 1, idempotency_key: 'suspend' });
  const two = await f.receive(governed());
  const receipt = await f.receive(command({ command_type: 'interrupt', payload: { run_id: one.run_id } }));
  assert.equal(receipt.status, 'accepted');
  await assert.rejects(work, { code: 'execution_grant_suspended' });
  assert.equal(f.inspect(one).record.snapshot.phase, 'canceled'); assert.equal(f.inspect(two).record, null); assert.equal(models, 1);
  const barrier = f.grants.get(spec); assert.deepEqual(barrier.settled_message_ids, [one.message_id]);
  assert.deepEqual(barrier.queued_message_ids, [two.message_id]);
});

test('admission pause preserves the original pending interaction and whole-Session owner', async t => {
  const entered = deferred(); let models = 0, owners = 0, closed = 0;
  const f = fixture(t, { authorizeInteraction: () => true, resolveBinding: request => ({
    ...binding(request.command, { model: { generate: async () => ++models === 1 ? response({ kind: 'tool_calls', text: '',
      toolCalls: [{ callId: 'write', name: 'write', arguments: {} }] }) : response() },
    tools: { execute: async request => request.interaction ? { status: 'ok', content: 'written' }
      : { status: 'approval_required', interactionId: 'original-approval', content: {} } } }, { tools: [tool()] }),
    withExecution: async ({ execute }) => {
      owners++; const result = await execute({ onCheckpoint: snapshot => { if (snapshot.phase === 'awaiting_interaction') entered.resolve(snapshot); } });
      closed++; return result;
    },
  }) });
  f.grants.ensure(spec); const receipt = await f.receive(governed()), work = f.runtime.drain(spec.session_id);
  const waiting = await entered.promise;
  f.grants.setAdmission(spec, false, { expected_revision: 1, idempotency_key: 'pause-queue' });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(owners, 1); assert.equal(closed, 0); assert.equal(models, 1);
  assert.deepEqual(f.inspect(receipt).record.snapshot.pendingInteraction, waiting.pendingInteraction);
  assert.equal((await f.receive(command({ command_type: 'submit_interaction', payload: { run_id: receipt.run_id,
    interaction_id: waiting.pendingInteraction.interactionId, token_ref: 'trusted-token', response: 'approve' } }))).status, 'accepted');
  await work; assert.equal(models, 2); assert.equal(owners, 1); assert.equal(closed, 1);
  assert.equal(f.inspect(receipt).record.snapshot.phase, 'completed');
});

for (const state of ['revoked', 'suspended', 'expired', 'admission_paused']) test(`qualified expiring work rechecks ${state} before resource recovery`, async t => {
  const failure = Error('Execution resource lookup interrupted'); let executionLookups = 0, models = 0;
  const f = fixture(t, { resolveBinding: request => {
    if (request.stage === 'execute' && ++executionLookups === 1) throw failure;
    return binding(request.command, { model: { generate: async () => { models++; return response(); } } });
  } });
  f.grants.ensure(timed, { expires_at: f.deadline() });
  const receipt = await f.receive(governed(timed));
  await assert.rejects(f.runtime.drain(timed.session_id), error => error === failure);
  assert.deepEqual(f.grants.get(timed).in_flight_message_ids, [receipt.message_id]); assert.equal(f.inspect(receipt).record, null);
  if (state === 'expired') f.advance({ wallMs: 60000, monoMs: 60000 });
  else if (state === 'admission_paused') f.grants.setAdmission(timed, false, { expected_revision: 1, idempotency_key: 'pause-after-qualification' });
  else f.grants.setState(timed, state, { expected_revision: 1, idempotency_key: 'state-after-qualification' });
  if (state === 'admission_paused') {
    await f.runtime.drain(timed.session_id); assert.equal(models, 1); assert.equal(executionLookups, 2);
    assert.equal(f.inspect(receipt).record.snapshot.runId, receipt.run_id);
    assert.deepEqual(f.grants.get(timed).settled_message_ids, [receipt.message_id]);
  } else {
    await assert.rejects(f.runtime.drain(timed.session_id), { code: `execution_grant_${state}` });
    assert.equal(models, 0); assert.equal(executionLookups, 1); assert.equal(f.inspect(receipt).record, null);
    assert.deepEqual(f.grants.get(timed).discarded_message_ids, []);
    assert.deepEqual(f.grants.get(timed).in_flight_message_ids, [receipt.message_id]);
  }
});
