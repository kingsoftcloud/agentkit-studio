import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStudioBuild } from '../src/studio-build.mjs';
import { createPortableBundles, verifyPortableBundle, importPortableBundle, loadPortableRuntime } from '../src/portable-bundle.mjs';
import { runtimeSkill } from '../src/skill-files.mjs';
import { createGlobalConfiguration } from '../src/global-config.mjs';
import { createModelService } from '../src/model-service.mjs';
import { createLocalResourceAdapters } from '../src/local-resource-adapters.mjs';
import { createZip, readZipFiles, buildIdFor } from '../src/zip.mjs';
import { prepareLocalResourceContext } from '../src/local-runtime.mjs';
import { selectedNativeBuildContract } from '../src/build-engine.mjs';
import { sha256 } from '../src/portable-resources.mjs';
import { PORTABLE_NATIVE_BUILTIN_CONTRACT, PORTABLE_NATIVE_BUILTIN_CATALOG_CONTRACT, PORTABLE_NATIVE_PATCH_CONTRACT,
  PORTABLE_NATIVE_BUILTIN_TOOLS, PORTABLE_NATIVE_WORKSPACE_TOOLS } from '../src/portable-native-tools.mjs';

const NATIVE_DSH_TURN = 'agentkit.native-dsh-turn/v1';
const TEN_WORKSPACE_TOOLS = [...PORTABLE_NATIVE_WORKSPACE_TOOLS];

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'studio-portable-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const skillRoot = join(root, 'source-skill'); await mkdir(join(skillRoot, 'scripts'), { recursive: true });
  const content = '---\nname: inventory-format\ndescription: Format inventory answers\n---\nUse format SKU|COUNT.\n';
  await writeFile(join(skillRoot, 'SKILL.md'), content);
  await writeFile(join(skillRoot, 'scripts', 'format.sh'), '#!/bin/sh\nprintf "SKU|COUNT"\n', { mode: 0o700 });
  const build = createStudioBuild({ storeDir: join(root, 'source-store'), nativeEngineContract: overrides.nativeEngineContract });
  const agentId = 'ar-local-1234567890abcdef', skillId = 'cloud-skill-space';
  const bindings = { modelProfileId: 'configured-model', skills: [skillId], mcpServers: ['cloud-mcp'], plugins: [
    { enabled: true, config: { binding: { resource: { kind: 'knowledge-base', id: 'kb-1' } } } },
    { enabled: true, config: { binding: { resource: { kind: 'memory-instance', id: 'mem-1' } } } },
  ], ...overrides.bindings };
  const record = await build.build({ agentId, agentName: 'portable', revision: 1, metadata: { id: agentId, revision: 1, local: true },
    spec: { runtime: { type: overrides.runtime || 'harness' }, instructions: { system: 'Answer inventory questions.' }, bindings }, bindings });
  const models = { profile: async id => ({ id, provider: 'openai-compatible', modelName: 'real-model-name', baseUrl: 'https://model.example/v1', credentialName: 'MODEL_TARGET_KEY', apiKey: 'source-model-secret' }) };
  const adapters = { describeMcp: async () => ({ resourceId: 'cloud-mcp', endpoint: 'https://mcp.example/api/mcp', headers: { Authorization: 'Bearer source-mcp-secret', Accept: 'application/json, text/event-stream' } }),
    loadSkill: async () => ({ definitions: [runtimeSkill({ name: 'skill', content, path: join(skillRoot, 'SKILL.md') })] }) };
  const configuration = { resolve: async () => ({ values: { cloudServerUrl: 'https://cloud.example', cloudRegion: 'cn-test', cloudAccessKey: 'source-ak', cloudSecretKey: 'source-sk' } }) };
  const portable = createPortableBundles({ storeDir: join(root, 'source-store'), build, models, adapters, configuration });
  return { root, skillRoot, build, record, agentId, skillId, portable, models, adapters };
}

test('Native export/import retain the frozen engine when the target Host live default is off', async t => {
  const native = 'agentkit.native-dsh-turn/v1', f = await fixture(t, { nativeEngineContract: native });
  const prepared = await f.portable.prepare(f.agentId, f.record.id);
  const zip = Buffer.from((await f.portable.download(f.agentId, f.record.id, prepared.bundleId)).base64, 'base64');
  assert.equal(verifyPortableBundle(zip).definition.format, 'agentkit.agent-bundle/v2');
  const target = join(f.root, 'native-target'), imported = await importPortableBundle(zip, target);
  await rm(join(f.root, 'source-store'), { recursive: true });
  const restored = await createStudioBuild({ storeDir: join(target, 'studio') }).resolve(imported.agentId, imported.buildId);
  assert.equal(restored.buildId, f.record.id);
  assert.equal(selectedNativeBuildContract(restored), native);
  assert.deepEqual(restored.executionEngine, (await verifyPortableBundle(zip)).definition.executionEngine);
});

