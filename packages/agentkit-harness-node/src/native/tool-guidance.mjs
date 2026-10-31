/** Tool owners contribute usage guidance; the core only assembles admitted contributions. */
export function nativeToolModelGuidance(tool, { commandBackend } = {}) {
  if (tool.name === 'read_workspace_file' && tool.workspaceMediaPolicy === 'bounded-image-read/v1')
    return ['Inspect workspace text or supported images through this tool. A partial read is not a complete observation.'];
  if (tool.name === 'run_command') return [
    'Use the bound backend and its reported cwd. Read saved output using task_id and cursors; a truncated preview is not command failure. Never relaunch an unknown write to recover output.',
    ...(commandBackend === 'e2b' ? ['Commands run in a remote sandbox. Workspace paths describe the host filesystem; do not assume they exist as remote command paths.'] : []),
  ];
  if (tool.childBudgetPolicy === 'start/v1' || tool.childBudgetPolicy === 'delegate/v1')
    return ['Child tasks share the parent task budget and permissions. Set smaller explicit limits when useful; await owned results rather than duplicating the work.'];
  return [];
}
