// Protocol-conformance tests for the native model adapter over a real local
// HTTP server streaming controlled protocol bytes. These exercise the wire
// normalization, SSE framing, tool assembly, error/refusal normalization,
// Retry-After, private replay and media projection — never live models and
// never mocking fetch. Fake credentials only.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createNativeModelPort } from '../src/native/model-port.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- fixtures -------------------------------------------------------------

function makeProfile(overrides = {}) {
  return {
    profileId: 'mock', profileVersion: '1', providerFamily: 'openai-compatible',
    maxOutputTokens: 8192, contextWindow: 128000,
    maxRetries: 2, maxProviderRetries: 3, maxContinuations: 3,
    requestTimeoutMs: 0, retryInitialDelayMs: 500, retryMaxDelayMs: 8000,
    retryBackoffMultiplier: 2, rateLimitCooldownMs: 60000,
    providerReplayMode: 'none', compatibilityDigest: '',
    ...overrides,
  };
}

function makeRequest({ profile, messages, tools, finalizationOnly = false, signal } = {}) {
  return {
    scope: { tenantId: 't', workspaceId: 'w', userId: 'u', agentId: 'a' },
    runId: 'r', sessionId: 's', turnId: 'tn', buildId: 'b', parentRunId: null, taskChainId: 'tc',
    operationKey: 'op', signal: signal || new AbortController().signal,
    profile: profile || makeProfile(),
    messages: messages || [{ role: 'user', content: 'Task' }],
    tools: tools == null ? [makeTool('read')] : tools,
    finalizationOnly,
  };
}

function makeTool(name) {
  return {
    name, description: `tool ${name}`, parameters: { type: 'object' },
    readOnly: true, concurrentSafe: false, permissions: [], timeoutMs: 5000,
    contextRole: 'none', observationRole: 'none', progressObservation: false, contextRetention: 'normal',
  };
}

function makePort({ port, protocol, profile, resolveProfile, fetchImpl, maxResponseBytes, idleTimeoutMs, bindingExtra }) {
  const binding = {
    protocol,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: 'fake-key',
    model: 'fake-model',
    ...(bindingExtra || {}),
  };
  return createNativeModelPort({
    resolveProfile: resolveProfile || (async () => binding),
    fetchImpl: fetchImpl || fetch,
    maxResponseBytes: maxResponseBytes || 4 * 1024 * 1024,
    idleTimeoutMs: idleTimeoutMs || 4000,
  });
}

// --- local HTTP server that streams controlled bytes ----------------------

function startServer(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('utf8');
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    let spec;
    try { spec = await handler(req, body, requests.length - 1); }
    catch (e) { spec = { status: 500, body: String(e && e.message || e) }; }
    const status = spec.status || 200;
    const headers = spec.headers || {};
    try { res.writeHead(status, headers); res.flushHeaders(); } catch { return; }
    const bodySpec = spec.body;
    if (bodySpec == null) { try { res.end(); } catch { } return; }
    if (typeof bodySpec === 'string' || Buffer.isBuffer(bodySpec)) { try { res.end(bodySpec); } catch { } return; }
    try {
      for await (const item of bodySpec) {
        if (item && typeof item === 'object' && !Buffer.isBuffer(item) && 'delay' in item) {
          await sleep(item.delay);
          continue;
        }
        if (res.writableEnded) break;
        res.write(item);
      }
    } catch { /* client disconnected */ }
    try { if (!res.writableEnded) res.end(); } catch { /* ignore */ }
  });
  server.keepAliveTimeout = 300;
  server.headersTimeout = 1000;
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      requests,
      close: () => new Promise((r) => {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        server.close(() => r());
      }),
    }));
  });
}

async function withServer(handler, fn) {
  const server = await startServer(handler);
  try { return await fn(server); } finally { await server.close(); }
}

// --- SSE wire builders -----------------------------------------------------

const sse = (data) => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
const sseDone = () => 'data: [DONE]\n\n';
function ochunk(delta = {}, finish = null, extra = {}) {
  return { id: 'c1', choices: [{ index: 0, delta, finish_reason: finish }], ...extra };
}
// Anthropic event: event:<type>\ndata:<json>\n\n
const ae = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

const SSE_HEADERS = { 'content-type': 'text/event-stream' };
const JSON_HEADERS = { 'content-type': 'application/json' };

async function collect(port, protocol, handler, request, opts = {}) {
  return withServer(handler, async (server) => {
    const port = createNativeModelPort({
      resolveProfile: async () => ({ protocol, baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: 'fake-key', model: 'fake-model', ...(opts.bindingExtra || {}) }),
      fetchImpl: opts.fetchImpl || fetch,
      maxResponseBytes: opts.maxResponseBytes || 4 * 1024 * 1024,
      idleTimeoutMs: opts.idleTimeoutMs || 4000,
    });
    const events = [];
    const result = await port.generate(request, (e) => events.push(e));
    return { result, events, requests: server.requests };
  });
}