test('portable Native captures a separate vision profile with protocol, budgets and target credentials', async t => {
  const f = await fixture(t, { nativeEngineContract: NATIVE_DSH_TURN, bindings: { visionModelProfileId: 'vision-only' } });
  const prior = f.models.profile;
  const options = { protocol: 'openai-chat', contextWindow: 32000, maxOutputTokens: 2048,
    requestTimeoutMs: 140000, parameters: { temperature: 0.1 } };
  f.models.profile = async id => id === 'vision-only' ? { ...await prior(id), modelName: 'image-observer',
    credentialName: 'VISION_TARGET_KEY', input: ['text', 'image'], ...options } : prior(id);
  const prepared = await f.portable.prepare(f.agentId, f.record.id);
  const zip = Buffer.from((await f.portable.download(f.agentId, f.record.id, prepared.bundleId)).base64, 'base64');
  const { manifest } = verifyPortableBundle(zip);
  assert.deepEqual(manifest.resources.profiles.map(profile => profile.id), ['configured-model', 'vision-only']);
  assert.deepEqual(manifest.resources.profiles.find(profile => profile.id === 'vision-only').parameters, options.parameters);
  assert.equal(zip.includes(Buffer.from('source-model-secret')), false);
  const target = join(f.root, 'target-vision'), imported = await importPortableBundle(zip, target);
  await rm(join(f.root, 'source-store'), { recursive: true });
  const env = { AGENTKIT_HOME: target };
  for (const requirement of imported.requirements) env[requirement.name] = 'target-only-key';
  const configuration = createGlobalConfiguration({ env, home: target, inheritLegacy: false });
  const resolved = await createModelService({ configuration, credentials: { resolve: async name => ({ value: env[name] }) } }).profile('vision-only');
  assert.equal(resolved.modelName, 'image-observer'); assert.deepEqual(resolved.input, ['text', 'image']);
  for (const [key, value] of Object.entries(options)) assert.deepEqual(resolved[key], value);
  assert.equal(resolved.apiKey, 'target-only-key');
  assert.equal(manifest.resources.profiles[1].default, false, 'observer is not a conversation picker default');
  const restored = await createStudioBuild({ storeDir: join(target, 'studio') }).resolve(imported.agentId, imported.buildId);
  assert.equal(restored.spec.bindings.visionModelProfileId, 'vision-only');
});

test('export and import retain exact build, file modes, resource identity and target-only credentials', async t => {
  const f = await fixture(t), result = await f.portable.prepare(f.agentId, f.record.id);
  const downloaded = await f.portable.download(f.agentId, f.record.id, result.bundleId), zip = Buffer.from(downloaded.base64, 'base64');
  for (const secret of ['source-model-secret', 'source-mcp-secret', 'source-ak', 'source-sk', f.root]) assert.equal(zip.includes(Buffer.from(secret)), false);
  const { manifest } = verifyPortableBundle(zip);
  assert.deepEqual(manifest.resources.remote.map(item => item.id), ['kb-1', 'mem-1']);
  const target = join(f.root, 'target'), imported = await importPortableBundle(zip, target);
  const env = { AGENTKIT_HOME: target, AGENTKIT_RUNTIME_AGENT_ID: imported.agentId, AGENTKIT_RUNTIME_BUILD_ID: imported.buildId };
  await assert.rejects(loadPortableRuntime(target, env), { code: 'PORTABLE_CREDENTIAL_MISSING' });
  for (const requirement of imported.requirements) env[requirement.name] = 'target-only-secret';
  // Removing all source files demonstrates no absolute path or cloud Skill fallback.
  await rm(f.skillRoot, { recursive: true }); await rm(join(f.root, 'source-store'), { recursive: true });
  const runtime = await loadPortableRuntime(target, env), skill = await runtime.loadSkill(f.skillId);
  assert.equal(skill.definitions.length, 1);
  assert.match(await readFile(join(skill.definitions[0].resourceBase.path, 'scripts', 'format.sh'), 'utf8'), /SKU\|COUNT/);
  assert.ok((await stat(join(skill.definitions[0].resourceBase.path, 'scripts', 'format.sh'))).mode & 0o111);
  for (const bindings of [{ skills: [f.skillId] }, { plugins: [{ config: { binding: { resource: { kind: 'skill-space', id: f.skillId } } } }] }]) {
    const context = await prepareLocalResourceContext({ record: { spec: { runtime: { type: 'codex' }, bindings } },
      resourceAdapter: runtime, input: 'Format inventory', resourceMode: 'context-only' });
    assert.ok(context.resourceContext.includes(JSON.stringify(skill.definitions[0].path)));
    assert.ok(context.resourceContext.includes(JSON.stringify(skill.definitions[0].resourceBase.path)));
    assert.ok(!context.resourceContext.includes(f.skillRoot), 'deleted export path must not reach Codex');
    assert.ok(!context.resourceContext.includes('Use format SKU|COUNT'), 'Codex reads skill bodies on demand');
  }
  const frozen = await createStudioBuild({ storeDir: join(target, 'studio') }).resolve(f.agentId, imported.buildId);
  assert.equal(frozen.metadata.id, f.agentId); assert.equal(frozen.spec.bindings.modelProfileId, 'configured-model');
  const config = createGlobalConfiguration({ env, home: f.root, inheritLegacy: false });
  const model = await createModelService({ configuration: config, credentials: { resolve: async name => ({ value: env[name] }) } }).profile('configured-model');
  assert.equal(model.apiKey, 'target-only-secret'); assert.equal(model.modelName, 'real-model-name');
  const descriptor = await createLocalResourceAdapters({ resourceStore: runtime.resourceStore }).describeMcp('cloud-mcp');
  assert.equal(descriptor.endpoint, 'https://mcp.example/api/mcp'); assert.equal(descriptor.headers.Authorization, undefined);
  assert.ok(descriptor.envRefs.Authorization);
  await assert.rejects(runtime.loadSkill('not-in-bundle'), { code: 'PORTABLE_SKILL_MISSING' });
  await assert.rejects(importPortableBundle(zip, target), { code: 'PORTABLE_HOME_EXISTS' });
  assert.equal((await readFile(join(target, 'portable-bundle.zip'))).equals(zip), true);
});

