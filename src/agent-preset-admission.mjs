/**
 * The narrow bridge between a Studio AgentRevision and the public DSH
 * agent-preset registry.
 *
 * This module admits a dsh-native revision only when its model is the active
 * DSH route. Studio tool/MCP/Skill/platform bindings are not DSH Cordis
 * declarations, so silently putting them in an empty preset would produce a
 * successful looking chat that runs the wrong composition. Those resource
 * bindings are routed through the Studio DSH provider bridge, which keeps the
 * native Session UI while delegating runtime work to Studio. The explicit
 * Native contract replaces the whole turn; legacy bindings retain the loop.
 */
import { NATIVE_DSH_TURN_CONTRACT } from '../packages/agentkit-harness/src/native/dsh-turn-contract.mjs';
import { selectedNativeBuildContract } from './build-engine.mjs';
import { nativeChildRoles } from './providers/native-subagents.mjs';
import { dshComponentBindings } from './providers/dsh-component-bindings.mjs';
import { knowledgeBindings } from './knowledge-tools.mjs';

function encodedId(value) {
  return encodeURIComponent(String(value))
    .replace(/%/g, '_')
    .replace(/[^A-Za-z0-9_.-]/g, '_')
    .slice(0, 180) || 'unknown';
}

function bindingValueCount(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value).length;
  return value ? 1 : 0;
}

function modelProfileIds(agent = {}) {
  const bindings = agent?.spec?.bindings && typeof agent.spec.bindings === 'object'
    ? agent.spec.bindings : {};
  const values = Array.isArray(bindings.modelProfileIds)
    ? bindings.modelProfileIds
    : bindings.modelProfileId ? [bindings.modelProfileId] : [];
  return [...new Set([bindings.modelProfileId, ...values.map(value => typeof value === 'string' ? value : value?.resourceId)].filter(Boolean).map(String))];
}

