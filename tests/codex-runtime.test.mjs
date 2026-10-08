import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createCodexRuntime, CodexRuntimeError } from '../src/providers/codex-runtime.mjs';

function fakeSpawn() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter();
  let closed = false;
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      const request = JSON.parse(String(chunk).trim());
      const respond = value => stdout.write(`${JSON.stringify(value)}\n`);
      if (request.method === 'initialize') respond({ id: request.id, result: { userAgent: 'fake-codex' } });
      else if (request.method === 'thread/start') respond({ id: request.id, result: { thread: { id: 'thread-fake' } } });
      else if (request.method === 'turn/start') {
        respond({ id: request.id, result: { turn: { id: 'turn-fake', status: 'inProgress' } } });
        setTimeout(() => {
          const common = { threadId: 'thread-fake', turnId: 'turn-fake' };
          respond({ method: 'item/started', params: { ...common, item: { id: 'item-reasoning', type: 'agentMessage', phase: 'commentary' } } });
          respond({ method: 'item/agentMessage/delta', params: { ...common, itemId: 'item-reasoning', delta: '先分析' } });
          respond({ method: 'item/completed', params: { ...common, item: { id: 'item-reasoning', type: 'agentMessage', phase: 'commentary', text: '先分析' } } });
          respond({ method: 'item/started', params: { ...common, item: { id: 'item-final', type: 'agentMessage', phase: 'final_answer' } } });
          respond({ method: 'item/agentMessage/delta', params: { ...common, itemId: 'item-final', delta: '答案' } });
          respond({ method: 'turn/completed', params: { ...common, turn: { id: 'turn-fake', status: 'completed' } } });
        }, 5);
      }
      callback();
    },
  });
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = () => { if (!closed) { closed = true; stdout.end(); child.emit('exit', 0, null); } };
  return child;
}

test('Codex runtime uses app-server protocol and streams reasoning before final text', async () => {
  const runtime = createCodexRuntime({ spawnImpl: fakeSpawn, cwd: '/tmp', timeoutMs: 1000 });
  const chunks = [];
  for await (const chunk of runtime.stream({ input: '你好', messages: [{ role: 'user', content: '之前的问题' }] })) chunks.push(chunk);
  assert.deepEqual(chunks, [
    { type: 'reasoning', text: '先分析' },
    { type: 'text', text: '答案' },
  ]);
});

test('native plugin MCP calls reach the Studio event stream, including failures', async () => {
  const runtime = createCodexRuntime({ spawnImpl: () => {
    const child = fakeSpawn(), write = child.stdout.write.bind(child.stdout);
    child.stdout.write = (data, ...args) => {
      const message = JSON.parse(String(data));
      if (message.method === 'item/started' && message.params.item.id === 'item-final') {
        const common = { threadId: 'thread-fake', turnId: 'turn-fake' };
        for (const status of ['completed', 'failed']) {
          const item = { id: status, type: 'mcpToolCall', server: 'plugin-mcp', tool: 'lookup', status, arguments: { card: 'P7' }, result: { content: [{ type: 'text', text: 'card-result' }] }, ...(status === 'failed' ? { error: { message: 'fixture failure' } } : {}) };
          write(JSON.stringify({ method: 'item/started', params: { ...common, item } }) + '\n');
          write(JSON.stringify({ method: 'item/completed', params: { ...common, item } }) + '\n');
        }
      }
      return write(data, ...args);
    };
    return child;
  } });
  const tools = [];
  for await (const chunk of runtime.stream({ input: '查卡片' })) if (chunk.type === 'tool') tools.push(chunk);
  assert.deepEqual(tools.map(chunk => [chunk.id, chunk.phase, chunk.name]), [
    ['completed', 'started', 'plugin-mcp/lookup'], ['completed', 'completed', 'plugin-mcp/lookup'],
    ['failed', 'started', 'plugin-mcp/lookup'], ['failed', 'failed', 'plugin-mcp/lookup'],
  ]);
  assert.deepEqual(tools[0].arguments, { card: 'P7' });
  assert.equal(tools[1].result.content[0].text, 'card-result');
  assert.equal(tools[3].error.message, 'fixture failure');
});

