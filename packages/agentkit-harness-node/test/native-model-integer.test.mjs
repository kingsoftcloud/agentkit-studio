import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createNativeModelPort } from '../src/native/model-port.mjs';
import { canonical, stringifyModelJson, configure } from '../../agentkit-harness-core/dist/index.mjs';

const exact = 9007199254740993n, argumentsText = '{"id":9007199254740993}';
const json = stringifyModelJson;
const sse = value => `data: ${json(value)}\n\n`;
function reply(protocol, stream, wholeInput) {
  if (protocol === 'openai-chat') {
    const call = { id: 'call', type: 'function', function: { name: 'probe', arguments: argumentsText } };
    const usage = { prompt_tokens: 1, completion_tokens: 1 };
    return stream ? sse({ id: 'msg', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...call }] }, finish_reason: 'tool_calls' }], usage }) + 'data: [DONE]\n\n'
      : json({ id: 'msg', choices: [{ message: { role: 'assistant', content: '', tool_calls: [call] }, finish_reason: 'tool_calls' }], usage });
  }
  if (protocol === 'openai-responses') {
    const item = { id: 'item', type: 'function_call', call_id: 'call', name: 'probe', arguments: argumentsText };
    const response = { id: 'response', model: 'model', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1 } };
    return stream ? [
      { type: 'response.created', response: { id: 'response', model: 'model' } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'item', delta: argumentsText },
      { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'item', arguments: argumentsText },
      { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response },
    ].map(sse).join('') : json(response);
  }
  const block = { type: 'tool_use', id: 'call', name: 'probe', input: { id: exact } };
  return stream ? [
    { type: 'message_start', message: { id: 'msg', model: 'model', role: 'assistant', content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: wholeInput ? block : { ...block, input: {} } },
    ...(wholeInput ? [] : [{ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: argumentsText } }]),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } }, { type: 'message_stop' },
  ].map(sse).join('') : json({ id: 'msg', type: 'message', role: 'assistant', model: 'model', content: [block],
    stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } });
}

for (const protocol of ['openai-chat', 'openai-responses', 'anthropic-messages']) for (const mode of
  protocol === 'anthropic-messages' ? ['buffered', 'stream-delta', 'stream-whole-input'] : ['buffered', 'stream-delta']) {
  test(`${protocol} ${mode}: actual HTTP parse and private replay retain the exact integer`, async t => {
    const requests = [], stream = mode !== 'buffered';
    const server = http.createServer(async (request, response) => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      requests.push(Buffer.concat(chunks).toString('utf8'));
      response.writeHead(200, { 'content-type': stream ? 'text/event-stream' : 'application/json' });
      response.end(reply(protocol, stream, mode === 'stream-whole-input'));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const profile = configure({ hostBindingDigest: 'numeric-host/v1', profile: { profileId: 'numeric', profileVersion: '1', providerFamily: 'fixture',
      compatibilityDigest: 'numeric/v1', providerReplayMode: protocol === 'anthropic-messages' ? 'anthropic_content' : 'reasoning_content' },
      contract: { objective: 'Return id' } }).profile;
    const port = createNativeModelPort({ resolveProfile: async () => ({ protocol, baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      apiKey: 'fixture-key', model: 'model' }) });
    const request = { scope: { tenantId: 't', workspaceId: 'w', userId: 'u', agentId: 'a' }, runId: 'r', sessionId: 's', turnId: 't', buildId: 'b',
      parentRunId: null, taskChainId: 'chain', operationKey: 'op', signal: new AbortController().signal, profile,
      messages: [{ role: 'user', content: 'Return id' }], tools: [{ name: 'probe', description: 'Probe id', parameters: { type: 'object' } }], finalizationOnly: false };
    const result = await port.generate(request, () => {});
    assert.equal(result.kind, 'tool_calls', result.text); assert.equal(result.toolCalls[0].arguments.id, exact);
    const again = await port.generate({ ...request, operationKey: 'op2', messages: [...request.messages,
      { role: 'assistant', content: result.text, toolCalls: result.toolCalls, ...(result.providerReplay ? { providerReplay: result.providerReplay } : {}) },
      { role: 'tool', callId: result.toolCalls[0].callId, name: 'probe', content: canonical({ id: exact }) }] }, () => {});
    assert.equal(again.kind, 'tool_calls'); assert.equal(requests.length, 2);
    assert.ok(requests[1].includes('9007199254740993')); assert.equal(requests[1].includes('9007199254740992'), false);
    if (protocol === 'anthropic-messages') assert.ok(requests[1].includes('"id":9007199254740993'));
  });
}
