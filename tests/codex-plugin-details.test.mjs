import test from 'node:test';
import assert from 'node:assert/strict';
import { readCodexPluginDetails, codexPluginSelector } from '../src/codex-plugin-details.mjs';
import { createStudioCodexPlugins } from '../src/studio-codex-plugins.mjs';

test('connector runtime states are distinct from plugin installation and match by exact id', async () => {
  const calls = [];
  const detail = await readCodexPluginDetails(async (method, params) => {
    calls.push([method, params]);
    if (method === 'plugin/list') return { marketplaces: [{ name: 'market', path: '/private/market', plugins: [{ id: 'sample@market', name: 'sample', installed: true, authPolicy: 'ON_INSTALL' }] }] };
    if (method === 'plugin/read') return { plugin: { apps: [
      { id: 'a', name: 'Same name', installUrl: 'https://chatgpt.com/apps/a' }, { id: 'b', name: 'Same name' },
      { id: 'c', name: 'Disabled' }, { id: 'd', name: 'Waiting', installUrl: 'javascript:alert(1)' },
    ], skills: [{ name: 'skill', enabled: true, path: '/private/skill' }], mcpServers: ['tool-server'] } };
    return { apps: [{ id: 'a', enabled: true, callable: true }, { id: 'c', enabled: false, callable: true }, { id: 'd', enabled: true, callable: false }] };
  }, codexPluginSelector('sample@market'));
  assert.deepEqual(calls[1], ['plugin/read', { pluginName: 'sample', marketplacePath: '/private/market' }]);
  assert.deepEqual(detail.apps.map(app => app.state), ['callable', 'not-loaded', 'disabled', 'not-callable']);
  assert.equal(detail.apps[3].installUrl, '');
  assert.equal(detail.authPolicy, 'ON_INSTALL');
  assert.ok(!JSON.stringify(detail).includes('/private'));
});

test('runtime lookup failure preserves authorization guidance but never claims callable', async () => {
  const detail = await readCodexPluginDetails(async (method, params) => {
    if (method === 'plugin/list') return { marketplaces: [{ name: 'remote', plugins: [{ name: 'sample' }] }] };
    if (method === 'plugin/read') {
      assert.deepEqual(params, { pluginName: 'sample', remoteMarketplaceName: 'remote' });
      return { plugin: { apps: [{ id: 'a', name: 'App', installUrl: 'https://chatgpt.com/apps/a' }], skills: [], mcpServers: [] } };
    }
    throw new Error('secret diagnostic');
  }, codexPluginSelector('sample@remote'));
  assert.equal(detail.apps[0].state, 'unknown');
  assert.equal(detail.apps[0].installUrl, 'https://chatgpt.com/apps/a');
  assert.ok(detail.runtimeError);
  assert.ok(!JSON.stringify(detail).includes('secret diagnostic'));
});

test('CLI installation retains authorization requirements and strips paths and untrusted extra fields', async () => {
  const service = createStudioCodexPlugins({ execImpl: async () => ({ stdout: JSON.stringify({
    pluginId: 'sample@market', authPolicy: 'ON_INSTALL', installedPath: '/private/cache', secret: 'private-token',
    appsNeedingAuth: [{ id: 'a', name: 'App', installUrl: 'https://chatgpt.com/apps/a', secret: 'private-token' }],
  }) }) });
  const result = await service.installCodex('sample@market');
  assert.equal(result.authPolicy, 'ON_INSTALL');
  assert.equal(result.appsNeedingAuth[0].installUrl, 'https://chatgpt.com/apps/a');
  assert.match(result.note, /仍需/);
  assert.ok(!JSON.stringify(result).includes('private'));
});

test('successful process exit with malformed or mismatched CLI results is not installation success and is never retried', async () => {
  for (const stdout of ['{}', 'not JSON', JSON.stringify({ pluginId: 'other@market' })]) {
    let calls = 0;
    const service = createStudioCodexPlugins({ execImpl: async () => { calls++; return { stdout }; } });
    await assert.rejects(service.installCodex('sample@market'), { code: 'CODEX_PLUGIN_RESULT_UNCONFIRMED' });
    assert.equal(calls, 1);
  }
});