test('native commands and file changes retain actual inputs, outputs and failure status', async () => {
  const items = [
    { id: 'command-ok', type: 'commandExecution', command: 'python3 scripts/check.py', cwd: '/imported/skill', status: 'completed', exitCode: 0, aggregatedOutput: 'nodes: 7', durationMs: 17 },
    { id: 'command-error', type: 'commandExecution', command: 'python3 missing.py', cwd: '/empty', status: 'completed', exitCode: 2, aggregatedOutput: 'file not found' },
    { id: 'command-declined', type: 'commandExecution', command: 'blocked command', cwd: '/empty', status: 'declined', exitCode: null },
    { id: 'file-ok', type: 'fileChange', status: 'completed', changes: [{ path: '/workspace/result.txt', kind: { type: 'add' }, diff: '+result' }] },
  ];
  const runtime = createCodexRuntime({ spawnImpl: () => {
    const child = fakeSpawn(), write = child.stdout.write.bind(child.stdout);
    child.stdout.write = (data, ...args) => {
      const message = JSON.parse(String(data));
      if (message.method === 'item/started' && message.params.item.id === 'item-final') {
        const common = { threadId: 'thread-fake', turnId: 'turn-fake' };
        for (const item of items) {
          write(JSON.stringify({ method: 'item/started', params: { ...common, item: { ...item, status: 'inProgress', aggregatedOutput: null } } }) + '\n');
          write(JSON.stringify({ method: 'item/completed', params: { ...common, item } }) + '\n');
        }
      }
      return write(data, ...args);
    };
    return child;
  } });
  const tools = [];
  for await (const chunk of runtime.stream({ input: 'Use the bound script' })) if (chunk.type === 'tool') tools.push(chunk);
  assert.deepEqual(tools.map(chunk => chunk.phase), ['started', 'completed', 'started', 'failed', 'started', 'failed', 'started', 'completed']);
  assert.deepEqual(tools[0].arguments, { command: items[0].command, cwd: items[0].cwd });
  assert.equal(tools[1].result.content[0].text, 'nodes: 7');
  assert.equal(tools[1].result.structuredContent.exitCode, 0);
  assert.equal(tools[3].result.structuredContent.exitCode, 2);
  assert.match(tools[5].error.message, /declined/);
  assert.equal(tools[7].name, 'codex/file-change');
  assert.deepEqual(tools[7].result.structuredContent.changes, items[3].changes);
});

test('command startup failures without a native command item reach the tool stream', async () => {
  let rawEventsRequested;
  const output = 'Chunk ID: probe\nWall time: 0.0000 seconds\nProcess exited with code 1\nOriginal token count: 9\nOutput:\nbwrap: Failed to make / slave: Permission denied\n';
  const runtime = createCodexRuntime({ spawnImpl: () => {
    const child = fakeSpawn(), read = child.stdout.write.bind(child.stdout), write = child.stdin.write.bind(child.stdin);
    child.stdin.write = (data, ...args) => {
      const request = JSON.parse(String(data));
      if (request.method === 'thread/start') rawEventsRequested = request.params.experimentalRawEvents;
      return write(data, ...args);
    };
    child.stdout.write = (data, ...args) => {
      const message = JSON.parse(String(data));
      if (message.method === 'item/started' && message.params.item.id === 'item-final') {
        const common = { threadId: 'thread-fake', turnId: 'turn-fake' };
        for (const item of [
          { type: 'function_call', call_id: 'early-command', name: 'exec_command', arguments: JSON.stringify({ cmd: 'python3 -c "print(7)"' }) },
          { type: 'function_call_output', call_id: 'early-command', output },
        ]) read(JSON.stringify({ method: 'rawResponseItem/completed', params: { ...common, item } }) + '\n');
      }
      return read(data, ...args);
    };
    return child;
  } });
  const chunks = [];
  for await (const chunk of runtime.stream({ input: 'Print seven using Python' })) chunks.push(chunk);
  const tools = chunks.filter(chunk => chunk.type === 'tool');
  assert.deepEqual(tools.map(chunk => chunk.phase), ['started', 'failed']);
  assert.equal(rawEventsRequested, true);
  assert.equal(tools[1].result.content[0].text, output);
  assert.equal(tools[1].result.structuredContent.exitCode, 1);
});

