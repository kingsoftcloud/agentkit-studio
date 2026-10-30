/** Frozen HTTP response-projection SIGKILL acceptance.
 *
 *  PRESERVES portable-bundle.zip so loadPortableRuntime activates inside
 *  mountStudioHost, triggering bindFrozenRuntime/startFrozenBuildRuntime.
 *  The fixture observes the real Session (via resolveAgent) and injects a
 *  precise fault at one of two boundaries in frozen-response-projection.mjs's
 *  save() path:
 *
 *  before-append: after the Native Run completes and turn/end is persisted,
 *    but BEFORE session.append(FROZEN_RESPONSE_PROJECTION_EVENT, ...). The
 *    fixture wraps session.append to detect the projection event, write a
 *    checkpoint, then Atomics.wait-block until the verifier SIGKILLs the Host.
 *
 *  after-flush: after persistence.flush(session) returns true (projection
 *    appended and durable). The fixture wraps ctx.sessions.flush to detect
 *    the projection event, await the real flush === true, write a checkpoint,
 *    then Atomics.wait-block until the verifier SIGKILLs the Host.
 *
 *  On Host restart, a persistent checkpoint file prevents re-triggering the
 *  same fault. The verifier replays the same HTTP request_id and verifies the
 *  projection is served from the original Session history with zero new
 *  model/tool calls. */
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { createStudioBuild } from '../../src/studio-build.mjs';
import { createPortableBundles, importPortableBundle } from '../../src/portable-bundle.mjs';
import { selectedNativeBuildContract } from '../../src/build-engine.mjs';
import { createAgentStore } from '../../src/agent-store.mjs';
import { dshPresetId } from '../../src/agent-preset-admission.mjs';
import { readZipFiles } from '../../src/zip.mjs';

export const name = 'studio-native-response-crash-proof';
export const inject = ['llm', 'sessions', 'sessionProjections', 'agents', 'agentPresets', 'credentials', 'connection', 'webServer', 'sessionController'];

const TEN_TOOLS = ['workspace_status', 'list_workspace_files', 'read_workspace_file', 'write_workspace_file',
  'write_workspace_files', 'edit_workspace_file', 'multi_edit_workspace_file', 'lint_workspace_file',
  'search_workspace_files', 'delete_workspace_file'];

const PROJECTION_EVENT = 'studio/runtime-response-projection';

export async function apply(ctx, options) {
  try { await applyProof(ctx, options); }
  catch (error) {
    await writeFile(join(options.directory, 'fixture-startup-error.json'), JSON.stringify({ code: error.code, message: error.message, stack: error.stack }));
    throw error;
  }
}

