/**
 * AgentKit Studio host half.
 *
 * The official DSH Host owns the Session Controller, profile, persistence,
 * Remote and renderer. Studio does not intercept DSH prompts here and does
 * not translate them into legacy session/run action calls. Agent authoring
 * is exposed through the public DSH ToolRegistry: native conversations can
 * inspect catalogs, maintain a reviewed draft and explicitly commit it via
 * the Host API. A selected no-resource dsh-native Studio Agent is admitted
 * through DSH's public agent-preset registry; Harness, Codex and
 * resource-bearing revisions use the Studio provider bridge while DSH keeps
 * ownership of the Session, loop and renderer.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { registerAuthoringTools } from './authoring-tools.mjs';
import { DshPresetAdmission, dshModelSelection } from './agent-preset-admission.mjs';

export const name = 'agentkit-studio';
export const inject = ['connection', 'webServer', 'credentials'];

const CONTROL_CHANNEL = '/agentkit';
const runtimeEnv = typeof process === 'object' && process?.env ? process.env : {};

/**
 * The Studio browser half runs in DSH's sandboxed srcdoc frame. A direct
 * fetch from that frame cannot carry a usable Origin, so the AgentEngine
 * control plane is reached through DSH's authenticated Connection RPC. The
 * Node Host owns credentials and calls the public Action API; no KsADK/Python
 * process is involved in this path.
 */