export function dshModelRoute(profile = {}, index = 0) {
  const provider = String(profile?.provider || 'ksyun').trim() || 'ksyun';
  const model = String(profile?.modelName || '').trim() || `model-${index + 1}`;
  const id = String(profile?.id || `${provider}:${model}`).trim();
  return `agentkit-studio-${id.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.slice(0, 64);
}

/**
 * Resolve the Agent's primary bound model to the exact DSH route published by
 * the Studio model bridge. An Agent may advertise fallback models, but a DSH
 * Session still needs one deterministic initial route; the first binding is
 * the persisted primary (`modelProfileId`) and users can switch afterward.
 */
export function dshModelSelection(agent = {}, settings = {}, { resolvedProfile } = {}) {
  const ids = modelProfileIds(agent);
  if (!ids.length) return undefined;
  const profiles = Array.isArray(settings?.values?.modelProfiles) ? settings.values.modelProfiles : [];
  const bound = String(ids[0]).trim();
  const index = profiles.findIndex(profile => profile?.enabled !== false && (String(profile?.id || '').trim() === bound || String(profile?.modelName || '').trim() === bound || (resolvedProfile?.id && profile.id === resolvedProfile.id)));
  const profile = index >= 0 ? profiles[index] : undefined;
  if (!profile?.modelName || profile.enabled === false) return undefined;
  return { provider: dshModelRoute(profile, index), model: String(resolvedProfile?.modelName || profile.modelName).trim() };
}

function toolBindingRefs(agent = {}) {
  const bindings = agent?.spec?.bindings && typeof agent.spec.bindings === 'object'
    ? agent.spec.bindings : {};
  const values = Array.isArray(bindings.tools) ? bindings.tools : [];
  return values.map(value => {
    if (typeof value === 'string') return value;
    return value?.resourceId || value?.id || value?.name || '';
  }).filter(Boolean).map(String);
}

function modelProfileMatchesActiveRoute(profileId, activeModel) {
  const configured = String(activeModel?.values?.modelName || activeModel?.values?.model || '').trim().toLowerCase();
  if (!configured) return false;
  const candidate = String(profileId || '').trim().toLowerCase();
  if (!candidate) return false;
  // AgentEngine model resources are namespaced (for example
  // model:provider:deepseek-v4-flash:live). DSH's native loop has one active
  // provider route, so only an exact model-id match is safe to admit.
  return candidate === configured || candidate.split(':').some(part => part === configured);
}

/**
 * Return the references that the current empty-preset provider cannot apply.
 * @param {object} agent - normalized AgentEngine Agent detail
 */
export function unsupportedDshBindings(agent = {}, { activeModel } = {}) {
  const spec = agent.spec && typeof agent.spec === 'object' ? agent.spec : {};
  const bindings = spec.bindings && typeof spec.bindings === 'object' ? spec.bindings : {};
  const refs = [];
  const profiles = modelProfileIds(agent);
  if (profiles.length > 1 || (profiles.length === 1 && !modelProfileMatchesActiveRoute(profiles[0], activeModel))) {
    refs.push('model');
  }
  for (const [key, label] of [
    ['tools', 'tool'],
    ['mcpServers', 'mcp'],
    ['skills', 'skill'],
    ['plugins', 'plugin'],
    ['a2a', 'a2a'],
  ]) {
    if (bindingValueCount(bindings[key]) > 0) refs.push(label);
  }
  return [...new Set(refs)];
}

export function dshPresetId(agentId, revision = 1, buildId = '') {
  const rev = Number.isFinite(Number(revision)) && Number(revision) > 0 ? Number(revision) : 1;
  return `agentkit-studio-agent-${encodedId(agentId)}-r${rev}${buildId ? `-${encodedId(buildId)}` : ''}`;
}

export function dshPresetEligibility(agent = {}, options = {}) {
  const runtime = String(agent?.spec?.runtime?.type || agent?.runtime?.type || agent?.framework || '').trim().toLowerCase();
  const local = agent?.metadata?.local === true || agent?.source === 'local-studio'
    || (agent?.source === undefined && agent?.metadata?.local !== false);
  if (!['dsh-native', 'harness', 'codex'].includes(runtime)) {
    return { ok: false, code: 'STUDIO_PRESET_RUNTIME_UNSUPPORTED', message: '当前 Agent runtime 没有 DSH 原生会话适配器', runtime };
  }
  if (!local && (agent.source !== 'studio-deployment' || !/^dep_[a-f0-9]{32}$/.test(agent.deployment?.id || ''))) {
    return { ok: false, code: 'STUDIO_DEPLOYMENT_REQUIRED', message: '仅支持从 Studio 本地构建部署的云端 Agent', runtime };
  }
  const unsupported = unsupportedDshBindings(agent, options);
  const agentId = String(agent?.metadata?.id || agent?.id || '').trim();
  if (!agentId) return { ok: false, code: 'STUDIO_PRESET_AGENT_ID_MISSING', message: 'AgentId 不能为空' };
  const revision = Number(agent?.metadata?.revision || agent?.revision || 1) || 1;
  const bridge = !local || runtime !== 'dsh-native' || unsupported.length > 0;
  return {
    ok: true,
    agentId,
    revision,
    presetId: dshPresetId(agentId, revision, !local && agent.deployment?.versionId !== 'initial' ? agent.deployment?.versionId : ''),
    runtime,
    local,
    mode: bridge ? 'studio-bridge' : 'dsh-native',
    ...(unsupported.length ? { unsupported } : {}),
  };
}

/**
 * Owns registration lifetimes for dynamically admitted Studio presets.
 * The registry remains the DSH source of truth; this class only caches
 * successful registrations so selecting the same revision is idempotent.
 */
export class DshPresetAdmission {
  /** @param {{getAgent: (id: string) => Promise<object>, getActiveModel?: () => Promise<object>, getModelSelection?: (agent: object) => Promise<object>, getToolContracts?: (agent: object) => Promise<object[]>, registry?: {register: Function}}} options */
  constructor({ getAgent, getActiveModel, getModelSelection, getToolContracts, getSkillDefinitions, getBasePlugins, registry, assertHostCompatible, nativeEngineContract } = {}) {
    if (nativeEngineContract !== undefined && nativeEngineContract !== NATIVE_DSH_TURN_CONTRACT) throw new TypeError('Unsupported Native Harness engine contract');
    this.nativeEngineContract = nativeEngineContract;
    this.assertHostCompatible = assertHostCompatible;
    this.getAgent = getAgent;
    this.getActiveModel = getActiveModel;
    this.getModelSelection = getModelSelection;
    this.getToolContracts = getToolContracts;
    this.getSkillDefinitions = getSkillDefinitions;
    this.getBasePlugins = getBasePlugins;
    this.registry = registry;
    this.registrations = new Map();
    this.pending = new Map();
    this.disposed = false;
  }

  setRegistry(registry) {
    // A Host scope teardown runs dispose(), which latches this instance and
    // unregisters every preset from the old registry. When the scope is
    // re-created (live patch reload, plugin reactivation) the same admission
    // receives the fresh registry: the stale latch must reset or every later
    // ensure() would refuse to admit presets into the new registry. The
    // registration cache is already empty after dispose(), so no stale
    // unregister handle can leak into the new registry.
    this.registry = registry;
    if (registry) this.disposed = false;
  }

  async ensure(agentId, { agent: suppliedAgent, allowUnavailableResources = false } = {}) {
    this.assertHostCompatible?.();
    if (!this.registry || typeof this.registry.register !== 'function') {
      const error = new Error('DSH agent preset registry 不可用');
      error.code = 'DSH_PRESET_REGISTRY_UNAVAILABLE';
      throw error;
    }
    if (typeof this.getAgent !== 'function') {
      const error = new Error('AgentEngine Server 不可用');
      error.code = 'AGENTENGINE_SERVER_UNAVAILABLE';
      throw error;
    }
    const agent = suppliedAgent || await this.getAgent(String(agentId || '').trim());
    const activeModel = typeof this.getActiveModel === 'function' ? await this.getActiveModel() : undefined;
    // Persisted Sessions already own their model-selection projection. Restoring
    // a definition must not serialize the registry behind an external model
    // catalog or credential lookup. Explicit new-session admission still checks
    // the requested model, including when it reuses a restored definition.
    const modelSelection = !allowUnavailableResources && typeof this.getModelSelection === 'function' ? await this.getModelSelection(agent) : undefined;
    const eligibility = dshPresetEligibility(agent, { activeModel });
    if (!eligibility.ok) {
      const error = new Error(eligibility.message);
      error.code = eligibility.code;
      error.details = { agentId, ...(eligibility.unsupported ? { unsupported: eligibility.unsupported } : {}), ...(eligibility.runtime ? { runtime: eligibility.runtime } : {}) };
      throw error;
    }
    const buildId = agent.buildId || '';
    if (buildId) {
      if (!/^build_[0-9a-f]{20}$/.test(buildId) || agent.metadata?.local !== true) {
        throw Object.assign(new Error('只有本地 Agent Build 支持冻结版本会话'), { code: 'BUILD_RUNTIME_UNSUPPORTED' });
      }
      eligibility.buildId = buildId;
      eligibility.presetId = dshPresetId(eligibility.agentId, eligibility.revision, buildId);
      eligibility.mode = 'studio-bridge';
    }
    if (this.disposed) throw Object.assign(new Error('Agent preset admission is disposed'), { code: 'DSH_PRESET_REGISTRY_UNAVAILABLE' });
    const previous = this.registrations.get(eligibility.presetId);
    if (previous && (!previous.resourcesUnavailable || allowUnavailableResources)) return { ...eligibility, ...(modelSelection ? { modelSelection } : {}), reused: true };
    const pending = this.pending.get(eligibility.presetId);
    if (pending) {
      await pending;
      if (!allowUnavailableResources && this.registrations.get(eligibility.presetId)?.resourcesUnavailable) return this.ensure(agentId, { agent });
      return { ...eligibility, ...(modelSelection ? { modelSelection } : {}), reused: true };
    }
    const registration = this.register(agent, eligibility, buildId, { allowUnavailableResources });
    this.pending.set(eligibility.presetId, registration);
    try {
      await registration;
      return { ...eligibility, ...(modelSelection ? { modelSelection } : {}), reused: false };
    } finally { this.pending.delete(eligibility.presetId); }
  }

  async register(agent, eligibility, buildId, { allowUnavailableResources = false } = {}) {
    const nativeEngineContract = selectedNativeBuildContract(agent, this.nativeEngineContract);
    const instructions = String(agent?.spec?.instructions?.system || agent?.spec?.description || '').trim();
    const task = String(agent?.spec?.instructions?.task || '').trim();
    const prefix = [instructions, task ? `当前任务约束：${task}` : ''].filter(Boolean).join('\n\n');
    const basePlugins = eligibility.local && this.getBasePlugins ? await this.getBasePlugins(agent) : [];
    // A Studio-owned Web binding replaces the standard preset's Web plugin;
    // duplicate names in the same scope fail admission. An ordinary legacy
    // preset without that binding retains its existing DSH Web environment.
    const ownsWeb = eligibility.local && (eligibility.runtime === 'harness' && nativeEngineContract
      || toolBindingRefs(agent).some(name => ['web_fetch', 'web_search'].includes(name)));
    const plugins = basePlugins.filter(row => !ownsWeb || row.name !== '@deepseek-ai/dsh-tool-web');
    let resourcesUnavailable = false;
    if (prefix) {
      const persona = plugins.find(row => row.id === 'persona');
      const row = {
      id: 'persona',
      name: '@deepseek-ai/dsh-persona',
      // Agent selection is independent from DSH's optional filesystem
      // workspace. The Studio runtime owns bound MCP/Skill/knowledge
      // resources, so inheriting the host's runtime context would silently
      // attach the current workspace and make a blank Agent session appear
      // workspace-bound in the native conversation UI.
      config: { ...persona?.config, prefix, includeRuntimeContext: false },
      };
      if (persona) Object.assign(persona, row);
      else plugins.push(row);
    }
    if (eligibility.mode === 'studio-bridge') {
      // Cloud tools/resources are executed by the frozen runtime;
      // asking the local DSH registry to materialize them would incorrectly
      // turn a valid cloud Agent into a local binding failure.
      const recoverResources = async (load) => {
        try { return await load(); }
        catch (error) {
          if (!allowUnavailableResources) throw error;
          resourcesUnavailable = true;
          console.warn('[agentkit-studio] preset resource snapshot unavailable during recovery:', eligibility.presetId, error?.code || 'RESOURCE_UNAVAILABLE');
          return [];
        }
      };
      const toolContracts = eligibility.local && typeof this.getToolContracts === 'function'
        ? await recoverResources(() => this.getToolContracts(agent))
        : [];
      // Catalog resource IDs can differ from their formal builtin names.
      if (toolContracts.some(tool => tool.executor === 'builtin' && tool.enabled !== false
        && ['web_fetch', 'web_search'].includes(tool.name))) {
        for (let index = plugins.length - 1; index >= 0; index--)
          if (plugins[index].name === '@deepseek-ai/dsh-tool-web') plugins.splice(index, 1);
      }
      const skillDefinitions = eligibility.local && typeof this.getSkillDefinitions === 'function'
        ? await recoverResources(() => this.getSkillDefinitions(agent))
        : [];
      if (skillDefinitions.length) {
        const shell = process.platform === 'win32' ? '@deepseek-ai/dsh-tool-pwsh' : '@deepseek-ai/dsh-tool-bash';
        if (!plugins.some(row => row.name === '@deepseek-ai/dsh-tool-skill')) plugins.push({ id: 'bound-skill-loader', name: '@deepseek-ai/dsh-tool-skill' });
        if (!plugins.some(row => row.name === shell)) plugins.push({ id: 'bound-skill-shell', name: shell });
      }
      plugins.push({
        id: 'studio-runtime',
        name: '@kingsoftcloud/agentkit-studio/dsh-runtime-plugin',
        config: {
          agentId: eligibility.agentId,
          runtime: eligibility.runtime,
          local: eligibility.local,
          ...(eligibility.local ? { componentBindings: dshComponentBindings(agent.spec), knowledgeBindings: knowledgeBindings(agent.spec) } : {}),
          ...(resourcesUnavailable ? { resourcesUnavailable: true } : {}),
          ...(eligibility.local ? {agentRevision:eligibility.revision} : {}),
          ...(eligibility.local && eligibility.runtime === 'harness' && nativeEngineContract
            ? { nativeEngineContract } : {}),
          ...(!eligibility.local ? { cloudVersionId: agent.deployment?.versionId || 'initial' } : {}),
          ...(buildId ? { buildId } : {}),
          ...(toolBindingRefs(agent).length ? { toolBindings: toolBindingRefs(agent) } : {}),
          ...(toolContracts.length ? { toolContracts } : {}),
          ...(skillDefinitions.length ? { skillDefinitions } : {}),
          ...(nativeEngineContract && eligibility.runtime === 'harness' ? { skillSpaceIds: [...new Set((agent.spec.bindings?.plugins ?? [])
            .filter(plugin => plugin.enabled !== false).map(plugin => plugin.config?.binding?.resource)
            .filter(resource => resource?.kind === 'skill-space').map(resource => resource.id || resource.resourceId).filter(Boolean))] } : {}),
          ...(eligibility.local && agent.spec.bindings?.a2a?.length
            ? { a2aBindings: structuredClone(agent.spec.bindings.a2a) } : {}),
          ...(nativeEngineContract && eligibility.runtime === 'harness' ? { subAgents: nativeChildRoles(agent.spec) } : {}),
        },
      });
    }
    // Revalidate a recovered placeholder before explicit admission; only retire
    // it after all resource probes succeed, so a failed retry preserves history.
    const previous = this.registrations.get(eligibility.presetId);
    if (previous?.resourcesUnavailable && !resourcesUnavailable) {
      await previous.unregister?.();
      this.registrations.delete(eligibility.presetId);
    }
    const unregister = await this.registry.register({
      id: eligibility.presetId,
      name: `${String(agent?.metadata?.name || agent?.name || eligibility.agentId)}${buildId ? ` · Revision ${eligibility.revision} · ${buildId.slice(-8)}` : ''}`,
      description: buildId ? `AgentKit Studio 冻结版本 ${buildId}` : 'AgentKit Studio Agent',
      // The persona row is optional. Runtime listeners own their selected
      // contract; opted-in Harness replaces the turn, while legacy bindings
      // change only the provider route. DSH retains Session and rendering.
      plugins,
    });
    // A newer revision must not remove a preset still referenced by an older
    // native Session. Dispose all registrations with the Host scope instead.
    this.registrations.set(eligibility.presetId, { presetId: eligibility.presetId, unregister, resourcesUnavailable });
  }

  async dispose() {
    this.disposed = true;
    await Promise.allSettled(this.pending.values());
    const entries = [...this.registrations.values()];
    this.registrations.clear();
    for (const entry of entries) {
      if (typeof entry.unregister === 'function') await entry.unregister();
    }
  }
}
