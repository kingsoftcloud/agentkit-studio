import { emptyUsage, TOOL_RESOURCE_USAGE_CONTRACT } from './contracts.mjs';
import type { ObjectValue, ToolCall, ToolResult, Usage } from './contracts.mjs';
import { copy, invariant } from './values.mjs';

/** Validate partial counters without converting missing/invalid values to zero.
 * A separate flag carries completeness; Usage remains an additive known part.
 */
export function toolResourceUsage(result: ToolResult): Usage {
  invariant(result.resourceUsageReported === undefined || typeof result.resourceUsageReported === 'boolean'
    && result.resourceUsage !== undefined, 'invalid_tool_usage_report_status');
  const usage = copy(result.resourceUsage ?? emptyUsage());
  invariant(usage && typeof usage === 'object' && !Array.isArray(usage)
    && Object.keys(usage).every(key => ['inputTokens', 'outputTokens', 'modelCalls', 'toolCalls', 'cost', 'cachedInputTokens', 'cacheWriteInputTokens', 'reasoningTokens'].includes(key)), 'invalid_usage');
  for (const key of ['inputTokens', 'outputTokens', 'modelCalls', 'toolCalls', 'cost', 'cachedInputTokens', 'cacheWriteInputTokens', 'reasoningTokens'] as const) {
    const value = usage[key];
    invariant(value === undefined && ['cachedInputTokens', 'cacheWriteInputTokens', 'reasoningTokens'].includes(key)
      || typeof value === 'number' && Number.isFinite(value) && value >= 0 && (key === 'cost' || Number.isSafeInteger(value)), 'invalid_usage');
  }
  return usage;
}

export const toolUsageIncomplete = (result: ToolResult): boolean => result.resourceUsageReported === false
  || Boolean(result.childBudgetSettlement && result.metadata?.usageReported === false);

/** A committed tool receipt owns its resource delta. Child settlements already
 * have their own deduplicated facts and must never be counted a second time.
 */
export function toolResourceUsageFacts(operationKey: string, calls: ToolCall[], results: ToolResult[]): { kind: string; payload: ObjectValue }[] {
  invariant(calls.length === results.length, 'tool_receipt_mismatch');
  return results.flatMap((result, index) => result.childBudgetSettlement || result.resourceUsage === undefined ? [] : [{
    kind: toolUsageIncomplete(result) ? 'usage.unavailable' : 'usage.reported', payload: {
      contract: TOOL_RESOURCE_USAGE_CONTRACT, semantics: 'delta', source: 'tool_resources', requestId: operationKey,
      attemptId: `${operationKey}:tool:${calls[index]!.callId}`, callId: calls[index]!.callId,
      usage: toolResourceUsage(result) as unknown as ObjectValue,
    },
  }]);
}

/** No receipt means the Host cannot prove that a nested request was free.
 * Preserve an explicit unknown lower bound; never invent a model-call count.
 */
export function unknownToolResourceUsageFacts(operationKey: string, calls: ToolCall[]): { kind: string; payload: ObjectValue }[] {
  return calls.map(call => ({ kind: 'usage.unavailable', payload: {
    contract: TOOL_RESOURCE_USAGE_CONTRACT, semantics: 'delta', source: 'tool_resources', requestId: operationKey,
    attemptId: `${operationKey}:tool:${call.callId}`, callId: call.callId, reason: 'tool_receipt_unavailable',
    usage: emptyUsage() as unknown as ObjectValue,
  } }));
}
