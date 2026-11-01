/** Packed-Host acceptance: a portable-imported Native Frozen Build executes a
 *  complete Native Run through the real DSH SDK, Host, preset, SessionController
 *  and ToolRegistry.
 *
 *  The fixture mirrors the real migration path inside the packed Studio Host:
 *  a source Agent's Frozen Native Build (ten Node workspace builtins) is
 *  prepared as a portable archive, imported into a fresh isolated
 *  AGENTKIT_HOME, the source store is removed, and the target Host — with its
 *  live Native default OFF — mounts the imported Build and admits its preset.
 *
 *  The verifier drives the actual session.run() through the DSH SDK; this
 *  fixture composes the Host, preset admission, the model adapter (which throws
 *  if the DSH model loop is entered), and the tools/pre-execute (permission
 *  denial only; path escape is left to the real Native workspace boundary) and
 *  tools/post-execute (steer) hooks — the same assembly proven by
 *  studio-native-harness.mjs --frozen --mount-host.
 *
 *  Boundary: this verifies the "imported Frozen Build executed from the target
 *  store" path, not the loadPortableRuntime/portable HTTP path (the portable
 *  archive is intentionally removed so loadPortableRuntime returns null). */
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createStudioBuild } from '../../src/studio-build.mjs';
import { createPortableBundles, importPortableBundle } from '../../src/portable-bundle.mjs';
import { selectedNativeBuildContract } from '../../src/build-engine.mjs';
import { createAgentStore } from '../../src/agent-store.mjs';
import { dshPresetId } from '../../src/agent-preset-admission.mjs';
import { readZipFiles } from '../../src/zip.mjs';

export const name = 'studio-native-portable-proof';
export const inject = ['llm', 'sessions', 'sessionProjections', 'agents', 'agentPresets', 'credentials', 'connection', 'webServer', 'sessionController'];

const TEN_TOOLS = ['workspace_status', 'list_workspace_files', 'read_workspace_file', 'write_workspace_file',
  'write_workspace_files', 'edit_workspace_file', 'multi_edit_workspace_file', 'lint_workspace_file',
  'search_workspace_files', 'delete_workspace_file'];

export async function apply(ctx, options) {
  try { await applyProof(ctx, options); }
  catch (error) {
    await writeFile(join(options.directory, 'fixture-startup-error.json'), JSON.stringify({ code: error.code, message: error.message, stack: error.stack }));
    throw error;
  }
}

