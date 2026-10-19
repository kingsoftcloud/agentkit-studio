/** Trusted Host startup and scoped dependency composition. Domain services
 * own their stores; route modules own RPC and HTTP transport adapters.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { registerAuthoringTools } from '../authoring-tools.mjs';
import { DshPresetAdmission, dshModelSelection } from '../agent-preset-admission.mjs';
import { createStartupReconciler } from '../preset-recovery.mjs';
import { bindPresetRegistry } from '../preset-registry-binding.mjs';
import { mountRuntimeBridge } from './runtime-bridge.mjs';
import { createStudioServices } from './services/index.mjs';
import { createStudioRoutes } from './routes/index.mjs';
import { createControlPlaneDispatcher } from './routes/dispatcher.mjs';
import { registerControlPlaneRoutes } from './routes/http.mjs';
import { registerBuildDownload } from './routes/download.mjs';
import { createAgentModelSelection } from './services/model-selection.mjs';
import { createLegacyLocalConversationFactory } from './services/legacy-conversation.mjs';
import { loadHostCompatibility } from './compatibility.mjs';
import { bindFrozenRuntime } from './frozen-runtime-lifecycle.mjs';

export async function mountStudioHost(ctx, { env: runtimeEnv = process.env, configurationHome, resourceAdapterFactory } = {}) {
  const hostCompatibility = await loadHostCompatibility(ctx);
  ctx.provide('studioHostCompatibility', hostCompatibility);
  const cloudEndpointOptions = {
    innerKopUrl: runtimeEnv.AGENTENGINE_INNER_KOP_URL || '',
    innerIamUrl: runtimeEnv.AGENTENGINE_INNER_IAM_URL || '',
  };
  const bridge = mountRuntimeBridge(ctx);
  // Keep Node-only configuration and HTTPS/KOP dependencies out of the
  // browser-facing plugin module graph. DSH loads this module for both the
  // Host and client faces; importing node:fs or aws4 at activation time makes
  // the whole plugin fail before the Host route can be registered.
  const { loadPortableRuntime, createPortableBundles } = await import('../portable-bundle.mjs');
  const portableRuntime = await loadPortableRuntime(runtimeEnv.AGENTKIT_HOME, runtimeEnv);
  const studioStoreDir = join(runtimeEnv.AGENTKIT_HOME || join(homedir(), '.agentkit'), 'studio');
  let templateServices, teamTemplates;
  const services = createStudioServices(ctx, {
    env: runtimeEnv, storeDir: studioStoreDir, portableRuntime, cloudEndpointOptions, configurationHome, resourceAdapterFactory, hostCompatibility,
    getTemplateAuthoring: () => templateServices?.templateAuthoring, getAdmission: () => presetAdmission, getModels: () => models, getPortableBundles: () => portableBundles,
  });
  const {
    studioBuildPromise, agentStorePromise, agentCatalogPromise, listLocalBuildTargets,
    skillDiscoveryPromise, localMcpStorePromise, mcpProbePromise, resourceAdaptersPromise,
    configurationPromise, credentialsService, serverClientPromise, deploymentClientPromise,
    studioSchedulerPromise, studioObservabilityPromise, studioEvaluationPromise,
    studioChannelsPromise, cloudSchedulesPromise, authoringRemoteFactory, deployments,
  } = services;
  await registerBuildDownload(ctx, { studioBuildPromise, getPortableBundles: () => portableBundles });
  // Studio-owned revisions still enter through DSH's native Session/Loop.
  // The provider is selected by the preset-scoped listener and delegates the
  // assembled turn to the local Harness or AgentEngine cloud stream.
  const { createDshRuntimeAdapter, routeDshRuntime: routeRuntime } = await import('../providers/dsh-runtime.mjs');
  const { LlmAdapter } = await import('@deepseek-ai/dsh-llm');
  // Codex is a native App Server runtime, not another gateway model. Keep its
  // optional child-process boundary lazy so Studio can still load on hosts
  // without a Codex binary and report CODEX_PROVIDER_UNAVAILABLE only when a
  // Codex Agent is selected.
  const { createCodexRuntime } = await import('../providers/codex-runtime.mjs');
  const { createCodexModelCatalog, createCodexModelAdapter, CODEX_PROVIDER } = await import('../providers/codex-models.mjs');
  const { resolveConfiguredCodexModel, selectCodexAgentModel, listCodexAgentModels } = await import('../providers/codex-configured-models.mjs');
  const codexOptions = portableRuntime
    ? await import('../portable-codex.mjs').then(({ portableCodexOptions }) => portableCodexOptions({ home: runtimeEnv.AGENTKIT_HOME, manifest: portableRuntime.manifest, env: runtimeEnv }))
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
        const localModels = await import('../model-service.mjs').then(({ createModelService }) => createModelService({ configuration, credentials: credentialsService }));
        const { createLocalConversationHandler } = await import('../local-runtime.mjs');
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
  const { createCodexResourceContext } = await import('../providers/codex-resource-context.mjs');
  const codexResourceContext = createCodexResourceContext({ agentStore: agentStorePromise, builds: studioBuildPromise, resources: resourceAdaptersPromise });
  const { CLOUD_PROVIDER, createDeploymentModelAdapter } = await import('../deployment-agents.mjs');
  const { createDeploymentConversation } = await import('../deployment-conversation.mjs');
  const dshRuntimeAdapter = createDshRuntimeAdapter({
    bridge,
    AdapterBase: LlmAdapter,
    attachments: () => ctx.get('attachments'),
    cloudRuntime: createDeploymentConversation({ agents: async () => (await deployments()).agents, observability: await studioObservabilityPromise, fetchImpl: services.runtimeFetch }),
    localHandler: localRuntimeHandler,
    codexRuntime,
    resolveCodexModel: selection => resolveConfiguredCodexModel(selection, models),
    codexResourceContext,
    resourceAdapter: await resourceAdaptersPromise,
    observability: await studioObservabilityPromise,
  });
  ctx.effect(() => bridge.setAdapter(dshRuntimeAdapter), 'agentkit-studio: runtime transport registration');
  const routeDshRuntime = (options, next) => routeRuntime(options, next, bridge);
  ctx.on('llm/stream', routeDshRuntime);
  ctx.effect(() => bridge.setResourceToolExecutor(async ({ resourceId, name, arguments: args = {}, signal } = {}) => {
    const adapters = await resourceAdaptersPromise;
    if (typeof adapters?.callMcpTool !== 'function') {
      const error = new Error('AgentKit Studio MCP 资源适配器不可用');
      error.code = 'MCP_RESOURCE_ADAPTER_MISSING';
      throw error;
    }
    return adapters.callMcpTool(resourceId, name, args, { signal });
  }), 'agentkit-studio: resource tool registration');
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
  const models = await import('../model-service.mjs').then(({ createModelService }) => configurationPromise.then(configuration => createModelService({ configuration, credentials })));
  const { describeGlobalModelCredential } = await import('../model-credential-sync.mjs');
  const portableBundles = createPortableBundles({ storeDir: studioStoreDir, build: (await studioBuildPromise).build, models,
    adapters: await resourceAdaptersPromise, configuration: await configurationPromise });
  templateServices = await (await import('./services/templates.mjs')).createTemplateServices(ctx, {
    ...services, storeDir: studioStoreDir, env: runtimeEnv, models, listCodexAgentModels, codexModels, getTeamTemplates: () => teamTemplates,
  });
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
  let presetAdmission;
  // DSH restores a Session's selected preset before the browser can issue a
  // fresh agents/ensure-preset RPC, and honors session.create calls carrying
  // an inherited agentPreset. Startup reconciliation therefore re-registers
  // every dynamic agentkit-studio-agent-* preset; apply() waits for it below.
  const reconciler = createStartupReconciler({
    store: agentStorePromise, build: studioBuildPromise, deployments,
    getAdmission: () => presetAdmission,
  });
  const createPresetAdmission = registry => new DshPresetAdmission({
    registry,
    assertHostCompatible: () => hostCompatibility.require('agent-presets'),
    getBasePlugins: async agent => {
      if (typeof registry?.pluginsFor !== 'function') throw Object.assign(new Error('DSH preset composition snapshot is unavailable; apply the pinned Studio patch series'), { code: 'DSH_PRESET_COMPOSITION_UNAVAILABLE' });
      const plugins = await registry.pluginsFor('standard');
      return agent.metadata?.teamRole ? (await import('../studio-team-composition.mjs')).teamBasePlugins(plugins) : plugins;
    },
    getAgent: async agentId => (await deployments()).agents.get(agentId),
    getActiveModel: async () => (await configurationPromise).resolve(),
    getModelSelection: createAgentModelSelection({ models, agentStorePromise, codexModels, selectCodexAgentModel, CLOUD_PROVIDER, dshModelSelection }),
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
  const teamRuntime = (await import('../studio-team-runtime.mjs')).ensureStudioTeamRuntime(ctx);
  const studioTeams = (await import('../studio-teams.mjs')).createStudioTeams({ ctx, runtimeReady: teamRuntime, directory: join(studioStoreDir,'teams'), agents: await agentStorePromise, getAdmission: () => presetAdmission });
  teamTemplates = (await import('../team-template-summon.mjs')).createTeamTemplateSummon({ catalog: templateServices.templateCatalog, summon: templateServices.templateSummon, teams: studioTeams });
  presetAdmission = createPresetAdmission();
  // Cordis unloads and reruns this scope when the registry changes. An old
  // scope must dispose its own admission, never whichever admission is current
  // after an asynchronous reload. Catalog-only profiles retain typed failures.
  bindPresetRegistry(ctx, { createAdmission: createPresetAdmission,
    publishAdmission: admission => { presetAdmission = admission; },
    reconcile: async admission => { await reconciler.run(admission); await studioTeams.restore(admission); },
  });
  const { startFrozenBuildRuntime } = await import('../frozen-build-runtime.mjs');
  const bindRuntime = () => bindFrozenRuntime(ctx, {
    start: async runtimeCtx => startFrozenBuildRuntime({ ctx: runtimeCtx, env: runtimeEnv, hostCompatibility, modelService: models, resources: () => resourceAdaptersPromise, build: (await studioBuildPromise).build,
      admit: (agentId, frozen) => presetAdmission.ensure(agentId, { agent: { ...frozen, metadata: { ...frozen.metadata, local: true } } }) }),
    onUnavailable: error => console.warn('[agentkit-studio] frozen runtime unavailable:', error.message),
  });
  if (portableRuntime) {
    // Settings writes reconcile the Loader. Awaiting them inside plugin apply
    // deadlocks that reconciliation; use the same public startup boundary as DSH Settings.
    let stopped = false;
    ctx.effect(() => () => { stopped = true; }, 'agentkit-studio: portable runtime startup');
    void ctx.root.loader.await().then(async () => {
      if (stopped) return;
      const { syncPortableModelProfiles } = await import('../portable-model-bridge.mjs');
      await syncPortableModelProfiles({ settings: ctx.get('settings'), profiles: portableRuntime.manifest.resources.profiles });
      if (stopped) return;
      await bindRuntime();
    }).catch(error => console.error('[agentkit-studio] portable runtime startup failed:', error?.code || 'PORTABLE_STARTUP_FAILED'));
  } else {
    await bindRuntime();
  }
  const routes = createStudioRoutes(ctx, {
    ...services, ...templateServices, assistantStoreDir: join(studioStoreDir, 'assistant-deletions'), studioTeams, teamTemplates, models, syncModelCredential, hostCompatibility,
    describeGlobalModelCredential: options => describeGlobalModelCredential({ ...options, env: runtimeEnv }),
    listCodexAgentModels, codexModels, portableBundles, getAdmission: () => presetAdmission,
  });
  const dispatch = createControlPlaneDispatcher({ bridge, serverClientPromise, routes });
  const getLegacyLocalConversationHandler = createLegacyLocalConversationFactory(ctx, services);
  await registerControlPlaneRoutes(ctx, { ...services, models, dispatch, getLegacyLocalConversationHandler });
  // Authoring tools need the in-process remote factory (cloud/resource data);
  // they live here because that factory is scoped to this function.
  registerAuthoringTools(ctx, { remoteFactory: authoringRemoteFactory });
  ctx.effect(async () => { const channels = await studioChannelsPromise; await channels?.ensureReady(); return () => channels?.dispose(); }, 'agentkit-studio: channels lifetime');
  ctx.effect(async () => { const scheduler = await studioSchedulerPromise; await scheduler?.ensureReady(); return () => scheduler?.dispose(); }, 'agentkit-studio: scheduler lifetime');
  ctx.effect(() => () => bridge.close(), 'agentkit-studio: stop owned runtime requests');
}
