import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReadBuffer, deserializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as shipped from '../dist/native-mcp-client.mjs';
import { createLocalResourceAdapters } from '../src/local-resource-adapters.mjs';
import { MCP_JSON_PARSER_CONTRACT, NATIVE_MCP_JSON_CODEC, nativeMcpJsonParser, nativeMcpSchemaValidator } from '../src/providers/native-mcp-json.mjs';

const integer = 9007199254740993n;
const rawContent = '{"id":9007199254740993,"float":9007199254740992.0,"zero":-0.0,"ordinary":7,"wrapper":{"$bigint":"9007199254740993"}}';
const rawTool = '{"name":"exact","inputSchema":{"type":"object","properties":{"id":{"type":"integer","minimum":9007199254740993}}},"outputSchema":{"type":"object","required":["id"],"properties":{"id":{"type":"integer","minimum":9007199254740993,"maximum":9007199254740993}}}}';
const resultJson = `{"content":[{"type":"text","text":"exact"}],"structuredContent":${rawContent}}`;
function reply(message) {
  let result;
  if (message.method === 'initialize') result = JSON.stringify({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'raw-json', version: '1' } });
  else if (message.method === 'tools/list') result = `{"tools":[${rawTool}]}`;
  else if (message.method === 'tools/call') result = message.params.arguments.invalid
    ? resultJson.replace('"id":9007199254740993', '"id":9007199254740992') : resultJson;
  else throw Error(`Unexpected method: ${message.method}`);
  return `{"jsonrpc":"2.0","id":${JSON.stringify(message.id)},"result":${result}}`;
}
function assertExact(value) {
  assert.equal(value.id, integer);
  assert.equal(typeof value.float, 'number');
  assert.equal(value.float, 9007199254740992);
  assert.ok(Object.is(value.zero, -0));
  assert.equal(value.ordinary, 7);
  assert.deepEqual(value.wrapper, { $bigint: '9007199254740993' });
}

test('ESM and CJS parser hooks preserve protocol validation, fragments and the standard default', () => {
  const require = createRequire(import.meta.url);
  const cjs = require('@modelcontextprotocol/sdk/shared/stdio.js');
  const constructors = [StdioClientTransport, SSEClientTransport, StreamableHTTPClientTransport,
    require('@modelcontextprotocol/sdk/client/stdio.js').StdioClientTransport,
    require('@modelcontextprotocol/sdk/client/sse.js').SSEClientTransport,
    require('@modelcontextprotocol/sdk/client/streamableHttp.js').StreamableHTTPClientTransport];
  for (const Transport of constructors) assert.equal(Transport.jsonParserContract, MCP_JSON_PARSER_CONTRACT);
  for (const name of ['StdioClientTransport', 'SSEClientTransport', 'StreamableHTTPClientTransport']) {
    assert.equal(shipped[name].jsonParserContract, MCP_JSON_PARSER_CONTRACT);
  }
  const raw = reply({ id: 1, method: 'tools/call', params: { arguments: {} } });
  for (const api of [{ ReadBuffer, deserializeMessage }, cjs]) {
    assert.equal(api.deserializeMessage(raw).result.structuredContent.id, Number(integer));
    assertExact(api.deserializeMessage(raw, nativeMcpJsonParser).result.structuredContent);
    const buffer = new api.ReadBuffer({ jsonParser: nativeMcpJsonParser });
    const bytes = Buffer.from(raw + '\r\n');
    buffer.append(bytes.subarray(0, 73)); assert.equal(buffer.readMessage(), null);
    buffer.append(bytes.subarray(73)); assertExact(buffer.readMessage().result.structuredContent);
    assert.throws(() => new api.ReadBuffer({ jsonParser: 'not a parser' }), TypeError);
    assert.throws(() => api.deserializeMessage('{"jsonrpc":"1.0","id":1,"result":{}}', nativeMcpJsonParser));
    assert.throws(() => api.deserializeMessage('{"jsonrpc":"2.0","id":1,"result":{"a":1,"a":2}}', nativeMcpJsonParser), /duplicate_model_json_key/);
    const bounded = new api.ReadBuffer({ maxBufferSize: 8, jsonParser: nativeMcpJsonParser });
    assert.throws(() => bounded.append(Buffer.from('123456789')), /buffer/i);
  }
});

test('Native output-schema validation compares unsafe integer limits exactly', () => {
  const schema = nativeMcpJsonParser(rawTool).outputSchema;
  const validate = nativeMcpSchemaValidator.getValidator(schema);
  const exact = nativeMcpJsonParser(rawContent);
  assert.deepEqual(validate(exact), { valid: true, data: exact, errorMessage: undefined });
  assert.equal(validate({ id: integer - 1n }).valid, false);
  assert.equal(validate({ id: integer + 1n }).valid, false);
  assert.equal(validate({ id: { $bigint: String(integer) } }).valid, false);
  assert.throws(() => nativeMcpSchemaValidator.getValidator({ $ref: 'https://external.test/schema' }), /external_tool_schema_reference/);
});