async function applyProof(ctx, options) {
  const root = options.directory;
  const identityFile = join(root, 'portable-identity.json');
  if (existsSync(identityFile)) return await rehydrate(ctx, options, root, JSON.parse(await readFile(identityFile, 'utf8')));

  // --- SOURCE side: create a Frozen Native Build with ten Node workspace tools.
  const sourceStore = join(root, 'source-store'), sourceWorkspace = join(root, 'source-workspace');
  await mkdir(sourceWorkspace, { recursive: true });
  const sourceBuild = createStudioBuild({ storeDir: sourceStore, nativeEngineContract: 'agentkit.native-dsh-turn/v1' });
  const sourceAgents = createAgentStore({ storeDir: join(sourceStore, 'agents') });
  const record = await sourceAgents.create({ name: 'Portable Native proof', runtimeType: 'harness',
    spec: { instructions: { system: 'PORTABLE_NATIVE_SYSTEM' }, bindings: { tools: [...TEN_TOOLS], modelProfileId: 'portable-proof' } } });
  const built = await sourceBuild.build({ agentId: record.metadata.id, agentName: record.metadata.name,
    revision: record.metadata.revision, metadata: record.metadata, spec: record.spec, bindings: record.spec.bindings });

  const models = { profile: async id => ({ id, provider: 'openai-compatible', modelName: 'pinned',
    baseUrl: options.modelUrl, credentialName: 'PORTABLE_PROOF_KEY', apiKey: 'source-model-secret' }) };
  const adapters = { describeMcp: async () => { throw Error('No MCP bound'); }, loadSkill: async () => { throw Error('No Skill bound'); } };
  const configuration = { resolve: async () => ({ values: {} }) };
  const portable = createPortableBundles({ storeDir: sourceStore, build: sourceBuild, models, adapters, configuration });
  const prepared = await portable.prepare(record.metadata.id, built.id);
  const zip = Buffer.from((await portable.download(record.metadata.id, built.id, prepared.bundleId)).base64, 'base64');

  // Verify the decompressed archive entries do not leak source paths or secrets.
  // readZipFiles decompresses each entry; check the actual bytes, not raw ZIP.
  const zipEntries = readZipFiles(zip);
  const manifestEntry = zipEntries.find(entry => entry.name === 'portable.json');
  const bundleEntry = zipEntries.find(entry => entry.name === 'agent-bundle.zip');
  assert.ok(manifestEntry && bundleEntry, 'portable.json and agent-bundle.zip must be in the archive');
  assert.ok(!manifestEntry.data.includes(Buffer.from('source-model-secret')), 'portable.json must not carry the source secret');
  // Recursively decompress the inner agent-bundle.zip and check all its
  // entries (manifest, spec, README, bindings, profiles, resources) for leaks.
  const innerEntries = readZipFiles(bundleEntry.data);
  const allEntryBytes = Buffer.concat([...zipEntries.map(entry => entry.data), ...innerEntries.map(entry => entry.data)]);
  const sourcePathLeaked = allEntryBytes.includes(Buffer.from(root)) || allEntryBytes.includes(Buffer.from(sourceStore));
  const sourceSecretLeaked = allEntryBytes.includes(Buffer.from('source-model-secret'));
  assert.equal(sourcePathLeaked, false, 'source absolute path leaked into decompressed archive entries');
  assert.equal(sourceSecretLeaked, false, 'source secret leaked into decompressed archive entries');
  // Check inner entries individually for the source secret.
  const innerManifest = innerEntries.find(entry => entry.name === 'agent-bundle/manifest.json');
  const innerSpec = innerEntries.find(entry => entry.name === 'agent-bundle/spec.json');
  assert.ok(innerManifest && innerSpec, 'agent-bundle must contain manifest.json and spec.json');
  assert.ok(!innerManifest.data.includes(Buffer.from('source-model-secret')), 'inner manifest must not carry the source secret');
  assert.ok(!innerSpec.data.includes(Buffer.from('source-model-secret')), 'inner spec must not carry the source secret');

  // --- TARGET side: import into a fresh isolated AGENTKIT_HOME.
  const target = join(root, 'target-home');
  const imported = await importPortableBundle(zip, target);
  assert.equal(imported.agentId, record.metadata.id);
  assert.equal(imported.buildId, built.id);

  // Remove the entire source: the target stands alone with no fallback.
  await rm(sourceStore, { recursive: true, force: true });
  await rm(sourceWorkspace, { recursive: true, force: true });

  // The imported Build resolves to its frozen Native engine with no live default.
  const targetBuild = createStudioBuild({ storeDir: join(target, 'studio') });
  const frozen = await targetBuild.resolve(imported.agentId, imported.buildId);
  assert.equal(selectedNativeBuildContract(frozen), 'agentkit.native-dsh-turn/v1');
  assert.deepEqual(frozen.bindings.tools, [...TEN_TOOLS]);

  // Remove the portable archive so loadPortableRuntime returns null: the frozen
  // Build in the target store drives the Native engine through the standard
  // preset/session path, not the separate frozen-build HTTP transport.
  await rm(join(target, 'portable-bundle.zip'), { force: true });

  const workspaceRoot = join(root, 'workspace');
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(join(root, 'outside.txt'), 'Outside the workspace.');
  await writeFile(join(target, 'config.yaml'), JSON.stringify({ modelProfiles: [{ id: 'portable-proof',
    provider: 'openai-compatible', modelName: 'pinned', baseUrl: options.modelUrl, default: true,
    credentialName: 'PORTABLE_PROOF_KEY' }], modelProfileKeys: { PORTABLE_PROOF_KEY: 'target-only-secret' } }), { mode: 0o600 });

  await mountHost(ctx, target, workspaceRoot);
  registerAdapter(ctx);
  registerHooks(ctx, root, record.metadata.id, built.id, presetId(record.metadata.id, record.metadata.revision, built.id));
  await writeFile(identityFile, JSON.stringify({ agentId: record.metadata.id, buildId: built.id,
    presetId: presetId(record.metadata.id, record.metadata.revision, built.id),
    sourcePathLeaked, sourceSecretLeaked,
    importedRequirements: imported.requirements.map(item => item.name) }), { mode: 0o600 });
}

const presetId = (agentId, revision, buildId) => dshPresetId(agentId, revision, buildId);

async function mountHost(ctx, target, workspaceRoot) {
  const { mountStudioHost } = await import('@kingsoftcloud/agentkit-studio/host-bootstrap');
  await mountStudioHost(ctx, { configurationHome: target, env: { AGENTKIT_HOME: target, AGENTKIT_STUDIO_WORKSPACE: workspaceRoot } });
}

