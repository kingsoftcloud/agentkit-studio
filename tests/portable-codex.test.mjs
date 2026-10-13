import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { portableCodexOptions } from '../src/portable-codex.mjs';

const manifest = { bundleId: `bundle_${'a'.repeat(64)}` };
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'portable-codex-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

test('imported Codex state is scoped to the bundle and excludes operator environment and personal plugins', async t => {
  const home = await fixture(t);
  const options = await portableCodexOptions({ home, manifest, env: {
    PATH: '/usr/bin', HOME: '/personal', CODEX_HOME: '/personal/codex', OPENAI_API_KEY: 'private',
    AGENTKIT_CODEX_MODEL: 'wrong-model', AGENTKIT_CODEX_SANDBOX: 'danger-full-access', KSYUN_SECRET_KEY: 'cloud-secret',
  } });
  assert.equal(options.inheritEnv, false);
  assert.equal(options.sandbox, 'read-only');
  assert.equal(options.approvalPolicy, 'never');
  assert.equal(options.env.PATH, '/usr/bin');
  for (const key of ['OPENAI_API_KEY', 'KSYUN_SECRET_KEY', 'AGENTKIT_CODEX_MODEL', 'AGENTKIT_CODEX_SANDBOX']) assert.equal(options.env[key], undefined);
  assert.notEqual(options.env.HOME, '/personal');
  assert.ok(options.env.CODEX_HOME.includes(manifest.bundleId));
  await assert.rejects(readFile(join(options.env.CODEX_HOME, 'auth.json')), { code: 'ENOENT' });
  await writeFile(join(options.cwd, 'retained'), 'persisted');
  const repeated = await portableCodexOptions({ home, manifest });
  assert.equal(repeated.cwd, options.cwd);
  assert.equal(await readFile(join(repeated.cwd, 'retained'), 'utf8'), 'persisted');
  const other = await portableCodexOptions({ home, manifest: { bundleId: `bundle_${'b'.repeat(64)}` } });
  assert.notEqual(other.cwd, options.cwd);
  assert.notEqual(other.env.CODEX_HOME, options.env.CODEX_HOME);
});

test('state creation refuses a symlink into an existing personal Codex home', async t => {
  const home = await fixture(t), personal = join(home, 'personal');
  await mkdir(personal);
  await writeFile(join(personal, 'auth.json'), 'must stay intact');
  await symlink(personal, join(home, 'runtime-state'));
  await assert.rejects(portableCodexOptions({ home, manifest }), { code: 'PORTABLE_CODEX_SCOPE_INVALID' });
  assert.equal(await readFile(join(personal, 'auth.json'), 'utf8'), 'must stay intact');
  await assert.rejects(portableCodexOptions({ home, manifest: { bundleId: '../personal' } }), { code: 'PORTABLE_CODEX_SCOPE_INVALID' });
});
