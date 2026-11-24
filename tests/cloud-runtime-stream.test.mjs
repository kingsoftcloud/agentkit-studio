import test from 'node:test';
import assert from 'node:assert/strict';
import { bindDshAgentRoute, createDshRuntimeAdapter } from '../src/providers/dsh-runtime.mjs';
import { CODEX_TOOL_EVENT } from '../src/providers/codex-tool-events.mjs';
import { createRuntimeResponsesStream } from '../src/runtime-responses-stream.mjs';
import { createAgentEngineClient } from '../src/server-client.mjs';

async function project(events, newline = '\n') {
  const data = events.map(event => `data: ${JSON.stringify(event)}${newline}${newline}`).join('');
  const body = new Response(data).body;
  const adapter = createDshRuntimeAdapter({ cloudClient: { streamAction: async () => ({ body }) } });
  const chunks = [];
  for await (const chunk of adapter.stream({ model: 'cloud:test', messages: [{ role: 'user', content: '检索' }] })) chunks.push(chunk);
  return chunks;
}

test('cloud message completion snapshots preserve interleaved text and reasoning exactly once', async () => {
  const frames = [];
  const stream = createRuntimeResponsesStream({ runId: 'run_interleaved' }, (_type, frame) => frames.push(frame));
  stream.start();
  for (const [index, type, text] of [[0, 'text-delta', '开始。'], [1, 'reasoning-delta', '检查'], [2, 'text-delta', '失败。']]) {
    stream.frame({ kind: 'assistant', value: { type: 'chunk', attemptId: 'one', chunk: { index, type, text } } });
  }
  stream.frame({ kind: 'assistant', value: { type: 'end', attemptId: 'one', outcome: { kind: 'committed', eventType: 'assistant/message' } } });
  stream.complete({ output: '开始。失败。' });
  const chunks = await project(frames);
  assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), '开始。失败。');
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block), [
    { type: 'text', text: '开始。' }, { type: 'reasoning', text: '检查' }, { type: 'text', text: '失败。' },
  ]);
});

test('API-created managed agents persist remote tool cards through RunAgent', async () => {
  for (const runtime of ['codex', 'dsh-native']) {
    const frames = [];
    const writer = createRuntimeResponsesStream({ runId: 'run_managed_tools' }, (_type, event) => frames.push(event));
    writer.start();
    for (const [callId, phase] of [['lookup', 'completed'], ['read', 'failed'], ['pending', 'started']]) {
      const call = { callId, name: callId, arguments: JSON.stringify({ key: callId }) };
      const toolEvent = (type, data) => writer.frame({ kind: 'event', value: { type, data } });
      const content = [{ type: 'text', text: `${callId} result` }];
      if (runtime === 'codex') {
        toolEvent(CODEX_TOOL_EVENT, { ...call, phase: 'started' });
        if (phase !== 'started') toolEvent(CODEX_TOOL_EVENT, { ...call, phase, content });
      } else {
        toolEvent('tool/call', call);
        if (phase !== 'started') toolEvent('tool/result', { message: { source: { callId }, content, isError: phase === 'failed' } });
      }
    }
    writer.complete({ output: '云端回答' });
    const sessionId = `managed-tool-session-${runtime}`;
    const facts = [];
    const release = bindDshAgentRoute(sessionId, { agentId: 'ar-managed-tools', source: 'agentengine-managed-runtime', runtime,
      agent: { session: { append: (...args) => facts.push(args) } } });
    try {
      const adapter = createDshRuntimeAdapter({ cloudClient: { async streamAction(action, request) {
        assert.equal(action, 'RunAgent');
        assert.equal(request.SessionId, sessionId);
        return { body: new Response(frames.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')).body };
      } }, cloudRuntime: () => assert.fail('API-managed route must use RunAgent') });
      const chunks = [];
      for await (const chunk of adapter.stream({ sessionId, messages: [{ role: 'user', content: '检索' }] })) chunks.push(chunk);
      assert.ok(facts.every(([type, , options]) => type === CODEX_TOOL_EVENT && options.ignorable === true && !options.surfaceOp));
      assert.deepEqual(facts.map(([, data]) => [data.name, data.phase]), [
        ['lookup', 'started'], ['lookup', 'completed'], ['read', 'started'], ['read', 'failed'], ['pending', 'started'], ['pending', 'failed'],
      ]);
      assert.equal(facts[1][1].callId, facts[0][1].callId);
      assert.equal(facts[1][1].arguments, '{"key":"lookup"}');
      assert.equal(facts[1][1].content[0].text, 'lookup result');
      assert.equal(facts[3][1].content[0].text, 'read result');
      assert.equal(facts[5][1].error.code, 'CLOUD_TOOL_OUTCOME_UNKNOWN');
      assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), '云端回答');
      assert.equal(chunks.some(chunk => chunk.type === 'reasoning-delta' || chunk.blockType === 'tool-call'), false);
      assert.equal(chunks.at(-1).reason.kind, 'stop');
    } finally { release(); }
  }
});

