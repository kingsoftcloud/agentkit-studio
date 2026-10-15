/** Controlled service adapters for the fixed-ref routing contract recordings. */
import { isDeepStrictEqual } from 'node:util';

export function compactRouteCalls(value, payload) {
  if (value && typeof value === 'object' && isDeepStrictEqual(value, payload)) return { $fixture: 'payload' };
  if (Array.isArray(value)) return value.map(item => compactRouteCalls(item, payload));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compactRouteCalls(item, payload)]));
  return value;
}

export function normalizeRouteValue(value) {
  if (value === undefined) return '[undefined]';
  if (typeof value === 'function') return '[function]';
  if (value instanceof AbortSignal) return { aborted: value.aborted };
  if (Array.isArray(value)) return value.map(normalizeRouteValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeRouteValue(item)]));
  return value;
}

export function createHostRouteFixture(mode = 'success') {
  const calls = [];
  const agent = { metadata: { id: 'agent-fixture', name: 'Fixture', revision: 3, local: true }, spec: { runtime: { type: 'harness' }, instructions: { system: 'fixture' }, bindings: {} } };
  const build = { ...agent, id: 'build_aaaaaaaaaaaaaaaaaaaa', agentId: 'agent-fixture', revision: 3, status: 'SUCCEEDED' };
  function method(name, result) {
    return async (...args) => {
      calls.push([name, normalizeRouteValue(args)]);
      if (mode === 'backend-error') throw Object.assign(new Error('fixture backend failure'), { code: 'FIXTURE_BACKEND_FAILED', status: 409, details: { reason: 'fixture' } });
      return structuredClone(typeof result === 'function' ? result(...args) : result);
    };
  }
  const service = (name, values) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, method(`${name}.${key}`, value)]));
  const agentStore = service('agents', { get: agent, getRevision: agent, captureRevision: agent, create: agent, update: agent, remove: {}, list: [agent] });
  const serverClient = service('server', {
    getAgent: agent, action: { data: { Events: [], AfterSeqId: 7, Deleted: true }, requestId: 'fixture-request' },
    listResource: { items: [], total: 0 }, listCatalogResources: { items: [], total: 0 },
    getObservabilityOverview: { Summary: { SessionCount: 1, TokenCount: 2, AgentRuntimeCount: 3, ErrorCount: 0, ErrorRate: 0 } },
  });
  const models = service('models', { sync: { configured: true }, settings: { modelProfiles: [] }, save: {}, create: { id: 'fixture-model' }, catalog: { defaultModel: 'fixture-model', items: [] } });
  const credentialsService = service('credentials', { set: undefined, describe: { configured: true, source: 'managed' }, resolve: { value: 'fixture-value' } });
  const skillDiscovery = service('skills', { discover: { items: [] }, previewDiscovered: {}, commitDiscovered: {}, listInstalled: { items: [] }, previewInstalled: {} });
  const localMcpStore = service('mcp', { create: { resourceId: 'mcp-local-fixture' }, update: {}, get: { resourceId: 'mcp-local-fixture' }, remove: { deleted: true }, list: [] });
  const studio = {
    build: service('build', { resolve: build, list: [build], download: { filename: 'fixture.zip', base64: 'UEs=' } }),
    operations: service('operations', { submit: { id: 'operation-fixture', status: 'QUEUED' }, list: [], cancel: {} }),
  };
  const scheduler = service('scheduler', { listSchedules: [], createSchedule: {}, getSchedule: {}, updateSchedule: {}, deleteSchedule: {}, runNow: {}, listOccurrences: [] });
  scheduler.availability = () => ({ triggerActive: true, runnerAvailable: true });
  const observability = service('traces', { overview: { total: 1 }, list: { items: [] }, get: {}, getOtlp: {} });
  const evaluation = service('evaluations', { listRuns: { items: [] }, getRun: {}, listTargets: { items: [] }, listEvalsets: { items: [] }, importEvalset: {}, createEvaluation: {} });
  const channels = service('channels', { getConnection: {}, updateConnection: {}, updateAgentConnection: {}, proxyAction: {} });
  const deployment = service('deployments', Object.fromEntries(['prepare', 'create', 'prepareUpdate', 'applyUpdate', 'list', 'get', 'refresh', 'repairAccess', 'reconcile', 'logs', 'remove'].map(name => [name, { result: name }])));
  const dshPlugins = service('dshPlugins', { listDsh: { items: [] }, installDsh: {}, uninstallDsh: {}, setDshEnabled: {}, updateDsh: {} });
  const codexPlugins = service('codexPlugins', { listCodex: { items: [] }, inspectCodex: {}, installCodex: {}, uninstallCodex: {} });
  const exporter = {
    sessionLogExportDeps: () => ({ sessionPersistence: {} }),
    flushLiveSessionLog: method('session.flush', undefined),
    readSessionLogText: method('session.read', '{"type":"fixture"}\n'),
  };
  const admission = { ensure: method('admission.ensure', { presetId: 'fixture-preset' }) };
  const nativeSchedule = { catalog: method('nativeSchedule.catalog', []) };
  const ctx = { get: name => name === 'schedule' ? nativeSchedule : undefined };
  const deps = {
    agentStorePromise: Promise.resolve(agentStore), agentCatalogPromise: Promise.resolve({ list: method('agentCatalog.list', { items: [agent], total: 1 }) }),
    serverClientPromise: Promise.resolve(serverClient), configurationPromise: Promise.resolve({}), credentialsService,
    models, syncModelCredential: models.sync, describeGlobalModelCredential: method('credentials.status', { configured: true }),
    listCodexAgentModels: method('models.codex', { items: [] }), codexModels: {},
    skillDiscoveryPromise: Promise.resolve(skillDiscovery), localMcpStorePromise: Promise.resolve(localMcpStore),
    mcpProbePromise: Promise.resolve({ probe: method('mcp.probe', { toolCount: 1 }) }),
    studioBuildPromise: Promise.resolve(studio), portableBundles: { prepare: method('portable.prepare', { id: 'portable-fixture' }) },
    studioSchedulerPromise: Promise.resolve(scheduler), studioObservabilityPromise: Promise.resolve(observability),
    studioEvaluationPromise: Promise.resolve(evaluation), studioChannelsPromise: Promise.resolve(channels),
    cloudSchedulesPromise: Promise.resolve({ execute: method('cloudSchedules.execute', {}) }),
    deployments: async () => deployment, getAdmission: () => admission,
    listLocalBuildTargets: method('build.targets', [build]),
    getDshPlugins: async () => dshPlugins, getCodexPlugins: async () => codexPlugins, getSessionLogExporter: async () => exporter,
  };
  const payload = {
    agentId: 'agent-fixture', buildId: build.id, deploymentId: 'deployment-fixture', sessionId: 'session/fixture',
    resourceId: 'mcp-local-fixture', taskId: 'task-fixture', runId: 'run-fixture', operationId: 'operation-fixture',
    name: 'Fixture', value: 'fixture-value', runtimeType: 'harness', spec: agent.spec, bindings: {}, revision: 3,
    source: 'fixture-source', pluginName: 'fixture-plugin', pluginId: 'fixture-plugin', marketplaceName: 'fixture-market',
    fileName: 'fixture.yaml', content: 'cases: []', scanPaths: ['fixture'], candidateId: 'candidate', inspectionToken: 'inspection', path: 'README.md', overwrite: true,
    profileId: 'fixture', limit: 10, query: 'fixture', kind: 'tool', action: 'FixtureAction', payload: { fixture: true }, patch: { prompt: 'fixture' }, scope: 'local',
  };
  return { deps, ctx, calls, payload, admission, exporter, dshPlugins, codexPlugins };
}
