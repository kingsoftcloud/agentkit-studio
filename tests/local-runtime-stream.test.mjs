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

async function run(fetchImpl, { execution, memory = false, nativeTools = false, provider = 'ksyun', reasoningEfforts, reasoningEffort, onReasoningFallback } = {}) {
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
    modelService: { profile: async () => ({ provider, baseUrl: 'http://model.test/v1', apiKey: 'test-only', modelName: 'model-1',
      ...(reasoningEfforts ? { reasoningEfforts } : {}) }) },
    resourceAdapter: {
      listMcpTools: async () => [{ name: 'search' }],
      callMcpTool: async (...args) => { calls.push(args); return [{ type: 'text', text: '搜索结果' }]; },
      searchMemory: async () => [],
      writeMemory: async () => { writes += 1; return { accepted: true }; },
    },
    observability: { syncTrace: async trace => traces.push(trace) },
    fetchImpl,
    ...(onReasoningFallback ? { onReasoningFallback } : {}),
  });
  await handler(Readable.from([JSON.stringify({ agentId: 'ar-local-aaaaaaaaaaaaaaaa', input: '先搜索再回答', nativeTools,
    ...(reasoningEffort ? { reasoningEffort } : {}) })]), response);
  return { output: response.chunks.join(''), traces, calls, writes };
}

test('CRLF fragmented model frames hand tool calls to DSH without executing a private loop', async () => {
  let requests = 0;
  const result = await run(async () => {
    requests++;
    return fragmentedResponse(frame(reply({ content: '我来搜索。', reasoning_content: '先核验来源' }, null), '\r\n') + frame(toolCall(1), '\r\n') + 'data: [DONE]\r\n\r\n');
  }, { nativeTools: true });
  assert.equal(requests, 1); assert.equal(result.calls.length, 0);
  assert.match(result.output, /先核验来源/); assert.match(result.output, /我来搜索/);
  assert.match(result.output, /tool_call/); assert.match(result.output, /call-1/);
  assert.equal(result.writes, 0);
});

test('obsolete per-model execution budgets cannot enable a private MCP loop or memory write', async () => {
  let requests = 0;
  const result = await run(async () => fragmentedResponse(frame(toolCall(++requests))), { execution: { maxSteps: 2 }, memory: true });
  assert.equal(requests, 1); assert.equal(result.calls.length, 0);
  assert.equal(result.traces[0].status, 'failed'); assert.match(result.output, /LOCAL_HARNESS_RETIRED/);
  assert.doesNotMatch(result.output, /run\.completed/); assert.equal(result.writes, 0);
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

test('a reasoning_effort 400 is downgraded once to the provider’s highest legal level', async () => {
  const bodies = [], logs = [];
  const result = await run(async (_url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    if (bodies.length === 1) {
      return new Response(JSON.stringify({ error: { message: 'reasoning_effort max is not supported' } }),
        { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    return fragmentedResponse(frame(reply({ content: '兼容档位已生效' })) + 'data: [DONE]\n\n');
  }, {
    // A stale declaration may still advertise max to an OpenAI gateway; the
    // runtime must recover instead of failing every turn.
    provider: 'openai',
    reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', max: 'max' },
    reasoningEffort: 'max',
    onReasoningFallback: event => logs.push(event),
  });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].reasoning_effort, 'max');
  assert.equal(bodies[1].reasoning_effort, 'high');
  assert.deepEqual(logs, [{ provider: 'openai', model: 'model-1', from: 'max', to: 'high', status: 400 }]);
  assert.match(result.output, /兼容档位已生效/);
  assert.equal(result.traces.at(-1).status, 'completed');
  assert.doesNotMatch(JSON.stringify(logs), /test-only/);
});

test('a reasoning 400 with no lower legal value fails without a second request', async () => {
  let requests = 0;
  const result = await run(async () => {
    requests += 1;
    return new Response(JSON.stringify({ error: { message: 'reasoning_effort max is not supported' } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } });
  }, { provider: 'ksyun', reasoningEfforts: { low: 'low', high: 'high', max: 'max' }, reasoningEffort: 'max' });
  assert.equal(requests, 1);
  assert.match(result.output, /MODEL_STREAM_FAILED/);
  assert.equal(result.traces.at(-1).status, 'failed');
});