async function applyProof(ctx, options) {
  const root = options.directory;
  const boundary = options.boundary; // 'before-append' or 'after-flush'
  const checkpointFile = join(root, 'crash-checkpoint.json');
  const identityFile = join(root, 'response-crash-identity.json');

  // On restart: if the checkpoint was already written (fault already triggered),
  // do NOT re-inject the fault. Just mount the Host normally.
  if (existsSync(identityFile)) {
    return await rehydrate(ctx, options, root, JSON.parse(await readFile(identityFile, 'utf8')));
  }

  // --- SOURCE side: create a Frozen Native Build.
  const sourceStore = join(root, 'source-store');
  const sourceBuild = createStudioBuild({ storeDir: sourceStore, nativeEngineContract: 'agentkit.native-dsh-turn/v1' });
  const sourceAgents = createAgentStore({ storeDir: join(sourceStore, 'agents') });
  const record = await sourceAgents.create({ name: 'Response Crash proof', runtimeType: 'harness',
    spec: { instructions: { system: 'PORTABLE_CRASH_SYSTEM' }, bindings: { tools: [...TEN_TOOLS], modelProfileId: 'portable-crash' } } });
  const built = await sourceBuild.build({ agentId: record.metadata.id, agentName: record.metadata.name,
    revision: record.metadata.revision, metadata: record.metadata, spec: record.spec, bindings: record.spec.bindings });

  const models = { profile: async id => ({ id, provider: 'openai-compatible', modelName: 'pinned',
    baseUrl: options.modelUrl, credentialName: 'PORTABLE_CRASH_KEY', apiKey: 'source-crash-secret' }) };
  const adapters = { describeMcp: async () => { throw Error('No MCP bound'); }, loadSkill: async () => { throw Error('No Skill bound'); } };
  const configuration = { resolve: async () => ({ values: {} }) };
  const portable = createPortableBundles({ storeDir: sourceStore, build: sourceBuild, models, adapters, configuration });
  const prepared = await portable.prepare(record.metadata.id, built.id);
  const zip = Buffer.from((await portable.download(record.metadata.id, built.id, prepared.bundleId)).base64, 'base64');

  // Recursive decompressed leak check.
  const zipEntries = readZipFiles(zip);
  const bundleEntry = zipEntries.find(entry => entry.name === 'agent-bundle.zip');
  const innerEntries = readZipFiles(bundleEntry.data);
  const allEntryBytes = Buffer.concat([...zipEntries.map(entry => entry.data), ...innerEntries.map(entry => entry.data)]);
  const sourcePathLeaked = allEntryBytes.includes(Buffer.from(root)) || allEntryBytes.includes(Buffer.from(sourceStore));
  const sourceSecretLeaked = allEntryBytes.includes(Buffer.from('source-crash-secret'));
  assert.equal(sourcePathLeaked, false, 'source absolute path leaked');
  assert.equal(sourceSecretLeaked, false, 'source secret leaked');

  // --- TARGET side: import.
  const target = join(root, 'target-home');
  const imported = await importPortableBundle(zip, target);
  await rm(sourceStore, { recursive: true, force: true });

  const targetBuild = createStudioBuild({ storeDir: join(target, 'studio') });
  const frozen = await targetBuild.resolve(imported.agentId, imported.buildId);
  assert.equal(selectedNativeBuildContract(frozen), 'agentkit.native-dsh-turn/v1');
  assert.deepEqual(frozen.bindings.tools, [...TEN_TOOLS]);

  const workspaceRoot = join(root, 'workspace');
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(join(workspaceRoot, 'target.txt'), 'Original crash bytes.');
  await writeFile(join(target, 'config.yaml'), JSON.stringify({ modelProfiles: [{ id: 'portable-crash',
    provider: 'openai-compatible', modelName: 'pinned', baseUrl: options.modelUrl, default: true,
    credentialName: 'PORTABLE_CRASH_KEY' }], modelProfileKeys: { PORTABLE_CRASH_KEY: 'target-only-secret' } }), { mode: 0o600 });

  const { mountStudioHost } = await import('@kingsoftcloud/agentkit-studio/host-bootstrap');
  await mountStudioHost(ctx, { configurationHome: target, env: {
    AGENTKIT_HOME: target, AGENTKIT_STUDIO_WORKSPACE: workspaceRoot,
    AGENTKIT_RUNTIME_AGENT_ID: imported.agentId, AGENTKIT_RUNTIME_BUILD_ID: imported.buildId,
    AGENTKIT_RUNTIME_TOKEN: options.runtimeToken, AGENTKIT_RUNTIME_PORT: String(options.runtimePort),
    PORTABLE_CRASH_KEY: 'target-only-secret',
  } });

  ctx.llm.registerAdapter(['agentkit-studio-response-crash-proof'], {
    providerInfo: provider => ({ id: provider, name: 'Response Crash proof' }), providerRetryPolicy: () => undefined,
    listModels: async provider => [{ provider, id: 'pinned', name: 'pinned' }],
    resolveModel: (provider, model) => ({ provider, id: model, name: model }),
    prepareCall: () => { throw Error('DSH model loop entered during response crash proof'); },
  });

  // --- Inject the fault at the specified boundary.
  // Observe agent/created to wrap the real Session's append or the sessions
  // flush method — both are real DSH objects obtained via the public API.
  ctx.on('agent/created', async ({ agent }) => {
    // The Frozen HTTP runtime creates sessions with a 'runtime-*' prefix.
    if (!agent.session.id.startsWith('runtime-')) return;
    const session = agent.session;
    if (typeof session.append !== 'function') return;

    if (boundary === 'before-append') {
      // Wrap session.append: detect the projection event, write checkpoint,
      // then block until SIGKILL (before the real append runs).
      const originalAppend = session.append.bind(session);
      session.append = (type, data, options) => {
        if (type === PROJECTION_EVENT && !existsSync(checkpointFile)) {
          const checkpoint = { boundary, pid: process.pid, time: Date.now(), type, sessionId: session.id,
            responseId: data?.responseId, requestId: data?.requestId };
          writeCheckpoint(checkpointFile, checkpoint);
          // Block indefinitely until the verifier SIGKILLs the process.
          // Atomics.wait on a shared Int32Array is the standard sync block.
          const buf = new Int32Array(new SharedArrayBuffer(4), 0, 1);
          Atomics.wait(buf, 0, 0, 300_000); // 5 min max; SIGKILL should come sooner
        }
        return originalAppend(type, data, options);
      };
    } else if (boundary === 'after-flush') {
      // Wrap ctx.sessions.flush: detect when a session with the projection
      // event is flushed, await the real flush === true, write checkpoint,
      // then block until SIGKILL.
      const originalFlush = ctx.sessions.flush.bind(ctx.sessions);
      ctx.sessions.flush = async sess => {
        const durable = await originalFlush(sess);
        // Only trigger after a successful flush of a session that now has
        // the projection event.
        if (durable === true && !existsSync(checkpointFile)) {
          const events = sess.snapshotEvents?.() ?? [];
          const hasProjection = events.some(e => e.type === PROJECTION_EVENT);
          if (hasProjection) {
            const projEvent = events.find(e => e.type === PROJECTION_EVENT);
            const checkpoint = { boundary, pid: process.pid, time: Date.now(),
              sessionId: sess.id, responseId: projEvent?.data?.responseId, requestId: projEvent?.data?.requestId };
            writeCheckpoint(checkpointFile, checkpoint);
            const buf = new Int32Array(new SharedArrayBuffer(4), 0, 1);
            Atomics.wait(buf, 0, 0, 300_000);
          }
        }
        return durable;
      };
    }
  });

  await writeFile(identityFile, JSON.stringify({ agentId: imported.agentId, buildId: imported.buildId,
    presetId: dshPresetId(record.metadata.id, record.metadata.revision, built.id),
    runtimeToken: options.runtimeToken, runtimePort: options.runtimePort, boundary,
    sourcePathLeaked, sourceSecretLeaked,
    importedRequirements: imported.requirements.map(item => item.name) }), { mode: 0o600 });
}

