/**
 * Regression: custom-header MCP authentication must pass through verbatim.
 *
 * Host-owned MCP records may reference a non-Bearer header such as
 * `X-Service-Token` through `server.envRefs`. The value is resolved by the Host
 * credentials service, sent raw (never reshaped into an Authorization
 * header / Bearer token), and never persisted by the local MCP store.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createLocalResourceAdapters, resolveMcpConnection } from '../src/local-resource-adapters.mjs';
import { createLocalMcpStore } from '../src/local-mcp-store.mjs';

const SECRET = 'fixture-token-value';
// Only a unit-test placeholder: resolveMcpConnection never dials the endpoint.
const UNIT_ENDPOINT = 'http://127.0.0.1:1/mcp';

test('resolveMcpConnection sends a custom envRefs header raw and never synthesizes Authorization', async () => {
  const looked = [];
  const credentials = { resolve: async name => { looked.push(name); return { value: SECRET }; } };
  const connection = await resolveMcpConnection({
    resourceId: 'custom-header-unit',
    endpoint: UNIT_ENDPOINT,
    headers: { 'x-request-source': 'studio-fixture' },
    envRefs: { 'X-Service-Token': 'env://SERVICE_TOKEN' },
  }, credentials);
  assert.deepEqual(connection, {
    resourceId: 'custom-header-unit',
    endpoint: UNIT_ENDPOINT,
    headers: { 'x-request-source': 'studio-fixture', 'X-Service-Token': SECRET },
  });
  assert.equal(Object.keys(connection.headers).some(name => name.toLowerCase() === 'authorization'), false);
  assert.ok(!connection.headers['X-Service-Token'].startsWith('Bearer '));
  assert.deepEqual(looked, ['SERVICE_TOKEN'], 'env:// prefix is stripped before asking the credentials service');
});

test('Authorization envRefs gets a Bearer prefix only when the resolved value has no auth scheme', async () => {
  const resolveWith = value => resolveMcpConnection({
    resourceId: 'authorization-unit',
    endpoint: UNIT_ENDPOINT,
    envRefs: { Authorization: 'env://SERVICE_TOKEN' },
  }, { resolve: async () => ({ value }) });
  assert.deepEqual((await resolveWith(SECRET)).headers, { Authorization: `Bearer ${SECRET}` });
  assert.deepEqual((await resolveWith('Basic dXNlcjpwYXNz')).headers, { Authorization: 'Basic dXNlcjpwYXNz' });
  assert.deepEqual((await resolveWith('Bearer already-schemed')).headers, { Authorization: 'Bearer already-schemed' });
  // A custom header is never prefixed, even when its value would look Bearer-able.
  assert.deepEqual((await resolveMcpConnection({
    resourceId: 'custom-header-unit',
    endpoint: UNIT_ENDPOINT,
    envRefs: { 'X-Service-Token': 'env://SERVICE_TOKEN' },
  }, { resolve: async () => ({ value: SECRET }) })).headers, { 'X-Service-Token': SECRET });
});

test('a missing custom-header credential fails closed instead of connecting unauthenticated', async () => {
  await assert.rejects(resolveMcpConnection({
    resourceId: 'custom-header-missing',
    endpoint: UNIT_ENDPOINT,
    envRefs: { 'X-Service-Token': 'env://MISSING_TOKEN' },
  }, { resolve: async () => ({ value: '' }) }, {}), error => {
    assert.equal(error.code, 'MCP_CREDENTIAL_MISSING');
    assert.equal(error.details.header, 'X-Service-Token');
    return true;
  });
});

test('a real loopback StreamableHTTP MCP sees the raw custom header on every request and no Authorization', async t => {
  const toolName = 'custom_header_probe';
  const receipt = `CUSTOM_HEADER_${randomUUID()}`;
  const seen = [];
  const sessions = new Map();
  const servers = new Set();
  const mcp = () => {
    const server = new Server({ name: 'custom-header-fixture', version: '1' }, { capabilities: { tools: {} } });
    servers.add(server);
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: toolName, description: 'Custom header fixture tool', inputSchema: { type: 'object', properties: {} } }],
    }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: receipt }] }));
    return server;
  };
  const http = createServer(async (req, res) => {
    // Record exactly what reached the wire before enforcing authentication.
    const request = { method: req.method, token: req.headers['x-service-token'], authorization: req.headers.authorization };
    seen.push(request);
    try {
      if (request.token !== SECRET) { res.writeHead(401).end(); return; }
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/mcp') { res.writeHead(404).end(); return; }
      let body;
      if (req.method === 'POST') {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        body = raw ? JSON.parse(raw) : undefined;
        if (body?.method) request.rpc = body.method;
      }
      let stream = sessions.get(req.headers['mcp-session-id']);
      if (!stream && req.method === 'POST' && body?.method === 'initialize') {
        stream = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID,
          onsessioninitialized: id => { sessions.set(id, stream); } });
        await mcp().connect(stream);
      }
      if (!stream) { res.writeHead(404).end(); return; }
      return await stream.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) res.writeHead(500).end(); else res.destroy();
    }
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const endpointUrl = `http://127.0.0.1:${http.address().port}/mcp`;
  const adapters = createLocalResourceAdapters({ credentials: { resolve: async () => ({ value: SECRET }) } });
  t.after(async () => {
    await adapters.close();
    await Promise.allSettled([...servers].map(server => server.close()));
    http.closeAllConnections();
    await new Promise(resolve => http.close(resolve));
  });

  const binding = { resourceId: 'custom-header-http', server: {
    transport: 'http', endpointUrl, envRefs: { 'X-Service-Token': 'env://SERVICE_TOKEN' } } };
  assert.deepEqual((await adapters.listMcpTools(binding)).map(tool => tool.name), [toolName]);
  assert.equal((await adapters.callMcpTool(binding, toolName))[0].text, receipt);

  assert.ok(seen.length >= 2, `fixture server observed ${seen.length} request(s)`);
  assert.ok(seen.some(request => request.rpc === 'initialize'), 'client initialized a real MCP session');
  assert.ok(seen.some(request => request.rpc === 'tools/list'), 'client listed tools');
  assert.ok(seen.some(request => request.rpc === 'tools/call'), 'client invoked the fixture tool');
  assert.deepEqual([...new Set(seen.map(request => request.token))], [SECRET],
    'every request carried exactly the raw credential value');
  assert.ok(seen.every(request => request.token === SECRET), 'no request used a Bearer-prefixed token');
  assert.ok(seen.every(request => request.authorization === undefined), 'no Authorization header was ever synthesized');
  assert.equal(sessions.size, 1, 'the fixture negotiated one authenticated MCP session');
});

test('local MCP store rejects literal custom headers but persists env:// references without the secret', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-mcp-custom-header-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createLocalMcpStore({ storeDir: directory });
  const endpointUrl = 'http://127.0.0.1:1/mcp';
  const base = { name: 'custom-header-fixture', displayName: 'Custom header fixture' };
  for (const headers of [
    { 'X-Service-Token': SECRET },
    { Authorization: `Bearer ${SECRET}` },
    // Even an allowlisted header name must use an env:// reference, not interpolation.
    { 'x-request-source': '${SERVICE_TOKEN}' },
  ]) {
    await assert.rejects(store.create({ ...base, server: { name: base.name, transport: 'http', endpointUrl, headers } }),
      error => { assert.equal(error.code, 'MCP_HEADER_REQUIRES_REFERENCE'); return true; });
  }
  assert.deepEqual(await readdir(directory).catch(() => []), [], 'rejected declarations must not be written to disk');

  const record = await store.create({ ...base, server: {
    name: base.name, transport: 'http', endpointUrl,
    headers: { 'x-request-source': 'studio-fixture' },
    envRefs: { 'X-Service-Token': 'env://SERVICE_TOKEN' },
  } });
  assert.match(record.resourceId, /^mcp-local-[a-f0-9]{16}$/);
  const names = (await readdir(directory)).filter(name => name.endsWith('.json'));
  assert.deepEqual(names, [`${record.resourceId}.json`]);
  const contents = await readFile(join(directory, names[0]), 'utf8');
  assert.ok(!contents.includes(SECRET), 'the credential value must never reach the public record');
  assert.ok(!contents.includes('Bearer'), 'no synthesized Authorization material may be persisted');
  const persisted = JSON.parse(contents);
  assert.deepEqual(persisted.server.headers, { 'x-request-source': 'studio-fixture' });
  assert.deepEqual(persisted.server.envRefs, { 'X-Service-Token': 'env://SERVICE_TOKEN' });
  assert.equal(Object.keys(persisted.server).some(name => name.toLowerCase() === 'authorization'), false);
  assert.deepEqual((await store.get(record.resourceId)).server.envRefs, { 'X-Service-Token': 'env://SERVICE_TOKEN' });
});
