import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodexModelProxy } from '../src/providers/codex-model-proxy.mjs';
import { prepareCodexProxyRequest } from '../src/codex-proxy-tools.mjs';
import { responsesToChat, chatToResponses, createResponsesStreamTransformer } from '../src/model-proxy.mjs';

const events = wire => wire.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
const profile = { baseUrl: 'https://chat.example/v1', apiKey: 'upstream-secret', modelName: 'bound-model' };

test('Codex proxy preserves namespace, custom tool input, reasoning and multi-round tool history', () => {
  const definitions = [{ type: 'namespace', name: 'files', tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }] },
    { type: 'custom', name: 'apply_patch', format: { type: 'text' } }];
  const context = prepareCodexProxyRequest({ tools: definitions });
  const [lookup, patch] = context.request.tools.map(tool => tool.name);
  const output = chatToResponses({ choices: [{ message: { tool_calls: [
    { id: 'a', function: { name: lookup, arguments: '{"file":"a"}' } },
    { id: 'b', function: { name: patch, arguments: JSON.stringify({ input: '*** Begin Patch\n*** End Patch' }) } },
  ] } }] }, { toolContext: context }).output;
  assert.equal(output[0].namespace, 'files'); assert.equal(output[0].name, 'lookup');
  assert.equal(output[1].type, 'custom_tool_call'); assert.equal(output[1].input, '*** Begin Patch\n*** End Patch');
  const second = prepareCodexProxyRequest({ tools: definitions, input: [
    { type: 'message', role: 'user', content: 'fix it' },
    { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Inspect before patching.' }] },
    ...output,
    { type: 'function_call_output', call_id: 'a', output: 'contents' },
    { type: 'custom_tool_call_output', call_id: 'b', output: 'applied' },
  ] });
  const history = responsesToChat(second.request).messages;
  assert.equal(history[1].reasoning_content, 'Inspect before patching.');
  assert.deepEqual(history[1].tool_calls.map(call => call.function.name), [lookup, patch]);
  assert.equal(history[3].tool_call_id, 'b');
  assert.deepEqual(JSON.parse(history[1].tool_calls[1].function.arguments), { input: output[1].input });
});

test('streaming proxy restores custom and namespace calls even when names and arguments are fragmented', () => {
  const context = prepareCodexProxyRequest({ tools: [
    { type: 'custom', name: 'apply_patch' }, { type: 'namespace', name: 'mcp', tools: [{ type: 'function', name: 'search' }] },
  ] });
  const [patch, search] = context.request.tools.map(tool => tool.name);
  const stream = createResponsesStreamTransformer({ toolContext: context });
  const wire = stream.handle({ choices: [{ delta: { tool_calls: [
    { index: 0, id: 'a', function: { name: patch.slice(0, 10), arguments: '{"input":' } },
    { index: 1, id: 'b', function: { name: search, arguments: '{"q":' } },
  ] } }] }) + stream.handle({ choices: [{ delta: { tool_calls: [
    { index: 0, function: { name: patch.slice(10), arguments: '"patch\\ntext"}' } },
    { index: 1, function: { arguments: '"news"}' } },
  ] }, finish_reason: 'tool_calls' }] }) + stream.finish();
  const all = events(wire), output = all.at(-1).response.output;
  assert.equal(output[0].type, 'custom_tool_call'); assert.equal(output[0].input, 'patch\ntext');
  assert.equal(output[1].name, 'search'); assert.equal(output[1].namespace, 'mcp');
  assert.ok(all.some(event => event.type === 'response.custom_tool_call_input.done'));
  assert.ok(all.findIndex(event => event.type === 'response.output_item.added' && event.output_index === 0) < all.findIndex(event => event.type === 'response.custom_tool_call_input.delta'));
  assert.throws(() => context.restore({ type: 'function_call', name: 'invented', arguments: '{}' }), { code: 'CODEX_TOOL_CONVERSION_FAILED' });
});

test('loopback proxy authenticates, pins model and credential, and closes after use', async () => {
  const calls = [];
  const proxy = await createCodexModelProxy({ profile, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return Response.json({ model: 'bound-model', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
  } });
  const url = `${proxy.baseUrl}/responses`;
  try {
    assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${proxy.apiKey}`, Origin: 'https://untrusted.example' }, body: '{}' })).status, 401);
    const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${proxy.apiKey}` }, body: JSON.stringify({ model: 'other-model', input: 'hello' }) });
    assert.equal(response.status, 200); assert.equal((await response.json()).output[0].content[0].text, 'ok');
    assert.equal(calls.length, 1); assert.equal(calls[0].url, 'https://chat.example/v1/chat/completions');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer upstream-secret');
    assert.equal(JSON.parse(calls[0].options.body).model, 'bound-model');
    assert.notEqual(proxy.apiKey, profile.apiKey);
  } finally { await proxy.close(); }
  await assert.rejects(fetch(url));
});

