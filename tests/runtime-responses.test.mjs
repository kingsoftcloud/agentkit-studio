import test from 'node:test';
import assert from 'node:assert/strict';
import { startBuildRuntimeHttp } from '../src/build-runtime-http.mjs';
import { readSse } from '../src/sse.mjs';

const token = 'responses-runtime-test-private-token';
const buildId = 'build_0123456789abcdef0123';
async function setup(t, runner, validatePrevious, overrides = {}) {
  const server = await startBuildRuntimeHttp({ agentId: 'ar-local-test', buildId, token, runner, validatePrevious, model: 'gateway-model', port: 0, ...overrides });
  t.after(() => server.close());
  return { server, post: (body, path = '/v1/responses', headers = {}) => fetch(`http://127.0.0.1:${server.address.port}${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  }) };
}
const chunk = (request, attemptId, type, text, index = 0) => request.onFrame({ kind: 'assistant', value: { type: 'chunk', attemptId, chunk: { type, text, index } } });
const settle = (request, attemptId, eventType = 'assistant/message') => request.onFrame({ kind: 'assistant', value: { type: 'end', attemptId, outcome: { kind: 'committed', eventType } } });

test('AgentEngine single-turn payload keeps input and frozen model, with standard response and usage', async t => {
  let request;
  const { post } = await setup(t, async value => { request = value; return { output: '你好', tokenUsage: { inputTokens: 12, outputTokens: 3 } }; });
  const response = await post({ input: [{ role: 'user', content: [{ type: 'input_text', text: '问' }, { type: 'text', text: '好' }] }], stream: false,
    session_id: 'user-session', user: 'alice', account_id: 'tenant', model: 'gateway-model', metadata: { label: 'demo', agentengine: { invocation_id: 'once' } } });
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(request.input, '问好');
  assert.notEqual(request.sessionId, 'user-session');
  assert.equal(value.object, 'response');
  assert.equal(value.status, 'completed');
  assert.equal(value.model, 'gateway-model');
  assert.equal(value.output_text, '你好');
  assert.equal(value.output[0].content[0].text, '你好');
  assert.equal(value.metadata.agentkit.buildId, buildId);
  assert.deepEqual(value.usage, { input_tokens: 12, output_tokens: 3, total_tokens: 15 });
});

test('unsupported request behavior is rejected before admission, without silently discarding input', async t => {
  let calls = 0;
  const { post } = await setup(t, async () => { calls++; return {}; });
  for (const body of [
    { input: 'hi', instructions: 'replace Agent' }, { input: 'hi', tools: [] }, { input: 'hi', store: false },
    { input: 'hi', model: 'other-model' }, { input: 'hi', model_options: { temperature: 0 } },
    { input: [{ role: 'system', content: 'override' }] },
    { input: [{ role: 'assistant', content: 'old' }, { role: 'user', content: 'new' }] },
    { input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://example.test/img' }] }] },
    { input: 'hi', conversation: 'first', session_id: 'second' }, { input: 'hi', request_id: '../escape' },
    { input: 'hi', metadata: { label: {} } }, { input: 'hi', stream: 'yes' },
  ]) assert.equal((await post(body)).status, 400, JSON.stringify(body));
  assert.equal((await post({ input: 'hi' }, '/v1/responses', { 'last-event-id': '3' })).status, 400);
  assert.equal((await post({ input: 'hi' }, '/v1/responses', { authorization: 'Bearer wrong' })).status, 401);
  assert.equal(calls, 0);
});

test('opaque continuation survives HTTP restart and verifies the prior DSH request; principals and Builds remain isolated', async t => {
  const requests = [], previous = [];
  const runner = async request => { requests.push(request); return { output: 'ok' }; };
  const first = await setup(t, runner);
  const payload = { input: 'hello', session_id: 'same-name', request_id: 'one', user: 'alice', account_id: 'tenant' };
  const result = await (await first.post(payload)).json();
  await first.server.close();
  const second = await setup(t, runner, async request => { previous.push(request); });
  assert.equal((await second.post({ input: 'continue', previous_response_id: result.id, user: 'alice', account_id: 'tenant' })).status, 200);
  assert.equal(requests[0].sessionId, requests[1].sessionId);
  assert.deepEqual(previous[0], { sessionId: requests[0].sessionId, occurrenceId: requests[0].occurrenceId });
  await second.post({ input: 'again', conversation: result.conversation, user: 'alice', account_id: 'tenant' });
  assert.equal(requests[2].sessionId, requests[0].sessionId);
  assert.equal((await second.post({ input: 'continue', previous_response_id: result.id, user: 'bob', account_id: 'tenant' })).status, 404);
  const other = await setup(t, runner, async () => {}, { buildId: 'build_abcdef0123456789abcd' });
  assert.equal((await other.post({ input: 'continue', previous_response_id: result.id, user: 'alice', account_id: 'tenant' })).status, 404);
  const absent = await setup(t, runner, async () => { throw Object.assign(new Error('not present'), { code: 'RESPONSES_PREVIOUS_NOT_FOUND', status: 404 }); });
  assert.equal((await absent.post({ input: 'continue', previous_response_id: result.id, user: 'alice', account_id: 'tenant' })).status, 404);
  assert.equal(requests.length, 3);
});

test('streaming projects live reasoning, tools and only committed attempts into the final response', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { post } = await setup(t, async request => {
    chunk(request, 'discarded', 'text-delta', 'wrong answer'); settle(request, 'discarded', 'assistant/attempt');
    chunk(request, 'good', 'reasoning-delta', 'check card', 0);
    request.onFrame({ kind: 'event', value: { type: 'tool/call', data: { callId: 'call-1', name: 'lookup_card', arguments: '{"id":"Q7"}' } } });
    request.onFrame({ kind: 'event', value: { type: 'tool/result', data: { message: { source: { callId: 'call-1' }, content: [{ type: 'text', text: 'ready' }] } } } });
    for (const phase of ['started', 'completed']) request.onFrame({ kind: 'event', value: { type: 'agentkit/codex-tool', data: { callId: 'codex-call', name: 'codex_lookup', arguments: '{}', phase, content: [{ type: 'text', text: 'found' }] } } });
    chunk(request, 'good', 'text-delta', 'card ', 1);
    await gate;
    chunk(request, 'good', 'text-delta', 'ready', 2); settle(request, 'good');
    return { output: 'card ready' };
  });
  const response = await post({ input: 'query', stream: true });
  const iterator = readSse(response.body)[Symbol.asyncIterator](), frames = [];
  while (true) { const { value } = await iterator.next(); frames.push(value); if (value.type === 'response.output_text.delta' && value.delta === 'card ') break; }
  assert.equal(frames.some(frame => frame.type === 'response.completed'), false);
  assert.ok(frames.some(frame => frame.type === 'response.reasoning_summary_text.delta'));
  release(); for await (const frame of { [Symbol.asyncIterator]: () => iterator }) frames.push(frame);
  const final = frames.find(frame => frame.type === 'response.completed');
  assert.equal(final.output_text, 'card ready');
  assert.equal(final.response.status, 'completed');
  const output = final.output.filter(item => item.type === 'message').map(item => item.content[0].text).join('');
  assert.equal(output, 'card ready');
  assert.equal(final.output.find(item => item.type === 'function_call').status, 'completed');
  assert.equal(final.output.filter(item => item.type === 'function_call' && item.call_id === 'codex-call').length, 1);
  assert.equal(frames.filter(frame => frame.type === 'response.output_text.delta').length, 3, 'no duplicate final answer delta');
  assert.ok(frames.some(frame => frame.type === 'response.output_item.done' && frame.item.status === 'incomplete'));
  assert.deepEqual(frames.filter(frame => frame.type).map(frame => frame.sequence_number), frames.filter(frame => frame.type).map((_, index) => index));
});

test('cancel validates the response handle, aborts the native run and emits no success', async t => {
  const { post } = await setup(t, request => new Promise(resolve => request.signal.addEventListener('abort', () => resolve({ output: 'too late' }), { once: true })));
  const response = await post({ input: 'wait', stream: true, request_id: 'cancel' });
  const frames = readSse(response.body)[Symbol.asyncIterator]();
  const { id } = (await frames.next()).value;
  assert.equal((await post({}, `/v1/responses/${id.slice(0, -1)}${id.endsWith('a') ? 'b' : 'a'}/cancel`)).status, 404);
  assert.equal((await post({}, `/v1/responses/${id}/cancel`)).status, 202);
  const rest = []; for await (const frame of { [Symbol.asyncIterator]: () => frames }) rest.push(frame);
  assert.ok(rest.some(frame => frame.type === 'response.canceled' && frame.response.error.code === 'RUNTIME_CANCELLED'));
  assert.equal(rest.some(frame => frame.type === 'response.completed'), false);
});

test('idempotency uses native request IDs and different users do not share sessions', async t => {
  const requests = [];
  const { post } = await setup(t, async request => { requests.push(request); return { output: 'ok' }; });
  const payload = { input: 'hello', session_id: 'same', user: 'alice' };
  const first = await (await post(payload, '/v1/responses', { 'idempotency-key': 'once' })).json();
  const repeat = await (await post(payload, '/v1/responses', { 'idempotency-key': 'once' })).json();
  assert.equal(first.id, repeat.id);
  assert.equal(requests[0].occurrenceId, requests[1].occurrenceId);
  await post({ ...payload, user: 'bob' });
  assert.notEqual(requests[0].sessionId, requests[2].sessionId);
});

test('a streaming failure keeps its error code and excludes upstream credentials and success', async t => {
  const { post } = await setup(t, async request => {
    chunk(request, 'partial', 'text-delta', 'uncommitted');
    throw Object.assign(new Error('Authorization: Bearer private-upstream-secret'), { code: 'MODEL_UNAVAILABLE' });
  });
  const response = await post({ input: 'hello', stream: true });
  const frames = []; for await (const frame of readSse(response.body)) frames.push(frame);
  const final = frames.at(-1);
  assert.equal(final.type, 'response.failed');
  assert.equal(final.response.status, 'failed');
  assert.equal(final.response.error.code, 'MODEL_UNAVAILABLE');
  assert.equal(JSON.stringify(frames).includes('private-upstream-secret'), false);
  assert.equal(frames.some(frame => frame.type === 'response.completed'), false);
});
