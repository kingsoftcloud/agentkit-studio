import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createLocalConversationHandler } from '../src/local-runtime.mjs';

function responseSink() {
  return { headersSent: false, writableEnded: false, chunks: [], writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; }, write(chunk) { this.chunks.push(String(chunk)); }, end(chunk = '') { if (chunk) this.chunks.push(String(chunk)); this.writableEnded = true; } };
}

function modelFetch() {
  let call = 0;
  return async (_url, init) => {
    call += 1;
    const body = JSON.parse(init.body);
    if (call === 1) {
      assert.equal(body.tools[0].function.name, 'search');
      return new Response('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"search","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n');
    }
    assert.equal(body.messages.at(-1).role, 'tool');
    return new Response('data: {"choices":[{"delta":{"content":"工具结果已使用"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  };
}

test('local runtime executes bound MCP tools and records a local trace', async () => {
  const response = responseSink();
  const traces = [];
  const handler = createLocalConversationHandler({
    agentStore: async () => ({ get: async () => ({ spec: { instructions: { system: 'test' }, bindings: { mcpServers: [{ resourceId: 'mcp-1' }] } } }) }),
    modelService: { profile: async () => ({ baseUrl: 'http://model.test/v1', apiKey: 'secret', modelName: 'model-1' }) },
    resourceAdapter: {
      listMcpTools: async () => [{ name: 'search', description: 'Search' }],
      callMcpTool: async () => [{ type: 'text', text: 'hit' }],
    },
    observability: { syncTrace: async record => traces.push(record) },
    fetchImpl: modelFetch(),
  });
  await handler(Readable.from([JSON.stringify({ agentId: 'ar-local-aaaaaaaaaaaaaaaa', sessionId: 's-1', input: '查一下' })]), response);
  const output = response.chunks.join('');
  assert.equal(response.status, 200);
  assert.match(output, /tool_call/);
  assert.match(output, /工具结果已使用/);
  assert.match(output, /run.completed/);
  assert.equal(traces[0].status, 'completed');
});

test('local runtime rejects resource-bound agents when the adapter is unavailable', async () => {
  const response = responseSink();
  const handler = createLocalConversationHandler({
    agentStore: async () => ({ get: async () => ({ spec: { bindings: { skills: ['skill-x'] } } }) }),
    modelService: { profile: async () => ({}) },
  });
  await handler(Readable.from([JSON.stringify({ agentId: 'ar-local-aaaaaaaaaaaaaaaa', input: 'run' })]), response);
  assert.equal(response.status, 409);
  assert.match(response.chunks.join(''), /RESOURCE_ADAPTER_MISSING/);
});
