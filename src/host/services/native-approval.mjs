import { invariant } from '@kingsoftcloud/agentkit-harness-core';

const text = value => typeof value === 'string' && value.trim() && value.length <= 256 && !value.includes('\0');

export function validateNativeApprovalStatusRequest(value) {
  invariant(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => ['agentId', 'sessionId', 'runId'].includes(key))
    && text(value.agentId) && text(value.sessionId)
    && (value.runId === undefined || text(value.runId)), 'STUDIO_NATIVE_APPROVAL_STATUS_INVALID');
}

export function validateNativeApprovalDecisionRequest(value) {
  invariant(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'agentId,decision,expectedGeneration,interactionId,requestId,runId,sessionId'
    && ['agentId', 'sessionId', 'runId', 'interactionId', 'requestId', 'expectedGeneration'].every(key => text(value[key]))
    && ['allow', 'deny'].includes(value.decision), 'STUDIO_NATIVE_APPROVAL_DECISION_INVALID');
}
