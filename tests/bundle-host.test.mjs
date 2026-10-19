import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath, lstat, readdir, cp, rename, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { createStudioBuild } from '../src/studio-build.mjs';
import { createPortableBundles } from '../src/portable-bundle.mjs';
import { parse as parseYaml } from 'yaml';
import { FROZEN_RUNTIME_READY } from '../src/host/frozen-runtime-lifecycle.mjs';
import { prepareBundleHost, acquireBundleProfileLock } from '../src/bundle-host.mjs';

async function fixture(t, credentialName = 'MODEL_KEY') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bundle-host-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installation = join(root, 'installation'), state = join(root, 'state'), archive = join(root, 'bundle.zip');
  const modules = join(installation, 'node_modules'), dsh = join(modules, '@deepseek-ai/dsh');
  const studio = join(modules, '@kingsoftcloud/agentkit-studio');
  await mkdir(join(dsh, 'lib'), { recursive: true }); await mkdir(studio, { recursive: true });
  await writeFile(join(dsh, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0-rc.2' }));
  await writeFile(join(dsh, 'lib/bin.js'), '// fixture installation entry');
  // Sequential unit fixtures control the installation facade. The opt-in native
  // verifier separately exercises real kernel exclusion across processes.
  const persistence = join(modules, '@deepseek-ai/dsh-session-persistence-jsonl');
  const system = join(persistence, 'node_modules/@deepseek-ai/node-addon-system');
  await mkdir(system, { recursive: true });
  await writeFile(join(persistence, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-session-persistence-jsonl', type: 'module', main: 'index.js' }));
  await writeFile(join(persistence, 'index.js'), 'export {};');
  await writeFile(join(system, 'package.json'), JSON.stringify({ name: '@deepseek-ai/node-addon-system', type: 'module', exports: { './flock': './flock.js' } }));
  await writeFile(join(system, 'flock.js'), 'export async function tryLockExclusive() {}');
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


test('verified legacy whole-directory profiles migrate once and retain rollback code, Settings and session state', async t => {
  const f = await fixture(t), plan = await prepareBundleHost(f);
  const profile = join(plan.env.DSH_HOME, 'profiles/agentkit-runtime'), modules = join(profile, 'node_modules');
  const history = join(plan.env.DSH_HOME, 'session-proof.json'), patch = join(profile, 'cordis.patch.yml');
  const settings = (await readFile(patch, 'utf8')) + '  name: \"@deepseek-ai/dsh-schedule\"\n  disabled: false\n  config: { deliveryHistoryDays: 91, deliveryHistoryRecords: 350 }\n- id: llm-pi-ai\n  config: { retained: true }\n';
  await writeFile(history, 'durable-history'); await writeFile(patch, settings);
  await writeFile(join(profile, 'other-settings.json'), '{"untouched":true}');
  await rm(join(profile, '.agentkit-runtime-profile.json')); await rm(modules, { recursive: true });
  await symlink(join(f.installation, 'node_modules'), modules, 'dir');
  const receipt = await readFile(join(f.state, '.agentkit-runtime.json'));
  assert.deepEqual((await prepareBundleHost(f)).identity, plan.identity);
  assert.equal((await lstat(modules)).isDirectory(), true);
  const backups = (await readdir(join(plan.env.DSH_HOME, 'profiles'))).filter(name => name.startsWith('.previous-'));
  assert.equal(backups.length, 1);
  const backup = join(plan.env.DSH_HOME, 'profiles', backups[0]);
  assert.equal((await lstat(join(backup, 'node_modules'))).isSymbolicLink(), true);
  for (const path of [profile, backup]) {
    assert.equal(await readFile(join(path, 'cordis.patch.yml'), 'utf8'), settings);
    assert.equal(await readFile(join(path, 'other-settings.json'), 'utf8'), '{"untouched":true}');
  }
  assert.equal(await readFile(history, 'utf8'), 'durable-history');
  assert.deepEqual(await readFile(join(f.state, '.agentkit-runtime.json')), receipt);
  await prepareBundleHost(f);
  assert.deepEqual((await readdir(join(plan.env.DSH_HOME, 'profiles'))).filter(name => name.startsWith('.previous-')), backups);
});

test('the original empty legacy patch gains one readiness gate and retains unrelated Settings', async t => {
  const f = await fixture(t), plan = await prepareBundleHost(f), profile = join(plan.env.DSH_HOME, 'profiles/agentkit-runtime');
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n');
  await writeFile(join(profile, 'retained-settings.json'), '{"userSetting":true}');
  await rm(join(profile, '.agentkit-runtime-profile.json')); await rm(join(profile, 'node_modules'), { recursive: true });
  await symlink(join(f.installation, 'node_modules'), join(profile, 'node_modules'), 'dir');
  await prepareBundleHost(f);
  assert.deepEqual(parseYaml(await readFile(join(profile, 'cordis.patch.yml'), 'utf8')), [{ id: 'schedule', inject: [FROZEN_RUNTIME_READY] }]);
  assert.equal(await readFile(join(profile, 'retained-settings.json'), 'utf8'), '{"userSetting":true}');
  const backup = (await readdir(join(plan.env.DSH_HOME, 'profiles'))).find(name => name.startsWith('.previous-'));
  assert.equal(await readFile(join(plan.env.DSH_HOME, 'profiles', backup, 'cordis.patch.yml'), 'utf8'), '[]\n');
});

test('legacy Schedule Settings gain only the missing readiness gate; conflicting or disabled rows remain rejected', async t => {
  const f = await fixture(t), plan = await prepareBundleHost(f), profile = join(plan.env.DSH_HOME, 'profiles/agentkit-runtime');
  await rm(join(profile, '.agentkit-runtime-profile.json')); await rm(join(profile, 'node_modules'), { recursive: true });
  await symlink(join(f.installation, 'node_modules'), join(profile, 'node_modules'), 'dir');
  const patch = join(profile, 'cordis.patch.yml');
  for (const invalid of ['- id: schedule\n  disabled: true\n', '- id: schedule\n  inject: []\n', '- id: schedule\n- id: schedule\n']) {
    await writeFile(patch, invalid); await assert.rejects(prepareBundleHost(f), { code: 'BUNDLE_HOST_PROFILE_MIGRATION_REQUIRED' });
    assert.equal(await readFile(patch, 'utf8'), invalid); assert.equal((await lstat(join(profile, 'node_modules'))).isSymbolicLink(), true);
  }
  await writeFile(patch, '- id: schedule\n  config: { deliveryHistoryDays: 91 }\n- id: llm-pi-ai\n  config: { retained: true }\n');
  await prepareBundleHost(f);
  assert.deepEqual(parseYaml(await readFile(patch, 'utf8')), [
    { id: 'schedule', config: { deliveryHistoryDays: 91 }, inject: [FROZEN_RUNTIME_READY] }, { id: 'llm-pi-ai', config: { retained: true } },
  ]);
});

test('owned Profile code refreshes for a new installation path without changing the immutable bundle or business state', async t => {
  const f = await fixture(t), plan = await prepareBundleHost(f), next = join(f.root, 'next-installation');
  const profile = join(plan.env.DSH_HOME, 'profiles/agentkit-runtime');
  const oldMarker = JSON.parse(await readFile(join(profile, '.agentkit-runtime-profile.json')));
  await writeFile(join(plan.cwd, 'retained.txt'), 'workspace');
  await writeFile(join(plan.env.DSH_HOME, 'session-proof.json'), 'history');
  const original = await readFile(join(profile, 'cordis.patch.yml'));
  await cp(f.installation, next, { recursive: true });
  await writeFile(join(next, 'node_modules/@kingsoftcloud/agentkit-studio/upgrade.mjs'), '// new image code');
  await rm(f.installation, { recursive: true }); // Old recorded external link targets no longer exist.
  const upgraded = await prepareBundleHost({ ...f, installation: next });
  assert.deepEqual(upgraded.identity, plan.identity);
  const marker = JSON.parse(await readFile(join(profile, '.agentkit-runtime-profile.json')));
  assert.deepEqual(marker.identity, oldMarker.identity); assert.notEqual(marker.code.studioDigest, oldMarker.code.studioDigest);
  assert.equal(await readFile(join(profile, 'node_modules/@kingsoftcloud/agentkit-studio/upgrade.mjs'), 'utf8'), '// new image code');
  assert.equal(await realpath(join(profile, 'node_modules/fixture-dependency')), join(next, 'node_modules/fixture-dependency'));
  assert.equal(await readFile(join(plan.cwd, 'retained.txt'), 'utf8'), 'workspace');
  assert.equal(await readFile(join(plan.env.DSH_HOME, 'session-proof.json'), 'utf8'), 'history');
  assert.deepEqual(await readFile(join(profile, 'cordis.patch.yml')), original);
  await prepareBundleHost({ ...f, installation: next });
});

test('edited owned code, altered link text and unrecognized old copies cannot become launcher-owned', async t => {
  const f = await fixture(t), plan = await prepareBundleHost(f);
  const profile = join(plan.env.DSH_HOME, 'profiles/agentkit-runtime');
  await writeFile(join(profile, 'node_modules/@kingsoftcloud/agentkit-studio/extra.mjs'), '// unexpected');
  await assert.rejects(prepareBundleHost(f), { code: 'BUNDLE_HOST_PROFILE_CONFLICT' });
  const g = await fixture(t), second = await prepareBundleHost(g);
  const copy = join(second.env.DSH_HOME, 'profiles/agentkit-runtime');
  await rm(join(copy, '.agentkit-runtime-profile.json'));
  await writeFile(join(g.installation, 'node_modules/@kingsoftcloud/agentkit-studio/upgrade.mjs'), '// unknown prior image');
  await assert.rejects(prepareBundleHost(g), { code: 'BUNDLE_HOST_PROFILE_CONFLICT' });
  const h = await fixture(t), third = await prepareBundleHost(h);
  const link = join(third.env.DSH_HOME, 'profiles/agentkit-runtime/node_modules/fixture-dependency');
  await rm(link); await symlink(join(h.installation, 'node_modules/./fixture-dependency'), link, 'dir');
  // Exact link text, rather than only a resolved identity, is part of the recorded code.
  await rm(link); await symlink(join(h.installation, 'node_modules', '..', 'node_modules/fixture-dependency') + '/', link, 'dir');
  await assert.rejects(prepareBundleHost(h), { code: 'BUNDLE_HOST_PROFILE_CONFLICT' });
});

test('exact current unmarked copies are adopted but a legacy link to another installation is rejected', async t => {
  const f = await fixture(t), plan = await prepareBundleHost(f), profile = join(plan.env.DSH_HOME, 'profiles/agentkit-runtime');
  await rm(join(profile, '.agentkit-runtime-profile.json')); await prepareBundleHost(f);
  assert.equal(JSON.parse(await readFile(join(profile, '.agentkit-runtime-profile.json'))).owner, 'agentkit-bundle-host');
  await rm(join(profile, '.agentkit-runtime-profile.json')); await rm(join(profile, 'node_modules'), { recursive: true });
  const foreign = join(f.root, 'foreign-modules'); await cp(join(f.installation, 'node_modules'), foreign, { recursive: true });
  await symlink(foreign, join(profile, 'node_modules'), 'dir');
  await assert.rejects(prepareBundleHost(f), { code: 'BUNDLE_HOST_PROFILE_CONFLICT' });
});

test('an interrupted profile rename rolls back first and then refreshes, preserving the old configuration backup', async t => {
  const f = await fixture(t), plan = await prepareBundleHost(f), profiles = join(plan.env.DSH_HOME, 'profiles');
  const profile = join(profiles, 'agentkit-runtime'), staging = '.preparing-11111111-1111-1111-1111-111111111111', backup = '.previous-22222222-2222-2222-2222-222222222222';
  const marker = JSON.parse(await readFile(join(profile, '.agentkit-runtime-profile.json')));
  await cp(profile, join(profiles, staging), { recursive: true, verbatimSymlinks: true });
  await writeFile(join(profiles, '.agentkit-runtime-profile-transaction.json'), JSON.stringify({ format: 'agentkit.runtime-profile-transaction/v1', identity: marker.identity, staging, backup }));
  await rename(profile, join(profiles, backup));
  await writeFile(join(f.installation, 'node_modules/@kingsoftcloud/agentkit-studio/upgrade.mjs'), '// restart after interruption');
  await prepareBundleHost(f);
  assert.equal(await readFile(join(profile, 'node_modules/@kingsoftcloud/agentkit-studio/upgrade.mjs'), 'utf8'), '// restart after interruption');
  await assert.rejects(lstat(join(profiles, staging)), { code: 'ENOENT' });
  await assert.rejects(lstat(join(profiles, '.agentkit-runtime-profile-transaction.json')), { code: 'ENOENT' });
  assert.equal((await readdir(profiles)).filter(name => name.startsWith('.previous-')).length, 1);
  await prepareBundleHost(f);
});

test('a committed profile switch with a leftover journal keeps its verified active copy and rollback backup', async t => {
  const f = await fixture(t), plan = await prepareBundleHost(f), profiles = join(plan.env.DSH_HOME, 'profiles');
  const profile = join(profiles, 'agentkit-runtime'), backup = '.previous-33333333-3333-3333-3333-333333333333';
  const marker = JSON.parse(await readFile(join(profile, '.agentkit-runtime-profile.json')));
  await cp(profile, join(profiles, backup), { recursive: true, verbatimSymlinks: true });
  await writeFile(join(profiles, '.agentkit-runtime-profile-transaction.json'), JSON.stringify({ format: 'agentkit.runtime-profile-transaction/v1', identity: marker.identity, staging: '.preparing-44444444-4444-4444-4444-444444444444', backup }));
  await prepareBundleHost(f);
  assert.deepEqual(JSON.parse(await readFile(join(profile, '.agentkit-runtime-profile.json'))), marker);
  assert.equal((await lstat(join(profiles, backup))).isDirectory(), true);
  await assert.rejects(lstat(join(profiles, '.agentkit-runtime-profile-transaction.json')), { code: 'ENOENT' });
});

test('tampered imported Agent Build blocks any Profile migration and leaves the legacy link intact', async t => {
  const f = await fixture(t), plan = await prepareBundleHost(f), profile = join(plan.env.DSH_HOME, 'profiles/agentkit-runtime');
  await rm(join(profile, '.agentkit-runtime-profile.json')); await rm(join(profile, 'node_modules'), { recursive: true });
  await symlink(join(f.installation, 'node_modules'), join(profile, 'node_modules'), 'dir');
  await writeFile(join(plan.env.AGENTKIT_HOME, 'studio/dist', plan.identity.agentId, plan.identity.buildId, 'agent-bundle.zip'), 'tampered');
  await assert.rejects(prepareBundleHost(f), { code: 'BUNDLE_HOST_STATE_CONFLICT' });
  assert.equal((await lstat(join(profile, 'node_modules'))).isSymbolicLink(), true);
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

test('Windows mutex lease normalizes identity, closes contenders and accepts abandoned ownership', async t => {
  const f = await fixture(t), root = join(f.installation, 'node_modules/@deepseek-ai/dsh-session-persistence-jsonl/node_modules/koffi');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'package.json'), '{"type":"module","main":"index.js"}');
  await writeFile(join(root, 'index.js'), `
    export const calls = []; let serial = 0, forced; const holds = new Map(), names = new Map();
    export function forceWait(result) { forced = result; }
    export default { load: name => { calls.push(['load', name]); return { func: (_abi, name) => ({
      CreateMutexW(_security, _initial, name) { const id = ++serial; names.set(id, name); calls.push(['create', name]); return id; },
      WaitForSingleObject(id, ms) { calls.push(['wait', id, ms]); const name = names.get(id); if (forced !== undefined) { const result = forced; forced = undefined; if (result === 0 || result === 0x80) holds.set(name, id); return result; } if (holds.has(name)) return 0; holds.set(name, id); return 0; },
      ReleaseMutex(id) { calls.push(['release', id]); holds.delete(names.get(id)); return 1; },
      CloseHandle(id) { calls.push(['close', id]); names.delete(id); return 1; },
    })[name] }; } };
  `);
  const modules = join(f.installation, 'node_modules'), profile = join(f.root, 'PROFILE');
  const release = await acquireBundleProfileLock(profile, modules, 'win32');
  await assert.rejects(acquireBundleProfileLock(profile.toLowerCase(), modules, 'win32'), { code: 'BUNDLE_HOST_PROFILE_BUSY' });
  await release(); await release();
  const next = await acquireBundleProfileLock(profile, modules, 'win32'); await next();
  const { calls, forceWait } = await import(pathToFileURL(join(root, 'index.js')));
  forceWait(0x102);
  await assert.rejects(acquireBundleProfileLock(profile, modules, 'win32'), { code: 'BUNDLE_HOST_PROFILE_BUSY' });
  forceWait(0x80);
  const recovered = await acquireBundleProfileLock(profile, modules, 'win32'); await recovered();
  assert.equal(calls.filter(row => row[0] === 'create').length, 4, 'same-thread reentry is rejected before CreateMutex');
  assert.equal(calls.filter(row => row[0] === 'release').length, 3);
  assert.equal(calls.filter(row => row[0] === 'close').length, 4);
  assert.equal(new Set(calls.filter(row => row[0] === 'create').map(row => row[1])).size, 1);
  assert.ok(calls.filter(row => row[0] === 'wait').every(row => row[2] === 0));
});
