/** Studio-owned Agents only. Historical cloud catalogs belong to their native products. */
const SUPPORTED_RUNTIMES = new Set(['dsh-native', 'harness', 'codex']);
function createdAt(item) {
  return Date.parse(String(item.metadata?.createdAt || item.createdAt || '').replace(/([+-]\d{2}:\d{2})Z$/, '$1')) || 0;
}
export function createAgentCatalog({ store, builds, deployments }) {
  async function list(query = {}) {
    const source = query.source || 'all';
    if (!['all', 'local', 'cloud'].includes(source)) throw Object.assign(new Error('Agent 来源无效'), { code: 'INVALID_QUERY' });
    const page = Math.max(1, Math.floor(Number(query.page) || 1));
    const pageSize = Math.min(100, Math.max(1, Math.floor(Number(query.limit) || 50)));
    const needle = String(query.query || '').trim().toLowerCase();
    const cloud = source === 'local' || !deployments ? { items: [], warnings: [] } : await deployments();
    const local = source === 'cloud' ? [] : await (await store()).list();
    const rows = [...local, ...cloud.items.filter(item => item.source === 'studio-deployment' && item.deployment?.id)]
      .filter(item => SUPPORTED_RUNTIMES.has(item.spec?.runtime?.type))
      .filter(item => !needle || [item.metadata?.id, item.metadata?.name, item.metadata?.description, item.spec?.description].filter(Boolean).join(' ').toLowerCase().includes(needle))
      .sort((a, b) => createdAt(b) - createdAt(a) || String(a.metadata?.id).localeCompare(String(b.metadata?.id)));
    const items = rows.slice((page - 1) * pageSize, page * pageSize);
    const catalogItems = builds ? await Promise.all(items.map(async item => item.source === 'studio-deployment' ? item : ({ ...item, builds: await builds(item.metadata?.id || item.id) }))) : items;
    return { items: catalogItems, total: rows.length, page, pageSize, warnings: cloud.warnings || [], source: 'studio-catalog', collection: source };
  }
  return { list };
}
