import type { ChildControlDelivery, ChildControlTarget } from './child-contract.mjs';
import type { RunCommand, RunSnapshot, StoredRun } from './contracts.mjs';
import { terminal } from './contracts.mjs';
import { CHILD_OWNER_CONTRACT } from './child-contract.mjs';
import { canonical, copy, invariant } from './values.mjs';

export function childControlDelivery(parent: RunSnapshot, command: RunCommand, target: ChildControlTarget): ChildControlDelivery {
  const send = command.kind === 'message_child', input = command.payload;
  invariant(['message_child', 'cancel_child'].includes(command.kind)
    && typeof input.childRunId === 'string' && input.childRunId.trim() && input.childRunId.length <= 256
    && Object.keys(input).every(key => (send ? ['childRunId', 'text', 'expectedGoalRevision'] : ['childRunId']).includes(key))
    && (!send || typeof input.text === 'string' && input.text.trim() && input.text.length <= 32768
      && Number.isSafeInteger(input.expectedGoalRevision) && (input.expectedGoalRevision as number) >= 0), 'invalid_child_control');
  return { target: copy(target), command: {
    commandId: `child-control:${canonical([parent.scope, parent.runId, command.commandId])}`,
    kind: send ? 'guide' : 'cancel', payload: send ? { text: input.text!, expectedGoalRevision: input.expectedGoalRevision! } : {},
  } };
}

/** Runs under the Store's multi-record transaction, before either ledger changes. */
export function validateChildControlDelivery(parent: StoredRun, child: StoredRun, command: RunCommand, delivery: ChildControlDelivery): void {
  const target = delivery.target, binding = child.configuration.childOwnerBinding, p = parent.snapshot, c = child.snapshot;
  invariant(!terminal(p.phase) && p.phase !== 'finalizing' && !p.childTerminalPhase
    && parent.configuration.childLifecyclePolicy === 'owned-background/v2'
    && (command.kind !== 'message_child' || parent.configuration.childInputPolicy === 'owned-child-input/v1'), 'child_control_unavailable');
  invariant(c.runId === command.payload.childRunId && c.runId === target.runId && canonical(c.scope) === canonical(target.scope)
    && ['tenantId', 'workspaceId', 'userId'].every(key => c.scope[key as keyof typeof c.scope] === p.scope[key as keyof typeof p.scope])
    && c.configDigest === target.configurationDigest && binding?.contract === CHILD_OWNER_CONTRACT
    && canonical(binding.parent) === canonical(Object.fromEntries(['scope', 'runId', 'sessionId', 'turnId', 'buildId', 'parentRunId', 'taskChainId']
      .map(key => [key, p[key as keyof RunSnapshot]])))
    && binding.parentOperationKey === target.parentOperationKey && binding.parentToolCallId === target.parentToolCallId,
  'child_control_origin_changed');
  const reservation = p.childBudgetReservations.find(item => item.childRunId === c.runId);
  invariant(reservation && p.childRunIds.includes(c.runId) && reservation.settledUsageDigest === null
    && canonical(reservation.childScope) === canonical(c.scope) && reservation.configurationDigest === c.configDigest
    && reservation.parentOperationKey === target.parentOperationKey && reservation.parentToolCallId === target.parentToolCallId
    && reservation.childRequestDigest === binding.childRequestDigest && reservation.maxModelCalls === binding.maxModelCalls
    && reservation.maxToolCalls === binding.maxToolCalls && reservation.deliveryMode === binding.deliveryMode, 'child_control_origin_changed');
  const intent = parent.intents.find(item => item.operationKey === target.parentOperationKey);
  const call = (intent?.payload.calls as unknown as { callId: string; name: string; arguments: { role: string; task: string } }[] | undefined)?.[0];
  const original = parent.receipts.find(item => item.operationKey === target.parentOperationKey && item.status === 'committed')
    ?.result.results as unknown as { childBudgetReservation?: unknown }[] | undefined;
  invariant(intent?.kind === 'tool' && (intent.payload.calls as unknown[]).length === 1 && call?.callId === target.parentToolCallId
    && call.arguments.role === binding.role && call.arguments.task === child.configuration.contract.objective
    && ['start/v1', 'delegate/v1'].includes(parent.configuration.tools.find(tool => tool.name === call.name)?.childBudgetPolicy ?? '')
    && original?.[0]?.childBudgetReservation && canonical(original[0].childBudgetReservation) === canonical(reservation), 'child_control_origin_changed');
  invariant(canonical(delivery) === canonical(childControlDelivery(p, command, target)), 'child_control_delivery_changed');
  invariant(!terminal(c.phase) && !c.childTerminalPhase
    && !child.receipts.some(receipt => receipt.status === 'uncertain'
      && child.intents.find(intent => intent.operationKey === receipt.operationKey)?.kind !== 'model'
      && !(receipt.result.retryScheduled === true && ['safe-read/v1', 'workspace-observation/v1'].includes(String(receipt.result.recoveryPolicy)))),
  'child_control_result_unknown');
  const preempts = (record: StoredRun, kinds: string[]) => record.commands.some(row => !row.consumed && kinds.includes(row.command.kind));
  invariant(!preempts(parent, ['cancel', 'policy_revoked', 'steer']), 'parent_control_preempts_child_control');
  if (command.kind === 'message_child') {
    invariant(!preempts(child, ['cancel', 'policy_revoked', 'steer']), 'child_control_preempts_input');
    invariant(command.payload.expectedGoalRevision === c.goalRevision, 'stale_child_goal_revision');
  }
}
