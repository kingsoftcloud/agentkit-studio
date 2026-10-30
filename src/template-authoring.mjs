/** Templates enter the same Agent store and creation contract as ordinary Agents. */
import { platformBinding } from './platform-resource-bindings.mjs';
import { nativeAgentPolicyFromSpec, NATIVE_AGENT_POLICY_CONTRACT } from './native-agent-policy.mjs';
const fail = (code, message) => { throw Object.assign(new Error(message), { code, status: 400 }); };
const idOf = value => typeof value === 'string' ? value : value?.resourceId;
export function createTemplateAuthoring({ catalog, store, resources, platformResources, dependencies }) {
  return {
    prepare: ref => catalog.prepare(ref),
    async create(payload = {}) {
      const ref = payload.templateSource;
      if (!ref) return store.create(payload);
      await catalog.ensure?.(ref);
      if (ref.catalog !== 'studio-builtin' || !ref.version || !ref.digest) fail('TEMPLATE_SOURCE_INVALID', '模板来源无效，请重新选择模板');
      const item = catalog.get(ref), spec = structuredClone(payload.spec || {}), bindings = spec.bindings || {};
      if (item.availability?.state === 'blocked') fail('TEMPLATE_DEPENDENCIES_INCOMPLETE', item.availability.reasons.join('；'));
      const runtimeType = payload.runtimeType || spec.runtime?.type;
      if (!item.runtimes.includes(runtimeType)) fail('TEMPLATE_RUNTIME_UNSUPPORTED', '模板不支持所选运行时');
      if (!payload.name?.trim() || !spec.instructions?.system?.trim()) fail('AGENT_DEFINITION_REQUIRED', '请填写名称和角色指令');
      if (item.dependencies && !dependencies) fail('TEMPLATE_DEPENDENCIES_UNAVAILABLE', '模板依赖安装服务尚未就绪');
      if (item.dependencies) await dependencies.validate(item, bindings);
      const modelIds = [...new Set([bindings.modelProfileId, ...(bindings.modelProfileIds || []).map(idOf)].filter(Boolean))];
      if (!modelIds.length) fail('TEMPLATE_MODEL_REQUIRED', '请选择当前运行时可用的模型');
      for (const [kind, ids] of [['model', modelIds], ['mcp', (bindings.mcpServers || []).map(idOf)], ['skill', (bindings.skills || []).map(idOf)], ['tool', (bindings.tools || []).map(idOf)]]) {
        if (!ids.length) continue;
        if (kind === 'tool' && runtimeType === 'dsh-native') fail('TEMPLATE_RESOURCE_UNSUPPORTED', 'DSH Native 不支持此类 Tool 绑定');
        const result = await resources(kind, runtimeType);
        const available = new Set(result.items.filter(row => row.disabled !== true).map(row => row.resourceId || row.id));
        if (ids.some(id => !id || !available.has(id))) fail('TEMPLATE_RESOURCE_UNAVAILABLE', `所选 ${kind} 资源已不可用，请刷新后重新选择`);
      }
      const plugins = [];
      const seen = new Set();
      for (const binding of bindings.plugins || []) {
        const resource = binding?.config?.binding?.resource;
        if (!resource?.kind || seen.has(resource.kind) || binding.enabled === false) fail('TEMPLATE_BINDING_INVALID', '平台资源绑定无效或重复');
        seen.add(resource.kind);
        plugins.push(platformBinding(resource.kind, resource.id, await platformResources(resource.kind)));
      }
      const hasMemory = seen.has('memory-instance'), enabled = spec.memory?.enabled === true;
      // The local Native provider (harness + local-default, no cloud binding)
      // allows write.mode 'off' whether memory is enabled or disabled — it is a
      // property of the provider, not of the enabled flag.
      const localProvider = spec.memory?.providerRef === 'local-default' && runtimeType === 'harness' && !hasMemory;
      // Only ENABLED local memory satisfies a template's memory-instance
      // requirement; disabled local memory must not bypass that binding.
      const usesLocalDefault = enabled && localProvider;
      for (const required of item.requirements.filter(value => value.required)) {
        const counts = { model: modelIds.length, mcp: bindings.mcpServers?.length || 0, skill: bindings.skills?.length || 0, tool: bindings.tools?.length || 0 };
        // A harness local-default Agent satisfies a memory-instance requirement
        // through the local store, not a cloud binding.
        if (required.kind === 'memory-instance' && usesLocalDefault) continue;
        if (!seen.has(required.kind) && !(counts[required.kind] >= (required.count || 1))) fail('TEMPLATE_BINDING_REQUIRED', required.label || `请绑定 ${required.kind} 资源`);
      }
      if (enabled && !hasMemory && !usesLocalDefault) fail('TEMPLATE_MEMORY_REQUIRED', '启用长期记忆前请选择记忆库');
      const mode = spec.memory?.write?.mode || 'explicit_only';
      const validWriteModes = localProvider ? ['off', 'explicit_only', 'candidate'] : ['candidate', 'explicit_only'];
      if (!validWriteModes.includes(mode)) fail('TEMPLATE_MEMORY_POLICY_INVALID', '记忆写入策略无效');
      spec.bindings = { ...bindings, modelProfileIds: modelIds, plugins };
      if (runtimeType === 'harness') {
        const bound = nativeAgentPolicyFromSpec(spec) ?? { contract: NATIVE_AGENT_POLICY_CONTRACT, mode: 'strict', rules: {} };
        spec.bindings.nativeAgentPolicy = bound;
        spec.bindings.policyTemplate = bound.mode;
      }
      // Disabled memory preserves the original block exactly (only the enabled
      // flag is normalized to false); enabled memory normalizes providerRef,
      // recall and write.mode. An explicit scopes:[] and an independent
      // recall.enabled survive in both branches.
      spec.memory = enabled
        ? { ...spec.memory, enabled,
            providerRef: hasMemory ? 'binding://platform-memory-instance' : (spec.memory?.providerRef ?? 'local-default'),
            recall: { ...spec.memory?.recall, enabled: spec.memory?.recall?.enabled ?? true }, write: { ...spec.memory?.write, mode } }
        : { ...spec.memory, enabled: false };
      spec.security = { toolPolicy: 'deny-by-default', allowedPermissions: runtimeType === 'harness'
        ? ['process:host-user', ...((bindings.mcpServers || []).length ? ['network:mcp'] : [])] : [] };
      const catalogId = catalog.prepare(ref).templateSource.catalogId;
      return store.create({ ...payload, runtimeType, spec, templateSource: { catalog: ref.catalog, ...(catalogId ? { catalogId } : {}), id: item.id, version: item.version, digest: item.digest } });
    },
  };
}