function writeCheckpoint(path, data) {
  const fd = openSync(path, 'w');
  try { writeFileSync(fd, JSON.stringify(data, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
}

async function rehydrate(ctx, options, root, identity) {
  const target = join(root, 'target-home');
  const workspaceRoot = join(root, 'workspace');
  const { mountStudioHost } = await import('@kingsoftcloud/agentkit-studio/host-bootstrap');
  await mountStudioHost(ctx, { configurationHome: target, env: {
    AGENTKIT_HOME: target, AGENTKIT_STUDIO_WORKSPACE: workspaceRoot,
    AGENTKIT_RUNTIME_AGENT_ID: identity.agentId, AGENTKIT_RUNTIME_BUILD_ID: identity.buildId,
    AGENTKIT_RUNTIME_TOKEN: identity.runtimeToken, AGENTKIT_RUNTIME_PORT: String(identity.runtimePort),
    PORTABLE_CRASH_KEY: 'target-only-secret',
  } });
  ctx.llm.registerAdapter(['agentkit-studio-response-crash-proof'], {
    providerInfo: provider => ({ id: provider, name: 'Response Crash proof' }), providerRetryPolicy: () => undefined,
    listModels: async provider => [{ provider, id: 'pinned', name: 'pinned' }],
    resolveModel: (provider, model) => ({ provider, id: model, name: model }),
    prepareCall: () => { throw Error('DSH model loop entered during response crash proof'); },
  });
}
