import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createPluginMarket,
  marketItemFromEntry,
  PLUGIN_MARKET_INDEX_PATH,
  PluginMarketUnavailableError,
} from '../src/plugin-market.mjs';

const entry = (name, extra = {}) => ({
  name,
  title: { en: name, zh: `${name} 中文名` },
  description: { en: 'desc', zh: '描述' },
  author: 'Author',
  homepage: 'https://example.com/plugin',
  repository: { url: 'https://github.com/acme/plugin', directory: 'packages/plugin' },
  metadata: { category: '工具', labels: ['效率'], keywords: ['dsh-plugin'], sortKeys: { downloads: 12345 } },
  defaultVersion: '1.2.0',
  versions: [
    { version: '1.2.0', install: { target: `${name}@1.2.0` }, compatibility: { compatible: true } },
    { version: '1.0.0', install: { target: `${name}@1.0.0` }, compatibility: { compatible: false, runtimeVersion: '0.2.2', requirements: { 'engines.dsh': '>=0.3.0' }, exempted: false } },
  ],
  installation: { status: 'not-installed' },
  ...extra,
});

function fakeService({ indexes = [], search = async () => ({ entries: [], total: 0, title: { zh: '索引' } }) } = {}) {
  const calls = { setIndexes: [], search: [] };
  const service = {
    listIndexes: () => indexes,
    setIndexes: async urls => { calls.setIndexes.push(urls); indexes = urls.map(url => ({ url })); },
    search: async (url, query) => { calls.search.push([url, query]); return search(url, query); },
  };
  return { service, calls };
}

function adapter(fake, options = {}) {
  return createPluginMarket({
    getService: name => name === 'pluginMarket' ? fake.service : name === 'webServer' ? { origin: 'http://127.0.0.1:8789' } : null,
    ...options,
  });
}

test('one official entry maps onto a Studio card', () => {
  const item = marketItemFromEntry(entry('@acme/dsh-tool'), { indexUrl: 'https://index.example/index.json', indexTitle: '社区索引' });
  assert.equal(item.id, '@acme/dsh-tool');
  assert.equal(item.displayName, '@acme/dsh-tool 中文名');
  assert.equal(item.description, '描述');
  assert.equal(item.version, '1.2.0');
  assert.equal(item.installSpec, '@acme/dsh-tool@1.2.0');
  assert.equal(item.source, 'index');
  assert.equal(item.category, '工具');
  assert.deepEqual(item.tags, ['效率']);
  assert.equal(item.stats.monthlyDownloads, 12345);
  assert.equal(item.installed, false);
  assert.equal(item.enabled, false);
  assert.equal(item.repository, 'https://github.com/acme/plugin');
  assert.equal(item.versions.length, 2);
  assert.equal(item.versions[0].compatible, true);
  assert.equal(item.versions[1].compatible, false);
  assert.equal(item.index.title, '社区索引');
  assert.equal(marketItemFromEntry(null), null);
  assert.equal(marketItemFromEntry({ name: '' }), null);
});

test('installed and update-available entries carry local state', () => {
  const installed = marketItemFromEntry(entry('dsh-a', { installation: { status: 'installed', installedVersion: '1.2.0' } }));
  assert.equal(installed.installed, true);
  assert.equal(installed.enabled, true);
  assert.equal(installed.installedVersion, '1.2.0');
  const updating = marketItemFromEntry(entry('dsh-b', { installation: { status: 'update-available', installedVersion: '1.0.0' } }));
  assert.equal(updating.installed, true);
  assert.equal(updating.updateAvailable, true);
});

test('discovery reads every configured index source', async () => {
  const fake = fakeService({
    indexes: [{ url: 'https://a.example/index.json', title: { zh: 'A 源' } }, { url: 'https://b.example/index.json' }],
    search: async url => ({ entries: url.includes('a.example') ? [entry('dsh-a')] : [entry('dsh-b'), entry('dsh-a')], total: 1, title: { zh: '源' } }),
  });
  const result = await adapter(fake).discover();
  assert.deepEqual(result.items.map(item => item.id), ['dsh-a', 'dsh-b']);
  assert.equal(result.info.source, 'plugin-market');
  assert.equal(result.info.indexes.length, 2);
  assert.equal(fake.calls.search.length, 2);
  assert.equal(fake.calls.search[0][1].limit, 100);
});

test('an index source that refuses the request becomes a warning', async () => {
  const fake = fakeService({
    indexes: [{ url: 'https://a.example/index.json' }, { url: 'https://b.example/index.json' }],
    search: async url => {
      if (url.includes('a.example')) throw new Error('HTTP 503');
      return { entries: [entry('dsh-b')], total: 1 };
    },
  });
  const result = await adapter(fake).discover();
  assert.deepEqual(result.items.map(item => item.id), ['dsh-b']);
  assert.equal(result.info.warnings[0].code, 'index');
});

test('the bundled community index is seeded when the profile has no source', async () => {
  const fake = fakeService({
    search: async () => ({ entries: [entry('dsh-bundled')], total: 1 }),
  });
  const result = await adapter(fake).discover();
  assert.deepEqual(fake.calls.setIndexes, [['http://127.0.0.1:8789' + PLUGIN_MARKET_INDEX_PATH]]);
  assert.deepEqual(result.items.map(item => item.id), ['dsh-bundled']);
});

test('a missing official service is reported as unavailable', async () => {
  const market = createPluginMarket({ getService: () => null });
  await assert.rejects(() => market.discover(), PluginMarketUnavailableError);
  const status = await market.status();
  assert.equal(status.available, false);
});

test('every refused source reports unavailable instead of an empty market', async () => {
  const fake = fakeService({ indexes: [{ url: 'https://a.example/index.json', error: 'HTTP 404' }] });
  const market = createPluginMarket({ getService: name => name === 'pluginMarket' ? fake.service : name === 'webServer' ? { origin: 'http://127.0.0.1:8789' } : null });
  await assert.rejects(() => market.discover(), /插件索引源不可用/u);
});

test('the bundled index document is read once and cached', async () => {
  let reads = 0;
  const market = createPluginMarket({
    getService: () => null,
    readIndexFile: async () => { reads += 1; return JSON.stringify({ format: 1, plugins: [] }); },
  });
  assert.deepEqual(await market.readBuiltinDocument(), { format: 1, plugins: [] });
  await market.readBuiltinDocument();
  assert.equal(reads, 1);
  const broken = createPluginMarket({ getService: () => null, readIndexFile: async () => '{' });
  await assert.rejects(() => broken.readBuiltinDocument(), PluginMarketUnavailableError);
});

test('status reports the configured sources', async () => {
  const fake = fakeService({ indexes: [{ url: 'https://a.example/index.json', title: { zh: 'A' } }] });
  const status = await adapter(fake).status();
  assert.equal(status.available, true);
  assert.equal(status.indexes.length, 1);
  assert.equal(status.builtinIndexUrl, 'http://127.0.0.1:8789' + PLUGIN_MARKET_INDEX_PATH);
});
