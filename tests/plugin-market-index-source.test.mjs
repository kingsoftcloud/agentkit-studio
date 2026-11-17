import test from 'node:test';
import assert from 'node:assert/strict';

import { createPluginMarketIndexSource, PLUGIN_MARKET_INDEX_PATH } from '../src/plugin-market.mjs';

const DOCUMENT = JSON.stringify({ format: 1, title: { en: 'Community' }, plugins: [] });

function adapter({ indexes = [], setIndexes, origin = 'http://127.0.0.1:8789' } = {}) {
  const calls = [];
  const market = {
    listIndexes: () => indexes,
    setIndexes: async urls => { calls.push(urls); if (setIndexes) await setIndexes(urls); indexes = urls.map(url => ({ url })); },
  };
  return {
    calls,
    source: createPluginMarketIndexSource({
      getService: name => name === 'pluginMarket' ? market : name === 'webServer' ? (origin === null ? undefined : { origin }) : undefined,
      readIndexFile: async () => DOCUMENT,
    }),
  };
}

test('the bundled index is served from a stable public path', () => {
  assert.equal(PLUGIN_MARKET_INDEX_PATH, '/api/agentkit.plugin-market/index.json');
});

test('a profile without an index source gets the bundled community index', async () => {
  const { calls, source } = adapter();
  const result = await source.ensureIndexSource();
  assert.deepEqual(calls, [['http://127.0.0.1:8789' + PLUGIN_MARKET_INDEX_PATH]]);
  assert.equal(result.seeded, true);
  assert.equal(result.url, 'http://127.0.0.1:8789' + PLUGIN_MARKET_INDEX_PATH);
});

test('a profile with a configured source is left alone', async () => {
  const { calls, source } = adapter({ indexes: [{ url: 'https://market.example/index.json' }] });
  const result = await source.ensureIndexSource();
  assert.equal(result.seeded, false);
  assert.equal(result.reason, 'already-configured');
  assert.deepEqual(calls, []);
});

test('an unmounted official service, an unknown origin and a refused write are reported, never thrown', async () => {
  const missing = createPluginMarketIndexSource({ getService: () => undefined, readIndexFile: async () => DOCUMENT });
  assert.equal((await missing.ensureIndexSource()).reason, 'plugin-market-unavailable');

  const noOrigin = adapter({ origin: null });
  assert.equal((await noOrigin.source.ensureIndexSource()).reason, 'index-url-unavailable');

  const refused = adapter({ setIndexes: async () => { throw new Error('plugin-market/settings-unavailable'); } });
  const result = await refused.source.ensureIndexSource();
  assert.equal(result.seeded, false);
  assert.equal(result.reason, 'settings-unavailable');
  assert.match(result.message, /settings-unavailable/u);
});

test('the bundled document is read once and cached', async () => {
  let reads = 0;
  const source = createPluginMarketIndexSource({
    getService: () => undefined,
    readIndexFile: async () => { reads += 1; return DOCUMENT; },
  });
  assert.deepEqual(await source.readBuiltinDocument(), JSON.parse(DOCUMENT));
  await source.readBuiltinDocument();
  assert.equal(reads, 1);
  const broken = createPluginMarketIndexSource({ getService: () => undefined, readIndexFile: async () => '{' });
  await assert.rejects(() => broken.readBuiltinDocument(), { code: 'PLUGIN_MARKET_UNAVAILABLE' });
});
