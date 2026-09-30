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
import { registerAuthoringTools } from './authoring-tools.mjs';
import { DshPresetAdmission } from './agent-preset-admission.mjs';

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
  const skillDiscoveryPromise = import('./skill-discovery.mjs').then(({ createSkillDiscovery }) => createSkillDiscovery({}));
  const studioStoreDir = join(runtimeEnv.AGENTKIT_HOME || join(homedir(), '.agentkit'), 'studio');
  const studioBuildPromise = Promise.all([
    import('./studio-operations.mjs').then(({ createOperationManager }) => createOperationManager({ storeDir: join(studioStoreDir, 'operations') })),
    import('./studio-build.mjs').then(({ createStudioBuild }) => createStudioBuild({ storeDir: studioStoreDir })),
  ]).then(([operations, build]) => ({ operations, build }));
  const studioSchedulerPromise = import('./studio-scheduler.mjs').then(({ createStudioScheduler }) => createStudioScheduler({ storeDir: join(studioStoreDir, 'scheduler') })).catch(error => { console.warn('[agentkit-studio] scheduler init failed:', error?.message || error); return null; });
  const studioObservabilityPromise = import('./studio-observability.mjs').then(({ createStudioObservability }) => createStudioObservability({ storeDir: join(studioStoreDir, 'traces') })).catch(error => { console.warn('[agentkit-studio] observability init failed:', error?.message || error); return null; });
  const studioEvaluationPromise = import('./studio-evaluation.mjs').then(({ createStudioEvaluation }) => createStudioEvaluation({ storeDir: join(studioStoreDir, 'evaluations') })).catch(error => { console.warn('[agentkit-studio] evaluation init failed:', error?.message || error); return null; });
  const studioChannelsPromise = import('./studio-channels.mjs').then(({ createStudioChannels }) => createStudioChannels({ storeDir: studioStoreDir })).catch(error => { console.warn('[agentkit-studio] channels init failed:', error?.message || error); return null; });
  const agentStorePromise = import('./agent-store.mjs').then(({ createAgentStore }) => createAgentStore({ storeDir: join(studioStoreDir, 'agents') }));
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
    createGlobalConfiguration({ env: runtimeEnv }));
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
  ]).then(async ([skillDiscovery, serverClient]) => {
    const { createLocalResourceAdapters } = await import('./local-resource-adapters.mjs');
    return createLocalResourceAdapters({ serverClient, skillDiscovery, credentials: credentialsService });
  });
  // Studio-owned revisions still enter through DSH's native Session/Loop.
  // The provider is selected by the preset-scoped listener and delegates the
  // assembled turn to the local Harness or AgentEngine cloud stream.
  const { createDshRuntimeAdapter, setDshRuntimeAdapter } = await import('./providers/dsh-runtime.mjs');
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
          modelService: localModels,
          resourceAdapter: resourceAdapters,
          observability,
        });
      });
    }
    return localRuntimeHandlerPromise;
  };
  const dshRuntimeAdapter = createDshRuntimeAdapter({
    cloudClient: await serverClientPromise,
    localHandler: localRuntimeHandler,
  });
  setDshRuntimeAdapter(dshRuntimeAdapter);
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
  });
  // Cordis exposes injected services through `get`; property access is only
  // available on typed service contexts and is absent in the plain plugin
  // apply context used by the DSH loader.
  const credentials = credentialsService;
  const models = await import('./model-service.mjs').then(({ createModelService }) => configurationPromise.then(configuration => createModelService({ configuration, credentials })));
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
  // The registry is an optional DSH service. Older profiles can still load
  // the Studio catalog and UI, but an Agent binding must return a typed
  // unavailable error instead of silently selecting the default DSH loop.
  ctx.inject(['agentPresets'], presetCtx => {
    presetRegistry = presetCtx.agentPresets;
    if (presetAdmission) presetAdmission.setRegistry(presetRegistry);
    presetCtx.effect(() => async () => {
      await presetAdmission?.dispose();
      presetRegistry = undefined;
    }, 'agentkit-studio: dynamic preset cleanup');
  });
  presetAdmission = new DshPresetAdmission({
    getAgent: async agentId => (await serverClientPromise).getAgent(agentId),
    getActiveModel: async () => (await configurationPromise).resolve(),
  });
  if (presetRegistry) presetAdmission.setRegistry(presetRegistry);
  const allowed = new Set(['agents/list', 'agents/create-local', 'agents/ensure-preset', 'agents/conversation-surface', 'models/sync-credential', 'models/catalog', 'settings/get', 'settings/update', 'skills/discover', 'skills/preview-discovered', 'skills/commit-discovered', 'skills/list', 'skills/preview-installed', 'plugins/dsh-list', 'agents/local-get', 'agents/update-local', 'agents/local-delete', 'plugins/dsh-install', 'plugins/dsh-remove', 'plugins/dsh-enable', 'plugins/dsh-disable', 'plugins/dsh-update', 'plugins/codex-list', 'plugins/codex-install', 'plugins/codex-remove', 'builds/create', 'builds/list', 'operations/list', 'operations/cancel', 'schedules/list', 'schedules/create', 'schedules/get', 'schedules/update', 'schedules/delete', 'schedules/run', 'schedules/occurrences', 'traces/overview', 'traces/list', 'traces/get', 'traces/otlp', 'evaluations/list', 'evaluations/create', 'evaluations/get', 'evaluations/targets', 'evaluations/evalsets', 'evaluations/import', 'channels/connection', 'channels/update', 'channels/action', 'server/action']);
  const dispatch = async (endpoint, payload, signal) => {
    if (!allowed.has(endpoint)) {
      return { ok: false, error: { code: 'agentkit/not-found', message: 'Unknown AgentKit control endpoint', details: { endpoint } } };
    }
    try {
      if (endpoint === 'models/sync-credential') return { ok: true, value: await syncModelCredential() };
      if (endpoint === 'settings/get') return { ok: true, value: await models.settings() };
      if (endpoint === 'settings/update') return { ok: true, value: await models.save(payload) };
      if (endpoint === 'models/catalog') return { ok: true, value: await models.catalog(String(payload?.profileId || '')) };
      const serverClient = await serverClientPromise;
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
      if (endpoint === 'agents/list') {
        const value = await serverClient.listAgents({
          page: Number(payload?.page || 1), pageSize: Number(payload?.limit || 50), query: String(payload?.query || ''),
        }, { signal });
        const local = await agentStorePromise.then(store => store.list()).catch(() => []);
        const items = [...local, ...(Array.isArray(value.items) ? value.items : [])];
        return { ok: true, value: { ...value, items, total: (value.total || 0) + local.length } };
      }
      if (endpoint === 'agents/ensure-preset') {
        const agentId = String(payload?.agentId || '').trim();
        if (!agentId) return { ok: false, error: { code: 'INVALID_AGENT_ID', message: 'AgentId 不能为空', details: {} } };
        try {
          const localStore = await agentStorePromise;
          const local = await localStore.get(agentId);
          const value = local
            ? await presetAdmission.ensure(agentId, { agent: local })
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
              ? await codex.installCodex(payload?.pluginId)
              : await codex.uninstallCodex(payload?.pluginId);
            return { ok: true, value: result };
          }
          if (endpoint === 'plugins/codex-list') return { ok: true, value: await import('./studio-codex-plugins.mjs').then(({ createStudioCodexPlugins }) => createStudioCodexPlugins({})).then(codex => codex.listCodex()) };
        } catch (error) {
          return { ok: false, error: { code: error?.code || 'PLUGIN_ECOSYSTEM_FAILED', message: error instanceof Error ? error.message : String(error), details: error?.details || {} } };
        }
      }
      if (endpoint === 'builds/create' || endpoint === 'builds/list' || endpoint === 'operations/list' || endpoint === 'operations/cancel') {
        const studio = await studioBuildPromise;
        try {
          if (endpoint === 'builds/create') {
            const agentId = String(payload?.agentId || '').trim();
            if (!agentId) return { ok: false, error: { code: 'INVALID_AGENT_ID', message: 'AgentId 不能为空', details: {} } };
            const localStore = await agentStorePromise;
            const detail = await localStore.get(agentId) || await serverClient.getAgent(agentId, { signal });
            const agentName = String(detail?.metadata?.name || detail?.name || agentId);
            const revision = Number(payload?.revision || detail?.metadata?.revision || 1);
            // Freeze the cloud Agent definition into a local content-addressed
            // bundle. Deployment-to-cloud remains a separate server contract.
            const operation = await studio.operations.submit({
              kind: 'build',
              resourceId: agentId,
              idempotencyKey: String(payload?.idempotencyKey || `build-${agentId}-${revision}`),
              metadata: { agentName, revision },
              runner: async () => {
                const record = await studio.build.build({
                  agentId, agentName, revision,
                  spec: detail?.spec ?? null,
                  bindings: detail?.spec?.bindings ?? detail?.bindings ?? {},
                  metadata: detail?.metadata ?? {},
                });
                return { buildId: record.id, summary: record.id };
              },
            });
            return { ok: true, value: { operationId: operation.id, status: operation.status, buildId: null } };
          }
          if (endpoint === 'builds/list') {
            const agentId = String(payload?.agentId || '').trim();
            if (!agentId) return { ok: true, value: { items: [] } };
            return { ok: true, value: { items: await studio.build.list(agentId) } };
          }
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
      if (endpoint.startsWith('schedules/') || endpoint.startsWith('traces/') || endpoint.startsWith('evaluations/') || endpoint.startsWith('channels/')) {
        try {
          if (endpoint.startsWith('schedules/')) {
            const scheduler = await studioSchedulerPromise;
            if (!scheduler) return { ok: false, error: { code: 'SCHEDULER_UNAVAILABLE', message: '调度器未初始化', details: {} } };
            if (endpoint === 'schedules/list') return { ok: true, value: { items: await scheduler.listSchedules(payload?.agentId || undefined) } };
            if (endpoint === 'schedules/create') return { ok: true, value: await scheduler.createSchedule(payload?.agentId || '', payload?.spec || payload) };
            if (endpoint === 'schedules/get') return { ok: true, value: await scheduler.getSchedule(payload?.taskId) };
            if (endpoint === 'schedules/update') return { ok: true, value: await scheduler.updateSchedule(payload?.taskId, payload?.patch || payload) };
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
                const series = cloud?.Series?.Sessions || cloud?.Series?.Runs || [];
                return { ok: true, value: {
                  buckets: series.map(item => ({ startedAt: new Date(Number(item.Timestamp)).toISOString(), runs: Number(item.Value) || 0, completed: Number(item.Value) || 0, failed: 0 })),
                  totalRuns: Number(summary.SessionCount ?? local.totalRuns ?? 0),
                  totalTokens: Number(summary.TokenCount ?? local.totalTokens ?? 0),
                  agents: local.agents || [],
                  cloud: { agentRuntimeCount: summary.AgentRuntimeCount, errorCount: summary.ErrorCount, errorRate: summary.ErrorRate },
                } };
              } catch { return { ok: true, value: local }; }
            }
            if (endpoint === 'traces/list') {
              const local = await observability.list(payload || {});
              try {
                const cloud = await serverClient.listAgentRuntimeStats({ Page: 1, PageSize: 100 }, { signal });
                const rows = cloud?.Items || cloud?.items || [];
                const cloudItems = rows.map(row => ({
                  traceId: String(row.AgentId || row.RuntimeId || ''),
                  agentId: String(row.AgentId || ''),
                  agentName: String(row.AgentName || row.AgentId || ''),
                  sessionId: '', status: String(row.Status || row.Phase || ''),
                  startedAt: row.StartTime || row.CreatedAt || null, completedAt: row.EndTime || null,
                  tokenUsage: { totalTokens: Number(row.TokenCount || row.TotalTokens || 0) },
                  spanCount: 0,
                }));
                return { ok: true, value: { items: [...local.items, ...cloudItems] } };
              } catch { return { ok: true, value: local }; }
            }
            if (endpoint === 'traces/get') return { ok: true, value: await observability.get(payload?.traceId) };
            if (endpoint === 'traces/otlp') return { ok: true, value: await observability.getOtlp(payload?.traceId) };
          }
          if (endpoint.startsWith('evaluations/')) {
            const evaluation = await studioEvaluationPromise;
            if (!evaluation) return { ok: false, error: { code: 'EVALUATION_UNAVAILABLE', message: '评测模块未初始化', details: {} } };
            if (endpoint === 'evaluations/list') return { ok: true, value: await evaluation.listRuns(payload || {}) };
            if (endpoint === 'evaluations/get') return { ok: true, value: await evaluation.getRun(payload?.runId) };
            if (endpoint === 'evaluations/targets') {
              const studio = await studioBuildPromise;
              const builds = [];
              for (const agent of (await serverClient.listAgents({ page: 1, pageSize: 50 }, { signal })).items || []) {
                builds.push(...await studio.build.list(agent?.metadata?.id || agent?.id || ''));
              }
              return { ok: true, value: await evaluation.listTargets({ builds }) };
            }
            if (endpoint === 'evaluations/evalsets') return { ok: true, value: await evaluation.listEvalsets() };
            if (endpoint === 'evaluations/import') return { ok: true, value: await evaluation.importEvalset({ content: payload?.content, fileName: payload?.fileName }) };
            if (endpoint === 'evaluations/create') return { ok: true, value: await evaluation.createEvaluation(payload || {}) };
          }
          if (endpoint.startsWith('channels/')) {
            const channels = await studioChannelsPromise;
            if (!channels) return { ok: false, error: { code: 'CHANNELS_UNAVAILABLE', message: '渠道模块未初始化', details: {} } };
            if (endpoint === 'channels/connection') return { ok: true, value: await channels.getConnection() };
            if (endpoint === 'channels/update') return { ok: true, value: await channels.updateConnection(payload || {}) };
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
        void Promise.all([agentStorePromise, configurationPromise, resourceAdaptersPromise, studioObservabilityPromise]).then(async ([store, configuration, resourceAdapters, observability]) => {
          const credentials = ctx.get('credentials');
          const models = await import('./model-service.mjs').then(({ createModelService }) => createModelService({ configuration, credentials }));
          const { createLocalConversationHandler } = await import('./local-runtime.mjs');
          return createLocalConversationHandler({ agentStore: async () => store, modelService: models, resourceAdapter: resourceAdapters, observability });
        }).then(handler => handler(request, response)).catch(error => {
          console.error('[local-runtime] handler failed:', error?.stack || error);
          if (!response.headersSent) response.writeHead(500);
          response.end(JSON.stringify({ error: { message: String(error?.message || error).slice(0, 200) } }));
        });
      },
    });
    const cloudConversationRoute = webCtx.webServer.register({
      kind: 'prefix',
      path: '/agentkit/cloud-conversation',
      handler: async (request, response) => {
        const admission = webCtx.connection.admit(request);
        if ('rejection' in admission) { response.writeHead(admission.rejection); response.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden'); return; }
        if (request.method !== 'POST') { response.writeHead(404); response.end('not found'); return; }
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
          });
          response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
          for await (const chunk of upstream.body) response.write(chunk);
          response.end();
        } catch (error) {
          if (!response.headersSent) response.writeHead(error?.status || 502, { 'content-type': 'application/json' });
          if (!response.writableEnded) response.end(JSON.stringify({ error: { code: error?.code || 'CLOUD_CONVERSATION_FAILED', message: error instanceof Error ? error.message : String(error) } }));
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
