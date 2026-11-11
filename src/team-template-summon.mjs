/** Save a team blueprint without materializing one ordinary Agent per role. */
import { createHash } from 'node:crypto';
import { paginateResources } from './resource-catalog.mjs';
import { platformBinding } from './platform-resource-bindings.mjs';
import { validateTeamRoleSpec, validateTeamTemplate } from './team-template-contract.mjs';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const nativeRuntimes = new Set(['dsh-native', 'harness']);

export function createTeamTemplateSummon({ catalog, summon, teams }) {
  async function definition(ref, options = {}) {
    await catalog.ensure?.(ref, 'team', options);
    const item = catalog.isRemote ? catalog.get(ref) : (catalog.resource?.(ref) || catalog.get(ref));
    return validateTeamTemplate(item);
  }

  const roleRef = (role, ref) => ({ ...role.template, catalogId: role.template.catalogId || ref.catalogId });

  async function blueprint(item, role, ref, plan) {
    const sourceRef = roleRef(role, ref);
    const prepared = catalog.prepare(sourceRef);
    const runtimeType = String(plan?.runtimeType || prepared.spec?.runtime?.type || '').trim();
    if (!nativeRuntimes.has(runtimeType)) fail('TEAM_TEMPLATE_RUNTIME_UNSUPPORTED', '角色「' + (role.label || role.name) + '」必须使用 DSH Native 或 Harness');
    const spec = { ...structuredClone(prepared.spec || {}), runtime: { ...(prepared.spec?.runtime || {}), type: runtimeType } };
    validateTeamRoleSpec(spec, role.name);
    const installed = await summon.prepareDependencies(sourceRef, { signal: plan?.signal, onProgress: plan?.onProgress });
    spec.bindings = {
      ...spec.bindings,
      modelProfileId: plan.modelId,
      modelProfileIds: [plan.modelId],
      skills: installed.skills.map(row => row.resourceId || row.id),
      mcpServers: installed.mcp.ids,
    };
    const memoryEnabled = Boolean(plan.bindings?.['memory-instance']);
    spec.memory = { ...spec.memory, enabled: memoryEnabled, recall: { enabled: memoryEnabled }, write: { mode: 'explicit_only' } };
    for (const kind of ['knowledge-base', 'memory-instance']) if (plan?.bindings?.[kind] && plan.catalogs?.[kind]) {
      spec.bindings.plugins = [...(spec.bindings.plugins || []), platformBinding(kind, plan.bindings[kind], plan.catalogs[kind])];
    }
    const source = {
      kind: 'template',
      catalog: prepared.templateSource?.catalog || 'studio-builtin',
      ...(prepared.templateSource?.catalogId || sourceRef.catalogId ? { catalogId: prepared.templateSource?.catalogId || sourceRef.catalogId } : {}),
      id: prepared.templateSource?.id || sourceRef.id,
      version: prepared.templateSource?.version || prepared.version || item.version,
      digest: prepared.templateSource?.digest || sourceRef.digest,
    };
    const agentPreset = String(role.agentPreset || role.agentPresetId || '').trim();
    return {
      name: role.name,
      label: role.label || role.name,
      instructions: role.instructions || '',
      source,
      spec,
      bindings: { ...(plan?.bindings || {}), ...(plan?.modelId ? { modelId: plan.modelId } : {}) },
      ...(agentPreset ? { agentPreset } : {}),
    };
  }

  function roleBindings(role, bindings, item) {
    const model = role.model || role.modelId || role.modelProfileId || item.defaultModel || item.model;
    return {
      ...(model ? { modelId: model } : {}),
      ...(bindings || {}),
      ...(role.bindings && typeof role.bindings === 'object' ? role.bindings : {}),
    };
  }

  return {
    async list(query = {}) {
      return catalog.listResources
        ? catalog.listResources({ ...query, kind: 'team' })
        : paginateResources((catalog.resources?.() || []).filter(row => row.kind === 'team'), query, { source: 'personal-catalog' });
    },

    async detail(ref) { return definition(ref); },

    async summon(payload) {
      if (!/^[a-zA-Z0-9-]{16,80}$/.test(payload.requestId || '')) fail('TEAM_REQUEST_INVALID', '召唤请求标识无效');
      const item = await definition(payload.ref, { signal: payload.signal });
      const bindings = payload.bindings || {};
      const known = (await teams.list()).items.find(row => row.templateSource?.id === item.id
        && row.templateSource.digest === item.digest
        && JSON.stringify(row.templateSource.bindings || {}) === JSON.stringify(bindings));
      if (known) return { status: 'created', team: known, reused: true };

      // Check every role before persisting the blueprint. A missing dependency
      // must never leave a half-installed TeamDefinition.
      const plans = [];
      for (const role of item.roles) {
        payload.signal?.throwIfAborted();
        payload.onProgress?.({ phase: 'checking', label: `正在检查${role.label}的模型与依赖` });
        const plan = await summon.plan({ ref: roleRef(role, payload.ref), bindings: roleBindings(role, bindings, item) });
        if (plan.missing.length) return { status: 'needs-input', role: role.label, plan };
        plans.push(plan);
      }

      const roles = [];
      for (let index = 0; index < item.roles.length; index++) {
        payload.signal?.throwIfAborted();
        const role = item.roles[index];
        roles.push(await blueprint(item, role, payload.ref, {
          ...plans[index],
          bindings: roleBindings(role, bindings, item),
          signal: payload.signal,
          onProgress: payload.onProgress,
        }));
        payload.onProgress?.({ phase: 'blueprint', label: `${index + 1}/${item.roles.length} ${item.roles[index].label} · 已保存角色蓝图` });
      }

      const id = `team-${createHash('sha256').update(JSON.stringify({ id: item.id, digest: item.digest, bindings })).digest('hex').slice(0, 24)}`;
      const team = await teams.save({
        id,
        runtime: 'dsh-native-team',
        name: item.name,
        description: item.description,
        instructions: item.instructions,
        lead: roles[0],
        members: roles.slice(1),
        templateSource: {
          id: item.id,
          digest: item.digest,
          version: item.version,
          artwork: item.artwork ? { ...item.artwork, available: true } : undefined,
          bindings,
        },
      });
      return { status: 'created', team, reused: false };
    },
  };
}
