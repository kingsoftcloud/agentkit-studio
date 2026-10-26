/**
 * Preset-scoped runtime bindings. Opted-in AgentKit Harness owns the complete
 * Native turn; DSH supplies its Session and admitted ToolRegistry pipeline.
 * Other runtime bindings retain the existing DSH model-request bridge.
 */

export const name = 'agentkit-studio-dsh-runtime';
export const inject = ['tools', 'skills', 'studioRuntimeBridge'];
const AGENT_REQUEST_EVENT = ['agent', 'request'].join('/');
import { bindDshAgentRoute, executeDshResourceTool } from '@kingsoftcloud/agentkit-studio/dsh-runtime';
import { resolveRuntimeBridge } from '../host/runtime-bridge.mjs';
import { migrateLegacyCodexObservations } from './codex-observation.mjs';
import { createDshPresentationTools } from './dsh-presentation-tools.mjs';
import { NATIVE_DSH_TURN_CONTRACT } from '../../packages/agentkit-harness/src/native/dsh-turn-contract.mjs';
import { nativeA2aToolDefinitions } from '../../packages/agentkit-harness/src/native/a2a-tools.mjs';
import { sandboxRegistryName } from './sandbox-code-name.mjs';
import { assertConcreteBuiltin, unavailableNodeBuiltin } from './dsh-node-builtin-catalog.mjs';
import { installNativeBoundPolicy } from './native-bound-policy.mjs';
import { normalizeNativeAgentPolicy } from '../native-agent-policy.mjs';

function builtinError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details });
}

// DSH's ToolRegistry validates successful values against the declared output
// schema. MCP servers may return any JSON root (including arrays), so expose a
// stable object envelope to the registry and keep the lossless payload in its
// string field. The rendered content remains the original JSON representation
// that the model and native conversation can consume.
const BRIDGED_OUTPUT_SCHEMA = {
  type: 'object',
  properties: { result: { type: 'string' } },
  required: ['result'],
};

function bridgedOutput(value) {
  return { result: typeof value === 'string' ? value : JSON.stringify(value) ?? '' };
}

function renderBridgedOutput(_args, value) {
  return [{ type: 'text', text: String(value?.result || '') }];
}

function createBuiltinExecutor(nodeTools) {
  return async (contract, argumentsValue, exec = {}) => {
    const name = String(contract?.name || '').trim();
    if (!name) throw builtinError('BUILTIN_TOOL_NAME_MISSING', 'AgentEngine 内置 Tool 缺少名称');
    assertConcreteBuiltin(name);
    if (!nodeTools?.supports(name)) throw unavailableNodeBuiltin(name);
    const result = await nodeTools.execute(name, argumentsValue, exec);
    if (result?.status === 'ok') return result.content;
    if (result?.status === 'error') return { ...result.content, ok: false };
    if (result?.status === 'uncertain') return { ...result.content, ok: false, status: 'uncertain' };
    throw builtinError('BUILTIN_TOOL_INVALID_OUTPUT', `Node builtin ${name} 返回了无效结果`, { name });
  };
}

