export function resourceStatusPresentation(resource, kind) {
  const status = String(resource.status || '').toLowerCase();
  if (resource.disabled) return { label: '不可用', detail: '资源已停用。', tone: 'signal' };
  if (kind === 'skill' && ['local-import', 'catalog-import'].includes(resource.source) && status === 'ready') return { label: '文件已安装', detail: '完整 Skill 文件已保存在本机；实际执行还取决于脚本依赖和当前授权。', tone: 'accent' };
  if ((kind === 'skill' || kind === 'skill-space') && status === 'available') return { label: '云端目录可见', detail: '云端 Skill Space 可在目录中读取；绑定后由 Host 下载加载，不代表所有 Skill 已执行验证。', tone: 'neutral' };
  if (kind === 'mcp') {
    if (resource.health?.errorCode || status === 'error') return { label: '探测失败', detail: resource.health?.errorCode || '请重新探测查看连接结果。', tone: 'signal' };
    if (status === 'ready' && (resource.health?.checkedAt || resource.health?.status === 'ready')) return { label: '探测通过', detail: '最近一次连接和工具列表读取成功；不代表每个工具已实际调用验证。', tone: 'accent' };
    if (resource.source === 'local') return { label: '已配置，未探测', detail: '已保存本机连接配置，请重新探测确认连通性。', tone: 'neutral' };
    if (status === 'running') return { label: '云端运行中', detail: '服务端运行状态；本机连通性尚未探测。', tone: 'neutral' };
  }
  return { label: ({ available: '目录可见', configured: '已配置', 'credential-missing': '缺少凭证', ready: '就绪', running: '运行中', error: '异常' })[status] || resource.status || '状态未知', detail: '目录状态不代表 Agent 绑定后的实际执行结果。', tone: 'neutral' };
}
