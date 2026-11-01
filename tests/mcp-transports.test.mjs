import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createLocalResourceAdapters } from '../src/local-resource-adapters.mjs';

test('stdio uses exact argv, resolves current Host credentials and reconnects after credential rotation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-mcp-stdio-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, 'server with spaces.mjs');
  await writeFile(script, `import { Server } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/index.js'))};
import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js'))};
import { ListToolsRequestSchema, CallToolRequestSchema } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/types.js'))};
const server = new Server({ name: 'stdio-fixture', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'read_fixture', inputSchema: { type: 'object' } }] }));
server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: [process.env.STUDIO_FIXTURE_TOKEN, process.argv[2], process.env.STUDIO_PARENT_SECRET || 'isolated'].join('|') }], structuredContent: { transport: 'stdio' } }));
await server.connect(new StdioServerTransport());`);
  let value = 'fixture-one';
  const adapters = createLocalResourceAdapters({ credentials: { resolve: async () => ({ value }) } }); t.after(() => adapters.close());
  const binding = { resourceId: 'stdio-fixture', server: { transport: 'stdio', command: process.execPath, args: [script, 'exact argument with spaces'], envRefs: { STUDIO_FIXTURE_TOKEN: 'env://FIXTURE' } } };
  assert.equal((await adapters.listMcpTools(binding))[0].name, 'read_fixture');
  assert.equal((await adapters.callMcpTool(binding, 'read_fixture'))[0].text, 'fixture-one|exact argument with spaces|isolated');
  assert.deepEqual((await adapters.callMcpTool(binding, 'read_fixture', {}, { resultFormat: 'mcp-result/v1' })).structuredContent,
    { transport: 'stdio' });
  value = 'fixture-two';
  assert.equal((await adapters.callMcpTool(binding, 'read_fixture'))[0].text, 'fixture-two|exact argument with spaces|isolated');
  assert.equal((await adapters.callMcpTool(binding, 'read_fixture', {}, { resultFormat: 'mcp-result/v1' })).content[0].text,
    'fixture-two|exact argument with spaces|isolated');
});

test('legacy SSE authenticates both the event stream and message requests and invokes a real local tool', async t => {
  const connections = new Map(), seen = [];
  const http = createServer(async (req, res) => {
    seen.push([req.method, req.headers.authorization, req.headers['x-request-source']]);
    if (req.headers.authorization !== 'Bearer fixture-sse') { res.writeHead(401); res.end(); return; }
    if (req.method === 'GET' && req.url === '/sse') {
      const transport = new SSEServerTransport('/messages', res);
      const mcp = new Server({ name: 'sse-fixture', version: '1' }, { capabilities: { tools: {} } });
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }));
      mcp.setRequestHandler(CallToolRequestSchema, async request => ({ content: [{ type: 'text', text: request.params.arguments.text }],
        structuredContent: { transport: 'sse' } }));
      connections.set(transport.sessionId, { transport, mcp });
      await mcp.connect(transport);
    } else if (req.method === 'POST' && req.url.startsWith('/messages')) {
      const connection = connections.get(new URL(req.url, 'http://local').searchParams.get('sessionId'));
      await connection.transport.handlePostMessage(req, res);
    }
    else { res.writeHead(404); res.end(); }
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const adapters = createLocalResourceAdapters({ credentials: { resolve: async () => ({ value: 'fixture-sse' }) } });
  t.after(async () => { await adapters.close(); await Promise.all([...connections.values()].map(({ mcp }) => mcp.close())); http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); });
  const binding = { resourceId: 'sse-fixture', server: { transport: 'sse', endpointUrl: `http://127.0.0.1:${http.address().port}/sse`, headers: { 'x-request-source': 'studio-fixture' }, envRefs: { Authorization: 'env://FIXTURE' } } };
  assert.equal((await adapters.listMcpTools(binding))[0].name, 'echo');
  assert.equal((await adapters.callMcpTool(binding, 'echo', { text: 'actual-sse-result' }))[0].text, 'actual-sse-result');
  assert.deepEqual((await adapters.callMcpTool(binding, 'echo', { text: 'actual-sse-result' }, { resultFormat: 'mcp-result/v1' })).structuredContent,
    { transport: 'sse' });
  assert.ok(seen.some(row => row[0] === 'GET')); assert.ok(seen.some(row => row[0] === 'POST'));
  assert.ok(seen.every(row => row[1] === 'Bearer fixture-sse' && row[2] === 'studio-fixture'));
  assert.equal(connections.size, 2, 'Native and ordinary clients use separate authenticated sessions');
});
