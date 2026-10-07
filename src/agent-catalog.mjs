/** Page the local and cloud Agent collections as one catalog, with explicit cloud availability. */
export function createAgentCatalog({ store, server, builds }) {
  async function list(query = {}, { signal } = {}) {
    const page = Math.max(1, Math.floor(Number(query.page) || 1));
    const pageSize = Math.min(100, Math.max(1, Math.floor(Number(query.limit) || 50)));
    const needle = String(query.query || '').trim();
    const local = (await (await store()).list()).filter(item => !needle || [item.metadata?.id, item.metadata?.name, item.metadata?.description, item.spec?.description].filter(Boolean).join(' ').toLowerCase().includes(needle.toLowerCase()));
    const offset = (page - 1) * pageSize;
    const items = local.slice(offset, offset + pageSize);
    const cloudOffset = Math.max(0, offset - local.length);
    const cloudPage = Math.floor(cloudOffset / pageSize) + 1;
    let total = local.length, cloudConnected = false, warnings = [];
    try {
      const client = await server();
      const first = await client.listAgents({ page: cloudPage, pageSize, query: needle }, { signal });
      total += Number(first.total) || 0;
      const needed = pageSize - items.length;
      const cloud = first.items.slice(cloudOffset % pageSize);
      if (cloud.length < needed && cloudOffset + cloud.length < Number(first.total)) {
        const next = await client.listAgents({ page: cloudPage + 1, pageSize, query: needle }, { signal });
        cloud.push(...next.items);
      }
      items.push(...cloud.slice(0, needed));
      cloudConnected = true;
    } catch (error) {
      if (signal?.aborted) throw error;
      total = local.length;
      warnings = [{ code: 'CLOUD_CATALOG_UNAVAILABLE', message: '云端 Agent 目录不可用，当前显示本地 Agent；本地创建和运行仍可使用。' }];
    }
    const catalogItems = builds ? await Promise.all(items.map(async item => ({ ...item, builds: await builds(item.metadata?.id || item.id) }))) : items;
    return { items: catalogItems, total, page, pageSize, cloudConnected, warnings, source: 'studio-catalog' };
  }
  return { list };
}
