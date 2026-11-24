import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { STAR_HARNESS_CORE, STAR_HARNESS_PACKAGE, STAR_HARNESS_UI, STAR_HARNESS_CLIENT_FILE,
  STAR_HARNESS_UI_CONTRACT, verifyStarHarnessProof } from '../src/host/services/star-harness-catalog.mjs';
import { createStarHarnessReleases } from '../src/host/services/star-harness-release.mjs';
import { createStarHarnessManager } from '../src/host/services/star-harness.mjs';
import { createNativeEngineRuntime, createHarnessServiceModelAdapter } from '../src/providers/native-engine-runtime.mjs';
import { starHarnessClientResponse } from '../src/host/routes/star-harness-client.mjs';
import { loadActiveStarHarnessUI, refreshStarHarnessUI, watchStarHarnessUI } from '../src/client/dsh/star-harness-ui.mjs';
import { ENGINE_TOOL_CATALOG, ENGINE_TOOL_CATALOG_FILE } from '../src/contracts/engine-tool-catalog.mjs';
import { createResourceRoutes } from '../src/host/routes/resources.mjs';
import { starHarnessProofFixture } from './fixtures/star-harness-proof.mjs';

test('loads the new signed module if the active release changes during an import', async () => {
  const old = { version: '0.0.29', sha256: '1'.repeat(64) };
  const next = { version: '0.0.30', sha256: '2'.repeat(64) };
  let selected = old;
  const requested = [];
  const active = await loadActiveStarHarnessUI({
    fetchImpl: async url => starHarnessClientResponse(new Request('http://localhost' + url), selected),
    importModule: async url => {
      requested.push(new URL('http://localhost' + url).searchParams.get('sha256'));
      if (selected === old) {
        selected = next;
        throw new TypeError('The old signed module is no longer active');
      }
      return { contract: STAR_HARNESS_UI_CONTRACT, version: next.version, installTaskTimeline() {}, createNativeChildPanel() {} };
    },
  });
  assert.deepEqual(requested, [old.sha256, next.sha256]);
  assert.deepEqual(active.descriptor, next);
  assert.equal(active.module.version, next.version);
});

