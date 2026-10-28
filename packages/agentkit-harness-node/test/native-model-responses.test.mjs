// Protocol-conformance tests for the OpenAI Responses native model adapter
// over a real local HTTP server streaming controlled Responses SSE bytes.
// These exercise the wire normalization, ordered output items, tool-argument
// assembly, refusal/usage/error normalization, replay sealing, media
// projection, canonical call-id pairing and one-attempt semantics — never live
// models and never mocking fetch. Fake credentials only.

import test from 'node:test';
import assert from 'node:assert/strict';
import { deepEqual as looseEqual } from 'node:assert';
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

// --- Responses SSE wire builders -------------------------------------------

const sse = (data) => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
const SSE_HEADERS = { 'content-type': 'text/event-stream' };
const JSON_HEADERS = { 'content-type': 'application/json' };

const rcreated = (id = 'resp-1', model = 'fake-model') => ({ type: 'response.created', response: { id, model } });
const rtext = (delta, id = 'resp-1') => ({ type: 'response.output_text.delta', response_id: id, delta });
const rcompleted = (id = 'resp-1', model = 'fake-model', usage, output) => ({
  type: 'response.completed',
  response: { id, model, ...(usage ? { usage } : {}), ...(output ? { output } : {}) },
});
const rincomplete = (id = 'resp-1', model = 'fake-model', reason, usage, output) => ({
  type: 'response.incomplete',
  response: { id, model, incomplete_details: { reason }, ...(usage ? { usage } : {}), ...(output ? { output } : {}) },
});
const rfailed = (error, id = 'resp-1') => ({ type: 'response.failed', response: { id, status: 'failed', error } });
const rerr = (error) => ({ type: 'error', error });
const rcancelled = (id = 'resp-1') => ({ type: 'response.cancelled', response: { id, status: 'cancelled' } });

const fcallAdded = (idx, itemId, callId, name) => ({
  type: 'response.output_item.added', output_index: idx,
  item: { type: 'function_call', id: itemId, call_id: callId, name, arguments: '' },
});
const fcallArgsDelta = (idx, itemId, delta) => ({
  type: 'response.function_call_arguments.delta', output_index: idx, item_id: itemId, delta,
});
const fcallArgsDone = (idx, itemId, args) => ({
  type: 'response.function_call_arguments.done', output_index: idx, item_id: itemId, arguments: args,
});
const fcallDone = (idx, item) => ({ type: 'response.output_item.done', output_index: idx, item });

async function collect(handler, request, opts = {}) {
  return withServer(handler, async (server) => {
    const port = createNativeModelPort({
      resolveProfile: async () => ({ protocol: 'openai-responses', baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: 'fake-key', model: 'fake-model', ...(opts.bindingExtra || {}) }),
      fetchImpl: opts.fetchImpl || fetch,
      maxResponseBytes: opts.maxResponseBytes || 4 * 1024 * 1024,
      idleTimeoutMs: opts.idleTimeoutMs || 4000,
    });
    const events = [];
    const result = await port.generate(request, (e) => events.push(e));
    return { result, events, requests: server.requests };
  });
}

// ===================== request projection =================================

test('responses: final candidate streams text and seals usage', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [
    sse(rcreated()), sse(rtext('Hello')), sse(rtext(' world')),
    sse(rcompleted('resp-1', 'fake-model', { input_tokens: 5, output_tokens: 2 })),
  ] });
  const { result, events, requests } = await collect(handler, makeRequest());
  assert.equal(result.kind, 'final_candidate');
  assert.equal(result.text, 'Hello world');
  assert.equal(result.usage.inputTokens, 5);
  assert.equal(result.usage.outputTokens, 2);
  assert.equal(result.usageReported, true);
  assert.deepEqual(events.map((e) => e.kind), ['text', 'text']);
  assert.equal(events[0].text, 'Hello');
  const body = JSON.parse(requests[0].body);
  assert.equal(requests[0].url, '/v1/responses');
  assert.equal(body.stream, true);
  assert.equal(body.model, 'fake-model');
  assert.equal(body.input[0].role, 'user');
  assert.equal(body.input[0].content[0].type, 'input_text');
  assert.equal(body.max_output_tokens, 8192);
  assert.equal(requests[0].headers.authorization, 'Bearer fake-key');
  assert.equal(requests[0].headers.accept, 'text/event-stream');
  assert.equal(requests[0].headers['content-type'], 'application/json');
});

test('responses: system messages lift to top-level instructions', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [sse(rcreated()), sse(rtext('ok')), sse(rcompleted('resp-1'))] });
  const messages = [{ role: 'system', content: 'Be concise.' }, { role: 'user', content: 'Hi' }];
  const { requests } = await collect(handler, makeRequest({ messages }));
  const body = JSON.parse(requests[0].body);
  assert.equal(body.instructions, 'Be concise.');
  assert.ok(!body.input.some((i) => i.role === 'system'));
  assert.equal(body.input[0].role, 'user');
});

test('responses: tools are flat function objects with tool_choice and parallel_tool_calls', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [sse(rcreated()), sse(rtext('ok')), sse(rcompleted('resp-1'))] });
  const { requests } = await collect(handler, makeRequest({ tools: [makeTool('read'), makeTool('write')] }));
  const body = JSON.parse(requests[0].body);
  assert.equal(body.tools[0].type, 'function');
  assert.equal(body.tools[0].name, 'read');
  assert.ok(!('function' in body.tools[0]));
  assert.equal(body.tool_choice, 'auto');
  assert.equal(body.parallel_tool_calls, true);
});

