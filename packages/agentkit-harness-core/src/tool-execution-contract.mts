import type { ToolDefinition } from './contracts.mjs';
import { canonical, copy } from './values.mjs';

/** Host governance is checked against the original ledger definition. I/O
 * owners compare their protocol separately; metadata never changes its schema,
 * permission requirements, effect classification or timeout. Unknown fields
 * remain in the comparison and therefore fail closed. */
export function matchesToolExecutionContract(candidate: ToolDefinition | null | undefined,
  expected: ToolDefinition): boolean {
  const protocol = executionProtocol(candidate), formal = executionProtocol(expected);
  return protocol !== null && formal !== null && canonical(protocol) === canonical(formal);
}

function executionProtocol(candidate: ToolDefinition | null | undefined): ToolDefinition | null {
  if (!candidate) return null;
  if (candidate.approvalPolicy !== undefined && candidate.approvalPolicy !== 'durable-preflight/v1') return null;
  if (candidate.recoveryPolicy !== undefined && !['manual', 'safe-read/v1', 'receipt-observation/v1', 'ephemeral-browser/v1'].includes(candidate.recoveryPolicy)) return null;
  if (candidate.executionTimeoutPolicy !== undefined && !['dispatch/v1', 'dispatch/v2'].includes(candidate.executionTimeoutPolicy)) return null;
  if (candidate.modelGuidance !== undefined && (!Array.isArray(candidate.modelGuidance)
    || candidate.modelGuidance.some(item => typeof item !== 'string'))) return null;
  const protocol = copy(candidate);
  delete protocol.approvalPolicy;
  delete protocol.recoveryPolicy;
  delete protocol.executionTimeoutPolicy;
  delete protocol.modelGuidance;
  return protocol;
}