test('an automatic model stays pinned during a lease and cutover leaves one worker per workspace', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'studio-harness-model-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace'), plugin = join(root, 'plugin');
  await Promise.all([mkdir(workspace), mkdir(plugin)]);
  await writeFile(join(plugin, 'settings.json'), JSON.stringify({ version: '0.0.31', previousVersion: null, enabled: true, bindings: [] }));
  const old = { id: 'old', modelName: 'wide', default: true, contextWindow: 256000 };
  const next = { id: 'new', modelName: 'small', contextWindow: 64000 };
  let profiles = [old, next], failNext = false;
  const active = new Set();
  const manager = createStarHarnessManager({
    root: plugin, modelProfiles: profiles, externalRoutes: new Map(),
    workspaceRegistry: () => ({ list: () => [{ path: workspace }] }),
    settings: async () => ({ modelProfiles: profiles }),
    profile: async id => profiles.find(row => row.id === id),
    releases: { entry: async () => plugin },
    start: async ({ profile, stateDir }) => {
      assert.equal(active.size, 0, 'another worker still owns this state directory');
      if (failNext && profile.id === next.id) throw Error('new worker rejected');
      const worker = { model: profile.modelName, contextWindow: profile.contextWindow, stateDir, alive: true, stop: async () => {
        worker.alive = false;
        active.delete(worker);
      } };
      active.add(worker);
      return worker;
    },
  });
  try {
    const lease = await manager.acquire(workspace);
    const first = lease.connection;
    profiles = [{ ...old, default: false }, { ...next, default: true }];
    manager.refreshModelProfiles(profiles);
    assert.equal(manager.route(workspace).modelSelection.model, 'wide');
    const concurrent = await manager.acquire(workspace);
    assert.equal(concurrent.connection, first);
    concurrent.release();
    lease.release();
    assert.equal(manager.route(workspace).modelSelection.model, 'small');
    assert.deepEqual(manager.modelInfo('small'), { images: false, contextWindow: next.contextWindow });
    const runtime = createNativeEngineRuntime({ stateRoot: join(root, 'studio'), externalRoutes: new Map(), starHarness: manager });
    await assert.rejects(runtime.stream({ input: 'Continue', cwd: workspace, expectedServiceModel: 'wide' }).next(),
      { code: 'STAR_HARNESS_MODEL_CHANGED' });
    const changed = await manager.acquire(workspace);
    assert.equal(changed.connection.model, 'small');
    assert.equal(changed.connection.stateDir, first.stateDir);
    assert.equal(first.alive, false);
    changed.release();
    await manager.bind(workspace, 'old');
    assert.equal(manager.route(workspace).modelSelection.model, 'wide');
    assert.deepEqual(manager.summaryProfile(workspace, 'small'), profiles[1]);
    const explicit = await manager.acquire(workspace);
    profiles = [{ ...profiles[0], contextWindow: 192000 }, profiles[1]];
    manager.refreshModelProfiles(profiles);
    assert.deepEqual(manager.modelInfo('wide'), { images: false, contextWindow: old.contextWindow });
    const pinned = await manager.acquire(workspace);
    assert.equal(pinned.connection, explicit.connection);
    pinned.release();
    explicit.release();
    assert.deepEqual(manager.modelInfo('wide'), { images: false, contextWindow: 192000 });
    const refreshed = await manager.acquire(workspace);
    assert.equal(refreshed.connection.contextWindow, 192000);
    assert.equal(refreshed.connection.stateDir, explicit.connection.stateDir);
    assert.equal(explicit.connection.alive, false);
    refreshed.release();
    failNext = true;
    await assert.rejects(manager.bind(workspace, 'new'), /new worker rejected/);
    assert.equal([...active][0].model, 'wide');
    failNext = false;
    await manager.unbind(workspace);
    const automatic = await manager.acquire(workspace);
    assert.equal(automatic.connection.model, 'small');
    automatic.release();
    await manager.setEnabled(false);
    assert.equal(active.size, 0);
  } finally { await manager.close(); }
});

test('stale explicit bindings do not hide the minimum context capacity of working bindings', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'studio-harness-capacity-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plugin = join(root, 'plugin');
  const profiles = [
    { id: 'large', modelName: 'wide', contextWindow: 1048576 },
    { id: 'small', modelName: 'wide', contextWindow: 256000 },
  ];
  const bindings = profiles.map(({ id }) => ({
    workspace: join(root, id), profileId: id, model: 'wide', images: id === 'small',
  }));
  // A binding predating profile IDs carries an empty one. It has no capacity of
  // its own and must not veto the window every other binding agrees on.
  bindings.push({ workspace: join(root, 'legacy'), profileId: '', model: 'wide', images: false });
  await Promise.all([plugin, ...bindings.map(binding => binding.workspace)].map(path => mkdir(path)));
  await writeFile(join(plugin, 'settings.json'), JSON.stringify({ version: '0.0.31', previousVersion: null, enabled: true, bindings }));
  const manager = createStarHarnessManager({
    root: plugin, externalRoutes: new Map(), modelProfiles: profiles, releases: {},
    settings: async () => ({ modelProfiles: profiles }),
  });
  t.after(() => manager.close());
  const runtime = createNativeEngineRuntime({ stateRoot: join(root, 'studio'), externalRoutes: new Map(), starHarness: manager });
  assert.deepEqual(await runtime.serviceModelInfo('wide'), { images: true, contextWindow: 256000 });
  for (const stale of [[], [{ ...profiles[1], enabled: false }], [{ ...profiles[1], modelName: 'renamed' }]]) {
    manager.refreshModelProfiles([profiles[0], ...stale]);
    assert.deepEqual(await runtime.serviceModelInfo('wide'), { images: false, contextWindow: 1048576 });
    assert.equal((await manager.status()).workspaces.find(row => row.workspace === bindings[1].workspace).profileId, 'small');
  }
  manager.refreshModelProfiles([]);
  assert.deepEqual(await runtime.serviceModelInfo('wide'), { images: false });
});