test('resource content changes yield a new export identity while an old export stays immutable', async t => {
  const f = await fixture(t), first = await f.portable.prepare(f.agentId, f.record.id);
  const originalBytes = (await f.portable.download(f.agentId, f.record.id, first.bundleId)).base64;
  const repeated = await f.portable.prepare(f.agentId, f.record.id); assert.equal(repeated.bundleId, first.bundleId);
  assert.equal((await f.portable.download(f.agentId, f.record.id, first.bundleId)).base64, originalBytes);
  await writeFile(join(f.skillRoot, 'scripts', 'format.sh'), 'new bytes');
  const second = await f.portable.prepare(f.agentId, f.record.id); assert.notEqual(second.bundleId, first.bundleId);
  const old = await f.portable.download(f.agentId, f.record.id, first.bundleId);
  assert.ok(readZipFiles(Buffer.from(old.base64, 'base64')).some(file => file.data.includes(Buffer.from('SKU|COUNT'))));
  await assert.rejects(f.portable.download(f.agentId, 'build_00000000000000000000', first.bundleId), { code: 'PORTABLE_ID_INVALID' });
});

test('archive rejects changed or extra files, symlinks and traversal before creating target directories', async t => {
  const f = await fixture(t), result = await f.portable.prepare(f.agentId, f.record.id);
  const zip = Buffer.from((await f.portable.download(f.agentId, f.record.id, result.bundleId)).base64, 'base64');
  const files = readZipFiles(zip);
  for (const modified of [files.map(file => file.name.endsWith('.sh') ? { ...file, data: 'changed' } : file), [...files, { name: 'unexpected', data: 'x' }], [...files, { name: '../outside', data: 'x' }]]) {
    await assert.rejects(importPortableBundle(createZip(modified), join(f.root, 'rejected')), { code: 'PORTABLE_BUNDLE_INVALID' });
    await assert.rejects(stat(join(f.root, 'rejected')), { code: 'ENOENT' });
  }
  await symlink(join(f.root, 'source-store'), join(f.skillRoot, 'linked'));
  await assert.rejects(f.portable.prepare(f.agentId, f.record.id), { code: 'PORTABLE_SKILL_SYMLINK' });
});

test('unsupported runtime, plugins, builtin tools and inline credentials fail explicitly', async t => {
  for (const [overrides, code] of [
    [{ runtime: 'langgraph' }, 'PORTABLE_RUNTIME_UNSUPPORTED'],
    [{ bindings: { tools: ['shell'] } }, 'PORTABLE_BUILTIN_UNSUPPORTED'],
    [{ bindings: { plugins: [{ pluginRef: 'third-party/plugin' }] } }, 'PORTABLE_PLUGIN_UNSUPPORTED'],
    [{ bindings: { mcpServers: [{ id: 'mcp', endpoint: 'https://mcp.example', headers: { Authorization: 'secret' } }] } }, 'PORTABLE_INLINE_SECRET'],
  ]) { const f = await fixture(t, overrides); await assert.rejects(f.portable.prepare(f.agentId, f.record.id), { code }); }
});

