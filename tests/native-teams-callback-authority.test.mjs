import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createManagedNativeKernel } from '../src/providers/native-managed-kernel.mjs';
import { createNativeTeamsCallbackPermitVerifier, nativeTeamsCallbackPermitBytes } from '../src/providers/native-teams-callback-authority.mjs';
import { preparedContext, callbackPermit } from './fixtures/native-teams-context.mjs';
import { permitIssuer, binding, target } from './fixtures/native-managed-kernel.mjs';

const denied = { code: 'NATIVE_TEAMS_CALLBACK_UNAUTHORIZED' };
const initialTime = Date.UTC(2026, 9, 25, 0, 0, 0);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
function signer() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { pem: publicKey.export({ format: 'pem', type: 'spki' }),
    sign(value) { return { ...value, signature: sign(null, nativeTeamsCallbackPermitBytes(value), privateKey).toString('base64url') }; } };
}
function claims(context, revision = 1) {
  return { authorityId: context.ref.authorityId, agentInstanceId: context.grant.agent_instance_id,
    sessionId: context.ref.sessionId, commandId: context.ref.commandId, policyDigest: context.policy_digest,
    attemptEpoch: context.ref.attemptEpoch, grantRevision: revision, groupId: context.ref.groupId, teamRunId: context.ref.teamRunId,
    memberId: context.ref.memberId, bundleDigest: context.ref.bundleDigest, leaderEpoch: context.ref.leaderEpoch };
}
function signedFixture(options = {}) {
  const context = preparedContext(), server = signer(); let wall = initialTime;
  const verifier = createNativeTeamsCallbackPermitVerifier({ verificationKeys: async () => ({ server: server.pem }),
    issuer: 'trusted-server', clock: () => wall, ...options });
  const permit = server.sign(callbackPermit(context, { now: wall })), request = {
    operation: 'invoke', expected: claims(context), grantExpiresAt: new Date(wall + 60000).toISOString() };
  return { context, server, verifier, permit, request, advance(ms) { wall += ms; } };
}

test('authentic original callback is signed with Teams canonical bytes and copied on verification', async () => {
  const f = signedFixture(), actual = await f.verifier.verify(f.permit, f.request);
  assert.deepEqual(actual, f.permit); assert.notEqual(actual, f.permit);
  assert.equal(nativeTeamsCallbackPermitBytes(f.permit).toString().includes('signature'), false);
  assert.equal(nativeTeamsCallbackPermitBytes({ ...f.permit, allowedOperations: [...f.permit.allowedOperations] }).equals(
    nativeTeamsCallbackPermitBytes(Object.fromEntries(Object.entries(f.permit).reverse()))), true);
});

test('unsigned, forged, wrong issuer/key/audience or injected key claims never authenticate', async () => {
  const f = signedFixture(), other = signer();
  for (const permit of [{ ...f.permit, signature: 'A'.repeat(86) }, other.sign(f.permit),
    f.server.sign({ ...f.permit, issuer: 'other' }), f.server.sign({ ...f.permit, kid: 'other' }),
    { ...f.permit, audience: 'agentengine-teams-runtime' }, { ...f.permit, publicKey: other.pem },
    { ...f.permit, signature: f.permit.signature + '==' }, { ...f.permit, signature: '' }]) {
    await assert.rejects(f.verifier.verify(permit, f.request), denied);
  }
});

test('signature cannot replace any original context, attempt, leader, policy or grant claim', async () => {
  const f = signedFixture();
  for (const key of Object.keys(f.request.expected)) {
    const value = f.permit[key], altered = typeof value === 'number' ? value + 1
      : key.endsWith('Digest') ? 'sha256:' + 'f'.repeat(64)
      : key === 'commandId' ? '11111111-1111-4111-8111-111111111111' : 'different';
    await assert.rejects(f.verifier.verify(f.server.sign({ ...f.permit, [key]: altered }), f.request), denied, key);
    const missing = structuredClone(f.request); delete missing.expected[key];
    await assert.rejects(f.verifier.verify(f.permit, missing), denied, `missing trusted ${key}`);
  }
  await assert.rejects(f.verifier.verify(f.permit, { ...f.request, operation: 'effects' }), denied);
});

