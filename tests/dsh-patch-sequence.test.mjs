import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const studio = fileURLToPath(new URL('..', import.meta.url));
function fixture(t) {
  const temporary = mkdtempSync(join(tmpdir(), 'studio-patch-sequence-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const repo = join(temporary, 'official checkout');
  const patches = join(temporary, 'patch set');
  mkdirSync(repo); mkdirSync(patches);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  writeFileSync(join(repo, 'profile.txt'), 'base\n');
  git('add', 'profile.txt');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base');
  writeFileSync(join(patches, '001.patch'), 'diff --git a/profile.txt b/profile.txt\n--- a/profile.txt\n+++ b/profile.txt\n@@ -1 +1 @@\n-base\n+product\n');
  writeFileSync(join(patches, '002.patch'), 'diff --git a/profile.txt b/profile.txt\n--- a/profile.txt\n+++ b/profile.txt\n@@ -1 +1 @@\n-product\n+upgraded\n');
  const check = () => execFileSync('make', ['patch-check', `DSH_ROOT=${repo}`, `PATCH_ROOT=${patches}`, `DSH_COMMIT=${git('rev-parse', 'HEAD').trim()}`], { cwd: studio, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { repo, patches, git, check };
}

test('patch-check accepts dependent patches in order without changing the checkout or index', t => {
  const { repo, git, check } = fixture(t);
  const index = git('ls-files', '--stage');
  check();
  assert.equal(readFileSync(join(repo, 'profile.txt'), 'utf8'), 'base\n');
  assert.equal(git('ls-files', '--stage'), index);
  assert.equal(git('status', '--porcelain'), '');
});

test('patch-check rejects an invalid later patch without leaving the first patch applied', t => {
  const { repo, patches, git, check } = fixture(t);
  writeFileSync(join(patches, '002.patch'), readFileSync(join(patches, '002.patch'), 'utf8').replace('-product', '-unknown'));
  assert.throws(check);
  assert.equal(readFileSync(join(repo, 'profile.txt'), 'utf8'), 'base\n');
  assert.equal(git('status', '--porcelain'), '');
});
