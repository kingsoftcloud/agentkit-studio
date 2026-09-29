/** Local Studio Agent store for the plugin Node host.
 *
 * The legacy Studio Host persisted locally-authored AgentDrafts; this store
 * restores that contract: conversation authoring writes an Agent here, the
 * Agents list merges local rows with cloud Agents, and local builds package
 * them. Shape matches the browser's `{ metadata, spec, bindings }` contract.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export class AgentStoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AgentStoreError';
    this.code = code;
    this.details = details;
  }
}

export function createAgentStore({ storeDir } = {}) {
  const root = storeDir;

  async function ensureDir() { await mkdir(root, { recursive: true, mode: 0o700 }); }

  function pathFor(agentId) { return join(root, `${agentId}.json`); }

  async function create({ name, runtimeType = 'dsh-native', description = '', spec = {}, bindings = {} }) {
    await ensureDir();
    const agentId = `ar-local-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const record = {
      metadata: {
        id: agentId,
        name: String(name || '未命名 Agent'),
        description: String(description || ''),
        revision: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        local: true,
      },
      spec: { ...spec, runtime: { type: runtimeType } },
      bindings,
    };
    const target = pathFor(agentId);
    const tmp = `${target}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(tmp, JSON.stringify(record, null, 2));
    await renameSafe(tmp, target);
    return record;
  }

  async function renameSafe(from, to) {
    const { rename } = await import('node:fs/promises');
    await rename(from, to);
  }

  async function list() {
    await ensureDir();
    let names;
    try { names = await readdir(root); } catch { return []; }
    const items = [];
    for (const name of names.filter(item => item.endsWith('.json')).sort()) {
      try {
        const record = JSON.parse(await readFile(join(root, name), 'utf8'));
        items.push({
          metadata: record.metadata,
          spec: record.spec || {},
          bindings: record.bindings || {},
          builds: [],
          source: 'local-store',
        });
      } catch { /* corrupt local agent is skipped */ }
    }
    return items;
  }

  async function get(agentId) {
    try { return JSON.parse(await readFile(pathFor(agentId), 'utf8')); } catch { return null; }
  }

  async function update(agentId, patch = {}) {
    const record = await get(agentId);
    if (!record) throw new AgentStoreError('AGENT_NOT_FOUND', '本地 Agent 不存在', { agentId });
    if (patch.name) record.metadata.name = String(patch.name);
    if (patch.description !== undefined) record.metadata.description = String(patch.description);
    if (patch.spec) record.spec = { ...record.spec, ...patch.spec, runtime: patch.spec?.runtime || record.spec?.runtime || { type: 'dsh-native' } };
    if (patch.bindings) record.bindings = { ...record.bindings, ...patch.bindings };
    record.metadata.revision = (Number(record.metadata.revision) || 1) + 1;
    record.metadata.updatedAt = new Date().toISOString();
    const target = pathFor(agentId);
    const tmp = `${target}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(tmp, JSON.stringify(record, null, 2));
    await rename(tmp, target);
    return record;
  }

  async function remove(agentId) {
    await ensureDir();
    await rm(pathFor(agentId), { force: true });
    return { agentId, deleted: true };
  }

  return { create, list, get, update, remove, root };
}
