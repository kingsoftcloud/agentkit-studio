import type { CommitBatch, RunConfiguration, RunSnapshot, ToolCall, ToolDefinition, ToolResult } from './contracts.mjs';
import { canonical, copy } from './values.mjs';
import { transition } from './transitions.mjs';

type Digest = (value: unknown) => string;
export const toolErrorRecoveryEnabled = (config: RunConfiguration): boolean =>
  config.toolErrorRecoveryPolicy != null || config.toolErrorRecoveryModelCalls != null;
export const toolErrorStreakExhausted = (snapshot: RunSnapshot): boolean => !!snapshot.toolErrorStreak
  && snapshot.toolErrorStreak.count >= 6 && snapshot.toolErrorStreak.goalRevision === snapshot.goalRevision
  && snapshot.toolErrorStreak.workspaceRevision === snapshot.workspaceRevision;

/** Host metadata from a locked observation tool, never a field in tool prose. */
function observationDigest(result: ToolResult, definition: ToolDefinition | undefined): string | null {
  const value = result.metadata?.progressObservationDigest;
  return definition && (definition.readOnly || definition.progressObservation || definition.observationRole === 'browser')
    && typeof value === 'string' && /^(?:sha256:)?[a-f0-9]{64}$/.test(value) ? value : null;
}

export function advanceToolErrorStreak(snapshot: RunSnapshot, call: ToolCall, result: ToolResult,
  definition: ToolDefinition | undefined, config: RunConfiguration, digest: Digest): RunSnapshot['toolErrorStreak'] {
  if (result.status !== 'error') return snapshot.toolErrorStreak;
  const query = definition?.readOnly && definition.observationRole === 'none';
  const semantic = definition?.observationRole === 'browser' ? observationDigest(result, definition) : null;
  const signature = digest(semantic ? [call.name, result.status, semantic] : [call.name, result.status, result.content,
    ...(toolErrorRecoveryEnabled(config) ? [[...(result.context?.presentation?.content ?? []), ...(result.context?.media ?? [])]] : []),
    ...(query ? [call.arguments] : [])]);
  const prior = snapshot.toolErrorStreak;
  const same = prior?.signature === signature && prior.goalRevision === snapshot.goalRevision && prior.workspaceRevision === snapshot.workspaceRevision;
  return { signature, count: same ? prior.count + Number(prior.modelCall !== snapshot.usage.modelCalls) : 1,
    modelCall: snapshot.usage.modelCalls, goalRevision: snapshot.goalRevision, workspaceRevision: snapshot.workspaceRevision,
    ...(toolErrorRecoveryEnabled(config) ? { action: { name: call.name, argumentsDigest: query ? digest(call.arguments) : null } } : {}) };
}

/** Bounded novelty only. It neither establishes repair nor accepts the task. */
export function advanceObservedProgress(snapshot: RunSnapshot, result: ToolResult, definition: ToolDefinition | undefined,
  digest: Digest): Pick<RunSnapshot, 'observedProgressRevision' | 'observedProgressFingerprints'> {
  const fingerprints = snapshot.observedProgressFingerprints ?? [], revision = snapshot.observedProgressRevision ?? 0;
  const blocks = [...(result.context?.presentation?.content ?? []), ...(result.context?.media ?? [])];
  if (!definition || !(definition.readOnly || definition.progressObservation)
    || !snapshot.pendingIntent || result.status !== 'ok' || result.workspaceChangedPaths?.length
    || [null, ''].includes(result.content as null | string) && !blocks.length
    || ['{}', '[]'].includes(canonical(result.content)) && !blocks.length)
    return { observedProgressRevision: revision, observedProgressFingerprints: fingerprints };
  const fingerprint = observationDigest(result, definition) ?? digest([result.content, blocks]);
  if (fingerprints.includes(fingerprint) || fingerprints.length >= 2048)
    return { observedProgressRevision: revision, observedProgressFingerprints: fingerprints };
  return { observedProgressRevision: revision + 1, observedProgressFingerprints: [...fingerprints, fingerprint] };
}

