import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkMaintenanceSource, exportMaintenanceSource, importMaintenanceSource } from '../scripts/dsh-maintenance-source.mjs';
import { patchPaths } from '../scripts/check-patch-manifest.mjs';
import { withDesktopCheckout } from '../scripts/desktop-checkout.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const branchRef = 'refs/heads/codex/studio-dsh-v0.2.0-rc.2';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'studio-maintenance-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'), patches = join(root, 'studio/patches/dsh-v0.2.0-rc.2');
  await mkdir(source); await mkdir(patches, { recursive: true });
  git(source, 'init', '--quiet');
  git(source, 'config', 'user.name', 'Fixture'); git(source, 'config', 'user.email', 'fixture@example.test');
  git(source, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(source, 'value.mjs'), 'export const value = 1;\n');
  await writeFile(join(source, 'old.mjs'), 'export const obsolete = true;\n');
  git(source, 'add', '.'); git(source, 'commit', '-qm', 'Fixture baseline');
  const baseCommit = git(source, 'rev-parse', 'HEAD');
  git(source, 'checkout', '-qb', branchRef.slice('refs/heads/'.length));
  const entries = [];
  let previous = baseCommit;
  for (const id of ['001', '002']) {
    if (id === '001') {
      await writeFile(join(source, 'value.mjs'), 'export const value = 2;\n');
      await writeFile(join(source, 'added.mjs'), 'export const added = true;\n');
    } else await rm(join(source, 'old.mjs'));
    git(source, 'add', '-A'); git(source, 'commit', '-qm', `Fixture change ${id}\n\nStudio-Patch: ${id}`);
    const commit = git(source, 'rev-parse', 'HEAD'), file = `${id}-fixture.patch`;
    const bytes = Buffer.from(git(source, 'diff', previous, commit) + '\n');
    await writeFile(join(patches, file), bytes);
    entries.push({ id, file, baseCommit, sha256: digest(bytes), category: 'general-fix', dependsOn: [],
      affectedFiles: patchPaths(bytes), affectedPackages: ['fixture'], contracts: ['Fixture behavior'], risk: 'low',
      maintainerRole: 'Fixture', removeWhen: 'Fixture retired', upstreamStatus: { state: 'not-submitted', evidence: 'Fixture' },
      verification: { hostTests: [], integrations: ['source'] } });
    previous = commit;
  }
  const tree = git(source, 'rev-parse', 'HEAD^{tree}');
  const sourceSha256 = digest(execFileSync('git', ['ls-tree', '-r', '-z', '--full-tree', tree], { cwd: source }));
  const manifest = { schemaVersion: 1, baseCommit, patchedTree: tree, patchedSourceSha256: sourceSha256,
    upstream: { repository: 'https://example.test/dsh.git', ref: 'fixture' }, verificationProfiles: { source: { kind: 'fixture' } }, patches: entries };
  await writeFile(join(patches, 'manifest.json'), json(manifest));
  return { root, source, patches, manifest, head: previous };
}

test('maintenance commits export reproducibly and import into an independent editable checkout', async t => {
  const input = await fixture(t);
  const first = await exportMaintenanceSource(input);
  assert.equal(first.scope, 'git-ancestry-and-regenerated-patches');
  assert.equal(first.tree, input.manifest.patchedTree);
  assert.equal(first.patches, 2);
  const before = await readFile(join(input.patches, 'source.json'));
  git(input.source, 'config', 'diff.algorithm', 'histogram');
  git(input.source, 'config', 'diff.mnemonicPrefix', 'true');
  git(input.source, 'config', 'color.ui', 'always');
  assert.deepEqual(await exportMaintenanceSource(input), first);
  assert.deepEqual(await readFile(join(input.patches, 'source.json')), before);
  assert.equal((await checkMaintenanceSource({ patches: input.patches })).scope, 'descriptor-and-export-digests');
  const output = join(input.root, 'imported');
  assert.equal((await importMaintenanceSource({ ...input, output })).imported, true);
  assert.equal(git(output, 'rev-parse', 'HEAD'), input.head);
  assert.equal(git(output, 'symbolic-ref', 'HEAD'), branchRef);
  assert.equal(git(output, 'status', '--porcelain'), '');
  assert.equal(git(output, 'remote'), '');
  assert.equal(await readFile(join(output, 'added.mjs'), 'utf8'), 'export const added = true;\n');
  await assert.rejects(readFile(join(output, 'old.mjs')), { code: 'ENOENT' });
  await assert.rejects(importMaintenanceSource({ ...input, output }), /already exists/);
  assert.equal(git(input.source, 'rev-parse', 'HEAD'), input.head);
  assert.equal(git(input.source, 'status', '--porcelain'), '');
});

