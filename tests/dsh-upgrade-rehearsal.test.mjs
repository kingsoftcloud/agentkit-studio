import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rehearsePatches } from '../scripts/rehearse-dsh-patches.mjs';
import { writeReviewedPatchFixture } from './helpers/reviewed-patch-series.mjs';

async function fixture(t, initial = 'base') {
  const root = await mkdtemp(join(tmpdir(), 'studio-upgrade-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, 'candidate with spaces'), patches = join(root, 'patches');
  await mkdir(checkout); await mkdir(patches);
  const git = (...args) => execFileSync('git', args, { cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q');
  await writeFile(join(checkout, 'profile.txt'), `${initial}\n`);
  await writeFile(join(checkout, 'other.txt'), 'base\n');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'candidate');
  const patch = (file, before, after) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-${before}\n+${after}\n`;
  await writeFile(join(patches, '001-profile.patch'), patch('profile.txt', 'base', 'product'));
  await writeFile(join(patches, '002-profile.patch'), patch('profile.txt', 'product', 'upgraded'));
  await writeFile(join(patches, '003-other.patch'), patch('other.txt', 'base', 'independent'));
  const commit = git('rev-parse', 'HEAD');
  await writeReviewedPatchFixture(patches, commit, checkout);
  return { checkout, patches, commit, git, run: () => rehearsePatches({ checkout, patches, commit }) };
}

test('checks a dependent series using a private index and never treats application as acceptance', async t => {
  const f = await fixture(t), index = f.git('ls-files', '--stage');
  const result = await f.run();
  assert.equal(result.applicationPassed, true);
  assert.equal(result.acceptancePassed, false);
  assert.deepEqual(result.verifiedRemovals, []);
  assert.equal(result.patches.length, 3);
  assert.equal(await readFile(join(f.checkout, 'profile.txt'), 'utf8'), 'base\n');
  assert.equal(f.git('ls-files', '--stage'), index);
  assert.equal(f.git('status', '--porcelain'), '');
});

test('distinguishes a direct conflict from blocked dependencies and still checks independent work', async t => {
  const f = await fixture(t, 'changed-upstream');
  const result = await f.run();
  assert.equal(result.applicationPassed, false);
  assert.deepEqual(result.patches.map(patch => patch.application), ['needs-rework', 'dependency-blocked', 'applied']);
  assert.deepEqual(result.patches[1].blockedBy, ['001']);
  assert.equal(f.git('status', '--porcelain'), '');
});

test('an already present textual change is not automatically considered an equivalent removable patch', async t => {
  const f = await fixture(t, 'product');
  const result = await f.run();
  assert.equal(result.patches[0].application, 'needs-rework');
  assert.equal(result.patches[0].removalVerified, false);
  assert.deepEqual(result.verifiedRemovals, []);
});

test('rejects a moving ref or dirty candidate before checking patches', async t => {
  const f = await fixture(t);
  await assert.rejects(rehearsePatches({ ...f, commit: '0'.repeat(40) }), /HEAD does not match/);
  await writeFile(join(f.checkout, 'profile.txt'), 'user change\n');
  await assert.rejects(f.run(), /must be clean/);
  assert.equal(await readFile(join(f.checkout, 'profile.txt'), 'utf8'), 'user change\n');
});

test('rejects altered patch content against its reviewed digest', async t => {
  const f = await fixture(t);
  await writeFile(join(f.patches, '001-profile.patch'), 'unreviewed change\n');
  await assert.rejects(f.run(), /content digest mismatch/);
  assert.equal(f.git('status', '--porcelain'), '');
});