test('responses: finalizationOnly keeps submit_final_output and drops normal tools', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [sse(rcreated()), sse(rtext('done')), sse(rcompleted('resp-1'))] });
  const submit = { ...makeTool('submit_final_output'), description: 'Submit final answer' };
  const { requests } = await collect(handler, makeRequest({ finalizationOnly: true, tools: [makeTool('read'), submit] }));
  const body = JSON.parse(requests[0].body);
  assert.deepEqual(body.tools.map((t) => t.name), ['submit_final_output']);
  assert.equal(body.tool_choice, 'auto');
});

test('responses: no tools omits tools and tool_choice', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [sse(rcreated()), sse(rtext('done')), sse(rcompleted('resp-1'))] });
  const { requests } = await collect(handler, makeRequest({ tools: [] }));
  const body = JSON.parse(requests[0].body);
  assert.ok(!('tools' in body));
  assert.ok(!('tool_choice' in body));
});

test('responses: binding parameters cannot override forbidden keys', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [sse(rcreated()), sse(rtext('done')), sse(rcompleted('resp-1'))] });
  const { requests } = await collect(handler, makeRequest(), {
    bindingExtra: { parameters: { model: 'EVIL', input: ['x'], tools: ['y'], stream: false, instructions: 'evil', temperature: 0.5 } },
  });
  const body = JSON.parse(requests[0].body);
  assert.equal(body.model, 'fake-model');
  assert.equal(body.stream, true);
  assert.equal(body.temperature, 0.5);
  assert.ok(Array.isArray(body.input));
  assert.equal(body.instructions, undefined, 'instructions is request-owned, never overridden by parameters');
  assert.equal(body.max_output_tokens, 8192, 'the pinned default stands when no output limit is supplied');
});

test('responses: host generation parameters cannot increase the pinned output budget', async () => {
  for (const value of [64, 9999]) {
    const { requests } = await collect(() => ({ headers: JSON_HEADERS, body: '{}' }),
      makeRequest({ profile: makeProfile({ maxOutputTokens: 128 }) }),
      { bindingExtra: { parameters: { max_output_tokens: value } } });
    assert.equal(JSON.parse(requests[0].body).max_output_tokens, Math.min(value, 128));
  }
});

test('responses: negative output budget is rejected before HTTP', async () => {
  const server = await startServer(() => ({ status: 200, body: '' }));
  try {
    const port = createNativeModelPort({
      resolveProfile: async () => ({ protocol: 'openai-responses', baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: 'fake-key', model: 'fake-model', parameters: { max_output_tokens: -1 } }),
      fetchImpl: fetch, maxResponseBytes: 4096, idleTimeoutMs: 4000,
    });
    const r = await port.generate(makeRequest({ profile: makeProfile({ maxOutputTokens: 128 }) }), () => {});
    assert.equal(r.kind, 'provider_terminal_error');
    assert.equal(server.requests.length, 0);
  } finally { await server.close(); }
});

// ===================== canonical call-id pairing =========================

test('responses: assistant function_call and tool function_call_output pair by call id', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [sse(rcreated()), sse(rtext('ok')), sse(rcompleted('resp-1'))] });
  const messages = [
    { role: 'user', content: 'read it' },
    { role: 'assistant', content: '', toolCalls: [{ callId: 'call-1', name: 'read', arguments: { path: 'a.py' } }] },
    { role: 'tool', callId: 'call-1', content: 'file contents' },
    { role: 'user', content: 'again' },
  ];
  const { requests } = await collect(handler, makeRequest({ messages }));
  const body = JSON.parse(requests[0].body);
  const types = body.input.map((i) => i.type);
  // user, function_call, function_call_output, user — and the tool-only assistant carries no role/content item.
  assert.equal(types[0], undefined); // first user is {role, content} (no type)
  assert.equal(body.input[0].role, 'user');
  assert.equal(body.input[1].type, 'function_call');
  assert.equal(body.input[1].call_id, 'call-1');
  assert.equal(body.input[1].arguments, '{"path":"a.py"}');
  assert.equal(body.input[2].type, 'function_call_output');
  assert.equal(body.input[2].call_id, 'call-1');
  assert.equal(body.input[2].output, 'file contents');
  assert.equal(body.input[3].role, 'user');
});

test('responses: orphan tool receipt is rejected before HTTP', async () => {
  const messages = [{ role: 'tool', callId: 'c1', content: 'orphan' }];
  const { result, requests } = await collect(() => { throw new Error('must not dispatch'); }, makeRequest({ messages }));
  assert.equal(result.kind, 'provider_terminal_error');
  assert.equal(result.failureKind, 'invalid_response');
  assert.equal(requests.length, 0);
});

test('responses: incomplete assistant tool batch is rejected before HTTP', async () => {
  const messages = [
    { role: 'assistant', content: '', toolCalls: [{ callId: 'c1', name: 'read', arguments: {} }] },
    { role: 'user', content: 'continue' },
  ];
  const { result, requests } = await collect(() => { throw new Error('must not dispatch'); }, makeRequest({ messages }));
  assert.equal(result.kind, 'provider_terminal_error');
  assert.equal(requests.length, 0);
});

test('responses: duplicate assistant tool ids are rejected before HTTP', async () => {
  const messages = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: '', toolCalls: [
      { callId: 'dup', name: 'read', arguments: {} }, { callId: 'dup', name: 'read', arguments: {} }] },
    { role: 'tool', callId: 'dup', content: 'r1' },
    { role: 'tool', callId: 'dup', content: 'r2' },
    { role: 'user', content: 'again' },
  ];
  const { result, requests } = await collect(() => { throw new Error('must not dispatch'); }, makeRequest({ messages }));
  assert.equal(result.kind, 'provider_terminal_error');
  assert.equal(requests.length, 0);
});

