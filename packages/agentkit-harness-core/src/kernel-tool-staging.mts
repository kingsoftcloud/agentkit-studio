import type { ObjectValue, RunConfiguration, RunSnapshot, ToolCall, ToolResult } from './contracts.mjs';
import type { NativePolicyRegistry } from './policy-registry.mjs';
import { executeCoordinatorResponse, isCoordinatorResponse, COORDINATOR_RESPONSE_POLICY } from './coordinator-response.mjs';
import { executeToolDiscovery, TOOL_SEARCH, DEFERRED_TOOL_CALL } from './tool-discovery.mjs';

/** Closed kernel capabilities, never inferred from a Host tool's name, readOnly
 * flag or permissions. Their only authoritative mutation is the fenced commit.
 */
export function kernelToolPolicy(config: RunConfiguration, call: ToolCall, policies: NativePolicyRegistry): string | null {
  return policies.stagedToolPolicy(config, call) ?? (isCoordinatorResponse(config, call) ? COORDINATOR_RESPONSE_POLICY
    : config.toolDiscoveryPolicy && [TOOL_SEARCH, DEFERRED_TOOL_CALL].includes(call.name) ? config.toolDiscoveryPolicy : null);
}

export function executeKernelTool(snapshot: RunSnapshot, config: RunConfiguration, call: ToolCall,
  interaction: ObjectValue | null, digest: (value: unknown) => string, policies: NativePolicyRegistry): ToolResult | null {
  return policies.executeTool(snapshot, config, call, interaction)
    ?? (isCoordinatorResponse(config, call) ? executeCoordinatorResponse(snapshot, config, call, digest)
      : config.toolDiscoveryPolicy && [TOOL_SEARCH, DEFERRED_TOOL_CALL].includes(call.name)
        ? executeToolDiscovery(snapshot, config, call) : null);
}
