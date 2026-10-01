import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createLocalConversationHandler } from '../src/local-runtime.mjs';

const frame = (value, newline = '\n') => `data: ${JSON.stringify(value)}${newline}${newline}`;
const reply = (delta, finish_reason = 'stop') => ({ choices: [{ delta, finish_reason }] });
const toolCall = index => reply({ tool_calls: [{ index: 0, id: `call-${index}`, function: { name: 'search', arguments: '{}' } }] }, 'tool_calls');

function fragmentedResponse(value) {
  const bytes = new TextEncoder().encode(value);
  return new Response(new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7));
      controller.close();
    },
  }));
}

async function run(fetchImpl, { execution, memory = false } = {}) {
  const traces = [];
  const calls = [];
  let writes = 0;
  const response = {
    chunks: [], writeHead(status) { this.status = status; },
    write(chunk) { this.chunks.push(String(chunk)); },
    end(chunk = '') { this.chunks.push(String(chunk)); this.writableEnded = true; },
  };
  const handler = createLocalConversationHandler({
    agentStore: async () => ({ get: async () => ({ spec: {
      execution, memory: { enabled: memory, write: { mode: 'candidate' } },
      bindings: { mcpServers: ['mcp-search'], ...(memory ? { plugins: [{ config: { binding: { resource: { kind: 'memory-instance', id: 'memory-1' } } } }] } : {}) },
    } }) }),
    modelService: { profile: async () => ({ baseUrl: 'http://model.test/v1', apiKey: 'test-only', modelName: 'model-1' }) },
    resourceAdapter: {
      listMcpTools: async () => [{ name: 'search' }],
      callMcpTool: async (...args) => { calls.push(args); return [{ type: 'text', text: '搜索结果' }]; },
      searchMemory: async () => [],
      writeMemory: async () => { writes += 1; return { accepted: true }; },
    },
    observability: { syncTrace: async trace => traces.push(trace) },
    fetchImpl,
  });
  await handler(Readable.from([JSON.stringify({ agentId: 'ar-local-aaaaaaaaaaaaaaaa', input: '先搜索再回答' })]), response);
  return { output: response.chunks.join(''), traces, calls, writes };
}

test('CRLF model frames stream reasoning and text while executing fragmented MCP calls', async () => {
  let requests = 0;
  const result = await run(async () => {
    requests += 1;
    return requests === 1
      ? fragmentedResponse(frame(reply({ reasoning_content: '先核验来源' }, null), '\r\n') + frame(toolCall(1), '\r\n') + 'data: [DONE]\r\n\r\n')
      : fragmentedResponse(frame(reply({ content: '已检索并确认' }), '\r\n') + 'data: [DONE]\r\n\r\n');
  });
  assert.equal(result.calls.length, 1);
  assert.match(result.output, /先核验来源/);
  assert.match(result.output, /已检索并确认/);
  assert.equal(result.traces[0].status, 'completed');
});

test('MCP continuation retains intermediate assistant text and reasoning in model history', async () => {
  let requests = 0;
  await run(async (_url, init) => {
    requests += 1;
    if (requests === 1) return fragmentedResponse(frame(reply({ content: '我来搜索。', reasoning_content: '需要最新证据' }, null)) + frame(toolCall(1)));
    const assistant = JSON.parse(init.body).messages.at(-2);
    assert.equal(assistant.content, '我来搜索。');
    assert.equal(assistant.reasoning_content, '需要最新证据');
    return fragmentedResponse(frame(reply({ content: '证据已确认' })));
  });
});

test('MCP workflows continue beyond three model rounds to a final answer', async () => {
  let requests = 0;
  const result = await run(async () => {
    requests += 1;
    return fragmentedResponse(frame(requests <= 3 ? toolCall(requests) : reply({ content: '三次检索后的最终回答' })));
  });
  assert.equal(requests, 4);
  assert.equal(result.calls.length, 3);
  assert.match(result.output, /三次检索后的最终回答/);
  assert.equal(result.traces[0].status, 'completed');
});

test('exhausted Agent execution budget fails instead of completing or writing memory', async () => {
  let requests = 0;
  const result = await run(async () => fragmentedResponse(frame(toolCall(++requests))), { execution: { maxSteps: 2 }, memory: true });
  assert.equal(requests, 2);
  assert.equal(result.traces[0].status, 'failed');
  assert.match(result.output, /LOCAL_EXECUTION_LIMIT/);
  assert.doesNotMatch(result.output, /run\.completed/);
  assert.equal(result.writes, 0);
});

for (const [name, stream, code] of [
  ['truncated frame', 'data: {"choices":[', 'UPSTREAM_STREAM_TRUNCATED'],
  ['malformed event', 'data: broken-json\n\n', 'MODEL_STREAM_INVALID'],
  ['upstream error frame', frame({ error: { message: 'sensitive upstream error', code: 'capacity' } }), 'MODEL_STREAM_FAILED'],
  ['output length limit', frame(reply({ content: '部分回答' }, 'length')), 'MODEL_OUTPUT_INCOMPLETE'],
]) test(`model ${name} records failure without a successful turn or memory write`, async () => {
  const result = await run(async () => fragmentedResponse(stream), { memory: true });
  assert.equal(result.traces[0].status, 'failed');
  assert.match(result.output, new RegExp(code));
  assert.doesNotMatch(result.output, /run\.completed|sensitive upstream error/);
  assert.equal(result.writes, 0);
});