// ===================== media projection ==================================

test('responses: user media is projected as input_image with a bare image_url', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [sse(rcreated()), sse(rtext('ok')), sse(rcompleted('resp-1'))] });
  const messages = [{ role: 'user', content: 'See this', media: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,ZmFrZQ==' } }] }];
  const { requests } = await collect(handler, makeRequest({ messages, tools: [] }));
  const body = JSON.parse(requests[0].body);
  assert.ok(Array.isArray(body.input[0].content));
  assert.equal(body.input[0].content[0].type, 'input_text');
  assert.equal(body.input[0].content[1].type, 'input_image');
  assert.equal(body.input[0].content[1].image_url, 'data:image/png;base64,ZmFrZQ==');
});

test('responses: local file path media is rejected before HTTP', async () => {
  const messages = [{ role: 'user', content: 'See', media: [{ type: 'image_url', image_url: { url: '/tmp/x.png' } }] }];
  const { result, requests } = await collect(() => ({ status: 200, body: '' }), makeRequest({ messages, tools: [] }));
  assert.equal(result.kind, 'provider_terminal_error');
  assert.equal(result.failureKind, 'invalid_response');
  assert.equal(requests.length, 0);
});

test('responses: image over request.maxInlineImageBytes is rejected before HTTP', async () => {
  const server = await startServer(() => ({ status: 200, headers: SSE_HEADERS, body: [sse(rcreated()), sse(rtext('ok')), sse(rcompleted('resp-1'))] }));
  try {
    const port = createNativeModelPort({
      resolveProfile: async () => ({ protocol: 'openai-responses', baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: 'fake-key', model: 'fake-model' }),
      fetchImpl: fetch, maxResponseBytes: 4096, idleTimeoutMs: 4000,
    });
    const messages = [{ role: 'user', content: 'See', media: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,ZmFrZQ==' } }] }];
    const req = makeRequest({ messages, tools: [] });
    req.maxInlineImageBytes = 3;
    const r = await port.generate(req, () => {});
    assert.equal(r.kind, 'provider_terminal_error');
    assert.equal(r.failureKind, 'invalid_response');
    assert.equal(server.requests.length, 0);
  } finally { await server.close(); }
});

test('responses: inline image budget covers the complete current user input including URL prefixes', async () => {
  const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } };
  const bytes = Buffer.byteLength(image.image_url.url);
  for (const [media, limit, allowed] of [[[image], bytes, true], [[image], bytes - 1, false]]) {
    const request = { ...makeRequest({ messages: [{ role: 'user', content: 'look', media }] }), maxInlineImageBytes: limit };
    const { requests } = await collect(() => ({ headers: JSON_HEADERS, body: '{}' }), request);
    assert.equal(requests.length, allowed ? 1 : 0);
  }
});

// ===================== tool assembly =====================================

test('responses: function_call assembles from argument deltas with tool_delta events', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [
    sse(rcreated()),
    sse(fcallAdded(0, 'fc-1', 'call-1', 'read')),
    sse(fcallArgsDelta(0, 'fc-1', '{"pa')), sse(fcallArgsDelta(0, 'fc-1', 'th":"a.py"}')),
    sse(fcallDone(0, { type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'read', arguments: '{"path":"a.py"}' })),
    sse(rcompleted('resp-1', 'fake-model', { input_tokens: 3, output_tokens: 4 },
      [{ type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'read', arguments: '{"path":"a.py"}' }])),
  ] });
  const { result, events } = await collect(handler, makeRequest());
  assert.equal(result.kind, 'tool_calls');
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].callId, 'call-1');
  assert.equal(result.toolCalls[0].name, 'read');
  looseEqual(result.toolCalls[0].arguments, { path: 'a.py' });
  assert.ok(events.some((e) => e.kind === 'tool_delta'));
});

test('responses: function_call_arguments.done is authoritative before output_item.done', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [
    sse(rcreated()),
    sse(fcallAdded(0, 'fc-1', 'call-1', 'read')),
    sse(fcallArgsDelta(0, 'fc-1', '{"pa')),
    sse(fcallArgsDone(0, 'fc-1', '{"path":"a.py"}')),
    sse(fcallDone(0, { type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'read', arguments: '{"path":"a.py"}' })),
    sse(rcompleted('resp-1', 'fake-model', undefined,
      [{ type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'read', arguments: '{"path":"a.py"}' }])),
  ] });
  const { result } = await collect(handler, makeRequest());
  assert.equal(result.kind, 'tool_calls');
  looseEqual(result.toolCalls[0].arguments, { path: 'a.py' });
  assert.equal(result.toolCalls[0].wireArgumentsInvalid, undefined);
});

test('responses: invalid argument JSON becomes a non-executable tool call', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [
    sse(rcreated()),
    sse(fcallAdded(0, 'fc-1', 'call-1', 'read')),
    sse(fcallArgsDelta(0, 'fc-1', '{"path":')),
    sse(fcallDone(0, { type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'read', arguments: '{"path":' })),
    sse(rcompleted('resp-1', 'fake-model', undefined,
      [{ type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'read', arguments: '{"path":' }])),
  ] });
  const { result } = await collect(handler, makeRequest());
  assert.equal(result.kind, 'tool_calls');
  assert.equal(result.toolCalls[0].wireArgumentsInvalid, true);
  looseEqual(result.toolCalls[0].arguments, {});
});