// ===================== OpenAI chat completions ============================

test('openai: final candidate streams text and seals usage', async () => {
  const handler = () => ({
    status: 200, headers: SSE_HEADERS,
    body: [sse(ochunk({ content: 'Hello' })), sse(ochunk({ content: ' world' }, 'stop')),
      sse({ id: 'c1', choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }), sseDone()],
  });
  const { result, events, requests } = await collect(0, 'openai-chat', handler, makeRequest());
  assert.equal(result.kind, 'final_candidate');
  assert.equal(result.text, 'Hello world');
  assert.equal(result.usage.inputTokens, 5);
  assert.equal(result.usage.outputTokens, 2);
  assert.deepEqual(events.map((e) => e.kind), ['text', 'text']);
  assert.equal(events[0].text, 'Hello');
  const body = JSON.parse(requests[0].body);
  assert.equal(body.stream, true);
  assert.equal(body.model, 'fake-model');
  assert.equal(body.tool_choice, 'auto');
  assert.equal(requests[0].headers.authorization, 'Bearer fake-key');
  assert.equal(requests[0].headers.accept, 'text/event-stream');
});

test('openai: tool fragments assemble into a sealed batch with tool_delta deltas', async () => {
  const handler = () => ({
    status: 200, headers: SSE_HEADERS,
    body: [
      sse(ochunk({ tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 're', arguments: '{"pa' } }] })),
      sse(ochunk({ tool_calls: [{ index: 0, function: { name: 'ad', arguments: 'th":"a.py"}' } }] })),
      sse(ochunk(null, 'tool_calls')), sseDone(),
    ],
  });
  const { result, events } = await collect(0, 'openai-chat', handler, makeRequest());
  assert.equal(result.kind, 'tool_calls');
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, 'read');
  assert.deepEqual(result.toolCalls[0].arguments, { path: 'a.py' });
  assert.ok(events.some((e) => e.kind === 'tool_delta'));
});

test('openai: length truncation never executes partial tool calls', async () => {
  const handler = () => ({
    status: 200, headers: SSE_HEADERS,
    body: [sse(ochunk({ content: 'partial', tool_calls: [{ index: 0, id: 'c', type: 'function', function: { name: 'read', arguments: '{"path":' } }] }, 'length',
      { usage: { prompt_tokens: 5, completion_tokens: 2 } })), sseDone()],
  });
  const { result } = await collect(0, 'openai-chat', handler, makeRequest());
  assert.equal(result.kind, 'output_limit');
  assert.equal(result.text, 'partial');
  assert.deepEqual(result.toolCalls, []);
  assert.equal(result.usage.inputTokens, 5);
});

test('openai: refusal becomes policy_abort with no tools', async () => {
  const handler = () => ({
    status: 200, headers: SSE_HEADERS,
    body: [sse(ochunk({ content: 'partial', tool_calls: [{ index: 0, id: 'c', type: 'function', function: { name: 'read', arguments: '{}' } }] }, 'content_filter')), sseDone()],
  });
  const { result } = await collect(0, 'openai-chat', handler, makeRequest());
  assert.equal(result.kind, 'policy_abort');
  assert.deepEqual(result.toolCalls, []);
});

test('openai: duplicate tool ids across indexes reject the batch', async () => {
  const handler = () => ({
    status: 200, headers: SSE_HEADERS,
    body: [sse(ochunk({ tool_calls: [
      { index: 0, id: 'dup', type: 'function', function: { name: 'read', arguments: '{}' } },
      { index: 1, id: 'dup', type: 'function', function: { name: 'read', arguments: '{}' } },
    ] }, 'tool_calls')), sseDone()],
  });
  const { result } = await collect(0, 'openai-chat', handler, makeRequest());
  assert.equal(result.kind, 'malformed_tool_call');
  assert.deepEqual(result.toolCalls, []);
});

test('openai: invalid argument JSON becomes a non-executable tool call', async () => {
  const handler = () => ({
    status: 200, headers: SSE_HEADERS,
    body: [sse(ochunk({ tool_calls: [{ index: 0, id: 'c', type: 'function', function: { name: 'read', arguments: '{"path":' } }] }, 'tool_calls')), sseDone()],
  });
  const { result } = await collect(0, 'openai-chat', handler, makeRequest());
  assert.equal(result.kind, 'tool_calls');
  assert.equal(result.toolCalls.length, 1);
  assert.deepEqual(result.toolCalls[0].arguments, {});
  assert.equal(result.toolCalls[0].wireArgumentsInvalid, true);
});

