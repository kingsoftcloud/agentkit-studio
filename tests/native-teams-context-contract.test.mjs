import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  teamsContextDigest,
  teamsSessionOwnerDigest,
  validatePreparedTeamsContext,
  validateTeamsCallbackPermit,
} from '../src/providers/native-teams-context-contract.mjs';

const INVALID = 'NATIVE_TEAMS_CONTEXT_INVALID';
const CONFLICT = 'NATIVE_TEAMS_CONTEXT_CONFLICT';
const CB_INVALID = 'NATIVE_TEAMS_CALLBACK_INVALID';

function assertCode(fn, code) {
  assert.throws(() => fn(), (err) => err instanceof Error && err.code === code, `expected ${code}`);
}
function assertInvalid(fn) { assertCode(fn, INVALID); }
function assertConflict(fn) { assertCode(fn, CONFLICT); }
function assertCbInvalid(fn) { assertCode(fn, CB_INVALID); }
function clone(v) { return JSON.parse(JSON.stringify(v)); }

const HEX64 = 'a'.repeat(64);
const FIXED = {
  contextRef: 'ctx-ref-1',
  policyRef: 'policy-ref-1',
  ownerSubject: 'owner-subj-1',
  commandId: '12345678-1234-1234-1234-123456789012',
  sessionId: 'sess-1',
  idempotencyKey: 'idem-key-1',
  agentInstanceId: 'agent-inst-1',
  tenantId: 'tenant-1',
  grantId: 'grant-1',
  ownerRef: 'owner-ref-1',
  attemptEpoch: 7,
  policyDigest: 'sha256:' + HEX64,
  bundleDigest: 'sha256:' + 'b'.repeat(64),
  contractDigest: 'sha256:' + 'c'.repeat(64),
  capabilitiesDigest: 'sha256:' + 'd'.repeat(64),
};

function baseContext() { return { task: 'summarize', turn: 3, meta: { x: 1 } }; }

function baseRef() {
  return {
    authorityId: 'auth-1', groupId: 'grp-1', teamRunId: 'run-1',
    memberId: 'mem-1', runMemberId: 'runmem-1', attemptId: 'att-1',
    deliveryId: 'del-1', bindingRef: 'bind-1', providerRef: 'prov-1',
    sessionId: FIXED.sessionId, commandId: FIXED.commandId,
    idempotencyKey: FIXED.idempotencyKey, schedulerEpoch: 2, leaderEpoch: 3,
    dispatchEpoch: 4, attemptEpoch: FIXED.attemptEpoch,
    target: {
      kind: 'cloud_agent', agentId: 'agent-1', versionId: 'ver-1',
      runtimeId: 'rt-1', agentInstanceId: FIXED.agentInstanceId,
    },
    bundleDigest: FIXED.bundleDigest, contractDigest: FIXED.contractDigest,
    capabilitiesDigest: FIXED.capabilitiesDigest,
  };
}

function baseRefNode() {
  const ref = baseRef();
  ref.target = { kind: 'node', nodeId: 'node-1', nodeGeneration: 5 };
  return ref;
}

function baseGrant() {
  return {
    grant_id: FIXED.grantId, tenant_id: FIXED.tenantId, session_id: FIXED.sessionId,
    agent_instance_id: FIXED.agentInstanceId, owner_ref: FIXED.ownerRef,
    attempt_epoch: FIXED.attemptEpoch,
  };
}

function baseCommand() {
  return {
    schema_version: 1, authorization_ref: 'server-authorization', submitted_at: '2026-10-25T00:00:00.000Z',
    source: { kind: 'a2a', ref: 'original-server-delivery' },
    command_type: 'enqueue', command_id: FIXED.commandId, session_id: FIXED.sessionId,
    idempotency_key: FIXED.idempotencyKey, agent_instance_id: FIXED.agentInstanceId,
    tenant_id: FIXED.tenantId,
    payload: {
      content: 'Original Teams task',
      execution_grant_id: FIXED.grantId,
      execution_grant_attempt_epoch: FIXED.attemptEpoch,
      execution_policy_ref: FIXED.policyRef,
      teams_context_ref: FIXED.contextRef,
    },
  };
}