test('responses: duplicate keys in streamed tool args become non-executable', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [
    sse(rcreated()),
    sse(fcallAdded(0, 'fc-1', 'call-1', 'read')),
    sse(fcallArgsDelta(0, 'fc-1', '{"path":"a","path":"b"}')),
    sse(fcallDone(0, { type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'read', arguments: '{"path":"a","path":"b"}' })),
    sse(rcompleted('resp-1', 'fake-model', undefined,
      [{ type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'read', arguments: '{"path":"a","path":"b"}' }])),
  ] });
  const { result } = await collect(handler, makeRequest());
  assert.equal(result.kind, 'tool_calls');
  assert.equal(result.toolCalls[0].wireArgumentsInvalid, true);
  looseEqual(result.toolCalls[0].arguments, {});
});

test('responses: duplicate tool ids across output indexes reject the batch', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [
    sse(rcreated()),
    sse(fcallAdded(0, 'fc-1', 'dup', 'read')),
    sse(fcallDone(0, { type: 'function_call', id: 'fc-1', call_id: 'dup', name: 'read', arguments: '{}' })),
    sse(fcallAdded(1, 'fc-2', 'dup', 'read')),
    sse(fcallDone(1, { type: 'function_call', id: 'fc-2', call_id: 'dup', name: 'read', arguments: '{}' })),
    sse(rcompleted('resp-1', 'fake-model', undefined,
      [{ type: 'function_call', id: 'fc-1', call_id: 'dup', name: 'read', arguments: '{}' },
       { type: 'function_call', id: 'fc-2', call_id: 'dup', name: 'read', arguments: '{}' }])),
  ] });
  const { result } = await collect(handler, makeRequest());
  assert.equal(result.kind, 'malformed_tool_call');
  assert.deepEqual(result.toolCalls, []);
});

test('responses: a changed identity in output_item.done is terminal invalid_response', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [
    sse(rcreated()),
    sse(fcallAdded(0, 'fc-1', 'call-1', 'read')),
    sse(fcallDone(0, { type: 'function_call', id: 'fc-1', call_id: 'PRIVATE_CHANGED', name: 'read', arguments: '{}' })),
    sse(rcompleted('resp-1')),
  ] });
  const { result } = await collect(handler, makeRequest());
  assert.equal(result.kind, 'provider_terminal_error');
  assert.equal(result.failureKind, 'invalid_response');
  assert.ok(!JSON.stringify(result).includes('PRIVATE_CHANGED'));
});

test('responses: hosted tool item types are rejected, not silently dropped', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [
    sse(rcreated()),
    sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'web_search_call', id: 'ws-1' } }),
    sse(rcompleted('resp-1')),
  ] });
  const { result } = await collect(handler, makeRequest());
  assert.equal(result.kind, 'provider_terminal_error');
  assert.equal(result.failureKind, 'invalid_response');
});

// ===================== finish / refusal / limit =========================

test('responses: refusal becomes policy_abort with no tools', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [
    sse(rcreated()),
    sse({ type: 'response.refusal.delta', response_id: 'resp-1', delta: 'I cannot' }),
    sse({ type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg-1', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'I cannot' }] } }),
    sse(rcompleted('resp-1', 'fake-model', { input_tokens: 2, output_tokens: 1 }, [{ type: 'message', id: 'msg-1', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'I cannot' }] }])),
  ] });
  const { result } = await collect(handler, makeRequest());
  assert.equal(result.kind, 'policy_abort');
  assert.deepEqual(result.toolCalls, []);
});

test('responses: incomplete with max_output_tokens and no tools is output_limit', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [
    sse(rcreated()), sse(rtext('partial')),
    sse(rincomplete('resp-1', 'fake-model', 'max_output_tokens', { input_tokens: 3, output_tokens: 8 })),
  ] });
  const { result } = await collect(handler, makeRequest());
  assert.equal(result.kind, 'output_limit');
  assert.equal(result.textCommitVersion, 'provider-finished-text/v1');
  assert.equal(result.text, 'partial');
  assert.deepEqual(result.toolCalls, []);
});

test('responses: incomplete with content_filter reason is policy_abort', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [
    sse(rcreated()), sse(rtext('partial')),
    sse(rincomplete('resp-1', 'fake-model', 'content_filter', { input_tokens: 2, output_tokens: 1 })),
  ] });
  const { result } = await collect(handler, makeRequest());
  assert.equal(result.kind, 'policy_abort');
});

test('responses: incomplete with an unclosed tool input is incomplete (output_limit), not length', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [
    sse(rcreated()),
    sse(fcallAdded(0, 'fc-1', 'call-1', 'read')),
    // no output_item.done, no function_call_arguments.done — the tool input stays open
    sse(rincomplete('resp-1', 'fake-model', 'max_output_tokens', { input_tokens: 2, output_tokens: 4 },
      [{ type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'read', arguments: '' }])),
  ] });
  const { result } = await collect(handler, makeRequest());
  // An unclosed tool input cannot grant bounded-text commit; the finish is
  // 'incomplete' which the normalizer maps to output_limit (never executes tools).
  assert.equal(result.kind, 'output_limit');
  assert.deepEqual(result.toolCalls, []);
});

test('responses: empty response is not a final', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [
    sse(rcreated()), sse(rcompleted('resp-1', 'fake-model', { input_tokens: 2, output_tokens: 0 })),
  ] });
  const { result } = await collect(handler, makeRequest());
  assert.equal(result.kind, 'empty_response');
  assert.equal(result.text, '');
});

// ===================== status conflict / identity / truncation ===========

test('responses: mixed response identities across frames is terminal', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [
    sse(rcreated('resp-1')),
    sse(rtext('A', 'resp-1')),
    sse(rtext('B', 'resp-2')), // foreign identity
  ] });
  const { result } = await collect(handler, makeRequest());
  assert.equal(result.kind, 'provider_terminal_error');
  assert.equal(result.failureKind, 'invalid_response');
  assert.equal(result.text, 'A');
});

