import test from 'node:test';
import assert from 'node:assert/strict';
import { mountRouteMindModels, routeMindGateway, ROUTEMIND_PROVIDER } from '../src/host/services/routemind-models.mjs';
import { webSearchEndpoint } from '../src/web-search-endpoint.mjs';
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

test('matching model names retain their upstream supplier identity', () => {
  const profile = { modelName: 'deepseek-flash' };
  assert.equal(modelPresentationProvider({ ...profile, baseUrl: 'http://kspmas.ksyun.com/v1' }).name, '星流');
  assert.equal(modelPresentationProvider({ ...profile, baseUrl: 'https://api.deepseek.com/v1' }).name, 'DeepSeek 官方');
});

test('RouteMind detail explains Studio, AgentKit and StarFlow with a bundled product preview', async () => {
  let image;
  registerRouteMindIntroductionRoute({ connection: { fetch: { register: route => { image = route; } } } });
  const html = renderToStaticMarkup(routeMindOverview(createElement, { baseURI: 'https://studio.test/' }));
  assert.match(html, /在 Studio 选 Auto.*星流模型.*在 AgentKit 中也可接入/);
  assert.match(html, /<img[^>]+agentkit\.routemind\.auto-preview\.jpg/);
  const response = await image.fetch(new Request('https://studio.test' + image.path));
  assert.equal(response.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer()).slice(0, 3)], [255, 216, 255]);
});
