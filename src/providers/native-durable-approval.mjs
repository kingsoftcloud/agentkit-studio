import { createHash } from 'node:crypto';
import { canonical, invariant, parseNativeJson } from '@kingsoftcloud/agentkit-harness-core';

export const NATIVE_DURABLE_APPROVAL = 'durable-preflight/v1';
export const HOST_PREFLIGHT_DEFER = 'dsh.tool-preflight-defer/v1';
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');

/** A permission belongs to one immutable call until that call settles. A
 * second tool-owned question does not consume the first permission grant. */
function decisionFor(record, request, interactionId) {
  const closed = record.events.filter(event => event.kind === 'tool.completed' && event.payload.callId === request.call.callId)
    .reduce((seq, event) => Math.max(seq, event.seq), 0);
  let latest = null;
  for (const intent of record.intents) {
    if (intent.kind !== 'tool' || intent.operationKey === request.operationKey) continue;
    const index = intent.payload.calls.findIndex(call => canonical(call) === canonical(request.call));
    const receipt = record.receipts.find(row => row.operationKey === intent.operationKey && row.status === 'committed');
    const result = receipt?.result.results?.[index];
    if (index < 0 || result?.status !== 'approval_required' || result.interactionId !== interactionId) continue;
    for (const event of record.events) if (event.seq > closed && event.kind === 'approval.resolved'
      && event.payload.interactionId === `${intent.operationKey}:approval` && event.payload.callId === request.call.callId
      && (!latest || event.seq > latest.seq)) latest = event;
  }
  return latest?.payload.decision ?? null;
}

/** The gateway owns this bridge and its live invocation map. Durable grants
 * come only from the original Native ledger, never from registry arguments. */
export function createNativeDurableApproval({ ctx, calls }) {
  // This registry also contains verification and workspace-repair owners.
  // Their claims have their own authority checks and normal Host permission
  // pipeline; a model-tool approval contract cannot be borrowed by them.
  const durableInvocation = exec => {
    const invocation = calls.get(String(exec.callId));
    return !invocation?.verificationDispatch && !invocation?.repair
      && invocation?.request?.definition?.approvalPolicy === NATIVE_DURABLE_APPROVAL ? invocation : null;
  };
  const invocationFor = exec => {
    const invocation = durableInvocation(exec);
    if (!invocation) return null;
    const request = invocation.request;
    invariant(ctx.tools?.preflightDeferContract === HOST_PREFLIGHT_DEFER && exec.preflightDefer === HOST_PREFLIGHT_DEFER,
      'studio_native_durable_approval_host_unavailable');
    invariant(invocation.agent === exec.agent && invocation.registryName === exec.name
      && !invocation.dispatched && !exec.signal.aborted && !request.signal.aborted
      && canonical(invocation.argumentEncoding ? parseNativeJson(JSON.stringify(exec.arguments)) : exec.arguments)
        === canonical(request.call.arguments)
      && invocation.assertCurrent?.(request) === true, 'studio_native_durable_approval_stale');
    return invocation;
  };
  return {
    // Eligibility only selects the stricter policy path. Resolve rechecks the
    // complete live ledger authority before yielding or consuming a grant.
    eligible: exec => durableInvocation(exec) !== null,
    resolve(exec, reason) {
      const invocation = invocationFor(exec);
      if (!invocation) return null;
      const request = invocation.request;
      const interactionId = `native-permission-${hash({ scope: request.scope, runId: request.runId,
        sessionId: request.sessionId, buildId: request.buildId, call: request.call, definition: request.definition, reason })}`;
      const record = invocation.loadRecord();
      const decision = decisionFor(record, request, interactionId);
      if (decision === 'allow') return { kind: 'allow' };
      if (decision === 'deny') return { kind: 'deny', reason: 'Native 工具审批被拒绝' };
      const content = { contract: 'agentkit.native-permission-request/v1', reason,
        toolName: request.call.name, argumentDigest: hash(request.call.arguments) };
      const outcome = { status: 'approval_required', interactionId, approvalPolicy: NATIVE_DURABLE_APPROVAL, content };
      invocation.outcome = outcome;
      invocation.deferredApproval = { outcome, value: { result: canonical(content) } };
      return { kind: 'defer', value: invocation.deferredApproval.value };
    },
    assertProjection(invocation, result) {
      if (!invocation.deferredApproval || result.isError) return;
      invariant(!invocation.dispatched && canonical(result.value) === canonical(invocation.deferredApproval.value)
        && canonical(result.content) === canonical([{ type: 'text', text: invocation.deferredApproval.value.result }]),
      'studio_native_deferred_approval_projection_changed');
    },
  };
}
