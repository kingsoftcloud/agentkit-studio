import { createHash } from 'node:crypto';
import { seed } from './seed.mjs';
const clone = value => structuredClone(value);
const fail = (code, message) => { throw Object.assign(new Error(message), { code, status: 400 }); };
export const TEMPLATE_CONTRACT = 'agentkit.studio.templates/v1';
export function validateCatalog(source) {
  if (source?.schemaVersion !== 1 || !source.revision || !Array.isArray(source.categories) || !Array.isArray(source.items)) fail('TEMPLATE_CATALOG_INVALID', '模板目录版本或结构无效');
  const categories = new Set(source.categories.map(item => item.id));
  const ids = new Set();
  for (const item of source.items) {
    if (ids.has(item.id)) fail('TEMPLATE_DUPLICATE', '模板 ID 重复');
    ids.add(item.id);
    if (!/^[a-z][a-z0-9-]*$/.test(item.id) || !/^\d+\.\d+\.\d+$/.test(item.version) || item.kind !== 'agent'
      || !item.name || !item.description || !categories.has(item.categoryId) || !item.deliverable || !item.origin?.type
      || !Array.isArray(item.tags) || !Array.isArray(item.examples) || item.examples.length < 2
      || !item.spec?.instructions?.system || !Array.isArray(item.runtimes) || !item.runtimes.length
      || item.runtimes.some(type => !['dsh-native', 'harness', 'codex'].includes(type)) || !item.runtimes.includes(item.spec.runtime?.type)
      || !Array.isArray(item.requirements)) fail('TEMPLATE_DEFINITION_INVALID', `模板定义不完整：${item.id || '(无 ID)'}`);
    const bindings = item.spec.bindings || {};
    if (Object.keys(bindings).some(key => !['tools', 'mcpServers', 'skills', 'plugins', 'policyTemplate'].includes(key))
      || ['tools', 'mcpServers', 'skills', 'plugins'].some(key => (bindings[key]?.length || 0) > 0)
      || item.spec.memory?.providerRef) fail('TEMPLATE_PRIVATE_BINDING', '公共模板不能包含环境专属资源引用');
    if (item.requirements.some(req => !['model', 'tool', 'mcp', 'skill', 'knowledge-base', 'memory-instance', 'skill-space'].includes(req.kind))) fail('TEMPLATE_RESOURCE_UNSUPPORTED', '模板包含未支持的资源需求');
  }
  return source;
}
export function createExpertCatalog(source = seed, { assetRoot } = {}) {
  source = clone(validateCatalog(source));
  const items = source.items.map(item => ({ ...clone(item), digest: `sha256:${createHash('sha256').update(JSON.stringify(item)).digest('hex')}` }));
  const byId = new Map(items.map(item => [item.id, item]));
  const resourceItems = (source.resources || []).map(item => ({ ...clone(item), digest: `sha256:${createHash('sha256').update(JSON.stringify(item)).digest('hex')}` }));
  const byResourceId = new Map(resourceItems.map(item => [item.id, item]));
  function resource(ref) {
    const item = byResourceId.get(typeof ref === 'string' ? ref : ref?.id);
    if (!item || (ref?.digest && ref.digest !== item.digest)) fail('TEMPLATE_RESOURCE_VERSION_UNAVAILABLE', '目录资源已变化，请刷新后重试');
    return clone(item);
  }
  function assetDependencies(value = {}) {
    return { ...value, ...(value.package ? { package: { ...source.packages?.[value.package.digest], ...value.package } } : {}),
      additional: (value.additional || []).map(assetDependencies) };
  }
  if (byId.size !== items.length) fail('TEMPLATE_DUPLICATE', '模板 ID 重复');
  function get(ref) {
    const item = byId.get(typeof ref === 'string' ? ref : ref?.id);
    if (!item || (ref?.version && item.version !== ref.version) || (ref?.digest && item.digest !== ref.digest)) fail('TEMPLATE_VERSION_UNAVAILABLE', '模板版本已变化，请重新选择模板');
    return clone(item);
  }
  function prepare(ref) {
    const item = get(ref);
    return { name: item.name, description: item.description, spec: item.spec, requirements: item.requirements,
      runtimes: item.runtimes, examples: item.examples,
      templateSource: { catalog: 'studio-builtin', id: item.id, version: item.version, digest: item.digest } };
  }
  return {
    contract: TEMPLATE_CONTRACT,
    list() { return { contract: TEMPLATE_CONTRACT, revision: source.revision, source: 'bundled', categories: clone(source.categories), items: items.map(item => {
      const value = clone(item);
      if (value.artwork) value.artwork = { available: true };
      if (value.dependencies) value.dependencies = { skills: [ ...(value.dependencies.skills || []), ...(value.dependencies.additional || []).flatMap(group => group.skills || []) ].map(({ path, files, ...metadata }) => metadata), mcp: value.dependencies.mcp || [] };
      return value;
    }) }; },
    get, prepare, resource,
    resources: () => resourceItems.map(({ dependencies, ...item }) => clone(item)),
    assets: ref => ({ root: assetRoot, dependencies: assetDependencies((byResourceId.has(typeof ref === 'string' ? ref : ref?.id) ? resource(ref) : get(ref)).dependencies || { skills: [], mcp: [] }) }),
  };
}

/** P0 authoring export: public content never retains author identity or bindings. */
export function exportTemplateDefinition(record) {
  const spec = record?.spec;
  if (!spec?.instructions?.system || !['dsh-native', 'harness', 'codex'].includes(spec.runtime?.type)) fail('TEMPLATE_DEFINITION_INVALID', '请选择有效的 Agent Revision');
  const resourceRequirements = [];
  const modelIds = [...new Set([spec.bindings?.modelProfileId, ...(spec.bindings?.modelProfileIds || [])].filter(Boolean))];
  for (const [kind, values] of [['model', modelIds], ['tool', spec.bindings?.tools || []], ['mcp', spec.bindings?.mcpServers || []], ['skill', spec.bindings?.skills || []]]) {
    if (values.length) resourceRequirements.push({ kind, required: true, count: values.length });
  }
  for (const binding of spec.bindings?.plugins || []) {
    const kind = binding?.config?.binding?.resource?.kind;
    if (binding.enabled !== false && !['knowledge-base', 'memory-instance', 'skill-space'].includes(kind)) fail('TEMPLATE_RESOURCE_UNSUPPORTED', '此 Agent 包含尚不能转换为模板的插件，请先整理其依赖');
    if (['knowledge-base', 'memory-instance', 'skill-space'].includes(kind) && binding.enabled !== false) resourceRequirements.push({ kind, required: true });
  }
  return { name: String(record.metadata?.name || ''), description: String(spec.description || ''), requirements: resourceRequirements,
    spec: { runtime: { type: spec.runtime.type }, instructions: { system: String(spec.instructions.system), task: String(spec.instructions.task || '') },
      bindings: { tools: [], mcpServers: [], skills: [], plugins: [], policyTemplate: 'strict' },
      memory: { enabled: spec.memory?.enabled === true, recall: { enabled: spec.memory?.recall?.enabled === true }, write: { mode: spec.memory?.write?.mode === 'candidate' ? 'candidate' : 'explicit_only' } } } };
}
