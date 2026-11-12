import { hostFetch } from '../http-fetch.mjs';
/** Trusted Host startup and scoped dependency composition. Domain services
 * own their stores; route modules own RPC and HTTP transport adapters.
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { NATIVE_MCP_JSON_CODEC } from '../providers/native-mcp-json.mjs';
import { snapshotNativeMcpSchema, snapshotNativeMcpPlanAccess } from '../providers/native-mcp-schema.mjs';
import { NATIVE_DSH_TURN_CONTRACT } from '@kingsoftcloud/agentkit-harness-node/native/dsh-turn-contract';
import { nativeHarnessHostContract, selectedNativeBuildContract } from '../build-engine.mjs';
import { loadConfiguredNativeSkills } from '../providers/native-skill-source.mjs';
import { nativeLocalToolContract } from '../native-tool-catalog.mjs';
import { registerAuthoringTools } from '../authoring-tools.mjs';
import { DshPresetAdmission, dshModelSelection } from '../agent-preset-admission.mjs';
import { createStartupReconciler } from '../preset-recovery.mjs';
import { bindPresetRegistry } from '../preset-registry-binding.mjs';
import { mountRuntimeBridge, ownAsyncResource } from './runtime-bridge.mjs';
import { createStudioServices } from './services/index.mjs';
import { alignProfileProductPlugin } from './profile-plugin-alignment.mjs';
import { createStudioRoutes } from './routes/index.mjs';
import { createControlPlaneDispatcher } from './routes/dispatcher.mjs';
import { registerControlPlaneRoutes } from './routes/http.mjs';
import { registerBuildDownload } from './routes/download.mjs';
import { createAgentModelSelection } from './services/model-selection.mjs';
import { createCloudExecutionModes } from '../cloud-execution-modes.mjs';
import { loadHostCompatibility } from './compatibility.mjs';
import { bindFrozenRuntime, FROZEN_RUNTIME_READY } from './frozen-runtime-lifecycle.mjs';
import { bindNativeBackgroundRuntime } from './native-background-lifecycle.mjs';
import { createStudioA2aSessionSink } from './services/a2a-session-events.mjs';
import { boundSkillResources, loadBoundSkillDefinitions } from '../skill-bindings.mjs';
import { createPromptPredictionHost } from '../prompt-prediction/host.mjs';

/**
 * Report the composed Agent preset once the registry resolves it.
 *
 * Bash background execution is a *composition* property, not a configuration
 * one: `@deepseek-ai/dsh-tool-bash` exposes `run_in_background` and promotes a
 * foreground command that reaches its deadline into a background job, while the
 * PTY `@deepseek-ai/dsh-terminal-bash` only settles a hard `timeout` and kills
 * the command. The managed runtime therefore cannot tell from its own settings
 * which of the two it runs with, and a 300s command failure is indistinguishable
 * from a model or transport timeout. Log the resolved composition so a red run
 * names the bash tool, the job service, and whether promotion is reachable.
 * @param ctx - the Host context resolving the composed services.
 * @param plugins - the plugin list the preset registry returned.
 */
export function logPresetComposition(ctx, plugins) {
  try {
    const names = (Array.isArray(plugins) ? plugins : [])
      .map(entry => String(entry?.name || entry?.id || '')).filter(Boolean);
    let jobs;
    try { jobs = ctx.get('jobs'); } catch { jobs = undefined; }
    console.info('[agentkit-studio] preset composition', JSON.stringify({
      requested: 'standard',
      pluginCount: names.length,
      bashTools: names.filter(name => /(?:tool-bash|terminal-bash|bash-persistent)$/.test(name)),
      jobsService: jobs !== undefined && jobs !== null,
      backgroundPromotion: names.includes('@deepseek-ai/dsh-tool-bash'),
    }));
  } catch (error) {
    // A diagnostic must never turn a working preset into a failed turn.
    console.warn('[agentkit-studio] preset composition probe failed:', error?.message || error);
  }
}

/**
 * Name the archive path that cancels a running turn.
 *
 * DSH publishes `workspace/session-stop` while archiving a Session, and its
 * archive admission answers by cancelling the live Agent with
 * `{kind: 'user'}` — indistinguishable in `turn/end` from the user's own stop
 * button. Record the session so a cancelled turn names the archiving path
 * instead of leaving only the cancellation cause.
 * @param ctx - the Host context carrying the workspace service.
 */