function basePrepared() {
  const context = baseContext();
  return {
    context_ref: FIXED.contextRef, context_digest: teamsContextDigest(context),
    policy_ref: FIXED.policyRef, policy_digest: FIXED.policyDigest,
    owner_subject: FIXED.ownerSubject, ref: baseRef(), grant: baseGrant(),
    command: baseCommand(), context,
  };
}

function basePermit() {
  return {
    schemaVersion: 1, audience: 'agentengine-teams-callback', permitKind: 'execute',
    issuer: 'issuer-1', kid: 'kid-1', authorityId: 'auth-1',
    issuedAt: '2026-10-25T00:00:00.000Z', expiresAt: '2026-10-25T00:00:10.000Z',
    nonce: 'nonce-1', signature: 'c2lnbmF0dXJl',
    groupId: 'grp-1', teamRunId: 'run-1', memberId: 'mem-1',
    commandId: FIXED.commandId, sessionId: FIXED.sessionId,
    agentInstanceId: FIXED.agentInstanceId, bundleDigest: FIXED.bundleDigest,
    policyDigest: FIXED.policyDigest, attemptEpoch: FIXED.attemptEpoch,
    leaderEpoch: 3, grantRevision: 2, allowedOperations: ['policy', 'invoke'],
  };
}

describe('teamsContextDigest', () => {
  test('produces sha256: + 64 lowercase hex', () => {
    const d = teamsContextDigest({ b: 1, a: 2 });
    assert.match(d, /^sha256:[0-9a-f]{64}$/);
  });
  test('deterministic and key-order independent', () => {
    assert.strictEqual(teamsContextDigest({ a: 1, b: 2 }), teamsContextDigest({ b: 2, a: 1 }));
  });
  test('content change changes digest', () => {
    assert.notStrictEqual(teamsContextDigest({ a: 1 }), teamsContextDigest({ a: 2 }));
  });
});

describe('teamsSessionOwnerDigest', () => {
  test('binds exactly tenant/owner/authority/group/teamRun/member/binding/instance', () => {
    const prepared = validatePreparedTeamsContext(basePrepared());
    const base = teamsSessionOwnerDigest(prepared);
    const mutated = clone(prepared);
    mutated.grant.tenant_id = 'tenant-2';
    assert.notStrictEqual(teamsSessionOwnerDigest(mutated), base);
  });
  test('changing bound runMemberId changes digest; unbound memberId does not', () => {
    const prepared = validatePreparedTeamsContext(basePrepared());
    const base = teamsSessionOwnerDigest(prepared);
    const m = clone(prepared);
    m.ref.runMemberId = 'runmem-2';
    assert.notStrictEqual(teamsSessionOwnerDigest(m), base);
    const m2 = clone(prepared);
    m2.ref.memberId = 'mem-2';
    assert.strictEqual(teamsSessionOwnerDigest(m2), base);
    const m3 = clone(prepared);
    m3.grant.grant_id = 'grant-2';
    assert.strictEqual(teamsSessionOwnerDigest(m3), base);
  });
  test('rejects missing bound fields', () => {
    const prepared = validatePreparedTeamsContext(basePrepared());
    const bad = clone(prepared); delete bad.grant.tenant_id;
    assertInvalid(() => teamsSessionOwnerDigest(bad));
  });
});

