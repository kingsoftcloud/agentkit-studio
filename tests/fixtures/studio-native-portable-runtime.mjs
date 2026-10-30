/** Archive-present portable Frozen HTTP acceptance.
 *
 *  PRESERVES portable-bundle.zip so loadPortableRuntime activates inside the
 *  real packed mountStudioHost, triggering bindFrozenRuntime/startFrozenBuildRuntime
 *  and the production Frozen HTTP transport on /v1/responses. The Frozen runtime
 *  uses UNATTENDED_EXECUTION_POLICY (read-only/never) — this is a product
 *  constraint, not a gap. The proof verifies that write attempts are correctly
 *  denied by the real policy, original bytes are unchanged, and the complete
 *  HTTP/SQLite cold-replay lifecycle works.
 *
 *  Boundary: verifies the "archive-present loadPortableRuntime → Frozen HTTP"
 *  path. The portable-bundle.zip is NOT removed. No fresh dependency install.
 *  DSH standard model prepareCall throws if entered (Native owns the turn). */
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createStudioBuild } from '../../src/studio-build.mjs';
import { createPortableBundles, importPortableBundle, verifyPortableBundle } from '../../src/portable-bundle.mjs';
import { selectedNativeBuildContract } from '../../src/build-engine.mjs';
import { createAgentStore } from '../../src/agent-store.mjs';
import { dshPresetId } from '../../src/agent-preset-admission.mjs';
import { readZipFiles } from '../../src/zip.mjs';

export const name = 'studio-native-portable-runtime-proof';
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

  // Cordis reloads this scope when the registry changes. The first run creates
  // the source Build, prepares/imports the portable archive, and persists the
  // identity. On a reload, skip the irreversible steps and only re-mount the
  // Host + re-register the adapter (the verifier drives HTTP, not session.run,
  // so the adapter must be registered for the Frozen runtime's model calls).
  const identityFile = join(root, 'portable-runtime-identity.json');
  const { existsSync } = await import('node:fs');
  if (existsSync(identityFile)) {
    const identity = JSON.parse(await readFile(identityFile, 'utf8'));
    return await rehydrate(ctx, options, root, identity);
  }

  // --- SOURCE side: create a Frozen Native Build with ten Node workspace tools.
  const sourceStore = join(root, 'source-store');
  const sourceBuild = createStudioBuild({ storeDir: sourceStore, nativeEngineContract: 'agentkit.native-dsh-turn/v1' });
  const sourceAgents = createAgentStore({ storeDir: join(sourceStore, 'agents') });
  const record = await sourceAgents.create({ name: 'Portable Runtime proof', runtimeType: 'harness',
    spec: { instructions: { system: 'PORTABLE_RUNTIME_SYSTEM' }, bindings: {
      tools: [...TEN_TOOLS, ...(options.catalog ? ['web_search', 'web_fetch'] : [])], modelProfileId: 'portable-runtime' } } });
  const built = await sourceBuild.build({ agentId: record.metadata.id, agentName: record.metadata.name,
    revision: record.metadata.revision, metadata: record.metadata, spec: record.spec, bindings: record.spec.bindings });

  const models = { profile: async id => ({ id, provider: 'openai-compatible', modelName: 'pinned',
    baseUrl: options.modelUrl, credentialName: 'PORTABLE_RUNTIME_KEY', apiKey: 'source-runtime-secret' }) };
  const adapters = { describeMcp: async () => { throw Error('No MCP bound'); }, loadSkill: async () => { throw Error('No Skill bound'); } };
  const configuration = { resolve: async () => ({ values: {} }) };
  const portable = createPortableBundles({ storeDir: sourceStore, build: sourceBuild, models, adapters, configuration });
  const prepared = await portable.prepare(record.metadata.id, built.id);
  const zip = Buffer.from((await portable.download(record.metadata.id, built.id, prepared.bundleId)).base64, 'base64');
  const { manifest } = verifyPortableBundle(zip);
  assert.equal(manifest.nativeBuiltin.contract, `agentkit.portable-native-builtin/v${options.catalog ? 2 : 1}`);

  // Recursive decompressed leak check (outer + inner agent-bundle.zip).
  const zipEntries = readZipFiles(zip);
  const bundleEntry = zipEntries.find(entry => entry.name === 'agent-bundle.zip');
  const innerEntries = readZipFiles(bundleEntry.data);
  const allEntryBytes = Buffer.concat([...zipEntries.map(entry => entry.data), ...innerEntries.map(entry => entry.data)]);
  const sourcePathLeaked = allEntryBytes.includes(Buffer.from(root)) || allEntryBytes.includes(Buffer.from(sourceStore));
  const sourceSecretLeaked = allEntryBytes.includes(Buffer.from('source-runtime-secret'));
  assert.equal(sourcePathLeaked, false, 'source absolute path leaked into decompressed archive entries');
  assert.equal(sourceSecretLeaked, false, 'source secret leaked into decompressed archive entries');

  // --- TARGET side: import into a fresh isolated AGENTKIT_HOME.
  const target = join(root, 'target-home');
  const imported = await importPortableBundle(zip, target);
  await rm(sourceStore, { recursive: true, force: true });

  const targetBuild = createStudioBuild({ storeDir: join(target, 'studio') });
  const frozen = await targetBuild.resolve(imported.agentId, imported.buildId);
  assert.equal(selectedNativeBuildContract(frozen), 'agentkit.native-dsh-turn/v1');
  assert.deepEqual(frozen.bindings.tools, [...TEN_TOOLS, ...(options.catalog ? ['web_search', 'web_fetch'] : [])]);

  // PRESERVE portable-bundle.zip. Pre-seed the workspace with a known file so the
  // proof can verify read-after-write-deny (bytes unchanged) without relying on
  // the read-only policy to allow creating files.
  const workspaceRoot = join(root, 'workspace');
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(join(workspaceRoot, 'target.txt'), 'Original frozen bytes.');
  await writeFile(join(target, 'config.yaml'), JSON.stringify({ modelProfiles: [{ id: 'portable-runtime',
    provider: 'openai-compatible', modelName: 'pinned', baseUrl: options.modelUrl, default: true,
    credentialName: 'PORTABLE_RUNTIME_KEY' }], modelProfileKeys: { PORTABLE_RUNTIME_KEY: 'target-only-secret' } }), { mode: 0o600 });

  // Mount the Host with runtime env vars so loadPortableRuntime activates and
  // startFrozenBuildRuntime starts the Frozen HTTP transport. The verifier
  // pre-selects a free port and passes it via options.runtimePort.
  const { mountStudioHost } = await import('@kingsoftcloud/agentkit-studio/host-bootstrap');
  await mountStudioHost(ctx, { configurationHome: target, env: {
    AGENTKIT_HOME: target, AGENTKIT_STUDIO_WORKSPACE: workspaceRoot,
    AGENTKIT_RUNTIME_AGENT_ID: imported.agentId, AGENTKIT_RUNTIME_BUILD_ID: imported.buildId,
    AGENTKIT_RUNTIME_TOKEN: options.runtimeToken, AGENTKIT_RUNTIME_PORT: String(options.runtimePort),
    PORTABLE_RUNTIME_KEY: 'target-only-secret',
    ...(options.catalog ? { KSADK_WEB_SEARCH_PROVIDER: 'fake', KSADK_WEB_SSRF_POLICY_JSON: '{"allow_private":true}' } : {}),
  } });

  // DSH model adapter must never prepare a call — Native owns the turn.
  ctx.llm.registerAdapter(['agentkit-studio-portable-runtime-proof'], {
    providerInfo: provider => ({ id: provider, name: 'Portable Runtime proof' }), providerRetryPolicy: () => undefined,
    listModels: async provider => [{ provider, id: 'pinned', name: 'pinned' }],
    resolveModel: (provider, model) => ({ provider, id: model, name: model }),
    prepareCall: () => { throw Error('DSH model loop entered during portable runtime execution'); },
  });

  await writeFile(join(root, 'portable-runtime-identity.json'), JSON.stringify({ agentId: imported.agentId, buildId: imported.buildId,
    presetId: dshPresetId(record.metadata.id, record.metadata.revision, built.id),
    runtimeToken: options.runtimeToken, runtimePort: options.runtimePort,
    sourcePathLeaked, sourceSecretLeaked,
    nativeBuiltin: manifest.nativeBuiltin,
    importedRequirements: imported.requirements.map(item => item.name) }), { mode: 0o600 });
}

