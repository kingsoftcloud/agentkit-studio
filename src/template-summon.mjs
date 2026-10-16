/** One-click authoring orchestrator; the Agent store, resource bindings and native Session stay unchanged. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { platformBinding } from './platform-resource-bindings.mjs';
const fail = (code, message) => { throw Object.assign(new Error(message), { code, status: 409 }); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function createTemplateSummon({ catalog, authoring, store, dependencies, models, resources, platformResources, operationDir }) {
  const pending = new Map();
  async function plan(payload = {}) {
    await catalog.ensure?.(payload.ref, 'agent', {signal:payload.signal});
    const item = catalog.get(payload.ref), runtimeType = payload.runtimeType || item.spec.runtime.type;
    if (item.availability?.state === 'blocked') fail('TEMPLATE_DEPENDENCIES_INCOMPLETE', item.availability.reasons.join('；'));
    if (!item.runtimes.includes(runtimeType)) fail('TEMPLATE_RUNTIME_UNSUPPORTED', '模板不支持所选运行时');
    const modelCatalog = await resources('model', runtimeType), selected = payload.bindings || {};
    let defaultId = '';
    try { const profile = await models.profile(''); defaultId = modelCatalog.items.some(row => (row.resourceId || row.id) === profile.id) ? profile.id : profile.modelName; } catch { /* show the model selector below */ }
    const modelId = selected.modelId || defaultId, missing = [], catalogs = {};
    if (!modelId || !modelCatalog.items.some(row => (row.resourceId || row.id) === modelId && row.disabled !== true && row.status !== 'credential-missing')) missing.push({ kind: 'model', label: '选择可用模型' });
    const choosePlatform = payload.configure || item.requirements.some(req => req.required && ['knowledge-base', 'memory-instance'].includes(req.kind)) || selected['knowledge-base'] || selected['memory-instance'];
    for (const kind of ['knowledge-base', 'memory-instance']) {
      const required = item.requirements.some(req => req.kind === kind && req.required);
      if (choosePlatform) {
        catalogs[kind] = await platformResources(kind);
        if ((required || selected[kind]) && !catalogs[kind].items.some(row => row.id === selected[kind] && !row.disabled)) missing.push({ kind, label: kind === 'knowledge-base' ? '选择知识库' : '选择记忆库' });
      }
    }
    const mcp = await dependencies.resolveMcp(item);
    // Public unauthenticated MCPs can be materialized by summon; no silent OAuth or account migration.
    missing.push(...mcp.missing.filter(value => !item.dependencies.mcp.find(row => row.key === value.key)?.autoInstall));
    return { ref: { id: item.id, version: item.version, digest: item.digest }, name: item.name, runtimeType, runtimes: item.runtimes,
      modelId, models: modelCatalog.items.map(row => ({ id: row.resourceId || row.id, name: row.name, disabled: row.disabled || row.status === 'credential-missing' })),
      bindings: selected, catalogs, missing, requirements: item.requirements,
      dependencies: { skills: (item.dependencies?.skills?.length || 0) + (item.dependencies?.additional || []).reduce((sum, group) => sum + (group.skills?.length || 0), 0), mcp: item.dependencies?.mcp?.length || 0 } };
  }
  async function execute(payload) {
    const key = String(payload.requestId || '');
    if (!/^[a-zA-Z0-9-]{16,80}$/.test(key)) fail('SUMMON_REQUEST_INVALID', '召唤请求缺少有效标识');
    const operationKey = hash(key), file = join(operationDir, `${operationKey}.json`);
    const fingerprint = hash({ ref: payload.ref, bindings: payload.bindings || {}, runtimeType: payload.runtimeType || '', task: payload.task || '' });
    let saved;
    try { saved = JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (saved && saved.fingerprint !== fingerprint) fail('SUMMON_REQUEST_CONFLICT', '同一召唤请求不能更换模板或资源');
    if (saved) {
      const previous = saved.agentId ? await store.get(saved.agentId) : (await store.list()).find(row => row.metadata.creationKey === operationKey);
      if (previous) return { status: 'created', agent: previous, reused: true };
      if (saved.state === 'creating') fail('SUMMON_RECONCILE_REQUIRED', '此前召唤结果尚待核对，请到我的智能体检查；未自动重复创建');
    }
    await catalog.ensure?.(payload.ref, 'agent', {signal:payload.signal});
    const template = catalog.get(payload.ref), chosen = payload.bindings || {};
    if (template.availability?.state === 'blocked') fail('TEMPLATE_DEPENDENCIES_INCOMPLETE', template.availability.reasons.join('；'));
    const existing = (await store.list()).find(row => {
      const source = row.metadata.templateSource, bindings = row.spec.bindings || {};
      return row.metadata.creationKey && source?.id === template.id && source.digest === template.digest
        && (!payload.runtimeType || row.spec.runtime.type === payload.runtimeType)
        && (!payload.task || row.spec.instructions.task === payload.task)
        && (!chosen.modelId || bindings.modelProfileId === chosen.modelId)
        && ['knowledge-base', 'memory-instance'].every(kind => !Object.hasOwn(chosen, kind)
          || (bindings.plugins?.find(plugin => plugin.config?.binding?.resource?.kind === kind)?.config.binding.resource.id || '') === chosen[kind]);
    });
    // Summon is an installation/open action. Custom edits remain the user's Agent;
    // the existing full authoring form is the explicit way to create another copy.
    if (existing) return { status: 'created', agent: existing, reused: true };
    payload.onProgress?.({phase:'checking',label:'正在检查模型与资源绑定'});
    const current = await plan(payload);
    if (current.missing.length) return { status: 'needs-input', plan: current };
    const item = catalog.get(current.ref), draft = catalog.prepare(current.ref), bindings = payload.bindings || {};
    const skills = await dependencies.materialize(item, {signal:payload.signal,onProgress:payload.onProgress});
    payload.signal?.throwIfAborted(); payload.onProgress?.({phase:'checking-mcp',label:'正在检查 MCP 连接'});
    const mcp = await dependencies.resolveMcp(item, { install: true });
    if (mcp.missing.length) fail('TEMPLATE_MCP_UNAVAILABLE', '此专家的 MCP 尚未连接成功，请在资源库中配置并探测后重试');
    draft.spec.bindings = { ...draft.spec.bindings, modelProfileId: current.modelId, modelProfileIds: [current.modelId],
      skills: skills.map(row => row.resourceId), mcpServers: mcp.ids, plugins: [] };
    for (const kind of ['knowledge-base', 'memory-instance']) if (bindings[kind]) draft.spec.bindings.plugins.push(platformBinding(kind, bindings[kind], current.catalogs[kind]));
    draft.spec.memory = { ...draft.spec.memory, enabled: Boolean(bindings['memory-instance']), recall: { enabled: Boolean(bindings['memory-instance']) }, write: { mode: 'explicit_only' } };
    if (payload.task) draft.spec.instructions.task = String(payload.task);
    await mkdir(operationDir, { recursive: true, mode: 0o700 });
    async function save(value) { const temporary = `${file}.${randomUUID()}.tmp`; await writeFile(temporary, JSON.stringify(value), { mode: 0o600 }); await rename(temporary, file); }
    payload.signal?.throwIfAborted(); payload.onProgress?.({phase:'creating',label:'正在创建专家',cancellable:false});
    await save({ fingerprint, state: 'creating' });
    try {
      const agent = await authoring.create({ ...draft, runtimeType: current.runtimeType, creationKey: operationKey });
      await save({ fingerprint, state: 'created', agentId: agent.metadata.id });
      return { status: 'created', agent, reused: false };
    } catch (error) {
      const created = (await store.list()).find(row => row.metadata.creationKey === operationKey);
      if (created) { await save({ fingerprint, state: 'created', agentId: created.metadata.id }); return { status: 'created', agent: created, reused: true }; }
      await save({ fingerprint, state: 'failed' }); throw error;
    }
  }
  return { plan, async list() {
    const mine = (await store.list()).filter(row => row.metadata.creationKey), directory = await catalog.list();
    return { ...directory, items: directory.items.map(item => {
      const instance = mine.find(row => row.metadata.templateSource?.id === item.id && row.metadata.templateSource?.digest === item.digest);
      return instance ? { ...item, instantiated: { agentId: instance.metadata.id, name: instance.metadata.name } } : item;
    }) };
  }, summon(payload = {}) {
    const key = String(payload.requestId || ''), fingerprint = hash(payload);
    if (pending.has(key)) {
      if (pending.get(key).fingerprint !== fingerprint) return Promise.reject(Object.assign(new Error('召唤正在进行，请勿更改请求'), { code: 'SUMMON_REQUEST_CONFLICT' }));
      return pending.get(key).promise;
    }
    const promise = execute(payload).finally(() => pending.delete(key)); pending.set(key, { fingerprint, promise }); return promise;
  } };
}
