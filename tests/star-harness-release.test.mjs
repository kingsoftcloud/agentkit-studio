import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createStarHarnessManager } from '../src/host/services/star-harness.mjs';
import { createStarHarnessReleases, STAR_HARNESS_PACKAGE } from '../src/host/services/star-harness-release.mjs';
import { createStarHarnessRoutes } from '../src/host/routes/star-harness.mjs';
import { createHarnessServiceModelAdapter } from '../src/providers/native-engine-runtime.mjs';
import { STAR_HARNESS_CORE, STAR_HARNESS_UI, STAR_HARNESS_CLIENT_FILE } from '../src/host/services/star-harness-catalog.mjs';
import { starHarnessProofFixture } from './fixtures/star-harness-proof.mjs';

const version = '9.0.24';
const dependency = 'fixture-harness-data';

test('the Studio bootstrap, plugin installer and tool catalog import without Harness implementation packages', () => {
  const manager = new URL('../src/host/services/star-harness.mjs', import.meta.url).href;
  const toolCatalog = new URL('../src/native-tool-catalog.mjs', import.meta.url).href;
  const bootstrap = new URL('../src/host/bootstrap.mjs', import.meta.url).href;
  const managedResources = new URL('../src/host/services/native-managed-host-resources.mjs', import.meta.url).href;
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      if (specifier.startsWith('@kingsoftcloud/agentkit-harness-')) throw Error(specifier);
      return next(specifier, context);
    } });
    const { createStarHarnessManager } = await import(process.argv[1]);
    if (typeof createStarHarnessManager !== 'function') throw Error('Missing Star Harness manager');
    const { nativeLocalToolContract } = await import(process.argv[2]);
    if (nativeLocalToolContract('read_workspace_file')?.executor !== 'builtin') throw Error('Missing legacy catalog');
    const { mountStudioHost } = await import(process.argv[3]);
    if (typeof mountStudioHost !== 'function') throw Error('Missing Studio host bootstrap');
    const { registerStudioManagedHostResources } = await import(process.argv[4]);
    if (typeof registerStudioManagedHostResources !== 'function') throw Error('Missing Studio managed host resources');
  `, manager, toolCatalog, bootstrap, managedResources]);
});

async function installFixture(t, modifiedDependency) {
  const root = await mkdtemp(join(tmpdir(), 'studio-star-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const releaseFiles = {
    [STAR_HARNESS_PACKAGE]: { 'package.json': JSON.stringify({ name: STAR_HARNESS_PACKAGE, version, dependencies: { [dependency]: '1.0.0' } }),
      'entry.mjs': '// A fixture that must be verified before probing.\n' },
    [STAR_HARNESS_CORE]: { 'package.json': JSON.stringify({ name: STAR_HARNESS_CORE, version }) },
    [STAR_HARNESS_UI]: { 'package.json': JSON.stringify({ name: STAR_HARNESS_UI, version }), [STAR_HARNESS_CLIENT_FILE]: 'export {};\n' },
  };
  const dependencyFiles = {
    'package.json': JSON.stringify({ name: dependency, version: '1.0.0' }),
    'data.json': '{"expected":true}',
  };
  const fixture = join(root, 'stage-fixture');
  for (const [name, files] of Object.entries({ ...releaseFiles, [dependency]: dependencyFiles })) {
    const directory = join(fixture, name);
    await mkdir(directory, { recursive: true });
    for (const [path, contents] of Object.entries(files)) {
      const file = join(directory, path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, contents);
    }
  }
  if (modifiedDependency) await writeFile(join(fixture, dependency, 'data.json'), '{"expected":false}');
  const directory = join(root, 'releases');
  const packageManager = { command: process.execPath, args: [
    '--input-type=module', '-e',
    `import { cpSync } from 'node:fs'; cpSync(${JSON.stringify(fixture)}, 'node_modules', {recursive:true});`, '--',
  ] };
  const proof = starHarnessProofFixture(version, releaseFiles, { dependencies: { [dependency]: dependencyFiles } });
  const releases = createStarHarnessReleases({ directory, packageManager, verifySignature: async () => {}, async fetchImpl(url) {
    if (!url.includes(`/v${version}/`)) return new Response(null, { status: 404 });
    return url.endsWith('.bundle.json') ? Response.json(proof.bundle) : new Response(Buffer.from(proof.manifest, 'base64'));
  } });
  let probed = 0;
  const manager = createStarHarnessManager({ root, releases, externalRoutes: new Map(),
    settings: async () => ({}), probe: async () => { probed++; } });
  t.after(() => manager.close());
  return { manager, releases, directory, probes: () => probed };
}

test('Star Harness verifies signed files and dependencies before the first probe', async t => {
  const fixture = await installFixture(t, true);
  await assert.rejects(fixture.manager.install(version), { code: 'STAR_HARNESS_RELEASE_INVALID' });
  assert.equal(fixture.probes(), 0);
  assert.deepEqual(await readdir(fixture.directory), []);
  await assert.rejects(fixture.manager.install('0.0.99'), { code: 'STAR_HARNESS_RELEASE_UNREVIEWED' });
  assert.equal(fixture.probes(), 0);
});

test('an unsigned cached installation cannot start or be reinstalled without release evidence', async t => {
  const fixture = await installFixture(t, false);
  await fixture.releases.install(version);
  const evidence = join(fixture.directory, version, '.studio-release-proof.json');
  await rm(evidence);
  const requested = [];
  const releases = createStarHarnessReleases({ directory: fixture.directory, async fetchImpl(url) {
    requested.push(url);
    return new Response(null, { status: 404 });
  } });
  await assert.rejects(releases.entry(version), { code: 'STAR_HARNESS_RELEASE_INVALID' });
  await assert.rejects(releases.install(version), { code: 'STAR_HARNESS_RELEASE_UNREVIEWED' });
  assert.ok(requested.some(url => url.endsWith(`/v${version}/studio-harness-release.bundle.json`)));
  assert.ok(await readFile(join(fixture.directory, version, 'node_modules', STAR_HARNESS_PACKAGE, 'entry.mjs')));
});

test('Star Harness rechecks cached release bytes before launching and repairs invalid installs', async t => {
  const fixture = await installFixture(t, false);
  await fixture.manager.install(version);
  assert.equal(fixture.probes(), 1);
  const entry = join(await fixture.releases.entry(version), 'entry.mjs');
  const original = await readFile(entry, 'utf8');
  await writeFile(entry, original + '// local edit\n');
  await assert.rejects(fixture.releases.entry(version), { code: 'STAR_HARNESS_RELEASE_INVALID' });
  await fixture.manager.install(version);
  assert.equal(fixture.probes(), 2);
  assert.equal(await readFile(entry, 'utf8'), original);
});

test('Star Harness status accepts a null payload and verifies stored configuration', async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-star-route-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { root, externalRoutes: new Map(), settings: async () => ({}) };
  const routes = createStarHarnessRoutes(createStarHarnessManager(options));
  const result = await routes('star-harness/status', null);
  assert.equal(result.value.enabled, false);
  await writeFile(join(root, 'settings.json'), JSON.stringify({
    enabled: true, version: null, previousVersion: null, bindings: [],
  }));
  const invalid = createStarHarnessRoutes(createStarHarnessManager(options));
  await assert.rejects(invalid('star-harness/status', null), { code: 'STAR_HARNESS_CONFIG_INVALID' });
});

test('the release catalog filters published versions by signature and Studio compatibility', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-star-catalog-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const versions = ['1.2.9', '1.2.10', '1.2.11', '1.2.12', '1.2.13-beta.0'];
  const proofs = Object.fromEntries(versions.map(version => [version, starHarnessProofFixture(version,
    Object.fromEntries([STAR_HARNESS_PACKAGE, STAR_HARNESS_CORE, STAR_HARNESS_UI].map(name => [name, {
      'package.json': JSON.stringify({ name, version }),
      ...(name === STAR_HARNESS_UI ? { [STAR_HARNESS_CLIENT_FILE]: 'export {};' } : {}),
    }])), { change: manifest => { if (version === '1.2.12') manifest.studio.engineProtocol = 'future'; } })]));
  const checked = [];
  const releases = createStarHarnessReleases({ directory, async verifySignature(_bundle, options) {
    const version = options.certificateIdentityURI.split('@refs/tags/v').at(-1);
    checked.push(version);
    if (version === '1.2.11') throw Error('Invalid signature');
  }, async fetchImpl(url) {
    if (url.startsWith('https://registry.npmjs.org/')) return Response.json({
      name: STAR_HARNESS_PACKAGE,
      versions: Object.fromEntries(versions.map(version => [version, { version, name: STAR_HARNESS_PACKAGE }])),
      time: { '1.2.10': '2026-11-20T10:02:13.000Z' },
    });
    const version = new URL(url).pathname.split('/').at(-2).slice(1);
    const proof = proofs[version];
    return url.endsWith('.bundle.json') ? Response.json(proof.bundle) : new Response(Buffer.from(proof.manifest, 'base64'));
  } });
  assert.deepEqual(await releases.catalog(), [
    { version: '1.2.10', publishedAt: '2026-11-20T10:02:13.000Z' },
    { version: '1.2.9', publishedAt: null },
  ]);
  assert.deepEqual(checked.sort(), ['1.2.10', '1.2.11', '1.2.12', '1.2.9']);
});

test('the release catalog follows the installed version and survives a registry outage', async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-star-catalog-status-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let offline = false;
  const releases = {
    install: async () => root,
    async catalog() {
      if (offline) throw Error('offline');
      return ['0.0.31', '0.0.30', '0.0.29'].map(version => ({ version, publishedAt: null }));
    },
  };
  const manager = createStarHarnessManager({ root, releases, externalRoutes: new Map(), settings: async () => ({}),
    probe: async () => {} });
  t.after(() => manager.close());
  await manager.install('0.0.30');
  await manager.install('0.0.31');
  const refresh = () => manager.status({ checkUpdates: true, includeVersions: true });
  const status = await refresh();
  assert.equal(status.rollbackVersion, '0.0.30');
  assert.deepEqual(status.releaseVersions.map(row => row.action), ['current', 'rollback', 'history']);
  offline = true;
  assert.equal((await refresh()).registryUnavailable, true);
  assert.deepEqual((await manager.status()).releaseVersions, status.releaseVersions);
  await assert.rejects(manager.install('0.0.29'), { code: 'STAR_HARNESS_VERSION_UNSUPPORTED' });
  await manager.install('0.0.30');
  const rolledBack = await manager.status();
  assert.equal(rolledBack.rollbackVersion, null);
  assert.equal(rolledBack.availableUpgrade, '0.0.31');
  assert.deepEqual(rolledBack.releaseVersions.map(row => row.action), ['upgrade', 'current', 'history']);
});

test('Star Harness changes automatic model bindings without replacing a leased worker', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'studio-star-model-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'manager'), workspace = join(directory, 'workspace');
  await mkdir(workspace);
  const models = [
    { id: 'a', modelName: 'Model A', default: true },
    { id: 'b', modelName: 'Model B', default: false },
  ];
  let profiles = models;
  const events = [];
  const open = () => createStarHarnessManager({
    root, externalRoutes: new Map(), modelProfiles: profiles,
    settings: async () => ({ modelProfiles: profiles }),
    profile: async id => profiles.find(item => item.id === id),
    workspaceRegistry: () => ({ list: () => [{ path: workspace }] }),
    releases: { entry: async () => directory, install: async () => directory },
    probe: async () => {},
    start: async ({ profile }) => {
      const connection = { alive: true, stop: async () => {
        connection.alive = false;
        events.push(['stop', profile.modelName]);
      } };
      events.push(['start', profile.modelName]);
      return connection;
    },
  });
  const first = open();
  t.after(() => first.close());
  await first.install(version);
  await first.setEnabled(true);
  const active = await first.acquire(workspace);
  profiles = models.map(item => ({ ...item, default: item.id === 'b' }));
  first.refreshModelProfiles(profiles);
  assert.equal(first.route(workspace).modelSelection.model, 'Model A');
  const concurrent = await first.acquire(workspace);
  assert.equal(concurrent.connection, active.connection);
  concurrent.release();
  assert.equal(active.connection.alive, true);
  active.release();
  assert.equal(first.route(workspace).modelSelection.model, 'Model B');
  const replacements = await Promise.all([first.acquire(workspace), first.acquire(workspace)]);
  assert.equal(replacements[0].connection, replacements[1].connection);
  replacements.forEach(lease => lease.release());
  assert.deepEqual(events, [['start', 'Model A'], ['stop', 'Model A'], ['start', 'Model B']]);
  await first.close();

  const restarted = open();
  t.after(() => restarted.close());
  const catalog = () => restarted.routes.map(route => route.modelSelection.model);
  const adapter = createHarnessServiceModelAdapter(class {}, catalog, undefined, () => Boolean(catalog().length));
  assert.equal((await adapter.resolveModel('managed', 'Model A')).id, 'Model A');
  assert.deepEqual((await adapter.listModels('managed')).map(model => model.id), ['Model B']);
  const continued = await restarted.acquire(workspace);
  continued.release();
  assert.deepEqual(events.at(-1), ['start', 'Model B']);
  await restarted.setEnabled(false);
  assert.deepEqual(events.at(-1), ['stop', 'Model B']);
  await assert.rejects(adapter.resolveModel('managed', 'Model A'), { code: 'NATIVE_ENGINE_MODEL_UNAVAILABLE' });
});
