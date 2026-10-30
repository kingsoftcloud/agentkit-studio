import { emptyUsage } from './contracts.mjs';
import type { ChildBudgetReservation, RunConfiguration, RunSnapshot, ToolBudget, ToolCall, ToolDefinition, ToolResult, Usage } from './contracts.mjs';
import { canonical, copy, invariant, scopeKey } from './values.mjs';
import { toolResourceUsage } from './tool-resource-usage.mjs';

/** Compaction, cancellation and replacement workers cannot discard allocated liability. */
export function validateChildBudgetTransition(previous: RunSnapshot, next: RunSnapshot): void {
  const before = previous.childBudgetReservations ?? [], after = next.childBudgetReservations ?? [];
  invariant(after.length >= before.length && before.every((item, index) => {
    const current = after[index];
    return current && canonical({ ...current, settledUsageDigest: item.settledUsageDigest }) === canonical(item)
      && (item.settledUsageDigest === null ? current.settledUsageDigest === null
        || typeof current.settledUsageDigest === 'string' && current.settledUsageDigest.length > 0
        : current.settledUsageDigest === item.settledUsageDigest);
  }), 'child_budget_reservation_is_immutable');
  const oldIds = previous.childRunIds ?? [], newIds = next.childRunIds ?? [];
  invariant(newIds.length >= oldIds.length && oldIds.every((id, index) => newIds[index] === id), 'child_run_ids_are_append_only');
  const promoted = next.promotedChildRunIds ?? [], previousPromoted = previous.promotedChildRunIds ?? [];
  invariant(promoted.length >= previousPromoted.length && previousPromoted.every((id, index) => promoted[index] === id)
    && new Set(promoted).size === promoted.length && promoted.every(id => after.some(item => item.childRunId === id
      && item.deliveryMode === 'foreground')), 'child_promotions_are_append_only');
  const cursors = next.childResponseCursors ?? {};
  invariant(Object.entries(previous.childResponseCursors ?? {}).every(([id, sequence]) => (cursors[id] ?? -1) >= sequence)
    && Object.entries(cursors).every(([id, sequence]) => after.some(item => item.childRunId === id)
      && Number.isSafeInteger(sequence) && sequence > 0), 'child_response_cursors_are_monotonic');
}

export function outstandingChildCalls(snapshot: RunSnapshot, kind: 'model' | 'tool'): number {
  let total = 0;
  for (const reservation of snapshot.childBudgetReservations ?? []) {
    if (reservation.settledUsageDigest !== null) continue;
    total += kind === 'model' ? reservation.maxModelCalls : reservation.maxToolCalls;
    invariant(Number.isSafeInteger(total), 'child_budget_overflow');
  }
  return total;
}

/** Null stays unlimited in the serialized request; never serialize Infinity. */
export function admittedToolBudget(snapshot: RunSnapshot, config: RunConfiguration, invokingCalls = 1): ToolBudget {
  const remaining = (limit: number | null, used: number, reserved: number) => limit === null ? null : Math.max(0, limit - used - reserved);
  return {
    maxModelCallsRemaining: remaining(config.limits.maxModelCalls,
      snapshot.usage.modelCalls + snapshot.descendantUsage.modelCalls,
      outstandingChildCalls(snapshot, 'model') + config.limits.finalizationReserveModelCalls),
    parentFinalizationReserved: true,
    maxToolCallsRemaining: remaining(config.limits.maxToolCalls,
      snapshot.usage.toolCalls + snapshot.descendantUsage.toolCalls,
      outstandingChildCalls(snapshot, 'tool') + invokingCalls),
    depth: config.delegationDepth, maxDepth: config.limits.maxSubagentDepth,
  };
}

function validateReservation(reservation: ChildBudgetReservation): void {
  scopeKey(reservation.childScope);
  for (const value of [reservation.childRunId, reservation.parentOperationKey, reservation.parentToolCallId]) {
    invariant(typeof value === 'string' && value.trim().length > 0, 'invalid_child_budget_reservation');
  }
  for (const value of [reservation.childRequestDigest, reservation.configurationDigest]) {
    invariant(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value), 'invalid_child_budget_digest');
  }
  invariant(Number.isSafeInteger(reservation.maxModelCalls) && reservation.maxModelCalls >= 1
    && Number.isSafeInteger(reservation.maxToolCalls) && reservation.maxToolCalls >= 0
    && reservation.settledUsageDigest === null, 'invalid_child_budget_reservation');
  invariant(reservation.deliveryMode === undefined || ['foreground', 'background'].includes(reservation.deliveryMode), 'invalid_child_delivery_mode');
}

