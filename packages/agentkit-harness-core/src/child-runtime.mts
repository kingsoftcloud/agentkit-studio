import type { ChildApproval, ChildLifecycleRequest, ChildLifecycleResult, ChildReadyRequest, ChildTaskControlState } from './child-contract.mjs';
import type { CommitBatch, EffectIntent, ObjectValue, RunCommand, RunConfiguration, RunSnapshot, ToolDefinition, ToolResult } from './contracts.mjs';
import { addUsage } from './machine.mjs';
import { admittedToolBudget, reduceChildBudget } from './child-budget.mjs';
import { canonical, copy, invariant } from './values.mjs';
import { prepareEffect, transition } from './transitions.mjs';
import { toolUsageIncomplete } from './tool-resource-usage.mjs';
import { CHILD_TASK_POLICY, reduceCoordinatorResponses } from './coordinator-response.mjs';

const settlementAuthority: ToolDefinition = { name: 'host_child_collection', description: 'Collect already owned children',
  parameters: { type: 'object' }, readOnly: false, concurrentSafe: false, permissions: [], timeoutMs: 1,
  contextRole: 'none', observationRole: 'none', progressObservation: false, contextRetention: 'normal', childBudgetPolicy: 'settle/v1' };
export const childLifecycleCursor = (snapshot: RunSnapshot): string => `${snapshot.goalRevision}:${snapshot.usage.modelCalls}:${snapshot.usage.toolCalls}`;
export const unsettledChildren = (snapshot: RunSnapshot) => (snapshot.childBudgetReservations ?? []).filter(item => item.settledUsageDigest === null);

export function admitChildPromotion(snapshot: RunSnapshot, config: RunConfiguration | undefined, command: RunCommand,
  tasks: ChildTaskControlState[] = []): { reason: string; changes: Partial<RunSnapshot>; facts: { kind: string; payload: ObjectValue }[] } {
  const reject = (reason: string) => ({ reason, changes: {}, facts: [] });
  if (config?.childPromotionPolicy !== 'owned-child-promotion/v1') return reject('child_promotion_unavailable');
  const id = command.payload.childRunId;
  if (Object.keys(command.payload).length !== 1 || typeof id !== 'string' || !id.trim()) return reject('invalid_child_promotion');
  if (snapshot.childTerminalPhase || snapshot.phase === 'finalizing'
    || (snapshot.promotedChildRunIds ?? []).includes(id)
    || !unsettledChildren(snapshot).some(item => item.childRunId === id && item.deliveryMode === 'foreground')
    || !tasks.some(item => item.childRunId === id && item.delivery === 'foreground' && item.canPromote)) return reject('foreground_child_unavailable');
  return { reason: 'applied', changes: { promotedChildRunIds: [...snapshot.promotedChildRunIds ?? [], id], childLifecycleCursor: null },
    facts: [{ kind: 'child.promoted', payload: { childRunId: id, commandId: command.commandId, delivery: 'background' } }] };
}

export function childUsageFacts(snapshot: RunSnapshot, operationKey: string, results: ToolResult[]): { kind: string; payload: ObjectValue }[] {
  return results.flatMap(item => {
    const child = item.childBudgetSettlement?.childRunId;
    if (!child || !snapshot.childBudgetReservations.some(value => value.childRunId === child && value.settledUsageDigest === null)
      && !(item.childBudgetReservation?.childRunId === child && !snapshot.childRunIds.includes(child))) return [];
    return [{ kind: toolUsageIncomplete(item) ? 'usage.unavailable' : 'usage.reported', payload: {
      semantics: 'delta', source: 'descendant_runs', requestId: operationKey, attemptId: `${operationKey}:child:${child}`,
      childRunId: child, usage: copy(item.resourceUsage ?? {}) as unknown as ObjectValue,
    } }];
  });
}