test('the selected Codex model reaches thread/start instead of inheriting another default', async () => {
  let selected;
  const runtime = createCodexRuntime({ model: 'configured-default', spawnImpl: () => {
    const child = fakeSpawn(); const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = (data, ...args) => { const message = JSON.parse(String(data)); if (message.method === 'thread/start') selected = message.params.model; return write(data, ...args); };
    return child;
  } });
  for await (const chunk of runtime.stream({ input: 'hi', model: 'selected-model' })) { void chunk; }
  assert.equal(selected, 'selected-model');
});

test('Codex runtime reports a typed provider error when spawn fails', async () => {
  const runtime = createCodexRuntime({ spawnImpl: () => { throw new Error('missing'); } });
  await assert.rejects(
    async () => { for await (const _chunk of runtime.stream({ input: 'hi' })) {} },
    error => error instanceof CodexRuntimeError && error.code === 'CODEX_PROVIDER_UNAVAILABLE',
  );
});

test('portable child environment replaces ambient credentials and model defaults', async () => {
  const previous = process.env.AGENTKIT_CODEX_MODEL;
  process.env.AGENTKIT_CODEX_MODEL = 'operator-default-must-not-leak';
  let childEnv, thread;
  try {
    const runtime = createCodexRuntime({ inheritEnv: false, env: { CODEX_HOME: '/isolated', PATH: '/usr/bin' }, spawnImpl: (_exe, _args, options) => {
      childEnv = options.env;
      const child = fakeSpawn(), write = child.stdin.write.bind(child.stdin);
      child.stdin.write = (data, ...args) => {
        const message = JSON.parse(String(data));
        if (message.method === 'thread/start') thread = message.params;
        return write(data, ...args);
      };
      return child;
    } });
    for await (const _chunk of runtime.stream({ input: 'hi', modelProvider: { baseUrl: 'https://gateway.example/v1', apiKey: 'target-credential' } })) {}
    assert.deepEqual(childEnv, { CODEX_HOME: '/isolated', PATH: '/usr/bin', AGENTKIT_CODEX_MODEL_API_KEY: 'target-credential' });
    assert.equal(thread.model, undefined);
  } finally {
    if (previous === undefined) delete process.env.AGENTKIT_CODEX_MODEL;
    else process.env.AGENTKIT_CODEX_MODEL = previous;
  }
});

test('a custom provider uses Responses and a per-child credential without altering native turns', async () => {
  const invocations = [], threads = [];
  const runtime = createCodexRuntime({ spawnImpl: (_executable, args, options) => {
    invocations.push({ args, env: options.env });
    const child = fakeSpawn(), write = child.stdin.write.bind(child.stdin);
    child.stdin.write = (data, ...rest) => {
      const message = JSON.parse(String(data));
      if (message.method === 'thread/start') threads.push(message.params);
      return write(data, ...rest);
    };
    return child;
  } });
  for await (const _chunk of runtime.stream({ input: 'hi', model: 'gateway-model', modelProvider: { baseUrl: 'https://gateway.example/v1', apiKey: 'private-test-key' } })) {}
  for await (const _chunk of runtime.stream({ input: 'hi', model: 'native-model' })) {}
  assert.ok(invocations[0].args.includes('model_providers.agentkit_gateway.wire_api="responses"'));
  assert.ok(invocations[0].args.includes('model_providers.agentkit_gateway.requires_openai_auth=false'));
  assert.ok(invocations[0].args.includes('model_providers.agentkit_gateway.base_url="https://gateway.example/v1"'));
  assert.equal(invocations[0].env.AGENTKIT_CODEX_MODEL_API_KEY, 'private-test-key');
  assert.ok(!JSON.stringify(invocations[0].args).includes('private-test-key'));
  assert.ok(!JSON.stringify(threads).includes('private-test-key'));
  assert.equal(threads[0].modelProvider, 'agentkit_gateway');
  assert.equal(threads[0].model, 'gateway-model');
  assert.equal(threads[1].modelProvider, undefined);
  assert.equal(invocations[1].env.AGENTKIT_CODEX_MODEL_API_KEY, process.env.AGENTKIT_CODEX_MODEL_API_KEY);
  assert.ok(!invocations[1].args.some(arg => arg.includes('agentkit_gateway')));
});

