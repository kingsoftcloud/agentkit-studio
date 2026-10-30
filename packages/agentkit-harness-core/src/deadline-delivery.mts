import type { CommitBatch, EffectIntent, Message, ObjectValue, RunConfiguration, RunSnapshot, ToolCall, ToolDefinition, ToolResult } from './contracts.mjs';
import { canonical, copy } from './values.mjs';
import { outstandingChildCalls } from './child-budget.mjs';
import { transition } from './transitions.mjs';
import { reviewPending } from './delivery-review.mjs';
import { webObservationDue, webVerificationOnly } from './task-policy.mjs';
import { parseNativeJson } from './model-json.mjs';

/** Retire only the original undispatched effect; no claim or port invocation. */
export function wallBudgetStop(snapshot: RunSnapshot, intent: EffectIntent): CommitBatch {
  return transition(snapshot, { phase: 'finalizing', pendingIntent: null, outcome: 'budget_exhausted', reason: 'wall_time_hard_limit' },
    [{ kind: 'budget.exhausted', payload: { reason: 'wall_time_hard_limit' } }],
    { receipts: [{ operationKey: intent.operationKey, status: 'not_dispatched', result: { reason: 'wall_time_hard_limit', executed: false } }] });
}
export function isWallBudgetStopBatch(snapshot: RunSnapshot, config: RunConfiguration, intent: EffectIntent, batch: CommitBatch): boolean {
  return config.limits.maxWallMs !== null && batch.snapshot.activeElapsedMs >= config.limits.maxWallMs
    && canonical(wallBudgetStop({ ...snapshot, activeElapsedMs: batch.snapshot.activeElapsedMs }, intent)) === canonical(batch);
}

const claimed = (s: RunSnapshot, kind: 'model' | 'tool') => s.usage[kind === 'model' ? 'modelCalls' : 'toolCalls']
  + s.descendantUsage[kind === 'model' ? 'modelCalls' : 'toolCalls'] + outstandingChildCalls(s, kind);