test('EOF without a completion marker is an error, not a successful Responses result', async () => {
  const proxy = await createCodexModelProxy({ profile, fetchImpl: async () => new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }) });
  try {
    const response = await fetch(`${proxy.baseUrl}/responses`, { method: 'POST', headers: { Authorization: `Bearer ${proxy.apiKey}` }, body: JSON.stringify({ input: 'hi', stream: true }) });
    const wire = await response.text();
    assert.match(wire, /UPSTREAM_STREAM_TRUNCATED/); assert.doesNotMatch(wire, /response.completed/);
  } finally { await proxy.close(); }
});

test('disconnect cancels an in-flight upstream request', async () => {
  let cancelled, started;
  const cancelledPromise = new Promise(resolve => { cancelled = resolve; });
  const startedPromise = new Promise(resolve => { started = resolve; });
  const proxy = await createCodexModelProxy({ profile, fetchImpl: async (_url, { signal }) => {
    started(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { cancelled(); reject(new Error('upstream-secret')); }, { once: true }));
  } });
  const controller = new AbortController();
  const request = fetch(`${proxy.baseUrl}/responses`, { method: 'POST', headers: { Authorization: `Bearer ${proxy.apiKey}` }, body: JSON.stringify({ input: 'hi', stream: true }), signal: controller.signal });
  try {
    await startedPromise; controller.abort(); await assert.rejects(request); await cancelledPromise;
  } finally { await proxy.close(); }
});

test('tool search output and raw custom input survive the next model request', () => {
  const context = prepareCodexProxyRequest({ tools: [{ type: 'tool_search' }, { type: 'custom', name: 'patch' }] });
  const name = context.request.tools[0].name;
  const call = context.restore({ type: 'function_call', call_id: 'search-1', name, arguments: '{"query":"lookup","limit":2}' });
  assert.equal(call.type, 'tool_search_call'); assert.equal(call.execution, 'client');
  const second = prepareCodexProxyRequest({ tools: [{ type: 'tool_search' }], input: [call, { type: 'tool_search_output', call_id: 'search-1', tools: [{ type: 'function', name: 'lookup' }] }] });
  const messages = responsesToChat(second.request).messages;
  assert.equal(messages[0].tool_calls[0].function.name, name);
  assert.equal(messages[1].tool_call_id, 'search-1'); assert.match(messages[1].content, /lookup/);
  assert.throws(() => context.restore({ type: 'function_call', name: context.request.tools[1].name, arguments: '{"input":123}' }), { code: 'CODEX_TOOL_CONVERSION_FAILED' });
  assert.throws(() => responsesToChat(prepareCodexProxyRequest({ tools: [{ type: 'web_search' }] }).request), { code: 'UNSUPPORTED_TOOL_TYPE' });
});

test('coded upstream errors and invalid JSON cannot echo credentials', async () => {
  for (const fetchImpl of [
    async () => { throw Object.assign(new Error('upstream-secret'), { code: 'ECONNRESET' }); },
    async () => new Response('upstream-secret'),
    async () => new Response('upstream-secret', { status: 401 }),
  ]) {
    const proxy = await createCodexModelProxy({ profile, fetchImpl });
    try {
      const response = await fetch(`${proxy.baseUrl}/responses`, { method: 'POST', headers: { Authorization: `Bearer ${proxy.apiKey}` }, body: '{"input":"hi"}' });
      assert.ok(response.status >= 400); assert.doesNotMatch(await response.text(), /upstream-secret/);
    } finally { await proxy.close(); }
  }
});

test('request metrics measure the actual outbound body without retaining prompt or credential content', async () => {
  const metrics = []; let body;
  const proxy = await createCodexModelProxy({ profile, onRequestMetrics: value => metrics.push(value), fetchImpl: async (_url, options) => {
    body = options.body;
    return Response.json({ choices: [{ message: { content: 'ok' } }] });
  } });
  try {
    await fetch(`${proxy.baseUrl}/responses`, { method: 'POST', headers: { Authorization: `Bearer ${proxy.apiKey}` }, body: JSON.stringify({ instructions: 'private system instruction', input: '你好 private-input', tools: [{ type: 'function', name: 'private-tool', description: 'private-description', parameters: { type: 'object' } }] }) });
    assert.equal(metrics.length, 1);
    assert.equal(metrics[0].requestChars, body.length);
    assert.equal(metrics[0].requestBytes, Buffer.byteLength(body));
    assert.equal(metrics[0].toolsChars, JSON.stringify(JSON.parse(body).tools).length);
    assert.equal(metrics[0].toolCount, 1);
    assert.ok(metrics[0].instructionsChars > 0);
    assert.doesNotMatch(JSON.stringify(metrics), /private-|upstream-secret|private system/);
  } finally { await proxy.close(); }
});
