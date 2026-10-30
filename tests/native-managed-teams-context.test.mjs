import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createManagedNativeKernel } from '../src/providers/native-managed-kernel.mjs';
import { teamsSessionOwnerDigest } from '../src/providers/native-teams-context-contract.mjs';
import { command, permitIssuer, target, binding } from './fixtures/native-managed-kernel.mjs';
import { preparedContext, callbackPermit } from './fixtures/native-teams-context.mjs';

const conflict = { code: 'NATIVE_TEAMS_CONTEXT_CONFLICT' }, identityError = { code: 'NATIVE_TEAMS_STORE_IDENTITY_MISMATCH' };
function fixture(t, overrides = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'managed-teams-'))), issuer = permitIssuer();
  let failCommit = false, lookups = 0;
  const config = { directory, target, permitVerifier: issuer.verifier, assertCurrent: () => true, autoStart: false,
    beforeCommit() { if (failCommit) throw Error('injected transaction failure'); },
    resolveBinding(request) { lookups++; return binding(request.command); }, ...overrides };
  let runtime = createManagedNativeKernel(config); const others = [];
  t.after(async () => { for (const other of others) await other.close(); await runtime.close(); rmSync(directory, { recursive: true, force: true }); });
  const sqlite = fn => { const db = new DatabaseSync(join(directory, 'commands.sqlite')); try { return fn(db); } finally { db.close(); } };
  return { directory, issuer, get runtime() { return runtime; }, get contexts() { return runtime.teamsContexts; },
    get opts() { return { expectedIncarnation: runtime.teamsContexts.incarnation() }; },
    get lookups() { return lookups; }, set failCommit(value) { failCommit = value; },
    receive: cmd => runtime.receive(cmd, issuer.issue(cmd)), sqlite,
    async reopen() { await runtime.close(); runtime = createManagedNativeKernel(config); return runtime; },
    another() { const other = createManagedNativeKernel(config); others.push(other); return other; },
  };
}

test('contexts are copied durable facts in the original store, not grants or execution policy', async t => {
  const f = fixture(t), original = preparedContext(), expected = structuredClone(original), opts = f.opts;
  assert.equal(f.runtime.capabilities.teamsContextRegistry, true);
  assert.equal(f.runtime.capabilities.teamsContext, false); assert.equal(f.runtime.capabilities.executionPolicy, false);
  assert.equal(f.contexts.durable, true); assert.equal(f.contexts.sharedAcrossHosts, false);
  f.contexts.put(original, opts); original.context.systemContext = 'mutated'; original.command.payload.content = 'changed';
  const stored = f.contexts.get(expected.context_ref, opts); assert.deepEqual(stored, expected);
  stored.ref.target.runtimeId = 'changed'; assert.deepEqual(f.contexts.get(expected.context_ref, opts), expected);
  assert.equal(f.contexts.ownsSession(expected.ref.sessionId), true);
  assert.throws(() => f.runtime.executionGrants.require(expected.grant), { code: 'execution_grant_not_found' });
  assert.equal(f.sqlite(db => db.prepare('SELECT COUNT(*) AS n FROM managed_commands').get().n), 0);
  assert.equal(f.sqlite(db => db.prepare('SELECT digest FROM managed_teams_owners').get().digest), teamsSessionOwnerDigest(expected));
  await f.reopen(); assert.deepEqual(f.contexts.get(expected.context_ref, opts), expected); assert.equal(f.lookups, 0);
});

test('immutable original context, policy, command and owner cannot be rebound', t => {
  const f = fixture(t), original = preparedContext(), opts = f.opts; f.contexts.put(original, opts);
  f.contexts.put(structuredClone(original), opts);
  for (const candidate of [preparedContext({ owner: 'someone-else', sessionId: original.ref.sessionId }),
    preparedContext({ contextRef: original.context_ref }), preparedContext({ policyRef: original.policy_ref }),
    preparedContext({ sessionId: original.ref.sessionId, commandId: original.ref.commandId }),
    preparedContext({ sessionId: original.ref.sessionId, idem: original.ref.idempotencyKey })]) {
    assert.throws(() => f.contexts.put(candidate, opts), conflict);
  }
  assert.deepEqual(f.contexts.get(original.context_ref, opts), original);
  assert.equal(f.sqlite(db => db.prepare('SELECT COUNT(*) AS n FROM managed_teams_contexts').get().n), 1);
});

