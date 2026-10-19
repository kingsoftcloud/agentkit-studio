import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { connect } from 'node:net';
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { createAgentEngineClient } from '../src/server-client.mjs';
import { hostFetch } from '../src/http-fetch.mjs';

test('resource POST and later model POST survive the Undici web transport in the same Host', async t => {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    requests.push({ path: request.url, body: JSON.parse(body) });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ Code: 0, RequestId: 'test-request', Data: [] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  // The fixture keeps real AWS4 Content-Length headers while routing the
  // approved inner KOP origin exclusively to this owned loopback server.
  const previous = getGlobalDispatcher();
  const dispatcher = new Agent({ connect(_options, callback) {
    const socket = connect({ host: '127.0.0.1', port: server.address().port });
    socket.once('connect', () => callback(null, socket)); socket.once('error', callback);
    return socket;
  } });
  setGlobalDispatcher(dispatcher);
  t.after(async () => { setGlobalDispatcher(previous); await dispatcher.close(); });
  const configuration = { resolve: async () => ({ values: { cloudServerUrl: 'http://kop.test', cloudAccessKey: 'synthetic-access', cloudSecretKey: 'synthetic-secret' }, sources: {} }) };
  const client = createAgentEngineClient({ configuration, innerKopUrl: 'http://kop.test' });
  await client.action('QueryMemorySdk', { Query: '新闻查询前的记忆召回' }, { apiVersion: '2025-11-14' });
  await (await hostFetch(origin + '/web-fetch', { method: 'POST', body: '{}' })).text();
  await client.action('QueryMemorySdk', { Query: '网页抓取后的记忆召回' }, { apiVersion: '2025-11-14' });
  await (await hostFetch(origin + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: '继续提问' }] }) })).text();
  assert.equal(requests.length, 4);
  assert.equal(requests[2].body.Query, '网页抓取后的记忆召回');
  assert.equal(requests[3].body.messages[0].content, '继续提问');
});
