import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { assertDesktopDevResources, closeVerificationClient } from '../scripts/desktop-dev-resources.mjs';

test('missing Office payload fails before Electron can display a fatal startup dialog', async t => {
  const source = await mkdtemp(join(tmpdir(), 'studio-desktop-resources-'));
  t.after(() => rm(source, { recursive: true, force: true }));
  const primaryRuntime = join(source, 'runtime/primary-runtime');
  const assets = join(source, 'runtime/office-skills');
  const cli = join(source, 'apps/desktop-host/node_modules/@deepseek-ai/libreoffice-kit/lib/cli.js');
  for (const path of [cli, join(dirname(dirname(cli)), 'package.json'),
    join(primaryRuntime, 'runtime.json'), join(primaryRuntime, 'dependencies/node/bin/node'),
    join(primaryRuntime, 'dependencies/python/bin/python3'), join(primaryRuntime, 'dependencies/pnpm/bin/pnpm.mjs'),
    ...['office-docx', 'office-pptx', 'office-xlsx'].map(name => join(assets, name, 'SKILL.md'))]) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, path.endsWith('package.json') ? '{"name":"@deepseek-ai/libreoffice-kit"}' : 'fixture');
  }
  await assert.rejects(assertDesktopDevResources({ source, primaryRuntime }), /check_office.py/);
  await mkdir(join(assets, 'scripts'));
  await writeFile(join(assets, 'scripts/check_office.py'), '# fixture');
  await assertDesktopDevResources({ source, primaryRuntime });
  await rm(join(primaryRuntime, 'dependencies/node/bin/node'));
  await assert.rejects(assertDesktopDevResources({ source, primaryRuntime }), /dependencies\/node\/bin\/node/);
});

test('a stuck Electron close cannot leave the verifier child running', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await once(child, 'spawn');
  const exited = once(child, 'exit');
  try {
    await closeVerificationClient({ process: () => child, close: () => new Promise(() => {}) }, 50);
    await exited;
    assert.equal(child.signalCode, 'SIGKILL');
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
});