test('openai: reasoning is captured for private replay and never in stream metadata', async () => {
  const handler = () => ({
    status: 200, headers: SSE_HEADERS,
    body: [sse(ochunk({ reasoning_content: 'PRIVATE' })), sse(ochunk({ content: '42' }, 'stop')), sseDone()],
  });
  const { result, events } = await collect(0, 'openai-chat', handler,
    makeRequest({ profile: makeProfile({ providerReplayMode: 'reasoning_content' }) }));
  assert.equal(result.kind, 'final_candidate');
  assert.equal(result.text, '42');
  assert.equal(result.providerReplay.reasoningContent, 'PRIVATE');
  assert.ok(events.some((e) => e.kind === 'thinking' && e.text === 'PRIVATE'));
  // private replay never enters an emitted event's metadata
  assert.ok(events.every((e) => !e.metadata || !e.metadata.providerReplay));
});

test('openai: reasoning mode none drops reasoning from stream and replay', async () => {
  const handler = () => ({
    status: 200, headers: SSE_HEADERS,
    body: [sse(ochunk({ reasoning_content: 'PRIVATE' })), sse(ochunk({ content: '42' }, 'stop')), sseDone()],
  });
  const { result, events } = await collect(0, 'openai-chat', handler, makeRequest());
  assert.equal(result.kind, 'final_candidate');
  assert.equal(result.providerReplay, undefined);
  assert.ok(!events.some((e) => e.kind === 'thinking'));
});

test('openai: partial EOF without [DONE] is retryable and seals no tools', async () => {
  const handler = () => ({
    status: 200, headers: SSE_HEADERS,
    body: [sse(ochunk({ tool_calls: [{ index: 0, id: 'c', type: 'function', function: { name: 'read', arguments: '{}' } }] }, 'tool_calls'))],
  });
  const { result } = await collect(0, 'openai-chat', handler, makeRequest());
  assert.equal(result.kind, 'provider_retryable_error');
  assert.equal(result.failureKind, 'incomplete_response');
  assert.deepEqual(result.toolCalls, []);
});

test('openai: empty/reasoning-only response is not a final', async () => {
  const handler = () => ({
    status: 200, headers: SSE_HEADERS,
    body: [sse(ochunk({ reasoning_content: 'private' }, 'stop')), sseDone()],
  });
  const { result } = await collect(0, 'openai-chat', handler,
    makeRequest({ profile: makeProfile({ providerReplayMode: 'reasoning_content' }) }));
  assert.equal(result.kind, 'empty_response');
  assert.equal(result.text, '');
});

test('openai: malformed JSON frame is terminal invalid_response', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [sse(ochunk({ content: 'prefix' })), 'data: not-json\n\n'] });
  const { result } = await collect(0, 'openai-chat', handler, makeRequest());
  assert.equal(result.kind, 'provider_terminal_error');
  assert.equal(result.failureKind, 'invalid_response');
  assert.equal(result.text, 'prefix');
});

test('openai: partial frame split across chunks assembles correctly', async () => {
  const wire = sse(ochunk({ content: 'Hel' })) + sse(ochunk({ content: 'lo' }, 'stop')) + sseDone();
  // write the whole wire byte-by-byte to force many partial reads
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: Array.from(wire, (ch) => ch) });
  const { result } = await collect(0, 'openai-chat', handler, makeRequest(), { maxResponseBytes: 1024 * 1024 });
  assert.equal(result.kind, 'final_candidate');
  assert.equal(result.text, 'Hello');
});

test('openai: HTTP status classification covers retryable and terminal', async () => {
  const cases = [
    [408, 'provider_retryable_error', 'request_timeout'],
    [429, 'provider_retryable_error', 'rate_limit'],
    [500, 'provider_retryable_error', 'server_error'],
    [503, 'provider_retryable_error', 'server_error'],
    [401, 'provider_terminal_error', 'client_error'],
    [403, 'policy_abort', undefined],
    [404, 'provider_terminal_error', 'client_error'],
    [307, 'provider_terminal_error', 'client_error'],
  ];
  for (const [status, kind, failureKind] of cases) {
    const handler = () => ({ status, headers: { 'retry-after': '10' }, body: '{"error":{"message":"secret-body"}}' });
    const { result } = await collect(0, 'openai-chat', handler, makeRequest());
    assert.equal(result.kind, kind, `status ${status}`);
    if (failureKind) assert.equal(result.failureKind, failureKind, `status ${status}`);
    assert.deepEqual(result.toolCalls, []);
    // error body never leaks into the result text
    assert.equal(result.text, '');
  }
});