test('managed KSXC offers WPS rebind only when a rejected run has a confirmed disconnected account', async () => {
  for (const [runtime, connection, expectedActions] of [
    ['ksxc', 'disconnected', ['RunAgent', 'GetKsxcConnection']],
    ['ksxc', 'connected', ['RunAgent', 'GetKsxcConnection']],
    ['ksxc', 'check-failed', ['RunAgent', 'GetKsxcConnection']],
    ['codex', 'disconnected', ['RunAgent']],
  ]) {
    const actions = [];
    const client = createAgentEngineClient({
      configuration: { resolve: async () => ({ values: { cloudServerUrl: 'http://127.0.0.1:8789' } }) },
      fetchImpl: async (url, init) => {
        const action = url.pathname.split('/').at(-1);
        actions.push(action);
        if (action === 'RunAgent') return Response.json({ Code: 403, Message: '无权执行该操作', RequestId: 'run-req', Data: null });
        assert.deepEqual(JSON.parse(init.body), {});
        if (connection === 'check-failed') return Response.json({ Code: 403, Message: '无法查询连接状态' });
        return Response.json({ Code: 0, Data: { Status: connection } });
      },
    });
    const sessionId = 'managed-rebind-session';
    const release = bindDshAgentRoute(sessionId, { agentId: 'ar-managed-rebind', source: 'agentengine-managed-runtime', runtime,
      agent: { spec: { bindings: { plugins: [] } } } });
    try {
      const adapter = createDshRuntimeAdapter({ cloudClient: client });
      const turn = async () => {
        const chunks = [];
        for await (const chunk of adapter.stream({ sessionId, messages: [{ role: 'user', content: '你好' }] })) chunks.push(chunk);
        return chunks;
      };
      if (runtime === 'ksxc' && connection === 'disconnected') {
        const [chunk] = await turn();
        assert.equal(chunk.type, 'finish');
        assert.equal(chunk.reason.kind, 'error');
        assert.equal(chunk.reason.failure.code, 'KSXC_CONNECTION_REQUIRED');
        assert.match(chunk.reason.failure.message, /重新绑定 WPS/);
      } else {
        await assert.rejects(turn, { code: 'SERVER_ACTION_FAILED', status: 403, requestId: 'run-req' });
      }
      assert.deepEqual(actions, expectedActions);
    } finally { release(); }
  }
});

test('identical text in different cloud content parts is not deduplicated', async () => {
  const chunks = await project([
    { type: 'response.output_text.delta', item_id: 'one', content_index: 0, delta: '相同' },
    { type: 'response.output_text.delta', item_id: 'one', content_index: 1, delta: '相同' },
    { type: 'response.output_text.done', item_id: 'one', content_index: 0, text: '相同' },
    { type: 'response.output_text.done', item_id: 'one', content_index: 1, text: '相同' },
    { type: 'response.output_text.done', item_id: 'one', content_index: 1, text: '相同' },
    { type: 'response.completed' },
  ]);
  assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), '相同相同');
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block.text), ['相同', '相同']);
});

test('cloud completion without text preserves streamed content and late corrections cannot rewrite another item', async () => {
  const chunks = await project([
    { type: 'response.output_text.delta', item_id: 'one', delta: '保留' },
    { type: 'response.output_text.done', item_id: 'one' }, { type: 'response.completed' },
  ]);
  assert.equal(chunks.find(chunk => chunk.type === 'block-end').block.text, '保留');
  for (const text of ['更正', '先前补充']) await assert.rejects(() => project([
    { type: 'response.output_text.delta', item_id: 'one', delta: '先前' },
    { type: 'response.output_text.delta', item_id: 'two', delta: '当前' },
    { type: 'response.output_text.done', item_id: 'one', text },
    { type: 'response.completed' },
  ]), { code: 'CLOUD_STREAM_ITEM_CHANGED' });
});

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