async function registerControlPlane(ctx) {
  // Keep Node-only configuration and HTTPS/KOP dependencies out of the
  // browser-facing plugin module graph. DSH loads this module for both the
  // Host and client faces; importing node:fs or aws4 at activation time makes
  // the whole plugin fail before the Host route can be registered.
  const { loadPortableRuntime, createPortableBundles } = await import('./portable-bundle.mjs');
  const portableRuntime = await loadPortableRuntime(runtimeEnv.AGENTKIT_HOME, runtimeEnv);
  const studioStoreDir = join(runtimeEnv.AGENTKIT_HOME || join(homedir(), '.agentkit'), 'studio');
  const skillDiscoveryPromise = import('./skill-discovery.mjs').then(({ createSkillDiscovery }) => createSkillDiscovery({ storeDir: join(studioStoreDir, 'skills') }));
  const studioBuildPromise = Promise.all([
    import('./studio-operations.mjs').then(({ createOperationManager }) => createOperationManager({ storeDir: join(studioStoreDir, 'operations') })),
    import('./studio-build.mjs').then(({ createStudioBuild }) => createStudioBuild({ storeDir: studioStoreDir })),
  ]).then(([operations, build]) => ({ operations, build }));
  const { BUILD_DOWNLOAD_PATH, buildDownloadResponse } = await import('./build-download-route.mjs');
  ctx.connection.fetch.register({
    path: BUILD_DOWNLOAD_PATH, methods: ['GET', 'HEAD'], requestBody: 'buffered',
    fetch: async request => {
      const bundleId = new URL(request.url).searchParams.get('bundleId');
      return buildDownloadResponse(request, bundleId ? { download: (agentId, buildId) => portableBundles.download(agentId, buildId, bundleId) } : (await studioBuildPromise).build);
    },
  });
  const studioSchedulerPromise = Promise.all([import('./studio-scheduler.mjs'), import('./native-automation-runner.mjs')]).then(([{ createStudioScheduler }, { createNativeAutomationRunner }]) => createStudioScheduler({ storeDir: join(studioStoreDir, 'scheduler'), runner: createNativeAutomationRunner({ getService: name => ctx.get(name), admit: async agentId => { const local = await (await agentStorePromise).get(agentId); return presetAdmission.ensure(agentId, local ? { agent: local } : {}); } }) })).catch(error => { console.warn('[agentkit-studio] scheduler init failed:', error?.message || error); return null; });
  const studioObservabilityPromise = import('./studio-observability.mjs').then(({ createStudioObservability }) => createStudioObservability({ storeDir: join(studioStoreDir, 'traces') })).catch(error => { console.warn('[agentkit-studio] observability init failed:', error?.message || error); return null; });
  const studioEvaluationPromise = Promise.all([import('./studio-evaluation.mjs'), import('./native-automation-runner.mjs')]).then(([{ createStudioEvaluation }, { createNativeAutomationRunner }]) => createStudioEvaluation({ storeDir: join(studioStoreDir, 'evaluations'), resolveTarget: async locator => { const target = (await listLocalBuildTargets()).find(build => build.id === locator); if (!target) throw Object.assign(new Error('评测 Build 不存在，请选择已完成的本地构建'), { code: 'EVALUATION_TARGET_NOT_FOUND' }); await (await studioBuildPromise).build.resolve(target.agentId, target.id); return target; }, runner: async request => createNativeAutomationRunner({ getService: name => ctx.get(name), admit: async (agentId, buildId) => { const local = await (await agentStorePromise).get(agentId); const frozen = await (await studioBuildPromise).build.resolve(agentId, buildId); return presetAdmission.ensure(agentId, { agent: { ...frozen, metadata: { ...local.metadata, ...frozen.metadata, local: true } } }); } })({ ...request, sessionId: `eval-session-${randomUUID()}`, occurrenceId: `eval-request-${randomUUID()}` }) })).catch(error => { console.warn('[agentkit-studio] evaluation init failed:', error?.message || error); return null; });
  const studioChannelsPromise = Promise.all([import('./studio-channels.mjs'), import('./native-automation-runner.mjs')]).then(([{ createStudioChannels }, { createNativeAutomationRunner }]) => createStudioChannels({
    storeDir: studioStoreDir,
    getAgent: async id => (await agentStorePromise).get(id),
    listAgents: async () => (await agentStorePromise).list(),
    runner: createNativeAutomationRunner({ getService: name => ctx.get(name), reuseSession: true, admit: async agentId => {
      const local = await (await agentStorePromise).get(agentId);
      if (!local) throw Object.assign(new Error('渠道绑定的本地 Agent 不存在'), { code: 'CHANNEL_AGENT_UNAVAILABLE' });
      return presetAdmission.ensure(agentId, { agent: local });
    } }),
  })).catch(error => { console.warn('[agentkit-studio] channels init failed:', error?.message || error); return null; });
  const agentStorePromise = import('./agent-store.mjs').then(({ createAgentStore }) => createAgentStore({ storeDir: join(studioStoreDir, 'agents') }));
  const agentCatalogPromise = import('./agent-catalog.mjs').then(({ createAgentCatalog }) => createAgentCatalog({ store: () => agentStorePromise,
    builds: async id => (await studioBuildPromise).build.list(id), deployments: async () => (await deployments()).agents.list() }));
  const listLocalBuildTargets = async () => { const studio = await studioBuildPromise; const agents = await (await agentStorePromise).list(); return (await Promise.all(agents.map(async agent => (await studio.build.list(agent.metadata.id)).map(build => ({ ...build, name: `${agent.metadata.name} · Revision ${build.revision}` }))))).flat().filter(build => build.status === 'SUCCEEDED'); };
  const localMcpStorePromise = import('./local-mcp-store.mjs').then(({ createLocalMcpStore }) => createLocalMcpStore({ storeDir: join(studioStoreDir, 'resources', 'mcp') }));
  const mcpProbePromise = import('./mcp-probes.mjs').then(({ createMcpProbes }) => createMcpProbes({ storeDir: join(studioStoreDir, 'resources', 'mcp-probes'), localStore: () => localMcpStorePromise, adapters: () => resourceAdaptersPromise }));
  // Authoring tools + resource catalogs read cloud/resource data through this
  // in-process remote — the legacy 8789 local Studio Host no longer exists.
  const authoringRemoteFactory = signal => Promise.all([serverClientPromise, agentStorePromise]).then(([serverClient]) => ({
    exchangeSession: async () => {},
    resources: async query => {
      const kind = new URLSearchParams(String(query || '')).get('kind') || 'model';
      if (kind === 'model') {
        const configuration = await configurationPromise;
        const credentials = ctx.get('credentials');
        const models = await import('./model-service.mjs').then(({ createModelService }) => createModelService({ configuration, credentials }));
        const catalog = await models.catalog('');
        return { items: catalog.items.map(item => ({ resourceId: item.id, name: item.name || item.id })) };
      }
      if (kind === 'skill') return (await skillDiscoveryPromise).listInstalled();
      const actions = { mcp: 'ListMCPs' };
      const action = actions[kind];
      if (!action) return { items: [] };
      const serverClient = await serverClientPromise;
      const result = await serverClient.action(action, { Page: 1, PageSize: 100 }, { signal });
      const raw = result.data || {};
      const rows = raw.MCPs || raw.SkillWorkspaces || raw.KnowledgeBases || raw.MemoryInstances || raw.Items || [];
      return { items: rows.map(row => ({ resourceId: String(row.mcp_id || row.Id || row.id || ''), name: String(row.display_name || row.Name || row.name || row.mcp_id || row.Id || row.id || '') })) };
    },
    quickAuthorAgent: async payload => {
      const store = await agentStorePromise;
      const record = await store.create({
        name: payload?.name, runtimeType: payload?.runtimeType, description: payload?.description,
        spec: payload?.spec, bindings: payload?.spec?.bindings || {},
      });
      return { metadata: record.metadata, spec: record.spec };
    },
  }));
  const configurationPromise = import('./global-config.mjs').then(({ createGlobalConfiguration }) =>
    createGlobalConfiguration({ env: runtimeEnv, inheritLegacy: !portableRuntime }));
  const credentialsService = ctx.get('credentials');
  const serverClientPromise = configurationPromise.then(configuration =>
    import('./server-client.mjs').then(({ createAgentEngineClient }) =>
      createAgentEngineClient({
        configuration,
        sessionToken: runtimeEnv.AGENTKIT_STUDIO_HOST_SESSION_TOKEN || '',
        serverUrl: runtimeEnv.AGENTKIT_STUDIO_HOST_URL || 'http://127.0.0.1:8789',
      })));
  const resourceAdaptersPromise = Promise.all([
    skillDiscoveryPromise,
    serverClientPromise,
    localMcpStorePromise,
  ]).then(async ([skillDiscovery, serverClient, localMcpStore]) => {
    const { createLocalResourceAdapters } = await import('./local-resource-adapters.mjs');
    const adapters = createLocalResourceAdapters({ serverClient, skillDiscovery, credentials: credentialsService, resourceStore: portableRuntime?.resourceStore || localMcpStore });
    if (portableRuntime) adapters.loadSkill = portableRuntime.loadSkill;
    return adapters;
  });
  // Studio-owned revisions still enter through DSH's native Session/Loop.
  // The provider is selected by the preset-scoped listener and delegates the
  // assembled turn to the local Harness or AgentEngine cloud stream.
  const { createDshRuntimeAdapter, setDshResourceToolExecutor, setDshRuntimeAdapter } = await import('./providers/dsh-runtime.mjs');
  const { LlmAdapter } = await import('@deepseek-ai/dsh-llm');
  // Codex is a native App Server runtime, not another gateway model. Keep its
  // optional child-process boundary lazy so Studio can still load on hosts
  // without a Codex binary and report CODEX_PROVIDER_UNAVAILABLE only when a
  // Codex Agent is selected.
  const { createCodexRuntime } = await import('./providers/codex-runtime.mjs');
  const { createCodexModelCatalog, createCodexModelAdapter, CODEX_PROVIDER } = await import('./providers/codex-models.mjs');
  const { resolveConfiguredCodexModel, selectCodexAgentModel, listCodexAgentModels } = await import('./providers/codex-configured-models.mjs');
  const codexOptions = portableRuntime
    ? await import('./portable-codex.mjs').then(({ portableCodexOptions }) => portableCodexOptions({ home: runtimeEnv.AGENTKIT_HOME, manifest: portableRuntime.manifest, env: runtimeEnv }))
    : {};
  const codexModels = createCodexModelCatalog(codexOptions);
  const codexRuntime = createCodexRuntime(codexOptions);
  let localRuntimeHandlerPromise;
  const localRuntimeHandler = async () => {
    if (!localRuntimeHandlerPromise) {
      localRuntimeHandlerPromise = Promise.all([
        agentStorePromise,
        configurationPromise,
        resourceAdaptersPromise,
        studioObservabilityPromise,
      ]).then(async ([store, configuration, resourceAdapters, observability]) => {
        const localModels = await import('./model-service.mjs').then(({ createModelService }) => createModelService({ configuration, credentials: credentialsService }));
        const { createLocalConversationHandler } = await import('./local-runtime.mjs');
        return createLocalConversationHandler({
          agentStore: async () => store,
          buildStore: (await studioBuildPromise).build,
          modelService: localModels,
          resourceAdapter: resourceAdapters,
          observability,
        });
      });
    }
    return localRuntimeHandlerPromise;
  };
  const codexResourceContext = async ({ agentId, buildId, agentRevision, input, userId, sessionId, toolAdapter, agent } = {}) => {
    const [store, buildState, resourceAdapter] = await Promise.all([agentStorePromise, studioBuildPromise, resourceAdaptersPromise]);
    let record;
    try { record = buildId ? await buildState.build.resolve(agentId, buildId) : agentRevision ? await store.getRevision(agentId,Number(agentRevision)) : await store.get(agentId); }
    catch (error) {
      console.warn('[agentkit-studio] Codex resource resolution failed:', JSON.stringify({ agentId, buildId: buildId || '', code: error?.code || 'UNKNOWN' }));
      throw error;
    }
    if (!record) throw Object.assign(new Error('本地 Codex Agent 不存在'), { code: 'AGENT_NOT_FOUND' });
    const { prepareLocalResourceContext, codexToolBindings, writeBoundMemory } = await import('./local-runtime.mjs');
    const prepared = await prepareLocalResourceContext({
      record,
      input,
      resourceAdapter,
      toolAdapter,
      userId: userId || 'studio-anonymous',
      agentId,
      agent,
    });
    const toolBindings = codexToolBindings(prepared.tools);
    const systemPrompt = [
      record.spec?.instructions?.system || record.spec?.description || '',
      record.spec?.instructions?.task || '',
      prepared.resourceContext ? `Relevant resources:\n${prepared.resourceContext}` : '',
    ].filter(Boolean).join('\n\n');
    return {
      agentName: String(record.metadata?.name || record.name || ''),
      systemPrompt,
      dynamicTools: toolBindings.map(item => item.spec),
      writeMemory: prepared.memoryWrite
        ? async assistantText => writeBoundMemory({
          binding: prepared.memory,
          resourceAdapter,
          input,
          assistantText,
          userId: userId || 'studio-anonymous',
          sessionId,
          agentId,
        })
        : null,
      toolHandler: async ({ name, arguments: args, callId, signal }) => {
        const binding = toolBindings.find(item => item.name === name);
        if (!binding?.tool?._source) {
          throw Object.assign(new Error(`Codex 请求了未绑定的工具：${name}`), { code: 'BOUND_TOOL_NOT_FOUND' });
        }
        if (binding.tool._source === 'dsh') {
          return toolAdapter.callTool(binding.tool.name, args || {}, { callId, signal, agent });
        }
        return resourceAdapter.callMcpTool(binding.tool._resourceId, binding.tool.name, args || {});
      },
    };
  };
  const { CLOUD_PROVIDER, createDeploymentModelAdapter } = await import('./deployment-agents.mjs');
  const { createDeploymentConversation } = await import('./deployment-conversation.mjs');
  const dshRuntimeAdapter = createDshRuntimeAdapter({
    AdapterBase: LlmAdapter,
    cloudRuntime: createDeploymentConversation({ agents: async () => (await deployments()).agents }),
    localHandler: localRuntimeHandler,
    codexRuntime,
    resolveCodexModel: selection => resolveConfiguredCodexModel(selection, models),
    codexResourceContext,
    resourceAdapter: await resourceAdaptersPromise,
    observability: await studioObservabilityPromise,
  });
  setDshRuntimeAdapter(dshRuntimeAdapter);
  const { routeDshRuntime } = await import('./providers/dsh-runtime.mjs');
  ctx.on('llm/stream', routeDshRuntime);
  setDshResourceToolExecutor(async ({ resourceId, name, arguments: args = {}, signal } = {}) => {
    const adapters = await resourceAdaptersPromise;
    if (typeof adapters?.callMcpTool !== 'function') {
      const error = new Error('AgentKit Studio MCP 资源适配器不可用');
      error.code = 'MCP_RESOURCE_ADAPTER_MISSING';
      throw error;
    }
    // The MCP SDK transport owns its request lifecycle. Keep the signal in
    // the bridge contract for future transports, but never expose credentials
    // or adapter internals to DSH's public ToolRegistry.
    void signal;
    return adapters.callMcpTool(resourceId, name, args);
  });
  ctx.inject(['llm'], llmCtx => {
    // registerAdapter already returns a disposer. Put the registration call
    // inside the owner effect so Cordis runs it on mount and calls its
    // disposer only when the llm service scope is torn down. Returning the
    // already-created disposer from a second effect would unregister the
    // route immediately and surface NO_ADAPTER on the first native turn.
    llmCtx.effect(
      () => llmCtx.llm.registerAdapter(['agentkit-studio'], dshRuntimeAdapter),
      'agentkit-studio: DSH runtime provider',
    );
    llmCtx.effect(() => llmCtx.llm.registerAdapter([CODEX_PROVIDER], createCodexModelAdapter({ catalog: codexModels, runtime: dshRuntimeAdapter })), 'agentkit-studio: Codex model directory');
    llmCtx.effect(() => llmCtx.llm.registerAdapter([CLOUD_PROVIDER], createDeploymentModelAdapter({ agents: async () => (await deployments()).agents, runtime: dshRuntimeAdapter })), 'agentkit-studio: frozen cloud models');
  });
  // Cordis exposes injected services through `get`; property access is only
  // available on typed service contexts and is absent in the plain plugin
  // apply context used by the DSH loader.
  const credentials = credentialsService;
  const models = await import('./model-service.mjs').then(({ createModelService }) => configurationPromise.then(configuration => createModelService({ configuration, credentials })));
  const portableBundles = createPortableBundles({ storeDir: studioStoreDir, build: (await studioBuildPromise).build, models,
    adapters: await resourceAdaptersPromise, configuration: await configurationPromise });
  let deploymentsPromise;
  const deployments = () => deploymentsPromise ||= Promise.all([import('./studio-deployments.mjs'), import('./server-client.mjs'), configurationPromise, studioBuildPromise, resourceAdaptersPromise])
    .then(([{ createStudioDeployments }, { createAgentEngineDeploymentClient }, configuration, studio, adapters]) => createStudioDeployments({
      storeDir: join(studioStoreDir, 'deployments'), ...studio, portableBundles, models, adapters, credentials, configuration, env: runtimeEnv,
      client: createAgentEngineDeploymentClient({ configuration }),
    }));
  const syncModelCredential = models.sync;
  // The DSH loader awaits an async plugin apply. Do this before returning from
  // activation so the first prompt cannot race the global ~/.agentkit key
  // being copied into the official credential service. The previous fire and
  // forget call made a fresh browser session intermittently fail with
  // llm-pi-ai/no-credential even though the Models page was already configured.
  try {
    await syncModelCredential();
  } catch (error) {
    console.warn('[agentkit-studio] model credential sync skipped:', error?.message || error);
  }
  let presetRegistry;
  let presetAdmission;
  // DSH restores a Session's selected preset before the browser can issue a
  // fresh agents/ensure-preset RPC. Dynamic Studio presets therefore need a
  // small startup reconciliation pass; otherwise a restart leaves persisted
  // sessions pointing at an unregistered agentkit-studio-agent-* preset and
  // the native page reports "Unknown agent preset" before the first prompt.
  const restorePersistedPresets = async () => {
    if (!presetAdmission) return;
    try {
      const {restoreLocalPresets} = await import('./preset-recovery.mjs');
      await restoreLocalPresets({store:await agentStorePromise,build:(await studioBuildPromise).build,admission:presetAdmission});
    } catch(error) { console.warn('[agentkit-studio] local revision recovery failed:',error?.message || error); }
    // Cloud catalog failures do not delay local Session recovery.
    void deployments().then(async service => {
      const catalog = await service.agents.recover();
      for (const agent of catalog.items || []) {
        try { await presetAdmission.ensure(agent.metadata.id,{agent}); }
        catch(error) { console.warn('[agentkit-studio] cloud preset restore skipped:',error?.message || error); }
      }
    }).catch(error=>console.warn('[agentkit-studio] cloud preset recovery unavailable:',error?.message || error));
  };
  // The registry is an optional DSH service. Older profiles can still load
  // the Studio catalog and UI, but an Agent binding must return a typed
  // unavailable error instead of silently selecting the default DSH loop.
  ctx.inject(['agentPresets'], presetCtx => {
    presetRegistry = presetCtx.agentPresets;
    if (presetAdmission) {
      presetAdmission.setRegistry(presetRegistry);
      void restorePersistedPresets();
    }
    presetCtx.effect(() => async () => {
      await presetAdmission?.dispose();
      presetRegistry = undefined;
    }, 'agentkit-studio: dynamic preset cleanup');
  });
  presetAdmission = new DshPresetAdmission({
    getAgent: async agentId => (await deployments()).agents.get(agentId),
    getActiveModel: async () => (await configurationPromise).resolve(),
    getModelSelection: async agent => {
      const local = agent?.metadata?.local !== false && agent?.source !== 'agentengine-server';
      if (!local) return { provider: CLOUD_PROVIDER, model: agent.deployment.model };
      if (local && !agent.buildId) await (await agentStorePromise).captureRevision(agent);
      if (local && agent?.spec?.runtime?.type === 'codex') return selectCodexAgentModel(agent, { models, catalog: codexModels });
      const settings = { values: await models.settings() };
      const configured = dshModelSelection(agent, settings);
      const bindings = agent?.spec?.bindings || {}, first = bindings.modelProfileIds?.[0];
      const id = bindings.modelProfileId || (typeof first === 'string' ? first : first?.resourceId);
      return configured || (!local || !id ? undefined : dshModelSelection(agent, settings, { resolvedProfile: await models.profile(id) }));
    },
    getSkillDefinitions: async agent => {
      const bindings = agent?.spec?.bindings || {};
      const ids = (bindings.skills || []).map(item => typeof item === 'string' ? item : item.resourceId || item.id).filter(Boolean);
      const space = bindings.plugins?.find(item => item?.config?.binding?.resource?.kind === 'skill-space')?.config?.binding?.resource;
      if (space) ids.push(space.id || space.resourceId);
      if (!ids.length) return [];
      const adapter = await resourceAdaptersPromise;
      const loaded = await Promise.all([...new Set(ids)].map(id => adapter.loadSkill(id)));
      return loaded.flatMap(item => item.definitions || []);
    },
    getToolContracts: async agent => {
      const bindings = agent?.spec?.bindings && typeof agent.spec.bindings === 'object'
        ? agent.spec.bindings : {};
      const refs = (Array.isArray(bindings.tools) ? bindings.tools : []).map(value => {
        if (typeof value === 'string') return value;
        return value?.resourceId || value?.id || value?.name || '';
      }).filter(Boolean).map(String);
      const mcpBindings = Array.isArray(bindings.mcpServers) ? bindings.mcpServers : [];
      if (!refs.length && !mcpBindings.length) return [];
      const builtinContracts = [];
      if (refs.length) {
        let page;
        try {
          page = await (await serverClientPromise).listCatalogResources({ kind: 'tool', limit: 200 });
        } catch (error) {
          // A local Agent can still be admitted when the optional catalog
          // process is temporarily unavailable. The Python builtin executor
          // remains the final authority and will fail closed for unknown names;
          // this avoids turning a valid binding into “暂不可读取”.
          if (error?.code !== 'CATALOG_UNAVAILABLE' && error?.code !== 'SERVER_UNAVAILABLE') throw error;
          builtinContracts.push(...refs.map(name => ({
            resourceId: name,
            name,
            description: `AgentEngine 内置 Tool：${name}`,
            parameters: { type: 'object', properties: {} },
            executor: 'builtin',
            timeoutSeconds: 20,
            sideEffect: 'none',
            permissions: [],
            enabled: true,
          })));
        }
        if (page) {
          const byRef = new Map();
          for (const item of page.items || []) {
            const contract = item?.contract && typeof item.contract === 'object' ? item.contract : {};
            const resourceId = String(item?.resourceId || item?.id || '').trim();
            const name = String(contract.name || item?.name || resourceId).trim();
            const normalized = {
              resourceId: resourceId || name,
              name,
              description: String(contract.description || item?.description || ''),
              parameters: contract.inputSchema || contract.input_schema || { type: 'object', properties: {} },
              executor: String(contract.executor || 'builtin'),
              timeoutSeconds: Number(contract.timeoutSeconds || contract.timeout_seconds || 20),
              sideEffect: String(contract.sideEffect || contract.side_effect || 'none'),
              permissions: Array.isArray(contract.permissions) ? contract.permissions : [],
              enabled: contract.enabled !== false,
            };
            if (resourceId) byRef.set(resourceId, normalized);
            if (name) byRef.set(name, normalized);
          }
          const missing = refs.filter(ref => !byRef.has(ref));
          if (missing.length) {
            const error = new Error(`绑定的 Tool 不在本地资源目录中：${missing.join(', ')}`);
            error.code = 'BOUND_TOOL_NOT_FOUND';
            error.details = { missing };
            throw error;
          }
          builtinContracts.push(...refs.map(ref => byRef.get(ref)));
        }
      }
      const mcpContracts = [];
      const seenNames = new Set(builtinContracts.map(contract => String(contract?.name || '')));
      const adapters = mcpBindings.length ? await resourceAdaptersPromise : null;
      for (const binding of mcpBindings) {
        const resourceId = String(typeof binding === 'string' ? binding : binding?.resourceId || binding?.id || '').trim();
        if (!resourceId) {
          const error = new Error('MCP 绑定缺少资源 ID');
          error.code = 'MCP_ID_MISSING';
          throw error;
        }
        const listed = await adapters.listMcpTools(binding);
        for (const tool of listed || []) {
          const name = String(tool?.name || '').trim();
          if (!name) continue;
          if (seenNames.has(name)) {
            const error = new Error(`多个绑定资源暴露了同名工具：${name}`);
            error.code = 'MCP_TOOL_NAME_COLLISION';
            error.details = { name, resourceId };
            throw error;
          }
          seenNames.add(name);
          mcpContracts.push({
            resourceId,
            mcpResourceId: resourceId,
            name,
            description: String(tool.description || ''),
            parameters: tool.inputSchema || tool.parameters || { type: 'object', properties: {} },
            executor: 'mcp',
            timeoutSeconds: 120,
            sideEffect: 'unknown',
            permissions: [],
            enabled: true,
          });
        }
      }
      return [...builtinContracts, ...mcpContracts];
    },
  });
  if (presetRegistry) {
    presetAdmission.setRegistry(presetRegistry);
    await restorePersistedPresets();
  }
  const { startFrozenBuildRuntime } = await import('./frozen-build-runtime.mjs');
  const startRuntime = async () => startFrozenBuildRuntime({ ctx, env: runtimeEnv, build: (await studioBuildPromise).build,
    admit: (agentId, frozen) => presetAdmission.ensure(agentId, { agent: { ...frozen, metadata: { ...frozen.metadata, local: true } } }) });
  if (portableRuntime) {
    // Settings writes reconcile the Loader. Awaiting them inside plugin apply
    // deadlocks that reconciliation; use the same public startup boundary as DSH Settings.
    let stopped = false, runtime;
    ctx.effect(() => () => { stopped = true; return runtime?.close(); }, 'agentkit-studio: portable runtime lifetime');
    void ctx.root.loader.await().then(async () => {
      if (stopped) return;
      const { syncPortableModelProfiles } = await import('./portable-model-bridge.mjs');
      await syncPortableModelProfiles({ settings: ctx.get('settings'), profiles: portableRuntime.manifest.resources.profiles });
      if (stopped) return;
      runtime = await startRuntime();
      if (stopped) await runtime?.close();
    }).catch(error => console.error('[agentkit-studio] portable runtime startup failed:', error?.code || 'PORTABLE_STARTUP_FAILED'));
  } else {
    const frozenRuntime = await startRuntime();
    if (frozenRuntime) ctx.effect(() => () => frozenRuntime.close(), 'agentkit-studio: frozen Build runtime');
  }
  const allowed = new Set(['sessions/export-log', 'agents/list', 'agents/create-local', 'agents/update-cloud', 'agents/ensure-preset', 'agents/conversation-surface', 'models/sync-credential', 'models/create', 'models/catalog', 'models/codex', 'resources/list', 'resources/delete', 'mcp/create', 'mcp/update', 'mcp/probe', 'mcp/delete', 'credentials/put', 'settings/get', 'settings/update', 'skills/discover', 'skills/preview-discovered', 'skills/commit-discovered', 'skills/list', 'skills/preview-installed', 'plugins/dsh-list', 'agents/local-get', 'agents/update-local', 'agents/local-delete', 'plugins/dsh-install', 'plugins/dsh-remove', 'plugins/dsh-enable', 'plugins/dsh-disable', 'plugins/dsh-update', 'plugins/codex-list', 'plugins/codex-inspect', 'plugins/codex-install', 'plugins/codex-remove', 'builds/create', 'builds/list', 'builds/download', 'builds/export-portable', 'operations/list', 'operations/cancel', 'schedules/list', 'schedules/create', 'schedules/get', 'schedules/update', 'schedules/delete', 'schedules/run', 'schedules/occurrences', 'traces/overview', 'traces/list', 'traces/get', 'traces/otlp', 'evaluations/list', 'evaluations/create', 'evaluations/get', 'evaluations/targets', 'evaluations/evalsets', 'evaluations/import', 'channels/connection', 'channels/update', 'channels/agent-update', 'channels/action', 'server/action']);
  for (const action of ['prepare', 'create', 'list', 'get', 'refresh', 'repairAccess', 'reconcile', 'logs', 'remove']) allowed.add(`deployments/${action}`);
  const dispatch = async (endpoint, payload, signal) => {
    if (!allowed.has(endpoint)) {
      return { ok: false, error: { code: 'agentkit/not-found', message: 'Unknown AgentKit control endpoint', details: { endpoint } } };
    }
    try {
      if (endpoint.startsWith('deployments/')) {
        const service = await deployments(), action = endpoint.slice('deployments/'.length);
        const value = await service[action](action === 'prepare' || action === 'create' ? payload : String(payload?.deploymentId || ''));
        return { ok: true, value };
      }
      if (endpoint === 'models/sync-credential') return { ok: true, value: await syncModelCredential() };
      if (endpoint === 'models/create') return { ok: true, value: await models.create(payload) };
      if (endpoint === 'settings/get') return { ok: true, value: await models.settings() };
      if (endpoint === 'settings/update') return { ok: true, value: await models.save(payload) };
      if (endpoint === 'models/catalog') return { ok: true, value: await models.catalog(String(payload?.profileId || '')) };
      if (endpoint === 'models/codex') return { ok: true, value: await listCodexAgentModels({ models, catalog: codexModels }) };
      const serverClient = await serverClientPromise;
      if (endpoint === 'resources/list') {
        const kind = String(payload?.kind || '').trim();
        if (!kind || ['model', 'skill', 'mcp', 'knowledge-base', 'memory-instance'].includes(kind)) {
          const { listStudioResources, listStudioRuntimeResources } = await import('./resource-catalog.mjs');
          return { ok: true, value: await (kind ? listStudioResources : listStudioRuntimeResources)({ query: payload, models, serverClient, signal,
            localMcpStore: await localMcpStorePromise, skillDiscovery: await skillDiscoveryPromise, mcpProbes: await mcpProbePromise }) };
        }
        if (kind === 'tool') {
          const value = await serverClient.listCatalogResources({ kind: 'tool', query: payload?.query, limit: payload?.limit, cursor: payload?.cursor, source: payload?.source, status: payload?.status }, { signal });
          return { ok: true, value };
        }
        const resourceKind = kind;
        const value = await serverClient.listResource(resourceKind, { Page: 1, PageSize: Math.min(Number(payload?.limit || 100), 100) }, { signal });
        return { ok: true, value };
      }
      if (endpoint === 'credentials/put') {
        const name = String(payload?.name || '').trim();
        const value = String(payload?.value || '');
        if (!/^[A-Za-z_][A-Za-z0-9_./:-]{0,127}$/.test(name)) return { ok: false, error: { code: 'CREDENTIAL_NAME_INVALID', message: '凭证名称无效', details: {} } };
        if (!value) return { ok: false, error: { code: 'CREDENTIAL_VALUE_MISSING', message: '凭证值不能为空', details: {} } };
        try {
          await credentialsService.set(name, value);
        } catch (error) {
          // Process-injected credentials are intentionally read-only in DSH.
          // The browser may still submit the same name when the value was
          // supplied through the Host environment; acknowledge that existing
          // effective credential without persisting or echoing its value.
          const current = typeof credentialsService.describe === 'function'
            ? await credentialsService.describe(name).catch(() => null)
            : null;
          const effective = current?.configured && current.source === 'env' ? await credentialsService.resolve(name).catch(() => null) : null;
          if (effective?.value !== value) throw error;
          return { ok: true, value: { name, configured: true, source: 'env', persistence: 'process-environment' } };
        }
        return { ok: true, value: { name, configured: true, persistence: 'managed-store' } };
      }
      if (endpoint === 'mcp/create') {
        const localStore = await localMcpStorePromise;
        return { ok: true, value: await localStore.create(payload || {}) };
      }
      if (endpoint === 'mcp/update') {
        const localStore = await localMcpStorePromise;
        const resourceId = String(payload?.resourceId || '').trim();
        return { ok: true, value: await localStore.update(resourceId, payload || {}) };
      }
      if (endpoint === 'mcp/probe') {
        const resourceId = String(payload?.resourceId || '').trim();
        return { ok: true, value: await (await mcpProbePromise).probe(resourceId) };
      }
      if (endpoint === 'mcp/delete' || endpoint === 'resources/delete') {
        const { deleteStudioMcp } = await import('./resource-lifecycle.mjs');
        return { ok: true, value: await deleteStudioMcp(payload, { localStore: await localMcpStorePromise, serverClient: await serverClientPromise }) };
      }
      // Agent catalog reads are now owned by the Studio Node host and call the
      // existing AgentEngine Action API directly. The DSH connection only
      // authenticates the browser-to-host hop; it is not a KsADK dependency.
      if (endpoint === 'agents/local-delete') {
        const store = await agentStorePromise;
        try {
          const record = await store.get(String(payload?.agentId || ''));
          if (!record) return { ok: false, error: { code: 'AGENT_NOT_FOUND', message: '本地 Agent 不存在', details: {} } };
          await store.remove(String(payload.agentId));
          return { ok: true, value: { agentId: String(payload.agentId), deleted: true } };
        } catch (error) {
          return { ok: false, error: { code: error?.code || 'LOCAL_AGENT_FAILED', message: error instanceof Error ? error.message : String(error), details: {} } };
        }
      }
      if (endpoint === 'agents/create-local' || endpoint === 'agents/local-get' || endpoint === 'agents/update-local') {
        const store = await agentStorePromise;
        try {
          if (endpoint === 'agents/create-local') {
            const record = await store.create({
              name: payload?.name,
              runtimeType: payload?.runtimeType || payload?.spec?.runtime?.type || 'dsh-native',
              description: payload?.description || payload?.spec?.description || '',
              spec: payload?.spec || {},
              bindings: payload?.bindings || payload?.spec?.bindings || {},
            });
            return { ok: true, value: { ...record, builds: [] } };
          }
          if (endpoint === 'agents/local-get') return { ok: true, value: await store.get(String(payload?.agentId || '')) };
          const record = await store.update(String(payload?.agentId || ''), {
            name: payload?.name, description: payload?.description,
            spec: payload?.spec, bindings: payload?.bindings,
          });
          return { ok: true, value: { ...record, builds: [] } };
        } catch (error) {
          return { ok: false, error: { code: error?.code || 'LOCAL_AGENT_FAILED', message: error instanceof Error ? error.message : String(error), details: error?.details || {} } };
        }
      }
      if (endpoint === 'agents/update-cloud') {
        const agentId = String(payload?.agentId || '').trim();
        if (!agentId) return { ok: false, error: { code: 'INVALID_AGENT_ID', message: 'AgentId 不能为空', details: {} } };
        const { buildCloudAgentUpdate } = await import('./server-client.mjs');
        const update = buildCloudAgentUpdate(agentId, {
          spec: payload?.spec || {},
          name: payload?.name,
          description: payload?.spec?.description,
        });
        await serverClient.action('UpdateAgent', update, { signal });
        try {
          return { ok: true, value: await serverClient.getAgent(agentId, { signal }) };
        } catch {
          return { ok: true, value: { metadata: { id: agentId, name: update.Name || agentId, revision: Number(payload?.revision || 1) + 1 }, spec: payload?.spec || {} } };
        }
      }
      if (endpoint === 'agents/list') {
        return { ok: true, value: await (await agentCatalogPromise).list(payload, { signal }) };
      }
      if (endpoint === 'agents/ensure-preset') {
        const agentId = String(payload?.agentId || '').trim();
        if (!agentId) return { ok: false, error: { code: 'INVALID_AGENT_ID', message: 'AgentId 不能为空', details: {} } };
        try {
          const localStore = await agentStorePromise;
          const local = await localStore.get(agentId);
          if (!local) await (await deployments()).agents.connect(agentId);
          const buildId = String(payload?.buildId || '').trim();
          const build = buildId ? await (await studioBuildPromise).build.resolve(agentId, buildId) : null;
          // The no-build path remains the original local admission contract:
          // presetAdmission.ensure(agentId, { agent: local }).
          const value = local
            ? await presetAdmission.ensure(agentId, { agent: build ? { ...build, metadata: { ...local.metadata, ...build.metadata, local: true } } : local })
            : await presetAdmission.ensure(agentId);
          return { ok: true, value };
        } catch (error) {
          return { ok: false, error: {
            code: error?.code || 'DSH_PRESET_ADMISSION_FAILED',
            message: error instanceof Error ? error.message : String(error),
            details: error?.details || {},
          } };
        }
      }
      if (endpoint === 'agents/conversation-surface') {
        // A cloud Agent can run through the existing Session/Run Actions. A
        // local Studio Build is not required for this transport; Build is a
        // separate deployment concern and remains explicitly unsupported.
        const agentId = String(payload?.agentId || '').trim();
        if (!agentId) return { ok: false, error: { code: 'INVALID_AGENT_ID', message: 'AgentId 不能为空', details: {} } };
        try {
          const agent = await serverClient.getAgent(agentId, { signal });
          const sessionId = String(payload?.sessionId || '').trim();
          if (!sessionId) return { ok: false, error: { code: 'INVALID_SESSION_ID', message: 'SessionId 不能为空', details: { agentId } } };
          try {
            await serverClient.action('GetSession', { SessionId: sessionId }, { signal });
          } catch (error) {
            if (error?.status !== 404) throw error;
            await serverClient.action('CreateSession', { AgentId: agentId, SessionId: sessionId, Tags: { source: 'agentkit-studio' } }, { signal });
          }
          const history = await serverClient.action('ListSessionEvents', { AgentId: agentId, SessionId: sessionId, Limit: 200 }, { signal });
          return { ok: true, value: { agentId, sessionId, transport: 'agentengine-action', events: history.data?.Events || [], watermark: history.data?.AfterSeqId || 0 } };
        } catch (error) {
          return { ok: false, error: {
            code: error?.code === 'SERVER_ACTION_FAILED' && error?.status === 404 ? 'AGENT_NOT_FOUND' : (error?.code || 'CONVERSATION_SURFACE_FAILED'),
            message: error instanceof Error ? error.message : String(error),
            details: error?.details || {},
          } };
        }
      }
      if (endpoint === 'skills/discover' || endpoint === 'skills/preview-discovered' || endpoint === 'skills/commit-discovered' || endpoint === 'skills/list' || endpoint === 'skills/preview-installed') {
        const skills = await skillDiscoveryPromise;
        try {
          if (endpoint === 'skills/discover') return { ok: true, value: await skills.discover(Array.isArray(payload?.scanPaths) ? payload.scanPaths : null) };
          if (endpoint === 'skills/preview-discovered') return { ok: true, value: await skills.previewDiscovered(payload?.inspectionToken, payload?.candidateId, String(payload?.path || '')) };
          if (endpoint === 'skills/commit-discovered') return { ok: true, value: await skills.commitDiscovered(payload?.inspectionToken, payload?.candidateId, payload?.overwrite === true) };
          if (endpoint === 'skills/list') return { ok: true, value: await skills.listInstalled() };
          return { ok: true, value: await skills.previewInstalled(payload?.resourceId, String(payload?.path || '')) };
        } catch (error) {
          return { ok: false, error: {
            code: error?.code || 'SKILL_DISCOVERY_FAILED',
            message: error instanceof Error ? error.message : String(error),
            details: error?.details || {},
          } };
        }
      }
      if (endpoint.startsWith('plugins/')) {
        try {
          const plugins = await import('./studio-plugins.mjs').then(({ createStudioPlugins }) => createStudioPlugins({ getService: name => ctx.get(name) }));
          if (endpoint === 'plugins/dsh-list') return { ok: true, value: await plugins.listDsh() };
          if (endpoint === 'plugins/dsh-install') return { ok: true, value: await plugins.installDsh(payload?.source, payload?.acceptHostPermissions === true) };
          if (endpoint === 'plugins/dsh-remove') return { ok: true, value: await plugins.uninstallDsh(payload?.pluginName) };
          if (endpoint === 'plugins/dsh-enable' || endpoint === 'plugins/dsh-disable') {
            const plugins = await import('./studio-plugins.mjs').then(({ createStudioPlugins }) => createStudioPlugins({ getService: name => ctx.get(name) }));
            return { ok: true, value: await plugins.setDshEnabled(payload?.pluginName, endpoint === 'plugins/dsh-enable') };
          }
          if (endpoint === 'plugins/dsh-update') {
            const plugins = await import('./studio-plugins.mjs').then(({ createStudioPlugins }) => createStudioPlugins({ getService: name => ctx.get(name) }));
            return { ok: true, value: await plugins.updateDsh(payload?.pluginName) };
          }
          if (endpoint === 'plugins/codex-install' || endpoint === 'plugins/codex-remove') {
            const codex = await import('./studio-codex-plugins.mjs').then(({ createStudioCodexPlugins }) => createStudioCodexPlugins({}));
            const result = endpoint === 'plugins/codex-install'
              ? await codex.installCodex(payload?.pluginId, payload?.marketplaceName)
              : await codex.uninstallCodex(payload?.pluginId, payload?.marketplaceName);
            return { ok: true, value: result };
          }
          if (endpoint === 'plugins/codex-list' || endpoint === 'plugins/codex-inspect') return { ok: true, value: await import('./studio-codex-plugins.mjs').then(({ createStudioCodexPlugins }) => createStudioCodexPlugins({})).then(codex => endpoint === 'plugins/codex-inspect' ? codex.inspectCodex(payload?.pluginId) : codex.listCodex()) };
        } catch (error) {
          return { ok: false, error: { code: error?.code || 'PLUGIN_ECOSYSTEM_FAILED', message: error instanceof Error ? error.message : String(error), details: error?.details || {} } };
        }
      }
      if (endpoint === 'builds/create' || endpoint === 'builds/list' || endpoint === 'builds/download' || endpoint === 'builds/export-portable' || endpoint === 'operations/list' || endpoint === 'operations/cancel') {
        const studio = await studioBuildPromise;
        try {
          if (endpoint === 'builds/create') {
            const { submitAgentBuild } = await import('./build-operation.mjs');
            return { ok: true, value: await submitAgentBuild({ payload, localStore: await agentStorePromise, serverClient, ...studio, signal }) };
          }
          if (endpoint === 'builds/list') {
            const agentId = String(payload?.agentId || '').trim();
            if (!agentId) return { ok: true, value: { items: [] } };
            return { ok: true, value: { items: await studio.build.list(agentId) } };
          }
          if (endpoint === 'builds/export-portable') {
            try { return { ok: true, value: await portableBundles.prepare(String(payload?.agentId || ''), String(payload?.buildId || '')) }; }
            catch (error) { return { ok: false, error: { code: error?.code || 'PORTABLE_EXPORT_FAILED', message: error?.code?.startsWith('PORTABLE_') ? error.message : '运行包导出失败，请检查绑定的资源是否可读取', details: {} } }; }
          }
          if (endpoint === 'builds/download') return { ok: true, value: await studio.build.download(String(payload?.agentId || ''), String(payload?.buildId || '')) };
          if (endpoint === 'operations/list') {
            const items = await studio.operations.list({ resourceId: String(payload?.resourceId || '') || undefined, kind: String(payload?.kind || '') || undefined });
            return { ok: true, value: { items } };
          }
          const operation = await studio.operations.cancel(String(payload?.operationId || ''));
          return { ok: true, value: operation };
        } catch (error) {
          return { ok: false, error: {
            code: error?.code || 'STUDIO_OPERATION_FAILED',
            message: error instanceof Error ? error.message : String(error),
            details: error?.details || {},
          } };
        }
      }
      if (endpoint === 'sessions/export-log') {
        const sessionId = String(payload?.sessionId || '').trim();
        if (!sessionId) throw Object.assign(new Error('Session ID 不能为空'), { code: 'SESSION_ID_MISSING' });
        const { readSessionLogText, flushLiveSessionLog, sessionLogExportDeps } = await import('@deepseek-ai/dsh-session-log-export');
        const deps = sessionLogExportDeps(ctx);
        if (!deps.sessionPersistence) throw Object.assign(new Error('DSH Session 持久化不可用'), { code: 'SESSION_EXPORT_UNAVAILABLE' });
        await flushLiveSessionLog(deps, sessionId, signal);
        const content = await readSessionLogText(deps.sessionPersistence, sessionId, signal);
        if (content === undefined) throw Object.assign(new Error('Session 不存在'), { code: 'SESSION_NOT_FOUND' });
        if (Buffer.byteLength(content) > 8 * 1024 * 1024) throw Object.assign(new Error('会话日志超过 8 MiB，请从原生会话使用 /export 导出完整 ZIP'), { code: 'SESSION_EXPORT_TOO_LARGE' });
        return { ok: true, value: { content, filename: `dsh-session-${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.jsonl`, contentType: 'application/x-ndjson' } };
      }
      if (endpoint.startsWith('schedules/') || endpoint.startsWith('traces/') || endpoint.startsWith('evaluations/') || endpoint.startsWith('channels/')) {
        try {
          if (endpoint.startsWith('schedules/')) {
            const scheduler = await studioSchedulerPromise;
            if (!scheduler) return { ok: false, error: { code: 'SCHEDULER_UNAVAILABLE', message: '调度器未初始化', details: {} } };
            if (endpoint === 'schedules/list') {
              const native = ctx.get('schedule');
              return { ok: true, value: { items: await scheduler.listSchedules(payload?.agentId || undefined), nativeItems: native?.catalog ? await native.catalog() : [], availability: { ...scheduler.availability(), nativeScheduleAvailable: Boolean(native?.catalog) } } };
            }
            if (endpoint === 'schedules/create') return { ok: true, value: await scheduler.createSchedule(payload?.agentId || '', payload?.spec || payload) };
            if (endpoint === 'schedules/get') return { ok: true, value: await scheduler.getSchedule(payload?.taskId) };
            if (endpoint === 'schedules/update') return { ok: true, value: await scheduler.updateSchedule(payload?.taskId, { ...(payload?.patch || payload), ...(payload?.agentId ? { agentId: payload.agentId } : {}) }) };
            if (endpoint === 'schedules/delete') return { ok: true, value: await scheduler.deleteSchedule(payload?.taskId) };
            if (endpoint === 'schedules/run') return { ok: true, value: await scheduler.runNow(payload?.taskId) };
            if (endpoint === 'schedules/occurrences') return { ok: true, value: { items: await scheduler.listOccurrences(payload?.taskId, payload?.agentId) } };
          }
          if (endpoint.startsWith('traces/')) {
            const observability = await studioObservabilityPromise;
            if (!observability) return { ok: false, error: { code: 'OBSERVABILITY_UNAVAILABLE', message: '观测模块未初始化', details: {} } };
            if (endpoint === 'traces/overview') {
              const local = await observability.overview(payload || {});
              try {
                const cloud = await serverClient.getObservabilityOverview({ range: payload?.range || '24h' }, { signal });
                const summary = cloud?.Summary || {};
                return { ok: true, value: { ...local, cloud: { sessionCount: summary.SessionCount, tokenCount: summary.TokenCount, agentRuntimeCount: summary.AgentRuntimeCount, errorCount: summary.ErrorCount, errorRate: summary.ErrorRate } } };
              } catch { return { ok: true, value: local }; }
            }
            if (endpoint === 'traces/list') return { ok: true, value: await observability.list(payload || {}) };
            if (endpoint === 'traces/get') return { ok: true, value: await observability.get(payload?.traceId) };
            if (endpoint === 'traces/otlp') return { ok: true, value: await observability.getOtlp(payload?.traceId) };
          }
          if (endpoint.startsWith('evaluations/')) {
            const evaluation = await studioEvaluationPromise;
            if (!evaluation) return { ok: false, error: { code: 'EVALUATION_UNAVAILABLE', message: '评测模块未初始化', details: {} } };
            if (endpoint === 'evaluations/list') return { ok: true, value: await evaluation.listRuns(payload || {}) };
            if (endpoint === 'evaluations/get') return { ok: true, value: await evaluation.getRun(payload?.runId) };
            if (endpoint === 'evaluations/targets') return { ok: true, value: await evaluation.listTargets({ builds: await listLocalBuildTargets() }) };
            if (endpoint === 'evaluations/evalsets') return { ok: true, value: await evaluation.listEvalsets() };
            if (endpoint === 'evaluations/import') return { ok: true, value: await evaluation.importEvalset({ content: payload?.content, fileName: payload?.fileName }) };
            if (endpoint === 'evaluations/create') return { ok: true, value: await evaluation.createEvaluation(payload || {}) };
          }
          if (endpoint.startsWith('channels/')) {
            const channels = await studioChannelsPromise;
            if (!channels) return { ok: false, error: { code: 'CHANNELS_UNAVAILABLE', message: '渠道模块未初始化', details: {} } };
            if (endpoint === 'channels/connection') return { ok: true, value: await channels.getConnection() };
            if (endpoint === 'channels/update') return { ok: true, value: await channels.updateConnection(payload || {}) };
            if (endpoint === 'channels/agent-update') return { ok: true, value: await channels.updateAgentConnection(payload?.agentId, payload || {}) };
            if (endpoint === 'channels/action') return { ok: true, value: await channels.proxyAction(payload?.action || '', payload?.payload || {}) };
          }
        } catch (error) {
          return { ok: false, error: { code: error?.code || 'STUDIO_LOCAL_FAILED', message: error instanceof Error ? error.message : String(error), details: error?.details || {} } };
        }
      }
      if (endpoint === 'server/action') {
        const action = String(payload?.action || '');
        const body = payload?.payload && typeof payload.payload === 'object' ? payload.payload : {};
        if (action === 'settings/get') return { ok: true, value: await models.settings() };
        if (action === 'settings/update') return { ok: true, value: await models.save(body) };
        if (action === 'models/catalog') return { ok: true, value: await models.catalog(String(body.profileId || '')) };
        if (action === 'models/sync-credential') return { ok: true, value: await syncModelCredential() };
        if (action === 'GetAgent') {
          const value = await serverClient.getAgent(String(body.AgentId || body.agentId || ''));
          return { ok: true, value };
        }
        const resourceKinds = { ListKnowledgeBases: 'knowledge-base', ListMemoryInstances: 'memory-instance', ListMCPs: 'mcp', ListSkillWorkspaces: 'skill-space' };
        if (resourceKinds[action]) {
          const value = await serverClient.listResource(resourceKinds[action], body);
          return { ok: true, value };
        }
        const value = await serverClient.action(action, body);
        return { ok: true, value: value.data, requestId: value.requestId };
      }
    } catch (error) {
      if (signal?.aborted) return { ok: false, error: { code: 'gateway/cancelled', message: 'AgentKit request cancelled', details: {} } };
      return { ok: false, error: { code: error?.code || 'agentkit/server-unavailable', message: error instanceof Error ? error.message : String(error), details: { status: error?.status || 0 } } };
    }
  };
  // HostConnectionService's dedicated-RPC helper owns its registration fiber;
  // the plugin uses the same public Connection admission and WebServer route
  // boundary directly so this optional control plane can coexist with DSH's
  // single shared /api Typert interceptor.
  const { createModelProxyHandler } = await import('./model-proxy-handler.mjs');
  ctx.inject(['connection', 'webServer'], (webCtx) => {
    const modelRoute = webCtx.webServer.register({ kind: 'prefix', path: '/agentkit/models/', handler: createModelProxyHandler({ models, admit: request => webCtx.connection.admit(request) }) });
    webCtx.effect(() => modelRoute, 'agentkit-studio: model compatibility route');
    const registration = webCtx.webServer.register({
      kind: 'prefix',
      path: CONTROL_CHANNEL,
      handler: async (request, response) => {
        const admission = webCtx.connection.admit(request);
        if ('rejection' in admission) {
          response.writeHead(admission.rejection);
          response.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden');
          return;
        }
        if (request.method !== 'POST') {
          response.writeHead(404);
          response.end('not found');
          return;
        }
        const chunks = [];
        let size = 0;
        try {
          for await (const chunk of request) {
            size += chunk.length;
            if (size > 1024 * 1024) {
              response.writeHead(413);
              response.end('request too large');
              return;
            }
            chunks.push(chunk);
          }
          const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const endpoint = String(message?.method || '');
          // The node IncomingMessage is already at EOF after the JSON body is
          // read; its abort signal may be marked closed even though the RPC
          // caller is still waiting for the response.  The catalog request is
          // bounded by the Host's own timeout and must not be cancelled here.
          const result = await dispatch(endpoint, message?.payload, undefined);
          response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          response.end(JSON.stringify({ type: 'server-response', rpcId: String(message?.rpcId || ''), result }));
        } catch (error) {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ type: 'server-response', rpcId: '', result: {
            ok: false,
            error: { code: 'agentkit/bad-request', message: error instanceof Error ? error.message : String(error), details: {} },
          } }));
        }
      },
    });
    const localRoute = webCtx.webServer.register({
      kind: 'prefix',
      path: '/agentkit/local-conversation',
      handler: (request, response) => {
        const admission = webCtx.connection.admit(request);
        if ('rejection' in admission) { response.writeHead(admission.rejection); response.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden'); return; }
        const controller = new AbortController();
        const disconnect = () => { if (!response.writableEnded) controller.abort(); };
        response.on?.('close', disconnect);
        void Promise.all([agentStorePromise, configurationPromise, resourceAdaptersPromise, studioObservabilityPromise]).then(async ([store, configuration, resourceAdapters, observability]) => {
          const credentials = ctx.get('credentials');
          const models = await import('./model-service.mjs').then(({ createModelService }) => createModelService({ configuration, credentials }));
          const { createLocalConversationHandler } = await import('./local-runtime.mjs');
          return createLocalConversationHandler({ agentStore: async () => store, modelService: models, resourceAdapter: resourceAdapters, observability });
        }).then(handler => handler(request, response, { signal: controller.signal })).catch(error => {
          console.error('[local-runtime] handler failed:', error?.stack || error);
          if (response.destroyed) return;
          if (!response.headersSent) response.writeHead(500);
          response.end(JSON.stringify({ error: { message: String(error?.message || error).slice(0, 200) } }));
        }).finally(() => response.off?.('close', disconnect));
      },
    });
    const cloudConversationRoute = webCtx.webServer.register({
      kind: 'prefix',
      path: '/agentkit/cloud-conversation',
      handler: async (request, response) => {
        const admission = webCtx.connection.admit(request);
        if ('rejection' in admission) { response.writeHead(admission.rejection); response.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden'); return; }
        if (request.method !== 'POST') { response.writeHead(404); response.end('not found'); return; }
        const controller = new AbortController();
        const disconnect = () => { if (!response.writableEnded) controller.abort(); };
        response.on?.('close', disconnect);
        const chunks = []; let size = 0;
        try {
          for await (const chunk of request) {
            size += chunk.length;
            if (size > 1024 * 1024) { response.writeHead(413); response.end('request too large'); return; }
            chunks.push(chunk);
          }
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const agentId = String(body?.agentId || '').trim();
          const sessionId = String(body?.sessionId || '').trim();
          const input = body?.input;
          const text = Array.isArray(input?.parts) ? input.parts.filter(part => part?.kind === 'text').map(part => part.text || '').join('') : String(input?.input || input || '');
          if (!agentId || !sessionId || !text.trim()) throw Object.assign(new Error('AgentId、SessionId 和文本输入不能为空'), { code: 'INVALID_CONVERSATION_INPUT' });
          const client = await serverClientPromise;
          const upstream = await client.streamAction('RunAgent', {
            AgentId: agentId, SessionId: sessionId, Messages: [{ role: 'user', content: text }],
            Stream: true, ApiFormat: 'responses', InvocationId: String(input?.inputId || body?.idempotencyKey || ''),
          }, { signal: controller.signal });
          response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
          for await (const chunk of upstream.body) response.write(chunk);
          response.end();
        } catch (error) {
          if (response.destroyed) return;
          if (!response.headersSent) response.writeHead(error?.status || 502, { 'content-type': 'application/json' });
          if (!response.writableEnded) response.end(JSON.stringify({ error: { code: error?.code || 'CLOUD_CONVERSATION_FAILED', message: error instanceof Error ? error.message : String(error) } }));
        } finally {
          response.off?.('close', disconnect);
        }
      },
    });
    webCtx.effect(() => localRoute, 'agentkit-studio: local conversation route');
    webCtx.effect(() => cloudConversationRoute, 'agentkit-studio: cloud conversation route');
    webCtx.effect(() => registration, 'agentkit-studio: control-plane route');
  });
  // Authoring tools need the in-process remote factory (cloud/resource data);
  // they live here because that factory is scoped to this function.
  registerAuthoringTools(ctx, { remoteFactory: authoringRemoteFactory });
  ctx.effect(async () => { const channels = await studioChannelsPromise; await channels?.ensureReady(); return () => channels?.dispose(); }, 'agentkit-studio: channels lifetime');
  ctx.effect(async () => { const scheduler = await studioSchedulerPromise; await scheduler?.ensureReady(); return () => scheduler?.dispose(); }, 'agentkit-studio: scheduler lifetime');
}