test('callback lifetime must fit the live execution grant, with exact issued/expiry boundaries', async () => {
  const f = signedFixture();
  await assert.rejects(f.verifier.verify(f.permit, { ...f.request, grantExpiresAt: null }), denied);
  await assert.rejects(f.verifier.verify(f.permit, { ...f.request, grantExpiresAt: new Date(initialTime + 19999).toISOString() }), denied);
  await assert.rejects(f.verifier.verify(f.permit, { ...f.request, grantExpiresAt: 'bad' }), denied);
  f.advance(-1001); await assert.rejects(f.verifier.verify(f.permit, f.request), denied);
  f.advance(1); await f.verifier.verify(f.permit, f.request);
  f.advance(21000); await assert.rejects(f.verifier.verify(f.permit, f.request), denied);
});

test('key refresh does not authenticate a caller-mutated permit or an expired callback', async () => {
  const entered = deferred(), release = deferred(); let now = initialTime;
  const server = signer(), f = signedFixture({ verificationKeys: async () => { entered.resolve(); await release.promise; return { server: server.pem }; }, clock: () => now });
  const permit = server.sign(f.permit), original = structuredClone(permit), request = structuredClone(f.request);
  const work = f.verifier.verify(permit, request); await entered.promise;
  permit.commandId = '11111111-1111-4111-8111-111111111111'; request.expected.commandId = permit.commandId;
  release.resolve(); assert.deepEqual(await work, original);
  now += 20000; await assert.rejects(f.verifier.verify(original, f.request), denied);
});

test('expiry is checked after an asynchronous key fetch', async () => {
  const entered = deferred(), release = deferred(); let now = initialTime;
  const server = signer(), f = signedFixture({ verificationKeys: async () => { entered.resolve(); await release.promise; return { server: server.pem }; }, clock: () => now });
  const work = f.verifier.verify(server.sign(f.permit), f.request); await entered.promise; now += 20000; release.resolve();
  await assert.rejects(work, denied);
});

test('recovery evidence permits cannot authorize model/tool/effect operations', async () => {
  const f = signedFixture(), recovery = f.server.sign(callbackPermit(f.context, { now: initialTime,
    permitKind: 'recovery', allowedOperations: ['append_effect_evidence'] }));
  await f.verifier.verify(recovery, { ...f.request, operation: 'append_effect_evidence', grantExpiresAt: null });
  await assert.rejects(f.verifier.verify(recovery, f.request), denied);
});

function runtimeFixture(t, { keySource } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'teams-authority-'))), server = signer(), issuer = permitIssuer();
  let wall = initialTime, mono = 100;
  const verifier = createNativeTeamsCallbackPermitVerifier({ verificationKeys: keySource ? () => keySource(server.pem) : async () => ({ server: server.pem }),
    issuer: 'trusted-server', clock: () => wall });
  const config = { directory, target, permitVerifier: issuer.verifier, resolveBinding: request => binding(request.command),
    assertCurrent: () => true, autoStart: false, teamsCallbackVerifier: verifier, clock: () => wall, monotonic: () => mono };
  let runtime = createManagedNativeKernel(config); const context = preparedContext();
  const opts = { expectedIncarnation: runtime.teamsContexts.incarnation() };
  runtime.teamsContexts.put(context, opts);
  const deadline = ms => new Date(wall + ms).toISOString();
  runtime.executionGrants.ensure(context.grant, { expires_at: deadline(60000) });
  const callback = revision => server.sign(callbackPermit(context, { now: wall, revision }));
  runtime.teamsContexts.putCallback(context.context_ref, callback(1), opts);
  t.after(async () => { await runtime.close(); rmSync(directory, { recursive: true, force: true }); });
  return { get runtime() { return runtime; }, context, callback, opts, deadline, directory,
    authorize: () => runtime.teamsCallbacks.authorize(context.context_ref, 'invoke'),
    advance({ wallMs = 0, monoMs = 0 }) { wall += wallMs; mono += monoMs; },
    async reopen() { await runtime.close(); runtime = createManagedNativeKernel(config); },
  };
}

