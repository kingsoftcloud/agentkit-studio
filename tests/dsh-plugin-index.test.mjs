import test from 'node:test';
import assert from 'node:assert/strict';

import { acceptPluginIndexUrl, createDshPluginIndex } from '../src/dsh-plugin-index.mjs';
import { createStudioPlugins } from '../src/studio-plugins.mjs';

const INDEX_URL = 'https://plugins.example.com/index.json';

function fetchDocument(document, { ok = true, status = 200 } = {}) {
  return async () => ({ ok, status, text: async () => JSON.stringify(document) });
}

test('plugin index without a configured URL serves the built-in catalog', async () => {
  const index = createDshPluginIndex({ env: {} });
  const loaded = await index.load();
  assert.equal(loaded.info.source, 'builtin');
  assert.equal(loaded.info.indexUrl, '');
  assert.ok(loaded.entries.length >= 3);
});

test('plugin index rejects non-HTTPS remote locations', async () => {
  assert.equal(acceptPluginIndexUrl('http://example.com/index.json'), null);
  assert.equal(acceptPluginIndexUrl('ftp://example.com/index.json'), null);
  assert.equal(acceptPluginIndexUrl('https://user:pass@example.com/index.json'), null);
  assert.equal(acceptPluginIndexUrl('http://127.0.0.1:8080/index.json')?.hostname, '127.0.0.1');
  let fetched = 0;
  const index = createDshPluginIndex({
    env: { AGENTKIT_STUDIO_DSH_PLUGIN_INDEX: 'http://example.com/index.json' },
    fetchImpl: async () => { fetched += 1; throw new Error('must not fetch'); },
  });
  const loaded = await index.load();
  assert.equal(fetched, 0);
  assert.equal(loaded.info.source, 'builtin');
  assert.equal(loaded.info.error.code, 'DSH_PLUGIN_INDEX_URL_REJECTED');
});

test('plugin index merges the remote document over the built-in list', async () => {
  const index = createDshPluginIndex({
    env: { AGENTKIT_STUDIO_DSH_PLUGIN_INDEX: INDEX_URL },
    fetchImpl: fetchDocument({ updatedAt: '2026-10-20T00:00:00Z', plugins: [{ id: 'community-plugin', displayName: 'Community' }] }),
  });
  const loaded = await index.load();
  assert.equal(loaded.info.source, 'builtin+remote');
  assert.equal(loaded.info.updatedAt, '2026-10-20T00:00:00Z');
  assert.ok(loaded.entries.some(entry => entry.id === 'community-plugin'));
  assert.ok(loaded.entries.some(entry => entry.id === '@deepseek-ai/dsh-experimental-agent-team-profile'));
});

test('plugin index keeps the last good document when a forced refresh fails', async () => {
  let calls = 0;
  const index = createDshPluginIndex({
    env: { AGENTKIT_STUDIO_DSH_PLUGIN_INDEX: INDEX_URL },
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return { ok: true, status: 200, text: async () => JSON.stringify({ plugins: [{ id: 'cached-plugin' }] }) };
      throw new Error('network down');
    },
  });
  const first = await index.load();
  assert.equal(first.info.source, 'builtin+remote');
  const refreshed = await index.refresh();
  assert.equal(refreshed.info.source, 'builtin+remote');
  assert.equal(refreshed.info.stale, true);
  assert.equal(refreshed.info.error.code, 'DSH_PLUGIN_INDEX_UNAVAILABLE');
  assert.ok(refreshed.entries.some(entry => entry.id === 'cached-plugin'));
});

test('plugin index reports HTTP and JSON failures without emptying the market', async () => {
  const http = createDshPluginIndex({ env: { AGENTKIT_STUDIO_DSH_PLUGIN_INDEX: INDEX_URL }, fetchImpl: fetchDocument({}, { ok: false, status: 503 }) });
  const failed = await http.load();
  assert.equal(failed.info.source, 'builtin');
  assert.equal(failed.info.error.code, 'DSH_PLUGIN_INDEX_HTTP_ERROR');
  assert.ok(failed.entries.length >= 3);
  const broken = createDshPluginIndex({ env: { AGENTKIT_STUDIO_DSH_PLUGIN_INDEX: INDEX_URL }, fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'not json' }) });
  assert.equal((await broken.load()).info.error.code, 'DSH_PLUGIN_INDEX_INVALID_JSON');
});

test('market list exposes catalog metadata and keeps remote rows installable', async () => {
  let installed = false;
  let installedSpec = '';
  const manager = {
    listBundles: async () => installed ? [{ name: 'community-plugin', installed: true, availability: 'profile', enabled: true, rows: [] }] : [],
    listPlugins: async () => [],
    inspect: async spec => ({ status: 'accepted', name: 'community-plugin' }),
    installBundle: async spec => { installedSpec = spec; installed = true; return { application: 'applied', changed: true }; },
  };
  const entries = [{ id: 'community-plugin', installSpec: 'community-plugin@1.0.0', displayName: 'Community', category: '界面', origin: 'remote' }];
  const pluginIndex = {
    load: async () => ({ entries, info: { source: 'builtin+remote', indexUrl: INDEX_URL, updatedAt: '2026-10-20T00:00:00Z' } }),
    refresh: async () => ({ entries: [], info: { source: 'builtin', indexUrl: '', updatedAt: '' } }),
  };
  const plugins = createStudioPlugins({ getService: name => name === 'pluginManager' ? manager : null, pluginIndex });
  const listed = await plugins.listDsh();
  assert.equal(listed.catalog.source, 'builtin+remote');
  const entry = listed.items.find(item => item.pluginId === 'community-plugin');
  assert.ok(entry);
  assert.equal(entry.displayName, 'Community');
  assert.equal(entry.category, '界面');
  assert.equal(entry.installSpec, 'community-plugin@1.0.0');
  assert.equal(entry.status, 'available');
  assert.equal(entry.verification.state, 'not-installed');
  const result = await plugins.installDsh(entry.installSpec);
  assert.equal(installedSpec, 'community-plugin@1.0.0');
  assert.equal(result.verification.state, 'loaded');
  assert.equal((await plugins.refreshDshCatalog()).catalog.source, 'builtin');
});
