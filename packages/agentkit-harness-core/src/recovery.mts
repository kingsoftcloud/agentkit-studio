import type { CommitBatch, EffectIntent, RunConfiguration, RunSnapshot, ToolCall } from './contracts.mjs';
import { settle } from './machine.mjs';
import { waitingToolReceipt } from './tool-receipt.mjs';
import { unknownToolResourceUsageFacts } from './tool-resource-usage.mjs';

function replayPolicy(intent: EffectIntent, configuration: RunConfiguration): string | null {
  if (intent.kind === 'workspace') return 'workspace-observation/v1';
  if (intent.kind === 'model' && configuration.modelRecoveryPolicy === 'pure-inference/v1') return 'pure-inference/v1';
  if (intent.kind === 'tool') {
    const calls = intent.payload.calls as unknown as ToolCall[];
    if (Array.isArray(calls) && calls.length && calls.every(call => {
      const tool = configuration.tools.find(tool => tool.name === call.name);
      return tool?.recoveryPolicy === 'safe-read/v1' && tool.readOnly && tool.observationRole === 'none'
        && !tool.delegatedReadOnly && !tool.childBudgetPolicy && !tool.backgroundCommandPolicy;
    })) return 'safe-read/v1';
  }
  return null;
}

/** Retire a lost claim before preparing a new operation; never reclaim the old key. */
export function recoverClaimed(snapshot: RunSnapshot, configuration: RunConfiguration, intent: EffectIntent, now: number): CommitBatch {
  const waiting = waitingToolReceipt(snapshot, configuration, intent);
  if (waiting) return settle(snapshot, intent, { operationKey: intent.operationKey, status: 'uncertain',
    result: { code: 'effect_outcome_unknown', recoveryPolicy: 'receipt-observation/v1' } }, waiting,
  intent.claimedAtMs === undefined ? 0 : Math.max(0, now - intent.claimedAtMs),
  [{ kind: 'effect.recovery_required', payload: { operationKey: intent.operationKey, kind: intent.kind,
    policy: 'receipt-observation/v1', reason: 'effect_outcome_unknown' } }]);
  if (intent.kind === 'tool_receipt' || intent.kind === 'workspace_repair') return settle(snapshot, intent, { operationKey: intent.operationKey,
    status: 'uncertain', result: { code: 'receipt_observation_lost' } },
  { pendingIntent: null, phase: 'awaiting_reconciliation' },
  intent.claimedAtMs === undefined ? 0 : Math.max(0, now - intent.claimedAtMs),
  [{ kind: intent.kind === 'workspace_repair' ? 'workspace.repair_unavailable' : 'tool.receipt_unavailable',
    payload: { originalOperationKey: intent.payload.originalOperationKey! } }]);
  const policy = replayPolicy(intent, configuration);
  const elapsed = intent.claimedAtMs === undefined ? 0 : Math.max(0, now - intent.claimedAtMs);
  const exhausted = policy !== null && snapshot.recoveryRetriesUsed >= configuration.limits.maxRecoveryRetries;
  const retry = policy !== null && !exhausted;
  const uncertainModelCalls = Number(snapshot.diagnostics.uncertainModelCalls ?? 0) + Number(intent.kind === 'model');
  const changes: Partial<RunSnapshot> = {
    pendingIntent: null,
    phase: retry ? intent.kind === 'model' ? intent.payload.purpose === 'compaction' ? 'compacting' : 'preparing_context' : snapshot.phase : 'finalizing',
    outcome: retry ? null : 'unverified', reason: retry ? null : exhausted ? 'recovery_retry_exhausted' : 'effect_outcome_unknown',
    recoveryRetriesUsed: snapshot.recoveryRetriesUsed + Number(retry),
    // A read whose result was lost still spent an attempt. Inference was charged before dispatch.
    usage: { ...snapshot.usage, toolCalls: snapshot.usage.toolCalls + (intent.kind === 'tool'
      ? (intent.payload.calls as unknown as ToolCall[]).length : 0) },
    diagnostics: { ...snapshot.diagnostics, ...(uncertainModelCalls ? { uncertainModelCalls, providerUsageIncomplete: true } : {}),
      ...(intent.kind === 'tool' ? { descendantUsageIncomplete: true } : {}) },
  };
  return settle(snapshot, intent, { operationKey: intent.operationKey, status: 'uncertain',
    result: { code: 'effect_outcome_unknown', recoveryPolicy: policy, retryScheduled: retry } }, changes, elapsed,
  [{ kind: retry ? 'effect.recovery_scheduled' : 'effect.recovery_required', payload: {
    operationKey: intent.operationKey, kind: intent.kind, policy, retriesUsed: changes.recoveryRetriesUsed!,
    reason: changes.reason ?? 'safe_replay_admitted',
  } }, ...(intent.kind === 'tool' ? unknownToolResourceUsageFacts(intent.operationKey, intent.payload.calls as unknown as ToolCall[]) : [])]);
}