/** Called on the sealed tool receipt, inside the same parent state transaction. */
export function reduceChildBudget(snapshot: RunSnapshot, result: ToolResult, definition: ToolDefinition | undefined,
  operationKey: string, call: ToolCall, budget: ToolBudget, digest: (value: unknown) => string): {
    childBudgetReservations: ChildBudgetReservation[]; childRunIds: string[]; usage: Usage;
  } {
  const reservations = copy(snapshot.childBudgetReservations ?? []), childRunIds = copy(snapshot.childRunIds ?? []);
  const reservation = result.childBudgetReservation, settlement = result.childBudgetSettlement;
  const usage = toolResourceUsage(result);
  if (reservation) {
    validateReservation(reservation);
    const foreground = reservation.deliveryMode === 'foreground' && settlement
      && settlement.childRunId === reservation.childRunId && ['ok', 'error'].includes(result.status);
    invariant(foreground || result.status === 'ok' && !settlement && !result.childRunIds?.length
      && Object.values(usage).every(value => value === 0), 'invalid_child_budget_start_receipt');
    invariant(definition?.childBudgetPolicy === 'start/v1' || definition?.childBudgetPolicy === 'delegate/v1', 'child_budget_start_not_admitted');
    invariant(reservation.parentOperationKey === operationKey && reservation.parentToolCallId === call.callId
      && (budget.maxModelCallsRemaining === null || reservation.maxModelCalls <= budget.maxModelCallsRemaining)
      && (budget.maxToolCallsRemaining === null || reservation.maxToolCalls + (definition.childBudgetPolicy === 'start/v1' ? 1 : 0) <= budget.maxToolCallsRemaining),
    'child_budget_start_exceeds_admission');
    invariant(['tenantId', 'workspaceId', 'userId'].every(key => reservation.childScope[key as keyof typeof reservation.childScope] === snapshot.scope[key as keyof typeof snapshot.scope])
      && reservation.childRunId !== snapshot.runId
      && !reservations.some(item => item.childRunId === reservation.childRunId || item.parentOperationKey === reservation.parentOperationKey)
      && !childRunIds.includes(reservation.childRunId), 'child_budget_start_identity_conflict');
    reservations.push(copy(reservation)); childRunIds.push(reservation.childRunId);
  }
  if (!settlement) {
    invariant(!reservations.some(item => result.childRunIds?.includes(item.childRunId)), 'child_budget_settlement_identity_required');
    for (const id of result.childRunIds ?? []) {
      invariant(typeof id === 'string' && id.trim().length > 0 && id !== snapshot.runId, 'invalid_child_run_id');
      if (!childRunIds.includes(id)) childRunIds.push(id);
    }
    return { childBudgetReservations: reservations, childRunIds, usage };
  }
  invariant(result.status !== 'approval_required' && result.status !== 'uncertain', 'invalid_child_budget_settlement_receipt');
  invariant(definition?.childBudgetPolicy === 'settle/v1' || reservation?.deliveryMode === 'foreground'
    && ['start/v1', 'delegate/v1'].includes(definition?.childBudgetPolicy ?? ''), 'child_budget_settlement_not_admitted');
  const reserved = reservations.find(item => item.childRunId === settlement.childRunId);
  invariant(typeof settlement.terminalSnapshotDigest === 'string' && /^[0-9a-f]{64}$/.test(settlement.terminalSnapshotDigest)
    && reserved && reserved.parentOperationKey === settlement.parentOperationKey
    && reserved.childRequestDigest === settlement.childRequestDigest
    && result.childRunIds?.filter(id => id === settlement.childRunId).length === 1
    && usage.modelCalls <= reserved.maxModelCalls && usage.toolCalls <= reserved.maxToolCalls,
  'child_budget_settlement_identity_or_limit_conflict');
  const sealed = digest({ settlement, usage, childRunIds: result.childRunIds,
    ...(result.resourceUsageReported === undefined ? {} : { resourceUsageReported: result.resourceUsageReported }) });
  invariant(reserved.settledUsageDigest === null || reserved.settledUsageDigest === sealed, 'child_budget_settlement_changed');
  const delta = reserved.settledUsageDigest === null ? usage : emptyUsage();
  reserved.settledUsageDigest = sealed;
  for (const id of result.childRunIds ?? []) {
    invariant(typeof id === 'string' && id.trim().length > 0 && id !== snapshot.runId, 'invalid_child_run_id');
    if (!childRunIds.includes(id)) childRunIds.push(id);
  }
  return { childBudgetReservations: reservations, childRunIds, usage: delta };
}
