export const NATIVE_CAPABILITY_PRESETS = [
  { id: 'web', label: '添加网页调研能力', tools: ['web_fetch', 'web_search'], detail: '读取公开网页并搜索资料；搜索是否可用取决于本地搜索服务配置。' },
  { id: 'read', label: '添加本地文件读取', tools: ['list_workspace_files', 'read_workspace_file', 'search_workspace_files'], detail: '只读取工作区内的文件，不授予写入权限。' },
  { id: 'write', label: '添加本地文件写入', tools: ['write_workspace_file', 'apply_workspace_patch'], detail: '允许请求工作区修改，执行仍受 Agent 规则与会话审批约束。' },
  { id: 'command', label: '添加本地命令执行', tools: ['sandbox_status', 'run_command', 'read_command_output', 'stop_command'], detail: '在绑定工作区启动、查看与停止本地命令；共享宿主文件系统和网络，不是隔离沙箱，执行仍受会话审批约束。' },
];

/** Selection only; this does not grant execution permissions or modify a Build. */
export function nativeCapabilitySummary({ tools = [], mcp = [], skills = [] } = {}) {
  const names = tools.map(tool => typeof tool === 'string' ? tool : tool.resourceId).filter(Boolean);
  const external = mcp.length || skills.length;
  return {
    names,
    text: !names.length && !external ? '当前为纯对话 Agent：未绑定外部工具，不能联网调研或操作本地文件。'
      : `已选择 ${names.length} 个工具、${mcp.length} 个 MCP、${skills.length} 个 Skill；仅能使用已绑定且获准执行的能力。`,
    hint: '需要更多能力时，请编辑 Agent 的「绑定能力」，保存后创建新的会话；已有会话继续使用原配置。',
  };
}