describe('validatePreparedTeamsContext shape', () => {
  test('accepts a valid cloud_agent context and returns independent copy', () => {
    const raw = basePrepared();
    const result = validatePreparedTeamsContext(raw);
    assert.deepStrictEqual(result.context, raw.context);
    assert.notStrictEqual(result, raw);
    assert.notStrictEqual(result.ref, raw.ref);
    assert.notStrictEqual(result.grant, raw.grant);
    assert.notStrictEqual(result.command, raw.command);
    assert.notStrictEqual(result.context, raw.context);
  });
  test('accepts a valid node target', () => {
    const raw = basePrepared(); raw.ref = baseRefNode();
    const result = validatePreparedTeamsContext(raw);
    assert.strictEqual(result.ref.target.kind, 'node');
    assert.strictEqual(result.ref.target.nodeGeneration, 5);
  });
  test('rejects unknown top-level field', () => {
    const raw = basePrepared(); raw.extra = 1;
    assertInvalid(() => validatePreparedTeamsContext(raw));
  });
  test('rejects unknown ref field', () => {
    const raw = basePrepared(); raw.ref.extra = 1;
    assertInvalid(() => validatePreparedTeamsContext(raw));
  });
  test('rejects unknown target field', () => {
    const raw = basePrepared(); raw.ref.target.extra = 1;
    assertInvalid(() => validatePreparedTeamsContext(raw));
  });
  test('rejects unknown grant field including expiry', () => {
    const raw = basePrepared(); raw.grant.expires_at = '2026-12-31T00:00:00.000Z';
    assertInvalid(() => validatePreparedTeamsContext(raw));
  });
  test('rejects missing required top-level field', () => {
    const raw = basePrepared(); delete raw.owner_subject;
    assertInvalid(() => validatePreparedTeamsContext(raw));
  });
  test('context defaults to {} when absent', () => {
    const raw = basePrepared(); delete raw.context; raw.context_digest = teamsContextDigest({});
    const result = validatePreparedTeamsContext(raw);
    assert.deepStrictEqual(result.context, {});
  });
  test('rejects non-object context', () => {
    const raw = basePrepared(); raw.context = 'nope';
    assertInvalid(() => validatePreparedTeamsContext(raw));
  });
  test('normalizes optional material fields to null when absent', () => {
    const result = validatePreparedTeamsContext(basePrepared());
    assert.strictEqual(result.material_manifest_ref, null);
    assert.strictEqual(result.material_manifest_digest, null);
  });
  test('accepts present material reference and digest together', () => {
    const raw = basePrepared();
    raw.material_manifest_ref = 'manifest-1';
    raw.material_manifest_digest = 'sha256:' + 'e'.repeat(64);
    const result = validatePreparedTeamsContext(raw);
    assert.strictEqual(result.material_manifest_ref, 'manifest-1');
  });
  test('rejects material reference without digest', () => {
    const raw = basePrepared();
    raw.material_manifest_ref = 'manifest-1';
    assertInvalid(() => validatePreparedTeamsContext(raw));
  });
  test('normalizes optional ref taskId/nativeRunId to null when absent', () => {
    const result = validatePreparedTeamsContext(basePrepared());
    assert.strictEqual(result.ref.taskId, null);
    assert.strictEqual(result.ref.nativeRunId, null);
  });
  test('accepts explicit ref taskId/nativeRunId', () => {
    const raw = basePrepared();
    raw.ref.taskId = 'task-1';
    raw.ref.nativeRunId = 'nrun-1';
    const result = validatePreparedTeamsContext(raw);
    assert.strictEqual(result.ref.taskId, 'task-1');
    assert.strictEqual(result.ref.nativeRunId, 'nrun-1');
  });
});