export async function apply(ctx) {
  await registerControlPlane(ctx);
  ctx.on('webserver/index-inject', table => table.push({
    kind: 'global',
    name: '__AGENTKIT_STUDIO__',
    value: {
      version: '0.0.1',
      // Allow an isolated release-candidate process to report its own DSH
      // version without rebuilding the plugin artifact.
      dshVersion: runtimeEnv.AGENTKIT_STUDIO_DSH_VERSION || '0.2.0-rc.2',
      hostUrl: runtimeEnv.AGENTKIT_STUDIO_HOST_URL || 'http://127.0.0.1:8789',
      controlPlane: 'agentengine-server',
      // The Studio Host owns this short-lived local session token. It is not
      // a model or cloud credential; the browser exchanges it once for CSRF.
      sessionToken: runtimeEnv.AGENTKIT_STUDIO_HOST_SESSION_TOKEN || null,
    },
  }));
  // The DSH application owns the browser document, so a React panel cannot
  // reliably replace its favicon from the plugin sandbox.  Use the public
  // webserver index injection seam to install the product mark in the
  // top-level document after the shell's own links have been parsed.
  ctx.on('webserver/index-inject', table => table.push({
    kind: 'script',
    placement: 'head',
    text: `(() => {
      const href = 'data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="29" fill="#f7ffff" stroke="#0aa6a6" stroke-width="2"/><path d="M32 6 7 54h11l5-10h18l5 10h11L32 6Zm0 18 5 10H27l5-10Z" fill="#0aa6a6"/></svg>')}'
      const apply = () => {
        document.querySelectorAll('link[rel~="icon"]:not([data-agentkit-studio-favicon])').forEach(link => link.remove())
        let link = document.querySelector('link[data-agentkit-studio-favicon]')
        if (!link) {
          link = document.createElement('link')
          link.dataset.agentkitStudioFavicon = 'true'
          document.head.append(link)
        }
        link.rel = 'icon'
        link.type = 'image/svg+xml'
        link.href = href
      }
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply, { once: true })
      else apply()
    })()`
  }));
}

export default {
  name,
  inject,
  apply,
};
