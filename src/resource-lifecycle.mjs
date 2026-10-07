/** Explicit deletion scope prevents a missing local record from deleting a cloud service. */
export async function deleteStudioMcp({ resourceId, scope = 'local' } = {}, { localStore, serverClient }) {
  const id = typeof resourceId === 'string' ? resourceId.trim() : '';
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
  if (!id || id.length > 200) fail('MCP_ID_INVALID', 'MCP 资源 ID 无效');
  if (scope === 'cloud') {
    if (!/^mcp-[A-Za-z0-9-]+$/.test(id) || id.startsWith('mcp-local-')) fail('MCP_SCOPE_INVALID', '云端删除只接受云端 MCP ID');
    const result = await serverClient.action('DeleteMCP', { Id: id });
    if (result.data?.Deleted !== true) fail('MCP_DELETE_UNCONFIRMED', '服务端未确认 MCP 已删除，请刷新云端目录核对');
    return { resourceId: id, scope, deleted: true };
  }
  if (scope !== 'local') fail('MCP_SCOPE_INVALID', 'MCP 删除范围无效');
  const record = await localStore.get(id);
  if (!record) fail('RESOURCE_NOT_FOUND', '本地 MCP 配置不存在；云端资源需要明确选择删除云端 MCP');
  return localStore.remove(id);
}