test('Codex export preserves the selected gateway protocol without shipping login or plugin state', async t => {
  const f = await fixture(t, { runtime: 'codex' });
  const originalProfile = f.models.profile;
  f.models.profile = async id => ({ ...await originalProfile(id), codexApi: 'chat-completions' });
  const result = await f.portable.prepare(f.agentId, f.record.id);
  const zip = Buffer.from((await f.portable.download(f.agentId, f.record.id, result.bundleId)).base64, 'base64');
  const { manifest, definition, files } = verifyPortableBundle(zip);
  assert.equal(definition.spec.runtime.type, 'codex');
  assert.equal(manifest.resources.profiles[0].codexApi, 'chat-completions');
  assert.ok(files.every(file => file.name === 'portable.json' || file.name === 'agent-bundle.zip' || file.name.startsWith('skills/')));
  const target = join(f.root, 'codex-target');
  await importPortableBundle(zip, target);
  const configuration = createGlobalConfiguration({ env: { AGENTKIT_HOME: target }, inheritLegacy: false });
  const model = await createModelService({ configuration, credentials: { resolve: async () => ({ value: 'target-only-secret' }) } }).profile('configured-model');
  assert.equal(model.codexApi, 'chat-completions');
  assert.equal(model.apiKey, 'target-only-secret');
});

test('Codex export refuses an unportable native-account model instead of omitting it', async t => {
  const f = await fixture(t, { runtime: 'codex', bindings: { modelProfileIds: ['native-account-model'] } });
  const originalProfile = f.models.profile;
  f.models.profile = async id => {
    if (id === 'native-account-model') throw Object.assign(new Error('model unavailable'), { code: 'MODEL_NOT_FOUND' });
    return originalProfile(id);
  };
  await assert.rejects(f.portable.prepare(f.agentId, f.record.id), { code: 'PORTABLE_CODEX_MODEL_UNAVAILABLE' });
});

test('portable startup rejects other runtime identities and never inherits legacy model or cloud credentials', async t => {
  const f = await fixture(t), result = await f.portable.prepare(f.agentId, f.record.id);
  const zip = Buffer.from((await f.portable.download(f.agentId, f.record.id, result.bundleId)).base64, 'base64');
  const target = join(f.root, 'isolated'), imported = await importPortableBundle(zip, target);
  await mkdir(join(f.root, '.agentengine'));
  await writeFile(join(f.root, '.agentengine', 'settings.json'), JSON.stringify({ modelApiKey: 'legacy-secret', cloudSecretKey: 'legacy-cloud-secret' }));
  const values = (await createGlobalConfiguration({ home: f.root, env: { AGENTKIT_HOME: target }, inheritLegacy: false }).resolve()).values;
  assert.equal(values.modelApiKey, undefined); assert.equal(values.cloudSecretKey, undefined);
  const env = { AGENTKIT_RUNTIME_AGENT_ID: f.agentId, AGENTKIT_RUNTIME_BUILD_ID: 'build_wrong' };
  for (const requirement of imported.requirements) env[requirement.name] = 'configured';
  await assert.rejects(loadPortableRuntime(target, env), { code: 'PORTABLE_RUNTIME_MISMATCH' });
  await writeFile(join(target, '.portable-importing'), '');
  await assert.rejects(loadPortableRuntime(target, env), { code: 'PORTABLE_IMPORT_INCOMPLETE' });
});

test('Native Frozen engine build exports its ten Node workspace builtins with a verified capability manifest', async t => {
  const f = await fixture(t, { nativeEngineContract: NATIVE_DSH_TURN, bindings: { tools: [...TEN_WORKSPACE_TOOLS] } });
  const prepared = await f.portable.prepare(f.agentId, f.record.id);
  const zip = Buffer.from((await f.portable.download(f.agentId, f.record.id, prepared.bundleId)).base64, 'base64');
  const { manifest, definition } = verifyPortableBundle(zip);
  assert.equal(definition.executionEngine.engine, 'agentkit.native/v1');
  assert.deepEqual(manifest.nativeBuiltin, { contract: PORTABLE_NATIVE_BUILTIN_CONTRACT, engine: NATIVE_DSH_TURN, tools: [...TEN_WORKSPACE_TOOLS] });
  // The manifest is part of the content-addressed identity, so it is covered by
  // the bundleId and cannot be silently dropped or altered without recomputation.
  assert.equal(manifest.bundleId, `bundle_${sha256(JSON.stringify({ format: manifest.format, agentId: manifest.agentId, buildId: manifest.buildId, resources: manifest.resources, requirements: manifest.requirements, files: manifest.files, nativeBuiltin: manifest.nativeBuiltin }))}`);
  // Original tool bindings are preserved verbatim in the frozen Build, not
  // reordered or dropped, and no Host path leaks into the archive.
  for (const secret of [f.root, 'source-model-secret', 'source-mcp-secret']) assert.equal(zip.includes(Buffer.from(secret)), false);
  const target = join(f.root, 'native-tools-target'), imported = await importPortableBundle(zip, target);
  const restored = await createStudioBuild({ storeDir: join(target, 'studio') }).resolve(imported.agentId, imported.buildId);
  assert.deepEqual(restored.bindings.tools, [...TEN_WORKSPACE_TOOLS]);
  assert.equal(selectedNativeBuildContract(restored), NATIVE_DSH_TURN);
});