test('openai: retry-after header is parsed into retryAfterMs', async () => {
  const handler = () => ({ status: 429, headers: { 'retry-after': '3.5' }, body: '{}' });
  const { result } = await collect(0, 'openai-chat', handler, makeRequest());
  assert.equal(result.kind, 'provider_retryable_error');
  assert.equal(result.retryAfterMs, 3500);
});

test('openai: invalid retry-after header yields no scheduler instruction', async () => {
  for (const header of ['NaN', 'inf', '-5', 'not-a-date']) {
    const handler = () => ({ status: 503, headers: { 'retry-after': header }, body: '{}' });
    const { result } = await collect(0, 'openai-chat', handler, makeRequest());
    assert.equal(result.retryAfterMs, undefined, `header ${header}`);
  }
});

test('openai: 400 with context_length_exceeded is context_overflow', async () => {
  const handler = () => ({ status: 400, body: '{"error":{"code":"context_length_exceeded","message":"secret"}}' });
  const { result } = await collect(0, 'openai-chat', handler, makeRequest());
  assert.equal(result.kind, 'context_overflow');
  // a 400 without the explicit code stays terminal
  const handler2 = () => ({ status: 400, body: '{"error":{"message":"context_length_exceeded"}}' });
  const { result: r2 } = await collect(0, 'openai-chat', handler2, makeRequest());
  assert.equal(r2.kind, 'provider_terminal_error');
});

test('openai: finalizationOnly omits tools and tool_choice', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [sse(ochunk({ content: 'done' }, 'stop')), sseDone()] });
  const { result, requests } = await collect(0, 'openai-chat', handler, makeRequest({ finalizationOnly: true }));
  assert.equal(result.kind, 'final_candidate');
  const body = JSON.parse(requests[0].body);
  assert.ok(!('tools' in body));
  assert.ok(!('tool_choice' in body));
});

test('openai: no tools omits tools and tool_choice', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [sse(ochunk({ content: 'done' }, 'stop')), sseDone()] });
  const { requests } = await collect(0, 'openai-chat', handler, makeRequest({ tools: [] }));
  const body = JSON.parse(requests[0].body);
  assert.ok(!('tools' in body) && !('tool_choice' in body));
});

test('openai: binding parameters cannot override forbidden keys', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [sse(ochunk({ content: 'done' }, 'stop')), sseDone()] });
  const { requests } = await collect(0, 'openai-chat', handler, makeRequest(), {
    bindingExtra: { parameters: { model: 'EVIL', messages: ['x'], tools: ['y'], stream: false, n: 9, tool_choice: 'none', temperature: 0.5 } },
  });
  const body = JSON.parse(requests[0].body);
  assert.equal(body.model, 'fake-model');
  assert.equal(body.stream, true);
  assert.equal(body.n, 1);
  assert.equal(body.tool_choice, 'auto');
  assert.equal(body.temperature, 0.5);
  assert.ok(Array.isArray(body.messages));
  assert.ok(!Array.isArray(body.tools) || body.tools[0].function);
});

test('openai: user media is projected as image_url content blocks', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [sse(ochunk({ content: 'ok' }, 'stop')), sseDone()] });
  const messages = [{ role: 'user', content: 'See this', media: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,ZmFrZQ==' } }] }];
  const { requests } = await collect(0, 'openai-chat', handler, makeRequest({ messages, tools: [] }));
  const body = JSON.parse(requests[0].body);
  assert.ok(Array.isArray(body.messages[0].content));
  assert.equal(body.messages[0].content[0].type, 'text');
  assert.equal(body.messages[0].content[1].type, 'image_url');
});

test('openai: local file path media is rejected before HTTP', async () => {
  const messages = [{ role: 'user', content: 'See', media: [{ type: 'image_url', image_url: { url: '/tmp/x.png' } }] }];
  const { result, requests } = await collect(0, 'openai-chat', () => ({ status: 200, body: '' }), makeRequest({ messages, tools: [] }));
  assert.equal(result.kind, 'provider_terminal_error');
  assert.equal(result.failureKind, 'invalid_response');
  assert.equal(requests.length, 0);
});

test('openai: caller abort propagates and does not produce a final', async () => {
  let release;
  const handler = () => new Promise((resolve) => {
    release = () => resolve({ status: 200, headers: SSE_HEADERS, body: [sse(ochunk({ content: 'partial' }))] });
    // never resolve until released; the server accepts but writes nothing
    setTimeout(release, 100);
  });
  await withServer(handler, async (server) => {
    const ac = new AbortController();
    const port = makePort({ port: server.port, protocol: 'openai-chat' });
    const p = port.generate(makeRequest({ signal: ac.signal }), () => {});
    ac.abort();
    await assert.rejects(p);
  });
});

