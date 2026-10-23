import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, statSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packMaintainedNodeHost } from '../scripts/pack-maintained-node-host.mjs';
import { NODE_HOST_ROOTS, readNodeHostPackages } from '../scripts/node-host-packages.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'maintained-host-export-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'), studio = join(root, 'studio'), output = join(root, 'output');
  mkdirSync(source); mkdirSync(studio);
  const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  writeFileSync(join(source, 'package.json'), JSON.stringify({ private: true, packageManager: 'pnpm@10.33.2' }));
  writeFileSync(join(source, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  const paths = new Map(), version = '0.2.1-rc.2';
  function pkg(name, extra = {}) {
    const path = join(source, 'packages', name.split('/').at(-1)); paths.set(name, path);
    mkdirSync(join(path, 'lib'), { recursive: true });
    writeFileSync(join(path, 'lib/index.js'), 'export const value = 1;\n');
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name, version, main: 'lib/index.js', files: ['lib', 'dist'], ...extra }));
  }
  const changed = '@deepseek-ai/changed', asset = '@deepseek-ai/asset', peer = '@deepseek-ai/peer';
  pkg(NODE_HOST_ROOTS[0], { dependencies: { [changed]: 'workspace:*', '@deepseek-ai/unchanged': 'workspace:*' }, peerDependencies: { [changed]: '*' } });
  pkg(NODE_HOST_ROOTS[1], { optionalDependencies: { [asset]: 'workspace:*' } });
  pkg(NODE_HOST_ROOTS[2], { peerDependencies: { [peer]: 'workspace:*' } });
  pkg(NODE_HOST_ROOTS[3], { exports: { '.': './lib/index.js', './src/*': './src/*' } });
  for (const name of [changed, asset, peer, '@deepseek-ai/unchanged', '@deepseek-ai/dsh-desktop']) pkg(name);
  const assetPath = paths.get(asset); rmSync(join(assetPath, 'lib'), { recursive: true }); mkdirSync(join(assetPath, 'dist'));
  writeFileSync(join(assetPath, 'dist/index.html'), '<html>one</html>');
  writeFileSync(join(assetPath, 'package.json'), JSON.stringify({ name: asset, version, exports: { './dist/*': { default: ['./dist/*'] } }, files: ['dist'] }));
  function commit() { git('add', '-A'); git('commit', '-qm', 'fixture'); }
  commit(); const baseCommit = git('rev-parse', 'HEAD');
  for (const name of [changed, peer, '@deepseek-ai/dsh-desktop']) writeFileSync(join(paths.get(name), 'lib/index.js'), 'export const value = 2;\n');
  writeFileSync(join(assetPath, 'dist/index.html'), '<html>two</html>'); commit();
  const pins = { baseCommit, headCommit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}') };
  mkdirSync(join(studio, 'patches', `dsh-v${version}`), { recursive: true });
  const descriptor = join(studio, 'patches', `dsh-v${version}`, 'source.json');
  const savePins = () => writeFileSync(descriptor, JSON.stringify(pins)); savePins();
  writeFileSync(join(studio, 'studio.plugin.json'), JSON.stringify({ requiredDsh: version }));
  return { root, source, studio, output, paths, pins, git, savePins, options: { source, studio, output } };
}

test('real pnpm archives include changed production/optional/peer closure and assets, preserve untracked files and write private manifest', async t => {
  const f = fixture(t);
  // The exporter takes an already prepared checkout. Install this fixture's
  // local workspace links normally; every dependency is local, no network.
  execFileSync('pnpm', ['install', '--offline', '--ignore-scripts', '--lockfile=false'], {
    cwd: f.source, stdio: 'pipe', timeout: 30000,
  });
  mkdirSync(join(f.source, 'untracked'));
  writeFileSync(join(f.source, 'untracked/package.json'), JSON.stringify({ name: NODE_HOST_ROOTS[0] }));
  const manifest = await packMaintainedNodeHost(f.options);
  assert.deepEqual(manifest.packages.map(p => p.name).sort(), [...NODE_HOST_ROOTS, '@deepseek-ai/changed', '@deepseek-ai/asset', '@deepseek-ai/peer'].sort());
  assert.equal(statSync(f.output).mode & 0o777, 0o700);
  assert.equal(statSync(join(f.output, 'host-packages.json')).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(join(f.output, 'host-packages.json'))), manifest);
  assert.equal(f.git('status', '--porcelain', '--untracked-files=no'), '');
  assert.ok(existsSync(join(f.source, 'untracked/package.json')));
  const consumed = await readNodeHostPackages(join(f.output, 'host-packages.json'), f.studio);
  assert.equal(Object.keys(consumed.dependencies).length, 7);
  await assert.rejects(packMaintainedNodeHost(f.options), /already exists/);
});

