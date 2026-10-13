/** Durable connectivity observations for cloud MCPs, separate from their cloud definitions. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

export function createMcpProbes({ storeDir, localStore, adapters }) {
  const pathFor = id => join(storeDir, `${createHash('sha256').update(String(id)).digest('hex')}.json`);
  async function get(id) {
    try { const value = JSON.parse(await readFile(pathFor(id), 'utf8')); return value.resourceId === id ? value : null; }
    catch { return null; }
  }
  async function save(value) {
    await mkdir(storeDir, { recursive: true, mode: 0o700 });
    const target = pathFor(value.resourceId), temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
    await rename(temp, target);
  }
  async function probe(resourceId) {
    if (typeof resourceId !== 'string' || !resourceId || resourceId.length > 200) throw Object.assign(new Error('MCP 资源 ID 无效'), { code: 'MCP_ID_INVALID' });
    const local = await localStore(), record = await local.get(resourceId);
    if (!record && resourceId.startsWith('mcp-local-')) throw Object.assign(new Error('本地 MCP 资源不存在'), { code: 'MCP_NOT_FOUND' });
    try {
      const discovered = await (await adapters()).listMcpTools(record || { resourceId });
      const tools = discovered.slice(0, 200).map(tool => ({ name: String(tool.name || ''), description: String(tool.description || ''), inputSchema: tool.inputSchema || { type: 'object', properties: {} } }));
      if (record) return { ...await local.markProbe(resourceId, { tools }), toolCount: tools.length };
      const value = { resourceId, status: 'ready', contract: { discoveredTools: tools }, health: { toolCount: tools.length, checkedAt: new Date().toISOString() } };
      await save(value);
      return { ...value, toolCount: tools.length };
    } catch (error) {
      if (record) await local.markProbe(resourceId, { error }).catch(() => {});
      else await save({ resourceId, status: 'error', health: { toolCount: 0, errorCode: error.code || 'MCP_PROBE_FAILED', checkedAt: new Date().toISOString() } }).catch(() => {});
      throw error;
    }
  }
  return { get, probe };
}
