import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createLocalConversationHandler, prepareLocalResourceContext } from '../src/local-runtime.mjs';

test('memory context explains Host persistence and does not promise writes in read-only mode', async () => {
  const memory = { config: { binding: { resource: { kind: 'memory-instance', id: 'memory-1' } } } };
  const resourceAdapter = { searchMemory: async () => [{ content: 'known fact' }] };
  const prepare = mode => prepareLocalResourceContext({ record: { spec: { memory: { enabled: true, write: { mode } }, bindings: { plugins: [memory] } } }, input: '请记住验收标记', resourceAdapter, resourceMode: 'context-only' });
  const writable = await prepare('candidate');
  assert.match(writable.resourceContext, /Host.*完成后.*记忆库/);
  assert.match(writable.resourceContext, /不能.*仅.*当前会话/);
  assert.match(writable.resourceContext, /不能.*已保存/);
  const readOnly = await prepare('off');
  assert.equal(readOnly.memoryWrite, false);
  assert.match(readOnly.resourceContext, /本轮不会写入/);
});

function responseSink() {
  return { headersSent: false, writableEnded: false, chunks: [], writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; }, write(chunk) { this.chunks.push(String(chunk)); }, end(chunk = '') { if (chunk) this.chunks.push(String(chunk)); this.writableEnded = true; } };
}

test('a local draft follows a catalog model selected on its bound gateway; frozen builds and other gateways remain restricted', async () => {
  const requests = [];
  const record = { metadata: { local: true }, spec: { bindings: { modelProfileId: 'legacy-text-model' } } };
  const profile = { id: 'default', modelName: 'legacy-text-model', baseUrl: 'https://model.test/v1', apiKey: 'test' };
  const handler = createLocalConversationHandler({
    agentStore: async () => ({ getRevision: async () => record }), buildStore: { resolve: async () => record },
    modelService: { profile: async () => profile, catalog: async () => ({ items: [{ id: 'vision-model', input: ['text', 'image'] }] }) },
    fetchImpl: async (_url, init) => { requests.push(JSON.parse(init.body)); return new Response('data: {"choices":[{"delta":{"content":"image answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'); },
  });
  const payload = { agentId: 'draft', agentRevision: 1, nativeTools: true, input: '',
    content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } }],
    modelSelection: { provider: 'agentkit-studio-default', model: 'vision-model' } };
  const accepted = responseSink(); await handler(Readable.from([JSON.stringify(payload)]), accepted);
  assert.equal(accepted.status, 200); assert.equal(requests[0].model, 'vision-model');
  for (const deniedPayload of [
    { ...payload, buildId: 'build_11111111111111111111' },
    { ...payload, modelSelection: { provider: 'unbound-provider', model: 'vision-model' } },
    { ...payload, modelSelection: { provider: 'agentkit-studio-default', model: 'not-in-catalog' } },
  ]) {
    const denied = responseSink(); await handler(Readable.from([JSON.stringify(deniedPayload)]), denied);
    assert.equal(denied.status, 409);
  }
  assert.equal(requests.length, 1);
});

test('native model selection reaches the actual frozen gateway and rejects an unbound route', async () => {
  const profiles = [
    { id: 'first', provider: 'openai-compatible', modelName: 'model-a', baseUrl: 'http://first.test/v1', apiKey: 'key-a' },
    { id: 'second', provider: 'openai-compatible', modelName: 'model-b', baseUrl: 'http://second.test/v1', apiKey: 'key-b' },
  ];
  const record = { metadata: { local: true }, spec: { bindings: { modelProfileId: 'first', modelProfileIds: ['first', 'second'] } } };
  const requests = [];
  const handler = createLocalConversationHandler({ buildStore: { resolve: async () => record },
    modelService: { profile: async id => profiles.find(p => p.id === id) },
    fetchImpl: async (url, init) => { requests.push({ url, model: JSON.parse(init.body).model, auth: init.headers.Authorization });
      return new Response('data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'); },
  });
  const payload = { agentId: 'frozen', buildId: 'build_11111111111111111111', input: 'question', nativeTools: true,
    modelSelection: { provider: 'agentkit-studio-second', model: 'model-b' } };
  const response = responseSink(); await handler(Readable.from([JSON.stringify(payload)]), response);
  assert.equal(response.status, 200);
  assert.equal(requests[0].url, 'http://second.test/v1/chat/completions');
  assert.equal(requests[0].model, 'model-b');
  assert.equal(requests[0].auth, 'Bearer key-b');
  const denied = responseSink(); await handler(Readable.from([JSON.stringify({ ...payload, modelSelection: { provider: 'unbound', model: 'model-b' } })]), denied);
  assert.equal(denied.status, 409); assert.equal(requests.length, 1);
});