test('openai: idle silence is a retryable request_timeout', async () => {
  async function* stall() { await new Promise(() => {}); }
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: stall() });
  await withServer(handler, async (server) => {
    const port = createNativeModelPort({
      resolveProfile: async () => ({ protocol: 'openai-chat', baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: 'fake-key', model: 'fake-model' }),
      fetchImpl: fetch, maxResponseBytes: 1024 * 1024, idleTimeoutMs: 60,
    });
    const result = await port.generate(makeRequest(), () => {});
    assert.equal(result.kind, 'provider_retryable_error');
    assert.equal(result.failureKind, 'request_timeout');
  });
});

test('openai: response exceeding maxResponseBytes is terminal', async () => {
  const big = 'data: ' + JSON.stringify(ochunk({ content: 'x'.repeat(2000) })) + '\n\n';
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [big, sseDone()] });
  const { result } = await collect(0, 'openai-chat', handler, makeRequest(), { maxResponseBytes: 512 });
  assert.equal(result.kind, 'provider_terminal_error');
  assert.equal(result.failureKind, 'invalid_response');
});

test('openai: conflicting usage reports fail closed', async () => {
  const tail = { id: 'c1', choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } };
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [sse(ochunk({ content: 'A' }, 'stop')), sse(tail), sse({ id: 'c1', choices: [], usage: { prompt_tokens: 50, completion_tokens: 2 } }), sseDone()] });
  const { result } = await collect(0, 'openai-chat', handler, makeRequest());
  assert.equal(result.kind, 'provider_terminal_error');
});

test('openai: snapshot message mid-stream is terminal', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [sse(ochunk({ content: 'A' })), sse({ id: 'c1', choices: [{ index: 0, message: { role: 'assistant', content: 'AB' }, finish_reason: 'stop' }] }), sseDone()] });
  const { result } = await collect(0, 'openai-chat', handler, makeRequest());
  assert.equal(result.kind, 'provider_terminal_error');
  assert.equal(result.text, 'A');
});

test('openai: buffered 2xx (non-SSE) final candidate parses', async () => {
  const handler = () => ({ status: 200, headers: JSON_HEADERS, body: JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'buffered' }, finish_reason: 'stop' }] }) });
  const { result } = await collect(0, 'openai-chat', handler, makeRequest());
  assert.equal(result.kind, 'final_candidate');
  assert.equal(result.text, 'buffered');
});

// ===================== Anthropic messages =================================

function anthropicFinalText(text = 'Hello', { stop = 'end_turn', outputTokens = 3, inputTokens = 7 } = {}) {
  return [
    ae('message_start', { type: 'message_start', message: { id: 'm1', model: 'fake-model', role: 'assistant', usage: { input_tokens: inputTokens, output_tokens: 0 } } }),
    ae('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    ae('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    ae('content_block_stop', { type: 'content_block_stop', index: 0 }),
    ae('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: outputTokens } }),
    ae('message_stop', { type: 'message_stop' }),
  ];
}

test('anthropic: final candidate streams text and seals usage', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: anthropicFinalText('Hello') });
  const { result, events, requests } = await collect(0, 'anthropic-messages', handler, makeRequest());
  assert.equal(result.kind, 'final_candidate');
  assert.equal(result.text, 'Hello');
  assert.equal(result.usage.inputTokens, 7);
  assert.equal(result.usage.outputTokens, 3);
  assert.ok(events.some((e) => e.kind === 'text' && e.text === 'Hello'));
  assert.equal(requests[0].url, '/v1/messages');
  assert.equal(requests[0].headers['x-api-key'], 'fake-key');
  assert.equal(requests[0].headers['anthropic-version'], '2023-06-01');
  const body = JSON.parse(requests[0].body);
  assert.equal(body.stream, true);
  assert.equal(body.model, 'fake-model');
  assert.equal(body.max_tokens, 8192);
  assert.equal(body.tools[0].name, 'read');
  assert.equal(body.tools[0].input_schema.type, 'object');
});