test('Codex runtime classifies an asynchronous missing executable as provider unavailable', async () => {
  const runtime = createCodexRuntime({
    spawnImpl: () => {
      const child = new EventEmitter();
      child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
      child.stdout = new PassThrough();
      queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' })));
      return child;
    },
  });
  await assert.rejects(
    async () => { for await (const _chunk of runtime.stream({ input: 'hi' })) {} },
    error => error instanceof CodexRuntimeError && error.code === 'CODEX_PROVIDER_UNAVAILABLE',
  );
});

test('Codex runtime registers dynamic tools and answers item/tool/call on the Host side', async () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter();
  let threadParams;
  let toolResponse;
  const respond = value => stdout.write(`${JSON.stringify(value)}\n`);
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      const request = JSON.parse(String(chunk).trim());
      if (request.method === 'initialize') respond({ id: request.id, result: { userAgent: 'fake-codex' } });
      else if (request.method === 'thread/start') {
        threadParams = request.params;
        respond({ id: request.id, result: { thread: { id: 'thread-tools' } } });
      } else if (request.method === 'turn/start') {
        respond({ id: request.id, result: { turn: { id: 'turn-tools', status: 'inProgress' } } });
        setTimeout(() => {
          const common = { threadId: 'thread-tools', turnId: 'turn-tools' };
          respond({ jsonrpc: '2.0', id: 77, method: 'item/tool/call', params: { ...common, callId: 'call-1', tool: 'search', namespace: null, arguments: { query: '金山云' } } });
        }, 2);
      } else if (request.id === 77) {
        toolResponse = request.result;
        const common = { threadId: 'thread-tools', turnId: 'turn-tools' };
        respond({ method: 'item/started', params: { ...common, item: { id: 'item-final', type: 'agentMessage', phase: 'final_answer' } } });
        respond({ method: 'item/agentMessage/delta', params: { ...common, itemId: 'item-final', delta: '工具已执行' } });
        respond({ method: 'turn/completed', params: { ...common, turn: { id: 'turn-tools', status: 'completed' } } });
      }
      callback();
    },
  });
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = () => { stdout.end(); child.emit('exit', 0, null); };
  const runtime = createCodexRuntime({ spawnImpl: () => child, cwd: '/tmp', timeoutMs: 1000 });
  const chunks = [];
  for await (const chunk of runtime.stream({
    input: '搜索金山云',
    dynamicTools: [{ type: 'function', name: 'search', description: 'Search', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }],
    toolHandler: async call => {
      assert.deepEqual(call.arguments, { query: '金山云' });
      return [{ type: 'text', text: 'hit' }];
    },
  })) chunks.push(chunk);
  assert.equal(threadParams.dynamicTools[0].name, 'search');
  assert.equal(toolResponse.success, true);
  assert.deepEqual(toolResponse.contentItems, [{ type: 'inputText', text: 'hit' }]);
  assert.deepEqual(chunks, [
    { type: 'tool', phase: 'started', name: 'search', id: 'call-1', arguments: { query: '金山云' } },
    { type: 'tool', phase: 'completed', name: 'search', id: 'call-1', arguments: { query: '金山云' }, result: { contentItems: [{ type: 'inputText', text: 'hit' }], success: true } },
    { type: 'text', text: '工具已执行' },
  ]);
});

