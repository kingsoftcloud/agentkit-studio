import test from 'node:test';
import assert from 'node:assert/strict';
import { chatToResponses, createResponsesStreamTransformer, responsesToChat, UnsupportedToolsError } from '../src/model-proxy.mjs';
import { prepareCodexProxyRequest } from '../src/codex-proxy-tools.mjs';

test('Responses request preserves multimodal input and maps Kspmas-compatible fields', () => {
  const result = responsesToChat({
    model: 'deepseek-v4.1-flash',
    instructions: 'You are concise.',
    input: [{ type: 'message', role: 'user', content: [
      { type: 'input_text', text: 'What is in this image?' },
      { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'high' },
    ] }],
    max_output_tokens: 128,
    reasoning: { effort: 'high' },
    text: { format: { type: 'json_schema', name: 'answer', schema: { type: 'object' }, strict: true } },
    tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } }],
    tool_choice: { type: 'function', name: 'lookup' },
  });
  assert.deepEqual(result.messages[0], { role: 'system', content: 'You are concise.' });
  assert.deepEqual(result.messages[1].content, [
    { type: 'text', text: 'What is in this image?' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: 'high' } },
  ]);
  assert.equal(result.max_tokens, 128);
  assert.equal(result.reasoning_effort, 'high');
  assert.deepEqual(result.tool_choice, { type: 'function', function: { name: 'lookup' } });
  assert.equal(result.response_format.json_schema.name, 'answer');
});

test('unsupported Responses tools fail closed instead of being dropped', () => {
  assert.throws(() => responsesToChat({ model: 'x', input: 'hi', tools: [{ type: 'web_search_preview' }] }), UnsupportedToolsError);
});

