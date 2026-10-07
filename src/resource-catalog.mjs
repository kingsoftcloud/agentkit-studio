/** One bounded catalog contract for gateway models and merged local/cloud resources. */
export function paginateResources(items, query = {}, metadata = {}) {
  const kind = String(query.kind || '');
  const needle = String(query.query || '').trim().toLowerCase();
  const limit = Math.min(200, Math.max(1, Math.floor(Number(query.limit) || 100)));
  let offset = 0;
  if (query.cursor) {
    try {
      const cursor = JSON.parse(Buffer.from(String(query.cursor), 'base64url').toString());
      if (cursor.kind !== kind || cursor.query !== needle || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw new Error();
      offset = cursor.offset;
    } catch { throw Object.assign(new Error('资源分页游标无效，请刷新目录'), { code: 'INVALID_RESOURCE_CURSOR' }); }
  }
  const seen = new Set();
  const rows = items.filter(item => {
    const id = String(item.resourceId || item.id || item.name || '');
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return !needle || [id, item.name, item.displayName, item.source, item.contract?.model].filter(Boolean).join(' ').toLowerCase().includes(needle);
  });
  return { ...metadata, items: rows.slice(offset, offset + limit), total: rows.length,
    nextCursor: offset + limit < rows.length ? Buffer.from(JSON.stringify({ kind, query: needle, offset: offset + limit })).toString('base64url') : null };
}

async function cloudItems(serverClient, kind, signal) {
  const items = [];
  for (let page = 1; page <= 1000; page += 1) {
    const result = await serverClient.listResource(kind, { Page: page, PageSize: 100 }, { signal });
    items.push(...result.items);
    if (!result.items.length || items.length >= Number(result.total)) return items;
  }
  throw Object.assign(new Error('云端资源目录过大，请缩小查询范围'), { code: 'RESOURCE_CATALOG_TOO_LARGE' });
}

export async function listStudioResources({ query = {}, models, localMcpStore, skillDiscovery, serverClient, signal, mcpProbes }) {
  const kind = String(query.kind || '');
  if (kind === 'model') {
    const settings = !query.profileId && models.settings ? await models.settings() : {};
    const profiles = (settings.modelProfiles || []).filter(item => item.enabled !== false);
    let catalog, warnings = [];
    try { catalog = await models.catalog(String(query.profileId || '')); }
    catch (error) {
      if (!profiles.length) throw error;
      catalog = {items:[],defaultModel:profiles.find(item=>item.default)?.id || profiles[0].id};
      warnings = [{code:error?.code || 'MODEL_CATALOG_UNAVAILABLE',message:'默认模型网关目录不可用，当前显示已配置的模型资源。'}];
    }
    const configured = profiles.map(item=>({resourceId:item.id,name:item.displayName || item.modelName || item.id,source:'本地模型配置',status:item.credentialConfigured === false ? 'credential-missing' : 'configured',kind,contract:{model:item.modelName,profileId:item.id}}));
    const gateway = catalog.items.map(item => ({ resourceId: item.id, name: item.name || item.id, source: '模型网关', status: 'available', kind, contract: { model: item.id, input: item.input } }));
    return paginateResources([...configured,...gateway.filter(item=>!configured.some(profile=>profile.resourceId===item.resourceId))], query, { source: 'model-gateway', defaultModel: catalog.defaultModel, ...(warnings.length ? {warnings} : {}) });
  }
  const local = kind === 'mcp' ? await localMcpStore.list({ limit: Infinity }) : (await skillDiscovery.listInstalled()).items;
  let cloud = [], warnings = [];
  try { cloud = await cloudItems(serverClient, kind === 'skill' ? 'skill-space' : kind, signal); }
  catch (error) {
    if (signal?.aborted) throw error;
    warnings = [{ code: error?.code || 'CLOUD_CATALOG_UNAVAILABLE', message: '云端资源目录不可用，当前仅显示本地资源。' }];
  }
  const items = [...local.map(item => ({ ...item, kind, source: item.source || 'local' })),
    ...cloud.map(item => ({ ...item, kind, source: item.source || 'agentengine-server',
      resourceId: item.resourceId || item.id, name: item.name || item.displayName || item.resourceId || item.id }))];
  const observed = kind === 'mcp' && mcpProbes ? await Promise.all(items.map(async item => ({ ...item, ...await mcpProbes.get(item.resourceId) }))) : items;
  return paginateResources(observed, query, { source: 'agentkit-studio', warnings });
}