test('responses: completed status field conflicting with the event is terminal', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [
    sse(rcreated()), sse(rtext('ok')),
    sse({ type: 'response.completed', response: { id: 'resp-1', status: 'incomplete', usage: { input_tokens: 1, output_tokens: 1 } } }),
  ] });
  const { result } = await collect(handler, makeRequest());
  assert.equal(result.kind, 'provider_terminal_error');
  assert.equal(result.failureKind, 'invalid_response');
});

test('responses: partial EOF without response.completed is retryable incomplete_response', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [
    sse(rcreated()), sse(rtext('partial')),
  ] });
  const { result } = await collect(handler, makeRequest());
  assert.equal(result.kind, 'provider_retryable_error');
  assert.equal(result.failureKind, 'incomplete_response');
  assert.deepEqual(result.toolCalls, []);
});

test('responses: malformed JSON frame is terminal invalid_response', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [sse(rcreated()), sse(rtext('prefix')), 'data: not-json\n\n'] });
  const { result } = await collect(handler, makeRequest());
  assert.equal(result.kind, 'provider_terminal_error');
  assert.equal(result.failureKind, 'invalid_response');
  assert.equal(result.text, 'prefix');
});

test('responses: nested duplicate keys in a buffered response envelope are terminal', async () => {
  const handler = () => ({ status: 200, headers: JSON_HEADERS,
    body: '{"status":"completed","output":[]' + ',"output":[{"type":"message","id":"m","role":"assistant","content":[{"type":"output_text","text":"x"}]}]}' });
  const { result } = await collect(handler, makeRequest());
  assert.equal(result.kind, 'provider_terminal_error');
  assert.equal(result.failureKind, 'invalid_response');
});

// ===================== in-stream errors / cancelled ======================

test('responses: in-stream rate_limit error is retryable', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [sse(rcreated()), sse(rerr({ type: 'rate_limit_error', message: 'secret' }))] });
  const { result } = await collect(handler, makeRequest());
  assert.equal(result.kind, 'provider_retryable_error');
  assert.equal(result.failureKind, 'rate_limit');
});

test('responses: in-stream invalid_request error is terminal client_error', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [sse(rcreated()), sse(rerr({ type: 'invalid_request_error', message: 'secret' }))] });
  const { result } = await collect(handler, makeRequest());
  assert.equal(result.kind, 'provider_terminal_error');
  assert.equal(result.failureKind, 'client_error');
});

test('responses: response.failed with an unknown error code is terminal invalid_response', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [sse(rcreated()), sse(rfailed({ code: 'something_unknown', message: 'secret' }))] });
  const { result } = await collect(handler, makeRequest());
  assert.equal(result.kind, 'provider_terminal_error');
  assert.equal(result.failureKind, 'invalid_response');
});

test('responses: response.cancelled is terminal, not a user abort', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [sse(rcreated()), sse(rtext('partial')), sse(rcancelled())] });
  const { result } = await collect(handler, makeRequest());
  assert.equal(result.kind, 'provider_terminal_error');
  assert.equal(result.failureKind, 'invalid_response');
  assert.notEqual(result.kind, 'user_abort');
});

test('responses: error event preserves reported usage', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [sse(rcreated()), sse({ type: 'error', error: { type: 'rate_limit_error' }, usage: { input_tokens: 7, output_tokens: 2 } })] });
  const { result } = await collect(handler, makeRequest());
  assert.equal(result.kind, 'provider_retryable_error');
  assert.equal(result.usageReported, true);
  assert.equal(result.usage.inputTokens, 7);
});

// ===================== usage completeness / cache / reasoning =============

test('responses: cached and reasoning tokens are retained and usageReported is true', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [
    sse(rcreated()), sse(rtext('Hello')),
    sse(rcompleted('resp-1', 'fake-model', { input_tokens: 12, output_tokens: 7,
      input_tokens_details: { cached_tokens: 5 }, output_tokens_details: { reasoning_tokens: 3 } })),
  ] });
  const { result } = await collect(handler, makeRequest());
  assert.equal(result.usageReported, true);
  assert.equal(result.usage.cachedInputTokens, 5);
  assert.equal(result.usage.reasoningTokens, 3);
});

test('responses: unreported usage yields usageReported false, not a known-zero cost claim', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [
    sse(rcreated()), sse(rtext('done')), sse(rcompleted('resp-1')),
  ] });
  const { result } = await collect(handler, makeRequest());
  assert.equal(result.kind, 'final_candidate');
  assert.equal(result.usageReported, false);
  assert.equal(result.usage.inputTokens, 0);
});

test('responses: partial usage (only input_tokens) stays unknown', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [
    sse(rcreated()), sse(rtext('done')),
    sse(rcompleted('resp-1', 'fake-model', { input_tokens: 12 })),
  ] });
  const { result } = await collect(handler, makeRequest());
  assert.equal(result.kind, 'final_candidate');
  assert.equal(result.usageReported, false);
});

test('responses: malformed usage counter is terminal invalid_response', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [
    sse(rcreated()), sse(rtext('done')),
    sse(rcompleted('resp-1', 'fake-model', { input_tokens: -1, output_tokens: 2 })),
  ] });
  const { result } = await collect(handler, makeRequest());
  assert.equal(result.kind, 'provider_terminal_error');
  assert.equal(result.failureKind, 'invalid_response');
});

// ===================== replay ============================================

