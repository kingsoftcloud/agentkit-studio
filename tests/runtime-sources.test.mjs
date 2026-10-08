import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { stageRuntimeSources } from '../scripts/stage-runtime-sources.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function repo(path, files) {
  await mkdir(path); git(path, 'init'); git(path, 'config', 'user.name', 'Fixture'); git(path, 'config', 'user.email', 'fixture@example.invalid');
  for (const [name, value] of Object.entries(files)) { await mkdir(join(path, name, '..'), { recursive: true }); await writeFile(join(path, name), value); }
  git(path, 'add', '.'); git(path, 'commit', '-m', 'fixture'); return git(path, 'rev-parse', 'HEAD');
}

test('Linux source inputs exclude working copies, profiles and ignored files while applying committed patches', async t => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-sources-')); t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'dsh'), studio = join(root, 'studio'), output = join(root, 'result');
  const commit = await repo(source, { 'package.json': '{"version":"0.2.0"}', 'code.txt': 'old\n', '.gitignore': '.env\nnode_modules/\n' });
  await writeFile(join(source, 'code.txt'), 'patched\n'); const patch = git(source, 'diff') + '\n';
  const studioCommit = await repo(studio, { 'package.json': '{"version":"0.0.1"}', 'studio.plugin.json': '{"requiredDsh":"0.2.0"}',
    'patches/dsh-v0.2.0/001-proof.patch': patch, '.gitignore': '.env\n' });
  await writeFile(join(source, '.env'), 'DO_NOT_EXPORT_SECRET'); await writeFile(join(studio, '.env'), 'DO_NOT_EXPORT_SECRET');
  await writeFile(join(source, 'untracked-profile'), 'DO_NOT_EXPORT_PROFILE');
  await writeFile(join(source, 'code.txt'), 'live-unreviewed-change\n');
  const manifest = await stageRuntimeSources({ studio, source, output, commit, dshVersion: '0.2.0' });
  assert.equal(manifest.studio.commit, studioCommit); assert.equal(manifest.dsh.commit, commit);
  for (const file of ['dsh-source.tar', 'studio-source.tar']) {
    const bytes = await readFile(join(output, file));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.inputs[file].sha256);
    for (const secret of ['DO_NOT_EXPORT_SECRET', 'DO_NOT_EXPORT_PROFILE', 'live-unreviewed-change']) assert.equal(bytes.includes(Buffer.from(secret)), false);
  }
  assert.equal(execFileSync('tar', ['-xOf', join(output, 'dsh-source.tar'), 'code.txt'], { encoding: 'utf8' }), 'patched\n');
  assert.equal(await readFile(join(source, 'code.txt'), 'utf8'), 'live-unreviewed-change\n');
  await assert.rejects(stageRuntimeSources({ studio, source, output, commit, dshVersion: '0.2.0' }), { code: 'EEXIST' });
  await writeFile(join(studio, 'package.json'), '{"version":"uncommitted"}');
  await assert.rejects(stageRuntimeSources({ studio, source, output: join(root, 'rejected'), commit, dshVersion: '0.2.0' }), /commit tracked Studio changes/);
});