test('conflicting unique reference rolls back a newly reserved Session and context together', t => {
  const f = fixture(t), one = preparedContext(), opts = f.opts; f.contexts.put(one, opts);
  const two = preparedContext({ sessionId: 'not-reserved', policyRef: one.policy_ref });
  assert.throws(() => f.contexts.put(two, opts), conflict);
  assert.equal(f.contexts.ownsSession(two.ref.sessionId), false); assert.equal(f.contexts.get(two.context_ref, opts), null);
  const next = preparedContext({ sessionId: two.ref.sessionId, owner: 'new-real-owner' });
  f.contexts.put(next, opts); assert.deepEqual(f.contexts.get(next.context_ref, opts), next);
});

test('injected commit failure does not leave a phantom reservation or partial context', t => {
  const f = fixture(t), original = preparedContext(), opts = f.opts; f.failCommit = true;
  assert.throws(() => f.contexts.put(original, opts), /injected transaction failure/u); f.failCommit = false;
  assert.equal(f.contexts.ownsSession(original.ref.sessionId), false); assert.equal(f.contexts.get(original.context_ref, opts), null);
  f.contexts.put(original, opts); assert.deepEqual(f.contexts.get(original.context_ref, opts), original);
});

test('missing, wrong or replaced store identity never looks like a missing context', async t => {
  const f = fixture(t), original = preparedContext(), opts = f.opts; f.contexts.put(original, opts);
  assert.throws(() => f.contexts.get('missing'), identityError);
  assert.throws(() => f.contexts.get('missing', { expectedIncarnation: 'different' }), identityError);
  await f.reopen(); assert.equal(f.contexts.incarnation(), opts.expectedIncarnation);
  f.sqlite(db => db.prepare('UPDATE managed_teams_identity SET incarnation=? WHERE id=1').run('replacement-store'));
  assert.throws(() => f.contexts.get('missing', opts), identityError);
  assert.throws(() => f.contexts.ownsSession(original.ref.sessionId), identityError);
  await f.reopen(); assert.notEqual(f.contexts.incarnation(), opts.expectedIncarnation);
  assert.throws(() => f.contexts.get(original.context_ref, opts), identityError);
});

test('independent receivers see original facts and agree on extension identity and nonce owner', t => {
  const f = fixture(t), other = f.another().teamsContexts, original = preparedContext(), opts = f.opts;
  assert.equal(other.incarnation(), opts.expectedIncarnation);
  f.contexts.put(original, opts); assert.deepEqual(other.get(original.context_ref, opts), original);
  assert.equal(other.extensionIdentity('teams-server', opts), null);
  f.contexts.bindExtensionIdentity('teams-server', 'original-server-identity', opts);
  other.bindExtensionIdentity('teams-server', 'original-server-identity', opts);
  assert.throws(() => other.bindExtensionIdentity('teams-server', 'other-server', opts), identityError);
  assert.equal(other.extensionIdentity('teams-server', opts), 'original-server-identity');
  assert.equal(f.contexts.registerNonce('permit-nonce', original.ref.commandId, original.ref.idempotencyKey, opts), true);
  assert.equal(other.registerNonce('permit-nonce', original.ref.commandId, original.ref.idempotencyKey, opts), true);
  assert.equal(other.registerNonce('permit-nonce', 'other-command', original.ref.idempotencyKey, opts), false);
  assert.equal(other.registerNonce('permit-nonce', original.ref.commandId, 'other-idempotency-key', opts), false);
});

