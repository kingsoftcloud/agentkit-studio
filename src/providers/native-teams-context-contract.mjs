// Bounded standalone wire-validation adapter for Teams host context facts.
//
// This module only validates and copies JSON wire data. It never authorizes,
// verifies signatures, touches the database, or interprets records as
// executable tools or permissions. The Host must independently verify the
// callback signature, the live grant, the current attempt, and the persisted
// operation on every use. See ksadk/kernel/teams_execution_context.py,
// ksadk/plugins/teams/cloud_contracts.py and cloud_permits.py for the source
// of truth. Teams transport uses its own RFC8785 codec; no compatibility
// with old Python database serialization is required.

import { createHash } from 'node:crypto';
import { invariant } from '@kingsoftcloud/agentkit-harness-core';
import { canonicalTeamsJson, copyTeamsJson as copy } from './native-teams-json.mjs';

const CONTEXT_INVALID = 'NATIVE_TEAMS_CONTEXT_INVALID';
const CONTEXT_CONFLICT = 'NATIVE_TEAMS_CONTEXT_CONFLICT';
const CALLBACK_INVALID = 'NATIVE_TEAMS_CALLBACK_INVALID';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

function isPlainObject(v) {
  return typeof v === 'object' && v !== null &&
    (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
}
function isOpaqueId(v) {
  return typeof v === 'string' && v.length >= 1 && v.length <= 256 && /^[^\s\0]+$/.test(v);
}
const isOperationKey = v => typeof v === 'string' && v.length >= 1 && v.length <= 200 && v.trim().length > 0 && !v.includes('\0');
function isDigest(v) { return typeof v === 'string' && DIGEST_RE.test(v); }
function isUuid(v) { return typeof v === 'string' && UUID_RE.test(v); }
function isPositiveSafeInt(v) { return Number.isSafeInteger(v) && v >= 1; }
function isTimestamp(v) {
  return typeof v === 'string' && TIMESTAMP_RE.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
}
function isBase64url(v) { return typeof v === 'string' && BASE64URL_RE.test(v); }
function reject(code) { invariant(false, code); }
function noUnknownKeys(obj, allowed, code) {
  for (const k of Object.keys(obj)) invariant(allowed.includes(k), code);
}
function requireKeys(obj, keys, code) {
  for (const k of keys) invariant(k in obj, code);
}

export function teamsContextDigest(value) {
  return 'sha256:' + createHash('sha256').update(canonicalTeamsJson(value)).digest('hex');
}

export function teamsSessionOwnerDigest(prepared) {
  invariant(isPlainObject(prepared), CONTEXT_INVALID);
  invariant(isPlainObject(prepared.grant), CONTEXT_INVALID);
  invariant(isPlainObject(prepared.ref), CONTEXT_INVALID);
  invariant(typeof prepared.grant.tenant_id === 'string' && prepared.grant.tenant_id.length > 0, CONTEXT_INVALID);
  invariant(typeof prepared.owner_subject === 'string' && prepared.owner_subject.length > 0, CONTEXT_INVALID);
  invariant(typeof prepared.ref.authorityId === 'string' && prepared.ref.authorityId.length > 0, CONTEXT_INVALID);
  invariant(typeof prepared.ref.groupId === 'string' && prepared.ref.groupId.length > 0, CONTEXT_INVALID);
  invariant(typeof prepared.ref.teamRunId === 'string' && prepared.ref.teamRunId.length > 0, CONTEXT_INVALID);
  invariant(typeof prepared.ref.runMemberId === 'string' && prepared.ref.runMemberId.length > 0, CONTEXT_INVALID);
  invariant(typeof prepared.ref.bindingRef === 'string' && prepared.ref.bindingRef.length > 0, CONTEXT_INVALID);
  invariant(typeof prepared.grant.agent_instance_id === 'string' && prepared.grant.agent_instance_id.length > 0, CONTEXT_INVALID);
  return teamsContextDigest({
    tenant: prepared.grant.tenant_id,
    owner: prepared.owner_subject,
    authority: prepared.ref.authorityId,
    group: prepared.ref.groupId,
    teamRun: prepared.ref.teamRunId,
    member: prepared.ref.runMemberId,
    binding: prepared.ref.bindingRef,
    instance: prepared.grant.agent_instance_id,
  });
}

const REF_KEYS = ['authorityId','groupId','teamRunId','memberId','runMemberId','taskId','attemptId','deliveryId','bindingRef','providerRef','sessionId','commandId','idempotencyKey','schedulerEpoch','leaderEpoch','dispatchEpoch','attemptEpoch','target','bundleDigest','contractDigest','capabilitiesDigest','nativeRunId'];
const REF_REQUIRED = ['authorityId','groupId','teamRunId','memberId','runMemberId','attemptId','deliveryId','bindingRef','providerRef','sessionId','commandId','idempotencyKey','schedulerEpoch','leaderEpoch','dispatchEpoch','attemptEpoch','target','bundleDigest','contractDigest','capabilitiesDigest'];
const REF_ID_KEYS = ['authorityId','groupId','teamRunId','memberId','runMemberId','attemptId','deliveryId','bindingRef','providerRef','sessionId'];
const REF_EPOCH_KEYS = ['schedulerEpoch','leaderEpoch','dispatchEpoch','attemptEpoch'];
const REF_DIGEST_KEYS = ['bundleDigest','contractDigest','capabilitiesDigest'];

function validateTarget(target) {
  invariant(isPlainObject(target), CONTEXT_INVALID);
  invariant(target.kind === 'node' || target.kind === 'cloud_agent', CONTEXT_INVALID);
  if (target.kind === 'node') {
    noUnknownKeys(target, ['kind','nodeId','nodeGeneration'], CONTEXT_INVALID);
    requireKeys(target, ['nodeId','nodeGeneration'], CONTEXT_INVALID);
    invariant(isOpaqueId(target.nodeId), CONTEXT_INVALID);
    invariant(isPositiveSafeInt(target.nodeGeneration), CONTEXT_INVALID);
    return { kind: 'node', nodeId: target.nodeId, nodeGeneration: target.nodeGeneration };
  }
  noUnknownKeys(target, ['kind','agentId','versionId','runtimeId','agentInstanceId'], CONTEXT_INVALID);
  requireKeys(target, ['agentId','versionId','runtimeId','agentInstanceId'], CONTEXT_INVALID);
  for (const k of ['agentId','versionId','runtimeId','agentInstanceId']) invariant(isOpaqueId(target[k]), CONTEXT_INVALID);
  return { kind: 'cloud_agent', agentId: target.agentId, versionId: target.versionId, runtimeId: target.runtimeId, agentInstanceId: target.agentInstanceId };
}

function validateRef(ref) {
  invariant(isPlainObject(ref), CONTEXT_INVALID);
  noUnknownKeys(ref, REF_KEYS, CONTEXT_INVALID);
  requireKeys(ref, REF_REQUIRED, CONTEXT_INVALID);
  for (const k of REF_ID_KEYS) invariant(isOpaqueId(ref[k]), CONTEXT_INVALID);
  invariant(isOperationKey(ref.idempotencyKey), CONTEXT_INVALID);
  invariant(isUuid(ref.commandId), CONTEXT_INVALID);
  for (const k of REF_EPOCH_KEYS) invariant(isPositiveSafeInt(ref[k]), CONTEXT_INVALID);
  for (const k of REF_DIGEST_KEYS) invariant(isDigest(ref[k]), CONTEXT_INVALID);
  const taskId = ref.taskId === undefined || ref.taskId === null ? null : ref.taskId;
  invariant(taskId === null || isOpaqueId(taskId), CONTEXT_INVALID);
  const nativeRunId = ref.nativeRunId === undefined || ref.nativeRunId === null ? null : ref.nativeRunId;
  invariant(nativeRunId === null || isOpaqueId(nativeRunId), CONTEXT_INVALID);
  const target = validateTarget(ref.target);
  return {
    authorityId: ref.authorityId, groupId: ref.groupId, teamRunId: ref.teamRunId,
    memberId: ref.memberId, runMemberId: ref.runMemberId, taskId,
    attemptId: ref.attemptId, deliveryId: ref.deliveryId, bindingRef: ref.bindingRef,
    providerRef: ref.providerRef, sessionId: ref.sessionId, commandId: ref.commandId,
    idempotencyKey: ref.idempotencyKey, schedulerEpoch: ref.schedulerEpoch,
    leaderEpoch: ref.leaderEpoch, dispatchEpoch: ref.dispatchEpoch,
    attemptEpoch: ref.attemptEpoch, target, bundleDigest: ref.bundleDigest,
    contractDigest: ref.contractDigest, capabilitiesDigest: ref.capabilitiesDigest,
    nativeRunId,
  };
}

const GRANT_KEYS = ['grant_id','tenant_id','session_id','agent_instance_id','owner_ref','attempt_epoch'];
const GRANT_ID_KEYS = ['grant_id','tenant_id','session_id','agent_instance_id','owner_ref'];

function validateGrant(grant) {
  invariant(isPlainObject(grant), CONTEXT_INVALID);
  noUnknownKeys(grant, GRANT_KEYS, CONTEXT_INVALID);
  requireKeys(grant, GRANT_KEYS, CONTEXT_INVALID);
  for (const k of GRANT_ID_KEYS) invariant(isOpaqueId(grant[k]), CONTEXT_INVALID);
  invariant(isPositiveSafeInt(grant.attempt_epoch), CONTEXT_INVALID);
  return {
    grant_id: grant.grant_id, tenant_id: grant.tenant_id, session_id: grant.session_id,
    agent_instance_id: grant.agent_instance_id, owner_ref: grant.owner_ref,
    attempt_epoch: grant.attempt_epoch,
  };
}

function validateCommandLocal(command) {
  invariant(isPlainObject(command), CONTEXT_INVALID);
  invariant(command.schema_version === 1 && isOpaqueId(command.authorization_ref) && isTimestamp(command.submitted_at), CONTEXT_INVALID);
  invariant(isPlainObject(command.source) && ['studio', 'responses', 'agui', 'a2a', 'parent_agent', 'scheduler', 'workflow', 'channel', 'system']
    .includes(command.source.kind) && typeof command.source.ref === 'string', CONTEXT_INVALID);
  invariant(typeof command.command_type === 'string', CONTEXT_INVALID);
  invariant(isUuid(command.command_id), CONTEXT_INVALID);
  invariant(isOpaqueId(command.session_id), CONTEXT_INVALID);
  invariant(isOperationKey(command.idempotency_key), CONTEXT_INVALID);
  invariant(isOpaqueId(command.agent_instance_id), CONTEXT_INVALID);
  invariant(isOpaqueId(command.tenant_id), CONTEXT_INVALID);
  invariant(isPlainObject(command.payload), CONTEXT_INVALID);
  invariant(Object.hasOwn(command.payload, 'content'), CONTEXT_INVALID);
  invariant(isOpaqueId(command.payload.execution_grant_id), CONTEXT_INVALID);
  invariant(isPositiveSafeInt(command.payload.execution_grant_attempt_epoch), CONTEXT_INVALID);
  invariant(isOpaqueId(command.payload.execution_policy_ref), CONTEXT_INVALID);
  invariant(isOpaqueId(command.payload.teams_context_ref), CONTEXT_INVALID);
  return command;
}

const TOP_KEYS = ['context_ref','context_digest','policy_ref','policy_digest','owner_subject','ref','grant','command','context','material_manifest_ref','material_manifest_digest'];
const TOP_REQUIRED = ['context_ref','context_digest','policy_ref','policy_digest','owner_subject','ref','grant','command'];

export function validatePreparedTeamsContext(raw, opts = {}) {
  try { raw = copy(raw); } catch { reject(CONTEXT_INVALID); }
  const options = opts || {};
  const trustedTarget = options.target;
  const validateCommand = options.validateCommand;
  invariant(isPlainObject(raw), CONTEXT_INVALID);
  noUnknownKeys(raw, TOP_KEYS, CONTEXT_INVALID);
  requireKeys(raw, TOP_REQUIRED, CONTEXT_INVALID);
  invariant(isOpaqueId(raw.context_ref), CONTEXT_INVALID);
  invariant(isDigest(raw.context_digest), CONTEXT_INVALID);
  invariant(isOpaqueId(raw.policy_ref), CONTEXT_INVALID);
  invariant(isDigest(raw.policy_digest), CONTEXT_INVALID);
  invariant(isOpaqueId(raw.owner_subject), CONTEXT_INVALID);
  const ref = validateRef(raw.ref);
  const grant = validateGrant(raw.grant);
  const context = raw.context === undefined ? {} : raw.context;
  invariant(isPlainObject(context), CONTEXT_INVALID);
  const materialRef = raw.material_manifest_ref === undefined || raw.material_manifest_ref === null ? null : raw.material_manifest_ref;
  const materialDigest = raw.material_manifest_digest === undefined || raw.material_manifest_digest === null ? null : raw.material_manifest_digest;
  invariant((materialRef === null) === (materialDigest === null), CONTEXT_INVALID);
  invariant(materialRef === null || isOpaqueId(materialRef), CONTEXT_INVALID);
  invariant(materialDigest === null || isDigest(materialDigest), CONTEXT_INVALID);
  let command = validateCommandLocal(raw.command);
  if (typeof validateCommand === 'function') {
    command = validateCommand(command);
    invariant(isPlainObject(command), CONTEXT_INVALID);
    invariant(isPlainObject(command.payload), CONTEXT_INVALID);
    validateCommandLocal(command);
  }
  invariant(typeof command.command_type === 'string', CONTEXT_INVALID);
  invariant(command.command_type === 'enqueue', CONTEXT_CONFLICT);
  invariant(command.command_id === ref.commandId, CONTEXT_CONFLICT);
  invariant(command.session_id === ref.sessionId, CONTEXT_CONFLICT);
  invariant(command.idempotency_key === ref.idempotencyKey, CONTEXT_CONFLICT);
  invariant(grant.agent_instance_id === command.agent_instance_id, CONTEXT_CONFLICT);
  invariant(grant.session_id === command.session_id, CONTEXT_CONFLICT);
  invariant(grant.tenant_id === command.tenant_id, CONTEXT_CONFLICT);
  invariant(grant.attempt_epoch === ref.attemptEpoch, CONTEXT_CONFLICT);
  invariant(command.payload.execution_grant_id === grant.grant_id, CONTEXT_CONFLICT);
  invariant(command.payload.execution_grant_attempt_epoch === ref.attemptEpoch, CONTEXT_CONFLICT);
  invariant(command.payload.execution_policy_ref === raw.policy_ref, CONTEXT_CONFLICT);
  invariant(command.payload.teams_context_ref === raw.context_ref, CONTEXT_CONFLICT);
  if (ref.target.kind === 'cloud_agent') {
    invariant(ref.target.agentInstanceId === command.agent_instance_id, CONTEXT_CONFLICT);
  }
  let computedContextDigest = null;
  try { computedContextDigest = teamsContextDigest(context); }
  catch { reject(CONTEXT_INVALID); }
  invariant(raw.context_digest === computedContextDigest, CONTEXT_CONFLICT);
  if (trustedTarget !== undefined && trustedTarget !== null) {
    invariant(isPlainObject(trustedTarget), CONTEXT_INVALID);
    invariant(typeof trustedTarget.tenantId === 'string' && trustedTarget.tenantId.length > 0, CONTEXT_INVALID);
    invariant(typeof trustedTarget.agentInstanceId === 'string' && trustedTarget.agentInstanceId.length > 0, CONTEXT_INVALID);
    invariant(grant.tenant_id === trustedTarget.tenantId, CONTEXT_CONFLICT);
    invariant(grant.agent_instance_id === trustedTarget.agentInstanceId, CONTEXT_CONFLICT);
  }
  const prepared = {
    context_ref: raw.context_ref, context_digest: raw.context_digest,
    policy_ref: raw.policy_ref, policy_digest: raw.policy_digest,
    owner_subject: raw.owner_subject, ref, grant, command,
    context, material_manifest_ref: materialRef, material_manifest_digest: materialDigest,
  };
  return copy(prepared);
}

const PERMIT_KEYS = ['schemaVersion','audience','permitKind','issuer','kid','authorityId','issuedAt','expiresAt','nonce','signature','groupId','teamRunId','memberId','commandId','sessionId','agentInstanceId','bundleDigest','policyDigest','attemptEpoch','leaderEpoch','grantRevision','allowedOperations'];
const PERMIT_ID_KEYS = ['issuer','kid','authorityId','nonce','groupId','teamRunId','memberId','sessionId','agentInstanceId'];
const PERMIT_EPOCH_KEYS = ['attemptEpoch','leaderEpoch','grantRevision'];
const EXECUTE_OPS = new Set(['policy','invoke','effects','read_material','create_artifact','upload_artifact','finalize_artifact']);
const RECOVERY_OPS = new Set(['append_effect_evidence']);

export function validateTeamsCallbackPermit(raw) {
  try { raw = copy(raw); } catch { reject(CALLBACK_INVALID); }
  invariant(isPlainObject(raw), CALLBACK_INVALID);
  noUnknownKeys(raw, PERMIT_KEYS, CALLBACK_INVALID);
  requireKeys(raw, PERMIT_KEYS, CALLBACK_INVALID);
  invariant(raw.schemaVersion === 1, CALLBACK_INVALID);
  invariant(raw.audience === 'agentengine-teams-callback', CALLBACK_INVALID);
  invariant(raw.permitKind === 'execute' || raw.permitKind === 'recovery', CALLBACK_INVALID);
  for (const k of PERMIT_ID_KEYS) invariant(isOpaqueId(raw[k]), CALLBACK_INVALID);
  invariant(isUuid(raw.commandId), CALLBACK_INVALID);
  for (const k of ['bundleDigest','policyDigest']) invariant(isDigest(raw[k]), CALLBACK_INVALID);
  invariant(isTimestamp(raw.issuedAt), CALLBACK_INVALID);
  invariant(isTimestamp(raw.expiresAt), CALLBACK_INVALID);
  invariant(typeof raw.signature === 'string' && raw.signature.length >= 1 && raw.signature.length <= 128 && isBase64url(raw.signature), CALLBACK_INVALID);
  for (const k of PERMIT_EPOCH_KEYS) invariant(isPositiveSafeInt(raw[k]), CALLBACK_INVALID);
  const ttl = (Date.parse(raw.expiresAt) - Date.parse(raw.issuedAt)) / 1000;
  invariant(ttl > 0 && ttl <= 30, CALLBACK_INVALID);
  invariant(Array.isArray(raw.allowedOperations), CALLBACK_INVALID);
  invariant(raw.allowedOperations.length >= 1 && raw.allowedOperations.length <= 8, CALLBACK_INVALID);
  const allowedOps = raw.permitKind === 'execute' ? EXECUTE_OPS : RECOVERY_OPS;
  for (const op of raw.allowedOperations) {
    invariant(typeof op === 'string', CALLBACK_INVALID);
    invariant(allowedOps.has(op), CALLBACK_INVALID);
  }
  invariant(new Set(raw.allowedOperations).size === raw.allowedOperations.length, CALLBACK_INVALID);
  const permit = {
    schemaVersion: raw.schemaVersion, audience: raw.audience, permitKind: raw.permitKind,
    issuer: raw.issuer, kid: raw.kid, authorityId: raw.authorityId,
    issuedAt: raw.issuedAt, expiresAt: raw.expiresAt, nonce: raw.nonce,
    signature: raw.signature, groupId: raw.groupId, teamRunId: raw.teamRunId,
    memberId: raw.memberId, commandId: raw.commandId, sessionId: raw.sessionId,
    agentInstanceId: raw.agentInstanceId, bundleDigest: raw.bundleDigest,
    policyDigest: raw.policyDigest, attemptEpoch: raw.attemptEpoch,
    leaderEpoch: raw.leaderEpoch, grantRevision: raw.grantRevision,
    allowedOperations: [...raw.allowedOperations],
  };
  return copy(permit);
}