const oldVersion = '9.0.26';
const newVersion = '9.0.27';
const sha256 = data => createHash('sha256').update(data).digest('hex');

function signedFixture(version, change = () => {}) {
  const ui = 'export const version=' + JSON.stringify(version);
  const files = Object.fromEntries([STAR_HARNESS_PACKAGE, STAR_HARNESS_CORE, STAR_HARNESS_UI].map(name => [name, {
    'package.json': JSON.stringify({ name, version, ...(name === STAR_HARNESS_CORE ? {} : {
      dependencies: { [STAR_HARNESS_CORE]: version },
    }) }),
    ...(name === STAR_HARNESS_UI ? { [STAR_HARNESS_CLIENT_FILE]: ui } : {}),
    ...(name === STAR_HARNESS_PACKAGE && version === newVersion ? {
      [ENGINE_TOOL_CATALOG_FILE]: JSON.stringify({ schemaVersion: ENGINE_TOOL_CATALOG, version,
        defaultTools: ['fixture_builtin'], childWorkspaceTools: ['fixture_builtin'], supportedCommandPlatforms: [],
        tools: [{ name: 'fixture_builtin', description: 'Verified catalog fixture.',
          parameters: { type: 'object', properties: {} }, readOnly: true, timeoutMs: 1000,
          permissions: [], availability: 'always' }] }),
    } : {}),
  }]));
  const proof = starHarnessProofFixture(version, files, { change });
  return { proof, files, ui, sha256: sha256(ui) };
}

test('the provenance policy binds the exact workflow, version and manifest bytes', async () => {
  const { proof } = signedFixture(newVersion);
  const verifySignature = async (bundle, options) => {
    assert.equal(bundle, proof.bundle);
    assert.equal(options.certificateIssuer, 'https://token.actions.githubusercontent.com');
    assert.equal(options.certificateIdentityURI, 'https://github.com/kingsoftcloud/ksadk-harness/.github/workflows/publish-npm.yml@refs/tags/v' + newVersion);
    assert.equal(options.tlogThreshold, 1);
  };
  await verifyStarHarnessProof(newVersion, proof, { verifySignature });
  const altered = { ...proof, manifest: Buffer.from('{}').toString('base64') };
  await assert.rejects(verifyStarHarnessProof(newVersion, altered, { verifySignature }), /differs from the attested artifact/);
  await assert.rejects(verifyStarHarnessProof(newVersion, signedFixture(newVersion, manifest => {
    manifest.studio.uiContract = 'agentkit.studio-harness-ui/v2';
  }).proof, { verifySignature: async () => {} }), /incompatible upgrade contract/);
  await assert.rejects(verifyStarHarnessProof(newVersion, proof, { verifySignature: async () => {
    throw Error('untrusted certificate');
  } }), /untrusted certificate/);
});