test('a revision-bound request uses the archived prompt and model instead of the edited Agent', async () => {
  const response=responseSink();
  const handler=createLocalConversationHandler({
    agentStore:async()=>({get:async()=>{throw new Error('latest Agent must not be read');},getRevision:async(_id,revision)=>{assert.equal(revision,1);return {metadata:{name:'Original'},spec:{instructions:{system:'original persona'},bindings:{modelProfileId:'old-model'}}};}}),
    modelService:{profile:async id=>{assert.equal(id,'old-model');return {baseUrl:'http://model.test/v1',apiKey:'test',modelName:id};}},
    fetchImpl:async(_url,init)=>{assert.equal(JSON.parse(init.body).messages[0].content,'original persona');return new Response('data: {"choices":[{"delta":{"content":"original"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');},
  });
  await handler(Readable.from([JSON.stringify({agentId:'ar-local-aaaaaaaaaaaaaaaa',agentRevision:1,input:'身份'})]),response);
  assert.equal(response.status,200);
});

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

test('local runtime hands native DSH MCP calls back to the loop without executing them', async () => {
  const response = responseSink();
  let requestBody;
  let calls = 0;
  const handler = createLocalConversationHandler({
    agentStore: async () => ({ get: async () => ({ spec: { bindings: { mcpServers: [{ resourceId: 'mcp-1' }] } } }) }),
    modelService: { profile: async () => ({ baseUrl: 'http://model.test/v1', apiKey: 'secret', modelName: 'model-1' }) },
    resourceAdapter: {
      listMcpTools: async () => { throw new Error('native DSH path must not rediscover MCP tools'); },
      callMcpTool: async () => { calls += 1; return []; },
    },
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return new Response('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-native","function":{"name":"search","arguments":"{\\"query\\":\\"hello\\"}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n');
    },
  });
  await handler(Readable.from([JSON.stringify({
    agentId: 'ar-local-aaaaaaaaaaaaaaaa', input: '搜索', nativeTools: true,
    tools: [{ name: 'search', description: 'Search', parameters: { type: 'object', properties: { query: { type: 'string' } } } }],
  })]), response);
  assert.equal(response.status, 200);
  assert.equal(requestBody.tools[0].function.name, 'search');
  assert.equal(calls, 0);
  assert.match(response.chunks.join(''), /"protocol":"dsh"/);
  assert.match(response.chunks.join(''), /"status":"tool_calls"/);
});

