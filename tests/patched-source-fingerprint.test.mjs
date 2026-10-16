import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprintPatchedSource, assertPatchedSource } from '../scripts/patched-source-fingerprint.mjs';

async function fixture(t) {
  const temporary = await mkdtemp(join(tmpdir(), 'studio-source-tree-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const source = join(temporary, 'checked source'); await mkdir(source);
  const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q'); git('config', 'core.autocrlf', 'false');
  await writeFile(join(source, 'source.mjs'), 'export const value = 1;\n');
  await writeFile(join(source, '中文.txt'), 'source text\n');
  git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base');
  return { source, git };
}

test('source fingerprint survives diff presentation changes and preserves the caller index', async t => {
  const { source, git } = await fixture(t);
  await writeFile(join(source, 'source.mjs'), 'export const value = 2;\n');
  git('config', 'core.abbrev', '7');
  const initialIndex = git('ls-files', '--stage'), initialDiff = git('diff', 'HEAD', '--binary');
  const before = await fingerprintPatchedSource(source);
  git('config', 'core.abbrev', '12'); git('config', 'diff.mnemonicPrefix', 'true');
  assert.notEqual(git('diff', 'HEAD', '--binary'), initialDiff);
  assert.deepEqual(await fingerprintPatchedSource(source), before);
  assert.equal(git('ls-files', '--stage'), initialIndex);
});

test('source admission rejects modified, added and deleted source files', async t => {
  const { source } = await fixture(t), expected = await fingerprintPatchedSource(source);
  const manifest = { patchedTree: expected.tree, patchedSourceSha256: expected.sha256 };
  await assertPatchedSource(source, manifest);
  await writeFile(join(source, 'source.mjs'), 'export const value = 3;\n');
  await assert.rejects(assertPatchedSource(source, manifest), { code: 'PATCHED_SOURCE_MISMATCH' });
  await writeFile(join(source, 'source.mjs'), 'export const value = 1;\n');
  await writeFile(join(source, 'extra.mjs'), 'unregistered source\n');
  await assert.rejects(assertPatchedSource(source, manifest), { code: 'PATCHED_SOURCE_MISMATCH' });
  await rm(join(source, 'extra.mjs')); await rm(join(source, 'source.mjs'));
  await assert.rejects(assertPatchedSource(source, manifest), { code: 'PATCHED_SOURCE_MISMATCH' });
});


test('source fingerprints resolve linked worktree indexes without modifying either index', async t => {
  const { source, git } = await fixture(t);
  const linked = join(source, '..', 'linked source');
  git('worktree', 'add', '--detach', linked, 'HEAD');
  t.after(() => { try { git('worktree', 'remove', '--force', linked); } catch {} });
  const mainIndex = git('ls-files', '--stage');
  const linkedGit = (...args) => execFileSync('git', args, { cwd: linked, encoding: 'utf8' });
  const linkedIndex = linkedGit('ls-files', '--stage');
  const initial = await fingerprintPatchedSource(linked);
  assert.deepEqual(initial, await fingerprintPatchedSource(source));
  await writeFile(join(linked, 'source.mjs'), 'export const value = 9;\n');
  assert.notDeepEqual(await fingerprintPatchedSource(linked), initial);
  assert.deepEqual(await fingerprintPatchedSource(source), initial);
  assert.equal(git('ls-files', '--stage'), mainIndex);
  assert.equal(linkedGit('ls-files', '--stage'), linkedIndex);
});
