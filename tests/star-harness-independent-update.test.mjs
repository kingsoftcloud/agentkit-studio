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
import { starHarnessClientResponse } from '../src/host/routes/star-harness-client.mjs';
import { loadActiveStarHarnessUI, refreshStarHarnessUI, watchStarHarnessUI } from '../src/client/dsh/star-harness-ui.mjs';

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

const oldVersion = '0.0.26';
const newVersion = '0.0.27';
const sha256 = data => createHash('sha256').update(data).digest('hex');
const sri = 'sha512-' + createHash('sha512').update('fixture').digest('base64');
const pins = { schemaVersion: 'agentkit.native-registry-pins/v2', packages: {}, dependencyPackages: {} };

function signedFixture(version, change = () => {}) {
  const ui = 'export const version=' + JSON.stringify(version);
  const files = Object.fromEntries([STAR_HARNESS_PACKAGE, STAR_HARNESS_CORE, STAR_HARNESS_UI].map(name => [name, {
    'package.json': JSON.stringify({ name, version, ...(name === STAR_HARNESS_CORE ? {} : {
      dependencies: { [STAR_HARNESS_CORE]: version },
    }) }),
    ...(name === STAR_HARNESS_UI ? { [STAR_HARNESS_CLIENT_FILE]: ui } : {}),
  }]));
  const manifest = {
    schemaVersion: 'agentkit.native-packages/v1', sourceCommit: 'c'.repeat(40),
    studio: { engineProtocol: 'agentkit.engine/v1', uiContract: STAR_HARNESS_UI_CONTRACT, uiSha256: sha256(ui) },
    packages: Object.entries(files).map(([name, rows]) => ({
      name, version, integrity: sri, fileHashes: Object.fromEntries(Object.entries(rows).map(([path, data]) => [path, sha256(data)])),
    })), dependencyPackages: {},
  };
  change(manifest);
  const bytes = Buffer.from(JSON.stringify(manifest));
  const statement = {
    _type: 'https://in-toto.io/Statement/v1', predicateType: 'https://slsa.dev/provenance/v1',
    subject: [{ name: 'manifest.json', digest: { sha256: sha256(bytes) } }],
  };
  const proof = { manifest: bytes.toString('base64'), bundle: { dsseEnvelope: {
    payloadType: 'application/vnd.in-toto+json', payload: Buffer.from(JSON.stringify(statement)).toString('base64'),
  } } };
  return { proof, files, ui, sha256: manifest.studio.uiSha256 };
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
  const runtimeRoot = join(root, 'plugin');
  await mkdir(workspace);
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
    directory: releasesDirectory, pins, fetchImpl, verifySignature: async (_bundle, options) => {
      if (offline) assert.equal(options.tufForceCache, true);
    },
    packageManager: { command: process.execPath, args: ['--input-type=module', '-e', command, '--'] },
  });
  let failedVersion;
  const starts = [];
  const makeManager = releases => createStarHarnessManager({
    root: runtimeRoot, releases, externalRoutes: new Map(), workspaceRegistry: () => ({ list: () => [{ path: workspace }] }),
    settings: async () => ({}), profile: async () => ({ modelName: 'mock' }), probe: async () => {},
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
  const old = await manager.acquire(workspace);
  assert.equal(old.connection.version, oldVersion);
  old.release();
  assert.equal((await manager.status({ checkUpdates: true })).availableUpgrade, newVersion);

  failedVersion = newVersion;
  await assert.rejects(manager.install(newVersion), /candidate refused/);
  assert.equal(manager.clientAsset.version, oldVersion);
  assert.equal((await manager.status()).version, oldVersion);
  assert.deepEqual(starts, [oldVersion, newVersion, oldVersion]);

  failedVersion = undefined;
  const startupDescriptor = Object.freeze((await manager.status()).clientUI);
  await manager.install(newVersion);
  let status = await manager.status();
  assert.deepEqual(status.clientUI, { version: newVersion, sha256: fixtures[newVersion].sha256 });
  assert.equal(status.previousVersion, oldVersion);
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
  await manager.install(oldVersion);
  status = await manager.status();
  assert.equal(status.version, oldVersion);
  assert.equal(status.clientUI.sha256, fixtures[oldVersion].sha256);
  assert.equal(starHarnessClientResponse(new Request('http://localhost/?sha256=' + fixtures[newVersion].sha256), manager.clientAsset).status, 404);
});
