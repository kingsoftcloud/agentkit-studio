import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const repository = resolve(import.meta.dirname, '..');

test('packing a source-only tree generates the DSH client and never ships a stale bundle', async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-client-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pkg = JSON.parse(await readFile(join(repository, 'package.json')));
  const source = join(root, 'source');
  // Exercise the real prepack lifecycle without reinstalling test dependencies.
  // prepack runs scripts/build-client.mjs from the copied tree, so the build
  // scripts travel with the source even though they are not published files.
  const names = new Set(['package.json', 'pnpm-workspace.yaml', '.gitignore', 'README.md', 'LICENSE', 'scripts', ...pkg.files.map(name => name.split('/')[0])]);
  names.delete('dist');
  for (const name of names) await cp(join(repository, name), join(source, name), {
    recursive: true, filter: path => !['node_modules', '.artifacts'].includes(basename(path)),
  });
  await symlink(join(repository, 'node_modules'), join(source, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const run = (command, args) => execute(command, args, { cwd: source, maxBuffer: 16 * 1024 * 1024 });
  await assert.rejects(readFile(join(source, 'dist/client.js')), { code: 'ENOENT' });
  await run('pnpm', ['pack', '--pack-destination', root]);
  const archive = join(root, `kingsoftcloud-agentkit-studio-${pkg.version}.tgz`);
  const expected = await readFile(join(source, 'dist/client.js'), 'utf8');
  assert.match(expected, /window\.__ModuleLoader__\.load\(/);
  const packed = async () => (await run('tar', ['-xOzf', archive, 'package/dist/client.js'])).stdout;
  assert.equal(await packed(), expected, 'Git-ignore must not exclude the package client export');
  await writeFile(join(source, 'dist/client.js'), 'stale build');
  await run('pnpm', ['pack', '--pack-destination', root]);
  assert.equal(await packed(), expected, 'prepack must rebuild even when dist exists');
  await rm(archive);
  await writeFile(join(source, 'src/client.js'), 'invalid JavaScript {{{');
  await assert.rejects(run('pnpm', ['pack', '--pack-destination', root]));
  await assert.rejects(readFile(archive), { code: 'ENOENT' }, 'a failed build must not emit an archive containing old dist');
});