test('rejects HEAD/tree/ancestry drift and dirty tracked files before creating output', async t => {
  const f = fixture(t), original = { ...f.pins };
  f.pins.tree = 'a'.repeat(40); f.savePins(); await assert.rejects(packMaintainedNodeHost(f.options), /tree/);
  Object.assign(f.pins, original); f.pins.headCommit = f.pins.baseCommit; f.savePins(); await assert.rejects(packMaintainedNodeHost(f.options), /HEAD/);
  Object.assign(f.pins, original); f.pins.baseCommit = 'f'.repeat(40); f.savePins(); await assert.rejects(packMaintainedNodeHost(f.options), /not an ancestor/);
  Object.assign(f.pins, original); f.savePins(); writeFileSync(join(f.source, 'package.json'), '{}');
  await assert.rejects(packMaintainedNodeHost(f.options), /uncommitted tracked/);
  assert.equal(existsSync(f.output), false);
});

test('refuses output through a symlink into source and preserves existing outputs', async t => {
  const f = fixture(t), alias = join(f.root, 'source-alias'); symlinkSync(f.source, alias);
  await assert.rejects(packMaintainedNodeHost({ ...f.options, output: join(alias, 'output') }), /inside source/);
  mkdirSync(f.output); writeFileSync(join(f.output, 'user.txt'), 'keep');
  await assert.rejects(packMaintainedNodeHost(f.options), /already exists/);
  assert.equal(readFileSync(join(f.output, 'user.txt'), 'utf8'), 'keep');
});

test('fails unresolved workspace dependencies instead of silently narrowing the closure', async t => {
  const f = fixture(t), path = join(f.paths.get(NODE_HOST_ROOTS[0]), 'package.json'), pkg = JSON.parse(readFileSync(path));
  pkg.dependencies['@deepseek-ai/missing'] = 'workspace:*'; writeFileSync(path, JSON.stringify(pkg));
  f.git('add', '-A'); f.git('commit', '-qm', 'missing workspace');
  f.pins.headCommit = f.git('rev-parse', 'HEAD'); f.pins.tree = f.git('rev-parse', 'HEAD^{tree}'); f.savePins();
  await assert.rejects(packMaintainedNodeHost(f.options), /Missing workspace dependency/);
  assert.equal(existsSync(f.output), false);
});

test('missing built export is rejected and never publishes a successful manifest', async t => {
  const f = fixture(t), path = join(f.paths.get(NODE_HOST_ROOTS[0]), 'package.json'), pkg = JSON.parse(readFileSync(path));
  pkg.exports = { '.': { import: './lib/missing.js' } }; writeFileSync(path, JSON.stringify(pkg));
  f.git('add', '-A'); f.git('commit', '-qm', 'missing target');
  f.pins.headCommit = f.git('rev-parse', 'HEAD'); f.pins.tree = f.git('rev-parse', 'HEAD^{tree}'); f.savePins();
  await assert.rejects(packMaintainedNodeHost(f.options), /built target missing/);
  assert.equal(existsSync(join(f.output, 'host-packages.json')), false);
});

test('a pack lifecycle that mutates tracked source is detected and cannot publish a manifest', async t => {
  const f = fixture(t), path = join(f.paths.get(NODE_HOST_ROOTS[0]), 'package.json'), pkg = JSON.parse(readFileSync(path));
  pkg.scripts = { prepack: 'node -e "require(\'node:fs\').writeFileSync(\'lib/index.js\',\'changed during packing\')"' };
  writeFileSync(path, JSON.stringify(pkg)); f.git('add', '-A'); f.git('commit', '-qm', 'mutating lifecycle');
  f.pins.headCommit = f.git('rev-parse', 'HEAD'); f.pins.tree = f.git('rev-parse', 'HEAD^{tree}'); f.savePins();
  await assert.rejects(packMaintainedNodeHost(f.options), /uncommitted tracked/);
  assert.equal(existsSync(join(f.output, 'host-packages.json')), false);
  assert.equal(readFileSync(join(f.paths.get(NODE_HOST_ROOTS[0]), 'lib/index.js'), 'utf8'), 'changed during packing');
});

test('missing runtime wildcard payload is rejected after ordinary packing', async t => {
  const f = fixture(t), path = join(f.paths.get('@deepseek-ai/asset'), 'package.json'), pkg = JSON.parse(readFileSync(path));
  pkg.exports = { './dist/*': './dist/missing/*' }; writeFileSync(path, JSON.stringify(pkg));
  f.git('add', '-A'); f.git('commit', '-qm', 'missing runtime wildcard');
  f.pins.headCommit = f.git('rev-parse', 'HEAD'); f.pins.tree = f.git('rev-parse', 'HEAD^{tree}'); f.savePins();
  await assert.rejects(packMaintainedNodeHost(f.options), /Missing packed target/);
  assert.equal(existsSync(join(f.output, 'host-packages.json')), false);
});