test('responses: reasoning_content replay is sealed from reasoning items', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [
    sse(rcreated()),
    sse({ type: 'response.reasoning_summary_text.delta', response_id: 'resp-1', delta: 'PRIVATE' }),
    sse(rtext('42')),
    sse(rcompleted('resp-1', 'fake-model', { input_tokens: 3, output_tokens: 2 })),
  ] });
  const profile = makeProfile({ providerReplayMode: 'reasoning_content', compatibilityDigest: 'a'.repeat(64) });
  const { result, events } = await collect(handler, makeRequest({ profile }));
  assert.equal(result.kind, 'final_candidate');
  assert.equal(result.text, '42');
  assert.equal(result.providerReplay.version, 'model-replay/v1');
  assert.equal(result.providerReplay.reasoningContent, 'PRIVATE');
  assert.equal(result.providerReplay.compatibilityDigest, 'a'.repeat(64));
  assert.ok(events.some((e) => e.kind === 'thinking' && e.text === 'PRIVATE'));
  // private replay never enters an emitted event's metadata
  assert.ok(events.every((e) => !e.metadata || !e.metadata.providerReplay));
});

test('responses: reasoning mode none drops reasoning from stream and replay', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [
    sse(rcreated()),
    sse({ type: 'response.reasoning_summary_text.delta', response_id: 'resp-1', delta: 'PRIVATE' }),
    sse(rtext('42')),
    sse(rcompleted('resp-1', 'fake-model', { input_tokens: 3, output_tokens: 2 })),
  ] });
  const { result, events } = await collect(handler, makeRequest());
  assert.equal(result.kind, 'final_candidate');
  assert.equal(result.providerReplay, undefined);
  assert.ok(!events.some((e) => e.kind === 'thinking'));
});

test('responses: anthropic_content replay mode is rejected at build time (not silently downgraded)', async () => {
  const server = await startServer(() => ({ status: 200, headers: SSE_HEADERS, body: [sse(rcreated()), sse(rtext('ok')), sse(rcompleted('resp-1'))] }));
  try {
    const port = createNativeModelPort({
      resolveProfile: async () => ({ protocol: 'openai-responses', baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: 'fake-key', model: 'fake-model' }),
      fetchImpl: fetch, maxResponseBytes: 4096, idleTimeoutMs: 4000,
    });
    const profile = makeProfile({ providerReplayMode: 'anthropic_content' });
    const r = await port.generate(makeRequest({ profile }), () => {});
    assert.equal(r.kind, 'provider_terminal_error');
    assert.equal(r.failureKind, 'invalid_response');
    assert.equal(server.requests.length, 0, 'no HTTP attempt under a mismatched replay mode');
  } finally { await server.close(); }
});

// ===================== HTTP classification / one attempt ==================

test('responses: HTTP status classification covers retryable and terminal', async () => {
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
    const { result } = await collect(handler, makeRequest());
    assert.equal(result.kind, kind, `status ${status}`);
    if (failureKind) assert.equal(result.failureKind, failureKind, `status ${status}`);
    assert.deepEqual(result.toolCalls, []);
    assert.equal(result.text, '', 'error body never leaks into result text');
  }
});

test('responses: retry-after header is parsed into retryAfterMs', async () => {
  const handler = () => ({ status: 429, headers: { 'retry-after': '3.5' }, body: '{}' });
  const { result } = await collect(handler, makeRequest());
  assert.equal(result.kind, 'provider_retryable_error');
  assert.equal(result.retryAfterMs, 3500);
});

test('responses: 400 with context_length_exceeded is context_overflow', async () => {
  const handler = () => ({ status: 400, body: '{"error":{"code":"context_length_exceeded","message":"secret"}}' });
  const { result } = await collect(handler, makeRequest());
  assert.equal(result.kind, 'context_overflow');
  const handler2 = () => ({ status: 400, body: '{"error":{"message":"context_length_exceeded"}}' });
  const { result: r2 } = await collect(handler2, makeRequest());
  assert.equal(r2.kind, 'provider_terminal_error');
});

test('responses: one provider attempt despite a retryable 429 (no adapter retry)', async () => {
  let calls = 0;
  const handler = () => { calls += 1; return { status: 429, headers: { 'retry-after': '0' }, body: '{"error":{"type":"rate_limit_error"}}' }; };
  const { result } = await collect(handler, makeRequest());
  assert.equal(result.kind, 'provider_retryable_error');
  assert.equal(calls, 1, 'the adapter issues exactly one HTTP attempt');
});

test('responses: one provider attempt despite a retryable in-stream error', async () => {
  let calls = 0;
  const handler = () => { calls += 1; return { status: 200, headers: SSE_HEADERS, body: [sse(rcreated()), sse(rerr({ type: 'overloaded_error' }))] }; };
  const { result } = await collect(handler, makeRequest());
  assert.equal(result.kind, 'provider_retryable_error');
  assert.equal(calls, 1);
});

test('responses: no persisted credentials: apiKey is not in result or request body', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [sse(rcreated()), sse(rtext('done')), sse(rcompleted('resp-1'))] });
  const { result, requests } = await collect(handler, makeRequest());
  assert.equal(JSON.stringify(result).includes('fake-key'), false);
  assert.equal(requests[0].body.includes('fake-key'), false);
});

// ===================== timeout / abort / buffer limits ===================

test('responses: idle silence is a retryable request_timeout', async () => {
  async function* stall() { await new Promise(() => {}); }
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: stall() });
  await withServer(handler, async (server) => {
    const port = createNativeModelPort({
      resolveProfile: async () => ({ protocol: 'openai-responses', baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: 'fake-key', model: 'fake-model' }),
      fetchImpl: fetch, maxResponseBytes: 1024 * 1024, idleTimeoutMs: 60,
    });
    const result = await port.generate(makeRequest(), () => {});
    assert.equal(result.kind, 'provider_retryable_error');
    assert.equal(result.failureKind, 'request_timeout');
  });
});

