import test from 'node:test';
import assert from 'node:assert/strict';
import { createDshRuntimeAdapter } from '../src/providers/dsh-runtime.mjs';

async function project(events, newline = '\n') {
  const data = events.map(event => `data: ${JSON.stringify(event)}${newline}${newline}`).join('');
  const body = new Response(data).body;
  const adapter = createDshRuntimeAdapter({ cloudClient: { streamAction: async () => ({ body }) } });
  const chunks = [];
  for await (const chunk of adapter.stream({ model: 'cloud:test', messages: [{ role: 'user', content: '检索' }] })) chunks.push(chunk);
  return chunks;
}

test('cloud replacement snapshots do not duplicate streamed answers', async () => {
  const chunks = await project([
    { type: 'response.output_text.delta', item_id: 'one', delta: '你好' },
    { type: 'response.output_text.delta', item_id: 'one', delta: '世界' },
    { type: 'response.output_text.delta', item_id: 'one', delta: '你好世界', replace: true },
    { type: 'response.output_text.done', item_id: 'one', text: '你好世界' },
    { type: 'response.completed', output_text: '你好世界' },
  ]);
  assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), '你好世界');
  assert.equal(chunks.find(chunk => chunk.type === 'block-end').block.text, '你好世界');
});

test('cloud CRLF frames preserve text and complete the native turn', async () => {
  const chunks = await project([
    { type: 'response.output_text.delta', delta: '实际回答' },
    { type: 'response.output_text.done', text: '实际回答' },
    { type: 'response.completed' },
  ], '\r\n');
  assert.equal(chunks.at(-1).type, 'finish');
  assert.equal(chunks.find(chunk => chunk.type === 'block-end').block.text, '实际回答');
});

test('cloud SSE event names complete a response when the payload omits type', async () => {
  const data = [
    'event: response.output_text.delta\ndata: {"delta":"事件回答"}',
    'event: response.output_text.done\ndata: {"text":"事件回答"}',
    'event: response.completed\ndata: {"output_text":"事件回答"}',
  ].join('\n\n') + '\n\n';
  const adapter = createDshRuntimeAdapter({ cloudClient: {
    streamAction: async () => ({ body: new Response(data).body }),
  } });
  const chunks = [];
  for await (const chunk of adapter.stream({ model: 'cloud:test', messages: [{ role: 'user', content: '检索' }] })) chunks.push(chunk);
  assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), '事件回答');
  assert.equal(chunks.at(-1).type, 'finish');
});

test('cloud bridge sends the human prompt rather than a trailing DSH runtime context', async () => {
  let sent;
  const adapter = createDshRuntimeAdapter({ cloudClient: {
    streamAction: async (_action, payload) => {
      sent = payload;
      return { body: new Response('data: {"type":"response.completed"}\n\n').body };
    },
  } });
  for await (const _chunk of adapter.stream({ model: 'cloud:test', messages: [
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '金山云 AgentEngine' }] },
    { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'Current runtime context. 文件沙箱与权限。' }] },
  ] })) {}
  assert.deepEqual(sent.Messages, [{ role: 'user', content: '金山云 AgentEngine' }]);
});

test('cloud platform memory writes after a completed RunAgent turn', async () => {
  let written;
  const adapter = createDshRuntimeAdapter({
    cloudClient: {
      streamAction: async () => ({ body: new Response([
        'data: {"type":"response.output_text.delta","delta":"云端回答"}',
        'data: {"type":"response.output_text.done","text":"云端回答"}',
        'data: {"type":"response.completed"}',
      ].join('\n\n') + '\n\n').body }),
    },
    resourceAdapter: {
      searchMemory: async () => [],
      writeMemory: async (_id, _userId, messages) => { written = messages; return { accepted: true }; },
    },
  });
  const agent = {
    metadata: { id: 'cloud-memory-agent', local: false },
    spec: {
      memory: { enabled: true, write: { mode: 'candidate' } },
      bindings: { plugins: [{ config: { binding: { resource: { kind: 'memory-instance', id: 'memory-1' } } } }] },
    },
  };
  for await (const _chunk of adapter.stream({
    model: 'cloud:cloud-memory-agent', sessionId: 'cloud-memory-session',
    messages: [{ role: 'user', content: '请记住我喜欢简洁回答' }], agent,
  })) {}
  assert.deepEqual(written?.map(item => item.content), ['请记住我喜欢简洁回答', '云端回答']);
});

test('cloud platform memory binding writes without a local memory projection', async () => {
  let written;
  const adapter = createDshRuntimeAdapter({
    cloudClient: {
      streamAction: async () => ({ body: new Response([
        'data: {"type":"response.output_text.delta","delta":"已记住"}',
        'data: {"type":"response.completed"}',
      ].join('\n\n') + '\n\n').body }),
    },
    resourceAdapter: {
      searchMemory: async () => [],
      writeMemory: async (_id, _userId, messages) => { written = messages; return { accepted: true }; },
    },
  });
  const agent = {
    metadata: { id: 'cloud-memory-agent-no-local-projection', local: false },
    spec: {
      bindings: { plugins: [{ config: { binding: { resource: { kind: 'memory-instance', id: 'memory-2' } } } }] },
    },
  };
  for await (const _chunk of adapter.stream({
    model: 'cloud:cloud-memory-agent-no-local-projection', sessionId: 'cloud-memory-session-2',
    messages: [{ role: 'user', content: '请记住我喜欢简洁回答' }], agent,
  })) {}
  assert.deepEqual(written?.map(item => item.content), ['请记住我喜欢简洁回答', '已记住']);
});
