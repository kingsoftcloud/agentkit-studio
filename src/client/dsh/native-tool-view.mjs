export const NATIVE_TOOL_TITLES = {
  ToolSearch: '查找已绑定工具', DeferredToolCall: '调用已加载工具',
  ArtifactRead: '读取任务工件', ArtifactSearch: '搜索任务工件',
  workspace_status: '查看工作区', list_workspace_files: '列出工作区文件',
  read_workspace_file: '读取文件', write_workspace_file: '写入文件', write_workspace_files: '写入多个文件',
  edit_workspace_file: '修改文件', multi_edit_workspace_file: '修改多处文件',
  search_workspace_files: '搜索文件', lint_workspace_file: '检查文件', delete_workspace_file: '删除文件',
  apply_workspace_patch: '应用文件补丁', list_workspace_checkpoints: '查看文件检查点',
  preview_workspace_rewind: '预览文件恢复', rewind_workspace_files: '恢复文件',
};
const errorLabels = {
  deferred_tool_not_loaded_or_not_deferred: '该工具尚未加载或未绑定。请使用已绑定的工具；需要更多能力时编辑 Agent 配置。',
  permission_denied: '未获准执行此操作，请检查 Agent 规则和会话权限。',
  invalid_path: '路径超出可访问范围或不可用，请选择工作区内的文件。',
  tool_not_found: '当前 Agent 未绑定此工具。',
  artifact_not_available: '当前任务没有此工件的读取授权，请通过产生结果的原工具继续读取。',
};

export function nativeToolDisplay(toolName, block) {
  const call = block?.call ?? block;
  let args = {}; try { args = JSON.parse(call?.argsRaw ?? '{}'); } catch { /* incomplete stream */ }
  const text = (block?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
  let result; try { result = JSON.parse(text); } catch { /* plain output remains visible */ }
  const error = block?.isError ? errorLabels[result?.code] ?? '工具未成功执行，请展开查看原始结果。' : '';
  return { title: NATIVE_TOOL_TITLES[toolName] ?? toolName, error, text,
    summary: String(args.path ?? args.query ?? args.name ?? args.directory ?? '').slice(0, 180),
    args: call?.argsRaw ?? '', settled: block?.kind === 'tool-result' };
}

/** Public keyed views change presentation only; committed call/result data stays intact. */
export function installNativeToolViews(ctx, React) {
  const h = React.createElement;
  function NativeToolRow({ toolName, block }) {
    const display = nativeToolDisplay(toolName, block);
    return h('details', { style: { margin: '6px 0', padding: '8px 12px', border: '1px solid currentColor', borderRadius: '8px', fontSize: '12px', overflowWrap: 'anywhere' } },
      h('summary', { style: { cursor: 'pointer' } }, `${display.title}${display.summary ? ` · ${display.summary}` : ''}${display.error ? ' · 未完成' : ''}`),
      display.error ? h('p', { role: 'alert' }, display.error) : null,
      h('div', null, '调用参数'), h('pre', { style: { whiteSpace: 'pre-wrap' } }, display.args),
      h('div', null, display.text ? '执行结果' : display.settled ? '无文本结果' : '正在执行'),
      display.text ? h('pre', { style: { whiteSpace: 'pre-wrap', maxHeight: '360px', overflow: 'auto' } }, display.text) : null);
  }
  ctx.slots.inject('tool.call.toolview', function* () {
    for (const name of Object.keys(NATIVE_TOOL_TITLES)) yield ctx.slots.register({ name: 'tool.call.toolview', key: name }, NativeToolRow);
  });
}