function registerBuiltinTools(ctx, contracts, config, bridge) {
  const declared = (Array.isArray(contracts) ? contracts : [])
    .filter(contract => contract && contract.executor === 'builtin' && contract.enabled !== false && contract.name);
  // A persisted DSH preset can outlive the catalog request that originally
  // admitted it. Preserve the Agent's explicit builtin bindings in that case;
  // an unavailable Node port rejects the call without another executor.
  const a2aDefinitions = config.a2aBindings?.length ? nativeA2aToolDefinitions() : [];
  for (const definition of a2aDefinitions) {
    if ((contracts ?? []).some(contract => contract.name === definition.name && contract.enabled !== false && contract.executor !== 'builtin'))
      throw builtinError('A2A_TOOL_NAME_COLLISION', 'A managed A2A name is already bound to another executor');
    if (!declared.some(contract => contract.name === definition.name)) declared.push({ name: definition.name,
      description: definition.description, parameters: definition.parameters, executor: 'builtin', enabled: true });
  }
  const declaredNames = new Set(declared.map(contract => String(contract.name)));
  const fallback = toolNames(config.toolBindings)
    .filter(name => !declaredNames.has(name))
    .map(name => ({
      name,
      description: `AgentEngine 内置 Tool：${name}`,
      parameters: { type: 'object', properties: {} },
      executor: 'builtin',
      timeoutSeconds: 20,
      enabled: true,
    }));
  const values = [...declared, ...fallback].map(contract => ({ ...contract, name: sandboxRegistryName(String(contract.name)) }));
  if (new Set(values.map(contract => contract.name)).size !== values.length)
    throw builtinError('BUILTIN_TOOL_NAME_COLLISION', 'Sandbox code bindings resolve to the same registry name');
  for (const contract of values) assertConcreteBuiltin(contract.name);
  if (!values.length) return;
  if (typeof ctx.tools?.register !== 'function') return;
  const nodeTools = bridge.createBuiltinTools?.({ ctx, config }) ?? null;
  if (nodeTools && typeof ctx.effect === 'function') ctx.effect(() => () => nodeTools.close(), 'agentkit-studio: Node builtin lifetime');
  const executeBuiltin = createBuiltinExecutor(nodeTools);
  const install = () => {
    const disposers = values.map(contract => {
      const formal = nodeTools?.supports(String(contract.name))
        ? nodeTools.definitions.find(definition => definition.name === String(contract.name)) : null;
      return ctx.tools.register({
        name: String(contract.name),
        description: String(contract.description || `AgentEngine 内置 Tool：${contract.name}`),
        parameters: formal?.parameters || contract.parameters || { type: 'object', properties: {} },
        output: { schema: BRIDGED_OUTPUT_SCHEMA, render: renderBridgedOutput },
        execute: async (args, exec) => bridgedOutput(await executeBuiltin(contract, args, exec)),
      });
    });
    return () => disposers.forEach(dispose => { try { dispose?.(); } catch {} });
  };
  if (typeof ctx.effect === 'function') ctx.effect(install, 'agentkit-studio: builtin tool bindings');
  else install();
  return nodeTools;
}

function registerMcpTools(ctx, contracts, config, bridge) {
  const values = (Array.isArray(contracts) ? contracts : [])
    .filter(contract => contract && contract.executor === 'mcp' && contract.enabled !== false && contract.name)
    .map(contract => ({
      ...contract,
      resourceId: String(contract.mcpResourceId || contract.resourceId || '').trim(),
    }))
    .filter(contract => contract.resourceId);
  if (!values.length || typeof ctx.tools?.register !== 'function') return;
  const install = () => {
    const disposers = values.map(contract => ctx.tools.register({
      name: String(contract.name),
      description: String(contract.description || `MCP Tool：${contract.name}`),
      parameters: contract.parameters || { type: 'object', properties: {} },
      output: { schema: BRIDGED_OUTPUT_SCHEMA, render: renderBridgedOutput },
      execute: async (args, exec) => bridgedOutput(await executeDshResourceTool({
        agentId: config.agentId,
        resourceId: contract.resourceId,
        name: contract.name,
        arguments: args || {},
        signal: exec?.signal,
        callId: exec?.callId,
        agent: exec?.agent,
      }, bridge)),
    }));
    return () => disposers.forEach(dispose => { try { dispose?.(); } catch {} });
  };
  if (typeof ctx.effect === 'function') ctx.effect(install, 'agentkit-studio: MCP tool bindings');
  else install();
}

function toolNames(values) {
  return (Array.isArray(values) ? values : []).map(value => {
    if (typeof value === 'string') return value;
    return value?.resourceId || value?.id || value?.name || '';
  }).filter(Boolean).map(String);
}

function createToolAdapter(ctx, bindings) {
  const allowed = new Set(toolNames(bindings).map(sandboxRegistryName));
  if (!allowed.size) return undefined;
  const schemas = agent => (ctx.tools.schemas?.(agent) || []).filter(schema => allowed.has(String(schema.name)));
  const resolve = (name, agent) => {
    const candidate = sandboxRegistryName(String(name || ''));
    const schema = schemas(agent).find(item => item.name === candidate);
    if (!schema) throw Object.assign(new Error(`DSH Tool 未注册或不在当前 Agent 绑定范围内：${candidate}`), { code: 'TOOL_NOT_FOUND' });
    return schema;
  };
  return {
    listTools(_ids = [], agent) {
      const available = new Set(schemas(agent).map(schema => schema.name));
      const missing = [...allowed].filter(name => !available.has(name));
      if (missing.length) throw Object.assign(new Error(`DSH Tool 未注册或不在当前 Agent 绑定范围内：${missing.join(', ')}`), { code: 'TOOL_NOT_FOUND', details: { names: missing } });
      return schemas(agent).map(schema => ({ name: schema.name, description: schema.description, parameters: schema.parameters, resourceId: schema.name }));
    },
    async callTool(name, args = {}, { callId, signal, agent } = {}) {
      const schema = resolve(name, agent);
      const result = await ctx.tools.execute({
        callId: String(callId || `studio-tool-${Date.now().toString(36)}`),
        name: schema.name,
        arguments: args,
        signal: signal || new AbortController().signal,
        agent,
      });
      if (result?.isError) {
        const error = new Error(`DSH Tool ${schema.name} 执行失败`);
        error.code = result.error?.code || 'DSH_TOOL_FAILED';
        error.details = { name: schema.name };
        throw error;
      }
      return result?.content ?? result?.value ?? result;
    },
  };
}

