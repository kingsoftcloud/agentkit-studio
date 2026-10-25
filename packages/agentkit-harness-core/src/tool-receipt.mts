import type { CommitBatch, EffectIntent, PortContext, RunCommand, RunConfiguration, RunSnapshot, StoredRun,
  ToolCall, ToolReceiptObservation, ToolReceiptRequest, ToolResult } from './contracts.mjs';
import { canonical, copy, invariant } from './values.mjs';
import { prepareEffect, transition } from './transitions.mjs';
import { reduceTools } from './machine.mjs';
import { stagePostHooks } from './hook-runtime.mjs';

export const TOOL_RECEIPT_OBSERVATION_CONTRACT = 'agentkit.tool-receipt-observation/v1' as const;
export function waitingToolReceipt(snapshot: RunSnapshot, config: RunConfiguration, intent: EffectIntent): Partial<RunSnapshot> | null {
  const calls = intent.payload.calls as unknown as ToolCall[] | undefined;
  if (intent.kind !== 'tool' || calls?.length !== 1
    || config.tools.find(tool => tool.name === calls[0]!.name)?.recoveryPolicy !== 'receipt-observation/v1') return null;
  return reduceTools(snapshot, [{ status: 'uncertain', content: { code: 'effect_outcome_unknown' } }], calls, intent, config);
}
export function toolReceiptSource(record: StoredRun, operationKey: string) {
  const { snapshot, configuration } = record;
  invariant(snapshot.toolReconciliation?.operationKey === operationKey, 'tool_receipt_identity_mismatch');
  const intent = record.intents.find(item => item.operationKey === operationKey);
  const calls = intent?.payload.calls as unknown as ToolCall[] | undefined;
  const receipt = record.receipts.find(item => item.operationKey === operationKey);
  invariant(intent?.kind === 'tool' && intent.status === 'running' && Number.isSafeInteger(intent.claimedFence)
    && receipt && (receipt.status === 'uncertain' || (receipt.result.results as unknown as ToolResult[] | undefined)?.[0]?.status === 'uncertain')
    && calls?.length === 1 && snapshot.toolReconciliation.callId === calls[0]!.callId
    && canonical(snapshot.pendingTools.slice(0, 1)) === canonical(calls), 'tool_receipt_source_invalid');
  const definition = configuration.tools.find(tool => tool.name === calls[0]!.name);
  invariant(definition?.recoveryPolicy === 'receipt-observation/v1', 'tool_receipt_policy_missing');
  return { intent, call: calls[0]!, definition };
}
export function prepareToolReceipt(record: StoredRun, command: RunCommand): CommitBatch {
  const { snapshot } = record;
  if (snapshot.phase !== 'awaiting_reconciliation' || snapshot.pendingIntent !== null
    || command.payload.originalOperationKey !== snapshot.toolReconciliation?.operationKey
    || Object.keys(command.payload).some(key => key !== 'originalOperationKey')) {
    return transition(snapshot, {}, [{ kind: 'command.applied', payload: { commandId: command.commandId,
      kind: command.kind, reason: 'tool_receipt_not_available' } }], { commandId: command.commandId, requireNoPendingCommands: false });
  }
  const original = toolReceiptSource(record, String(command.payload.originalOperationKey));
  const batch = prepareEffect(snapshot, 'tool_receipt', 'reconciling_tool', {
    contract: TOOL_RECEIPT_OBSERVATION_CONTRACT, originalOperationKey: original.intent.operationKey,
    callId: original.call.callId, originalClaimedFence: original.intent.claimedFence!,
  });
  return transition(snapshot, { phase: batch.snapshot.phase, pendingIntent: batch.snapshot.pendingIntent }, [
    { kind: 'effect.prepared', payload: { operationKey: batch.snapshot.pendingIntent!, kind: 'tool_receipt' } },
    { kind: 'command.applied', payload: { commandId: command.commandId, kind: command.kind, reason: 'observing_original_receipt' } },
  ], { intents: batch.intents, commandId: command.commandId, requireNoPendingCommands: false });
}
export function toolReceiptRequest(context: PortContext, record: StoredRun, intent: EffectIntent): ToolReceiptRequest {
  invariant(intent.kind === 'tool_receipt' && intent.payload.contract === TOOL_RECEIPT_OBSERVATION_CONTRACT,
    'tool_receipt_request_invalid');
  const original = toolReceiptSource(record, String(intent.payload.originalOperationKey));
  invariant(intent.payload.callId === original.call.callId && intent.payload.originalClaimedFence === original.intent.claimedFence,
    'tool_receipt_identity_mismatch');
  return { ...context, contract: TOOL_RECEIPT_OBSERVATION_CONTRACT, originalOperationKey: original.intent.operationKey,
    originalClaimedFence: original.intent.claimedFence!, call: copy(original.call), definition: copy(original.definition) };
}
export function reduceToolReceipt(record: StoredRun, intent: EffectIntent, observation: ToolReceiptObservation,
  digest: (value: unknown) => string): Partial<RunSnapshot> {
  const { snapshot, configuration } = record, original = toolReceiptSource(record, String(intent.payload.originalOperationKey));
  invariant(observation?.contract === TOOL_RECEIPT_OBSERVATION_CONTRACT
    && observation.originalOperationKey === original.intent.operationKey && observation.callId === original.call.callId,
  'tool_receipt_identity_mismatch');
  if (observation.result === null) return { pendingIntent: null, phase: 'awaiting_reconciliation' };
  const result = copy(observation.result);
  invariant(result && ['ok', 'error'].includes(result.status)
    && Object.keys(result).every(key => ['status', 'content', 'context', 'additionalContexts', 'workspaceChangedPaths', 'artifactRefs',
      'resourceUsage', 'resourceUsageReported', 'metadata',
      ...(configuration.artifactPolicy === 'runtime-artifacts/v1' ? ['artifactObservationDigest', 'archiveContext'] : [])].includes(key))
    && new TextEncoder().encode(configuration.artifactPolicy === 'runtime-artifacts/v1'
      ? canonical({ content: result.context?.content ?? canonical(result.content), media: result.context?.media ?? [],
        additionalContexts: result.additionalContexts ?? [] }) : canonical(result)).byteLength
      <= configuration.limits.maxToolResultBytes, 'tool_receipt_result_invalid');
  // The original attempt was charged once while entering the wait. The new
  // receipt query is an observation, never another tool execution or retry.
  const before = { ...snapshot, phase: 'executing_tools' as const, reason: null, outcome: null,
    usage: { ...snapshot.usage, toolCalls: snapshot.usage.toolCalls - 1 } };
  invariant(before.usage.toolCalls >= 0, 'tool_receipt_usage_invalid');
  const changes = reduceTools(before, [result], [original.call], original.intent, configuration, digest);
  return stagePostHooks(snapshot, { phase: 'executing_tools', reason: null, outcome: null, ...changes,
    toolReconciliation: null, preparedContext: null }, configuration, [original.call], [result]);
}
