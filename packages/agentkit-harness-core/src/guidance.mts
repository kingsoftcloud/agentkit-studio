import type { Message, ModelResult, RunCommand, RunConfiguration, RunSnapshot } from './contracts.mjs';
import { invariant } from './values.mjs';

/** Only a sealed batch boundary may drain inline guidance. Other commands stay visible. */
export function guidanceRunnable(snapshot: RunSnapshot, command: RunCommand, config: RunConfiguration): boolean {
  return command.kind !== 'guide' || config.guidancePolicy !== 'boundary-guide/v1'
    || snapshot.pendingIntent === null && (snapshot.phase === 'finalizing'
      || !snapshot.pendingTools.length && ['created', 'preparing_context', 'verifying'].includes(snapshot.phase)
        && !snapshot.pendingGuidanceIds?.length);
}

export function guidanceReason(snapshot: RunSnapshot, command: RunCommand, config: RunConfiguration): string {
  if (typeof command.payload.text !== 'string' || !command.payload.text.trim() || command.payload.text.length > 32768
    || !Number.isSafeInteger(command.payload.expectedGoalRevision) || Number(command.payload.expectedGoalRevision) < 0)
    return 'invalid_guidance';
  if (command.payload.expectedGoalRevision !== snapshot.goalRevision) return 'stale_goal_revision';
  if (snapshot.pendingGuidanceIds?.length) return 'guidance_previous_unconsumed';
  if (['effect_outcome_unknown', 'recovery_retry_exhausted', 'browser_session_unavailable'].includes(snapshot.reason ?? '')) return 'recovery_required';
  if (snapshot.pendingTools.length) return 'guidance_not_at_boundary';
  return guidanceRunnable(snapshot, command, config) ? 'applied' : 'guidance_not_at_boundary';
}

export function effectiveGuidanceResponse(result: ModelResult): boolean {
  return ['tool_calls', 'final_candidate', 'output_limit'].includes(result.kind)
    && (result.toolCalls.length > 0 || !!result.text.trim());
}

/** A pending requirement must survive even a Host context projection. */
export function assertGuidanceRetained(snapshot: RunSnapshot, messages: Message[]): void {
  for (const inputId of snapshot.pendingGuidanceIds ?? []) {
    const source = snapshot.messages.find(message => message.kind === 'guidance' && message.inputId === inputId && !message.history);
    invariant(source && messages.some(message => message.role === 'user' && message.kind === source.kind
      && message.inputId === inputId && message.inputGoalRevision === source.inputGoalRevision
      && message.content === source.content), 'context_guidance_missing');
  }
}
