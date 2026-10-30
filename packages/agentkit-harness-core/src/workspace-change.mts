import type { ToolDefinition, ToolResult } from './contracts.mjs';
import { invariant } from './values.mjs';

export const WORKSPACE_CHANGE_POLICY = 'observed-command/v1' as const;
export const WORKSPACE_CHANGE_CONTRACT = 'agentkit.workspace-change-observation/v1' as const;
export interface WorkspaceChangeObservation {
  contract: typeof WORKSPACE_CHANGE_CONTRACT;
  status: 'captured' | 'unavailable';
  revision: string | null;
  reason: null | 'inventory_limit' | 'concurrent_change' | 'inventory_unavailable' | 'unsupported_path' | 'baseline_unavailable';
}

/** Process completion and change-inventory completeness are independent facts.
 * An unavailable inventory invalidates prior verification, not the process receipt. */
export function validateWorkspaceChange(result: ToolResult, definition?: ToolDefinition): WorkspaceChangeObservation | undefined {
  const value = result.workspaceChangeObservation;
  if (value === undefined) return undefined;
  invariant(definition?.workspaceChangePolicy === WORKSPACE_CHANGE_POLICY && !definition.readOnly
    && !definition.concurrentSafe && result.status !== 'approval_required', 'workspace_change_not_owned');
  invariant(value && Object.keys(value).length === 4
    && Object.keys(value).every(key => ['contract', 'status', 'revision', 'reason'].includes(key))
    && value.contract === WORKSPACE_CHANGE_CONTRACT
    && (value.status === 'captured' && typeof value.revision === 'string' && !!value.revision && value.reason === null
      && Array.isArray(result.workspaceChangedPaths)
      || value.status === 'unavailable' && value.revision === null
      && ['inventory_limit', 'concurrent_change', 'inventory_unavailable', 'unsupported_path', 'baseline_unavailable'].includes(String(value.reason))
      && result.workspaceChangedPaths === undefined), 'invalid_workspace_change_observation');
  return value;
}

export function workspaceChangeUnobserved(result: ToolResult): boolean {
  return result.workspaceChangeObservation?.status === 'unavailable';
}