test('responses: response exceeding maxResponseBytes is terminal', async () => {
  const big = 'data: ' + JSON.stringify(rtext('x'.repeat(2000))) + '\n\n';
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [big, sse(rcreated())] });
  const { result } = await collect(handler, makeRequest(), { maxResponseBytes: 512 });
  assert.equal(result.kind, 'provider_terminal_error');
  assert.equal(result.failureKind, 'invalid_response');
});

test('responses: caller abort propagates and does not produce a final', async () => {
  let release;
  const handler = () => new Promise((resolve) => {
    release = () => resolve({ status: 200, headers: SSE_HEADERS, body: [sse(rcreated()), sse(rtext('partial'))] });
    setTimeout(release, 100);
  });
  await withServer(handler, async (server) => {
    const port = createNativeModelPort({
      resolveProfile: async () => ({ protocol: 'openai-responses', baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: 'fake-key', model: 'fake-model' }),
      fetchImpl: fetch,
    });
    const ac = new AbortController();
    const p = port.generate(makeRequest({ signal: ac.signal }), () => {});
    ac.abort();
    await assert.rejects(p);
  });
});

test('responses: a protocol terminal seals the attempt without waiting for socket EOF', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [sse(rcreated()), sse(rtext('done')), sse(rcompleted('resp-1')), { delay: 1000 }] });
  const { result } = await collect(handler, makeRequest({ profile: makeProfile({ requestTimeoutMs: 300 }) }));
  assert.equal(result.kind, 'final_candidate');
  assert.equal(result.text, 'done');
});

// ===================== buffered 2xx (non-SSE) =============================

test('responses: buffered 2xx completed final candidate parses', async () => {
  const handler = () => ({ status: 200, headers: JSON_HEADERS,
    body: JSON.stringify({ id: 'resp-1', status: 'completed', output: [{ type: 'message', id: 'm1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'buffered' }] }], usage: { input_tokens: 3, output_tokens: 2 } }) });
  const { result } = await collect(handler, makeRequest());
  assert.equal(result.kind, 'final_candidate');
  assert.equal(result.text, 'buffered');
  assert.equal(result.usage.inputTokens, 3);
});

test('responses: buffered 2xx failed status is terminal invalid_response', async () => {
  const handler = () => ({ status: 200, headers: JSON_HEADERS, body: JSON.stringify({ status: 'failed', error: { code: 'server_error' } }) });
  const { result } = await collect(handler, makeRequest());
  assert.equal(result.kind, 'provider_terminal_error');
  assert.equal(result.failureKind, 'invalid_response');
});

test('responses: buffered output_text convenience must match canonical output', async () => {
  const handler = () => ({ status: 200, headers: JSON_HEADERS, body: JSON.stringify({
    status: 'completed', output_text: 'mismatch',
    output: [{ type: 'message', id: 'm1', role: 'assistant', content: [{ type: 'output_text', text: 'real' }] }] }) });
  const { result } = await collect(handler, makeRequest());
  assert.equal(result.kind, 'provider_terminal_error');
  assert.equal(result.failureKind, 'invalid_response');
});

test('responses: resolveProfile failure is a terminal host_error without leaking the exception', async () => {
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

// ===================== snapshot reconciliation ===========================

test('responses: completed output reconciles legacy streamed text via the message snapshot', async () => {
  // Stream partial text as a legacy (unindexed) delta, then let the completed
  // output array supply the authoritative message snapshot. The message takes
  // output_index 0 (no streamed item occupies that slot) and the projection's
  // canonical text extends the observed prefix.
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [
    sse(rcreated()),
    sse(rtext('Hel')),
    sse(rcompleted('resp-1', 'fake-model', { input_tokens: 4, output_tokens: 6 },
      [{ type: 'message', id: 'msg-1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Hello' }] }])),
  ] });
  const { result, events } = await collect(handler, makeRequest({ tools: [] }));
  assert.equal(result.kind, 'final_candidate');
  assert.equal(result.text, 'Hello');
  assert.deepEqual(events.filter((e) => e.kind === 'text').map((e) => e.text), ['Hel', 'lo']);
});

test('responses: completed output fills a declared-but-undone tool call', async () => {
  // The function_call is declared and partially streamed, but never sealed by
  // an output_item.done. The completed output array supplies the authoritative
  // closed snapshot at the same output_index, filling the gap.
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [
    sse(rcreated()),
    sse(fcallAdded(0, 'fc-1', 'call-1', 'read')),
    sse(fcallArgsDelta(0, 'fc-1', '{"path":')),
    sse(rcompleted('resp-1', 'fake-model', { input_tokens: 3, output_tokens: 5 },
      [{ type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'read', arguments: '{"path":"a.py"}' }])),
  ] });
  const { result } = await collect(handler, makeRequest());
  assert.equal(result.kind, 'tool_calls');
  assert.equal(result.toolCalls.length, 1);
  looseEqual(result.toolCalls[0].arguments, { path: 'a.py' });
});

test('responses: completed output that drops a streamed tool call is terminal', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [
    sse(rcreated()),
    sse(fcallAdded(0, 'fc-1', 'call-1', 'read')),
    sse(fcallDone(0, { type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'read', arguments: '{}' })),
    // completed output omits fc-1 entirely
    sse(rcompleted('resp-1', 'fake-model', { input_tokens: 2, output_tokens: 2 }, [])),
  ] });
  const { result } = await collect(handler, makeRequest());
  assert.equal(result.kind, 'provider_terminal_error');
  assert.equal(result.failureKind, 'invalid_response');
});