export function prepareChildLifecycle(snapshot: RunSnapshot, config: RunConfiguration): CommitBatch | null {
  if (config.childLifecyclePolicy !== 'owned-background/v2' || snapshot.pendingIntent || !unsettledChildren(snapshot).length) return null;
  const foreground = unsettledChildren(snapshot).filter(item => item.deliveryMode === 'foreground'
    && !(snapshot.promotedChildRunIds ?? []).includes(item.childRunId)).map(item => item.childRunId);
  const barrier = foreground.length > 0 && ['preparing_context', 'executing_tools'].includes(snapshot.phase);
  const action = snapshot.phase === 'finalizing' ? 'cancel' : snapshot.phase === 'verifying' || barrier ? 'wait' : 'poll';
  if (snapshot.childLifecycleFailure === 'cancel' || snapshot.childLifecycleFailure && action !== 'cancel') return null;
  if (action === 'poll' && (snapshot.phase !== 'preparing_context'
    || snapshot.childLifecycleCursor === childLifecycleCursor(snapshot) && !snapshot.childApproval)) return null;
  return prepareEffect(snapshot, 'child', snapshot.phase, { action, reservations: copy(unsettledChildren(snapshot)) as never,
    ...(config.childTaskPolicy === CHILD_TASK_POLICY ? { responseCursors: copy(snapshot.childResponseCursors ?? {}) } : {}),
    ...(barrier ? { waitForChildRunIds: foreground } : {}),
    childApproval: action === 'cancel' ? null : copy(snapshot.childApproval ?? null) as never,
    interaction: action === 'cancel' ? null : copy(snapshot.interaction) });
}

export function childLifecycleRequest(snapshot: RunSnapshot, intent: EffectIntent, signal: AbortSignal): ChildLifecycleRequest {
  invariant(intent.kind === 'child' && snapshot.pendingIntent === intent.operationKey
    && ['poll', 'wait', 'cancel'].includes(String(intent.payload.action))
    && canonical(intent.payload.reservations) === canonical(unsettledChildren(snapshot)), 'child_observation_identity_conflict');
  const selected = intent.payload.waitForChildRunIds as unknown as string[] | undefined;
  const waitFor = selected?.filter(id => !(snapshot.promotedChildRunIds ?? []).includes(id));
  return { scope: copy(snapshot.scope), runId: snapshot.runId, sessionId: snapshot.sessionId, turnId: snapshot.turnId,
    buildId: snapshot.buildId, parentRunId: snapshot.parentRunId, taskChainId: snapshot.taskChainId,
    operationKey: intent.operationKey, signal, action: selected && !waitFor!.length ? 'poll' : intent.payload.action as ChildLifecycleRequest['action'],
    ...(intent.claimedFence === undefined ? {} : { executionFence: intent.claimedFence }),
    reservations: copy(unsettledChildren(snapshot)), childApproval: copy(intent.payload.childApproval) as unknown as ChildApproval | null,
    ...(intent.payload.responseCursors === undefined ? {} : { responseCursors: copy(intent.payload.responseCursors) as Record<string, number> }),
    ...(waitFor?.length ? { waitForChildRunIds: copy(waitFor) } : {}),
    interaction: copy(intent.payload.interaction) as ChildLifecycleRequest['interaction'] };
}

export function validateChildApproval(reservations: ChildLifecycleRequest['reservations'], approval: ChildApproval): void {
  invariant(approval && reservations.some(item => item.childRunId === approval.childRunId
    && canonical(item.childScope) === canonical(approval.childScope) && item.parentOperationKey === approval.parentOperationKey
    && item.parentToolCallId === approval.parentToolCallId && item.settledUsageDigest === null)
    && [approval.interactionId, approval.hostInteractionId, approval.toolCall?.callId, approval.toolCall?.name].every(value => typeof value === 'string' && value.trim())
    && typeof approval.definitionDigest === 'string' && /^[0-9a-f]{64}$/.test(approval.definitionDigest), 'child_approval_not_reserved');
}