test('a combined Native binding (subset of tools plus skill/model/mcp) survives import and source removal with the frozen engine', async t => {
  const subset = ['read_workspace_file', 'write_workspace_file', 'list_workspace_files'];
  const f = await fixture(t, { nativeEngineContract: NATIVE_DSH_TURN, bindings: { tools: [...subset] } });
  const prepared = await f.portable.prepare(f.agentId, f.record.id);
  const zip = Buffer.from((await f.portable.download(f.agentId, f.record.id, prepared.bundleId)).base64, 'base64');
  const { manifest } = verifyPortableBundle(zip);
  assert.deepEqual(manifest.nativeBuiltin.tools, [...subset].sort());
  const target = join(f.root, 'combined-target'), imported = await importPortableBundle(zip, target);
  // Removing the entire source store and skill directory proves the target
  // stands alone: no absolute export path, no cloud Skill fallback, no Host state.
  await rm(f.skillRoot, { recursive: true }); await rm(join(f.root, 'source-store'), { recursive: true });
  const env = { AGENTKIT_HOME: target, AGENTKIT_RUNTIME_AGENT_ID: imported.agentId, AGENTKIT_RUNTIME_BUILD_ID: imported.buildId };
  for (const requirement of imported.requirements) env[requirement.name] = 'target-only-secret';
  const runtime = await loadPortableRuntime(target, env);
  const skill = await runtime.loadSkill(f.skillId);
  assert.equal(skill.definitions.length, 1);
  // The target Host live default is off (no nativeEngineContract), yet the
  // imported Build still resolves to its original frozen Native engine.
  const restored = await createStudioBuild({ storeDir: join(target, 'studio') }).resolve(imported.agentId, imported.buildId);
  assert.deepEqual(restored.bindings.tools, [...subset]);
  assert.equal(selectedNativeBuildContract(restored), NATIVE_DSH_TURN);
  assert.deepEqual(restored.executionEngine, (await verifyPortableBundle(zip)).definition.executionEngine);
});

test('the complete reference Node builtin inventory survives a v2 Frozen export/import without aliasing or granting authority', async t => {
  const reference = JSON.parse(await readFile(new URL('./fixtures/native-reference-builtin-catalog.json', import.meta.url)));
  const names = [...reference.ordinary, ...reference.resourceTools].sort();
  assert.equal(names.length, 34);
  assert.deepEqual(PORTABLE_NATIVE_BUILTIN_TOOLS, names);
  assert.ok(names.includes('run_code')); assert.ok(!names.includes('sandbox_run_code'));
  const f = await fixture(t, { nativeEngineContract: NATIVE_DSH_TURN, bindings: { tools: names } });
  const prepared = await f.portable.prepare(f.agentId, f.record.id);
  const zip = Buffer.from((await f.portable.download(f.agentId, f.record.id, prepared.bundleId)).base64, 'base64');
  const { manifest } = verifyPortableBundle(zip);
  assert.deepEqual(manifest.nativeBuiltin, { contract: PORTABLE_NATIVE_BUILTIN_CATALOG_CONTRACT,
    engine: NATIVE_DSH_TURN, tools: names });
  const target = join(f.root, 'full-catalog');
  const imported = await importPortableBundle(zip, target);
  await rm(join(f.root, 'source-store'), { recursive: true });
  const restored = await createStudioBuild({ storeDir: join(target, 'studio') }).resolve(imported.agentId, imported.buildId);
  assert.deepEqual(restored.spec.bindings.tools, names);
  assert.deepEqual(restored.bindings.tools, names);
  assert.equal(restored.spec.executionPolicy, undefined, 'capability export cannot add execution permissions');
  const files = readZipFiles(zip), portable = files.find(file => file.name === 'portable.json');
  for (const bad of [
    { ...manifest.nativeBuiltin, contract: PORTABLE_NATIVE_BUILTIN_CONTRACT },
    { ...manifest.nativeBuiltin, tools: names.filter(name => name !== 'web_fetch') },
    { ...manifest.nativeBuiltin, tools: names.map(name => name === 'run_code' ? 'sandbox_run_code' : name).sort() },
  ]) {
    const { bundleId, createdAt, ...identity } = { ...manifest, nativeBuiltin: bad };
    portable.data = Buffer.from(JSON.stringify({ ...identity, createdAt, bundleId: `bundle_${sha256(JSON.stringify(identity))}` }));
    assert.throws(() => verifyPortableBundle(createZip(files)), { code: 'PORTABLE_BUNDLE_INVALID' });
  }
});

