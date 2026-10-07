/** Local Studio Agent store for the plugin Node host.
 *
 * The legacy Studio Host persisted locally-authored AgentDrafts; this store
 * restores that contract: conversation authoring writes an Agent here, the
 * Agents list merges local rows with cloud Agents, and local builds package
 * them. Shape matches the browser's `{ metadata, spec, bindings }` contract.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, rm, rename, link } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export class AgentStoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AgentStoreError';
    this.code = code;
    this.details = details;
  }
}

function resourceId(value) { return String(value?.resourceId || value?.id || value || '').trim(); }

function looksLikeCloudSkillSpace(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(resourceId(value));
}

/** Migrate the pre-platform-picker shape without changing local Skill IDs. */
export function normalizeAgentBindings(bindings = {}) {
  const source = bindings && typeof bindings === 'object' ? bindings : {};
  const plugins = Array.isArray(source.plugins) ? [...source.plugins] : [];
  const hasSkillSpace = plugins.some(item => item?.config?.binding?.resource?.kind === 'skill-space');
  const skills = [];
  for (const value of Array.isArray(source.skills) ? source.skills : []) {
    if (looksLikeCloudSkillSpace(value)) {
      if (!hasSkillSpace) plugins.push({
        ecosystem: 'dsh', pluginRef: '@kingsoftcloud/agentkit-studio/platform-resources', enabled: true,
        config: { schemaVersion: 1, selectionMode: 'discovery', executionMode: 'outer-agent', binding: { id: 'platform-skill-space', resource: { kind: 'skill-space', id: resourceId(value), required: true } } },
      });
    } else skills.push(value);
  }
  return { ...source, skills, plugins };
}

function normalizeRecord(record) {
  if (!record || typeof record !== 'object') return record;
  const bindings = normalizeAgentBindings(record.spec?.bindings || record.bindings || {});
  return { ...record, spec: { ...(record.spec || {}), bindings }, bindings };
}

export function createAgentStore({ storeDir } = {}) {
  const root = storeDir;

  async function ensureDir() { await mkdir(root, { recursive: true, mode: 0o700 }); }

  function pathFor(agentId) {
    if (!/^ar-local-[a-f0-9]{16}$/.test(agentId)) throw new AgentStoreError('INVALID_AGENT_ID', '本地 Agent ID 无效');
    return join(root, `${agentId}.json`);
  }

  function revisionPath(agentId, revision) {
    pathFor(agentId);
    if (!Number.isSafeInteger(revision) || revision < 1) throw new AgentStoreError('INVALID_AGENT_REVISION','Agent Revision 无效');
    return join(root,'revisions',agentId,`${revision}.json`);
  }

  async function captureRevision(value) {
    const normalized = normalizeRecord(value);
    const record = JSON.parse(JSON.stringify({metadata:normalized.metadata,spec:normalized.spec,bindings:normalized.bindings}));
    const path = revisionPath(record.metadata.id,Number(record.metadata.revision));
    await mkdir(dirname(path),{recursive:true,mode:0o700});
    const temporary = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(temporary,JSON.stringify(record,null,2),{flag:'wx',mode:0o600}); await link(temporary,path); }
    catch(error) {
      if(error.code!=='EEXIST') throw error;
      if(!isDeepStrictEqual(JSON.parse(await readFile(path,'utf8')),record)) throw new AgentStoreError('AGENT_REVISION_CONFLICT','已保存的 Agent Revision 不能被覆盖');
    } finally { await rm(temporary,{force:true}); }
    return record;
  }

  async function getRevision(agentId, revision) {
    try { return normalizeRecord(JSON.parse(await readFile(revisionPath(agentId,Number(revision)),'utf8'))); }
    catch(error) { if(error.code==='ENOENT') return null; throw error; }
  }

  async function listRevisions(agentId) {
    const dir = dirname(revisionPath(agentId,1));
    const names = await readdir(dir).catch(error=>{if(error.code==='ENOENT') return [];throw error;});
    const revisions = [];
    for(const name of names.filter(name=>/^[1-9][0-9]*\.json$/.test(name)).sort((a,b)=>parseInt(a)-parseInt(b))) revisions.push(await getRevision(agentId,parseInt(name)));
    return revisions.filter(Boolean);
  }

  async function create({ name, runtimeType = 'dsh-native', description = '', spec = {}, bindings = {} }) {
    await ensureDir();
    const agentId = `ar-local-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const normalizedBindings = normalizeAgentBindings(spec.bindings ?? bindings);
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
      spec: { ...spec, bindings: normalizedBindings, runtime: { type: runtimeType } },
      bindings: normalizedBindings,
    };
    const target = pathFor(agentId);
    await captureRevision(record);
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
        const record = normalizeRecord(JSON.parse(await readFile(join(root, name), 'utf8')));
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
    try { return normalizeRecord(JSON.parse(await readFile(pathFor(agentId), 'utf8'))); } catch { return null; }
  }

  async function update(agentId, patch = {}) {
    const record = await get(agentId);
    if (!record) throw new AgentStoreError('AGENT_NOT_FOUND', '本地 Agent 不存在', { agentId });
    await captureRevision(record);
    if (patch.name) record.metadata.name = String(patch.name);
    if (patch.description !== undefined) record.metadata.description = String(patch.description);
    if (patch.spec) record.spec = { ...record.spec, ...patch.spec, runtime: patch.spec?.runtime || record.spec?.runtime || { type: 'dsh-native' } };
    if (patch.bindings) record.bindings = { ...record.bindings, ...patch.bindings };
    if (patch.spec?.bindings) record.bindings = patch.spec.bindings;
    else if (patch.bindings) record.spec.bindings = record.bindings;
    const normalized = normalizeAgentBindings(record.spec.bindings || record.bindings || {});
    record.spec.bindings = normalized;
    record.bindings = normalized;
    record.metadata.revision = (Number(record.metadata.revision) || 1) + 1;
    record.metadata.updatedAt = new Date().toISOString();
    await captureRevision(record);
    const target = pathFor(agentId);
    const tmp = `${target}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(tmp, JSON.stringify(record, null, 2));
    await rename(tmp, target);
    return record;
  }

  async function remove(agentId) {
    await ensureDir();
    await rm(pathFor(agentId), { force: true });
    await rm(dirname(revisionPath(agentId,1)),{recursive:true,force:true});
    return { agentId, deleted: true };
  }

  return { create, list, get, update, remove, captureRevision, getRevision, listRevisions, root };
}
