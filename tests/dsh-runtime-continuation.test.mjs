import test from 'node:test';
import assert from 'node:assert/strict';
import { apply as applyDshRuntimePlugin } from '../src/providers/dsh-runtime-plugin.mjs';
import { createDshRuntimeAdapter, unbindDshAgentRoutes } from '../src/providers/dsh-runtime.mjs';

const event = item => `data: ${JSON.stringify({ conversationItem: item })}\n\n`;
const completed = `data: ${JSON.stringify({ runtimeEvent: { event_type: 'run.completed' } })}\n\n`;
const prompt = { model: 'gateway-model', messages: [{ role: 'user', content: '运行冻结版本' }] };

async function selectPreset(runtime, sessionId, buildId) {
  const listeners = new Map();
  applyDshRuntimePlugin({
    tools: { schemas: () => [], execute: async () => ({}) },
    on: (name, callback) => { listeners.set(name, callback); return () => {}; },
  }, { agentId: 'frozen-agent', runtime, local: true, buildId });
  await listeners.get('agent/request')({ agent: { id: sessionId } }, async () => prompt);
}

test('frozen Build selection survives the scoped request to root Harness transport', async t => {
  t.after(() => unbindDshAgentRoutes('frozen-agent'));
  const buildId = 'build_11111111111111111111';
  await selectPreset('harness', 'frozen-harness-session', buildId);
  let body;
  const adapter = createDshRuntimeAdapter({
    localHandler: async () => async (request, response) => {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      body = JSON.parse(raw);
      response.writeHead(200);
      response.write(completed);
      response.end('data: [DONE]\n\n');
    },
  });
  for await (const _chunk of adapter.stream({ ...prompt, sessionId: 'frozen-harness-session' })) {}
  assert.equal(body.buildId, buildId, 'native Session must execute its selected Build, not the latest Agent');
});

test('frozen Build selection reaches Codex resource materialization', async t => {
  t.after(() => unbindDshAgentRoutes('frozen-agent'));
  const buildId = 'build_22222222222222222222';
  await selectPreset('codex', 'frozen-codex-session', buildId);
  let context;
  const adapter = createDshRuntimeAdapter({
    codexResourceContext: async options => { context = options; return {}; },
    codexRuntime: { async *stream() { yield { type: 'text', text: 'frozen answer' }; } },
  });
  for await (const _chunk of adapter.stream({ ...prompt, sessionId: 'frozen-codex-session' })) {}
  assert.equal(context.buildId, buildId);
});

function assertContinuousBlocks(chunks, expected) {
  const starts = chunks.filter(chunk => chunk.type === 'block-start');
  const ends = chunks.filter(chunk => chunk.type === 'block-end');
  assert.deepEqual(starts.map(chunk => chunk.index), expected.map(item => item[0]));
  assert.deepEqual(ends.map(chunk => [chunk.index, chunk.block.type, chunk.block.text]), expected);
  const active = new Set();
  for (const chunk of chunks) {
    if (chunk.type === 'block-start') active.add(chunk.index);
    if (chunk.type.endsWith('-delta')) assert.ok(active.has(chunk.index), 'delta cannot target a closed block');
    if (chunk.type === 'block-end') { assert.ok(active.has(chunk.index)); active.delete(chunk.index); }
  }
  assert.equal(active.size, 0);
}

test('Harness reasoning and final answer survive two tool continuations', async () => {
  const adapter = createDshRuntimeAdapter({
    localHandler: async () => async (_request, response) => {
      response.writeHead(200);
      for (const item of [
        { kind: 'assistant_reasoning', payload: { operation: 'append', text: '先搜索' } },
        { kind: 'assistant_text', payload: { operation: 'append', text: '正在搜索。' } },
        { kind: 'tool_call', payload: { callId: 'search', name: 'search' } },
        { kind: 'tool_result', payload: { callId: 'search', name: 'search' } },
        { kind: 'assistant_text', payload: { operation: 'append', text: '继续读取。' } },
        { kind: 'tool_call', payload: { callId: 'read', name: 'read' } },
        { kind: 'tool_result', payload: { callId: 'read', name: 'read' } },
        { kind: 'assistant_reasoning', payload: { operation: 'append', text: '已核验来源' } },
      ]) response.write(event(item));
      response.write(event({ kind: 'assistant_text', payload: { operation: 'append', text: '最终答案' } }));
      response.write(completed);
      response.end('data: [DONE]\n\n');
    },
  });
  const chunks = [];
  for await (const chunk of adapter.stream({ ...prompt, model: 'local:stream-agent' })) chunks.push(chunk);
  assertContinuousBlocks(chunks, [
    [0, 'reasoning', '先搜索'],
    [1, 'text', '正在搜索。'],
    [2, 'reasoning', '工具 search 正在调用。工具 search 已完成。'],
    [3, 'text', '继续读取。'],
    [4, 'reasoning', '工具 read 正在调用。工具 read 已完成。已核验来源'],
    [5, 'text', '最终答案'],
  ]);
});

test('Codex intermediate text does not suppress later tools, reasoning or final text', async () => {
  const adapter = createDshRuntimeAdapter({
    codexRuntime: { async *stream() {
      yield { type: 'reasoning', text: '计划' };
      yield { type: 'text', text: '处理中' };
      yield { type: 'tool', phase: 'started', name: 'search' };
      yield { type: 'tool', phase: 'completed', name: 'search' };
      yield { type: 'reasoning', text: '已核验' };
      yield { type: 'text', text: '最终回答' };
      yield { type: 'reasoning', text: '补充说明' };
    } },
  });
  const chunks = [];
  for await (const chunk of adapter.stream({ ...prompt, model: 'local:codex-agent', studioRuntime: 'codex' })) chunks.push(chunk);
  assertContinuousBlocks(chunks, [
    [0, 'reasoning', '计划'], [1, 'text', '处理中'],
    [2, 'reasoning', '工具 search 正在调用。工具 search 已完成。已核验'],
    [3, 'text', '最终回答'], [4, 'reasoning', '补充说明'],
  ]);
});

test('Codex completed text is persisted through the bound memory adapter', async () => {
  let written;
  const adapter = createDshRuntimeAdapter({
    codexResourceContext: async () => ({
      writeMemory: async text => { written = text; return { accepted: true }; },
    }),
    codexRuntime: { async *stream() { yield { type: 'text', text: '已记住你的偏好' }; } },
  });
  for await (const _chunk of adapter.stream({ ...prompt, model: 'local:codex-memory-agent', studioRuntime: 'codex', sessionId: 'memory-session' })) {}
  assert.equal(written, '已记住你的偏好');
});
