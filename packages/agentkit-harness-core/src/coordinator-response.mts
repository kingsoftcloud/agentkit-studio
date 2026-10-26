import type { CoordinatorResponse } from './child-contract.mjs';
import type { ObjectValue, RunConfiguration, RunSnapshot, ToolCall, ToolDefinition, ToolResult } from './contracts.mjs';
import { canonical, copy, invariant } from './values.mjs';
import { toolInputRejection } from './tool-input.mjs';

export const CHILD_TASK_POLICY = 'session-controls/v1';
export const COORDINATOR_RESPONSE_POLICY = 'owned-parent-response/v1';
export const RESPOND_TO_COORDINATOR = 'RespondToCoordinator';

/** Modified Apache-2.0 code; attribution and license: THIRD_PARTY_NOTICES.md.
 * The acknowledgement and immutable queue fact share the tool receipt commit. */
export function coordinatorResponseDefinition(deferred = false): ToolDefinition {
  return { name: RESPOND_TO_COORDINATOR,
    description: 'Send a concise response or progress update to the coordinator that owns this subagent. Answer coordinator messages with this tool before or alongside the next work call. Continue the current task unless the coordinator explicitly changed or ended it. This does not replace the final task result.',
    readOnly: false, concurrentSafe: false, permissions: [], timeoutMs: 10000,
    contextRole: 'task_planning', observationRole: 'none', progressObservation: false, contextRetention: 'normal',
    ...(deferred ? { discovery: { deferred: true, searchHint: 'reply respond report progress to parent coordinator' } } : {}),
    parameters: { type: 'object', additionalProperties: false, required: ['summary', 'message'], properties: {
      summary: { type: 'string', minLength: 1, maxLength: 200 },
      message: { type: 'string', minLength: 1, maxLength: 20000 } } } };
}

export function isCoordinatorResponse(config: RunConfiguration, call: Pick<ToolCall, 'name'>): boolean {
  return config.coordinatorResponsePolicy === COORDINATOR_RESPONSE_POLICY && call.name === RESPOND_TO_COORDINATOR;
}

export function validateCoordinatorConfiguration(config: RunConfiguration): void {
  invariant(config.childTaskPolicy === undefined || config.childTaskPolicy === CHILD_TASK_POLICY
    && config.childLifecyclePolicy === 'owned-background/v2', 'invalid_child_task_policy');
  invariant(config.coordinatorResponsePolicy === undefined || config.coordinatorResponsePolicy === COORDINATOR_RESPONSE_POLICY,
    'invalid_coordinator_response_policy');
  if (config.coordinatorResponsePolicy) invariant(config.tools.some(tool =>
    canonical(tool) === canonical(coordinatorResponseDefinition(!!config.toolDiscoveryPolicy))), 'coordinator_response_tool_binding_invalid');
}

export function executeCoordinatorResponse(snapshot: RunSnapshot, config: RunConfiguration, call: ToolCall,
  digest: (value: unknown) => string): ToolResult {
  invariant(isCoordinatorResponse(config, call) && config.childOwnerBinding, 'coordinator_response_parent_unavailable');
  const rejection = toolInputRejection(config.tools.find(tool => tool.name === call.name)!, call);
  if (rejection) return { status: 'error', content: rejection };
  // Reference Zod limits count UTF-16 code units, unlike JSON Schema maxLength.
  if (String(call.arguments.summary).length > 200 || String(call.arguments.message).length > 20000)
    return { status: 'error', content: { code: 'invalid_arguments', executed: false, message: 'Coordinator response exceeds its UTF-16 length limit.' } };
  const responseId = `response_${digest({ childRunId: snapshot.runId, childToolCallId: call.callId })}`;
  return { status: 'ok', content: { status: 'success', responseId, message: 'Response was queued for the coordinator.' },
    context: { content: `Response ${responseId} was queued for the coordinator. Continue the current task unless the coordinator explicitly changed or ended it.` } };
}

export function coordinatorResponseFacts(snapshot: RunSnapshot, config: RunConfiguration, calls: ToolCall[], results: ToolResult[],
  digest: (value: unknown) => string): { kind: string; payload: ObjectValue }[] {
  return calls.flatMap((call, index) => {
    if (!isCoordinatorResponse(config, call) || results[index]?.status !== 'ok') return [];
    const expected = executeCoordinatorResponse(snapshot, config, call, digest);
    invariant(canonical(results[index]!.content) === canonical(expected.content), 'invalid_coordinator_response_receipt');
    return [{ kind: 'coordinator.response_queued', payload: { childToolCallId: call.callId,
      responseId: (expected.content as ObjectValue).responseId!, summary: call.arguments.summary!, message: call.arguments.message! } }];
  });
}

/** Only owner-verified child facts can enter this channel. They never become user guidance. */
export function reduceCoordinatorResponses(snapshot: RunSnapshot, config: RunConfiguration, responses: CoordinatorResponse[] | undefined,
  allowedIds: string[], digest: (value: unknown) => string): Partial<RunSnapshot> {
  if (responses === undefined) return {};
  invariant(config.childTaskPolicy === CHILD_TASK_POLICY && Array.isArray(responses), 'coordinator_responses_unavailable');
  const cursors = copy(snapshot.childResponseCursors ?? {}), seen = new Set<string>();
  const notices: RunSnapshot['messages'] = [];
  for (const response of responses) {
    invariant(response && allowedIds.includes(response.childRunId) && Number.isSafeInteger(response.sequence) && response.sequence > 0
      && typeof response.childToolCallId === 'string' && response.childToolCallId.trim()
      && response.responseId === `response_${digest({ childRunId: response.childRunId, childToolCallId: response.childToolCallId })}`
      && typeof response.summary === 'string' && response.summary.length > 0 && response.summary.length <= 200
      && typeof response.message === 'string' && response.message.length > 0 && response.message.length <= 20000
      && !seen.has(response.responseId), 'invalid_coordinator_response');
    seen.add(response.responseId);
    if (response.sequence <= (snapshot.childResponseCursors?.[response.childRunId] ?? 0)) continue;
    invariant(response.sequence > (cursors[response.childRunId] ?? 0), 'coordinator_response_order_conflict');
    cursors[response.childRunId] = response.sequence;
    notices.push({ role: 'user', kind: 'child_response', content: canonical({ source: 'subagent_message', trust: 'data',
      parentAcceptance: 'not_evaluated', ...copy(response) }) });
  }
  if (!notices.length) return {};
  return { childResponseCursors: cursors, preparedContext: null,
    // Reuse the existing post-batch observation queue. These have no guidance
    // inputId/debt; never insert user data between an assistant call and results.
    ...(snapshot.pendingTools.length ? { queuedGuidance: [...snapshot.queuedGuidance, ...notices] }
      : { messages: [...snapshot.messages, ...notices] }),
    ...(snapshot.phase === 'verifying' ? { phase: 'preparing_context', candidate: null, verification: null,
      finalText: '', outcome: null, reason: null } : {}) };
}
