/** Host-owned MCP catalog for direct AgentEngine/DSH mode.
 *
 * The browser only receives connection metadata and the last probe contract.
 * Credential values are owned by DSH's credentials service and are never
 * written into these records.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export class LocalMcpStoreError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'LocalMcpStoreError'; this.code = code; this.details = details; }
}

function idOf(value) { return String(value?.resourceId || value?.id || value || '').trim(); }
function safeId(value) { return /^mcp-local-[a-f0-9]{16}$/.test(value); }
function normalize(record) {
  if (!record || typeof record !== 'object') return null;
  const resourceId = idOf(record);
  if (!resourceId) return null;
  const server = record.server && typeof record.server === 'object' ? record.server : {};
  return {
    ...record,
    id: resourceId,
    resourceId,
    name: String(record.name || server.name || resourceId),
    displayName: String(record.displayName || record.name || server.name || resourceId),
    description: String(record.description || ''),
    version: String(record.version || server.version || '1.0.0'),
    source: 'local',
    status: String(record.status || 'ready'),
    server: {
      name: String(server.name || record.name || resourceId),
      version: String(server.version || record.version || '1.0.0'),
      transport: String(server.transport || 'http'),
      ...(server.endpointUrl ? { endpointUrl: String(server.endpointUrl) } : {}),
      ...(server.command ? { command: String(server.command) } : {}),
      ...(Array.isArray(server.args) ? { args: server.args.map(String) } : {}),
      ...(server.envRefs && typeof server.envRefs === 'object' ? { envRefs: { ...server.envRefs } } : {}),
    },
  };
}

export function createLocalMcpStore({ storeDir } = {}) {
  if (!storeDir) throw new TypeError('storeDir is required');
  async function ensureDir() { await mkdir(storeDir, { recursive: true, mode: 0o700 }); }
  function pathFor(resourceId) {
    if (!safeId(resourceId)) throw new LocalMcpStoreError('MCP_ID_INVALID', '本地 MCP 资源 ID 无效', { resourceId });
    return join(storeDir, `${resourceId}.json`);
  }
  async function save(record) {
    const normalized = normalize(record);
    if (!normalized) throw new LocalMcpStoreError('MCP_RECORD_INVALID', 'MCP 资源声明无效');
    await ensureDir();
    const target = pathFor(normalized.resourceId);
    const temporary = `${target}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(temporary, JSON.stringify(normalized, null, 2), { mode: 0o600 });
    await rename(temporary, target);
    return normalized;
  }
  async function list({ query = '', limit = 200 } = {}) {
    await ensureDir();
    const names = await readdir(storeDir).catch(() => []);
    const needle = String(query || '').trim().toLowerCase();
    const items = [];
    for (const name of names.filter(item => item.endsWith('.json')).sort()) {
      try {
        const item = normalize(JSON.parse(await readFile(join(storeDir, name), 'utf8')));
        if (!item) continue;
        if (needle && !`${item.displayName} ${item.name} ${item.resourceId}`.toLowerCase().includes(needle)) continue;
        items.push(item);
      } catch { /* ignore corrupt records */ }
    }
    return items.slice(0, Math.min(200, Math.max(1, Number(limit) || 200)));
  }
  async function get(resourceId) {
    try { return normalize(JSON.parse(await readFile(pathFor(idOf(resourceId)), 'utf8'))); } catch { return null; }
  }
  async function create(payload = {}) {
    const server = payload.server && typeof payload.server === 'object' ? payload.server : {};
    const name = String(server.name || payload.name || '').trim();
    const displayName = String(payload.displayName || payload.name || name).trim();
    const transport = String(server.transport || 'http').trim().toLowerCase();
    if (!name || !displayName) throw new LocalMcpStoreError('MCP_NAME_MISSING', 'MCP 名称不能为空');
    if (!['http', 'sse', 'stdio'].includes(transport)) throw new LocalMcpStoreError('MCP_TRANSPORT_INVALID', 'MCP 传输方式无效');
    if (transport !== 'stdio' && !/^https?:\/\//i.test(String(server.endpointUrl || ''))) throw new LocalMcpStoreError('MCP_ENDPOINT_INVALID', 'HTTP/SSE MCP 需要有效的服务地址');
    if (transport === 'stdio' && !String(server.command || '').trim()) throw new LocalMcpStoreError('MCP_COMMAND_INVALID', 'stdio MCP 需要启动命令');
    const resourceId = `mcp-local-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    return save({
      resourceId, id: resourceId, name, displayName,
      description: String(payload.description || ''), version: String(server.version || payload.version || '1.0.0'),
      server: { ...server, name, transport, envRefs: server.envRefs && typeof server.envRefs === 'object' ? server.envRefs : {} },
      status: 'pending', contract: { discoveredTools: [] }, health: { status: 'pending', toolCount: 0, tools: [] },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
  }
  async function markProbe(resourceId, { tools = [], error = null } = {}) {
    const current = await get(resourceId);
    if (!current) throw new LocalMcpStoreError('MCP_NOT_FOUND', '本地 MCP 资源不存在', { resourceId });
    const safeTools = Array.isArray(tools) ? tools.slice(0, 200).map(tool => ({
      name: String(tool?.name || ''), description: String(tool?.description || ''),
      inputSchema: tool?.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} },
    })).filter(tool => tool.name) : [];
    const failed = Boolean(error);
    return save({ ...current, status: failed ? 'error' : 'ready', contract: { ...(current.contract || {}), discoveredTools: safeTools }, health: { status: failed ? 'error' : 'ready', toolCount: safeTools.length, tools: safeTools, ...(failed ? { error: String(error) } : {}) }, updatedAt: new Date().toISOString() });
  }
  async function remove(resourceId) {
    const id = idOf(resourceId);
    if (!safeId(id)) throw new LocalMcpStoreError('MCP_ID_INVALID', '本地 MCP 资源 ID 无效', { resourceId: id });
    await rm(pathFor(id), { force: true });
    return { resourceId: id, deleted: true };
  }
  return { list, get, create, markProbe, remove, root: storeDir };
}
