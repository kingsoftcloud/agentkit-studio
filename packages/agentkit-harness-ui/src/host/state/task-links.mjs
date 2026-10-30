/** A Native execution root comes from the authenticated Host, not the model or
 * the conversation shell's independently selected working directory. */
export function nativeTaskWorkspaceRoot(status, { agentId, sessionId, fallback } = {}) {
  const workspace = status?.workspace;
  return status?.contract === 'agentkit.studio-native-recovery/v1' && !status.managed && status.agentId === agentId
    && status.sessionId === sessionId && typeof status.runId === 'string' && status.runId
    && workspace?.contract === 'agentkit.native-execution-workspace/v1'
    && typeof workspace.workspaceId === 'string' && workspace.workspaceId
    && typeof workspace.root === 'string' && workspace.root.length <= 32768
    && !/[\u0000-\u001f]/.test(workspace.root) && /^(?:\/|[a-z]:[\\/])/i.test(workspace.root)
    ? workspace.root : fallback;
}

/** Validate the original Markdown href before URL normalization can erase traversal. */
export function taskWorkspaceFileTarget(href, workspaceRoot) {
  if (typeof href !== 'string' || typeof workspaceRoot !== 'string' || !workspaceRoot) return null;
  let value;
  try { value = decodeURIComponent(href); } catch { return null; }
  if (!value || /[\u0000-\u001f?#]/.test(value)) return null;
  const position = value.match(/:(\d+)(?::(\d+))?$/);
  if (position) {
    if (![position[1], position[2]].filter(Boolean).every(v => Number.isSafeInteger(Number(v)) && Number(v) > 0)) return null;
    value = value.slice(0, position.index);
  }
  value = value.replaceAll('\\', '/');
  const base = workspaceRoot.replaceAll('\\', '/').replace(/\/+$/, '');
  if (value.split('/').includes('..') || /^(?![a-z]:\/)[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('//')) return null;
  const absolute = value.startsWith('/') || /^[a-z]:\//i.test(value);
  if (absolute) {
    const insensitive = /^[a-z]:\//i.test(base);
    const input = insensitive ? value.toLowerCase() : value;
    const prefix = (insensitive ? base.toLowerCase() : base) + '/';
    if (!input.startsWith(prefix)) return null;
  } else {
    value = value.replace(/^(?:\.\/)+/, '');
    if (!value || value.includes(':')) return null;
    value = base + '/' + value;
  }
  return { path: value, ...(position ? { line: Number(position[1]), ...(position[2] ? { column: Number(position[2]) } : {}) } : {}) };
}
