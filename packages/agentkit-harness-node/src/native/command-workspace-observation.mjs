import { WORKSPACE_CHANGE_CONTRACT } from '@kingsoftcloud/agentkit-harness-core';

const reasons = new Map([
  ['capture_limit_exceeded', 'inventory_limit'],
  ['workspace_changed_during_capture', 'concurrent_change'],
  ['capture_failed', 'inventory_unavailable'],
  ['unsupported_workspace_path', 'unsupported_path'],
]);

/** Inventory is a bounded observation, never a command authorization check.
 * Root/session/authority errors still escape and are handled by the executor. */
export async function captureCommandWorkspace(capture, request) {
  try {
    const captured = await capture(request);
    if (!captured || typeof captured.revision !== 'string' || !captured.revision
      || !captured.entries || typeof captured.entries !== 'object' || Array.isArray(captured.entries))
      return { captured: null, reason: 'inventory_unavailable' };
    return { captured, reason: null };
  }
  catch (error) {
    const reason = reasons.get(error?.code);
    if (!reason) throw error;
    return { captured: null, reason };
  }
}

export function commandWorkspaceChange(before, after) {
  if (!before.captured || !after.captured) return {
    workspaceChangeObservation: { contract: WORKSPACE_CHANGE_CONTRACT, status: 'unavailable', revision: null,
      reason: after.reason ?? before.reason ?? 'baseline_unavailable' },
  };
  const paths = [...new Set([...Object.keys(before.captured.entries), ...Object.keys(after.captured.entries)])]
    .filter(path => before.captured.entries[path] !== after.captured.entries[path]).sort();
  return { workspaceChangedPaths: paths,
    workspaceChangeObservation: { contract: WORKSPACE_CHANGE_CONTRACT, status: 'captured', revision: after.captured.revision, reason: null } };
}
