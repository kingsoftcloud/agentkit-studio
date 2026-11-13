/** Preserve why the live Host could not approve an exact call. The Host's
 * approval service still makes the decision and records its normal audit. */
export async function requestNativeHostApproval(approval, agent, request) {
  if (request.signal?.aborted) return 'cancelled';
  if (typeof approval?.request !== 'function') return 'unavailable';
  const policy = approval.overrideOf?.(agent.session) ?? approval.config?.policy;
  const outcome = await approval.request({ ...request, agent });
  return outcome === 'rejected' && policy === 'never' ? 'prompts-disabled' : outcome;
}

export function nativeEngineApprovalReply(outcome, explain) {
  if (outcome === 'allowed-once') return 'allow';
  if (!explain) return 'deny';
  const denialReason = outcome === 'prompts-disabled' ? 'approval_prompts_disabled'
    : outcome === 'rejected' || outcome === 'denied' ? 'approval_rejected'
    : outcome === 'cancelled' ? 'approval_cancelled' : 'approval_unavailable';
  return { decision: 'deny', denialReason };
}
