// Studio checks the versioned Hook callback headers, payloads and replies at its boundary.
import { canonical, copy, invariant, scopeKey } from './native-values.mjs';
/** @typedef {{hookId: string, sourceRef: string, bindingDigest: string, executionPolicyDigest: string,
 * readOnly: boolean, events: string[], toolNames?: string[], timeoutMs: number, maxInputBytes: number,
 * maxOutputBytes: number, failureMode: string, compactionSourceProjection?: string}} HookDefinition */
/** @typedef {{scope: unknown, runId: string, sessionId: string, turnId: string, buildId: string,
 * parentRunId: string | null, taskChainId: string}} HookIdentity */
/** @typedef {{goal: string, toolCallCount: number, stopContinuationCount: number, call: {name: string} | null,
 * toolResult: unknown, candidate: unknown, compaction: unknown}} HookInput */
/** @typedef {HookIdentity & {schemaVersion: string, operationKey: string, event: string, goalRevision: number,
 * inputDigest: string, definition: HookDefinition, input: HookInput}} HookInvocation */
/** @typedef {{action: string, additionalContext: string[], updatedArguments: Record<string, unknown> | null}} HookOutput */
const events = ['PreToolUse', 'PostToolUse', 'Stop', 'PreCompact'];
const failures = ['producer_failed', 'producer_invalid', 'input_budget_exceeded', 'output_budget_exceeded',
    'producer_timeout', 'binding_unavailable', 'policy_denied', 'policy_error'];
/** @param {unknown} value */
export const hookBytes = (value) => new TextEncoder().encode(canonical(value)).byteLength;
/** Host hashes this declaration into each binding. @param {number} cleanupTimeoutMs */
export function hookExecutionPolicy(cleanupTimeoutMs) {
    invariant(Number.isFinite(cleanupTimeoutMs) && cleanupTimeoutMs > 0, 'invalid_hook_cleanup_timeout');
    return { schemaVersion: 'agentkit.native-hook-callback-lifetime/v1', cleanupTimeoutMs };
}
/** @param {HookDefinition} input */
export function validateHookDefinition(input) {
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
/** @param {HookDefinition} definition @param {string} event @param {string} [toolName] */
function hookMatches(definition, event, toolName) {
    return definition.events.includes(event) && (!['PreToolUse', 'PostToolUse'].includes(event)
        || definition.toolNames === undefined || toolName !== undefined && definition.toolNames.includes(toolName));
}
/** @param {HookIdentity} request */
export function hookIdentity(request) {
    const { scope, runId, sessionId, turnId, buildId, parentRunId, taskChainId } = request;
    return copy({ scope, runId, sessionId, turnId, buildId, parentRunId, taskChainId });
}
/** @param {HookInvocation} input @param {(binding: {definition: HookDefinition, input: HookInput}) => string} digest */
export function validateHookInvocation(input, digest) {
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
/** @param {HookInvocation} request @param {string} status @param {HookOutput | null} [output] @param {string | null} [reason] */
export function hookResult(request, status, output = null, reason = null) {
    return copy({ schemaVersion: 'agentkit.native-hook-result/v1', identity: hookIdentity(request), operationKey: request.operationKey,
        goalRevision: request.goalRevision, event: request.event, hookId: request.definition.hookId, sourceRef: request.definition.sourceRef,
        bindingDigest: request.definition.bindingDigest, executionPolicyDigest: request.definition.executionPolicyDigest,
        inputDigest: request.inputDigest, status, output, reason });
}
/** @param {HookOutput} input @param {string} event */
function validateHookOutput(input, event) {
    const output = copy(input);
    invariant(output && Object.keys(output).every(key => ['action', 'additionalContext', 'updatedArguments'].includes(key))
        && ['continue', 'deny', 'repair'].includes(output.action) && Array.isArray(output.additionalContext)
        && output.additionalContext.every(text => typeof text === 'string')
        && (output.updatedArguments === null || typeof output.updatedArguments === 'object' && !Array.isArray(output.updatedArguments)), 'invalid_hook_output');
    invariant(output.action !== 'repair' || event === 'Stop' && output.additionalContext.some(text => text.trim()), 'invalid_hook_repair');
    invariant(output.updatedArguments === null || event === 'PreToolUse' && output.action === 'continue', 'invalid_hook_arguments');
    return output;
}
/** @param {HookInvocation} request @param {ReturnType<typeof hookResult>} input */
export function validateHookResult(request, input) {
    const result = copy(input), expected = hookResult(request, result.status, result.output, result.reason);
    invariant(['ok', 'failed', 'uncertain'].includes(result.status) && canonical(result) === canonical(expected), 'hook_receipt_binding_mismatch');
    invariant(result.status === 'ok' ? result.output !== null && result.reason === null
        : result.output === null && result.reason !== null && failures.includes(result.reason), 'invalid_hook_result');
    if (hookBytes(request.input) > request.definition.maxInputBytes)
        invariant(result.status === 'failed'
            && result.reason === 'input_budget_exceeded', 'hook_input_budget_exceeded');
    if (result.status === 'ok') {
        invariant(result.output !== null, 'invalid_hook_result');
        validateHookOutput(result.output, request.event);
        invariant(hookBytes(result.output) <= request.definition.maxOutputBytes, 'hook_output_budget_exceeded');
    }
    return result;
}
