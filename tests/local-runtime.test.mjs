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
    agentStore: async () => ({ get: async () => ({ metadata: { name: '搜索助手' }, spec: { instructions: { system: 'test' }, bindings: { mcpServers: [{ resourceId: 'mcp-1' }] } } }) }),
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
  assert.equal(traces[0].agentName, '搜索助手');
  assert.deepEqual(traces[0].events.filter(event => event.event_type.startsWith('tool.')).map(event => [event.event_type, event.payload.name]), [
    ['tool.started', 'search'],
    ['tool.completed', 'search'],
  ]);
  assert.ok(traces[0].events.some(event => event.event_type === 'turn.text'));
});

test('local runtime executes bound DSH tools through the session adapter', async () => {
  const response = responseSink();
  let requestBody;
  let called;
  let call = 0;
  const handler = createLocalConversationHandler({
    agentStore: async () => ({ get: async () => ({ metadata: { name: '工作区助手' }, spec: { bindings: { tools: ['component_status'] } } }) }),
    modelService: { profile: async () => ({ baseUrl: 'http://model.test/v1', apiKey: 'secret', modelName: 'model-1' }) },
    resourceAdapter: { listMcpTools: async () => [] },
    observability: { syncTrace: async () => {} },
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      call += 1;
      if (call === 1) return new Response('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-dsh","function":{"name":"component_status","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n');
      assert.equal(requestBody.messages.at(-1).role, 'tool');
      return new Response('data: {"choices":[{"delta":{"content":"工作区状态已读取"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    },
  });
  await handler(Readable.from([JSON.stringify({ agentId: 'ar-local-aaaaaaaaaaaaaaaa', input: '检查状态' })]), response, {
    toolAdapter: {
      listTools: async ids => { assert.deepEqual(ids, ['component_status']); return [{ name: 'component_status', description: '读取状态', parameters: { type: 'object', properties: {} } }]; },
      callTool: async (name, args, meta) => { called = [name, args, meta.callId]; return [{ type: 'text', text: 'healthy' }]; },
    },
  });
  assert.equal(response.status, 200);
  assert.equal(requestBody.tools[0].function.name, 'component_status');
  assert.deepEqual(called, ['component_status', {}, 'call-dsh']);
  assert.match(response.chunks.join(''), /工作区状态已读取/);
});

test('local runtime rejects bound DSH tools without the session adapter', async () => {
  const response = responseSink();
  const handler = createLocalConversationHandler({
    agentStore: async () => ({ get: async () => ({ spec: { bindings: { tools: ['component_status'] } } }) }),
    modelService: { profile: async () => ({}) },
    resourceAdapter: { listMcpTools: async () => [] },
  });
  await handler(Readable.from([JSON.stringify({ agentId: 'ar-local-aaaaaaaaaaaaaaaa', input: 'run' })]), response);
  assert.equal(response.status, 409);
  assert.match(response.chunks.join(''), /TOOL_ADAPTER_MISSING/);
});

test('local runtime records a failed MCP tool in the local trace', async () => {
  const response = responseSink();
  const traces = [];
  const handler = createLocalConversationHandler({
    agentStore: async () => ({ get: async () => ({ metadata: { name: '失败搜索助手' }, spec: { bindings: { mcpServers: [{ resourceId: 'mcp-1' }] } } }) }),
    modelService: { profile: async () => ({ baseUrl: 'http://model.test/v1', apiKey: 'secret', modelName: 'model-1' }) },
    resourceAdapter: {
      listMcpTools: async () => [{ name: 'search' }],
      callMcpTool: async () => { throw Object.assign(new Error('remote search failed'), { code: 'MCP_TOOL_FAILED' }); },
    },
    observability: { syncTrace: async record => traces.push(record) },
    fetchImpl: async () => new Response('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-fail","function":{"name":"search","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n'),
  });
  await handler(Readable.from([JSON.stringify({ agentId: 'ar-local-aaaaaaaaaaaaaaaa', sessionId: 's-fail', input: '搜索' })]), response);
  assert.equal(response.status, 200);
  assert.equal(traces[0].status, 'failed');
  assert.deepEqual(traces[0].events.filter(event => event.event_type.startsWith('tool.')).map(event => [event.event_type, event.payload.name]), [
    ['tool.started', 'search'],
    ['tool.failed', 'search'],
  ]);
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

test('local runtime injects cloud Skill Space and memory recall into the model turn', async () => {
  const response = responseSink();
  let requestBody;
  const handler = createLocalConversationHandler({
    agentStore: async () => ({ get: async () => ({ spec: {
      instructions: { system: '你是营销助手' },
      bindings: { plugins: [
        { config: { binding: { resource: { kind: 'skill-space', id: 'space-1' } } } },
        { config: { binding: { resource: { kind: 'memory-instance', id: 'memory-1' } } } },
      ] },
    } }) }),
    modelService: { profile: async () => ({ baseUrl: 'http://model.test/v1', apiKey: 'secret', modelName: 'model-1' }) },
    resourceAdapter: {
      loadSkill: async id => { assert.equal(id, 'space-1'); return { name: '云端技能', content: '标题要短，语气友好' }; },
      searchMemory: async (id, query, userId) => { assert.deepEqual([id, query, userId], ['memory-1', '写一篇', 'session-1']); return [{ content: '用户偏好轻松口吻' }]; },
      listMcpTools: async () => [],
    },
    observability: { syncTrace: async () => {} },
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return new Response('data: {"choices":[{"delta":{"content":"已结合绑定资源"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    },
  });
  await handler(Readable.from([JSON.stringify({ agentId: 'ar-local-aaaaaaaaaaaaaaaa', sessionId: 'session-1', input: '写一篇' })]), response);
  assert.equal(response.status, 200);
  const system = requestBody.messages[0].content;
  assert.match(system, /标题要短，语气友好/);
  assert.match(system, /用户偏好轻松口吻/);
  assert.match(response.chunks.join(''), /已结合绑定资源/);
});

test('local runtime keeps a text-only turn alive when MCP discovery is temporarily unavailable', async () => {
  const response = responseSink();
  let requestBody;
  const handler = createLocalConversationHandler({
    agentStore: async () => ({ get: async () => ({ spec: { bindings: { mcpServers: ['mcp-unavailable'] } } }) }),
    modelService: { profile: async () => ({ baseUrl: 'http://model.test/v1', apiKey: 'secret', modelName: 'model-1' }) },
    resourceAdapter: {
      listMcpTools: async () => { throw Object.assign(new Error('Endpoint TLS 无法验证'), { code: 'MCP_CONNECT_FAILED' }); },
    },
    observability: { syncTrace: async () => {} },
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return new Response('data: {"choices":[{"delta":{"content":"普通文本对话可继续"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    },
  });
  await handler(Readable.from([JSON.stringify({ agentId: 'ar-local-aaaaaaaaaaaaaaaa', sessionId: 's-mcp', input: '你是谁' })]), response);
  assert.equal(response.status, 200);
  assert.match(requestBody.messages[0].content, /MCP mcp-unavailable 当前不可用/);
  assert.match(response.chunks.join(''), /普通文本对话可继续/);
});

test('local runtime executes the frozen Build instead of the mutable Agent record', async () => {
  const response = responseSink();
  let requestBody;
  const handler = createLocalConversationHandler({
    agentStore: async () => ({ get: async () => ({ spec: { instructions: { system: 'new prompt' } } }) }),
    buildStore: { resolve: async () => ({ metadata: { local: true }, spec: { instructions: { system: 'frozen prompt' }, bindings: {} }, bindings: {} }) },
    modelService: { profile: async () => ({ baseUrl: 'http://model.test/v1', apiKey: 'secret', modelName: 'model-1' }) },
    resourceAdapter: { listMcpTools: async () => [] },
    observability: { syncTrace: async () => {} },
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return new Response('data: {"choices":[{"delta":{"content":"冻结版本"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    },
  });
  await handler(Readable.from([JSON.stringify({ agentId: 'ar-local-aaaaaaaaaaaaaaaa', buildId: 'build_11111111111111111111', input: '运行' })]), response);
  assert.equal(response.status, 200);
  assert.match(requestBody.messages[0].content, /frozen prompt/);
  assert.doesNotMatch(requestBody.messages[0].content, /new prompt/);
});

test('local runtime aborts the model stream and records a canceled trace', async () => {
  const response = responseSink();
  const controller = new AbortController();
  const traces = [];
  let upstreamAborted = false;
  const handler = createLocalConversationHandler({
    agentStore: async () => ({ get: async () => ({ spec: { bindings: {} } }) }),
    modelService: { profile: async () => ({ baseUrl: 'http://model.test/v1', apiKey: 'secret', modelName: 'model-1' }) },
    resourceAdapter: { listMcpTools: async () => [] },
    observability: { syncTrace: async record => traces.push(record) },
    fetchImpl: async (_url, init) => {
      await new Promise((resolve, reject) => {
        if (init.signal.aborted) { upstreamAborted = true; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); return; }
        init.signal.addEventListener('abort', () => { upstreamAborted = true; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
      });
      return new Response('');
    },
  });
  const pending = handler(Readable.from([JSON.stringify({ agentId: 'ar-local-aaaaaaaaaaaaaaaa', sessionId: 's-cancel', input: '运行' })]), response, { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await pending;
  assert.equal(upstreamAborted, true);
  assert.equal(traces[0].status, 'canceled');
  assert.equal(traces[0].events.at(-1).event_type, 'run.canceled');
  assert.doesNotMatch(response.chunks.join(''), /run\.failed/);
});