describe('validatePreparedTeamsContext identifiers and types', () => {
  test('rejects untrimmed opaque identifier', () => {
    const raw = basePrepared(); raw.owner_subject = ' owner ';
    assertInvalid(() => validatePreparedTeamsContext(raw));
  });
  test('rejects empty opaque identifier', () => {
    const raw = basePrepared(); raw.context_ref = '';
    assertInvalid(() => validatePreparedTeamsContext(raw));
  });
  test('rejects over-long opaque identifier (>256)', () => {
    const raw = basePrepared(); raw.policy_ref = 'p'.repeat(257);
    assertInvalid(() => validatePreparedTeamsContext(raw));
  });
  test('accepts 256-char opaque identifier', () => {
    const raw = basePrepared(); raw.owner_subject = 'o'.repeat(256);
    assert.doesNotThrow(() => validatePreparedTeamsContext(raw));
  });
  test('rejects malformed digest (uppercase hex)', () => {
    const raw = basePrepared(); raw.policy_digest = 'sha256:' + 'A'.repeat(64);
    assertInvalid(() => validatePreparedTeamsContext(raw));
  });
  test('rejects malformed digest (wrong length)', () => {
    const raw = basePrepared(); raw.policy_digest = 'sha256:' + 'a'.repeat(63);
    assertInvalid(() => validatePreparedTeamsContext(raw));
  });
  test('rejects malformed command UUID', () => {
    const raw = basePrepared(); raw.ref.commandId = 'not-a-uuid';
    assertInvalid(() => validatePreparedTeamsContext(raw));
  });
  test('rejects non-positive epoch', () => {
    const raw = basePrepared(); raw.ref.attemptEpoch = 0;
    assertInvalid(() => validatePreparedTeamsContext(raw));
  });
  test('rejects non-integer epoch', () => {
    const raw = basePrepared(); raw.ref.attemptEpoch = 1.5;
    assertInvalid(() => validatePreparedTeamsContext(raw));
  });
  test('rejects unsafe-large epoch', () => {
    const raw = basePrepared(); raw.ref.attemptEpoch = Number.MAX_SAFE_INTEGER + 1;
    assertInvalid(() => validatePreparedTeamsContext(raw));
  });
  test('rejects string epoch', () => {
    const raw = basePrepared(); raw.ref.attemptEpoch = '7';
    assertInvalid(() => validatePreparedTeamsContext(raw));
  });
});

describe('validatePreparedTeamsContext scope (CONFLICT)', () => {
  test('rejects non-enqueue command_type', () => {
    const raw = basePrepared(); raw.command.command_type = 'cancel';
    assertConflict(() => validatePreparedTeamsContext(raw));
  });
  test('rejects command_id mismatch with ref.commandId', () => {
    const raw = basePrepared(); raw.command.command_id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    raw.ref.commandId = raw.command.command_id; // keep ref valid UUID shape but differ from grant? no: ref.commandId must equal command_id
    raw.ref.commandId = '11111111-2222-3333-4444-555555555555';
    assertConflict(() => validatePreparedTeamsContext(raw));
  });
  test('rejects grant.attempt_epoch mismatch with ref.attemptEpoch', () => {
    const raw = basePrepared(); raw.grant.attempt_epoch = 8;
    assertConflict(() => validatePreparedTeamsContext(raw));
  });
  test('rejects payload.execution_policy_ref mismatch', () => {
    const raw = basePrepared(); raw.command.payload.execution_policy_ref = 'other-policy';
    assertConflict(() => validatePreparedTeamsContext(raw));
  });
  test('rejects payload.teams_context_ref mismatch', () => {
    const raw = basePrepared(); raw.command.payload.teams_context_ref = 'other-ctx';
    assertConflict(() => validatePreparedTeamsContext(raw));
  });
  test('rejects payload.execution_grant_id mismatch', () => {
    const raw = basePrepared(); raw.command.payload.execution_grant_id = 'other-grant';
    assertConflict(() => validatePreparedTeamsContext(raw));
  });
  test('rejects payload.execution_grant_attempt_epoch mismatch', () => {
    const raw = basePrepared(); raw.command.payload.execution_grant_attempt_epoch = 8;
    assertConflict(() => validatePreparedTeamsContext(raw));
  });
  test('rejects grant.agent_instance_id mismatch with command', () => {
    const raw = basePrepared(); raw.grant.agent_instance_id = 'other-inst';
    assertConflict(() => validatePreparedTeamsContext(raw));
  });
  test('rejects grant.tenant_id mismatch with command', () => {
    const raw = basePrepared(); raw.grant.tenant_id = 'other-tenant';
    assertConflict(() => validatePreparedTeamsContext(raw));
  });
  test('rejects grant.session_id mismatch with command', () => {
    const raw = basePrepared(); raw.grant.session_id = 'other-sess';
    assertConflict(() => validatePreparedTeamsContext(raw));
  });
  test('rejects command.idempotency_key mismatch with ref', () => {
    const raw = basePrepared(); raw.command.idempotency_key = 'other-key';
    assertConflict(() => validatePreparedTeamsContext(raw));
  });
  test('rejects command.session_id mismatch with ref', () => {
    const raw = basePrepared(); raw.command.session_id = 'other-sess';
    assertConflict(() => validatePreparedTeamsContext(raw));
  });
  test('rejects cloud_agent target agentInstanceId mismatch with command', () => {
    const raw = basePrepared(); raw.ref.target.agentInstanceId = 'other-inst';
    assertConflict(() => validatePreparedTeamsContext(raw));
  });
  test('rejects context_digest mismatch', () => {
    const raw = basePrepared(); raw.context_digest = 'sha256:' + '0'.repeat(64);
    assertConflict(() => validatePreparedTeamsContext(raw));
  });
  test('rejects owner_subject corrupt (INVALID, not CONFLICT)', () => {
    const raw = basePrepared(); raw.owner_subject = '';
    assertInvalid(() => validatePreparedTeamsContext(raw));
  });
});

