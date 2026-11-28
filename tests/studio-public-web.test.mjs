import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudioPublicSearch, createStudioWebTools } from '../src/providers/studio-public-web.mjs';

function assertAnonymous(init) {
  assert.equal(init.credentials, 'omit');
  assert.equal(init.redirect, 'error');
  const headers = new Headers(init.headers);
  for (const name of ['authorization', 'x-api-key', 'cookie', 'proxy-authorization']) assert.equal(headers.has(name), false);
}

test('default search sends keywords to a public service without model or search credentials', async () => {
  const methods = [];
  const search = createStudioPublicSearch({ fetchImpl: async (url, init) => {
    assert.equal(new URL(url).href, 'https://mcp.exa.ai/mcp?tools=web_search_exa');
    assertAnonymous(init);
    if (init.method === 'GET') return new Response(null, { status: 405 });
    const body = JSON.parse(init.body);
    methods.push(body.method);
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id, result: {
      protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' },
    } });
    assert.equal(body.method, 'tools/call');
    assert.deepEqual(body.params, { name: 'web_search_exa', arguments: { query: 'reserved domains', numResults: 2 } });
    return Response.json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text',
      text: ['Title: IANA\nURL: https://www.iana.org/domains/reserved\nPublished: N/A\nHighlights:\nExample domains',
        'Title: duplicate\nURL: https://www.iana.org/domains/reserved',
        'Title: credentialed URL\nURL: https://user:password@example.com/',
        'Title: N/A\nURL: https://example.com'].join('\n\n') }] } });
  } });
  assert.deepEqual(await search(' reserved domains ', 2), { truncated: false, sources: [
    { title: 'IANA', url: 'https://www.iana.org/domains/reserved', snippet: 'Example domains' },
    { title: 'example.com', url: 'https://example.com/' },
  ] });
  assert.deepEqual(methods, ['initialize', 'notifications/initialized', 'tools/call']);
});

test('Studio can reuse an anonymously accessible search URL without contacting the default service', async () => {
  const search = createStudioPublicSearch({ endpoint: () => 'https://search.example.com/query', fetchImpl: async (url, init) => {
    assertAnonymous(init);
    assert.equal(init.method, 'GET');
    assert.equal(url, 'https://search.example.com/query?q=fixture&max_results=5');
    return Response.json({ results: [{ title: 'Example', url: 'https://example.com/' }] });
  } });
  const tools = createStudioWebTools(search, async url => ({ ok: true, url, text: 'Public content' }));
  assert.deepEqual(tools.specs.map(tool => tool.name), ['studio_web_search', 'studio_web_fetch']);
  const fetch = JSON.parse(await tools.handler({ name: 'studio_web_fetch', arguments: { url: 'https://example.com/' } }));
  assert.equal(fetch.text, 'Public content');
  const query = JSON.parse(await tools.handler({ name: 'studio_web_search', arguments: { query: 'fixture' } }));
  assert.equal(query.sources[0].title, 'Example');
  assert.equal(await tools.handler({ name: 'other_tool' }), undefined);
});

test('a rate-limited anonymous search produces a tool error without a credentialed retry', async () => {
  let requests = 0;
  const search = createStudioPublicSearch({ fetchImpl: async (_, init) => {
    assertAnonymous(init);
    requests += 1;
    return new Response('Too Many Requests', { status: 429 });
  } });
  const tools = createStudioWebTools(search);
  await assert.rejects(tools.handler({ name: 'studio_web_search', arguments: { query: 'fixture' } }),
    { code: 'web_search_rate_limited' });
  assert.equal(requests, 1);
});