/** Checked before every task OR compaction inference, including empty retries. */
export function toolErrorRecoveryBoundary(snapshot: RunSnapshot, config: RunConfiguration, modelCallsRemaining: number): CommitBatch | null {
  if (!toolErrorRecoveryEnabled(config)) return null;
  const recovery = snapshot.toolErrorRecovery, allowance = config.toolErrorRecoveryModelCalls ?? null;
  if (recovery) {
    if (snapshot.goalRevision !== recovery.goalRevision) return transition(snapshot, { toolErrorRecovery: null,
      toolErrorStreak: snapshot.toolErrorStreak ? { ...snapshot.toolErrorStreak, count: 0 } : null },
    [{ kind: 'tool.error_recovery_resolved', payload: { reason: 'user_goal_changed' } }]);
    if (allowance !== null && recovery.priorModelCallsSpent + snapshot.usage.modelCalls - recovery.startedModelCall >= allowance)
      return transition(snapshot, { phase: 'finalizing', outcome: 'blocked', reason: 'repeated_tool_error_recovery_exhausted', pendingIntent: null },
        [{ kind: 'tool.error_recovery_exhausted', payload: { reason: 'repeated_tool_error_recovery_exhausted' } }]);
    return null;
  }
  const streak = snapshot.toolErrorStreak;
  if (!toolErrorStreakExhausted(snapshot) || !streak?.action) return null;
  const remaining = Math.min(allowance ?? Infinity, modelCallsRemaining);
  return transition(snapshot, { phase: 'preparing_context', preparedContext: null, toolErrorRecovery: {
    action: copy(streak.action), failureFingerprint: streak.signature, startedModelCall: snapshot.usage.modelCalls,
    priorModelCallsSpent: 0, observationRevision: snapshot.observedProgressRevision ?? 0,
    goalRevision: snapshot.goalRevision, workspaceRevision: snapshot.workspaceRevision,
    diagnosticObservationSeen: false, diagnosticModelCall: null, trialConsumed: false, trialCallId: null, trialModelCall: null },
  messages: [...snapshot.messages, { role: 'user', kind: 'tool_error_recovery_observation', content: canonical({
    failed_tool: streak.action.name, repeated_errors: streak.count, remaining_model_calls: Number.isFinite(remaining) ? Math.max(0, remaining) : null,
    diagnosis_is_not_completion: true, instructions: 'Stop repeating the failed action. Inspect actual state or use another authorized method. '
      + 'A new successful host-declared observation permits one corrected trial on a later model decision; it does not prove repair or completion. '
      + 'The task remains within its original budget.' }) }] },
  [{ kind: 'tool.error_recovery_started', payload: { failedTool: streak.action.name, modelCallAllowance: allowance } }]);
}

export function guardedToolErrorAction(snapshot: RunSnapshot, call: ToolCall, digest: Digest): boolean {
  const recovery = snapshot.toolErrorRecovery;
  return !!recovery && recovery.action.name === call.name
    && (recovery.action.argumentsDigest === null || recovery.action.argumentsDigest === digest(call.arguments));
}

export function refuseUndiagnosedToolAction(snapshot: RunSnapshot, call: ToolCall, digest: Digest): CommitBatch | null {
  if (!guardedToolErrorAction(snapshot, call, digest)) return null;
  const recovery = snapshot.toolErrorRecovery!;
  if (recovery.diagnosticObservationSeen && !recovery.trialConsumed && recovery.trialCallId === null
    && (recovery.diagnosticModelCall === null || snapshot.usage.modelCalls > recovery.diagnosticModelCall)
    || recovery.trialCallId === call.callId && recovery.trialModelCall === snapshot.usage.modelCalls) return null;
  return transition(snapshot, { pendingTools: snapshot.pendingTools.slice(1), messages: [...snapshot.messages,
    { role: 'tool', callId: call.callId, name: call.name, content: canonical({ status: 'error', execution_status: 'not_dispatched',
      content: { reason: 'tool_error_diagnosis_required', executed: false } }) }] },
  [{ kind: 'tool.error_recovery_refused', payload: { callId: call.callId, name: call.name,
    reason: 'tool_error_diagnosis_required', executionStatus: 'not_dispatched' } }]);
}

/** Trial reservation and original execution intent share one durable commit. */
export function reserveDiagnosticTrial(snapshot: RunSnapshot, call: ToolCall, batch: CommitBatch, digest: Digest): CommitBatch {
  if (!guardedToolErrorAction(snapshot, call, digest)) return batch;
  return { ...batch, snapshot: { ...batch.snapshot, toolErrorRecovery: { ...snapshot.toolErrorRecovery!,
    trialConsumed: true, trialCallId: call.callId, trialModelCall: snapshot.usage.modelCalls } } };
}

export function advanceDiagnosticRecovery(before: RunSnapshot, updated: RunSnapshot, call: ToolCall, result: ToolResult,
  definition: ToolDefinition | undefined, digest: Digest): Partial<RunSnapshot> {
  const recovery = before.toolErrorRecovery;
  if (!recovery || result.status !== 'ok') return {};
  if (guardedToolErrorAction(before, call, digest) && recovery.trialCallId === call.callId
    && recovery.trialModelCall === before.usage.modelCalls) return { toolErrorRecovery: null,
    toolErrorStreak: updated.toolErrorStreak ? { ...updated.toolErrorStreak, count: 0 } : null };
  if (!recovery.diagnosticObservationSeen && definition?.name === call.name && (result.workspaceChangedPaths?.length
    || (definition.readOnly || definition.observationRole === 'browser')
      && (updated.observedProgressRevision ?? 0) > recovery.observationRevision)) return { toolErrorRecovery: { ...recovery,
        diagnosticObservationSeen: true, diagnosticModelCall: before.usage.modelCalls } };
  return {};
}