function observeSessionStop(ctx) {
  try {
    ctx.on('workspace/session-stop', request => {
      try {
        console.info('[agentkit-studio] session stop', JSON.stringify({
          source: 'workspace/session-stop',
          sessionId: String(request?.sessionId || ''),
        }));
      } catch { /* diagnostics never fail a stop */ }
    });
  } catch (error) {
    // An older DSH without the workspace registry keeps every other path working.
    console.warn('[agentkit-studio] session stop probe unavailable:', error?.message || error);
  }
}

/**
 * Name the caller of a long `AbortSignal.timeout` deadline.
 *
 * A deadline that fires inside `build-runtime-http.mjs` surfaces as a
 * `DOMException` `TimeoutError` whose stack is only the timer callback, so the
 * duration is the sole clue and every layer looks equally guilty. Trace the
 * creation site of long deadlines once per process: the run boundary records the
 * failure, this records who armed it.
 * @param thresholdMs - deadlines at or above this value are traced.
 */
function traceLongAbortDeadlines(thresholdMs = 100_000) {
  const original = AbortSignal.timeout;
  if (typeof original !== 'function' || original.traced) return;
  const traced = function timeout(ms) {
    try {
      if (Number(ms) >= thresholdMs) {
        console.info('[agentkit-studio] abort deadline', JSON.stringify({
          ms: Number(ms),
          stack: String(new Error().stack || '').split('\n').slice(1, 8)
            .map(line => line.trim().replace(/^at /, '')).join(' <- '),
        }));
      }
    } catch { /* diagnostics never arm a deadline */ }
    return original.call(AbortSignal, ms);
  };
  traced.traced = true;
  AbortSignal.timeout = traced;
}

