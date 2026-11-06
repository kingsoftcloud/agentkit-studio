import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectRuntimeInstallation, reportHostStartupFailure } from '../src/runtime-host-installation.mjs';

async function installationFixture(t, { dshVersion = '0.2.2-rc.1', requiredDsh = '0.2.2-rc.1' } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'host-startup-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modules = join(root, 'installation/node_modules');
  const dsh = join(modules, '@deepseek-ai/dsh'), studio = join(modules, '@kingsoftcloud/agentkit-studio');
  await mkdir(join(dsh, 'lib'), { recursive: true });
  await mkdir(studio, { recursive: true });
  await writeFile(join(dsh, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: dshVersion }));
  await writeFile(join(dsh, 'lib/bin.js'), '// entry');
  await writeFile(join(studio, 'studio.plugin.json'), JSON.stringify({ requiredDsh }));
  return { root, installation: join(root, 'installation') };
}

test('a DSH/Studio version mismatch names both versions and reports to the state log', async t => {
  const { root, installation } = await installationFixture(t, { dshVersion: '0.2.1-rc.2', requiredDsh: '0.2.2-rc.1' });
  const error = await inspectRuntimeInstallation(installation).then(() => null, value => value);
  assert.equal(error.code, 'BUNDLE_HOST_VERSION_MISMATCH');
  assert.match(error.message, /0\.2\.2-rc\.1/);
  assert.match(error.message, /0\.2\.1-rc\.2/);
  assert.deepEqual(error.details, { requiredDsh: '0.2.2-rc.1', actualDsh: '0.2.1-rc.2' });

  const state = join(root, 'state');
  const record = await reportHostStartupFailure(error, { event: 'bundle.host.failed', state, generic: '运行包启动失败' });
  assert.equal(record.code, 'BUNDLE_HOST_VERSION_MISMATCH');
  assert.equal(record.message, error.message);
  const log = await readFile(join(state, 'host-startup-error.log'), 'utf8');
  assert.match(log, /BUNDLE_HOST_VERSION_MISMATCH/);
  assert.match(log, /0\.2\.2-rc\.1/);
  assert.match(log, /0\.2\.1-rc\.2/);
});

test('an unrelated startup failure keeps the sanitized message and never writes paths', async t => {
  const { root } = await installationFixture(t);
  const state = join(root, 'state');
  const error = Object.assign(new Error('/secret/path/leaked credential'), { code: 'BUNDLE_HOST_TOKEN_REQUIRED' });
  const record = await reportHostStartupFailure(error, { event: 'bundle.host.failed', state, generic: '运行包启动失败，请检查安装、运行包、独立状态目录及所需凭证' });
  assert.equal(record.message, '运行包启动失败，请检查安装、运行包、独立状态目录及所需凭证');
  assert.equal(record.detail, undefined);
  const log = await readFile(join(state, 'host-startup-error.log'), 'utf8');
  assert.doesNotMatch(log, /secret\/path/);
});
