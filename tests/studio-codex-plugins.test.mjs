import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioCodexPlugins } from '../src/studio-codex-plugins.mjs';

test('Codex lifecycle keeps the marketplace-qualified plugin identity', async () => {
  const calls = [];
  const plugins = createStudioCodexPlugins({ catalogRpc: async () => { throw new Error('RPC unavailable in CLI fixture'); }, codexHome: '/tmp/isolated-codex', executable: 'codex', execImpl: async (...args) => { calls.push(args); return { stdout: JSON.stringify({ pluginId: args[1][2], authPolicy: 'ON_USE' }) }; } });
  await plugins.installCodex('sample', 'local-market');
  await plugins.uninstallCodex('sample@local-market');
  assert.deepEqual(calls.map(call => call[1]), [['plugin', 'add', 'sample@local-market', '--json'], ['plugin', 'remove', 'sample@local-market', '--json']]);
  assert.equal(calls[0][2].env.CODEX_HOME, '/tmp/isolated-codex');
});

test('Codex catalog retains marketplace and trusts an empty authoritative inventory over cache', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-codex-plugins-'));
  try {
    await mkdir(join(dir, 'plugins/cache/openai-bundled/stale'), { recursive: true });
    const empty = createStudioCodexPlugins({ catalogRpc: async () => { throw new Error('RPC unavailable in CLI fixture'); }, codexHome: dir, execImpl: async () => ({ stdout: JSON.stringify({ installed: [], available: [] }) }) });
    assert.deepEqual((await empty.listCodex()).items, []);
    const plugins = createStudioCodexPlugins({ catalogRpc: async () => { throw new Error('RPC unavailable in CLI fixture'); }, execImpl: async () => ({ stdout: JSON.stringify({ installed: [], available: [{ name: 'sample', marketplaceName: 'market', pluginId: 'sample@market', installed: false }] }) }) });
    const item = (await plugins.listCodex()).items[0];
    assert.equal(item.marketplaceName, 'market');
    assert.equal(item.pluginId, 'sample@market');
    assert.equal(item.installed, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Codex CLI fallback includes available plugins and permits catalogs larger than the exec default', async () => {
  const plugins = createStudioCodexPlugins({ catalogRpc: async () => { throw new Error('old server'); }, execImpl: async (_command, args, options) => {
    assert.deepEqual(args.slice(-4), ['plugin', 'list', '--available', '--json']);
    assert.equal(options.maxBuffer, 16 * 1024 * 1024);
    return { stdout: JSON.stringify({ installed: [], available: [] }) };
  } });
  assert.equal((await plugins.listCodex()).source, 'codex-cli');
});

test('App Server plugin metadata preserves official presentation, eligibility and featured identities', async () => {
  const plugins = createStudioCodexPlugins({ codexHome: '/tmp/test-codex', catalogRpc: async (read, options) => {
    assert.equal(options.env.CODEX_HOME, '/tmp/test-codex');
    return read(async (method, params) => {
      assert.equal(method, 'plugin/list'); assert.equal(params.forceRefetch, false);
      return { featuredPluginIds: ['remote-sample'], marketplaces: [{ name: 'market', plugins: [
        { id: 'sample@market', remotePluginId: 'remote-sample', name: 'sample', installed: false, enabled: false, mustShowInstallationInterstitial: true, interface: { displayName: 'Sample Tool', shortDescription: 'Official summary', composerIconUrl: 'https://example.com/icon.png' }, shareContext: { creatorName: 'private-user' } },
        { id: 'denied@market', name: 'denied', availability: 'UNAVAILABLE', interface: { composerIconUrl: 'javascript:alert(1)' } },
      ] }] };
    });
  }, execImpl: () => assert.fail('rich catalog should not fall back to CLI') });
  const result = await plugins.listCodex();
  assert.equal(result.source, 'codex-app-server');
  assert.equal(result.items[0].displayName, 'Sample Tool');
  assert.equal(result.items[0].description, 'Official summary');
  assert.equal(result.items[0].featured, true);
  assert.equal(result.items[0].iconUrl, 'https://example.com/icon.png');
  assert.equal(result.items[0].readOnlyReason, 'codex-install-confirmation');
  assert.equal(result.items[1].readOnlyReason, 'codex-unavailable');
  assert.equal(result.items[1].iconUrl, undefined);
  assert.ok(!JSON.stringify(result).includes('private-user'));
});

test('Codex CLI failures keep a typed actionable diagnostic', async () => {
  const plugins = createStudioCodexPlugins({ catalogRpc: async () => { throw new Error('RPC unavailable in CLI fixture'); }, execImpl: async () => { throw Object.assign(new Error('command failed'), { stderr: 'No marketplace found for sample' }); } });
  await assert.rejects(() => plugins.installCodex('sample@market'), error => error.code === 'CODEX_PLUGIN_OPERATION_FAILED' && error.message.includes('No marketplace found'));
});

test('Codex cache fallback cannot claim enabled plugins or expose lifecycle actions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-codex-cache-'));
  try {
    const manifestDir = join(dir, 'plugins/cache/openai-bundled/sample/.codex-plugin');
    await mkdir(manifestDir, { recursive: true });
    await writeFile(join(manifestDir, 'plugin.json'), JSON.stringify({ name: 'sample' }));
    const plugins = createStudioCodexPlugins({ catalogRpc: async () => { throw new Error('RPC unavailable in CLI fixture'); }, codexHome: dir, execImpl: async () => { throw Object.assign(new Error('not found'), { code: 'ENOENT' }); } });
    const result = await plugins.listCodex();
    assert.equal(result.items[0].enabled, false);
    assert.equal(result.items[0].status, 'cached');
    assert.equal(result.items[0].lifecycleAvailable, false);
    assert.equal(result.error.code, 'CODEX_PLUGIN_INVENTORY_UNAVAILABLE');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