async function rehydrate(ctx, options, root, identity) {
  const target = join(root, 'target-home');
  const workspaceRoot = join(root, 'workspace');
  const { mountStudioHost } = await import('@kingsoftcloud/agentkit-studio/host-bootstrap');
  await mountStudioHost(ctx, { configurationHome: target, env: {
    AGENTKIT_HOME: target, AGENTKIT_STUDIO_WORKSPACE: workspaceRoot,
    AGENTKIT_RUNTIME_AGENT_ID: identity.agentId, AGENTKIT_RUNTIME_BUILD_ID: identity.buildId,
    AGENTKIT_RUNTIME_TOKEN: identity.runtimeToken, AGENTKIT_RUNTIME_PORT: String(identity.runtimePort),
    PORTABLE_RUNTIME_KEY: 'target-only-secret',
    ...(options.catalog ? { KSADK_WEB_SEARCH_PROVIDER: 'fake', KSADK_WEB_SSRF_POLICY_JSON: '{"allow_private":true}' } : {}),
  } });
  ctx.llm.registerAdapter(['agentkit-studio-portable-runtime-proof'], {
    providerInfo: provider => ({ id: provider, name: 'Portable Runtime proof' }), providerRetryPolicy: () => undefined,
    listModels: async provider => [{ provider, id: 'pinned', name: 'pinned' }],
    resolveModel: (provider, model) => ({ provider, id: model, name: model }),
    prepareCall: () => { throw Error('DSH model loop entered during portable runtime execution'); },
  });
}
