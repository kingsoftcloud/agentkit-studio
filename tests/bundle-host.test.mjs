import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStudioBuild } from '../src/studio-build.mjs';
import { createPortableBundles } from '../src/portable-bundle.mjs';
import { parse as parseYaml } from 'yaml';
import { FROZEN_RUNTIME_READY } from '../src/host/frozen-runtime-lifecycle.mjs';
import { prepareBundleHost } from '../src/bundle-host.mjs';

async function fixture(t, credentialName = 'MODEL_KEY') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bundle-host-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installation = join(root, 'installation'), state = join(root, 'state'), archive = join(root, 'bundle.zip');
  const modules = join(installation, 'node_modules'), dsh = join(modules, '@deepseek-ai/dsh');
  const studio = join(modules, '@kingsoftcloud/agentkit-studio');
  await mkdir(join(dsh, 'lib'), { recursive: true }); await mkdir(studio, { recursive: true });
  await writeFile(join(dsh, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0-rc.2' }));
  await writeFile(join(dsh, 'lib/bin.js'), '// fixture installation entry');
  await mkdir(join(modules, 'fixture-dependency'), { recursive: true });
  await writeFile(join(modules, 'fixture-dependency/package.json'), JSON.stringify({ name: 'fixture-dependency' }));
  await writeFile(join(studio, 'studio.plugin.json'), JSON.stringify({ requiredDsh: '0.2.0-rc.2' }));
  const storeDir = join(root, 'source'), build = createStudioBuild({ storeDir }), agentId = 'ar-local-1234567890abcdef';
  const bindings = { modelProfileId: 'model' };
  const built = await build.build({ agentId, agentName: 'proof', revision: 1, metadata: { id: agentId, local: true, revision: 1 },
    spec: { runtime: { type: 'harness' }, bindings, instructions: { system: 'Reply with OK.' } }, bindings });
  const portable = createPortableBundles({ storeDir, build, models: { profile: async id => ({ id, provider: 'openai-compatible', modelName: 'model',
    baseUrl: 'https://example.com/v1', credentialName, apiKey: 'source-secret' }) }, adapters: {}, configuration: { resolve: async () => ({ values: {} }) } });
  const exported = await portable.prepare(agentId, built.id);
  await writeFile(archive, Buffer.from((await portable.download(agentId, built.id, exported.bundleId)).base64, 'base64'));
  return { root, installation, state, archive, env: { PATH: '/usr/bin', MODEL_KEY: 'target-secret', AGENTKIT_RUNTIME_TOKEN: 't'.repeat(32),
    NODE_OPTIONS: '--require personal-hook', DSH_HOME: '/personal/dsh', OPENAI_API_KEY: 'personal-key', CLOUD_SECRET_KEY: 'personal-cloud-key' } };
}

test('offline boot wires the public DSH CLI/profile and forwards only target resource credentials', async t => {
  const f = await fixture(t), plan = await prepareBundleHost(f);
  assert.match(plan.entry, /node_modules\/@deepseek-ai\/dsh\/lib\/bin.js$/);
  assert.deepEqual(plan.args, ['--profile', 'agentkit-runtime', '--host', '127.0.0.1', '--no-open', '--port', '0']);
  assert.equal(plan.env.MODEL_KEY, 'target-secret');
  for (const key of ['NODE_OPTIONS', 'OPENAI_API_KEY', 'CLOUD_SECRET_KEY']) assert.equal(plan.env[key], undefined);
  assert.equal(plan.env.HOME, join(f.state, 'home'));
  assert.equal(plan.env.DSH_HOME, join(f.state, 'dsh'));
  const profile = join(plan.env.DSH_HOME, 'profiles/agentkit-runtime');
  assert.deepEqual(JSON.parse(await readFile(join(profile, 'package.json'))).dsh.profile.bundles,
    ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@kingsoftcloud/agentkit-studio']);
  assert.equal(await realpath(join(profile, 'node_modules')), join(profile, 'node_modules'));
  assert.deepEqual(parseYaml(await readFile(join(profile, 'cordis.patch.yml'), 'utf8')), [{ id: 'schedule', inject: [FROZEN_RUNTIME_READY] }]);
  const localStudio = join(profile, 'node_modules/@kingsoftcloud/agentkit-studio');
  assert.equal((await lstat(localStudio)).isDirectory(), true);
  assert.equal(await realpath(localStudio), localStudio);
  assert.equal(await realpath(join(profile, 'node_modules/fixture-dependency')), join(f.installation, 'node_modules/fixture-dependency'));
  assert.equal(await realpath(join(profile, 'node_modules/@deepseek-ai/dsh')), join(f.installation, 'node_modules/@deepseek-ai/dsh'));
  assert.equal(await readFile(join(localStudio, 'studio.plugin.json'), 'utf8'), await readFile(join(f.installation, 'node_modules/@kingsoftcloud/agentkit-studio/studio.plugin.json'), 'utf8'));
  assert.equal((await readFile(join(plan.env.AGENTKIT_HOME, 'portable-bundle.zip'))).equals(await readFile(f.archive)), true);
  assert.equal(JSON.stringify(plan.identity).includes('secret'), false);
});

test('restart preserves DSH session state, while changed archives cannot take over a deployment', async t => {
  const f = await fixture(t), first = await prepareBundleHost(f);
  const history = join(first.env.DSH_HOME, 'session-proof.json'); await writeFile(history, 'durable-history');
  const again = await prepareBundleHost({ ...f, expectedSha256: first.identity.sha256 });
  assert.deepEqual(again.identity, first.identity); assert.equal(await readFile(history, 'utf8'), 'durable-history');
  await assert.rejects(prepareBundleHost({ ...f, expectedSha256: '0'.repeat(64) }), { code: 'BUNDLE_HOST_DIGEST_MISMATCH' });
  await writeFile(join(first.env.AGENTKIT_HOME, 'portable-bundle.zip'), 'other-deployment');
  await assert.rejects(prepareBundleHost(f), { code: 'BUNDLE_HOST_STATE_CONFLICT' });
  assert.equal(await readFile(history, 'utf8'), 'durable-history');
});

test('missing credentials, invalid identity and reserved credential names fail before publishing state', async t => {
  const f = await fixture(t);
  await assert.rejects(prepareBundleHost({ ...f, env: { ...f.env, MODEL_KEY: '' } }), { code: 'PORTABLE_CREDENTIAL_MISSING' });
  await assert.rejects(prepareBundleHost({ ...f, env: { ...f.env, AGENTKIT_RUNTIME_TOKEN: 'short' } }), { code: 'BUNDLE_HOST_TOKEN_REQUIRED' });
  await assert.rejects(prepareBundleHost({ ...f, env: { ...f.env, AGENTKIT_RUNTIME_AGENT_ID: 'wrong' } }), { code: 'PORTABLE_RUNTIME_MISMATCH' });
  await assert.rejects(readFile(join(f.state, 'agentkit/portable-bundle.zip')), { code: 'ENOENT' });
  for (const name of ['NODE_OPTIONS', 'AGENTKIT_RUNTIME_TOKEN', 'AGENTKIT_HOME', 'AGENTKIT_BUNDLE_SHA256']) {
    const reserved = await fixture(t, name);
    await assert.rejects(prepareBundleHost(reserved), { code: 'BUNDLE_HOST_CREDENTIAL_RESERVED' });
  }
  const generated = await fixture(t, 'AGENTKIT_BUNDLE_MODEL_1234567890AB');
  const plan = await prepareBundleHost({ ...generated, env: { ...generated.env, AGENTKIT_BUNDLE_MODEL_1234567890AB: 'generated-target-secret' } });
  assert.equal(plan.env.AGENTKIT_BUNDLE_MODEL_1234567890AB, 'generated-target-secret');
});

test('a normal Studio model credential survives export and cold Host boot', async t => {
  const f = await fixture(t, 'AGENTKIT_MODEL_API_KEY');
  const plan = await prepareBundleHost({ ...f, env: { ...f.env, AGENTKIT_MODEL_API_KEY: 'fake-key' } });
  assert.equal(plan.env.AGENTKIT_MODEL_API_KEY, 'fake-key');
  assert.equal(plan.env.OPENAI_API_KEY, undefined);
  assert.equal(JSON.stringify(plan.identity).includes('fake-key'), false);
});

test('personal directory links and foreign DSH profiles cannot become deployment state', async t => {
  const f = await fixture(t), personal = join(f.root, 'personal'); await mkdir(personal);
  await symlink(personal, f.state);
  await assert.rejects(prepareBundleHost(f), { code: 'BUNDLE_HOST_STATE_INVALID' });
  await rm(f.state); const plan = await prepareBundleHost(f);
  await writeFile(join(plan.env.DSH_HOME, 'profiles/agentkit-runtime/package.json'), JSON.stringify({ dsh: { profile: { bundles: ['personal'] } } }));
  await assert.rejects(prepareBundleHost(f), { code: 'BUNDLE_HOST_PROFILE_CONFLICT' });
  const g = await fixture(t);
  await writeFile(join(g.installation, 'node_modules/@deepseek-ai/dsh/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.7' }));
  await assert.rejects(prepareBundleHost(g), { code: 'BUNDLE_HOST_VERSION_MISMATCH' });
  const foreign = await fixture(t);
  await mkdir(join(foreign.state, 'dsh'), { recursive: true });
  await writeFile(join(foreign.state, 'dsh/cordis.patch.yml'), 'personal-profile');
  await assert.rejects(prepareBundleHost(foreign), { code: 'BUNDLE_HOST_STATE_CONFLICT' });
  assert.equal(await readFile(join(foreign.state, 'dsh/cordis.patch.yml'), 'utf8'), 'personal-profile');
});

test('versioned state isolates immutable bundles and preserves prior history on rollback', async t => {
  const f = await fixture(t), g = await fixture(t);
  const first = await prepareBundleHost({ ...f, versionedState: true });
  const history = join(first.env.DSH_HOME, 'retained-history'); await writeFile(history, 'original-history');
  const second = await prepareBundleHost({ ...f, archive: g.archive, versionedState: true });
  assert.notEqual(first.env.DSH_HOME, second.env.DSH_HOME);
  const restored = await prepareBundleHost({ ...f, versionedState: true });
  assert.equal(restored.env.DSH_HOME, first.env.DSH_HOME);
  assert.equal(await readFile(history, 'utf8'), 'original-history');
  assert.equal(restored.env.AGENTKIT_BUNDLE_SHA256, restored.identity.sha256);
});


test('a deleted assistant cannot be resurrected from its old runtime directory', async t => {
  const f = await fixture(t);
  await prepareBundleHost(f);
  await writeFile(join(f.state, '.assistant-closed.json'), JSON.stringify({ phase: 'closed' }));
  await assert.rejects(prepareBundleHost(f), { code: 'BUNDLE_HOST_ASSISTANT_CLOSED' });
});


test('legacy whole-directory link requires explicit migration and preserves sessions and Settings', async t => {
  const f = await fixture(t), plan = await prepareBundleHost(f);
  const profile = join(plan.env.DSH_HOME, 'profiles/agentkit-runtime'), modules = join(profile, 'node_modules');
  const history = join(plan.env.DSH_HOME, 'session-proof.json'), patch = join(profile, 'cordis.patch.yml');
  await writeFile(history, 'durable-history'); await writeFile(patch, 'retained-settings');
  await rm(modules, { recursive: true }); await symlink(join(f.installation, 'node_modules'), modules, 'dir');
  await assert.rejects(prepareBundleHost(f), { code: 'BUNDLE_HOST_PROFILE_MIGRATION_REQUIRED' });
  assert.equal(await readFile(history, 'utf8'), 'durable-history');
  assert.equal(await readFile(patch, 'utf8'), 'retained-settings');
  assert.equal(await realpath(modules), join(f.installation, 'node_modules'));
});

test('profile package edits or a different installed Studio cannot silently replace retained code', async t => {
  const f = await fixture(t), plan = await prepareBundleHost(f);
  const profile = join(plan.env.DSH_HOME, 'profiles/agentkit-runtime');
  await writeFile(join(profile, 'node_modules/@kingsoftcloud/agentkit-studio/extra.mjs'), '// unexpected');
  await assert.rejects(prepareBundleHost(f), { code: 'BUNDLE_HOST_PROFILE_CONFLICT' });
  const g = await fixture(t); await prepareBundleHost(g);
  await writeFile(join(g.installation, 'node_modules/@kingsoftcloud/agentkit-studio/extra.mjs'), '// changed installation');
  await assert.rejects(prepareBundleHost(g), { code: 'BUNDLE_HOST_PROFILE_CONFLICT' });
});

test('private package dependencies stay linked to their original installation', async t => {
  const f = await fixture(t), dependency = join(f.installation, 'node_modules/@kingsoftcloud/agentkit-studio/node_modules/private-dependency');
  await mkdir(dependency, { recursive: true }); await writeFile(join(dependency, 'package.json'), '{"name":"private-dependency"}');
  const plan = await prepareBundleHost(f), copy = join(plan.env.DSH_HOME, 'profiles/agentkit-runtime/node_modules/@kingsoftcloud/agentkit-studio/node_modules/private-dependency');
  assert.equal((await lstat(copy)).isSymbolicLink(), true);
  assert.equal(await realpath(copy), dependency);
  await prepareBundleHost(f);
});


test('profile scope links cannot move Studio outside its current DSH resolution scope', async t => {
  const f = await fixture(t), plan = await prepareBundleHost(f);
  const scope = join(plan.env.DSH_HOME, 'profiles/agentkit-runtime/node_modules/@kingsoftcloud');
  await rm(scope, { recursive: true }); await symlink(join(f.installation, 'node_modules/@kingsoftcloud'), scope, 'dir');
  await assert.rejects(prepareBundleHost(f), { code: 'BUNDLE_HOST_PROFILE_CONFLICT' });
});

test('linked private module directories materialize and are checked again at restart', async t => {
  const f = await fixture(t), privateModules = join(f.root, 'private-modules');
  await mkdir(join(privateModules, 'private-dependency'), { recursive: true });
  await writeFile(join(privateModules, 'private-dependency/package.json'), '{"name":"private-dependency"}');
  await symlink(privateModules, join(f.installation, 'node_modules/@kingsoftcloud/agentkit-studio/node_modules'), 'dir');
  const plan = await prepareBundleHost(f), modules = join(plan.env.DSH_HOME, 'profiles/agentkit-runtime/node_modules/@kingsoftcloud/agentkit-studio/node_modules');
  assert.equal((await lstat(modules)).isDirectory(), true);
  assert.equal(await realpath(join(modules, 'private-dependency')), join(privateModules, 'private-dependency'));
  await prepareBundleHost(f);
  await rm(join(modules, 'private-dependency')); await mkdir(join(modules, 'private-dependency'));
  await assert.rejects(prepareBundleHost(f), { code: 'BUNDLE_HOST_PROFILE_CONFLICT' });
});


test('missing schedule startup dependency requires migration without replacing Settings or history', async t => {
  const f = await fixture(t), plan = await prepareBundleHost(f);
  const patch = join(plan.env.DSH_HOME, 'profiles/agentkit-runtime/cordis.patch.yml');
  const settings = '- id: llm-pi-ai\n  config: { providers: {} }\n';
  await writeFile(patch, settings);
  await assert.rejects(prepareBundleHost(f), { code: 'BUNDLE_HOST_PROFILE_MIGRATION_REQUIRED' });
  assert.equal(await readFile(patch, 'utf8'), settings);
});


test('later Schedule patch overrides cannot withdraw the required startup dependency', async t => {
  const f = await fixture(t), plan = await prepareBundleHost(f);
  const patch = join(plan.env.DSH_HOME, 'profiles/agentkit-runtime/cordis.patch.yml');
  const original = await readFile(patch, 'utf8'), history = join(plan.env.DSH_HOME, 'session-proof.json');
  await writeFile(history, 'retained-history');
  for (const override of ['- id: schedule\n  inject: []\n', '- id: schedule\n  disabled: true\n']) {
    const value = original + override;
    await writeFile(patch, value);
    await assert.rejects(prepareBundleHost(f), { code: 'BUNDLE_HOST_PROFILE_MIGRATION_REQUIRED' });
    assert.equal(await readFile(patch, 'utf8'), value);
    assert.equal(await readFile(history, 'utf8'), 'retained-history');
  }
});