export async function mountStudioHost(ctx, { env: runtimeEnv = process.env, configurationHome, resourceAdapterFactory,
  nativeHookRegistrations = [], nativeContextSourceRegistrations = [], githubSkillSourceFetch = hostFetch,
  nativeA2aInbound, nativeManagedKernel } = {}) {
  traceLongAbortDeadlines();
  // The Desktop shell resolves this plugin through the profile, so an upgraded
  // application can still load an older profile copy. Align it before any Studio
  // surface loads; module resolution already happened, so it applies NEXT launch.
  try { alignProfileProductPlugin({ env: runtimeEnv }); }
  catch (error) {
    console.warn('[studio] profile alignment skipped', { message: error instanceof Error ? error.message : String(error) });
  }
  const nativeEngineContract = nativeHarnessHostContract(runtimeEnv);
  // Partial resource loss is the default: one unreachable MCP or skill must not
  // disable the whole Agent. Operators who need the old fail-closed contract set
  // AGENTKIT_STRICT_RESOURCES=1 (Agent Advanced env or the runtime image).
  const strictResources = /^(?:1|true|yes|on)$/i.test(String(runtimeEnv.AGENTKIT_STRICT_RESOURCES || '').trim());
  const configuredLocalSkillDirectory = runtimeEnv.KSADK_LOCAL_SKILLS_DIR?.trim();
  const localSkillDirectory = configuredLocalSkillDirectory ? resolve(configuredLocalSkillDirectory) : undefined;
  const hostCompatibility = await loadHostCompatibility(ctx);
  ctx.provide('studioHostCompatibility', hostCompatibility);
  const cloudEndpointOptions = {
    innerKopUrl: runtimeEnv.AGENTENGINE_INNER_KOP_URL || '',
    innerIamUrl: runtimeEnv.AGENTENGINE_INNER_IAM_URL || '',
  };
  const bridge = mountRuntimeBridge(ctx);
  const a2aSessionSink = createStudioA2aSessionSink({ ctx });
  ctx.effect(() => () => a2aSessionSink.close(), 'agentkit-studio: A2A observation delivery');
  for (const registration of nativeHookRegistrations) {
    const retire = bridge.nativeHooks.register(registration);
    ctx.effect(() => retire, 'agentkit-studio: trusted Native hook source');
  }
  for (const registration of nativeContextSourceRegistrations) {
    const retire = bridge.nativeContextSources.register(registration);
    ctx.effect(() => retire, 'agentkit-studio: trusted Native context source');
  }
  // Defer optional portable-bundle dependencies until Host activation.
  // The browser uses the separately declared ./client bundle; it must never
  // load this Host bootstrap or its Node-only configuration dependencies.
  const { loadPortableRuntime, loadPortableRuntimeDirectory, createPortableBundles } = await import('../portable-bundle.mjs');
  const portableRuntime = await loadPortableRuntime(runtimeEnv.AGENTKIT_HOME, runtimeEnv);
  const managedRuntime = runtimeEnv.AGENTENGINE_MANIFEST_PATH
    ? await import('../managed-runtime-definition.mjs').then(({ loadManagedRuntimeDefinition }) => loadManagedRuntimeDefinition({ manifest: runtimeEnv.AGENTENGINE_MANIFEST_PATH, env: runtimeEnv })) : null;
  const managedBundleRuntime = managedRuntime && runtimeEnv.AGENTKIT_STUDIO_BUNDLE_DIR
    ? await loadPortableRuntimeDirectory(runtimeEnv.AGENTKIT_STUDIO_BUNDLE_DIR, runtimeEnv)
    : null;
  if (portableRuntime && managedRuntime) throw Object.assign(new Error('运行输入不能同时包含声明和 portable bundle'), { code: 'MANAGED_HOST_INPUT_CONFLICT' });
  const resourceBundleRuntime = portableRuntime || managedBundleRuntime;
  const managedResourceContext = managedRuntime
    ? await import('../managed-resource-context.mjs').then(({ createManagedResourceContext }) => createManagedResourceContext(managedRuntime)) : undefined;
  const resolveResourceUser = managedRuntime
    ? await import('../managed-resource-identity.mjs').then(({ createManagedResourceIdentityResolver }) => createManagedResourceIdentityResolver({
      runtime: managedRuntime,
      // Session ownership is Agent state, not deployment-version state. AGENTKIT_HOME
      // is version-scoped (versions/<sha256(VersionId)>/agentkit), so reading the
      // registry from it opened a fresh, empty directory after every accepted
      // UpdateAgent: the Hosted UI found the Session, but resource identity
      // resolution answered MANAGED_RESOURCE_IDENTITY_UNAVAILABLE and the turn
      // failed with 托管资源缺少可核对的会话归属. Consume the same Agent-scoped
      // registry the Session actions write, keeping the version directory only as
      // the fallback for a Host launched without the explicit path.
      directory: runtimeEnv.AGENTKIT_MANAGED_SESSIONS || join(runtimeEnv.AGENTKIT_HOME, 'managed-sessions'),
    })) : undefined;
  const studioStoreDir = join(runtimeEnv.AGENTKIT_HOME || join(homedir(), '.agentkit'), 'studio');
  let managedKernel;
  const cloudExecutionModes = createCloudExecutionModes({ directory: studioStoreDir });
  let templateServices, teamTemplates;
  const services = createStudioServices(ctx, {
    env: runtimeEnv, storeDir: studioStoreDir, portableRuntime: resourceBundleRuntime, managedRuntime, managedResourceContext, cloudEndpointOptions, configurationHome, resourceAdapterFactory, hostCompatibility,
    getTemplateAuthoring: () => templateServices?.templateAuthoring, getAdmission: () => presetAdmission, getModels: () => models, getPortableBundles: () => portableBundles,
  });
  const {
    studioBuildPromise, agentStorePromise, agentCatalogPromise, listLocalBuildTargets,
    skillDiscoveryPromise, localMcpStorePromise, mcpProbePromise, resourceAdaptersPromise,
    configurationPromise, credentialsService, serverClientPromise, deploymentClientPromise,
    studioSchedulerPromise, studioObservabilityPromise, studioEvaluationPromise,
    studioChannelsPromise, cloudSchedulesPromise, authoringRemoteFactory, deployments,
  } = services;

  // Generic cloud-control capability for independent DSH plugins. The Host
  // owns configuration, credentials, and AgentEngine clients; consumers only
  // receive this narrow provider and do not become Studio product modules.
  ctx.provide('agentkitHostCloud', Object.freeze({
    storeDir: studioStoreDir,
    env: runtimeEnv,
    fetchImpl: services.runtimeFetch,
    configuration: configurationPromise,
    getClient: async () => serverClientPromise,
    getDeploymentClient: async () => deploymentClientPromise,
  }));

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
    : managedRuntime ? await import('../portable-codex.mjs').then(({ isolatedRuntimeCodexOptions }) => isolatedRuntimeCodexOptions({ home: runtimeEnv.AGENTKIT_HOME, scopeId: `manifest_${managedRuntime.sha256}`, env: runtimeEnv })) : {};
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
          fetchImpl: hostFetch,
          observability,
        });
      });
    }
    return localRuntimeHandlerPromise;
  };
  const { skillDefinitionsForBindings, withBuiltinSkillContextForBindings } = await import('../builtin-skills.mjs');
  const { createCodexResourceContext } = await import('../providers/codex-resource-context.mjs');
  // Codex App Server turns receive developerInstructions instead of the DSH
  // skill registry, so the builtin platform guide is inlined there. It is
  // gated on the same platform bindings as getSkillDefinitions: a Codex Agent
  // with no platform resource keeps its plain developerInstructions.
  const resolveCodexBindings = async ({ agentId, buildId, agentRevision } = {}) => {
    if (!agentId) return {};
    // Same resolution order as createCodexResourceContext so the gate sees the
    // exact revision/build bindings the context is built from.
    const record = buildId ? await (await studioBuildPromise).build.resolve(agentId, buildId)
      : agentRevision ? await (await agentStorePromise).getRevision(agentId, Number(agentRevision))
      : await (await agentStorePromise).get(agentId);
    return record?.spec?.bindings || record?.bindings || {};
  };
  const codexResourceContextBase = createCodexResourceContext({ agentStore: agentStorePromise, builds: studioBuildPromise, resources: resourceAdaptersPromise });
  const codexResourceContext = async request => {
    const context = await codexResourceContextBase(request);
    return withBuiltinSkillContextForBindings(context, await resolveCodexBindings(request));
  };
  // Materialize resources consumed by DSH adapters before registering those
  // adapters. The Host can service model discovery while this async plugin
  // scope is still activating, so a deployment callback must never observe a
  // temporal-dead-zone binding for the portable bundle service.
  const credentials = credentialsService;
  const models = await import('../model-service.mjs').then(({ createModelService }) => configurationPromise.then(configuration => createModelService({ configuration, credentials })));
  const portableBundles = createPortableBundles({ storeDir: studioStoreDir, build: (await studioBuildPromise).build, models,
    adapters: await resourceAdaptersPromise, configuration: await configurationPromise, credentials });
  await registerBuildDownload(ctx, { studioBuildPromise, getPortableBundles: () => portableBundles });
  const { CLOUD_PROVIDER, createDeploymentModelAdapter } = await import('../deployment-agents.mjs');
  const { createDeploymentConversation } = await import('../deployment-conversation.mjs');
  const dshRuntimeAdapter = createDshRuntimeAdapter({
    bridge,
    AdapterBase: LlmAdapter,
    cloudClient: await serverClientPromise,
    attachments: () => ctx.get('attachments'),
    cloudRuntime: createDeploymentConversation({ agents: async () => (await deployments()).agents, observability: await studioObservabilityPromise, fetchImpl: services.runtimeFetch,
      permissionModeFor: agentId => cloudExecutionModes.get(agentId) }),
    localHandler: localRuntimeHandler,
    codexRuntime,
    // The permission picker (local, Studio cloud and Hosted UI) converges on the
    // Session preset; read it here so Codex's own sandbox follows the picker.
    permissionModeForSession: session => {
      try {
        const current = ctx.get?.('permissionPresets')?.current?.(session);
        if (typeof current === 'string' && current) return current;
        return ctx.get?.('sessionProjections')?.stateOf?.(session, 'sandboxMode') ?? undefined;
      } catch { return undefined; }
    },
    resolveCodexModel: selection => resolveConfiguredCodexModel(selection, models),
    codexResourceContext,
    resolveResourceUser,
    resourceAdapter: await resourceAdaptersPromise,
    observability: await studioObservabilityPromise,
  });
  ctx.effect(() => bridge.setAdapter(dshRuntimeAdapter), 'agentkit-studio: runtime transport registration');
  const routeDshRuntime = (options, next) => routeRuntime(options, next, bridge, request => hostCompatibility.isAgentLoopRequest(request));
  ctx.on('llm/stream', routeDshRuntime);
  const { createBoundResourceToolExecutor } = await import('./services/resource-tools.mjs');
  ctx.effect(() => bridge.setResourceToolExecutor(createBoundResourceToolExecutor({
    agents: agentStorePromise, builds: studioBuildPromise, resources: resourceAdaptersPromise,
  })), 'agentkit-studio: resource tool registration');
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
  const workspaceRoot = resolve(runtimeEnv.AGENTKIT_STUDIO_WORKSPACE || process.cwd());
  const { createNativeSkillConnection } = await import('../providers/native-skill-host.mjs');
  const skillConnection = await createNativeSkillConnection({ configuration: await configurationPromise, env: runtimeEnv, ...cloudEndpointOptions });
  const [{ createStudioSkillManagement }, { createGithubArchiveSkillSource }, skillDiscovery, skillAgents] = await Promise.all([
    import('../skill-management.mjs'), import('../skill-github-archive-source.mjs'), skillDiscoveryPromise, agentStorePromise,
  ]);
  const githubSkills = createGithubArchiveSkillSource({ fetchImpl: githubSkillSourceFetch });
  const getSkillManagement = (agentId, root = workspaceRoot) => createStudioSkillManagement({ workspaceRoot: root,
    stateDir: join(studioStoreDir, 'builtin-workspace'), agentId, skillDiscovery, agents: skillAgents, source: githubSkills });
  const { createKnowledgeConnection, createStudioKnowledgeTools } = await import('../knowledge-tools.mjs');
  const knowledgeConnection = await createKnowledgeConnection({ configuration: await configurationPromise, env: runtimeEnv,
    serverUrl: runtimeEnv.AGENTKIT_STUDIO_HOST_URL || '', sessionToken: runtimeEnv.AGENTKIT_STUDIO_HOST_SESSION_TOKEN || '', ...cloudEndpointOptions });
  const getKnowledgeTools = config => createStudioKnowledgeTools({ agentId: config.agentId,
    bindings: config.knowledgeBindings, connection: knowledgeConnection, env: runtimeEnv });
  const { createLegacyMemoryConnection, createLegacyMemoryTools } = await import('../legacy-memory-tools.mjs');
  const memoryConnection = await createLegacyMemoryConnection({ configuration: await configurationPromise, env: runtimeEnv,
    serverUrl: runtimeEnv.AGENTKIT_STUDIO_HOST_URL || '', sessionToken: runtimeEnv.AGENTKIT_STUDIO_HOST_SESSION_TOKEN || '', ...cloudEndpointOptions });
  const getLegacyMemoryTools = (config, root = workspaceRoot) => createLegacyMemoryTools({ agentId: config.agentId,
    root: join(realpathSync(studioStoreDir), 'legacy-memory'), workspaceRoot: realpathSync(root),
    bindings: config.legacyMemoryBindings, connection: memoryConnection, env: runtimeEnv });
  {
    const { createDshNodeBuiltins } = await import('../providers/dsh-node-builtins.mjs');
    ctx.effect(() => bridge.setBuiltinToolsFactory(({ ctx: toolsCtx, config, isClosed, signal }) => createDshNodeBuiltins({
      ctx: toolsCtx, workspaceRoot, stateDir: join(studioStoreDir, 'builtin-workspace'), agentId: config.agentId,
      isClosed, signal, env: runtimeEnv, fetchImpl: hostFetch,
      a2aSessionEvents: a2aSessionSink.forPreset(config),
      browserExecutablePath: runtimeEnv.AGENTKIT_STUDIO_NATIVE_CHROMIUM_EXECUTABLE || undefined,
      getSkillManagement, getKnowledgeTools, knowledgeBindings: config.knowledgeBindings,
      getLegacyMemoryTools, legacyMemoryBindings: config.legacyMemoryBindings,
      toolBindings: config.toolBindings ?? [], toolContracts: config.toolContracts ?? [], componentBindings: config.componentBindings,
      skillConnection, agentRevision: config.agentRevision, buildId: config.buildId, skillDefinitions: config.skillDefinitions ?? [], a2aBindings: config.a2aBindings ?? [],
    })), 'agentkit-studio: Node builtin environment');
  }
  // A frozen Native Build retains its engine when the live-preset default is
  // disabled. Register the capability; selection remains explicit per preset.
  {
    const { createNativeDshTools } = await import('../providers/native-dsh-tools.mjs');
    const { bindNativeSessionWorkspace } = await import('../providers/native-session-workspace.mjs');
    ctx.effect(() => bridge.setNativeToolsFactory(({ ctx: toolsCtx, config, agent }) => {
      const workspace = bindNativeSessionWorkspace({ ctx: toolsCtx, agent, fallbackRoot: workspaceRoot, managed: Boolean(managedRuntime) });
      return createNativeDshTools({ ctx: toolsCtx, config, ...workspace,
        stateDir: join(studioStoreDir, 'native-harness', 'workspace-state', createHash('sha256').update(config.agentId).digest('hex')),
        browserExecutablePath: runtimeEnv.AGENTKIT_STUDIO_NATIVE_CHROMIUM_EXECUTABLE || undefined,
        commandEnvironment: runtimeEnv,
        a2aSessionEvents: a2aSessionSink.forPreset(config),
        skillConnection,
        getSkillManagement: id => getSkillManagement(id, workspace.workspaceRoot), getKnowledgeTools,
        getLegacyMemoryTools: settings => getLegacyMemoryTools(settings, workspace.workspaceRoot),
        executeMcpTool: request => bridge.executeResourceTool(request),
      });
    }), 'agentkit-studio: Native tool environment');
  }
  let nativeHostPromise;
  let dshA2aPromise;
  const dshA2aControls = () => dshA2aPromise ||= ownAsyncResource(ctx,
    Promise.all([import('./services/dsh-a2a-control.mjs'), import('@deepseek-ai/dsh-agent')])
      .then(([{ createStudioDshA2aControls }, { agentEvents }]) => createStudioDshA2aControls({ ctx, agentEvents, signal: bridge.signal })),
    'agentkit-studio: DSH A2A controls');
  const nativeHost = () => nativeHostPromise ||= ownAsyncResource(ctx,
    Promise.all([import('./services/native-harness.mjs'), import('@deepseek-ai/dsh-system-prompt'), agentStorePromise, studioBuildPromise, resourceAdaptersPromise,
      import('@deepseek-ai/dsh-agent'), studioObservabilityPromise])
      .then(([{ createStudioNativeHarness }, { renderPrompt }, agents, studio, resources, { emitAgentEvent, agentEvents, assembleContextFor }, observability]) => createStudioNativeHarness({
        ctx, storeDir: studioStoreDir, workspaceRoot, agents, builds: studio.build, models, resources, fetchImpl: hostFetch, renderPrompt,
        modelCompatibilityRule: runtimeEnv.KSADK_MODEL_COMPAT_RULE,
        publishStreamFrame: ({ agent }, frame) => emitAgentEvent(ctx, agent, 'agent/assistant-stream', { frame }),
        agentEvents, assembleContextFor, hookRegistry: bridge.nativeHooks, contextSourceRegistry: bridge.nativeContextSources, observability,
      })), 'agentkit-studio: Native Harness lifetime');
  ctx.effect(() => bridge.setNativeTurnExecutor(async payload => (await nativeHost()).executeTurn(payload)), 'agentkit-studio: Native whole-turn registration');
  if (nativeManagedKernel !== undefined) {
    // Materialize the shared Host before its managed borrower so teardown
    // closes the receiver/Native loops before releasing Host-owned resources.
    if (nativeManagedKernel.resolveBinding === undefined) await nativeHost();
    const { registerStudioManagedNativeKernel } = await import('./services/native-managed-kernel.mjs');
    managedKernel = registerStudioManagedNativeKernel(ctx, { storeDir: studioStoreDir,
      configuration: nativeManagedKernel, resolveHost: nativeHost });
  }
  if (nativeA2aInbound !== undefined) {
    const { registerStudioNativeA2aInbound } = await import('./services/native-a2a-inbound.mjs');
    registerStudioNativeA2aInbound(ctx, { storeDir: studioStoreDir,
      configuration: { ...nativeA2aInbound, events: nativeA2aInbound.events ?? managedKernel?.events } });
  }
  const { describeGlobalModelCredential } = await import('../model-credential-sync.mjs');
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
    managedAgents: async () => (await serverClientPromise).listAgents({ page: 1, pageSize: 100, remoteOnly: true }),
    getAdmission: () => presetAdmission,
  });
  const createPresetAdmission = registry => new DshPresetAdmission({
    registry,
    strictResources,
    nativeEngineContract,
    assertHostCompatible: () => hostCompatibility.require('agent-presets'),
    getBasePlugins: async agent => {
      if (typeof registry?.pluginsFor !== 'function') throw Object.assign(new Error('DSH preset composition snapshot is unavailable; apply the pinned Studio patch series'), { code: 'DSH_PRESET_COMPOSITION_UNAVAILABLE' });
      const plugins = await registry.pluginsFor('standard');
      logPresetComposition(ctx, plugins);
      return agent.metadata?.teamRole ? (await import('../studio-team-composition.mjs')).teamBasePlugins(plugins) : plugins;
    },
    getAgent: async agentId => {
      if (managedRuntime && agentId === managedRuntime.agent.metadata.id) return structuredClone(managedRuntime.agent);
      try {
        return await (await deployments()).agents.get(agentId);
      } catch (error) {
        // Studio deployment receipts are the preferred provenance. A
        // read-only Server lookup is the explicit fallback for Agents created
        // through the public API as ManagedRuntime (there is no local receipt
        // for those rows).
        if (error?.code !== 'DEPLOYMENT_AGENT_NOT_FOUND') throw error;
        return (await serverClientPromise).getAgent(agentId);
      }
    },
    getActiveModel: async () => (await configurationPromise).resolve(),
    getModelSelection: createAgentModelSelection({ models, agentStorePromise, codexModels, selectCodexAgentModel, CLOUD_PROVIDER, dshModelSelection }),
    getSkillDefinitions: async agent => {
      const bindings = agent?.spec?.bindings || {};
      const bound = boundSkillResources(bindings).length
        ? await loadBoundSkillDefinitions(bindings, await resourceAdaptersPromise) : [];
      const definitions = skillDefinitionsForBindings(bindings, bound);
      const native = agent?.spec?.runtime?.type === 'harness'
        && selectedNativeBuildContract(agent, nativeEngineContract) === NATIVE_DSH_TURN_CONTRACT;
      return native ? loadConfiguredNativeSkills({ directory: localSkillDirectory, definitions }) : definitions;
    },
    getToolContracts: async agent => {
      const bindings = agent?.spec?.bindings && typeof agent.spec.bindings === 'object'
        ? agent.spec.bindings : {};
      const bindingRefs = (Array.isArray(bindings.tools) ? bindings.tools : []).map(value => {
        if (typeof value === 'string') return value;
        return value?.resourceId || value?.id || value?.name || '';
      }).filter(Boolean).map(String);
      const mcpBindings = Array.isArray(bindings.mcpServers) ? bindings.mcpServers : [];
      if (!bindingRefs.length && !mcpBindings.length) return [];
      const native = agent?.spec?.runtime?.type === 'harness'
        && selectedNativeBuildContract(agent, nativeEngineContract) === NATIVE_DSH_TURN_CONTRACT;
      const builtinContracts = native ? bindingRefs.map(nativeLocalToolContract).filter(Boolean) : [];
      const localNames = new Set(builtinContracts.map(tool => tool.resourceId));
      const refs = bindingRefs.filter(ref => !localNames.has(ref));
      if (refs.length) {
        let page;
        try {
          page = await (await serverClientPromise).listCatalogResources({ kind: 'tool', limit: 200 });
        } catch (error) {
          // A local Agent can still be admitted when the optional catalog
          // process is temporarily unavailable. The bound runtime executor
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
      const nativeMcp = agent?.spec?.runtime?.type === 'harness'
        && selectedNativeBuildContract(agent, nativeEngineContract) === NATIVE_DSH_TURN_CONTRACT;
      const seenNames = new Set(builtinContracts.map(contract => String(contract?.name || '')));
      const adapters = mcpBindings.length ? await resourceAdaptersPromise : null;
      for (const binding of mcpBindings) {
        const resourceId = String(typeof binding === 'string' ? binding : binding?.resourceId || binding?.id || '').trim();
        if (!resourceId) {
          const error = new Error('MCP 绑定缺少资源 ID');
          error.code = 'MCP_ID_MISSING';
          throw error;
        }
        const listed = await adapters.listMcpTools(binding,
          nativeMcp ? { jsonCodec: NATIVE_MCP_JSON_CODEC, snapshot: true } : undefined);
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
            ...(nativeMcp ? { nativeMcpSchema: snapshotNativeMcpSchema(tool), nativeMcpPlanAccess: snapshotNativeMcpPlanAccess(tool) }
              : { parameters: tool.inputSchema || tool.parameters || { type: 'object', properties: {} } }),
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
  observeSessionStop(ctx);
  presetAdmission = createPresetAdmission();
  // Cordis unloads and reruns this scope when the registry changes. An old
  // scope must dispose its own admission, never whichever admission is current
  // after an asynchronous reload. Catalog-only profiles retain typed failures.
  const presetRegistryStartup = bindPresetRegistry(ctx, { createAdmission: createPresetAdmission,
    publishAdmission: admission => { presetAdmission = admission; },
    reconcile: async admission => { await reconciler.run(admission); await studioTeams.restore(admission); },
  });
  const { startFrozenBuildRuntime } = await import('../frozen-build-runtime.mjs');
  const bindRuntime = () => bindFrozenRuntime(ctx, {
    // The portable profile delays native schedule restoration until frozen
    // preset/model/permission initialization has completed. No timer retry or
    // Session prewarming substitutes for the native dependency lifecycle.
    readyService: resourceBundleRuntime || managedRuntime ? FROZEN_RUNTIME_READY : undefined,
    start: async runtimeCtx => startFrozenBuildRuntime({ ctx: runtimeCtx, env: runtimeEnv, hostCompatibility, managedRuntime, managedResourceContext, modelService: models, resources: () => resourceAdaptersPromise, build: (await studioBuildPromise).build,
      admit: (agentId, frozen) => presetAdmission.ensure(agentId, { agent: { ...frozen, metadata: { ...frozen.metadata, local: true } }, allowUnavailableResources: !strictResources, requireModelSelection: true }) }),
    onUnavailable: error => console.warn('[agentkit-studio] frozen runtime unavailable:', error.message),
  });
  if (resourceBundleRuntime || managedRuntime) {
    // Settings writes reconcile the Loader. Awaiting them inside plugin apply
    // deadlocks that reconciliation; use the same public startup boundary as DSH Settings.
    let stopped = false;
    ctx.effect(() => () => { stopped = true; }, 'agentkit-studio: portable runtime startup');
    void ctx.root.loader.await().then(async () => {
      if (stopped) return;
      const { syncPortableModelProfiles } = await import('../portable-model-bridge.mjs');
      await syncPortableModelProfiles({ settings: ctx.get('settings'), profiles: managedRuntime?.modelProfiles || resourceBundleRuntime.manifest.resources.profiles,
        capabilities: profile => models.capabilitiesOf(profile) });
      if (stopped) return;
      await bindRuntime();
    }).catch(error => console.error('[agentkit-studio] portable runtime startup failed:', error?.code || 'PORTABLE_STARTUP_FAILED'));
  } else {
    await bindRuntime();
  }
  bindNativeBackgroundRuntime(ctx, { getHost: nativeHost,
    readyService: resourceBundleRuntime ? FROZEN_RUNTIME_READY : undefined,
    onError: error => console.error('[agentkit-studio] Native background startup failed:', error?.code || 'NATIVE_BACKGROUND_STARTUP_FAILED'),
  });
  const routes = createStudioRoutes(ctx, {
    ...services, ...templateServices, studioTeams, teamTemplates, models, syncModelCredential, hostCompatibility, cloudExecutionModes,
    describeGlobalModelCredential: options => describeGlobalModelCredential({ ...options, env: runtimeEnv }),
    listCodexAgentModels, codexModels, portableBundles, getAdmission: () => presetAdmission, getNativeHost: nativeHost,
    getDshA2aControls: dshA2aControls,
  });
  const dispatch = createControlPlaneDispatcher({ bridge, serverClientPromise, routes });
  await registerControlPlaneRoutes(ctx, { ...services, models, dispatch });
  // Prompt prediction is a Studio-owned auxiliary text request. It observes
  // native Session events but never enters the Session loop or mutates history.
  ctx.inject(['connection'], predictionCtx => {
    const dispose = createPromptPredictionHost(predictionCtx, { models, env: runtimeEnv });
    predictionCtx.effect(() => dispose, 'agentkit-studio: prompt prediction');
  });
  // Authoring tools need the in-process remote factory (cloud/resource data);
  // they live here because that factory is scoped to this function.
  registerAuthoringTools(ctx, { remoteFactory: authoringRemoteFactory });
  ctx.effect(async () => { const channels = await studioChannelsPromise; await channels?.ensureReady(); return () => channels?.dispose(); }, 'agentkit-studio: channels lifetime');
  ctx.effect(async () => { const scheduler = await studioSchedulerPromise; await scheduler?.ensureReady(); return () => scheduler?.dispose(); }, 'agentkit-studio: scheduler lifetime');
  ctx.effect(() => () => bridge.close(), 'agentkit-studio: stop owned runtime requests');
  // A registry service may already exist while its asynchronously injected
  // Studio definitions are still being recovered. Do not expose a completed
  // Host mount before its persisted Session presets are registered. Keep the
  // optional-registry catalog profile independent from this native startup.
  if (ctx.get('agentPresets')) await presetRegistryStartup.ready;
  if (nativeManagedKernel?.autoStart !== false) managedKernel?.startRecovery();
}