export function wallDeliveryOnly(snapshot: RunSnapshot, config: RunConfiguration): boolean {
  const quote = snapshot.executionBudgetObservation, reserve = config.limits.finalizationReserveWallMs;
  return reserve > 0 && config.limits.maxWallMs !== null && !!quote && quote.runId === snapshot.runId
    && quote.goalRevision === snapshot.goalRevision && quote.wallMsRemaining !== null && quote.wallMsRemaining <= reserve;
}
/** A committed preparation quote, never a deadline extension or tool grant. */
export function observeExecutionBudget(snapshot: RunSnapshot, config: RunConfiguration) {
  if (config.limits.finalizationReserveWallMs <= 0 || config.limits.maxWallMs === null) return null;
  const previous = snapshot.executionBudgetObservation, remaining = Math.max(0, config.limits.maxWallMs - snapshot.activeElapsedMs);
  const model = claimed(snapshot, 'model'), tool = claimed(snapshot, 'tool');
  const crossing = previous?.wallMsRemaining != null && previous.wallMsRemaining > config.limits.finalizationReserveWallMs
    && remaining <= config.limits.finalizationReserveWallMs;
  if (previous?.runId === snapshot.runId && previous.goalRevision === snapshot.goalRevision
    && previous.modelCallsClaimed === model && previous.toolCallsClaimed === tool && !crossing) return null;
  // Summary retries keep their sealed quote until the deadline window is crossed.
  if (snapshot.phase === 'compacting' && previous && !crossing) return null;
  const quote = { policy: 'prepared-execution-budget/v1' as const, runId: snapshot.runId,
    sourceRevision: snapshot.revision, goalRevision: snapshot.goalRevision, modelCallsClaimed: model, toolCallsClaimed: tool,
    wallMsRemaining: remaining };
  return transition(snapshot, { executionBudgetObservation: quote, preparedContext: null }, [
    { kind: 'budget.observed', payload: quote }]);
}
export function writtenDeliveryPaths(snapshot: RunSnapshot): string[] {
  return snapshot.deliveryArtifacts?.goalRevision === snapshot.goalRevision ? snapshot.deliveryArtifacts.paths : [];
}
export function rememberDeliveryWrite(snapshot: RunSnapshot, call: ToolCall, result: ToolResult, definition?: ToolDefinition) {
  const path = call.arguments.path;
  if (definition?.deliveryArtifactRole !== 'write' || !definition.deliveryWrite || definition.readOnly
    || result.status !== 'ok' || typeof path !== 'string' || !result.workspaceChangedPaths?.includes(path)) return {};
  // Only canonical, workspace-relative paths can become durable read authority.
  if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some(part => !part || ['.', '..'].includes(part))) return {};
  return { deliveryArtifacts: { goalRevision: snapshot.goalRevision, paths: [...new Set([...writtenDeliveryPaths(snapshot), path])].slice(0, 2048) } };
}
export function scopedDeliveryReader(tool: ToolDefinition, snapshot: RunSnapshot): ToolDefinition | null {
  const paths = writtenDeliveryPaths(snapshot);
  if (tool.deliveryArtifactRole !== 'read' || !tool.readOnly || tool.contextRole !== 'workspace_read' || !paths.length) return null;
  const parameters = copy(tool.parameters), properties = parameters.properties && typeof parameters.properties === 'object'
    && !Array.isArray(parameters.properties) ? parameters.properties : {};
  const path = properties.path && typeof properties.path === 'object' && !Array.isArray(properties.path) ? properties.path : {};
  parameters.properties = { ...properties, path: { ...path, enum: paths } };
  parameters.allOf = [...Array.isArray(parameters.allOf) ? parameters.allOf : [], { properties: { path: { enum: paths } }, required: ['path'] }];
  return { ...copy(tool), parameters, description: tool.description
    + ' In the deadline delivery window, inspect only these paths already successfully written by this Run for its current goal. '
    + 'This permits checking exact text before an edit; it grants no further exploration or acceptance.' };
}
export function deliveryReadOutsidePaths(snapshot: RunSnapshot, config: RunConfiguration, calls: ToolCall[]): boolean {
  if (!wallDeliveryOnly(snapshot, config)) return false;
  const readers = new Set(config.tools.filter(tool => tool.deliveryArtifactRole === 'read').map(tool => tool.name));
  return calls.some(call => readers.has(call.name) && !writtenDeliveryPaths(snapshot).includes(String(call.arguments.path)));
}
export function deliverySummaryAllowed(snapshot: RunSnapshot, config: RunConfiguration): boolean {
  const policy = config.limits.deliveryContextRecoveryPolicy, quote = snapshot.executionBudgetObservation;
  const modelRoom = config.limits.maxModelCalls === null ? Infinity : config.limits.maxModelCalls - claimed(snapshot, 'model');
  if (!policy || !wallDeliveryOnly(snapshot, config) || modelRoom <= config.limits.finalizationReserveModelCalls
    || !quote?.wallMsRemaining || snapshot.pendingTools.length || snapshot.pendingInteraction || reviewPending(snapshot)) return false;
  if (policy === 'delivery-window-summary/v2') return true;
  if (snapshot.lastWorkspaceMutationToolCall !== snapshot.usage.toolCalls || snapshot.messages.length < 2) return false;
  const parent = snapshot.messages.at(-2)!, receipt = snapshot.messages.at(-1)!, call = parent.toolCalls?.[0];
  if (parent.role !== 'assistant' || parent.toolCalls?.length !== 1 || receipt.role !== 'tool' || !call
    || receipt.callId !== call.callId || !config.tools.some(tool => tool.name === call.name && tool.deliveryWrite && !tool.readOnly)) return false;
  // Durable Host receipt markers are added by reduceTools, never accepted from tool JSON.
  const bound = snapshot.context.lastDeliveryWriteReceipt;
  return !!bound && typeof bound === 'object' && !Array.isArray(bound) && bound.runId === snapshot.runId
    && bound.goalRevision === snapshot.goalRevision && bound.toolCalls === snapshot.usage.toolCalls
    && bound.callId === call.callId && bound.receiptDigest === canonical(receipt);
}
function deliveryFeedbackMessages(snapshot: RunSnapshot, config: RunConfiguration, messages: Message[]): Message[] {
  const readers = config.tools.filter(tool => tool.deliveryArtifactRole === 'read' && tool.readOnly && tool.contextRole === 'workspace_read');
  const admitted = new Map(readers.filter(tool => scopedDeliveryReader(tool, snapshot)
    && (config.contract.allowedToolNames === null || config.contract.allowedToolNames.includes(tool.name))).map(tool => [tool.name, tool]));
  let calls = new Map<string, ToolCall>();
  return messages.map(message => {
    if (message.role === 'assistant') calls = new Map((message.toolCalls ?? [])
      .filter(call => readers.some(tool => tool.name === call.name) && typeof call.arguments.path === 'string').map(call => [call.callId, call]));
    const call = message.role === 'tool' && message.callId ? calls.get(message.callId) : null;
    if (!call) return message;
    try {
      const value = parseNativeJson(message.content);
      if (!value || typeof value !== 'object' || Array.isArray(value) || value.status !== 'ok') return message;
      const source = value.content, path = call.arguments.path;
      if (!source || typeof source !== 'object' || Array.isArray(source) || source.ok !== true
        || source.path !== path || typeof source.content !== 'string'
        || !['host artifact reference', 'ArtifactRead', 'ArtifactSearch'].some(term =>
          (String(source.suggested_action ?? '') + String(value.artifact_instruction ?? '')).includes(term))
        || !Number.isSafeInteger(source.start_line) || !Number.isSafeInteger(source.total_lines)
        || Number(source.total_lines) < 0 || typeof source.partial !== 'boolean') return message;
      const start = Number(source.start_line), end = source.end_line, total = Number(source.total_lines);
      let continuation: string;
      if (!admitted.has(call.name) || !writtenDeliveryPaths(snapshot).includes(String(path)))
        continuation = 'This historical path is outside current delivery read admission.';
      else if (source.partial_line === start && source.line_count === 0)
        continuation = 'Part of this line is omitted; no artifact reader is currently admitted. Do not guess its missing text.';
      else if (Number.isSafeInteger(end) && start >= 1 && start <= Number(end) && Number(end) < total) {
        const properties = admitted.get(call.name)!.parameters.properties;
        continuation = properties && typeof properties === 'object' && !Array.isArray(properties) && 'start_line' in properties
          ? `Continue with ${call.name} on this same admitted path at start_line=${Number(end) + 1}. This page does not attest earlier coverage or verification.`
          : 'This page omits later text; the admitted reader declares no line pagination. Do not guess missing text or call unavailable artifact readers.';
      } else if (Number.isSafeInteger(end) && end === total && (start >= 1 && start <= Number(end) || total === 0))
        continuation = 'This visible range reaches the file end; earlier ranges may remain unread. Review the available text before an exact edit.';
      else return message;
      source.suggested_action = continuation; delete value.artifact_instruction;
      return { ...message, content: canonical(value) };
    } catch { return message; }
  });
}
/** Detached, countable model view. Canonical receipts and private replay remain immutable. */
export function deliveryTaskMessages(snapshot: RunSnapshot, config: RunConfiguration, messages: Message[]): Message[] {
  if (!wallDeliveryOnly(snapshot, config) || reviewPending(snapshot) || webObservationDue(snapshot, config)
    || webVerificationOnly(snapshot, config)
    || config.limits.maxModelCalls !== null && config.limits.maxModelCalls - claimed(snapshot, 'model') <= config.limits.finalizationReserveModelCalls
    || config.limits.maxToolCalls !== null && claimed(snapshot, 'tool') >= config.limits.maxToolCalls) return messages;
  const view = config.wallDeliveryPolicy == null || config.wallDeliveryPolicy === 'deadline-delivery/v7'
    ? deliveryFeedbackMessages(snapshot, config, messages) : messages;
  return [...view, { role: 'system', kind: 'deadline_delivery_policy', content: canonical({
    policy: 'prepared-execution-budget/v1', authority: 'budget_observation_only', quote: snapshot.executionBudgetObservation,
    instruction: 'The existing deadline is in its delivery window. Use only admitted delivery tools and current-goal written paths. '
      + 'Complete the requested deliverable and report missing evidence honestly. No new permission, verification verdict or time is granted.',
  }) }];
}