describe('validatePreparedTeamsContext trusted target', () => {
  test('accepts matching trusted target', () => {
    const raw = basePrepared();
    const result = validatePreparedTeamsContext(raw, { target: { tenantId: FIXED.tenantId, agentInstanceId: FIXED.agentInstanceId } });
    assert.strictEqual(result.grant.tenant_id, FIXED.tenantId);
  });
  test('rejects trusted target tenant mismatch as CONFLICT', () => {
    const raw = basePrepared();
    assertConflict(() => validatePreparedTeamsContext(raw, { target: { tenantId: 'other', agentInstanceId: FIXED.agentInstanceId } }));
  });
  test('rejects trusted target agentInstance mismatch as CONFLICT', () => {
    const raw = basePrepared();
    assertConflict(() => validatePreparedTeamsContext(raw, { target: { tenantId: FIXED.tenantId, agentInstanceId: 'other' } }));
  });
  test('null trusted target is treated as not passed', () => {
    const raw = basePrepared();
    assert.doesNotThrow(() => validatePreparedTeamsContext(raw, { target: null }));
  });
});

describe('validatePreparedTeamsContext validateCommand hook', () => {
  test('calls validateCommand with an independent copy and uses its result', () => {
    const raw = basePrepared();
    const canonicalCmd = clone(raw.command);
    let called = false;
    const result = validatePreparedTeamsContext(raw, {
      validateCommand: (c) => { called = true; assert.notStrictEqual(c, raw.command); assert.deepEqual(c, raw.command); return canonicalCmd; },
    });
    assert.strictEqual(called, true);
    assert.notStrictEqual(result.command, canonicalCmd);
    assert.deepStrictEqual(result.command, canonicalCmd);
  });
  test('rejects validateCommand result whose command_id mismatches ref as CONFLICT', () => {
    const raw = basePrepared();
    const bad = clone(raw.command); bad.command_id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    assertConflict(() => validatePreparedTeamsContext(raw, { validateCommand: () => bad }));
  });
  test('propagates validateCommand thrown error unchanged', () => {
    const raw = basePrepared();
    const marker = new Error('bad');
    assert.throws(() => validatePreparedTeamsContext(raw, { validateCommand: () => { throw marker; } }), (e) => e === marker);
  });
  test('rejects validateCommand result that is not a plain object', () => {
    const raw = basePrepared();
    assertInvalid(() => validatePreparedTeamsContext(raw, { validateCommand: () => 'nope' }));
  });
});

describe('validatePreparedTeamsContext independence', () => {
  test('mutating the returned copy does not affect the input', () => {
    const raw = basePrepared();
    const result = validatePreparedTeamsContext(raw);
    result.context.added = true;
    result.command.payload.extra = 1;
    assert.strictEqual(raw.context.added, undefined);
    assert.strictEqual(raw.command.payload.extra, undefined);
  });
  test('mutating the input after validation does not affect the returned copy', () => {
    const raw = basePrepared();
    const result = validatePreparedTeamsContext(raw);
    raw.context.after = true;
    raw.command.payload.after = true;
    assert.strictEqual(result.context.after, undefined);
    assert.strictEqual(result.command.payload.after, undefined);
  });
});

