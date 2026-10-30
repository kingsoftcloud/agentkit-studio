import type { HookDefinition, HookEvent, HookFailure, HookInvocation, HookInvocationResult, HookOutput, ObjectValue, RunIdentity } from './contracts.mjs';
import { canonical, copy, invariant, scopeKey } from './values.mjs';

const events: HookEvent[] = ['PreToolUse', 'PostToolUse', 'Stop', 'PreCompact'];
const failures: HookFailure[] = ['producer_failed', 'producer_invalid', 'input_budget_exceeded', 'output_budget_exceeded',
  'producer_timeout', 'binding_unavailable', 'policy_denied', 'policy_error'];
export const hookBytes = (value: unknown): number => new TextEncoder().encode(canonical(value)).byteLength;
/** Host hashes this declaration into each binding; it is not a callback-controlled option. */
export function hookExecutionPolicy(cleanupTimeoutMs: number): ObjectValue {
  invariant(Number.isFinite(cleanupTimeoutMs) && cleanupTimeoutMs > 0, 'invalid_hook_cleanup_timeout');
  return { schemaVersion: 'agentkit.native-hook-callback-lifetime/v1', cleanupTimeoutMs };
}
export function validateHookDefinition(input: HookDefinition): HookDefinition {
  const definition = copy(input);
  invariant(Object.keys(definition).every(key => ['hookId', 'sourceRef', 'bindingDigest', 'executionPolicyDigest', 'readOnly',
    'events', 'toolNames', 'timeoutMs', 'maxInputBytes', 'maxOutputBytes', 'failureMode', 'compactionSourceProjection'].includes(key))
    && typeof definition.hookId === 'string' && /^[a-z0-9._-]{1,128}$/.test(definition.hookId)
    && typeof definition.sourceRef === 'string' && definition.sourceRef.trim().length > 0 && definition.sourceRef.length <= 512
    && /^sha256:[a-f0-9]{64}$/.test(definition.bindingDigest) && /^sha256:[a-f0-9]{64}$/.test(definition.executionPolicyDigest)
    && typeof definition.readOnly === 'boolean' && Array.isArray(definition.events) && definition.events.length > 0
    && new Set(definition.events).size === definition.events.length && definition.events.every(event => events.includes(event))
    && Number.isFinite(definition.timeoutMs) && definition.timeoutMs > 0
    && Number.isSafeInteger(definition.maxInputBytes) && definition.maxInputBytes > 0
    && Number.isSafeInteger(definition.maxOutputBytes) && definition.maxOutputBytes > 0
    && ['warn', 'block'].includes(definition.failureMode), 'invalid_hook_definition');
  invariant(definition.toolNames === undefined || Array.isArray(definition.toolNames) && definition.toolNames.length > 0
    && new Set(definition.toolNames).size === definition.toolNames.length
    && definition.toolNames.every(name => typeof name === 'string' && name.trim())
    && definition.events.some(event => event === 'PreToolUse' || event === 'PostToolUse'), 'invalid_hook_tool_filter');
  invariant(definition.compactionSourceProjection === undefined || definition.compactionSourceProjection === 'canonical_user'
    && definition.events.includes('PreCompact'), 'invalid_hook_compaction_projection');
  return definition;
}
export function hookMatches(definition: HookDefinition, event: HookEvent, toolName?: string): boolean {
  return definition.events.includes(event) && (!['PreToolUse', 'PostToolUse'].includes(event)
    || definition.toolNames === undefined || toolName !== undefined && definition.toolNames.includes(toolName));
}
export function hookIdentity(request: RunIdentity): RunIdentity {
  const { scope, runId, sessionId, turnId, buildId, parentRunId, taskChainId } = request;
  return copy({ scope, runId, sessionId, turnId, buildId, parentRunId, taskChainId });
}
export function validateHookInvocation(input: HookInvocation, digest: (value: unknown) => string): HookInvocation {
  const request = copy(input), definition = validateHookDefinition(request.definition), subject = request.input;
  scopeKey(request.scope);
  invariant([request.runId, request.sessionId, request.turnId, request.buildId, request.taskChainId].every(value => typeof value === 'string' && value.trim())
    && (request.parentRunId === null || typeof request.parentRunId === 'string' && request.parentRunId.trim()), 'invalid_hook_identity');
  invariant(request.schemaVersion === 'agentkit.native-hook/v1' && typeof request.operationKey === 'string' && request.operationKey.trim()
    && Number.isSafeInteger(request.goalRevision) && request.goalRevision >= 0
    && subject && Object.keys(subject).length === 7 && Object.keys(subject).every(key => ['goal', 'toolCallCount',
      'stopContinuationCount', 'call', 'toolResult', 'candidate', 'compaction'].includes(key))
    && typeof subject.goal === 'string' && subject.goal.trim()
    && Number.isSafeInteger(subject.toolCallCount) && subject.toolCallCount >= 0
    && Number.isSafeInteger(subject.stopContinuationCount) && subject.stopContinuationCount >= 0
    && hookMatches(definition, request.event, subject.call?.name)
    && request.inputDigest === digest({ definition, input: subject }), 'invalid_hook_invocation');
  invariant(request.event === 'PreToolUse' ? subject.call !== null && subject.toolResult === null && subject.candidate === null && subject.compaction === null
    : request.event === 'PostToolUse' ? subject.call !== null && subject.toolResult !== null && subject.candidate === null && subject.compaction === null
      : request.event === 'Stop' ? subject.call === null && subject.toolResult === null && subject.candidate !== null && subject.compaction === null
        : subject.call === null && subject.toolResult === null && subject.candidate === null && subject.compaction !== null, 'invalid_hook_subject');
  return request;
}
export function hookResult(request: HookInvocation, status: HookInvocationResult['status'],
  output: HookOutput | null = null, reason: HookFailure | null = null): HookInvocationResult {
  return copy({ schemaVersion: 'agentkit.native-hook-result/v1', identity: hookIdentity(request), operationKey: request.operationKey,
    goalRevision: request.goalRevision, event: request.event, hookId: request.definition.hookId, sourceRef: request.definition.sourceRef,
    bindingDigest: request.definition.bindingDigest, executionPolicyDigest: request.definition.executionPolicyDigest,
    inputDigest: request.inputDigest, status, output, reason });
}
export function validateHookOutput(input: HookOutput, event: HookEvent): HookOutput {
  const output = copy(input);
  invariant(output && Object.keys(output).every(key => ['action', 'additionalContext', 'updatedArguments'].includes(key))
    && ['continue', 'deny', 'repair'].includes(output.action) && Array.isArray(output.additionalContext)
    && output.additionalContext.every(text => typeof text === 'string')
    && (output.updatedArguments === null || typeof output.updatedArguments === 'object' && !Array.isArray(output.updatedArguments)), 'invalid_hook_output');
  invariant(output.action !== 'repair' || event === 'Stop' && output.additionalContext.some(text => text.trim()), 'invalid_hook_repair');
  invariant(output.updatedArguments === null || event === 'PreToolUse' && output.action === 'continue', 'invalid_hook_arguments');
  return output;
}
export function validateHookResult(request: HookInvocation, input: HookInvocationResult): HookInvocationResult {
  const result = copy(input), expected = hookResult(request, result.status, result.output, result.reason);
  invariant(['ok', 'failed', 'uncertain'].includes(result.status) && canonical(result) === canonical(expected), 'hook_receipt_binding_mismatch');
  invariant(result.status === 'ok' ? result.output !== null && result.reason === null
    : result.output === null && result.reason !== null && failures.includes(result.reason), 'invalid_hook_result');
  if (hookBytes(request.input) > request.definition.maxInputBytes) invariant(result.status === 'failed'
    && result.reason === 'input_budget_exceeded', 'hook_input_budget_exceeded');
  if (result.status === 'ok') {
    validateHookOutput(result.output!, request.event);
    invariant(hookBytes(result.output) <= request.definition.maxOutputBytes, 'hook_output_budget_exceeded');
  }
  return result;
}