test('callback slots bind the original context and grant revision; only later expiry replaces a slot', async t => {
  const f = fixture(t), original = preparedContext(), opts = f.opts, now = Date.now(); f.contexts.put(original, opts);
  assert.equal(f.contexts.getCallback(original.context_ref, 1, opts), null);
  const first = callbackPermit(original, { now, ttl: 20000 }), shorter = callbackPermit(original, { now, ttl: 10000 });
  f.contexts.putCallback(original.context_ref, first, opts); f.contexts.putCallback(original.context_ref, shorter, opts);
  assert.deepEqual(f.contexts.getCallback(original.context_ref, 1, opts), first);
  const longer = callbackPermit(original, { now, ttl: 25000 }); f.contexts.putCallback(original.context_ref, longer, opts);
  const revised = callbackPermit(original, { now, ttl: 5000, revision: 2 }); f.contexts.putCallback(original.context_ref, revised, opts);
  longer.allowedOperations.push('effects');
  assert.deepEqual(f.contexts.getCallback(original.context_ref, 1, opts).allowedOperations, ['policy', 'invoke']);
  assert.deepEqual(f.contexts.getCallback(original.context_ref, 2, opts), revised);
  await f.reopen(); assert.deepEqual(f.contexts.getCallback(original.context_ref, 2, opts), revised);
  assert.throws(() => f.runtime.executionGrants.require(original.grant), { code: 'execution_grant_not_found' },
    'persisting an unverified callback never creates a grant');
});

test('callback storage cannot cross the original context, epoch, policy or authority', t => {
  const f = fixture(t), original = preparedContext(), opts = f.opts; f.contexts.put(original, opts);
  for (const change of [{ commandId: command().command_id }, { groupId: 'other' }, { teamRunId: 'other' }, { memberId: 'other' },
    { sessionId: 'other' }, { agentInstanceId: 'other' }, { attemptEpoch: 8 }, { leaderEpoch: 4 },
    { authorityId: 'other' }, { bundleDigest: 'sha256:' + 'f'.repeat(64) }, { policyDigest: 'sha256:' + 'e'.repeat(64) }]) {
    assert.throws(() => f.contexts.putCallback(original.context_ref, callbackPermit(original, change), opts), conflict);
  }
  assert.throws(() => f.contexts.putCallback('absent', callbackPermit(original), opts), conflict);
  assert.equal(f.contexts.getCallback(original.context_ref, 1, opts), null);
});

test('public signed commands cannot use reserved Sessions or opaque policy/context references', async t => {
  const f = fixture(t), original = preparedContext(), opts = f.opts; f.contexts.put(original, opts);
  for (const cmd of [original.command, command({ session_id: original.ref.sessionId }),
    command({ session_id: original.ref.sessionId, command_type: 'interrupt', payload: {} }),
    command({ session_id: original.ref.sessionId, command_type: 'resume', payload: { target: { kind: 'run', id: 'original' } } })]) {
    assert.equal((await f.receive(cmd)).error.code, 'native_teams_ingress_required');
  }
  const unsupported = command({ payload: { content: 'ordinary', teams_context_ref: original.context_ref } });
  assert.equal((await f.receive(unsupported)).status, 'unsupported'); assert.equal(f.lookups, 0);
  assert.equal(f.sqlite(db => db.prepare('SELECT COUNT(*) AS n FROM managed_commands').get().n), 0);
});

test('reservation arriving during asynchronous admission blocks ordinary work at commit', async t => {
  let release, entered; const held = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const f = fixture(t, { async resolveBinding(request) { entered(); await held; return binding(request.command); } });
  t.after(() => release()); const original = preparedContext(), opts = f.opts;
  const receiving = f.receive(command({ session_id: original.ref.sessionId })); await started;
  f.another().teamsContexts.put(original, opts); release();
  assert.equal((await receiving).error.code, 'native_teams_ingress_required');
  assert.equal(f.sqlite(db => db.prepare('SELECT COUNT(*) AS n FROM managed_runs').get().n), 0);
});

test('preparation cannot take over a Session that already admitted ordinary managed work', async t => {
  const f = fixture(t), cmd = command(); assert.equal((await f.receive(cmd)).status, 'accepted');
  const original = preparedContext({ sessionId: cmd.session_id });
  assert.throws(() => f.contexts.put(original, f.opts), conflict); assert.equal(f.contexts.ownsSession(cmd.session_id), false);
  await f.runtime.drain(cmd.session_id);
});

test('corrupt persisted owner or context is detected before facts are returned', t => {
  const f = fixture(t), original = preparedContext(), opts = f.opts; f.contexts.put(original, opts);
  f.sqlite(db => db.prepare('UPDATE managed_teams_owners SET digest=? WHERE session_id=?').run('corrupt', original.ref.sessionId));
  assert.throws(() => f.contexts.get(original.context_ref, opts), identityError);
});