test('Native patch builds export a distinct v3 capability and reject a recomputed v2 downgrade', async t => {
  const names = ['apply_workspace_patch', 'read_workspace_file'];
  const f = await fixture(t, { nativeEngineContract: NATIVE_DSH_TURN, bindings: { tools: names } });
  const prepared = await f.portable.prepare(f.agentId, f.record.id);
  const zip = Buffer.from((await f.portable.download(f.agentId, f.record.id, prepared.bundleId)).base64, 'base64');
  const { manifest } = verifyPortableBundle(zip);
  assert.deepEqual(manifest.nativeBuiltin, { contract: PORTABLE_NATIVE_PATCH_CONTRACT, engine: NATIVE_DSH_TURN, tools: names });
  const target = join(f.root, 'patch-target'); const imported = await importPortableBundle(zip, target);
  const restored = await createStudioBuild({ storeDir: join(target, 'studio') }).resolve(imported.agentId, imported.buildId);
  assert.deepEqual(restored.bindings.tools, names); assert.equal(restored.spec.executionPolicy, undefined);
  const files = readZipFiles(zip), portable = files.find(file => file.name === 'portable.json');
  const { bundleId, createdAt, ...identity } = { ...manifest, nativeBuiltin: { ...manifest.nativeBuiltin, contract: PORTABLE_NATIVE_BUILTIN_CATALOG_CONTRACT } };
  portable.data = Buffer.from(JSON.stringify({ ...identity, createdAt, bundleId: `bundle_${sha256(JSON.stringify(identity))}` }));
  assert.throws(() => verifyPortableBundle(createZip(files)), { code: 'PORTABLE_BUNDLE_INVALID' });
});

test('builtin tools that are not Node-wired are rejected with an explicit reason at export', async t => {
  for (const [overrides, messageMatch] of [
    // A Native Frozen engine build binding an unknown, non-whitelisted tool.
    [{ nativeEngineContract: NATIVE_DSH_TURN, bindings: { tools: ['shell'] } }, /shell/],
    // A Native Frozen engine build mixing a whitelisted tool with an unknown one.
    [{ nativeEngineContract: NATIVE_DSH_TURN, bindings: { tools: ['workspace_status', 'shell'] } }, /shell/],
    // A legacy Harness build (no Native engine pin) cannot export tools yet.
    [{ bindings: { tools: ['workspace_status'] } }, /Native/],
    // These runtimes do not pin the Native engine required by this manifest.
    [{ runtime: 'dsh-native', bindings: { tools: ['workspace_status'] } }, /Native/],
    [{ runtime: 'codex', bindings: { tools: ['workspace_status'] } }, /Native/],
  ]) {
    const f = await fixture(t, overrides);
    await assert.rejects(f.portable.prepare(f.agentId, f.record.id), { code: 'PORTABLE_BUILTIN_UNSUPPORTED', message: messageMatch });
  }
});

test('a recomputed archive identity cannot smuggle a bad or missing builtin manifest past verification', async t => {
  const subset = ['read_workspace_file', 'write_workspace_file', 'list_workspace_files'];
  const f = await fixture(t, { nativeEngineContract: NATIVE_DSH_TURN, bindings: { tools: [...subset] } });
  const prepared = await f.portable.prepare(f.agentId, f.record.id);
  const zip = Buffer.from((await f.portable.download(f.agentId, f.record.id, prepared.bundleId)).base64, 'base64');
  // Recompute the content-addressed bundleId after each mutation so the bundleId
  // check alone would pass; the cross-check against the frozen Build must still fail.
  const recompute = mutate => {
    const files = readZipFiles(zip), portable = files.find(file => file.name === 'portable.json');
    const manifest = JSON.parse(portable.data.toString('utf8'));
    mutate(manifest);
    const { bundleId, createdAt, ...identity } = manifest;
    manifest.bundleId = `bundle_${sha256(JSON.stringify(identity))}`;
    portable.data = Buffer.from(JSON.stringify(manifest, null, 2));
    return createZip(files);
  };
  const expectedSorted = [...subset].sort();
  const validManifest = { contract: PORTABLE_NATIVE_BUILTIN_CONTRACT, engine: NATIVE_DSH_TURN, tools: expectedSorted };
  for (const [label, mutate] of [
    ['extra whitelisted tool not in bindings', m => { m.nativeBuiltin = { ...validManifest, tools: [...expectedSorted, 'search_workspace_files'].sort() }; }],
    ['wrong engine', m => { m.nativeBuiltin = { ...validManifest, engine: 'agentkit.native/v1' }; }],
    ['unknown contract', m => { m.nativeBuiltin = { ...validManifest, contract: 'agentkit.portable-native-builtin/v9' }; }],
    ['extra field', m => { m.nativeBuiltin = { ...validManifest, extra: true }; }],
    ['unsorted tools', m => { m.nativeBuiltin = { ...validManifest, tools: [...expectedSorted].reverse() }; }],
    ['stripped manifest with tools present', m => { delete m.nativeBuiltin; }],
  ]) {
    assert.throws(() => verifyPortableBundle(recompute(mutate)), { code: 'PORTABLE_BUNDLE_INVALID' }, `verify tamper ${label} should be rejected`);
    await assert.rejects(importPortableBundle(recompute(mutate), join(f.root, `rejected-${label}`)), { code: 'PORTABLE_BUNDLE_INVALID' }, `import tamper ${label} should be rejected`);
  }
  // A spurious manifest on an otherwise valid tools-less bundle is also rejected.
  const plain = await fixture(t);
  const plainPrepared = await plain.portable.prepare(plain.agentId, plain.record.id);
  const plainZip = Buffer.from((await plain.portable.download(plain.agentId, plain.record.id, plainPrepared.bundleId)).base64, 'base64');
  const recomputePlain = mutate => {
    const files = readZipFiles(plainZip), portable = files.find(file => file.name === 'portable.json');
    const manifest = JSON.parse(portable.data.toString('utf8'));
    mutate(manifest);
    const { bundleId, createdAt, ...identity } = manifest;
    manifest.bundleId = `bundle_${sha256(JSON.stringify(identity))}`;
    portable.data = Buffer.from(JSON.stringify(manifest, null, 2));
    return createZip(files);
  };
  await assert.rejects(importPortableBundle(recomputePlain(m => { m.nativeBuiltin = validManifest; }), join(f.root, 'rejected-spurious')), { code: 'PORTABLE_BUNDLE_INVALID' });
  assert.throws(() => verifyPortableBundle(recomputePlain(m => { m.nativeBuiltin = validManifest; })), { code: 'PORTABLE_BUNDLE_INVALID' });
});

