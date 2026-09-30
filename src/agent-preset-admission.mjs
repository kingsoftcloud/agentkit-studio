/**
 * The narrow bridge between a Studio AgentRevision and the public DSH
 * agent-preset registry.
 *
 * This module admits a dsh-native revision only when its model is the active
 * DSH route. Studio tool/MCP/Skill/platform bindings are not DSH Cordis
 * declarations, so silently putting them in an empty preset would produce a
 * successful looking chat that runs the wrong composition. Those resource
 * bindings are routed through the Studio DSH provider bridge, which keeps the
 * native Session UI and loop while delegating the model turn to Studio.
 */

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
  return values.map(value => typeof value === 'string' ? value : value?.resourceId).filter(Boolean).map(String);
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
  ]) {
    if (bindingValueCount(bindings[key]) > 0) refs.push(label);
  }
  return [...new Set(refs)];
}

export function dshPresetId(agentId, revision = 1) {
  const rev = Number.isFinite(Number(revision)) && Number(revision) > 0 ? Number(revision) : 1;
  return `agentkit-studio-agent-${encodedId(agentId)}-r${rev}`;
}

export function dshPresetEligibility(agent = {}, options = {}) {
  const runtime = String(agent?.spec?.runtime?.type || agent?.runtime?.type || agent?.framework || '').trim().toLowerCase();
  if (!['dsh-native', 'harness', 'codex'].includes(runtime)) {
    return { ok: false, code: 'STUDIO_PRESET_RUNTIME_UNSUPPORTED', message: '当前 Agent runtime 没有 DSH 原生会话适配器', runtime };
  }
  const unsupported = unsupportedDshBindings(agent, options);
  const agentId = String(agent?.metadata?.id || agent?.id || '').trim();
  if (!agentId) return { ok: false, code: 'STUDIO_PRESET_AGENT_ID_MISSING', message: 'AgentId 不能为空' };
  const revision = Number(agent?.metadata?.revision || agent?.revision || 1) || 1;
  const bridge = runtime !== 'dsh-native' || unsupported.length > 0;
  return {
    ok: true,
    agentId,
    revision,
    presetId: dshPresetId(agentId, revision),
    runtime,
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
  /** @param {{getAgent: (id: string) => Promise<object>, getActiveModel?: () => Promise<object>, registry?: {register: Function}}} options */
  constructor({ getAgent, getActiveModel, registry } = {}) {
    this.getAgent = getAgent;
    this.getActiveModel = getActiveModel;
    this.registry = registry;
    this.registrations = new Map();
  }

  setRegistry(registry) {
    this.registry = registry;
  }

  async ensure(agentId, { agent: suppliedAgent } = {}) {
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
    const eligibility = dshPresetEligibility(agent, { activeModel });
    if (!eligibility.ok) {
      const error = new Error(eligibility.message);
      error.code = eligibility.code;
      error.details = { agentId, ...(eligibility.unsupported ? { unsupported: eligibility.unsupported } : {}), ...(eligibility.runtime ? { runtime: eligibility.runtime } : {}) };
      throw error;
    }
    const previous = this.registrations.get(eligibility.agentId);
    if (previous?.presetId === eligibility.presetId) return { ...eligibility, reused: true };
    if (previous?.unregister) await previous.unregister();
    const instructions = String(agent?.spec?.instructions?.system || agent?.spec?.description || '').trim();
    const task = String(agent?.spec?.instructions?.task || '').trim();
    const prefix = [instructions, task ? `当前任务约束：${task}` : ''].filter(Boolean).join('\n\n');
    const plugins = [];
    if (prefix) plugins.push({ id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix } });
    if (eligibility.mode === 'studio-bridge') {
      plugins.push({
        id: 'studio-runtime',
        name: '@kingsoftcloud/agentkit-studio/dsh-runtime-plugin',
        config: {
          agentId: eligibility.agentId,
          runtime: eligibility.runtime,
          local: agent?.metadata?.local === true,
        },
      });
    }
    const unregister = await this.registry.register({
      id: eligibility.presetId,
      name: String(agent?.metadata?.name || agent?.name || eligibility.agentId),
      description: 'AgentKit Studio dsh-native Agent（使用当前 DSH 模型路由）',
      // The persona row is optional. Resource-bearing Harness/Codex revisions
      // add the Studio runtime listener, which changes only the provider route;
      // DSH still owns the Session Controller, durable loop and renderer.
      plugins,
    });
    this.registrations.set(eligibility.agentId, { presetId: eligibility.presetId, unregister });
    return { ...eligibility, reused: false };
  }

  async dispose() {
    const entries = [...this.registrations.values()];
    this.registrations.clear();
    for (const entry of entries) {
      if (typeof entry.unregister === 'function') await entry.unregister();
    }
  }
}