test('anthropic: tool_use assembles from input_json_delta', async () => {
  const handler = () => ({
    status: 200, headers: SSE_HEADERS,
    body: [
      ae('message_start', { type: 'message_start', message: { id: 'm1', model: 'fake-model', role: 'assistant', usage: { input_tokens: 4, output_tokens: 0 } } }),
      ae('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool-1', name: 'read', input: {} } }),
      ae('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } }),
      ae('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"a.py"}' } }),
      ae('content_block_stop', { type: 'content_block_stop', index: 0 }),
      ae('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } }),
      ae('message_stop', { type: 'message_stop' }),
    ],
  });
  const { result, events } = await collect(0, 'anthropic-messages', handler, makeRequest());
  assert.equal(result.kind, 'tool_calls');
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].callId, 'tool-1');
  assert.equal(result.toolCalls[0].name, 'read');
  assert.deepEqual(result.toolCalls[0].arguments, { path: 'a.py' });
  assert.ok(events.some((e) => e.kind === 'tool_delta'));
});

test('anthropic: signed thinking captured into anthropic_content replay', async () => {
  const handler = () => ({
    status: 200, headers: SSE_HEADERS,
    body: [
      ae('message_start', { type: 'message_start', message: { id: 'm1', model: 'fake-model', role: 'assistant', usage: { input_tokens: 3, output_tokens: 0 } } }),
      ae('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      ae('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'PRIVATE_THINKING' } }),
      ae('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig123' } }),
      ae('content_block_stop', { type: 'content_block_stop', index: 0 }),
      ae('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
      ae('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Answer' } }),
      ae('content_block_stop', { type: 'content_block_stop', index: 1 }),
      ae('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } }),
      ae('message_stop', { type: 'message_stop' }),
    ],
  });
  const { result, events } = await collect(0, 'anthropic-messages', handler,
    makeRequest({ profile: makeProfile({ providerReplayMode: 'anthropic_content' }) }));
  assert.equal(result.kind, 'final_candidate');
  assert.equal(result.text, 'Answer');
  assert.ok(result.providerReplay);
  assert.equal(result.providerReplay.version, 'model-replay/v2');
  const thinkingBlock = result.providerReplay.anthropicContent.find((b) => b.type === 'thinking');
  assert.equal(thinkingBlock.thinking, 'PRIVATE_THINKING');
  assert.equal(thinkingBlock.signature, 'sig123');
  // thinking emitted for display; signature never in stream metadata
  assert.ok(events.some((e) => e.kind === 'thinking' && e.text === 'PRIVATE_THINKING'));
  assert.ok(events.every((e) => !e.metadata || !e.metadata.signature));
});

test('anthropic: refusal stop_details becomes policy_abort', async () => {
  const handler = () => ({
    status: 200, headers: SSE_HEADERS,
    body: [
      ae('message_start', { type: 'message_start', message: { id: 'm1', model: 'fake-model', role: 'assistant', usage: { input_tokens: 2, output_tokens: 0 } } }),
      ae('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      ae('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } }),
      ae('content_block_stop', { type: 'content_block_stop', index: 0 }),
      ae('message_delta', { type: 'message_delta', delta: { stop_reason: 'refusal', stop_sequence: null, stop_details: { type: 'refusal' } }, usage: { output_tokens: 1 } }),
      ae('message_stop', { type: 'message_stop' }),
    ],
  });
  const { result } = await collect(0, 'anthropic-messages', handler, makeRequest());
  assert.equal(result.kind, 'policy_abort');
  assert.deepEqual(result.toolCalls, []);
});

test('anthropic: max_tokens stop_reason is output_limit', async () => {
  const { result } = await collect(0, 'anthropic-messages', () => ({ status: 200, headers: SSE_HEADERS, body: anthropicFinalText('partial', { stop: 'max_tokens' }) }), makeRequest());
  assert.equal(result.kind, 'output_limit');
  assert.equal(result.text, 'partial');
});

test('anthropic: in-stream rate_limit error is retryable', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [ae('message_start', { type: 'message_start', message: { id: 'm1', model: 'fake-model', role: 'assistant', usage: { input_tokens: 2, output_tokens: 0 } } }), ae('error', { type: 'error', error: { type: 'rate_limit_error', message: 'secret' } })] });
  const { result } = await collect(0, 'anthropic-messages', handler, makeRequest());
  assert.equal(result.kind, 'provider_retryable_error');
  assert.equal(result.failureKind, 'rate_limit');
});

test('anthropic: in-stream invalid_request error is terminal', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [ae('error', { type: 'error', error: { type: 'invalid_request_error', message: 'secret' } })] });
  const { result } = await collect(0, 'anthropic-messages', handler, makeRequest());
  assert.equal(result.kind, 'provider_terminal_error');
  assert.equal(result.failureKind, 'client_error');
});