export function apply(ctx, config = {}) {
  const agentId = String(config.agentId || '').trim();
  if (!agentId) throw new Error('agentkit-studio-dsh-runtime: agentId is required');
  if (config.nativeEngineContract !== undefined && (config.nativeEngineContract !== NATIVE_DSH_TURN_CONTRACT
    || config.runtime !== 'harness' || config.local !== true)) {
    throw Object.assign(new Error('Unsupported Native Harness engine contract'), { code: 'STUDIO_NATIVE_ENGINE_CONTRACT_UNSUPPORTED' });
  }
  if (config.nativeEngineContract !== NATIVE_DSH_TURN_CONTRACT
    && config.toolContracts?.some(contract => contract.nativeMcpSchema !== undefined)) {
    throw Object.assign(new Error('Native MCP schemas require the Native turn engine'), { code: 'STUDIO_NATIVE_MCP_SCHEMA_ENGINE_REQUIRED' });
  }
  const bridge = resolveRuntimeBridge(typeof ctx.get === 'function' ? ctx : undefined);
  const routeScope = bridge.createRouteScope();
  const routes = new Map();
  let stopped = false;
  if (typeof ctx.effect === 'function') ctx.effect(() => () => {
    stopped = true;
    for (const dispose of routes.values()) dispose();
    routes.clear();
  }, 'agentkit-studio: preset route lifetime');
  const skills = Array.isArray(config.skillDefinitions) ? config.skillDefinitions : [];
  if (skills.length) {
    if (typeof ctx.skills?.register !== 'function') throw new Error('DSH SkillRegistry 不可用');
    const install = () => {
      const disposers = skills.map(skill => ctx.skills.register(skill));
      return () => disposers.forEach(dispose => dispose?.());
    };
    if (typeof ctx.effect === 'function') ctx.effect(install, 'agentkit-studio: bound skills');
    else install();
  }
  const wholeNativeTurn = config.nativeEngineContract === NATIVE_DSH_TURN_CONTRACT;
  const nativeToolBindings = wholeNativeTurn ? bridge.createNativeTools({ ctx, config }) : null;
  const boundToolPolicy = wholeNativeTurn ? normalizeNativeAgentPolicy(config.boundToolPolicy) : null;
  if (boundToolPolicy) {
    const install = () => installNativeBoundPolicy(ctx, boundToolPolicy,
      (agent, toolName) => nativeToolBindings.policyDefinition(agent, toolName));
    if (typeof ctx.effect === 'function') ctx.effect(install, 'agentkit-studio: bound Native policy');
    else install();
  }
  const builtinToolBindings = !wholeNativeTurn ? registerBuiltinTools(ctx, config.toolContracts, config, bridge) : null;
  if (!wholeNativeTurn) registerMcpTools(ctx, config.toolContracts, config, bridge);
  const boundToolAdapter = createToolAdapter(ctx, [...toolNames(config.toolBindings),
    ...(!wholeNativeTurn && config.a2aBindings?.length ? nativeA2aToolDefinitions().map(tool => tool.name) : [])]);
  const toolAdapter = config.runtime === 'codex'
    ? { ...boundToolAdapter, ...createDshPresentationTools(ctx) } : boundToolAdapter;
  // Legacy resource adapters retain their existing per-model-step ownership.
  // Local AgentKit Harness is claimed above at the whole-turn boundary.
  const nativeTools = config.local === true && config.runtime !== 'codex';
  if (wholeNativeTurn) ctx.on('agent/execute-turn', async payload => {
    if (config.resourcesUnavailable) throw Object.assign(new Error('Native Harness 资源恢复失败，请修复绑定后重试'), { code: 'STUDIO_PRESET_RESOURCES_UNAVAILABLE' });
    if (stopped) throw Object.assign(new Error('Studio preset scope was retired'), { code: 'STUDIO_PRESET_SCOPE_CLOSED' });
    return bridge.executeNativeTurn({ ...payload, binding: { agentId, runtime: config.runtime, local: true,
      buildId: config.buildId, agentRevision: config.agentRevision, nativeEngineContract: config.nativeEngineContract,
      boundToolPolicy, nativeTools: nativeToolBindings } });
  });
  // Trusted Host queries this ephemeral binding through agentEvents(ctx, agent).
  // Durable ownership grants no tools or permissions by itself.
  if (wholeNativeTurn) ctx.on('agentkit/native-recovery-binding', async () => {
    if (config.resourcesUnavailable) throw Object.assign(new Error('Native Harness 资源恢复失败，请修复绑定后重试'), { code: 'STUDIO_PRESET_RESOURCES_UNAVAILABLE' });
    if (stopped) throw Object.assign(new Error('Studio preset scope was retired'), { code: 'STUDIO_PRESET_SCOPE_CLOSED' });
    return { agentId, runtime: config.runtime, local: true,
      agentRevision: config.agentRevision, ...(config.buildId ? { buildId: config.buildId } : {}),
      nativeEngineContract: config.nativeEngineContract, boundToolPolicy, nativeTools: nativeToolBindings };
  });
  if (!wholeNativeTurn && config.local === true && config.a2aBindings?.length) ctx.on('agentkit/dsh-a2a-binding', async () => {
    if (config.resourcesUnavailable) throw Object.assign(new Error('A2A resources unavailable'), { code: 'STUDIO_PRESET_RESOURCES_UNAVAILABLE' });
    if (stopped) throw Object.assign(new Error('Studio preset scope was retired'), { code: 'STUDIO_PRESET_SCOPE_CLOSED' });
    return { contract: 'agentkit.studio-dsh-a2a-binding/v1', agentId, runtime: config.runtime, local: true,
      agentRevision: config.agentRevision, buildId: config.buildId ?? null, tools: builtinToolBindings };
  });
  // The Agent loop dispatches its request waterfall through the selected Agent
  // scope, then invokes `llm.stream` from the root loop context. Bind the
  // Studio provider at the scoped request boundary so the root adapter can
  // recover this Agent's runtime and Tool adapter by session id.
  ctx.on(AGENT_REQUEST_EVENT, async (payload, next) => {
    if (config.resourcesUnavailable) throw Object.assign(new Error('此会话的 Agent 资源恢复失败。请检查资源配置后重新选择 Agent 或重新打开应用。'), { code: 'STUDIO_PRESET_RESOURCES_UNAVAILABLE' });
    if (wholeNativeTurn) throw Object.assign(new Error('此 Harness 必须通过整轮执行接口运行，请安装兼容的 Studio Host'), { code: 'STUDIO_NATIVE_WHOLE_TURN_REQUIRED' });
    const resolved = await next();
    if (stopped) throw Object.assign(new Error('Studio preset scope was retired'), { code: 'STUDIO_PRESET_SCOPE_CLOSED' });
    if (config.runtime === 'codex' && config.local === true) migrateLegacyCodexObservations(payload?.agent?.session);
    const sessionId = String(payload?.agent?.id || '').trim();
    if (sessionId) {
      routes.get(sessionId)?.();
      routes.set(sessionId, bindDshAgentRoute(sessionId, {
        agentId,
        agent: payload?.agent,
        runtime: config.runtime,
        local: config.local === true,
        buildId: config.buildId,
        agentRevision: config.agentRevision,
        cloudVersionId: config.cloudVersionId,
        toolAdapter,
        nativeTools,
      }, bridge, routeScope));
    }
    // Keep the DSH-visible provider/model header unchanged. The preset-scoped
    // listener below owns the transport interception; exposing the Studio
    // provider here would make the native picker appear to switch models.
    return resolved;
  });
  // llm/stream is a Host-wide event, not a preset-scoped Agent event.
  // The Host listener uses the route registered above for this Session only.
}

export default { name, inject, apply };