describe('validateTeamsCallbackPermit shape', () => {
  test('accepts a valid execute permit and returns an independent copy', () => {
    const raw = basePermit();
    const result = validateTeamsCallbackPermit(raw);
    assert.deepStrictEqual(result, raw);
    assert.notStrictEqual(result, raw);
    assert.notStrictEqual(result.allowedOperations, raw.allowedOperations);
  });
  test('accepts a valid recovery permit', () => {
    const raw = basePermit();
    raw.permitKind = 'recovery';
    raw.allowedOperations = ['append_effect_evidence'];
    const result = validateTeamsCallbackPermit(raw);
    assert.strictEqual(result.permitKind, 'recovery');
  });
  test('rejects unknown field', () => {
    const raw = basePermit(); raw.extra = 1;
    assertCbInvalid(() => validateTeamsCallbackPermit(raw));
  });
  test('rejects schemaVersion other than 1', () => {
    const raw = basePermit(); raw.schemaVersion = 2;
    assertCbInvalid(() => validateTeamsCallbackPermit(raw));
  });
  test('rejects wrong audience', () => {
    const raw = basePermit(); raw.audience = 'agentengine-teams-runtime';
    assertCbInvalid(() => validateTeamsCallbackPermit(raw));
  });
  test('rejects wrong permitKind', () => {
    const raw = basePermit(); raw.permitKind = 'probe';
    assertCbInvalid(() => validateTeamsCallbackPermit(raw));
  });
  test('rejects malformed command UUID', () => {
    const raw = basePermit(); raw.commandId = 'not-a-uuid';
    assertCbInvalid(() => validateTeamsCallbackPermit(raw));
  });
  test('rejects malformed digest', () => {
    const raw = basePermit(); raw.bundleDigest = 'sha256:bad';
    assertCbInvalid(() => validateTeamsCallbackPermit(raw));
  });
});

describe('validateTeamsCallbackPermit lifetime and timestamps', () => {
  test('rejects lifetime over 30s', () => {
    const raw = basePermit();
    raw.expiresAt = '2026-10-25T00:00:31.000Z';
    assertCbInvalid(() => validateTeamsCallbackPermit(raw));
  });
  test('accepts lifetime of exactly 30s', () => {
    const raw = basePermit();
    raw.expiresAt = '2026-10-25T00:00:30.000Z';
    assert.doesNotThrow(() => validateTeamsCallbackPermit(raw));
  });
  test('rejects non-positive lifetime', () => {
    const raw = basePermit();
    raw.expiresAt = raw.issuedAt;
    assertCbInvalid(() => validateTeamsCallbackPermit(raw));
  });
  test('rejects expiresAt before issuedAt', () => {
    const raw = basePermit();
    raw.issuedAt = '2026-10-25T00:00:10.000Z';
    raw.expiresAt = '2026-10-25T00:00:00.000Z';
    assertCbInvalid(() => validateTeamsCallbackPermit(raw));
  });
  test('rejects non-UTC-ms timestamp format', () => {
    const raw = basePermit();
    raw.issuedAt = '2026-10-25T00:00:00Z';
    assertCbInvalid(() => validateTeamsCallbackPermit(raw));
  });
  test('rejects timestamp with offset', () => {
    const raw = basePermit();
    raw.expiresAt = '2026-10-25T00:00:10.000+00:00';
    assertCbInvalid(() => validateTeamsCallbackPermit(raw));
  });
});

