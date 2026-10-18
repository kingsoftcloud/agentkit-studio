import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { transform } from 'esbuild';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'studio-full-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const patch = await readFile(new URL('../patches/dsh-v0.2.1-rc.2/029-full-update-blockmap-cache.patch', import.meta.url), 'utf8');
  const body = patch.split('+++ b/apps/desktop/src/mac-full-update-cache.ts\n')[1].split('\ndiff --git')[0];
  const source = body.split('\n').filter(line => line.startsWith('+')).map(line => line.slice(1)).join('\n');
  const module = join(root, 'actual-patched-cache.mjs');
  await writeFile(module, (await transform(source, { loader: 'ts', format: 'esm', target: 'node24' })).code);
  const { discardFullUpdateBlockmaps } = await import(pathToFileURL(module));
  const cache = join(root, 'studio-updater'), pending = join(cache, 'pending');
  await mkdir(pending, { recursive: true });
  const zip = join(pending, 'AgentKit-Studio-mac-arm64.zip');
  await writeFile(zip, 'verified native ZIP');
  await writeFile(join(cache, 'update.zip'), 'native previous ZIP');
  await writeFile(join(cache, 'current.blockmap'), 'stale index');
  await writeFile(join(pending, 'current.blockmap'), 'stale pending index');
  return { discardFullUpdateBlockmaps, cache, pending, zip };
}

test('a full native release removes stale indexes without altering either ZIP', async t => {
  const f = await fixture(t);
  assert.equal(f.discardFullUpdateBlockmaps({ agentkitUpdateMode: 'full', downloadedFile: f.zip }, { platform: 'darwin' }), true);
  await assert.rejects(readFile(join(f.cache, 'current.blockmap')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(f.pending, 'current.blockmap')), { code: 'ENOENT' });
  assert.equal(await readFile(f.zip, 'utf8'), 'verified native ZIP');
  assert.equal(await readFile(join(f.cache, 'update.zip'), 'utf8'), 'native previous ZIP');
});

test('ordinary updates and other platforms retain native indexes; foreign paths are rejected', async t => {
  const f = await fixture(t);
  assert.equal(f.discardFullUpdateBlockmaps({ agentkitUpdateMode: 'incremental', downloadedFile: f.zip }, { platform: 'darwin' }), false);
  assert.equal(f.discardFullUpdateBlockmaps({ agentkitUpdateMode: 'full', downloadedFile: f.zip }, { platform: 'win32' }), false);
  assert.equal(await readFile(join(f.cache, 'current.blockmap'), 'utf8'), 'stale index');
  assert.throws(() => f.discardFullUpdateBlockmaps({ agentkitUpdateMode: 'full', downloadedFile: '/tmp/user.zip' }, { platform: 'darwin' }), /native updater download path/);
});