test('patch edits remain rejected even when both exported hash inventories are rewritten', async t => {
  const input = await fixture(t); await exportMaintenanceSource(input);
  const path = join(input.patches, '001-fixture.patch');
  const changed = (await readFile(path, 'utf8')).replace('+export const value = 2;', '+export const value = 9;');
  await writeFile(path, changed);
  const manifest = JSON.parse(await readFile(join(input.patches, 'manifest.json')));
  const descriptor = JSON.parse(await readFile(join(input.patches, 'source.json')));
  manifest.patches[0].sha256 = descriptor.commits[0].sha256 = digest(changed);
  manifest.maintenanceSource.sha256 = digest(json(descriptor));
  await writeFile(join(input.patches, 'source.json'), json(descriptor));
  await writeFile(join(input.patches, 'manifest.json'), json(manifest));
  assert.equal((await checkMaintenanceSource({ patches: input.patches })).verified, true);
  await assert.rejects(checkMaintenanceSource(input), /bundle commits differ/);
  const baseline = join(input.root, 'baseline');
  git(input.source, 'worktree', 'add', '--detach', baseline, manifest.baseCommit);
  await assert.rejects(withDesktopCheckout({ source: baseline, patches: input.patches,
    output: join(input.root, 'package-output'), commit: manifest.baseCommit }, () => assert.fail('build must not start')), /bundle commits differ/);
});

test('bundle corruption, mixed baseline and reordered commits fail admission', async t => {
  const input = await fixture(t); await exportMaintenanceSource(input);
  const descriptorPath = join(input.patches, 'source.json'), manifestPath = join(input.patches, 'manifest.json');
  const descriptor = JSON.parse(await readFile(descriptorPath)), manifest = JSON.parse(await readFile(manifestPath));
  async function rewrite(value) {
    manifest.maintenanceSource.sha256 = digest(json(value));
    await writeFile(descriptorPath, json(value)); await writeFile(manifestPath, json(manifest));
  }
  await rewrite({ ...descriptor, baseCommit: '0'.repeat(40) });
  await assert.rejects(checkMaintenanceSource(input), /baseline/);
  await rewrite({ ...descriptor, commits: [...descriptor.commits].reverse() });
  await assert.rejects(checkMaintenanceSource(input), /inventory/);
  await rewrite(descriptor);
  delete manifest.maintenanceSource;
  await writeFile(manifestPath, json(manifest));
  await assert.rejects(checkMaintenanceSource(input), /not bound/);
  manifest.maintenanceSource = { descriptor: 'source.json', sha256: digest(json(descriptor)) };
  await writeFile(manifestPath, json(manifest));
  await writeFile(join(input.patches, descriptor.bundle.file), 'corrupt bundle');
  await assert.rejects(checkMaintenanceSource(input), /bundle digest/);
});

test('dirty source and wrong commit trailers cannot overwrite reviewed exports', async t => {
  const input = await fixture(t); await exportMaintenanceSource(input);
  const before = await readFile(join(input.patches, 'source.json'));
  await writeFile(join(input.source, 'uncommitted.mjs'), 'pending\n');
  await assert.rejects(exportMaintenanceSource(input), /commit maintenance edits/);
  await rm(join(input.source, 'uncommitted.mjs'));
  git(input.source, 'commit', '--amend', '-qm', 'Wrong trailer\n\nStudio-Patch: 001');
  await assert.rejects(exportMaintenanceSource(input), /trailer/);
  assert.deepEqual(await readFile(join(input.patches, 'source.json')), before);
});

test('merge commits are refused even when the patch inventory has the same number of entries', async t => {
  const input = await fixture(t);
  const second = git(input.source, 'rev-parse', 'HEAD');
  git(input.source, 'reset', '--hard', 'HEAD~1');
  git(input.source, 'merge', '--no-ff', '--no-edit', second);
  input.manifest.patches.push({ ...input.manifest.patches[1], id: '003', file: '003-fixture.patch' });
  await writeFile(join(input.patches, 'manifest.json'), json(input.manifest));
  await assert.rejects(exportMaintenanceSource(input), /linear chain/);
});
