/** Workspace tools accepted by the Native child binder. No authority is granted
 * by this inventory; the Host also requires the original parent tool binding. */
export const NATIVE_CHILD_WORKSPACE_TOOLS = Object.freeze(['workspace_status', 'list_workspace_files', 'read_workspace_file', 'lint_workspace_file',
  'search_workspace_files', 'write_workspace_file', 'write_workspace_files', 'edit_workspace_file',
  'multi_edit_workspace_file', 'delete_workspace_file', 'apply_workspace_patch',
  'list_workspace_checkpoints', 'preview_workspace_rewind', 'rewind_workspace_files']);

/** Requires a separately bound execution resource; this is not a file-tool grant. */
export const NATIVE_CHILD_COMMAND_TOOLS = Object.freeze(['sandbox_status', 'run_command', 'read_command_output', 'stop_command']);