export function reduceChildLifecycle(snapshot: RunSnapshot, config: RunConfiguration, request: ChildLifecycleRequest,
  result: ChildLifecycleResult, digest: (value: unknown) => string, { observationOnly = false } = {}): Partial<RunSnapshot> {
  invariant(request.runId === snapshot.runId && canonical(request.scope) === canonical(snapshot.scope)
    && request.operationKey === snapshot.pendingIntent && canonical(request.reservations) === canonical(unsettledChildren(snapshot)), 'child_observation_identity_conflict');
  invariant(canonical(request.responseCursors ?? null) === canonical(config.childTaskPolicy === CHILD_TASK_POLICY
    ? snapshot.childResponseCursors ?? {} : null), 'coordinator_response_cursor_conflict');
  if (request.waitForChildRunIds) invariant(request.action === 'wait' && request.waitForChildRunIds.length > 0
    && new Set(request.waitForChildRunIds).size === request.waitForChildRunIds.length
    && request.waitForChildRunIds.every(id => request.reservations.some(item => item.childRunId === id && item.deliveryMode === 'foreground')),
  'child_foreground_wait_identity_conflict');
  invariant(result && result.operationKey === request.operationKey && Array.isArray(result.results)
    && Array.isArray(result.pendingChildRunIds) && Array.isArray(result.approvals)
    && [null, 'child_owner_unavailable', 'child_receipt_unavailable'].includes(result.errorCode), 'child_lifecycle_result_identity_conflict');
  const requested = new Set(request.reservations.map(item => item.childRunId));
  const settled = result.results.map(item => item.childBudgetSettlement?.childRunId);
  const pending = result.pendingChildRunIds;
  invariant(requested.size === request.reservations.length && settled.every(id => typeof id === 'string' && requested.has(id))
    && new Set(settled).size === settled.length && new Set(pending).size === pending.length
    && pending.every(id => requested.has(id) && !settled.includes(id)) && settled.length + pending.length === requested.size
    && result.results.every(item => !item.childBudgetReservation)
    && new Set(result.approvals.map(item => item.childRunId)).size === result.approvals.length
    && result.approvals.every(item => pending.includes(item.childRunId))
    && (request.action !== 'cancel' || result.approvals.length === 0), 'child_lifecycle_result_identity_conflict');
  for (const approval of result.approvals) validateChildApproval(request.reservations, approval);
  let updated = copy(snapshot);
  updated.pendingIntent = null; updated.childLifecycleCursor = childLifecycleCursor(snapshot);
  if (request.action !== 'cancel') {
    updated.childApproval = null; updated.interaction = null; updated.pendingInteraction = null;
  }
  for (const item of result.results) {
    const before = updated.childBudgetReservations.find(value => value.childRunId === item.childBudgetSettlement!.childRunId)!;
    const ledger = reduceChildBudget(updated, item, settlementAuthority, request.operationKey,
      { callId: before.parentToolCallId, name: settlementAuthority.name, arguments: {} }, admittedToolBudget(snapshot, config, 0), digest);
    updated.childBudgetReservations = ledger.childBudgetReservations; updated.childRunIds = ledger.childRunIds;
    updated.descendantUsage = addUsage(updated.descendantUsage, ledger.usage);
    if (toolUsageIncomplete(item)) updated.diagnostics.descendantUsageIncomplete = true;
    if (before.settledUsageDigest !== null || request.action === 'cancel') continue;
    const content = canonical(item.content), truncated = sliceUnicode(content, 8192);
    updated.messages.push({ role: 'user', kind: 'background_child_observation', content: canonical({ source: 'child_result', trust: 'data',
      parentAcceptance: 'not_evaluated', childRunId: before.childRunId, receiptRef: request.operationKey,
      status: item.status, result: truncated, textTruncated: truncated.length < content.length }) });
    updated.preparedContext = null;
    if (snapshot.phase === 'verifying') {
      updated.phase = 'preparing_context'; updated.candidate = null; updated.verification = null;
      updated.finalText = ''; updated.outcome = null; updated.reason = null;
    }
  }
  if (result.children !== undefined) {
    invariant(Array.isArray(result.children) && new Set(result.children.map(item => item.runId)).size === result.children.length, 'child_state_identity_conflict');
    for (const child of result.children) {
      const owned = request.reservations.find(item => item.childRunId === child.runId);
      invariant(owned && owned.parentOperationKey === child.operationKey && owned.parentToolCallId === child.callId
        && child.reservedModelCalls === owned.maxModelCalls && child.reservedToolCalls === owned.maxToolCalls
        && ['prepared', 'running', 'awaiting_interaction', 'completed', 'failed', 'canceled', 'interrupted'].includes(child.state)
        && (settled.includes(child.runId) ? ['completed', 'failed', 'canceled'].includes(child.state)
          : !['completed', 'failed', 'canceled'].includes(child.state))
        && child.usage.modelCalls <= owned.maxModelCalls && child.usage.toolCalls <= owned.maxToolCalls
        && typeof child.sessionId === 'string' && child.sessionId.trim(), 'child_state_identity_conflict');
      addUsage({ inputTokens: 0, outputTokens: 0, modelCalls: 0, toolCalls: 0, cost: 0 }, child.usage);
      const index = updated.children.findIndex(item => item.runId === child.runId);
      const projected = { ...copy(child), notified: settled.includes(child.runId) };
      if (index < 0) updated.children.push(projected); else updated.children[index] = projected;
    }
  }
  if (request.action !== 'cancel') Object.assign(updated, reduceCoordinatorResponses(updated, config, result.responses,
    request.reservations.map(item => item.childRunId), digest));
  if (result.approvals.length && !result.errorCode) {
    invariant(config.childApprovalPolicy === 'owned-child-approval/v1', 'child_approval_policy_unavailable');
    const approval = copy(result.approvals[0]!);
    updated.childApproval = approval; updated.resumePhase = updated.phase; updated.phase = 'awaiting_interaction';
    updated.pendingInteraction = { interactionId: `${request.operationKey}:approval`, hostInteractionId: `native-child-${digest(approval)}`,
      callId: approval.toolCall.callId, operationKey: request.operationKey };
    updated.interaction = null;
  } else if (result.errorCode || !observationOnly && request.action !== 'poll'
    && pending.some(id => !request.waitForChildRunIds || request.waitForChildRunIds.includes(id))) {
    updated.phase = 'finalizing'; updated.candidate = null; updated.verification = null;
    updated.childLifecycleFailure = request.action; updated.outcome = 'unverified';
    updated.reason = result.errorCode ?? 'background_children_unsettled'; updated.finalText = '';
  }
  return updated;
}

