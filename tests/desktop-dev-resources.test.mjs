import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { assertDesktopDevHome, assertDesktopDevResources, closeVerificationClient } from '../scripts/desktop-dev-resources.mjs';

test('desktop source links reject nested profiles, including paths through directory aliases', async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-desktop-home-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'dsh'), studio = join(root, 'studio');
  await mkdir(source); await mkdir(studio);
  await assertDesktopDevHome({ source, studio, home: join(root, 'user-home/dsh') });
  for (const base of [source, studio]) await assert.rejects(assertDesktopDevHome({ source, studio, home: join(base, 'new-home') }), /outside/);
  const alias = join(root, 'alias');
  await symlink(studio, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(assertDesktopDevHome({ source, studio, home: join(alias, 'new-home') }), /outside/);
});

for (const nodeOnly of [false, true]) test(`Desktop checks actual Office assets and declared interpreters (Node-only: ${nodeOnly})`, async t => {
  const source = await mkdtemp(join(tmpdir(), 'studio-desktop-resources-'));
  t.after(() => rm(source, { recursive: true, force: true }));
  const primaryRuntime = join(source, 'runtime/primary-runtime');
  const assets = join(source, 'runtime/office-skills');
  const cli = join(source, 'apps/desktop-host/node_modules/@deepseek-ai/libreoffice-kit/lib/cli.js');
  const node = join(primaryRuntime, 'dependencies/node/bin', process.platform === 'win32' ? 'node.exe' : 'node');
  const python = join(primaryRuntime, 'dependencies/python', ...(process.platform === 'win32' ? ['python.exe'] : ['bin/python3']));
  for (const path of [cli, join(dirname(dirname(cli)), 'package.json'),
    node, ...nodeOnly ? [] : [python], join(primaryRuntime, 'dependencies/pnpm/bin/pnpm.mjs'),
    ...['office', 'office-docx', 'office-pptx', 'office-xlsx', 'office-recalculate', 'office-export-pdf'].map(name => join(assets, name, 'SKILL.md'))]) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, path.endsWith('package.json') ? '{"name":"@deepseek-ai/libreoffice-kit"}' : 'fixture');
  }
  const manifest = { desktopVersion: '1', platform: process.platform, arch: process.arch, node: '24.21.0', pnpm: '11.28.5',
    officeLibrarySha256: createHash('sha256').update('fixture').digest('hex'),
    pythonPackages: {}, ...nodeOnly ? { schemaVersion: 2 } : { python: '3.12.14' } };
  await writeFile(join(primaryRuntime, 'runtime.json'), JSON.stringify(manifest));
  if (!nodeOnly) {
    await assert.rejects(assertDesktopDevResources({ source, primaryRuntime }), /requires Node-only Office/);
    return;
  }
  for (const path of [join(primaryRuntime, 'dependencies/node/node_modules/office.mjs'),
    ...['office-docx', 'office-pptx', 'office-xlsx', 'office-recalculate'].map(name => join(assets, name, 'SKILL.node.md'))]) {
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, 'fixture');
  }
  await assert.rejects(assertDesktopDevResources({ source, primaryRuntime }), /office-render/);
  await mkdir(join(assets, 'office-render'));
  await writeFile(join(assets, 'office-render/SKILL.md'), '# fixture');
  await assertDesktopDevResources({ source, primaryRuntime });
  const library = join(primaryRuntime, 'dependencies/node/node_modules/office.mjs');
  await writeFile(library, 'corrupt');
  await assert.rejects(assertDesktopDevResources({ source, primaryRuntime }), /checksum mismatch/);
  await writeFile(library, 'fixture');
  if (nodeOnly) {
    await writeFile(join(primaryRuntime, 'runtime.json'), JSON.stringify({ ...manifest, python: '3.12.14' }));
    await assert.rejects(assertDesktopDevResources({ source, primaryRuntime }), /no Python metadata/);
    await writeFile(join(primaryRuntime, 'runtime.json'), JSON.stringify(manifest));
  } else {
    await rm(python);
    await assert.rejects(assertDesktopDevResources({ source, primaryRuntime }), /dependencies\/python/);
    await writeFile(python, 'fixture');
  }
  await rm(node);
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
