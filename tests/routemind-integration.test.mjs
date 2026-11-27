import test from 'node:test';
import assert from 'node:assert/strict';
import { mountRouteMindModels, routeMindGateway, ROUTEMIND_PROVIDER } from '../src/host/services/routemind-models.mjs';
import { resolveStarflowWebSearch, starflowWebSearch } from '../src/providers/starflow-web-search.mjs';
import { webSearchEndpoint } from '../src/web-search-endpoint.mjs';
import { dshModelRoute } from '../src/model-route.mjs';
import { modelPresentationProvider } from '../src/model-reasoning.mjs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { routeMindOverview } from '../src/client/pages/routemind-detail.mjs';
import { registerRouteMindIntroductionRoute } from '../src/host/routes/star-harness-client.mjs';

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
  assert.deepEqual(providers[ROUTEMIND_PROVIDER].models.map(model => model.name), ['Auto', 'Auto', 'Auto', 'Auto']);
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

test('a fresh turn resolves official search from the selected route without another key or model-name fallback', async () => {
  const starflow = { id: 'starflow-flash', connectionId: 'cloud-account', modelName: 'deepseek-flash',
    baseUrl: 'http://kspmas.ksyun.com/v1', apiKey: 'starflow-fixture' };
  const deepseek = { ...starflow, id: 'deepseek-flash', connectionId: 'official', baseUrl: 'https://api.deepseek.com/v1' };
  const models = {
    settings: async () => ({ modelProfiles: [deepseek, starflow] }),
    profile: async id => {
      assert.equal(id, starflow.id);
      return starflow;
    },
  };
  assert.equal(modelPresentationProvider(starflow).name, '星流');
  assert.equal(modelPresentationProvider(deepseek).name, 'DeepSeek 官方');
  assert.equal(await resolveStarflowWebSearch(models, { provider: 'unrelated', model: starflow.modelName }), undefined);
  let calls = 0;
  const search = await resolveStarflowWebSearch(models, { provider: dshModelRoute(starflow), model: starflow.modelName }, {
    fetch: async (url, init) => {
      calls++;
      assert.equal(url, 'https://kspmas.ksyun.com/v1/chat/completions');
      assert.equal(init.headers.Authorization, 'Bearer starflow-fixture');
      assert.match(JSON.parse(init.body).messages.at(-1).content, /联网搜索/);
      return Response.json({ usage: { web_search_queries: 1 }, choices: [{ message: { content: 'Grounded.',
        annotations: [{ url_citation: { url: 'https://example.com/proof', title: 'Proof' } }] } }] });
    },
  });
  assert.equal(calls, 0);
  assert.deepEqual(await search('latest public release', 2), { content: 'Grounded.', searchCount: 1,
    sources: [{ url: 'https://example.com/proof', title: 'Proof' }] });
  assert.equal(calls, 1);
});

test('RouteMind detail serves a bundled illustration and keeps the routing explanation legible', async () => {
  let image;
  registerRouteMindIntroductionRoute({ connection: { fetch: { register: route => { image = route; } } } });
  const html = renderToStaticMarkup(routeMindOverview(createElement, { inkMuted: '#777' }, { baseURI: 'http://studio.local/' }));
  assert.match(html, /最有性价比.*响应更快、成本更低/);
  assert.match(html, /<img[^>]+routemind\.introduction\.jpg/);
  assert.match(html, /对话任务.*RouteMind 评估与路由.*选中的模型/);
  assert.doesNotMatch(html, /价格优先|质量优先/);
  const response = await image.fetch(new Request('http://studio.local' + image.path));
  assert.equal(response.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer()).slice(0, 3)], [255, 216, 255]);
});
