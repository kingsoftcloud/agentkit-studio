import { randomUUID } from 'node:crypto';
import { teamsContextDigest } from '../../src/providers/native-teams-context-contract.mjs';
import { command, target } from './native-managed-kernel.mjs';

export function preparedContext({ sessionId = 'teams-session', contextRef = randomUUID(), policyRef = randomUUID(),
  owner = 'actual-studio-user', commandId = randomUUID(), idem = randomUUID(), ...changes } = {}) {
  const grant = { grant_id: randomUUID(), tenant_id: target.tenantId, agent_instance_id: target.agentInstanceId,
    session_id: sessionId, owner_ref: 'teams/group/member', attempt_epoch: 7 };
  const context = { systemContext: 'Trusted team task', childSystemContext: '', limits: { max_model_calls: 3 } };
  const ref = { authorityId: 'authority', groupId: 'group', teamRunId: 'team-run', memberId: 'member', runMemberId: 'run-member',
    taskId: null, attemptId: 'attempt', deliveryId: 'delivery', bindingRef: 'binding', providerRef: 'provider', sessionId,
    commandId, idempotencyKey: idem, schedulerEpoch: 2, leaderEpoch: 3, dispatchEpoch: 4, attemptEpoch: 7,
    target: { kind: 'cloud_agent', agentId: 'agent', versionId: 'version', runtimeId: 'runtime', agentInstanceId: target.agentInstanceId },
    bundleDigest: teamsContextDigest('bundle'), contractDigest: teamsContextDigest('contract'), capabilitiesDigest: teamsContextDigest('capabilities'), nativeRunId: null };
  return { context_ref: contextRef, context_digest: teamsContextDigest(context), policy_ref: policyRef,
    policy_digest: teamsContextDigest('policy'), owner_subject: owner, ref, grant,
    command: command({ command_id: commandId, idempotency_key: idem, session_id: sessionId,
      payload: { content: 'Original Teams request', execution_grant_id: grant.grant_id, execution_grant_attempt_epoch: grant.attempt_epoch,
        execution_policy_ref: policyRef, teams_context_ref: contextRef } }), context,
    material_manifest_ref: null, material_manifest_digest: null, ...changes };
}

export function callbackPermit(context, { now = Date.now(), ttl = 20000, revision = 1, ...changes } = {}) {
  return { schemaVersion: 1, audience: 'agentengine-teams-callback', permitKind: 'execute', issuer: 'trusted-server', kid: 'server',
    authorityId: context.ref.authorityId, issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + ttl).toISOString(),
    nonce: randomUUID(), signature: 'A'.repeat(86), groupId: context.ref.groupId, teamRunId: context.ref.teamRunId,
    memberId: context.ref.memberId, commandId: context.ref.commandId, sessionId: context.ref.sessionId,
    agentInstanceId: context.grant.agent_instance_id, bundleDigest: context.ref.bundleDigest, policyDigest: context.policy_digest,
    attemptEpoch: context.ref.attemptEpoch, leaderEpoch: context.ref.leaderEpoch, grantRevision: revision,
    allowedOperations: ['policy', 'invoke'], ...changes };
}