test('Chat provider turns isolate their proxy and disable only hosted search', async () => {
  const invocations = [];
  const runtime = createCodexRuntime({ spawnImpl: (_bin, args, options) => {
    invocations.push({ args, env: options.env }); return fakeSpawn();
  } });
  for await (const _chunk of runtime.stream({ input: 'hi', model: 'chat-model', modelProvider: { api: 'chat-completions', baseUrl: 'https://chat.example/v1', apiKey: 'upstream-secret' } })) {}
  const { args, env } = invocations[0];
  assert.ok(args.includes('web_search="disabled"'));
  assert.ok(!JSON.stringify(args).includes('upstream-secret'));
  assert.notEqual(env.AGENTKIT_CODEX_MODEL_API_KEY, 'upstream-secret');
  const baseUrl = JSON.parse(args.find(arg => arg.startsWith('model_providers.agentkit_gateway.base_url=')).split('=').slice(1).join('='));
  assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:/);
  await assert.rejects(fetch(`${baseUrl}/responses`));
  for await (const _chunk of runtime.stream({ input: 'hi', modelProvider: { baseUrl: 'https://responses.example/v1', apiKey: 'response-secret' } })) {}
  assert.ok(!invocations[1].args.some(arg => arg.startsWith('web_search=')));
});

test('gateway rate limits remain actionable and never expose provider credentials', async () => {
  const runtime = createCodexRuntime({ spawnImpl: () => {
    const child = fakeSpawn(), write = child.stdout.write.bind(child.stdout);
    child.stdout.write = (data, ...args) => {
      const message = JSON.parse(String(data));
      if (message.method === 'turn/completed') message.params.turn = { status: 'failed', error: { message: 'exceeded retry limit, last status: 429 Too Many Requests private-test-key' } };
      return write(JSON.stringify(message) + '\n', ...args);
    };
    return child;
  } });
  await assert.rejects(async () => {
    for await (const _chunk of runtime.stream({ input: 'hi', modelProvider: { baseUrl: 'https://gateway.example/v1', apiKey: 'private-test-key' } })) {}
  }, error => {
    assert.equal(error.code, 'CODEX_MODEL_RATE_LIMITED');
    assert.match(error.message, /限流.*稍后重试.*切换模型/);
    assert.doesNotMatch(error.message, /private-test-key/); return true;
  });
});

test('Codex cumulative token notifications reach consumers once without duplicate billing', async () => {
  const runtime = createCodexRuntime({ spawnImpl: () => {
    const child = fakeSpawn(), write = child.stdout.write.bind(child.stdout);
    child.stdout.write = (data, ...args) => {
      const message = JSON.parse(String(data));
      if (message.method === 'turn/completed') {
        for (const [inputTokens, outputTokens, cachedInputTokens] of [[100, 20, 30], [100, 20, 30], [250, 50, 80]]) {
          write(JSON.stringify({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-fake', turnId: 'turn-fake', tokenUsage: { total: { inputTokens, outputTokens, cachedInputTokens, reasoningOutputTokens: 10 }, last: { inputTokens: 999999, outputTokens: 999999 } } } }) + '\n');
        }
      }
      return write(data, ...args);
    };
    return child;
  } });
  const chunks = [];
  for await (const chunk of runtime.stream({ input: '你好' })) if (chunk.type === 'usage') chunks.push(chunk);
  assert.equal(chunks.length, 2);
  assert.equal(chunks.reduce((sum, chunk) => sum + chunk.usage.inputTokens, 0), 250);
  assert.equal(chunks.reduce((sum, chunk) => sum + chunk.usage.outputTokens, 0), 50);
  assert.equal(chunks.reduce((sum, chunk) => sum + chunk.usage.cachedInputTokens, 0), 80);
});