for (const mode of ['stdio', 'http-json', 'http-sse', 'sse']) test(`Native MCP reads exact numeric results and output schemas through actual ${mode}`, { timeout: 15000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'native-mcp-json-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const adapters = createLocalResourceAdapters();
  let binding, initializations = 0;
  if (mode === 'stdio') {
    const script = join(directory, 'raw server.mjs');
    await writeFile(script, `import {createInterface} from 'node:readline';
const rawTool=${JSON.stringify(rawTool)}, resultJson=${JSON.stringify(resultJson)};
const reply=${reply.toString()};
for await(const line of createInterface({input:process.stdin})) {
  const message=JSON.parse(line); if(message.id===undefined) continue;
  const raw=reply(message)+'\\n'; process.stdout.write(raw.slice(0,73)); process.stdout.write(raw.slice(73));
}`);
    binding = { resourceId: 'raw', server: { transport: 'stdio', command: process.execPath, args: [script] } };
    t.after(() => adapters.close());
  } else {
    const channels = new Map(); let nextChannel = 0;
    const server = createServer(async (request, response) => {
      if (mode === 'sse' && request.method === 'GET') {
        const channel = String(++nextChannel); channels.set(channel, response);
        request.on('close', () => channels.delete(channel));
        response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' });
        response.write(`event: endpoint\ndata: /send?channel=${channel}\n\n`); return;
      }
      if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
      let body = ''; for await (const chunk of request) body += chunk;
      const message = JSON.parse(body);
      if (message.id === undefined) { response.writeHead(202); response.end(); return; }
      if (message.method === 'initialize') initializations++;
      const raw = reply(message);
      if (mode === 'sse') {
        const channel = new URL(request.url, 'http://local').searchParams.get('channel');
        const stream = channels.get(channel);
        stream.write(`event: message\ndata: ${raw.slice(0, 73)}`); stream.write(raw.slice(73) + '\n\n');
        response.writeHead(202); response.end();
      } else if (mode === 'http-sse') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(`event: message\ndata: ${raw.slice(0, 73)}`); response.end(raw.slice(73) + '\n\n');
      } else {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.write(raw.slice(0, 73)); response.end(raw.slice(73));
      }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    binding = { resourceId: 'raw', server: { transport: mode === 'sse' ? 'sse' : 'http', endpointUrl: `http://127.0.0.1:${server.address().port}/mcp` } };
    t.after(async () => { await adapters.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  }
  const ordinary = await adapters.listMcpTools(binding);
  assert.equal(ordinary[0].inputSchema.properties.id.minimum, Number(integer));
  const tools = await adapters.listMcpTools(binding, { jsonCodec: NATIVE_MCP_JSON_CODEC });
  assert.equal(tools[0].inputSchema.properties.id.minimum, integer);
  assert.equal(tools[0].outputSchema.properties.id.maximum, integer);
  assertExact((await adapters.callMcpTool(binding, 'exact', {}, { resultFormat: 'mcp-result/v1' })).structuredContent);
  assert.deepEqual(await adapters.callMcpTool(binding, 'exact'), [{ type: 'text', text: 'exact' }]);
  assertExact((await adapters.callMcpTool(binding, 'exact', {}, { resultFormat: 'mcp-result/v1' })).structuredContent);
  if (mode !== 'stdio') assert.equal(initializations, 2, 'ordinary and Native connections are independently reused');
  const snapshot = await adapters.listMcpTools(binding, { jsonCodec: NATIVE_MCP_JSON_CODEC, snapshot: true });
  assert.equal(snapshot[0].inputSchema.properties.id.minimum, integer);
  assertExact((await adapters.callMcpTool(binding, 'exact', {}, { resultFormat: 'mcp-result/v1' })).structuredContent);
  if (mode !== 'stdio') assert.equal(initializations, 3, 'catalog snapshots cannot close either active caller');
  await assert.rejects(adapters.callMcpTool(binding, 'exact', { invalid: true }, { resultFormat: 'mcp-result/v1' }),
    error => error.code === 'MCP_TOOL_FAILED' && /output schema/.test(error.details.cause));
  await assert.rejects(adapters.listMcpTools(binding, { jsonCodec: 'unknown' }), { code: 'MCP_JSON_CODEC_INVALID' });
  await assert.rejects(adapters.listMcpTools(binding, { snapshot: 'yes' }), { code: 'MCP_SNAPSHOT_INVALID' });
});