test('malformed tool binding shapes are rejected at export instead of silently dropped', async t => {
  for (const [label, overrides] of [
    ['null element', { nativeEngineContract: NATIVE_DSH_TURN, bindings: { tools: [null] } }],
    ['empty object element', { nativeEngineContract: NATIVE_DSH_TURN, bindings: { tools: [{}] } }],
    ['empty string element', { nativeEngineContract: NATIVE_DSH_TURN, bindings: { tools: [''] } }],
    ['non-array tools object', { nativeEngineContract: NATIVE_DSH_TURN, bindings: { tools: { name: 'run_code' } } }],
    ['numeric resourceId', { nativeEngineContract: NATIVE_DSH_TURN, bindings: { tools: [{ resourceId: 123 }] } }],
    ['resourceId/name contradiction', { nativeEngineContract: NATIVE_DSH_TURN, bindings: { tools: [{ resourceId: 'workspace_status', name: 'shell' }] } }],
    ['null element on legacy harness', { bindings: { tools: [null] } }],
    ['non-array on dsh-native', { runtime: 'dsh-native', bindings: { tools: { name: 'run_code' } } }],
  ]) {
    const f = await fixture(t, overrides);
    await assert.rejects(f.portable.prepare(f.agentId, f.record.id), { code: 'PORTABLE_BINDING_INVALID' }, `${label} should be rejected`);
  }
});

test('duplicate and mixed string/object bindings resolve consistently with the formal catalog contract', async t => {
  const f = await fixture(t, { nativeEngineContract: NATIVE_DSH_TURN,
    bindings: { tools: ['workspace_status', 'workspace_status', { resourceId: 'read_workspace_file' }, { name: 'read_workspace_file' }] } });
  const prepared = await f.portable.prepare(f.agentId, f.record.id);
  const zip = Buffer.from((await f.portable.download(f.agentId, f.record.id, prepared.bundleId)).base64, 'base64');
  const { manifest, definition } = verifyPortableBundle(zip);
  // The manifest binds the de-duplicated, spec-sorted distinct tool names; the
  // frozen Build preserves the original (duplicate, mixed) binding array verbatim.
  assert.deepEqual(manifest.nativeBuiltin.tools, ['read_workspace_file', 'workspace_status']);
  assert.deepEqual(definition.bindings.tools, ['workspace_status', 'workspace_status', { resourceId: 'read_workspace_file' }, { name: 'read_workspace_file' }]);
  // An object carrying an extra non-identity field is still accepted (the formal
  // contract ignores extra fields, only resourceId/id/name is the identity).
  const f2 = await fixture(t, { nativeEngineContract: NATIVE_DSH_TURN, bindings: { tools: [{ resourceId: 'workspace_status', enabled: false }] } });
  const prepared2 = await f2.portable.prepare(f2.agentId, f2.record.id);
  const zip2 = Buffer.from((await f2.portable.download(f2.agentId, f2.record.id, prepared2.bundleId)).base64, 'base64');
  assert.deepEqual(verifyPortableBundle(zip2).manifest.nativeBuiltin.tools, ['workspace_status']);
});