test('responses: conflicting successful terminal with an error cannot authorize tools or a bounded answer', async () => {
  for (const type of ['response.completed', 'response.incomplete']) {
    const { result } = await collect(() => ({ headers: SSE_HEADERS, body: [
      sse(rcreated()), sse(rtext('partial')),
      sse({ type, response: { id: 'resp-1', model: 'fake-model', error: { code: 'invalid_api_key' },
        usage: { input_tokens: 11, output_tokens: 5 },
        ...(type.endsWith('incomplete') ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
        output: [{ type: 'function_call', id: 'f1', call_id: 'c1', name: 'write', arguments: '{}', status: 'completed' }] } }),
    ] }), makeRequest());
    assert.equal(result.kind, 'provider_terminal_error', type);
    assert.deepEqual(result.toolCalls, []);
    assert.equal(result.usage.inputTokens, 11);
    assert.equal(result.usage.outputTokens, 5);
  }
});

test('responses: historical malformed arguments are rejected before HTTP instead of becoming an empty object', async () => {
  const cycle = {}; cycle.self = cycle;
  for (const arguments_ of [null, 'bad', [], { bad: NaN }, { bad: undefined }, cycle]) {
    const { result, requests } = await collect(() => ({ headers: JSON_HEADERS, body: '{}' }), makeRequest({ messages: [
      { role: 'assistant', content: '', toolCalls: [{ callId: 'c1', name: 'read', arguments: arguments_ }] },
      { role: 'tool', callId: 'c1', name: 'read', content: 'done' },
      { role: 'user', content: 'continue' },
    ] }));
    assert.equal(result.kind, 'provider_terminal_error');
    assert.deepEqual(result.toolCalls, []);
    assert.equal(requests.length, 0);
  }
});

test('responses: malformed buffered message content cannot be hidden beside a valid function call', async () => {
  for (const content of [null, 'not-parts', {}]) {
    const { result } = await collect(() => ({ headers: JSON_HEADERS, body: JSON.stringify({
      id: 'resp-1', model: 'fake-model', status: 'completed', output: [
        { type: 'message', id: 'm1', role: 'assistant', content },
        { type: 'function_call', id: 'f1', call_id: 'c1', name: 'read', arguments: '{}' },
      ],
    }) }), makeRequest());
    assert.equal(result.kind, 'provider_terminal_error');
    assert.deepEqual(result.toolCalls, []);
  }
});

test('responses: complete argument snapshots cannot rewrite already streamed arguments', async () => {
  for (const terminal of [
    fcallArgsDone(0, 'f1', '{"path":"other"}'),
    fcallDone(0, { type: 'function_call', id: 'f1', call_id: 'c1', name: 'read', arguments: '{"path":"other"}' }),
  ]) {
    const { result } = await collect(() => ({ headers: SSE_HEADERS, body: [
      sse(rcreated()), sse(fcallAdded(0, 'f1', 'c1', 'read')),
      sse(fcallArgsDelta(0, 'f1', '{"path":"safe')),
      sse(terminal), sse(rcompleted()),
    ] }), makeRequest());
    assert.equal(result.kind, 'provider_terminal_error');
    assert.deepEqual(result.toolCalls, []);
  }
});

test('responses: host parameters cannot enable hidden conversation history, background work, or automatic truncation', async () => {
  const { result, requests } = await collect(() => ({ headers: SSE_HEADERS, body: [
    sse(rcreated()), sse(rtext('done')), sse(rcompleted()),
  ] }), makeRequest(), { bindingExtra: { parameters: {
    previous_response_id: 'foreign-history', conversation: 'foreign-conversation', background: true,
    truncation: 'auto', temperature: 0.2,
  } } });
  assert.equal(result.kind, 'final_candidate');
  const body = JSON.parse(requests[0].body);
  for (const key of ['previous_response_id', 'conversation', 'background']) assert.equal(key in body, false);
  assert.equal(body.truncation, 'disabled');
  assert.equal(body.temperature, 0.2);
});

test('responses: indexed reasoning summary does not require an optional reasoning content array', async () => {
  const reasoning = { type: 'reasoning', id: 'reason-1', summary: [{ type: 'summary_text', text: 'PRIVATE' }] };
  const message = { type: 'message', id: 'message-1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done' }] };
  for (const providerReplayMode of ['none', 'reasoning_content']) for (const providerThinkingDisplay of [undefined, false, true]) {
    const { result, events } = await collect(() => ({ headers: SSE_HEADERS, body: [
      sse(rcreated()),
      sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'reason-1', summary: [] } }),
      sse({ type: 'response.reasoning_summary_text.delta', output_index: 0, item_id: 'reason-1', summary_index: 0, delta: 'PRIVATE' }),
      sse({ type: 'response.reasoning_summary_text.done', output_index: 0, item_id: 'reason-1', summary_index: 0, text: 'PRIVATE' }),
      sse(fcallDone(0, reasoning)), sse(fcallDone(1, message)),
      sse(rcompleted('resp-1', 'fake-model', undefined, [reasoning, message])),
    ] }), makeRequest({ profile: makeProfile({ providerReplayMode,
      ...(providerThinkingDisplay === undefined ? {} : { providerThinkingDisplay }) }) }));
    assert.equal(result.kind, 'final_candidate');
    assert.equal(result.text, 'done');
    assert.deepEqual(result.toolCalls, []);
    assert.equal(events.filter(e => e.kind === 'thinking').map(e => e.text).join(''),
      (providerThinkingDisplay ?? providerReplayMode !== 'none') ? 'PRIVATE' : '');
    assert.equal(result.providerReplay?.reasoningContent, providerReplayMode === 'none' ? undefined : 'PRIVATE');
  }
});