test('Chat response restores reasoning, multimodal output and parallel tool calls', () => {
  const result = chatToResponses({
    id: 'chat-1', model: 'g', created: 123,
    choices: [{ finish_reason: 'stop', message: {
      reasoning_content: 'short reason',
      content: [{ type: 'text', text: 'answer' }, { type: 'image_url', image_url: { url: 'https://img.test/a.png' } }],
      tool_calls: [
        { id: 'call-a', function: { name: 'lookup', arguments: '{}' } },
        { id: 'call-b', function: { name: 'lookup', arguments: '{"x":1}' } },
      ],
    } }],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.output[0].type, 'reasoning');
  assert.deepEqual(result.output[1].content[1], { type: 'output_image', image_url: { url: 'https://img.test/a.png' } });
  assert.equal(result.output.filter(item => item.type === 'function_call').length, 2);
  assert.equal(result.usage.total_tokens, 7);
});

test('stream transformer keeps interleaved tool calls independent', () => {
  const transformer = createResponsesStreamTransformer({ id: 'resp-1', model: 'g' });
  const first = transformer.handle({ choices: [{ delta: {
    content: 'ok',
    tool_calls: [
      { index: 0, id: 'a', function: { name: 'a', arguments: '{' } },
      { index: 1, id: 'b', function: { name: 'b', arguments: '{' } },
    ],
  } }] });
  const second = transformer.handle({ choices: [{ delta: {
    tool_calls: [
      { index: 0, function: { arguments: '}' } },
      { index: 1, function: { arguments: '"x":1}' } },
    ],
  } }] });
  const last = transformer.finish();
  assert.match(first, /response\.created/);
  assert.match(second + last, /"arguments":"\{\}"/);
  assert.match(second + last, /"arguments":"\{\\"x\\":1\}"/);
  assert.match(last, /response\.completed/);
});

test('Responses stream announces items before deltas and keeps final output, usage and image detail', () => {
  const request = responsesToChat({ model: 'vision', input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AA', detail: 'high' }] }] });
  assert.equal(request.messages[0].content[0].image_url.detail, 'high');
  const t = createResponsesStreamTransformer({ id: 'resp-complete', model: 'vision' });
  const wire = t.handle({ choices: [{ delta: { content: 'Hi' } }] })
    + t.handle({ choices: [{ delta: { content: '!' }, finish_reason: 'length' }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }) + t.finish();
  const events = wire.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  const added = events.findIndex(e => e.type === 'response.output_item.added');
  const delta = events.findIndex(e => e.type === 'response.output_text.delta');
  assert.ok(added >= 0 && added < delta);
  assert.equal(events[delta].output_index, 0);
  const final = events.at(-1).response;
  assert.equal(final.status, 'incomplete');
  assert.equal(final.output[0].content[0].text, 'Hi!');
  assert.equal(final.usage.total_tokens, 6);
});

test('a rejected upstream request exposes only bounded provider identifiers', async () => {
  const { upstreamErrorIdentifiers } = await import('../src/model-proxy-handler.mjs');

  // Machine-readable identifiers survive so the DSH failure contract can
  // classify the turn instead of reporting a bare 400.
  assert.deepEqual(
    upstreamErrorIdentifiers(JSON.stringify({
      error: { code: 'context_length_exceeded', type: 'invalid_request_error', message: 'prompt is too long' },
    })),
    { upstreamCode: 'context_length_exceeded', upstreamType: 'invalid_request_error' },
  );

  // The provider may echo the whole conversation inside `message`; nothing but
  // the short identifier may leave the proxy.
  const echoed = JSON.stringify({
    error: { code: 'invalid_request_error', type: 'invalid_request_error',
      message: 'Authorization: Bearer sk-secret -- user asked: 我的银行卡号是 6222' },
  });
  const identifiers = upstreamErrorIdentifiers(echoed);
  assert.deepEqual(Object.keys(identifiers).sort(), ['upstreamCode', 'upstreamType']);
  assert.equal(JSON.stringify(identifiers).includes('sk-secret'), false);
  assert.equal(JSON.stringify(identifiers).includes('6222'), false);

  // Non-JSON bodies, oversized identifiers and absent codes carry no detail.
  assert.deepEqual(upstreamErrorIdentifiers('<html>Bad Gateway</html>'), {});
  assert.deepEqual(upstreamErrorIdentifiers(''), {});
  assert.deepEqual(upstreamErrorIdentifiers(JSON.stringify({ error: { code: 'x'.repeat(200) } })), {});
  assert.deepEqual(upstreamErrorIdentifiers(undefined), {});
});

test('a rejected upstream request is classified by its provider code', async () => {
  const { dshModelFailure } = await import('../src/model-failure.mjs');

  assert.equal(dshModelFailure({ code: 'MODEL_UPSTREAM_ERROR', message: '模型服务返回 400',
    details: { status: 400, upstreamCode: 'context_length_exceeded' } }).code, 'CONTEXT_WINDOW_EXCEEDED');
  assert.equal(dshModelFailure({ code: 'MODEL_UPSTREAM_ERROR', message: '模型服务返回 400',
    details: { status: 429, upstreamCode: 'rate_limit_exceeded' } }).code, 'RATE_LIMIT');
  assert.equal(dshModelFailure({ code: 'MODEL_UPSTREAM_ERROR', message: '模型服务返回 401',
    details: { status: 401 } }).code, 'AUTH');
  // An unclassified 400 stays an explicit invalid response, never a silent retry.
  assert.equal(dshModelFailure({ code: 'MODEL_UPSTREAM_ERROR', message: '模型服务返回 400',
    details: { status: 400 } }).code, 'INVALID_RESPONSE');
});

// Codex 0.167.2 executes shell commands through `local_shell_call`. Both the
// call and its output must reach the chat request, and the synthetic call id
// used when Codex omits `call_id` must be the one the tool result references —
// otherwise the upstream rejects the turn with "assistant message with
// 'tool_calls' must be followed by tool messages".
test('local_shell_call pairs with its output in the chat request', () => {
  const tools = [{ type: 'function', name: 'shell', description: 'run', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } }];
  const input = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run' }] },
    { type: 'local_shell_call', call_id: 'call_2', action: { type: 'exec', command: ['echo', 'hi'] } },
    { type: 'local_shell_call_output', call_id: 'call_2', output: 'hi' },
  ];
  const ctx = prepareCodexProxyRequest({ model: 'm', input, tools });
  const chat = responsesToChat(ctx.request);
  const calls = chat.messages.flatMap(message => (message.tool_calls || []).map(call => call.id));
  const outputs = chat.messages.filter(message => message.role === 'tool').map(message => message.tool_call_id);
  assert.deepEqual(calls, ['call_2']);
  assert.deepEqual(outputs, ['call_2']);
});

test('a call without call_id still pairs with its output', () => {
  const tools = [{ type: 'function', name: 'shell', description: 'run', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } }];
  const input = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run' }] },
    { type: 'function_call', name: 'shell', arguments: '{"cmd":"echo hi"}' },
    { type: 'function_call_output', output: 'hi' },
  ];
  const ctx = prepareCodexProxyRequest({ model: 'm', input, tools });
  const chat = responsesToChat(ctx.request);
  const calls = chat.messages.flatMap(message => (message.tool_calls || []).map(call => call.id));
  const outputs = chat.messages.filter(message => message.role === 'tool').map(message => message.tool_call_id);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls, outputs);
});
