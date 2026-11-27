import test from 'node:test';
import assert from 'node:assert/strict';
import { mountRouteMindModels, routeMindGateway, ROUTEMIND_PROVIDER } from '../src/host/services/routemind-models.mjs';
import { starflowWebSearch } from '../src/providers/starflow-web-search.mjs';
import { webSearchEndpoint } from '../src/web-search-endpoint.mjs';

test('RouteMind activation owns an independent Auto route and removes it when disabled', async () => {
  const events = new Map(), providers = {}, keys = new Map();
  let active = false;
  const ctx = {
    on: (event, fn) => events.set(event, fn),
    effect: () => {},
    get: () => ({
      describe: () => [{ ns: 'llm-pi-ai', revision: 1, value: { providers } }],
      mutate: async (_ns, [op]) => {
        if (op.op === 'unset') delete providers[op.path[1]];
        else providers[op.path[1]] = op.value;
      },
    }),
  };
  mountRouteMindModels(ctx, { active: () => active, gateway: () => routeMindGateway({}),
    credentials: { resolve: async key => ({ value: keys.get(key) }), set: async (key, value) => keys.set(key, value) } });
  await events.get('plugin-manager/changed')();
  assert.deepEqual(providers, {});
  active = true;
  await events.get('plugin-manager/changed')();
  assert.deepEqual(providers[ROUTEMIND_PROVIDER].models.map(model => model.id), ['auto', 'auto-cost', 'auto-balance', 'auto-quality']);
  assert.equal(providers[ROUTEMIND_PROVIDER].baseURL, 'http://127.0.0.1:8787/v1');
  active = false;
  await events.get('plugin-manager/changed')();
  assert.deepEqual(providers, {});
});

test('native 星流 search reuses the model credential and requires counted search', async () => {
  const profile = { baseUrl: 'https://kspmas.ksyun.com/v1', modelName: 'deepseek-v4.1-flash-1017', apiKey: 'fixture-key' };
  let count = 1;
  const search = starflowWebSearch(profile, async (url, init) => {
    assert.equal(url, 'https://kspmas.ksyun.com/v1/chat/completions');
    assert.equal(init.headers.Authorization, 'Bearer fixture-key');
    assert.equal(init.redirect, 'error');
    assert.deepEqual(JSON.parse(init.body).tools, [{ type: 'web_search' }]);
    return Response.json({ usage: { web_search_queries: count },
      choices: [{ message: { content: 'Grounded response', citations: [{ url: 'https://example.com' }] } }] });
  });
  assert.deepEqual(await search('AgentKit', 2), { sources: [{ url: 'https://example.com/', title: 'example.com' }],
    content: 'Grounded response', searchCount: 1 });
  count = 0;
  await assert.rejects(() => search('AgentKit', 2), { code: 'starflow_search_not_performed' });
  assert.equal(starflowWebSearch({ ...profile, baseUrl: 'https://custom.test/v1' }), undefined);
});

test('custom anonymous search accepts public HTTPS and local HTTP and rejects inline credentials', () => {
  assert.equal(webSearchEndpoint('http://127.0.0.1:9090/search'), 'http://127.0.0.1:9090/search');
  assert.equal(webSearchEndpoint('https://search.example.com/query'), 'https://search.example.com/query');
  const withCredentials = new URL('https://search.example.com/query');
  withCredentials.username = 'fixture-user';
  withCredentials.password = 'fixture-password';
  assert.throws(() => webSearchEndpoint(withCredentials.href));
  withCredentials.username = '';
  withCredentials.password = '';
  withCredentials.searchParams.set('key', 'fixture-value');
  assert.throws(() => webSearchEndpoint(withCredentials.href));
});
