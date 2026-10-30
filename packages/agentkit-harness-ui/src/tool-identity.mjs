/** Protocol identity, presentation family and placement have one owner. These
 * descriptors never change execution names or confer tool permissions. */
const groups = [
  ['delivery', 'diagnostics', '交付范围', ['declare_deliverables']],
  ['execute', 'conversation', '终端', ['Bash', 'bash', 'execute', 'run_command', 'Execute', 'ExecuteCommand', 'execute_command', 'RunCommand', 'shell', 'Shell']],
  ['file', 'conversation', '读取', ['Read', 'read', 'read_workspace_file']],
  ['validation', 'conversation', '检查文件', ['lint_workspace_file']],
  ['list', 'conversation', '列出文件', ['Glob', 'glob', 'List', 'list_workspace_files']],
  ['search', 'conversation', '搜索文件', ['Grep', 'grep', 'search_workspace_files', 'Search', 'search']],
  ['edit', 'conversation', '编辑', ['Edit', 'edit_workspace_file', 'multi_edit_workspace_file', 'MultiEdit', 'edit', 'StrReplace', 'Patch', 'apply_workspace_patch']],
  ['write', 'conversation', '写入', ['Write', 'write', 'write_workspace_file', 'write_workspace_files']],
  ['delete', 'conversation', '删除', ['delete_workspace_file']],
  ['agent', 'conversation', '子智能体', ['native_start_child', 'native_delegate', 'Agent', 'Task', 'subagent']],
  ['plan', 'panel', '更新任务', ['TodoWrite', 'TodoRead', 'todo_write', 'todo_read', 'update_plan']],
  ['environment', 'diagnostics', '运行环境', ['sandbox_status', 'workspace_status', 'component_status']],
  ['web-search', 'conversation', '网页搜索', ['web_search', 'WebSearch']],
  ['web-fetch', 'conversation', '网页抓取', ['web_fetch', 'WebFetch']],
  ['browser', 'conversation', '浏览器', ['browser_inspect_workspace']],
  ['skill', 'conversation', '技能', ['Skill', 'skill', 'skill_load', 'load_skill', 'skill_read', 'skill_disclose', 'preview_skill', 'execute_skills', 'skill_read_manifest', 'skill_read_instructions', 'skill_read_resource']],
  ['skill-catalog', 'conversation', '搜索技能', ['skill_catalog', 'skill_search', 'search_skills', 'list_skills', 'list_skill_spaces']],
  ['tool-search', 'conversation', '查找工具', ['tool_search', 'ToolSearch']],
  ['tool-call', 'conversation', '调用工具', ['DeferredToolCall']],
  ['command-output', 'conversation', '终端输出', ['read_command_output']],
  ['command-stop', 'conversation', '停止命令', ['stop_command']],
  ['child-control', 'conversation', '子任务', ['native_read_child', 'native_wait_child', 'native_cancel_child', 'native_merge_child']],
  ['child-report', 'conversation', '向主任务汇报', ['RespondToCoordinator']],
  ['artifact-list', 'conversation', '查看产物', ['ArtifactList']],
  ['artifact-read', 'conversation', '读取产物', ['ArtifactRead']],
  ['artifact-search', 'conversation', '搜索产物', ['ArtifactSearch']],
];
const identities = new Map(groups.flatMap(([family, placement, title, names]) => names.map(name => [name, Object.freeze({ family, placement, title })])));
const unknown = Object.freeze({ family: 'generic', placement: 'conversation', title: null });
export function toolIdentity(name) { return identities.get(String(name ?? '')) ?? unknown; }
export function toolConversationVisible(item) {
  return toolIdentity(item.name).placement === 'conversation'
    || ['failed', 'uncertain', 'interrupted', 'waiting'].includes(item.status);
}
export function localizedToolTitle(name, fallback, locale) {
  return String(locale ?? '').startsWith('zh') ? toolIdentity(name).title ?? fallback : fallback;
}