test('anthropic: duplicate tool ids reject the batch', async () => {
  const handler = () => ({
    status: 200, headers: SSE_HEADERS,
    body: [
      ae('message_start', { type: 'message_start', message: { id: 'm1', model: 'fake-model', role: 'assistant', usage: { input_tokens: 2, output_tokens: 0 } } }),
      ae('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'dup', name: 'read', input: {} } }),
      ae('content_block_stop', { type: 'content_block_stop', index: 0 }),
      ae('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'dup', name: 'read', input: {} } }),
      ae('content_block_stop', { type: 'content_block_stop', index: 1 }),
      ae('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 2 } }),
      ae('message_stop', { type: 'message_stop' }),
    ],
  });
  const { result } = await collect(0, 'anthropic-messages', handler, makeRequest());
  assert.equal(result.kind, 'malformed_tool_call');
  assert.deepEqual(result.toolCalls, []);
});

test('anthropic: invalid input_json becomes a non-executable tool call', async () => {
  const handler = () => ({
    status: 200, headers: SSE_HEADERS,
    body: [
      ae('message_start', { type: 'message_start', message: { id: 'm1', model: 'fake-model', role: 'assistant', usage: { input_tokens: 2, output_tokens: 0 } } }),
      ae('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool-1', name: 'read', input: {} } }),
      ae('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } }),
      ae('content_block_stop', { type: 'content_block_stop', index: 0 }),
      ae('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 2 } }),
      ae('message_stop', { type: 'message_stop' }),
    ],
  });
  const { result } = await collect(0, 'anthropic-messages', handler, makeRequest());
  assert.equal(result.kind, 'tool_calls');
  assert.equal(result.toolCalls[0].wireArgumentsInvalid, true);
  assert.deepEqual(result.toolCalls[0].arguments, {});
});

test('anthropic: partial EOF without message_stop is retryable', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [ae('message_start', { type: 'message_start', message: { id: 'm1', model: 'fake-model', role: 'assistant', usage: { input_tokens: 2, output_tokens: 0 } } }), ae('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'c', name: 'read', input: {} } }), ae('content_block_stop', { type: 'content_block_stop', index: 0 })] });
  const { result } = await collect(0, 'anthropic-messages', handler, makeRequest());
  assert.equal(result.kind, 'provider_retryable_error');
  assert.equal(result.failureKind, 'incomplete_response');
  assert.deepEqual(result.toolCalls, []);
});

test('anthropic: empty response is not a final', async () => {
  const handler = () => ({
    status: 200, headers: SSE_HEADERS,
    body: [
      ae('message_start', { type: 'message_start', message: { id: 'm1', model: 'fake-model', role: 'assistant', usage: { input_tokens: 2, output_tokens: 0 } } }),
      ae('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } }),
      ae('message_stop', { type: 'message_stop' }),
    ],
  });
  const { result } = await collect(0, 'anthropic-messages', handler, makeRequest());
  assert.equal(result.kind, 'empty_response');
});

test('anthropic: user media projected as image source blocks', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: anthropicFinalText('ok') });
  const messages = [{ role: 'user', content: 'See', media: [{ type: 'image_url', image_url: { url: 'https://example.com/x.png' } }] }];
  const { requests } = await collect(0, 'anthropic-messages', handler, makeRequest({ messages, tools: [] }));
  const body = JSON.parse(requests[0].body);
  assert.equal(body.messages[0].content[1].type, 'image');
  assert.equal(body.messages[0].content[1].source.type, 'url');
});

test('anthropic: HTTP status classification mirrors the chat adapter', async () => {
  for (const [status, kind] of [[429, 'provider_retryable_error'], [403, 'policy_abort'], [500, 'provider_retryable_error'], [401, 'provider_terminal_error']]) {
    const handler = () => ({ status, body: '{"error":{"message":"secret"}}' });
    const { result } = await collect(0, 'anthropic-messages', handler, makeRequest());
    assert.equal(result.kind, kind, `status ${status}`);
  }
});

test('anthropic: finalizationOnly omits tools', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: anthropicFinalText('done') });
  const { requests } = await collect(0, 'anthropic-messages', handler, makeRequest({ finalizationOnly: true }));
  const body = JSON.parse(requests[0].body);
  assert.ok(!('tools' in body));
});

test('anthropic: binding parameters cannot override forbidden keys', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: anthropicFinalText('done') });
  const { requests } = await collect(0, 'anthropic-messages', handler, makeRequest(), {
    bindingExtra: { parameters: { model: 'EVIL', messages: ['x'], tools: ['y'], stream: false, system: 'evil', temperature: 0.3 } },
  });
  const body = JSON.parse(requests[0].body);
  assert.equal(body.model, 'fake-model');
  assert.equal(body.stream, true);
  assert.equal(body.temperature, 0.3);
  assert.ok(Array.isArray(body.messages));
});