// Bound notices by Unicode scalar count without importing a Node API into the core.
function sliceUnicode(value: string, limit: number): string { return Array.from(value).slice(0, limit).join(''); }

export function childReadyProbe(snapshot: RunSnapshot, config: RunConfiguration, intent: EffectIntent | null): ChildReadyRequest | null {
  if (config.childLifecyclePolicy !== 'owned-background/v2' || snapshot.phase !== 'requesting_model'
    || intent?.kind !== 'model' || intent.status !== 'prepared' || snapshot.pendingIntent !== intent.operationKey
    || ['compaction', 'delivery_review'].includes(String(intent.payload.purpose))) return null;
  const reservations = unsettledChildren(snapshot);
  return reservations.length ? { scope: copy(snapshot.scope), runId: snapshot.runId, sessionId: snapshot.sessionId,
    turnId: snapshot.turnId, buildId: snapshot.buildId, parentRunId: snapshot.parentRunId, taskChainId: snapshot.taskChainId,
    reservations: copy(reservations), includeApprovals: config.childApprovalPolicy === 'owned-child-approval/v1',
    ...(config.childTaskPolicy === CHILD_TASK_POLICY ? { responseCursors: copy(snapshot.childResponseCursors ?? {}) } : {}) } : null;
}
export function stageChildReady(snapshot: RunSnapshot, config: RunConfiguration, intent: EffectIntent,
  request: ChildReadyRequest, ids: string[]): CommitBatch | null {
  invariant(canonical(childReadyProbe(snapshot, config, intent)) === canonical(request)
    && Array.isArray(ids) && ids.length === new Set(ids).size
    && ids.every(id => request.reservations.some(item => item.childRunId === id)), 'child_readiness_identity_conflict');
  if (!ids.length) return null;
  return transition(snapshot, { phase: 'preparing_context', pendingIntent: null, preparedContext: null, childLifecycleCursor: null },
    [{ kind: 'child.ready_observed', payload: { childRunIds: ids, operationKey: intent.operationKey } }],
    { receipts: [{ operationKey: intent.operationKey, status: 'not_dispatched', result: {
      code: 'superseded_by_child_observation', executed: false, childRunIds: ids } }], requireNoPendingCommands: true });
}
export function isChildReadyBatch(snapshot: RunSnapshot, config: RunConfiguration, batch: CommitBatch, intent: EffectIntent): boolean {
  try {
    const effective = snapshot.taskContract ? { ...config, contract: snapshot.taskContract } : config;
    const request = childReadyProbe(snapshot, effective, intent);
    const ids = batch.receipts[0]?.result.childRunIds;
    if (!request || !Array.isArray(ids) || !ids.length) return false;
    const expected = stageChildReady(snapshot, effective, intent, request, ids as string[]);
    // Driver activity may advance time before commit; Store checks its monotonicity.
    return expected !== null && canonical({ ...expected, snapshot: { ...expected.snapshot,
      activeElapsedMs: batch.snapshot.activeElapsedMs } }) === canonical(batch);
  } catch { return false; }
}
