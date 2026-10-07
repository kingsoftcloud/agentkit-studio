import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioCodexPlugins } from '../src/studio-codex-plugins.mjs';

test('Codex lifecycle keeps the marketplace-qualified plugin identity', async () => {
  const calls = [];
  const plugins = createStudioCodexPlugins({ codexHome: '/tmp/isolated-codex', execImpl: async (...args) => { calls.push(args); return { stdout: '{}' }; } });
  await plugins.installCodex('sample', 'local-market');
  await plugins.uninstallCodex('sample@local-market');
  assert.deepEqual(calls.map(call => call[1]), [['plugin', 'add', 'sample@local-market', '--json'], ['plugin', 'remove', 'sample@local-market', '--json']]);
  assert.equal(calls[0][2].env.CODEX_HOME, '/tmp/isolated-codex');
});

test('Codex catalog retains marketplace and trusts an empty authoritative inventory over cache', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-codex-plugins-'));
  try {
    await mkdir(join(dir, 'plugins/cache/openai-bundled/stale'), { recursive: true });
    const empty = createStudioCodexPlugins({ codexHome: dir, execImpl: async () => ({ stdout: JSON.stringify({ installed: [], available: [] }) }) });
    assert.deepEqual((await empty.listCodex()).items, []);
    const plugins = createStudioCodexPlugins({ execImpl: async () => ({ stdout: JSON.stringify({ installed: [], available: [{ name: 'sample', marketplaceName: 'market', pluginId: 'sample@market', installed: false }] }) }) });
    const item = (await plugins.listCodex()).items[0];
    assert.equal(item.marketplaceName, 'market');
    assert.equal(item.pluginId, 'sample@market');
    assert.equal(item.installed, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Codex CLI failures keep a typed actionable diagnostic', async () => {
  const plugins = createStudioCodexPlugins({ execImpl: async () => { throw Object.assign(new Error('command failed'), { stderr: 'No marketplace found for sample' }); } });
  await assert.rejects(() => plugins.installCodex('sample@market'), error => error.code === 'CODEX_PLUGIN_OPERATION_FAILED' && error.message.includes('No marketplace found'));
});

test('Codex cache fallback cannot claim enabled plugins or expose lifecycle actions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-codex-cache-'));
  try {
    const manifestDir = join(dir, 'plugins/cache/openai-bundled/sample/.codex-plugin');
    await mkdir(manifestDir, { recursive: true });
    await writeFile(join(manifestDir, 'plugin.json'), JSON.stringify({ name: 'sample' }));
    const plugins = createStudioCodexPlugins({ codexHome: dir, execImpl: async () => { throw Object.assign(new Error('not found'), { code: 'ENOENT' }); } });
    const result = await plugins.listCodex();
    assert.equal(result.items[0].enabled, false);
    assert.equal(result.items[0].status, 'cached');
    assert.equal(result.items[0].lifecycleAvailable, false);
    assert.equal(result.error.code, 'CODEX_PLUGIN_INVENTORY_UNAVAILABLE');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