describe('validateTeamsCallbackPermit signature and revisions', () => {
  test('rejects empty signature', () => {
    const raw = basePermit(); raw.signature = '';
    assertCbInvalid(() => validateTeamsCallbackPermit(raw));
  });
  test('rejects non-base64url signature', () => {
    const raw = basePermit(); raw.signature = 'has space!';
    assertCbInvalid(() => validateTeamsCallbackPermit(raw));
  });
  test('rejects signature longer than 128', () => {
    const raw = basePermit(); raw.signature = 'A'.repeat(129);
    assertCbInvalid(() => validateTeamsCallbackPermit(raw));
  });
  test('accepts signature of exactly 128 base64url chars', () => {
    const raw = basePermit(); raw.signature = 'A'.repeat(128);
    assert.doesNotThrow(() => validateTeamsCallbackPermit(raw));
  });
  test('rejects grantRevision zero', () => {
    const raw = basePermit(); raw.grantRevision = 0;
    assertCbInvalid(() => validateTeamsCallbackPermit(raw));
  });
  test('rejects grantRevision non-integer', () => {
    const raw = basePermit(); raw.grantRevision = 1.5;
    assertCbInvalid(() => validateTeamsCallbackPermit(raw));
  });
  test('rejects grantRevision string', () => {
    const raw = basePermit(); raw.grantRevision = '2';
    assertCbInvalid(() => validateTeamsCallbackPermit(raw));
  });
  test('rejects unsafe-large grantRevision', () => {
    const raw = basePermit(); raw.grantRevision = Number.MAX_SAFE_INTEGER + 1;
    assertCbInvalid(() => validateTeamsCallbackPermit(raw));
  });
  test('rejects attemptEpoch zero', () => {
    const raw = basePermit(); raw.attemptEpoch = 0;
    assertCbInvalid(() => validateTeamsCallbackPermit(raw));
  });
  test('rejects leaderEpoch zero', () => {
    const raw = basePermit(); raw.leaderEpoch = 0;
    assertCbInvalid(() => validateTeamsCallbackPermit(raw));
  });
});

describe('validateTeamsCallbackPermit allowed operations', () => {
  test('rejects execute op outside the allowed set', () => {
    const raw = basePermit(); raw.allowedOperations = ['policy', 'cancel'];
    assertCbInvalid(() => validateTeamsCallbackPermit(raw));
  });
  test('rejects recovery op outside {append_effect_evidence}', () => {
    const raw = basePermit();
    raw.permitKind = 'recovery';
    raw.allowedOperations = ['policy'];
    assertCbInvalid(() => validateTeamsCallbackPermit(raw));
  });
  test('rejects duplicate ops', () => {
    const raw = basePermit(); raw.allowedOperations = ['policy', 'policy'];
    assertCbInvalid(() => validateTeamsCallbackPermit(raw));
  });
  test('rejects empty allowedOperations', () => {
    const raw = basePermit(); raw.allowedOperations = [];
    assertCbInvalid(() => validateTeamsCallbackPermit(raw));
  });
  test('rejects more than 8 allowedOperations', () => {
    const raw = basePermit();
    raw.allowedOperations = ['policy','invoke','effects','read_material','create_artifact','upload_artifact','finalize_artifact','policy2'.slice(0,7)];
    raw.allowedOperations = ['policy','invoke','effects','read_material','create_artifact','upload_artifact','finalize_artifact','x'];
    assertCbInvalid(() => validateTeamsCallbackPermit(raw));
  });
  test('rejects non-string op', () => {
    const raw = basePermit(); raw.allowedOperations = ['policy', 1];
    assertCbInvalid(() => validateTeamsCallbackPermit(raw));
  });
  test('accepts all 7 execute ops', () => {
    const raw = basePermit();
    raw.allowedOperations = ['policy','invoke','effects','read_material','create_artifact','upload_artifact','finalize_artifact'];
    assert.doesNotThrow(() => validateTeamsCallbackPermit(raw));
  });
});

describe('validateTeamsCallbackPermit independence', () => {
  test('mutating the returned permit does not affect the input', () => {
    const raw = basePermit();
    const result = validateTeamsCallbackPermit(raw);
    result.allowedOperations.push('cancel');
    result.signature = 'tampered';
    assert.strictEqual(raw.allowedOperations.length, 2);
    assert.strictEqual(raw.signature, 'c2lnbmF0dXJl');
  });
});