test('one release switches verified engine and UI together, and a failed candidate keeps the old pair', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'studio-independent-update-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const explicitlyBound = join(root, 'explicit-workspace');
  const runtimeRoot = join(root, 'plugin');
  await Promise.all([mkdir(workspace), mkdir(explicitlyBound)]);
  const releasesDirectory = join(runtimeRoot, 'releases');
  const fixtures = Object.fromEntries([oldVersion, newVersion].map(version => [version, signedFixture(version)]));
  const installerMap = {};
  for (const [version, fixture] of Object.entries(fixtures)) {
    const destination = join(root, version);
    installerMap[version] = destination;
    for (const [name, files] of Object.entries(fixture.files)) {
      for (const [path, text] of Object.entries(files)) {
        const target = join(destination, name, path);
        await mkdir(join(target, '..'), { recursive: true });
        await writeFile(target, text);
      }
    }
  }
  let offline = false;
  const fetchImpl = async address => {
    assert.equal(offline, false, 'local rollback does not query the registry');
    if (address.endsWith('/latest')) return Response.json({ name: STAR_HARNESS_PACKAGE, version: newVersion });
    const version = /\/v(\d+\.\d+\.\d+)\//.exec(address)[1];
    const proof = fixtures[version].proof;
    return address.endsWith('.bundle.json') ? Response.json(proof.bundle) : new Response(Buffer.from(proof.manifest, 'base64'));
  };
  const command = `
    import {cpSync} from 'node:fs';
    const files = ${JSON.stringify(installerMap)};
    const engine = ${JSON.stringify(STAR_HARNESS_PACKAGE)};
    const ui = ${JSON.stringify(STAR_HARNESS_UI)};
    const spec = process.argv.find(value => value.startsWith(engine + '@'));
    const version = spec.slice(engine.length + 1);
    if (!process.argv.includes(ui + '@' + version)) throw Error('missing matched UI');
    cpSync(files[version], 'node_modules', {recursive:true});
  `;
  const makeReleases = () => createStarHarnessReleases({
    directory: releasesDirectory, fetchImpl, verifySignature: async (_bundle, options) => {
      if (offline) assert.equal(options.tufForceCache, true);
    },
    packageManager: { command: process.execPath, args: ['--input-type=module', '-e', command, '--'] },
  });
  let failedVersion;
  const starts = [];
  const modelProfiles = [
    { id: 'default', default: true, modelName: 'mock' },
    { id: 'official', modelName: 'deepseek-flash', contextWindow: 1_048_576, input: ['text', 'image'] },
  ];
  const makeManager = releases => createStarHarnessManager({
    root: runtimeRoot, releases, externalRoutes: new Map(), workspaceRegistry: () => ({ list: () => [{ path: workspace }] }),
    modelProfiles, settings: async () => ({ modelProfiles }),
    profile: async id => modelProfiles.find(row => row.id === (id ?? 'default')), probe: async () => {},
    start: async ({ version, packageDirectory }) => {
      assert.match(packageDirectory, new RegExp(version.replaceAll('.', '\\.')));
      starts.push(version);
      if (version === failedVersion) throw Error('candidate refused the workspace');
      return { version, alive: true, stop: async () => {} };
    },
  });
  let manager = makeManager(makeReleases());
  t.after(() => manager.close());
  await manager.install(oldVersion);
  await manager.setEnabled(true);
  assert.equal(manager.clientAsset.version, oldVersion);
  assert.equal(manager.toolCatalog, null);
  const old = await manager.acquire(workspace);
  assert.equal(old.connection.version, oldVersion);
  old.release();
  assert.deepEqual(await manager.modelInfo('mock'), { images: false, contextWindow: 128_000 });
  assert.equal((await manager.status({ checkUpdates: true })).availableUpgrade, newVersion);

  failedVersion = newVersion;
  await assert.rejects(manager.install(newVersion), /candidate refused/);
  assert.equal(manager.clientAsset.version, oldVersion);
  assert.equal(manager.toolCatalog, null);
  assert.equal((await manager.status()).version, oldVersion);
  assert.deepEqual(starts, [oldVersion, newVersion, oldVersion]);

  failedVersion = undefined;
  const startupDescriptor = Object.freeze((await manager.status()).clientUI);
  await manager.install(newVersion);
  let status = await manager.status();
  assert.deepEqual(status.clientUI, { version: newVersion, sha256: fixtures[newVersion].sha256 });
  assert.equal(status.previousVersion, oldVersion);
  assert.equal(manager.toolCatalog.version, newVersion);
  const resources = createResourceRoutes({ starHarness: manager,
    serverClientPromise: Promise.resolve({ listCatalogResources: async () => ({ items: [] }) }) });
  const list = await resources('resources/list', { kind: 'tool', runtimeType: 'harness' });
  assert.deepEqual(list.value.items.map(item => item.resourceId), ['fixture_builtin']);
  assert.equal(list.value.items[0].contract.childWorkspace, true);
  let reads = 0;
  const active = await loadActiveStarHarnessUI({
    fetchImpl: async (url, options) => {
      assert.equal(options.cache, 'no-store');
      const descriptor = starHarnessClientResponse(new Request('http://localhost' + url), manager.clientAsset);
      assert.equal(descriptor.headers.get('cache-control'), 'no-store');
      reads++;
      return descriptor;
    },
    importModule: async url => {
      const asset = starHarnessClientResponse(new Request('http://localhost' + url), manager.clientAsset);
      assert.equal(asset.status, 200);
      assert.match(asset.headers.get('cache-control'), /immutable/);
      assert.equal(await asset.text(), fixtures[newVersion].ui);
      return { contract: STAR_HARNESS_UI_CONTRACT, version: newVersion, installTaskTimeline() {}, createNativeChildPanel() {} };
    },
  });
  assert.equal(reads, 1);
  assert.equal(startupDescriptor.version, oldVersion);
  assert.equal(active.module.version, newVersion);
  assert.deepEqual(active.descriptor, status.clientUI);

  let reloads = 0, listener;
  const renderer = {
    __AGENTKIT_STUDIO__: Object.freeze({ starHarnessUI: startupDescriptor }),
    location: { reload() { reloads++; } },
    BroadcastChannel: class {
      set onmessage(value) { listener = value; }
      close() {}
    },
  };
  const unwatch = watchStarHarnessUI(renderer, active.descriptor);
  refreshStarHarnessUI(renderer, active.descriptor, status.clientUI, false);
  listener({ data: active.descriptor.sha256 });
  assert.equal(reloads, 0, 'the cached Desktop bootstrap must not trigger repeat reloads');
  listener({ data: startupDescriptor.sha256 });
  assert.equal(reloads, 1, 'another window activating a different release must reload');
  unwatch();

  await manager.close();
  offline = true;
  manager = makeManager(makeReleases());
  await manager.restoreClientAsset();
  assert.equal(manager.clientAsset.version, newVersion);
  assert.equal(manager.toolCatalog.version, newVersion);
  const catalogFile = join(releasesDirectory, newVersion, 'node_modules', STAR_HARNESS_PACKAGE, ENGINE_TOOL_CATALOG_FILE);
  await writeFile(catalogFile, '{}');
  await assert.rejects(manager.restoreClientAsset(), { code: 'STAR_HARNESS_RELEASE_INVALID' });
  assert.equal(manager.toolCatalog, null);
  await writeFile(catalogFile, fixtures[newVersion].files[STAR_HARNESS_PACKAGE][ENGINE_TOOL_CATALOG_FILE]);
  await manager.restoreClientAsset();
  await manager.install(oldVersion);
  status = await manager.status();
  assert.equal(status.version, oldVersion);
  assert.equal(manager.toolCatalog, null);
  assert.equal(status.clientUI.sha256, fixtures[oldVersion].sha256);
  assert.equal(starHarnessClientResponse(new Request('http://localhost/?sha256=' + fixtures[newVersion].sha256), manager.clientAsset).status, 404);

  await manager.bind(explicitlyBound, 'official');
  const runtime = createNativeEngineRuntime({ stateRoot: join(root, 'studio-state'), externalRoutes: new Map(), starHarness: manager });
  const adapter = createHarnessServiceModelAdapter(class {}, () => runtime.serviceModels, model => runtime.serviceModelInfo(model));
  assert.deepEqual(await adapter.resolveModel('Harness', 'deepseek-flash'), {
    provider: 'Harness', id: 'deepseek-flash', name: 'deepseek-flash', modalities: ['text', 'image'],
    context: { contextWindow: 1_048_576 },
  });

  // An installation from a previous Host with no release proof is repairable
  // through the current signed release and cannot become a rollback target.
  await rm(join(releasesDirectory, oldVersion, '.studio-release-proof.json'));
  await manager.close();
  manager = makeManager(makeReleases());
  await assert.rejects(manager.restoreClientAsset(), { code: 'STAR_HARNESS_RELEASE_INVALID' });
  assert.equal((await manager.status()).repairNeeded, true);
  await manager.install(newVersion);
  assert.equal((await manager.status()).previousVersion, null);
  assert.equal(manager.clientAsset.version, newVersion);
});