function registerAdapter(ctx) {
  ctx.llm.registerAdapter(['agentkit-studio-portable-proof'], {
    providerInfo: provider => ({ id: provider, name: 'Portable Native proof' }), providerRetryPolicy: () => undefined,
    listModels: async provider => [{ provider, id: 'pinned', name: 'pinned' }],
    resolveModel: (provider, model) => ({ provider, id: model, name: model }),
    prepareCall: () => { throw Error('DSH model loop entered during portable Native execution'); },
  });
}

function registerHooks(ctx, root, agentId, buildId, preset) {
  ctx.on('agent/created', async ({ agent, source }) => {
    if (agent.session.id !== 'portable-native-session') return;
    const origin = ctx.webServer.getOrigin();
    const unauthorized = await fetch(origin + '/agentkit', { method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'host/compatibility', payload: {} }), signal: AbortSignal.timeout(5000) });
    if (unauthorized.status !== 401) throw Error('Mounted Host accepted unauthenticated control RPC');
    await unauthorized.text();
    const login = await fetch(ctx.connection.authenticatedUrl(origin + '/connect'), { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    if (login.status !== 302) throw Error('Portable proof connection authentication failed');
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const rpc = async (method, payload = {}) => {
      const response = await fetch(origin + '/agentkit', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify({ method, payload, rpcId: method }), signal: AbortSignal.timeout(10000) });
      const result = (await response.json()).result;
      if (response.status !== 200 || !result?.ok) throw Error(`Portable proof RPC ${method} failed: ${result?.error?.code}`);
      return result.value;
    };
    const compatibility = await rpc('host/compatibility');
    if (!compatibility.features['agent-presets'].available) throw Error('Mounted Host preset compatibility failed');
    const stored = await rpc('agents/local-get', { agentId });
    if (stored.metadata.id !== agentId) throw Error('Mounted Host read a different Agent');
    if (source !== 'resume') {
      const admitted = await rpc('agents/ensure-preset', { agentId, buildId });
      if (admitted.presetId !== preset) throw Error('Portable proof admitted a different preset');
    }
    await appendFile(join(root, 'mounted-host-http.jsonl'), JSON.stringify({ source, agentId, preset, unauthorizedStatus: unauthorized.status, compatible: true }) + '\n');
    const deadline = Date.now() + 15000;
    while (true) {
      try { await ctx.agentPresets.pluginsFor(preset); break; }
      catch (error) { if (error.code !== 'agent-preset/not-found' || Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 25)); }
    }
    if (source === 'resume') {
      if (ctx.sessionProjections.stateOf(agent.session, 'agentPreset') !== preset) throw Error('Portable proof preset identity was not persisted');
      await ctx.agentPresets.recompose(agent.ctx, preset);
    } else await ctx.agentPresets.select(agent, preset);
  });

  // Permission denial: the pre-execute hook rejects writes to 'denied.txt' only.
  // Path escape ('../outside.txt') is NOT intercepted here — it must reach the
  // real Native workspace schema/boundary and fail with a genuine error.
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.agent.session.id !== 'portable-native-session') return next();
    await appendFile(join(root, 'tool-admissions.jsonl'), JSON.stringify({ callId: exec.callId, name: exec.name, path: exec.arguments.path }) + '\n');
    if (exec.arguments.path === 'denied.txt') return { kind: 'deny', reason: 'Verification policy denied this write' };
    return next();
  });

  ctx.on('tools/post-execute', async (exec, result, next) => {
    if (exec.agent.session.id !== 'portable-native-session' || result.isError) return next();
    const path = exec.arguments.path;
    exec.agent.steer({ id: `portable-steer-${exec.callId}`, role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: `Live instruction for ${path}` }] });
    return { kind: 'accept', content: [{ type: 'text', text: `Published ${path} (policy view)` }],
      additionalContexts: [{ id: `context-${exec.callId}`, role: 'user', source: { kind: 'tool', callId: exec.callId },
        content: [{ type: 'text', text: `Loaded context for ${path}` }] }] };
  });
}

async function rehydrate(ctx, options, root, identity) {
  const target = join(root, 'target-home');
  const workspaceRoot = join(root, 'workspace');
  await mountHost(ctx, target, workspaceRoot);
  registerAdapter(ctx);
  registerHooks(ctx, root, identity.agentId, identity.buildId, identity.presetId);
}