test('tampering both inner agent-bundle and outer portable with full identity recompute still rejects malformed, conflicting and unknown tools', async t => {
  const subset = ['read_workspace_file', 'write_workspace_file', 'list_workspace_files'];
  const f = await fixture(t, { nativeEngineContract: NATIVE_DSH_TURN, bindings: { tools: [...subset] } });
  const prepared = await f.portable.prepare(f.agentId, f.record.id);
  const zip = Buffer.from((await f.portable.download(f.agentId, f.record.id, prepared.bundleId)).base64, 'base64');

  // Recompute EVERY identity — inner buildId, agent-bundle.zip file hashes, and
  // outer bundleId — after tampering both the inner agent-bundle manifest and
  // the outer portable manifest. This simulates a determined attacker who
  // recomputes the entire archive; the shape and cross-copy checks must still
  // catch the malformed, conflicting or unknown tool bindings.
  function tamperArchive({ mutateInner, mutateOuter } = {}) {
    const outerFiles = readZipFiles(zip);
    const portableFile = outerFiles.find(file => file.name === 'portable.json');
    const bundleFile = outerFiles.find(file => file.name === 'agent-bundle.zip');
    const manifest = JSON.parse(portableFile.data.toString('utf8'));
    // Read and tamper the inner agent-bundle.
    const innerFiles = readZipFiles(bundleFile.data);
    const innerManifest = JSON.parse(innerFiles.find(file => file.name === 'agent-bundle/manifest.json').data.toString('utf8'));
    if (mutateInner) mutateInner(innerManifest);
    // spec.json must match { spec, bindings } of the (tampered) inner manifest,
    // otherwise the existing 'build spec mismatch' check would fire first.
    const newBundle = createZip([
      { name: 'agent-bundle/manifest.json', data: JSON.stringify(innerManifest, null, 2) },
      { name: 'agent-bundle/spec.json', data: JSON.stringify({ spec: innerManifest.spec, bindings: innerManifest.bindings }, null, 2) },
      { name: 'agent-bundle/README.md', data: innerFiles.find(file => file.name === 'agent-bundle/README.md').data },
    ]);
    // Recompute the inner buildId from the tampered manifest identity.
    const { createdAt, ...innerIdentity } = innerManifest;
    manifest.buildId = buildIdFor(innerIdentity);
    // Update the agent-bundle.zip file entry hash/bytes in the outer manifest.
    const bundleEntry = manifest.files.find(file => file.name === 'agent-bundle.zip');
    bundleEntry.sha256 = sha256(newBundle); bundleEntry.bytes = newBundle.length;
    bundleFile.data = newBundle;
    if (mutateOuter) mutateOuter(manifest);
    // Recompute the outer bundleId from the fully updated identity.
    const { bundleId, createdAt: outerCreatedAt, ...identity } = manifest;
    manifest.bundleId = `bundle_${sha256(JSON.stringify(identity))}`;
    portableFile.data = Buffer.from(JSON.stringify(manifest, null, 2));
    return createZip(outerFiles);
  }
  const expectedSorted = [...subset].sort();
  const validManifest = { contract: PORTABLE_NATIVE_BUILTIN_CONTRACT, engine: NATIVE_DSH_TURN, tools: expectedSorted };

  for (const [label, opts] of [
    // spec.bindings.tools and bindings.tools diverge: smuggle an unknown tool
    // through the top-level bindings copy while spec still lists the whitelist.
    ['spec/bindings tools divergence', { mutateInner: m => { m.bindings.tools = [...subset, 'shell']; } }],
    // Both copies carry a malformed null element (consistent, but malformed).
    ['malformed null element in both copies', { mutateInner: m => { m.spec.bindings.tools = [null]; m.bindings.tools = [null]; } }],
    // Both copies carry an unknown tool not on the whitelist.
    ['unknown tool in both copies', { mutateInner: m => { m.spec.bindings.tools = [...subset, 'run_code']; m.bindings.tools = [...subset, 'run_code']; } }],
    // Non-array tools in both copies (a Python tool object smuggled in).
    ['non-array tools in both copies', { mutateInner: m => { m.spec.bindings.tools = { name: 'run_code' }; m.bindings.tools = { name: 'run_code' }; } }],
    // Inner manifest drops tools but the outer manifest still declares a builtin.
    ['inner drops tools, outer keeps manifest', { mutateInner: m => { delete m.spec.bindings.tools; delete m.bindings.tools; } }],
    // Inner has the right tools but the outer nativeBuiltin declares an extra one.
    ['outer manifest declares extra tool', { mutateOuter: m => { m.nativeBuiltin = { ...validManifest, tools: [...expectedSorted, 'search_workspace_files'].sort() }; } }],
    // Inner has an extra whitelisted tool the outer manifest does not declare.
    ['inner extra whitelisted tool, outer manifest honest', { mutateInner: m => { m.spec.bindings.tools = [...subset, 'search_workspace_files']; m.bindings.tools = [...subset, 'search_workspace_files']; } }],
    // Outer manifest stripped while inner still binds tools.
    ['outer manifest stripped, inner has tools', { mutateOuter: m => { delete m.nativeBuiltin; } }],
  ]) {
    assert.throws(() => verifyPortableBundle(tamperArchive(opts)), { code: 'PORTABLE_BUNDLE_INVALID' }, `verify: ${label}`);
    await assert.rejects(importPortableBundle(tamperArchive(opts), join(f.root, `full-tamper-${label}`)), { code: 'PORTABLE_BUNDLE_INVALID' }, `import: ${label}`);
  }
});
