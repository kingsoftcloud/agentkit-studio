/** Default task capabilities are authored once, then frozen as concrete tool
 * bindings. This inventory grants no permission and never changes an existing
 * session. External resources are admitted separately by their owner. */
export const NATIVE_DEFAULT_TOOL_NAMES: readonly string[] = Object.freeze([
  'workspace_status', 'list_workspace_files', 'read_workspace_file', 'search_workspace_files',
  'write_workspace_file', 'write_workspace_files', 'edit_workspace_file', 'multi_edit_workspace_file',
  'apply_workspace_patch', 'lint_workspace_file', 'web_fetch', 'web_search',
  'sandbox_status', 'run_command', 'read_command_output', 'stop_command',
  'browser_inspect_workspace',
]);
export function defaultNativeToolNames(availableNames: readonly string[]): string[] {
  const available = new Set(availableNames);
  return NATIVE_DEFAULT_TOOL_NAMES.filter(name => available.has(name));
}