test('mounted trusted callback authority rechecks the original live grant on every use', async t => {
  const f = runtimeFixture(t);
  assert.equal(f.runtime.capabilities.teamsCallbackAuthorization, true);
  const result = await f.authorize(); assert.deepEqual(result.context, f.context); assert.equal(result.grant.revision, 1);
  f.runtime.executionGrants.setAdmission(f.context.grant, false, { expected_revision: 1, idempotency_key: 'pause-queue' });
  await f.authorize();
  f.runtime.executionGrants.setState(f.context.grant, 'suspended', { expected_revision: 1, idempotency_key: 'suspend' });
  await assert.rejects(f.authorize(), { code: 'execution_grant_suspended' });
  f.runtime.executionGrants.setState(f.context.grant, 'active', { expected_revision: 2, idempotency_key: 'resume' });
  await assert.rejects(f.authorize(), denied, 'the old signed callback cannot follow a changed grant revision');
  f.runtime.teamsContexts.putCallback(f.context.context_ref, f.callback(3), f.opts); await f.authorize();
  f.runtime.executionGrants.setState(f.context.grant, 'revoked', { expected_revision: 3, idempotency_key: 'revoke' });
  await assert.rejects(f.authorize(), { code: 'execution_grant_revoked' });
});

test('persisting a syntactically valid forged callback never authorizes work', async t => {
  const f = runtimeFixture(t), forged = callbackPermit(f.context, { now: initialTime, ttl: 25000 });
  f.runtime.teamsContexts.putCallback(f.context.context_ref, forged, f.opts);
  await assert.rejects(f.authorize(), denied);
});

for (const change of ['revoke', 'renew', 'store-replacement']) test(`grant or identity ${change} during key refresh blocks the callback`, async t => {
  const entered = deferred(), release = deferred(), f = runtimeFixture(t, { keySource: async pem => {
    entered.resolve(); await release.promise; return { server: pem };
  } });
  t.after(() => release.resolve()); const work = f.authorize(); await entered.promise;
  if (change === 'revoke') f.runtime.executionGrants.setState(f.context.grant, 'revoked', { expected_revision: 1, idempotency_key: 'during-key-fetch' });
  else if (change === 'renew') f.runtime.executionGrants.renew(f.context.grant, { expected_revision: 1,
    expires_at: f.deadline(120000), renewal_id: 'during-key-fetch' });
  else { const db = new DatabaseSync(join(f.directory, 'commands.sqlite')); try {
    db.prepare('UPDATE managed_teams_identity SET incarnation=?').run('replacement-store');
  } finally { db.close(); } }
  release.resolve(); await assert.rejects(work, { code: change === 'revoke' ? 'execution_grant_revoked'
    : change === 'renew' ? denied.code : 'NATIVE_TEAMS_STORE_IDENTITY_MISMATCH' });
});

test('cold registry and signed callbacks cannot reconstruct the grant monotonic authority', async t => {
  const f = runtimeFixture(t); await f.authorize(); await f.reopen();
  await assert.rejects(f.authorize(), { code: 'execution_grant_clock_unverified' });
  f.runtime.executionGrants.ensure(f.context.grant); await assert.rejects(f.authorize(), { code: 'execution_grant_clock_unverified' });
  f.runtime.executionGrants.renew(f.context.grant, { expected_revision: 1, expires_at: f.deadline(120000), renewal_id: 'fresh-server-renewal' });
  await assert.rejects(f.authorize(), denied);
  f.runtime.teamsContexts.putCallback(f.context.context_ref, f.callback(2), f.opts); await f.authorize();
});

test('wall clock rollback cannot revive an expired grant for callback execution', async t => {
  const f = runtimeFixture(t); await f.authorize(); f.advance({ wallMs: -3600000, monoMs: 60000 });
  await assert.rejects(f.authorize(), { code: 'execution_grant_expired' });
});