test('anthropic: buffered 2xx (non-SSE) message parses', async () => {
  const handler = () => ({
    status: 200, headers: JSON_HEADERS,
    body: JSON.stringify({ id: 'm1', type: 'message', role: 'assistant', model: 'fake-model', stop_reason: 'end_turn', content: [{ type: 'text', text: 'buffered' }], usage: { input_tokens: 3, output_tokens: 2 } }),
  });
  const { result } = await collect(0, 'anthropic-messages', handler, makeRequest());
  assert.equal(result.kind, 'final_candidate');
  assert.equal(result.text, 'buffered');
  assert.equal(result.usage.inputTokens, 3);
});

test('no persisted credentials: apiKey is not in result or request body', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [sse(ochunk({ content: 'done' }, 'stop')), sseDone()] });
  const { result, requests } = await collect(0, 'openai-chat', handler, makeRequest());
  assert.equal(JSON.stringify(result).includes('fake-key'), false);
  assert.equal(requests[0].body.includes('fake-key'), false);
});

test('openai: legacy function_call envelope becomes malformed_tool_call', async () => {
  const handler = () => ({
    status: 200, headers: JSON_HEADERS,
    body: JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'done', function_call: { name: 'read', arguments: '{}' } }, finish_reason: 'stop' }] }),
  });
  const { result } = await collect(0, 'openai-chat', handler, makeRequest());
  assert.equal(result.kind, 'malformed_tool_call');
});

test('openai: mixed completion identities across frames is terminal', async () => {
  const handler = () => ({
    status: 200, headers: SSE_HEADERS,
    body: [sse({ id: 'c1', choices: [{ index: 0, delta: { content: 'A' } }] }), sse({ id: 'c2', choices: [{ index: 0, delta: { content: 'B' } }] }), sseDone()],
  });
  const { result } = await collect(0, 'openai-chat', handler, makeRequest());
  assert.equal(result.kind, 'provider_terminal_error');
  assert.equal(result.text, 'A');
});

test('anthropic: replay round-trips through assistant message projection', async () => {
  // First request captures anthropic_content replay; the second request carries
  // it on an assistant message and the adapter re-projects the original blocks.
  const handler = () => ({
    status: 200, headers: SSE_HEADERS,
    body: [
      ae('message_start', { type: 'message_start', message: { id: 'm1', model: 'fake-model', role: 'assistant', usage: { input_tokens: 3, output_tokens: 0 } } }),
      ae('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      ae('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'PRIVATE' } }),
      ae('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }),
      ae('content_block_stop', { type: 'content_block_stop', index: 0 }),
      ae('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu-1', name: 'read', input: {} } }),
      ae('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"x"}' } }),
      ae('content_block_stop', { type: 'content_block_stop', index: 1 }),
      ae('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 4 } }),
      ae('message_stop', { type: 'message_stop' }),
    ],
  });
  const profile = makeProfile({ providerReplayMode: 'anthropic_content' });
  const { result, requests } = await collect(0, 'anthropic-messages', handler, makeRequest({ profile }));
  assert.equal(result.kind, 'tool_calls');
  const replay = result.providerReplay.anthropicContent;
  const assistantMessage = {
    role: 'assistant', content: '', toolCalls: [{ callId: 'tu-1', name: 'read', arguments: { path: 'x' } }],
    providerReplay: result.providerReplay,
  };
  // Second request re-projects the assistant replay; the wire carries the
  // original thinking+tool_use blocks, not a re-derived text/tool projection.
  const { requests: r2 } = await collect(0, 'anthropic-messages', handler, makeRequest({ profile, messages: [assistantMessage, { role: 'user', content: 'again' }] }));
  const body = JSON.parse(r2[0].body);
  const firstAssistant = body.messages[0];
  assert.equal(firstAssistant.role, 'assistant');
  const types = firstAssistant.content.map((b) => b.type);
  assert.ok(types.includes('thinking'));
  assert.ok(types.includes('tool_use'));
  const thinking = firstAssistant.content.find((b) => b.type === 'thinking');
  assert.equal(thinking.signature, 'sig');
});


test('resolveProfile failure is a terminal host_error without leaking the exception', async () => {
  const server = await startServer(() => ({ status: 200, body: '' }));
  try {
    const port = createNativeModelPort({
      resolveProfile: async () => { throw new Error('secret-credential-leak'); },
      fetchImpl: fetch,
    });
    const result = await port.generate(makeRequest(), () => {});
    assert.equal(result.kind, 'provider_terminal_error');
    assert.equal(result.failureKind, 'host_error');
    assert.equal(JSON.stringify(result).includes('secret-credential-leak'), false);
    assert.equal(server.requests.length, 0);
  } finally { await server.close(); }
});
