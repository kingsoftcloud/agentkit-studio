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

test('Codex runtime reports a typed provider error when spawn fails', async () => {
  const runtime = createCodexRuntime({ spawnImpl: () => { throw new Error('missing'); } });
  await assert.rejects(
    async () => { for await (const _chunk of runtime.stream({ input: 'hi' })) {} },
    error => error instanceof CodexRuntimeError && error.code === 'CODEX_PROVIDER_UNAVAILABLE',
  );
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
    { type: 'tool', phase: 'started', name: 'search' },
    { type: 'tool', phase: 'completed', name: 'search' },
    { type: 'text', text: '工具已执行' },
  ]);
});