test('native DSH continuation does not duplicate the current user message', async () => {
  const requests = [];
  const handler = createLocalConversationHandler({
    agentStore: async () => ({ get: async () => ({ metadata: { name: 'native' }, spec: { instructions: {}, bindings: { modelProfileId: 'p' } } }) }),
    modelService: { profile: async () => ({ id: 'p', modelName: 'm', baseUrl: 'https://model.invalid', apiKey: 'k' }) },
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const chunks = [];
  const request = { async *[Symbol.asyncIterator]() { yield JSON.stringify({ agentId: 'a', input: '继续', history: [{ role: 'user', content: '继续' }] }); } };
  const response = { writableEnded: false, writeHead() {}, write(chunk) { chunks.push(String(chunk)); }, end() { this.writableEnded = true; } };
  await handler(request, response, {});
  assert.equal(requests[0].messages.filter(item => item.role === 'user').length, 1);
  assert.match(chunks.join(''), /ok/);
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
      searchMemory: async (id, query, userId, options) => { assert.deepEqual([id, query, userId, options], ['memory-1', '写一篇', 'studio-anonymous', { agentId: 'ar-local-aaaaaaaaaaaaaaaa' }]); return [{ content: '用户偏好轻松口吻' }]; },
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

test('local runtime renders AICP memory Content arrays as text', async () => {
  const response = responseSink();
  let requestBody;
  const handler = createLocalConversationHandler({
    agentStore: async () => ({ get: async () => ({ spec: {
      bindings: { plugins: [{ config: { binding: { resource: { kind: 'memory-instance', id: 'memory-1' } } } }] },
    } }) }),
    modelService: { profile: async () => ({ baseUrl: 'http://model.test/v1', apiKey: 'secret', modelName: 'model-1' }) },
    resourceAdapter: {
      searchMemory: async () => [{ Content: [{ Type: 'input_text', Text: '用户之前选择了轻松口吻。' }] }],
      listMcpTools: async () => [],
    },
    observability: { syncTrace: async () => {} },
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return new Response('data: {"choices":[{"delta":{"content":"已读取"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    },
  });
  await handler(Readable.from([JSON.stringify({ agentId: 'ar-local-aaaaaaaaaaaaaaaa', sessionId: 'session-memory-content', input: '你还记得什么？' })]), response);
  assert.match(requestBody.messages[0].content, /用户之前选择了轻松口吻/);
  assert.doesNotMatch(requestBody.messages[0].content, /\[object Object\]/);
});

test('local runtime writes a bound memory conversation after a completed turn', async () => {
  const response = responseSink();
  let write;
  const handler = createLocalConversationHandler({
    agentStore: async () => ({ get: async () => ({ metadata: { id: 'ar-local-aaaaaaaaaaaaaaaa', name: 'Memory Agent' }, spec: {
      memory: { enabled: true, write: { mode: 'candidate' } },
      bindings: { plugins: [{ config: { binding: { resource: { kind: 'memory-instance', id: 'memory-1' } } } }] },
    } }) }),
    modelService: { profile: async () => ({ baseUrl: 'http://model.test/v1', apiKey: 'secret', modelName: 'model-1' }) },
    resourceAdapter: {
      listMcpTools: async () => [],
      searchMemory: async () => [],
      writeMemory: async (...args) => { write = args; return { accepted: true }; },
    },
    observability: { syncTrace: async () => {} },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.match(body.messages.at(-1).content, /记住/);
      return new Response('data: {"choices":[{"delta":{"content":"已记录"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    },
  });
  await handler(Readable.from([JSON.stringify({ agentId: 'ar-local-aaaaaaaaaaaaaaaa', sessionId: 'session-1', userId: 'user-1', input: '记住我喜欢轻松口吻' })]), response);
  assert.equal(response.status, 200);
  assert.equal(write[0], 'memory-1');
  assert.equal(write[1], 'user-1');
  assert.deepEqual(write[2], [{ role: 'user', content: '记住我喜欢轻松口吻' }, { role: 'assistant', content: '已记录' }]);
  assert.deepEqual(write[3], { sessionId: 'session-1', agentId: 'ar-local-aaaaaaaaaaaaaaaa', flush: true });
  assert.match(response.chunks.join(''), /已记录/);
});

test('local runtime keeps explicit-only memory off for ordinary turns', async () => {
  const response = responseSink();
  let writes = 0;
  const handler = createLocalConversationHandler({
    agentStore: async () => ({ get: async () => ({ spec: {
      memory: { enabled: true, write: { mode: 'explicit_only' } },
      bindings: { plugins: [{ config: { binding: { resource: { kind: 'memory-instance', id: 'memory-1' } } } }] },
    } }) }),
    modelService: { profile: async () => ({ baseUrl: 'http://model.test/v1', apiKey: 'secret', modelName: 'model-1' }) },
    resourceAdapter: { listMcpTools: async () => [], searchMemory: async () => [], writeMemory: async () => { writes += 1; return { accepted: true }; } },
    observability: { syncTrace: async () => {} },
    fetchImpl: async () => new Response('data: {"choices":[{"delta":{"content":"普通回答"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'),
  });
  await handler(Readable.from([JSON.stringify({ agentId: 'ar-local-aaaaaaaaaaaaaaaa', sessionId: 'session-1', input: '你好' })]), response);
  assert.equal(response.status, 200);
  assert.equal(writes, 0);
  assert.match(response.chunks.join(''), /普通回答/);
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

test('an explicitly disabled memory binding does not recall or write cloud data', async () => {
  const binding = { config: { binding: { resource: { kind: 'memory-instance', id: 'memory-off' } } } };
  const knowledge = { config: { binding: { resource: { kind: 'knowledge-base', id: 'kb' } } } };
  const result = await prepareLocalResourceContext({ record: { spec: { memory: { enabled: false }, bindings: { plugins: [binding, knowledge] } } }, input: '记忆验收', resourceAdapter: { searchMemory: async () => { throw new Error('disabled memory must not be called'); }, searchKnowledge: async () => [{content:'KB-CANARY'}] }, resourceMode: 'context-only' });
  assert.match(result.resourceContext, /长期记忆已关闭/);
  assert.match(result.resourceContext, /Knowledge: KB-CANARY/);
  assert.doesNotMatch(result.resourceContext, /Memory:/);
  assert.equal(result.memoryWrite, false);
});
