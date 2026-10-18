import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { verifyPackagedUpdateSource } from '../scripts/packaged-update-source.mjs';

test('signed delivery rejects the missing updater source seen in the installed app', async t => {
  const resources = await mkdtemp(join(tmpdir(), 'studio-update-source-'));
  t.after(() => rm(resources, { recursive: true, force: true }));
  const expected = { target: 'mac-arm64', origin: 'https://updates.example.org', channel: 'preview' };
  await assert.rejects(verifyPackagedUpdateSource(resources, expected), /app-update.yml is missing/);
  const config = { provider: 'generic', url: `${expected.origin}/studio/feeds/mac-arm64/`, channel: 'preview', updaterCacheDirName: 'studio-updater' };
  for (const change of [{ url: 'https://download.deepseek.com/studio/feeds/mac-arm64/' }, { channel: 'nightly' }, { url: `${expected.origin}/studio/feeds/mac-x64/` }, { updaterCacheDirName: '' }]) {
    await writeFile(join(resources, 'app-update.yml'), stringify({ ...config, ...change }));
    await assert.rejects(verifyPackagedUpdateSource(resources, expected), /does not match/);
  }
  await writeFile(join(resources, 'app-update.yml'), stringify(config));
  assert.deepEqual(await verifyPackagedUpdateSource(resources, expected), { url: config.url, channel: 'preview' });
});
