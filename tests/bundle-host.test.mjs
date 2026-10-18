import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStudioBuild } from '../src/studio-build.mjs';
import { createPortableBundles } from '../src/portable-bundle.mjs';
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
  assert.equal(await realpath(join(profile, 'node_modules')), join(f.installation, 'node_modules'));
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
