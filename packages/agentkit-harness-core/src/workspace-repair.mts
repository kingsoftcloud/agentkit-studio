import type { CommitBatch, EffectIntent, PortContext, RunCommand, StoredRun, WorkspaceRepairRequest, WorkspaceRepairResult } from './contracts.mjs';
import { copy, invariant } from './values.mjs';
import { prepareEffect, transition } from './transitions.mjs';
import { reduceToolReceipt, toolReceiptSource, TOOL_RECEIPT_OBSERVATION_CONTRACT } from './tool-receipt.mjs';

export const WORKSPACE_REPAIR_CONTRACT = 'agentkit.workspace-compensation/v1' as const;
export function prepareWorkspaceRepair(record: StoredRun, command: RunCommand): CommitBatch {
  const { snapshot } = record;
  if (snapshot.phase !== 'awaiting_reconciliation' || snapshot.pendingIntent !== null
    || command.payload.originalOperationKey !== snapshot.toolReconciliation?.operationKey
    || Object.keys(command.payload).some(key => key !== 'originalOperationKey'))
    return transition(snapshot, {}, [{ kind: 'command.applied', payload: { commandId: command.commandId,
      kind: command.kind, reason: 'workspace_repair_not_available' } }], { commandId: command.commandId, requireNoPendingCommands: false });
  const original = toolReceiptSource(record, String(command.payload.originalOperationKey));
  if (original.definition.workspaceRepairPolicy !== 'preimage-compensation/v1')
    return transition(snapshot, {}, [{ kind: 'command.applied', payload: { commandId: command.commandId,
      kind: command.kind, reason: 'workspace_repair_not_admitted' } }], { commandId: command.commandId, requireNoPendingCommands: false });
  const batch = prepareEffect(snapshot, 'workspace_repair', 'reconciling_tool', {
    contract: WORKSPACE_REPAIR_CONTRACT, originalOperationKey: original.intent.operationKey,
    originalClaimedFence: original.intent.claimedFence!, callId: original.call.callId,
  });
  return transition(snapshot, { phase: batch.snapshot.phase, pendingIntent: batch.snapshot.pendingIntent }, [
    { kind: 'effect.prepared', payload: { operationKey: batch.snapshot.pendingIntent!, kind: 'workspace_repair' } },
    { kind: 'command.applied', payload: { commandId: command.commandId, kind: command.kind, reason: 'compensating_original_workspace_effect' } },
  ], { intents: batch.intents, commandId: command.commandId, requireNoPendingCommands: false });
}
export function workspaceRepairRequest(context: PortContext, record: StoredRun, intent: EffectIntent): WorkspaceRepairRequest {
  const original = toolReceiptSource(record, String(intent.payload.originalOperationKey));
  invariant(intent.kind === 'workspace_repair' && intent.payload.contract === WORKSPACE_REPAIR_CONTRACT
    && intent.payload.callId === original.call.callId && intent.payload.originalClaimedFence === original.intent.claimedFence
    && original.definition.workspaceRepairPolicy === 'preimage-compensation/v1', 'workspace_repair_binding_invalid');
  return { ...context, contract: WORKSPACE_REPAIR_CONTRACT, originalOperationKey: original.intent.operationKey,
    originalClaimedFence: original.intent.claimedFence!, call: copy(original.call), definition: copy(original.definition) };
}
export function reduceWorkspaceRepair(record: StoredRun, intent: EffectIntent, result: WorkspaceRepairResult, digest: (value: unknown) => string) {
  const content = result?.result?.content;
  invariant(result?.contract === WORKSPACE_REPAIR_CONTRACT && (result.result === null
    || result.result?.status === 'error' && content && typeof content === 'object' && !Array.isArray(content)
      && content.error_type === 'workspace_operation_compensated' && content.compensated === true), 'workspace_repair_result_invalid');
  return reduceToolReceipt(record, intent, { ...result, contract: TOOL_RECEIPT_OBSERVATION_CONTRACT }, digest);
}
