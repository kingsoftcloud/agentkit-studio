import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createStarHarnessManager } from '../src/host/services/star-harness.mjs';
import { createStarHarnessReleases, STAR_HARNESS_PACKAGE } from '../src/host/services/star-harness-release.mjs';
import { createStarHarnessRoutes } from '../src/host/routes/star-harness.mjs';

const version = '0.0.24';
const dependency = 'fixture-harness-data';
const hashes = files => Object.fromEntries(Object.entries(files).map(([path, contents]) => [
  path, createHash('sha256').update(contents).digest('hex'),
]));

async function installFixture(t, modifiedDependency) {
  const root = await mkdtemp(join(tmpdir(), 'studio-star-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const nodeFiles = { 'package.json': JSON.stringify({
    name: STAR_HARNESS_PACKAGE, version, dependencies: { [dependency]: '1.0.0' },
  }), 'entry.mjs': '// A fixture that must be verified before probing.\n' };
  const dependencyFiles = {
    'package.json': JSON.stringify({ name: dependency, version: '1.0.0' }),
    'data.json': '{"expected":true}',
  };
  const fixture = join(root, 'stage-fixture');
  for (const [name, files] of [[STAR_HARNESS_PACKAGE, nodeFiles], [dependency, dependencyFiles]]) {
    const directory = join(fixture, name);
    await mkdir(directory, { recursive: true });
    for (const [path, contents] of Object.entries(files)) await writeFile(join(directory, path), contents);
  }
  if (modifiedDependency) await writeFile(join(fixture, dependency, 'data.json'), '{"expected":false}');
  const directory = join(root, 'releases');
  const packageManager = { command: process.execPath, args: [
    '--input-type=module', '-e',
    `import { cpSync } from 'node:fs'; cpSync(${JSON.stringify(fixture)}, 'node_modules', {recursive:true});`, '--',
  ] };
  const releases = createStarHarnessReleases({ directory, packageManager, pins: {
    schemaVersion: 'agentkit.native-registry-pins/v2',
    packages: { [STAR_HARNESS_PACKAGE]: { version, files: hashes(nodeFiles) } },
    dependencyPackages: { [dependency + '@1.0.0']: { version: '1.0.0', files: hashes(dependencyFiles) } },
    runtimeDependencies: { [dependency]: '1.0.0' },
  } });
  let probed = 0;
  const manager = createStarHarnessManager({ root, releases, externalRoutes: new Map(),
    settings: async () => ({}), probe: async () => { probed++; } });
  t.after(() => manager.close());
  return { manager, releases, directory, probes: () => probed };
}

test('Star Harness verifies reviewed files and dependencies before the first probe', async t => {
  const fixture = await installFixture(t, true);
  await assert.rejects(fixture.manager.install(version), { code: 'STAR_HARNESS_RELEASE_INVALID' });
  assert.equal(fixture.probes(), 0);
  assert.deepEqual(await readdir(fixture.directory), []);
  await assert.rejects(fixture.manager.install('0.0.99'), { code: 'STAR_HARNESS_RELEASE_UNREVIEWED' });
  assert.equal(fixture.probes(), 0);
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
