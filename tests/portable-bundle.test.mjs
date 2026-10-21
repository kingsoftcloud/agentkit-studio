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
import { createZip, readZipFiles } from '../src/zip.mjs';
import { prepareLocalResourceContext } from '../src/local-runtime.mjs';
import { selectedNativeBuildContract } from '../src/build-engine.mjs';

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
