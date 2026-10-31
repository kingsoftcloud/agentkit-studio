/** Observes a real packed Host; never supplies an executor, ledger, or wake. */
import { appendFileSync, existsSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAgentStore } from '../../src/agent-store.mjs';
import { dshPresetId } from '../../src/agent-preset-admission.mjs';
import { parseNativeJson } from '@kingsoftcloud/agentkit-harness-core';

export const name = 'studio-native-background-proof';
export const inject = ['llm', 'sessions', 'sessionProjections', 'agents', 'agentPresets',
  'credentials', 'connection', 'webServer', 'sessionController', 'permissionPresets', 'approval'];
export async function apply(ctx, options) {
  const root = options.directory, workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  const store = createAgentStore({ storeDir: join(root, 'studio/agents') });
  const identityFile = join(root, 'identity.json');
  let identity;
  try { identity = JSON.parse(await readFile(identityFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let record = identity ? await store.get(identity.agentId) : await store.create({
    name: 'Native background proof', runtimeType: 'harness',
    ...(options.frozen ? { spec: { instructions: { system: 'FROZEN_BACKGROUND_SYSTEM' } } } : {}),
    bindings: { modelProfileIds: ['fixture'], tools: ['run_command'] },
  });
  identity = { ...identity, agentId: record.metadata.id, sessionId: 'native-background-session' };
  if (options.frozen) {
    const { createStudioBuild } = await import('../../src/studio-build.mjs');
    const builds = createStudioBuild({ storeDir: join(root, 'studio'), nativeEngineContract: 'agentkit.native-dsh-turn/v1' });
    if (!identity.buildId) {
      const built = await builds.build({ agentId: record.metadata.id, agentName: record.metadata.name,
        revision: record.metadata.revision, metadata: record.metadata, spec: record.spec, bindings: record.spec.bindings });
      identity.buildId = built.id;
      await store.update(record.metadata.id, { spec: { ...record.spec, instructions: { system: 'LIVE_BACKGROUND_SYSTEM_CHANGED' } } });
    }
    record = await builds.resolve(identity.agentId, identity.buildId);
  }
  await writeFile(identityFile, JSON.stringify(identity));
  await writeFile(join(root, 'config.yaml'), JSON.stringify({ modelProfiles: [{ id: 'fixture',
    provider: 'openai-compatible', modelName: 'pinned', baseUrl: options.modelUrl,
    default: true, credentialName: 'PROOF_KEY' }], modelProfileKeys: { PROOF_KEY: 'background-proof-secret' } }), { mode: 0o600 });
  const warn = console.warn;
  const logError = console.error;
  console.warn = (...args) => { appendFileSync(join(root, 'warnings.log'), args.map(String).join(' ') + '\n'); warn(...args); };
  console.error = (...args) => { appendFileSync(join(root, 'errors.log'), args.map(String).join(' ') + '\n'); logError(...args); };
  ctx.effect(() => () => { console.warn = warn; console.error = logError; }, 'Background proof diagnostics');
  ctx.llm.registerAdapter(['agentkit-studio-fixture'], {
    providerInfo: provider => ({ id: provider, name: 'Background proof' }), providerRetryPolicy: () => undefined,
    listModels: async provider => [{ provider, id: 'pinned', name: 'pinned' }],
    resolveModel: (provider, model) => ({ provider, id: model, name: model }),
    prepareCall: () => { throw Error('Default DSH model loop entered during Native background execution'); },
  });
  const { mountStudioHost } = await import('@kingsoftcloud/agentkit-studio/host-bootstrap');
  await mountStudioHost(ctx, { configurationHome: root, env: { AGENTKIT_HOME: root,
    AGENTKIT_STUDIO_WORKSPACE: workspace, ...(!options.frozen ? { AGENTKIT_STUDIO_NATIVE_HARNESS: 'agentkit.native-dsh-turn/v1' } : {}) } });
  const presetId = dshPresetId(record.metadata.id, record.metadata.revision, record.buildId || '');
  ctx.on('agent/created', async ({ agent, source }) => {
    if (agent.session.id !== identity.sessionId) return;
    if (source !== 'resume') {
      const origin = ctx.webServer.getOrigin();
      const login = await fetch(ctx.connection.authenticatedUrl(origin + '/connect'), { redirect: 'manual', signal: AbortSignal.timeout(5000) });
      if (login.status !== 302) throw Error('Background proof authentication failed');
      const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
      const response = await fetch(origin + '/agentkit', { method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'agents/ensure-preset', payload: { agentId: identity.agentId,
          ...(record.buildId ? { buildId: record.buildId } : {}) } }), signal: AbortSignal.timeout(10000) });
      const result = (await response.json()).result;
      if (!result?.ok || result.value.presetId !== presetId) throw Error('Production background preset admission failed');
      await ctx.agentPresets.select(agent, presetId);
    } else {
      if (ctx.sessionProjections.stateOf(agent.session, 'agentPreset') !== presetId) throw Error('Cold background preset changed');
      await ctx.agentPresets.recompose(agent.ctx, presetId);
    }
    appendFileSync(join(root, 'session-loads.jsonl'), JSON.stringify({ source, sessionId: agent.session.id, pid: process.pid }) + '\n');
  });
  ctx.on('tools/pre-execute', async (exec, next) => {
    appendFileSync(join(root, 'tool-admissions.jsonl'), JSON.stringify({ name: exec.name, callId: exec.callId, sessionId: exec.agent.session.id }) + '\n');
    return next();
  });
  // A deterministic human response still goes through the production approval
  // service and its durable asked/decided events.
  ctx.on('approval/request', async request => {
    if (request.agent.session.id === identity.sessionId && request.toolName === 'run_command') return 'allowed-once';
  }, { prepend: true });
  if (options.boundary === 'prepare') {
    const { SqliteRunStore } = await import('@kingsoftcloud/agentkit-harness-node/native/sqlite-store');
    const originalCreate = SqliteRunStore.prototype.createNotification, marker = join(root, 'prepare-checkpoint.json');
    SqliteRunStore.prototype.createNotification = function (configuration, snapshot) {
      const admitted = originalCreate.call(this, configuration, snapshot);
      if (snapshot.sessionId === identity.sessionId && admitted.created && !existsSync(marker)) {
        writeFileSync(marker, JSON.stringify({ pid: process.pid, runId: snapshot.runId,
          configDigest: snapshot.configDigest, scope: snapshot.scope }));
        const fd = openSync(marker, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
        // Stop immediately AFTER the real SQLite admission transaction and
        // BEFORE the SDK can claim ownership. No replacement ledger is used.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }
      return admitted;
    };
    ctx.effect(() => () => { SqliteRunStore.prototype.createNotification = originalCreate; }, 'Background admission crash checkpoint');
  }
  if (options.boundary === 'owner') {
    const originalFlush = ctx.sessions.flush.bind(ctx.sessions), marker = join(root, 'owner-checkpoint.json');
    ctx.sessions.flush = async session => {
      const durable = await originalFlush(session);
      const owner = session.snapshotEvents().findLast(event => event.type === 'turn/owner');
      if (durable === true && session.id === identity.sessionId && owner
        && owner.data.engine === 'agentkit.native-dsh-background-turn/v1' && !existsSync(marker)) {
        const binding = parseNativeJson(owner.data.binding);
        writeFileSync(marker, JSON.stringify({ pid: process.pid, owner, binding, events: session.snapshotEvents() }));
        const fd = openSync(marker, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
        // Parent sends SIGKILL to this actual Host PID. No graceful teardown or
        // synthetic Session/Native rows stand in for process death.
        await new Promise(() => {});
      }
      return durable;
    };
    ctx.effect(() => () => { ctx.sessions.flush = originalFlush; }, 'Background owner crash checkpoint');
  }
  await writeFile(join(root, 'host-ready.json'), JSON.stringify({ pid: process.pid }));
}
