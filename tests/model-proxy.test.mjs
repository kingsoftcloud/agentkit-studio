import test from 'node:test';
import assert from 'node:assert/strict';
import { chatToResponses, createResponsesStreamTransformer, responsesToChat, UnsupportedToolsError } from '../src/model-proxy.mjs';

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
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
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
