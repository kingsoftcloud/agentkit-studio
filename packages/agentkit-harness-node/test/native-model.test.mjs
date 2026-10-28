// Protocol-conformance tests for the native model adapter over a real local
// HTTP server streaming controlled protocol bytes. These exercise the wire
// normalization, SSE framing, tool assembly, error/refusal normalization,
// Retry-After, private replay and media projection — never live models and
// never mocking fetch. Fake credentials only.

import test from 'node:test';
import assert from 'node:assert/strict';
import { deepEqual as looseEqual } from 'node:assert';
import http from 'node:http';
import { createNativeModelPort } from '../src/native/model-port.mjs';
import { readModelSse } from '../src/native/model-sse.mjs';
import { admitInlineReasoningPolicy, inlineReasoningMarker, projectInlineReasoning } from '../src/native/model-inline-reasoning.mjs';
import { admitProviderCompatibilityPolicy } from '../src/native/model-provider-compat.mjs';
import { NativeKernel, MemoryRunStore } from '../../agentkit-harness-core/dist/index.mjs';
import { fixture as coreFixture, scope as coreScope, digest as coreDigest, tool as coreTool } from '../../agentkit-harness-core/test/fixtures.mjs';

test('idle policy HTTP: hidden reasoning keeps a long real stream alive across adapter and kernel deadlines', async () => {
  const handler = () => ({ headers: SSE_HEADERS, body: (async function* () {
    for (let index = 0; index < 14; index++) { yield sse(ochunk({ reasoning_content: 'private ' })); yield { delay: 60 }; }
    yield sse(ochunk({ content: 'Answer' }, 'stop')); yield sseDone();
  })() });
  await withServer(handler, async server => {
    const { config, snapshot } = coreFixture({ profile: makeProfile({ compatibilityDigest: 'http-stream/v1', requestTimeoutMs: 250, streaming: true,
      streamTimeoutPolicy: 'idle/v1', providerReplayMode: 'reasoning_content', providerThinkingDisplay: false, maxProviderRetries: 0 }),
    limits: { effectTimeoutMs: 600, maxWallMs: 5000 } });
    const store = new MemoryRunStore(); store.create(config, snapshot); const seen = [];
    const kernel = new NativeKernel({ store, digest: coreDigest, owner: 'http-stream',
      ports: { model: makePort({ port: server.port, protocol: 'openai-chat' }) }, onStream: (_, event) => seen.push(event) });
    const result = await kernel.runUntilIdle(coreScope, 'run');
    assert.equal(result.finalText, 'Answer'); assert.equal(result.usage.modelCalls, 1); assert.equal(server.requests.length, 1);
    assert.deepEqual(seen, [{ kind: 'text', text: 'Answer' }]);
    const receipt = store.load(coreScope, 'run').receipts[0];
    assert.equal(receipt.result.providerReplay.reasoningContent, 'private '.repeat(14));
    assert.deepEqual(receipt.result.displayStream.records.map(record => record.event), seen);
  });
});

test('idle policy HTTP: comments cannot keep a silent provider alive', async () => {
  const { result, events, requests } = await collect(null, 'openai-chat', () => ({ headers: SSE_HEADERS,
    body: [': heartbeat\n\n', sse(''), { delay: 180 }, ': heartbeat\n\n', sse(ochunk({ content: 'late' }, 'stop')), sseDone()] }),
  makeRequest({ profile: makeProfile({ streaming: true, streamTimeoutPolicy: 'idle/v1', requestTimeoutMs: 80 }) }));
  assert.equal(result.kind, 'provider_retryable_error'); assert.equal(result.failureKind, 'request_timeout');
  assert.equal(events.length, 0); assert.equal(requests.length, 1);
});

test('thinking display HTTP: OpenAI display and private replay are independent', async t => {
  for (const [display, replay] of [[false, 'reasoning_content'], [true, 'reasoning_content'], [true, 'none']]) await t.test(`${display}/${replay}`, async () => {
    const { result, events } = await collect(null, 'openai-chat', () => ({ headers: SSE_HEADERS,
      body: [sse(ochunk({ reasoning_content: 'PRIVATE' })), sse(ochunk({ content: 'Answer' }, 'stop')), sseDone()] }),
    makeRequest({ profile: makeProfile({ providerReplayMode: replay, providerThinkingDisplay: display }) }));
    assert.equal(result.kind, 'final_candidate'); assert.equal(result.text, 'Answer');
    assert.equal(events.some(event => event.kind === 'thinking' && event.text === 'PRIVATE'), display);
    assert.equal(result.providerReplay?.reasoningContent, replay === 'none' ? undefined : 'PRIVATE');
  });
});

test('provider compatibility HTTP: pinned options reach the actual buffered request without retries', async t => {
  for (const [model, rule, effort, thinking] of [
    ['glm-5.3-flash', 'zai', 'high', { type: 'disabled' }],
    ['kimi-k2.7-code', 'kspmas-gateway', undefined, undefined],
    ['gpt-fixture', 'strict-openai', 'medium', undefined],
  ]) await t.test(model, async () => {
    const { result, requests } = await collect(null, 'openai-chat', () => ({ headers: JSON_HEADERS,
      body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Done' } }] }) }),
    makeRequest({ profile: makeProfile({ streaming: false, parallelToolCalls: false, reasoningEffort: 'medium',
      providerCompatibilityPolicy: admitProviderCompatibilityPolicy(rule) }) }), { bindingExtra: { model } });
    assert.equal(result.kind, 'final_candidate'); assert.equal(result.text, 'Done'); assert.equal(requests.length, 1);
    const body = JSON.parse(requests[0].body);
    assert.equal(body.stream, false); assert.equal(body.parallel_tool_calls, false);
    assert.equal(body.reasoning_effort, effort); assert.deepEqual(body.thinking, thinking);
  });
});

test('inline reasoning: reference provider selection preserves unrelated and legacy content', () => {
  const text = 'private</think>public', auto = admitInlineReasoningPolicy();
  for (const [policy, binding, expected] of [
    [auto, { model: 'glm-5.3-flash' }, 'public'],
    [auto, { model: 'glm-5.3-flash', baseUrl: 'https://deepseek.invalid' }, text],
    [auto, { model: 'kimi-k2.7-code', baseUrl: 'https://kspmas.invalid' }, text],
    [auto, { model: 'unknown' }, text],
    [admitInlineReasoningPolicy('strict-openai'), { model: 'glm' }, text],
    [admitInlineReasoningPolicy('unknown-rule'), { model: 'glm' }, text],
    [undefined, { model: 'glm' }, text],
  ]) assert.equal(projectInlineReasoning(text, inlineReasoningMarker(policy, binding)), expected);
});

test('inline reasoning: real HTTP stream and buffered responses follow the Python projection', async t => {
  const profile = makeProfile({ inlineReasoningPolicy: admitInlineReasoningPolicy('zai') });
  for (const streaming of [false, true]) for (const [chunks, expected] of [
    [['The screenshot shows 6428.</thi', 'nk>64', '28'], '6428'],
    [['Ordinary ', 'answer'], 'Ordinary answer'],
    [['\u0085<think>unfinished'], ''],
  ]) await t.test(`${streaming ? 'stream' : 'buffered'} ${JSON.stringify(expected)}`, async () => {
    const handler = () => streaming ? { headers: SSE_HEADERS, body: [
      ...chunks.map(text => sse(ochunk({ content: text }))), sse(ochunk({}, 'stop')), sseDone(),
    ] } : { headers: JSON_HEADERS, body: JSON.stringify({ choices: [{ finish_reason: 'stop',
      message: { role: 'assistant', content: chunks.join('') } }] }) };
    const { result, events, requests } = await collect(null, 'openai-chat', handler, makeRequest({ profile }));
    assert.equal(result.text, expected);
    assert.equal(result.kind, expected ? 'final_candidate' : 'empty_response');
    if (streaming) assert.equal(events.filter(event => event.kind === 'text').map(event => event.text).join(''), expected);
    assert.equal(requests.length, 1);
  });
});

test('inline reasoning: incomplete streams never release pending private content', async () => {
  const { result, events } = await collect(null, 'openai-chat', () => ({ headers: SSE_HEADERS,
    body: [sse(ochunk({ content: '<think>unfinished' }))] }),
  makeRequest({ profile: makeProfile({ inlineReasoningPolicy: admitInlineReasoningPolicy('zai') }) }));
  assert.equal(result.kind, 'provider_retryable_error');
  assert.equal(result.text, '');
  assert.equal(events.some(event => event.kind === 'text'), false);
});

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

for (const protocol of ['openai-chat', 'openai-responses', 'anthropic-messages']) test(`buffered thinking display HTTP: ${protocol} separates public content from replay and opaque bytes`, async t => {
  const body = protocol === 'openai-chat' ? { choices: [{ finish_reason: 'stop', message: {
    role: 'assistant', content: 'Answer', reasoning_content: 'DISPLAY_THOUGHT' } }] }
    : protocol === 'openai-responses' ? { id: 'resp-buffered-thinking', model: 'fake-model', status: 'completed', output: [
      { type: 'reasoning', id: 'reasoning-1', summary: [{ type: 'summary_text', text: 'DISPLAY_THOUGHT' }], encrypted_content: 'OPAQUE_PRIVATE_BYTES' },
      { type: 'message', id: 'message-1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Answer' }] },
    ] } : { type: 'message', content: [
      { type: 'thinking', thinking: 'DISPLAY_THOUGHT', signature: 'PRIVATE_SIGNATURE' },
      { type: 'redacted_thinking', data: 'OPAQUE_PRIVATE_BYTES' }, { type: 'text', text: 'Answer' },
    ], stop_reason: 'end_turn' };
  const replayMode = protocol === 'anthropic-messages' ? 'anthropic_content' : 'reasoning_content';
  for (const [policy, display, replay] of [[true, true, 'none'], [true, true, replayMode],
    [true, false, replayMode], [false, true, replayMode]]) await t.test(`${policy ? 'new' : 'legacy'}/${display}/${replay}`, async () => {
    const { result, events, requests } = await collect(null, protocol, () => ({ headers: JSON_HEADERS, body: JSON.stringify(body) }),
      makeRequest({ profile: makeProfile({ streaming: false, providerReplayMode: replay, providerThinkingDisplay: display,
        compatibilityDigest: 'b'.repeat(64), ...(policy ? { providerThinkingDisplayPolicy: 'provider-visible/v1' } : {}) }) }));
    assert.equal(result.kind, 'final_candidate'); assert.equal(result.text, 'Answer'); assert.equal(requests.length, 1);
    assert.deepEqual(events, policy && display ? [{ kind: 'thinking', text: 'DISPLAY_THOUGHT' }] : []);
    assert.doesNotMatch(JSON.stringify(events), /OPAQUE_PRIVATE_BYTES|PRIVATE_SIGNATURE/);
    assert.equal(Boolean(result.providerReplay), replay !== 'none');
    const wire = JSON.parse(requests[0].body);
    assert.equal(wire.provider_thinking_display, undefined); assert.equal(wire.providerThinkingDisplayPolicy, undefined);
  });
  const malformed = structuredClone(body);
  if (protocol === 'openai-chat') malformed.choices[0].message.content = 4;
  else if (protocol === 'openai-responses') malformed.output_text = 'Conflicting body';
  else malformed.content.push({ type: 'tool_use', id: '', name: 'write', input: {} });
  const invalid = await collect(null, protocol, () => ({ headers: JSON_HEADERS, body: JSON.stringify(malformed) }),
    makeRequest({ profile: makeProfile({ streaming: false, providerReplayMode: 'none', providerThinkingDisplay: true,
      providerThinkingDisplayPolicy: 'provider-visible/v1' }) }));
  assert.equal(invalid.result.kind, 'provider_terminal_error'); assert.deepEqual(invalid.events, [],
    'A buffered body must pass all envelope validation before publishing reasoning');
});

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
  looseEqual(result.toolCalls[0].arguments, { path: 'a.py' });
  assert.ok(events.some((e) => e.kind === 'tool_delta'));
});

test('openai: null fields in later tool fragments do not erase a prior identity', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [
    sse(ochunk({ tool_calls: [{ index: 0, id: 'policy-call', type: 'function',
      function: { name: 'lookup_policy', arguments: '' } }] })),
    sse(ochunk({ tool_calls: [{ index: 0, id: null, type: 'function',
      function: { name: null, arguments: '{}' } }] })),
    sse(ochunk({}, 'tool_calls', { usage: { prompt_tokens: 12, completion_tokens: 3 } })), sseDone(),
  ] });
  const { result } = await collect(0, 'openai-chat', handler, makeRequest());
  assert.equal(result.kind, 'tool_calls');
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].callId, 'policy-call');
  assert.equal(result.toolCalls[0].name, 'lookup_policy');
  looseEqual(result.toolCalls[0].arguments, {});
  assert.equal(result.usage.inputTokens, 12);
});

test('openai: a different non-null identity after a null fragment still rejects the batch', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [
    sse(ochunk({ tool_calls: [{ index: 0, id: 'original', type: 'function',
      function: { name: 'read', arguments: '' } }] })),
    sse(ochunk({ tool_calls: [{ index: 0, id: null, function: { name: null, arguments: '{}' } }] })),
    sse(ochunk({ tool_calls: [{ index: 0, id: 'different' }] })),
    sse(ochunk({}, 'tool_calls')), sseDone(),
  ] });
  const { result } = await collect(0, 'openai-chat', handler, makeRequest());
  assert.equal(result.kind, 'malformed_tool_call');
  assert.deepEqual(result.toolCalls, []);
});

test('openai: length truncation never executes partial tool calls', async () => {
  const handler = () => ({
    status: 200, headers: SSE_HEADERS,
    body: [sse(ochunk({ content: 'partial', tool_calls: [{ index: 0, id: 'c', type: 'function', function: { name: 'read', arguments: '{"path":' } }] }, 'length',
      { usage: { prompt_tokens: 5, completion_tokens: 2 } })), sseDone()],
  });
  const { result } = await collect(0, 'openai-chat', handler, makeRequest());
  assert.equal(result.kind, 'output_limit');
  assert.equal(result.textCommitVersion, 'provider-finished-text/v1');
  assert.equal(result.text, 'partial');
  assert.deepEqual(result.toolCalls, []);
  assert.equal(result.usage.inputTokens, 5);
});

test('openai: length followed by EOF without DONE is uncommitted transport text', async () => {
  const { result } = await collect(0, 'openai-chat', () => ({ status: 200, headers: SSE_HEADERS,
    body: [sse(ochunk({ content: 'Partial summary' }, 'length'))] }), makeRequest());
  assert.equal(result.kind, 'provider_retryable_error'); assert.equal(result.textCommitVersion, undefined);
  assert.equal(result.providerReplay, undefined); assert.deepEqual(result.toolCalls, []);
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
  looseEqual(result.toolCalls[0].arguments, {});
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

// ZCode reference: turn-output-token-continuation.ts at 3c5b227. A successful
// generated response that fills the context window is output truncation; a
// rejected overlong input remains a separate context-overflow failure.
for (const streaming of [false, true]) {
  test(`zcode alignment: completed context-window truncation preserves text and usage, streaming=${streaming}`, async () => {
    const { result } = await collect(0, 'anthropic-messages', () => streaming
      ? { headers: SSE_HEADERS, body: anthropicFinalText('Continue this', { stop: 'model_context_window_exceeded' }) }
      : { headers: JSON_HEADERS, body: JSON.stringify({ content: [{ type: 'text', text: 'Continue this' }],
        stop_reason: 'model_context_window_exceeded', usage: { input_tokens: 7, output_tokens: 3 } }) }, makeRequest());
    assert.equal(result.kind, 'output_limit');
    assert.equal(result.text, 'Continue this');
    assert.equal(result.textCommitVersion, 'provider-finished-text/v1');
    assert.deepEqual(result.toolCalls, []);
    assert.equal(result.usage.inputTokens, 7);
    assert.equal(result.usage.outputTokens, 3);
  });
}

test('zcode alignment: context-window truncation cannot dispatch a parseable but unfinished tool batch', async () => {
  const { result } = await collect(0, 'anthropic-messages', () => ({ headers: JSON_HEADERS,
    body: JSON.stringify({ content: [{ type: 'tool_use', id: 'unfinished', name: 'read', input: {} }],
      stop_reason: 'model_context_window_exceeded', usage: { input_tokens: 7, output_tokens: 3 } }) }), makeRequest());
  assert.equal(result.kind, 'output_limit');
  assert.deepEqual(result.toolCalls, []);
});

test('zcode alignment: context-window marker without message_stop is an incomplete transport attempt', async () => {
  const frames = anthropicFinalText('Partial', { stop: 'model_context_window_exceeded' });
  const { result } = await collect(0, 'anthropic-messages', () => ({ headers: SSE_HEADERS, body: frames.slice(0, -1) }), makeRequest());
  assert.equal(result.kind, 'provider_retryable_error');
  assert.deepEqual(result.toolCalls, []);
  assert.equal(result.textCommitVersion, undefined);
});

test('zcode alignment: completed context-window truncation resumes the Native task and executes only the subsequent complete call', async () => {
  let executions = 0;
  await withServer((_request, _body, index) => ({ headers: JSON_HEADERS, body: JSON.stringify(index === 0
    ? { content: [{ type: 'text', text: 'Unfinished work' }, { type: 'tool_use', id: 'partial', name: 'write', input: {} }],
      stop_reason: 'model_context_window_exceeded', usage: { input_tokens: 7, output_tokens: 3 } }
    : index === 1
      ? { content: [{ type: 'tool_use', id: 'complete', name: 'write', input: {} }],
        stop_reason: 'tool_use', usage: { input_tokens: 8, output_tokens: 2 } }
      : { content: [{ type: 'text', text: 'Completed task' }], stop_reason: 'end_turn',
        usage: { input_tokens: 9, output_tokens: 2 } }) }), async server => {
    const { config, snapshot } = coreFixture({ outputRecoveryPolicy: 'task-or-delivery/v1',
      tools: [coreTool({ name: 'write', readOnly: false, concurrentSafe: false })],
      profile: { profileId: 'test', profileVersion: '1', compatibilityDigest: 'fixture/v1', providerFamily: 'anthropic-messages' } });
    const model = createNativeModelPort({ resolveProfile: async () => ({ protocol: 'anthropic-messages',
      baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: 'fake-key', model: 'fake-model' }) });
    const store = new MemoryRunStore();
    const kernel = new NativeKernel({ store, digest: coreDigest, owner: 'context-limit-test', ports: { model,
      tools: { execute: async request => {
        assert.equal(request.call.callId, 'complete'); executions++;
        return { status: 'ok', content: 'written' };
      } } } });
    kernel.start(snapshot, config);
    const end = await kernel.runUntilIdle(coreScope, 'run');
    assert.equal(end.phase, 'completed');
    assert.equal(end.finalText, 'Completed task');
    assert.equal(executions, 1);
    assert.equal(server.requests.length, 3);
    assert.equal(end.usage.modelCalls, 3);
    assert.equal(end.usage.toolCalls, 1);
    assert.equal(end.usage.inputTokens, 24);
    assert.equal(end.usage.outputTokens, 7);
    const resumed = JSON.parse(server.requests[1].body);
    assert.ok(resumed.messages.some(message => message.content.some(block => block.type === 'text' && /interrupted|resume/i.test(block.text))));
  });
});

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
  looseEqual(result.toolCalls[0].arguments, { path: 'a.py' });
  assert.ok(events.some((e) => e.kind === 'tool_delta'));
});

for (const providerThinkingDisplay of [undefined, false, true]) test(`anthropic: signed thinking captured into anthropic_content replay (thinking display ${providerThinkingDisplay ?? 'legacy'})`, async () => {
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
    makeRequest({ profile: makeProfile({ providerReplayMode: 'anthropic_content',
      ...(providerThinkingDisplay === undefined ? {} : { providerThinkingDisplay }) }) }));
  assert.equal(result.kind, 'final_candidate');
  assert.equal(result.text, 'Answer');
  assert.ok(result.providerReplay);
  assert.equal(result.providerReplay.version, 'model-replay/v2');
  const thinkingBlock = result.providerReplay.anthropicContent.find((b) => b.type === 'thinking');
  assert.equal(thinkingBlock.thinking, 'PRIVATE_THINKING');
  assert.equal(thinkingBlock.signature, 'sig123');
  // thinking emitted for display; signature never in stream metadata
  assert.equal(events.some((e) => e.kind === 'thinking' && e.text === 'PRIVATE_THINKING'), providerThinkingDisplay ?? true);
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
  assert.equal(result.textCommitVersion, 'provider-finished-text/v1');
  assert.equal(result.text, 'partial');
});

test('anthropic: max_tokens without message_stop remains uncommitted transport text', async () => {
  const body = anthropicFinalText('Partial summary', { stop: 'max_tokens' }).slice(0, -1);
  const { result } = await collect(0, 'anthropic-messages', () => ({ status: 200, headers: SSE_HEADERS, body }), makeRequest());
  assert.equal(result.kind, 'provider_retryable_error'); assert.equal(result.textCommitVersion, undefined);
  assert.deepEqual(result.toolCalls, []);
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
  looseEqual(result.toolCalls[0].arguments, {});
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
  const { requests: r2 } = await collect(0, 'anthropic-messages', handler, makeRequest({ profile, messages: [assistantMessage, { role: 'tool', callId: 'tu-1', content: 'read result' }, { role: 'user', content: 'again' }] }));
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

// ===== Fix 1: replay profile binding + replayToolIds ======================

test('openai: cross-profile replay is dropped (no reasoning_content on the wire)', async () => {
  const digestA = 'a'.repeat(64), digestB = 'b'.repeat(64);
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [sse(ochunk({ reasoning_content: 'PRIVATE_A' })), sse(ochunk({ content: '42' }, 'stop')), sseDone()] });
  // Seal replay under profile A.
  const profileA = makeProfile({ providerReplayMode: 'reasoning_content', compatibilityDigest: digestA });
  const { result } = await collect(0, 'openai-chat', handler, makeRequest({ profile: profileA }));
  assert.equal(result.providerReplay.reasoningContent, 'PRIVATE_A');
  assert.equal(result.providerReplay.compatibilityDigest, digestA);
  // Re-project under profile B (different compatibilityDigest): the replay must
  // be dropped so private material never leaks onto another model's wire.
  const profileB = makeProfile({ providerReplayMode: 'reasoning_content', compatibilityDigest: digestB });
  const assistant = { role: 'assistant', content: '42', toolCalls: [], providerReplay: result.providerReplay };
  const handler2 = () => ({ status: 200, headers: SSE_HEADERS, body: [sse(ochunk({ content: 'ok' }, 'stop')), sseDone()] });
  const { requests } = await collect(0, 'openai-chat', handler2, makeRequest({ profile: profileB, messages: [assistant, { role: 'user', content: 'again' }] }));
  const body = JSON.parse(requests[0].body);
  assert.equal(body.messages[0].reasoning_content, undefined);
});

test('anthropic: replayToolIds map the original tool_use id to the canonical id', async () => {
  const digest = 'c'.repeat(64);
  const handler = () => ({
    status: 200, headers: SSE_HEADERS,
    body: [
      ae('message_start', { type: 'message_start', message: { id: 'm1', model: 'fake-model', role: 'assistant', usage: { input_tokens: 2, output_tokens: 0 } } }),
      ae('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'orig-1', name: 'read', input: {} } }),
      ae('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"f"}' } }),
      ae('content_block_stop', { type: 'content_block_stop', index: 0 }),
      ae('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 3 } }),
      ae('message_stop', { type: 'message_stop' }),
    ],
  });
  const profile = makeProfile({ providerReplayMode: 'anthropic_content', compatibilityDigest: digest });
  const { result } = await collect(0, 'anthropic-messages', handler, makeRequest({ profile }));
  assert.equal(result.kind, 'tool_calls');
  assert.equal(result.providerReplay.compatibilityDigest, digest);
  // The kernel remaps orig-1 -> canonical-1 and sets replayToolIds on the result.
  const assistant = {
    role: 'assistant', content: '', toolCalls: [{ callId: 'canonical-1', name: 'read', arguments: { path: 'f' } }],
    providerReplay: result.providerReplay, replayToolIds: { 'orig-1': 'canonical-1' },
  };
  const handler2 = () => ({ status: 200, headers: SSE_HEADERS, body: anthropicFinalText('ok') });
  const { requests } = await collect(0, 'anthropic-messages', handler2, makeRequest({ profile, messages: [assistant, { role: 'tool', callId: 'canonical-1', content: 'read result' }, { role: 'user', content: 'again' }] }));
  const body = JSON.parse(requests[0].body);
  const tu = body.messages[0].content.find((b) => b.type === 'tool_use');
  assert.equal(tu.id, 'canonical-1');
  assert.equal(tu.name, 'read');
});

test('anthropic: replay whose tool_use does not pair with toolCalls is dropped', async () => {
  const digest = 'd'.repeat(64);
  const handler = () => ({
    status: 200, headers: SSE_HEADERS,
    body: [
      ae('message_start', { type: 'message_start', message: { id: 'm1', model: 'fake-model', role: 'assistant', usage: { input_tokens: 2, output_tokens: 0 } } }),
      ae('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'orig-1', name: 'read', input: {} } }),
      ae('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"f"}' } }),
      ae('content_block_stop', { type: 'content_block_stop', index: 0 }),
      ae('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 3 } }),
      ae('message_stop', { type: 'message_stop' }),
    ],
  });
  const profile = makeProfile({ providerReplayMode: 'anthropic_content', compatibilityDigest: digest });
  const { result } = await collect(0, 'anthropic-messages', handler, makeRequest({ profile }));
  // The replay claims tool_use id orig-1, but the message's toolCalls say
  // canonical-9 with no matching replayToolIds -> pairing fails -> replay dropped
  // and blocks derived from toolCalls (id canonical-9), not injected from replay.
  const assistant = {
    role: 'assistant', content: '', toolCalls: [{ callId: 'canonical-9', name: 'read', arguments: { path: 'f' } }],
    providerReplay: result.providerReplay,
  };
  const handler2 = () => ({ status: 200, headers: SSE_HEADERS, body: anthropicFinalText('ok') });
  const { requests } = await collect(0, 'anthropic-messages', handler2, makeRequest({ profile, messages: [assistant, { role: 'tool', callId: 'canonical-9', content: 'read result' }, { role: 'user', content: 'again' }] }));
  const body = JSON.parse(requests[0].body);
  const tu = body.messages[0].content.find((b) => b.type === 'tool_use');
  assert.equal(tu.id, 'canonical-9');
  // The original (unmapped) replay id never reaches the wire.
  assert.ok(!body.messages[0].content.some((b) => b.id === 'orig-1'));
});

// ===== Fix 2: finalizationOnly keeps submit_final_output ==================

test('openai: finalizationOnly keeps submit_final_output, drops normal tools', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [sse(ochunk({ content: 'done' }, 'stop')), sseDone()] });
  const submit = { ...makeTool('submit_final_output'), description: 'Submit final answer' };
  const { requests } = await collect(0, 'openai-chat', handler,
    makeRequest({ finalizationOnly: true, tools: [makeTool('read'), submit] }));
  const body = JSON.parse(requests[0].body);
  const names = body.tools.map((t) => t.function.name);
  assert.deepEqual(names, ['submit_final_output']);
});

test('anthropic: finalizationOnly keeps submit_final_output, drops normal tools', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: anthropicFinalText('done') });
  const submit = { ...makeTool('submit_final_output'), description: 'Submit final answer' };
  const { requests } = await collect(0, 'anthropic-messages', handler,
    makeRequest({ finalizationOnly: true, tools: [makeTool('read'), submit] }));
  const body = JSON.parse(requests[0].body);
  assert.deepEqual(body.tools.map((t) => t.name), ['submit_final_output']);
});

// ===== Fix 3: readBoundedText overflow + HTTP body/timer cleanup ==========

test('openai: buffered body exceeding maxResponseBytes is terminal, not a truncated final', async () => {
  const big = JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'x'.repeat(2000) }, finish_reason: 'stop' }] });
  const handler = () => ({ status: 200, headers: JSON_HEADERS, body: big });
  const { result } = await collect(0, 'openai-chat', handler, makeRequest(), { maxResponseBytes: 256 });
  assert.equal(result.kind, 'provider_terminal_error');
  assert.equal(result.failureKind, 'invalid_response');
});

test('openai: 400 headers then hanging body is bounded by requestTimeoutMs', async () => {
  async function* hang() { await new Promise(() => {}); }
  const handler = () => ({ status: 400, headers: JSON_HEADERS, body: hang() });
  await withServer(handler, async (server) => {
    const port = createNativeModelPort({
      resolveProfile: async () => ({ protocol: 'openai-chat', baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: 'fake-key', model: 'fake-model' }),
      fetchImpl: fetch, maxResponseBytes: 4096, idleTimeoutMs: 4000,
    });
    const profile = makeProfile({ requestTimeoutMs: 80 });
    const result = await port.generate(makeRequest({ profile }), () => {});
    // The 400 status is authoritative; an unreadable body cannot change it, and
    // the overall timer bounds the hang so this never waits forever.
    assert.ok(['provider_terminal_error', 'provider_retryable_error'].includes(result.kind));
  });
});

test('openai: 429 with a hanging body returns rate_limit and does not hang', async () => {
  async function* hang() { await new Promise(() => {}); }
  const handler = () => ({ status: 429, headers: { 'retry-after': '2' }, body: hang() });
  const { result } = await collect(0, 'openai-chat', handler, makeRequest({ profile: makeProfile({ requestTimeoutMs: 80 }) }));
  assert.equal(result.kind, 'provider_retryable_error');
  assert.equal(result.failureKind, 'rate_limit');
  assert.equal(result.retryAfterMs, 2000);
});

test('openai: buffered invalid UTF-8 body is terminal invalid_response', async () => {
  const handler = () => ({ status: 200, headers: JSON_HEADERS, body: Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]) });
  const { result } = await collect(0, 'openai-chat', handler, makeRequest());
  assert.equal(result.kind, 'provider_terminal_error');
  assert.equal(result.failureKind, 'invalid_response');
});

// ===== Fix 4: strict parseModelJson + wireArgumentsInvalid ================

test('openai: duplicate keys in streamed tool args become non-executable', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [sse(ochunk({ tool_calls: [{ index: 0, id: 'c', type: 'function', function: { name: 'read', arguments: '{"path":"a","path":"b"}' } }] }, 'tool_calls')), sseDone()] });
  const { result } = await collect(0, 'openai-chat', handler, makeRequest());
  assert.equal(result.kind, 'tool_calls');
  assert.equal(result.toolCalls[0].wireArgumentsInvalid, true);
  looseEqual(result.toolCalls[0].arguments, {});
});

test('openai: non-finite number in buffered tool args becomes non-executable', async () => {
  const handler = () => ({ status: 200, headers: JSON_HEADERS, body: JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: [{ id: 'c', type: 'function', function: { name: 'read', arguments: '{"x":1e400}' } }] }, finish_reason: 'tool_calls' }] }) });
  const { result } = await collect(0, 'openai-chat', handler, makeRequest());
  assert.equal(result.kind, 'tool_calls');
  assert.equal(result.toolCalls[0].wireArgumentsInvalid, true);
});

test('anthropic: duplicate keys in input_json_delta become non-executable', async () => {
  const handler = () => ({
    status: 200, headers: SSE_HEADERS,
    body: [
      ae('message_start', { type: 'message_start', message: { id: 'm1', model: 'fake-model', role: 'assistant', usage: { input_tokens: 2, output_tokens: 0 } } }),
      ae('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu', name: 'read', input: {} } }),
      ae('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"a","path":"b"}' } }),
      ae('content_block_stop', { type: 'content_block_stop', index: 0 }),
      ae('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 2 } }),
      ae('message_stop', { type: 'message_stop' }),
    ],
  });
  const { result } = await collect(0, 'anthropic-messages', handler, makeRequest());
  assert.equal(result.kind, 'tool_calls');
  assert.equal(result.toolCalls[0].wireArgumentsInvalid, true);
  looseEqual(result.toolCalls[0].arguments, {});
});

test('openai: nested duplicate keys in a buffered response envelope are terminal', async () => {
  // Duplicate keys in the top-level envelope -> strict parse rejects -> terminal.
  const handler = () => ({ status: 200, headers: JSON_HEADERS, body: '{"choices":[{"index":0,"message":{"role":"assistant","content":"x"},"finish_reason":"stop"}],"choices":[]}' });
  const { result } = await collect(0, 'openai-chat', handler, makeRequest());
  assert.equal(result.kind, 'provider_terminal_error');
  assert.equal(result.failureKind, 'invalid_response');
});

// ===== Fix 5: maxInlineImageBytes + base64 byte count + userinfo URLs =====

test('openai: image over request.maxInlineImageBytes is rejected before HTTP', async () => {
  // The encoded URL and its prefix exceed a 3-byte dispatch budget.
  const server = await startServer(() => ({ status: 200, headers: SSE_HEADERS, body: [sse(ochunk({ content: 'ok' }, 'stop')), sseDone()] }));
  try {
    const port = createNativeModelPort({
      resolveProfile: async () => ({ protocol: 'openai-chat', baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: 'fake-key', model: 'fake-model' }),
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

test('openai: image URL with userinfo credentials is rejected before HTTP', async () => {
  const server = await startServer(() => ({ status: 200, headers: SSE_HEADERS, body: [sse(ochunk({ content: 'ok' }, 'stop')), sseDone()] }));
  try {
    const port = createNativeModelPort({
      resolveProfile: async () => ({ protocol: 'openai-chat', baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: 'fake-key', model: 'fake-model' }),
      fetchImpl: fetch, maxResponseBytes: 4096, idleTimeoutMs: 4000,
    });
    const messages = [{ role: 'user', content: 'See', media: [{ type: 'image_url', image_url: { url: 'https://user:pass@127.0.0.1/x.png' } }] }];
    const req = makeRequest({ messages, tools: [] });
    req.maxInlineImageBytes = 40 * 1024 * 1024;
    const r = await port.generate(req, () => {});
    assert.equal(r.kind, 'provider_terminal_error');
    assert.equal(r.failureKind, 'invalid_response');
    assert.equal(server.requests.length, 0);
  } finally { await server.close(); }
});

// ===== Fix 6: usage cached/reasoning tokens + usageReported ===============

test('openai: cached and reasoning tokens are retained and usageReported is true', async () => {
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [
    sse(ochunk({ content: 'Hello' }, 'stop')),
    sse({ id: 'c1', choices: [], usage: { prompt_tokens: 12, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 5 }, completion_tokens_details: { reasoning_tokens: 3 } } }),
    sseDone(),
  ] });
  const { result } = await collect(0, 'openai-chat', handler, makeRequest());
  assert.equal(result.usageReported, true);
  assert.equal(result.usage.cachedInputTokens, 5);
  assert.equal(result.usage.reasoningTokens, 3);
});

test('openai: unreported usage yields usageReported false, not a known-zero cost claim', async () => {
  // Stream ends at finish with no usage tail frame.
  const handler = () => ({ status: 200, headers: SSE_HEADERS, body: [sse(ochunk({ content: 'done' }, 'stop')), sseDone()] });
  const { result } = await collect(0, 'openai-chat', handler, makeRequest());
  assert.equal(result.kind, 'final_candidate');
  assert.equal(result.usageReported, false);
  assert.equal(result.usage.inputTokens, 0);
});

test('anthropic: cache_read_input_tokens retained as cachedInputTokens', async () => {
  const handler = () => ({
    status: 200, headers: SSE_HEADERS,
    body: [
      ae('message_start', { type: 'message_start', message: { id: 'm1', model: 'fake-model', role: 'assistant', usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 4 } } }),
      ae('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      ae('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }),
      ae('content_block_stop', { type: 'content_block_stop', index: 0 }),
      ae('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }),
      ae('message_stop', { type: 'message_stop' }),
    ],
  });
  const { result } = await collect(0, 'anthropic-messages', handler, makeRequest());
  assert.equal(result.usageReported, true);
  assert.equal(result.usage.cachedInputTokens, 4);
  assert.equal(result.usage.inputTokens, 14);
  assert.equal(result.usage.outputTokens, 2);
});

test('SSE byte budgets also count ArrayBuffer chunks and require finite limits', async () => {
  const chunk = new TextEncoder().encode('data: hello\n\n').buffer;
  const body = async function* () { yield chunk; };
  const frames = [];
  for await (const frame of readModelSse(body(), { maxBytes: chunk.byteLength })) frames.push(frame);
  assert.equal(frames[0].data, 'hello');
  for (const maxBytes of [chunk.byteLength - 1, Infinity, NaN]) {
    await assert.rejects(async () => { for await (const frame of readModelSse(body(), { maxBytes })) void frame; });
  }
});

test('both protocols keep partial usage unknown, validate supplied counters and retain explicit zeroes', async () => {
  for (const protocol of ['openai-chat', 'anthropic-messages']) {
    for (const [usage, complete, invalid] of (protocol === 'openai-chat'
      ? [[{ prompt_tokens: 3 }, false], [{ prompt_tokens: 0, completion_tokens: 0 }, true], [{ prompt_tokens: null }, false, true], [{ total_tokens: -1 }, false, true]]
      : [[{ input_tokens: 3 }, false], [{ cache_read_input_tokens: 3 }, false], [{ input_tokens: 0, output_tokens: 0 }, true], [{ input_tokens: null }, false, true], [{ cache_creation_input_tokens: -1 }, false, true]])) {
      const envelope = protocol === 'openai-chat'
        ? { choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage }
        : { type: 'message', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage };
      const { result } = await collect(0, protocol, () => ({ headers: JSON_HEADERS, body: JSON.stringify(envelope) }), makeRequest());
      assert.equal(result.kind, invalid ? 'provider_terminal_error' : 'final_candidate', `${protocol}: ${JSON.stringify(usage)}`);
      if (!invalid) assert.equal(result.usageReported, complete);
    }
  }
});

test('Anthropic split usage includes cache reads and writes with right-biased updates', async () => {
  const frames = anthropicFinalText('ok');
  frames[0] = ae('message_start', { type: 'message_start', message: { id: 'm1', role: 'assistant', usage: { input_tokens: 10, cache_read_input_tokens: 4, cache_creation_input_tokens: 7 } } });
  frames.splice(-1, 0, ae('message_delta', { type: 'message_delta', delta: {}, usage: { output_tokens: 0, cache_read_input_tokens: 2 } }));
  const { result } = await collect(0, 'anthropic-messages', () => ({ headers: SSE_HEADERS, body: frames }), makeRequest());
  assert.equal(result.kind, 'final_candidate');
  assert.equal(result.usageReported, true);
  assert.equal(result.usage.inputTokens, 19);
  assert.equal(result.usage.cachedInputTokens, 2);
  assert.equal(result.usage.cacheWriteInputTokens, 7);
  assert.equal(result.usage.outputTokens, 0);
});

test('Anthropic stream keeps partial usage incomplete and rejects inclusive-token overflow', async () => {
  for (const usage of [{ input_tokens: 5 }, { input_tokens: Number.MAX_SAFE_INTEGER, cache_creation_input_tokens: 1 }]) {
    const frames = [
      ae('message_start', { type: 'message_start', message: { id: 'm1', role: 'assistant', usage } }),
      ae('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'ok' } }),
      ae('content_block_stop', { type: 'content_block_stop', index: 0 }),
      ae('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
      ae('message_stop', { type: 'message_stop' }),
    ];
    const { result } = await collect(0, 'anthropic-messages', () => ({ headers: SSE_HEADERS, body: frames }), makeRequest());
    assert.equal(result.kind, usage.input_tokens === 5 ? 'final_candidate' : 'provider_terminal_error');
    assert.equal(result.usageReported, false);
  }
});

test('Anthropic content retains initial text and drains content in block order', async () => {
  const frames = [
    ae('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'B' } }),
    ae('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'A' } }),
    ae('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'a' } }),
    ae('content_block_stop', { type: 'content_block_stop', index: 0 }),
    ae('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'b' } }),
    ae('content_block_stop', { type: 'content_block_stop', index: 1 }),
    ae('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
    ae('message_stop', { type: 'message_stop' }),
  ];
  const { result, events } = await collect(0, 'anthropic-messages', () => ({ headers: SSE_HEADERS, body: frames }), makeRequest());
  assert.equal(result.text, 'AaBb');
  assert.equal(result.kind, 'final_candidate');
  assert.equal(events.filter((e) => e.kind === 'text').map((e) => e.text).join(''), 'AaBb');
});

test('Anthropic unclosed or gapped content and foreign DONE never seal a final', async () => {
  for (const [index, close, stop] of [[0, false, true], [1, true, true], [0, true, false]]) {
    const frames = [ae('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: 'partial' } })];
    if (close) frames.push(ae('content_block_stop', { type: 'content_block_stop', index }));
    frames.push(ae('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } }));
    frames.push(stop ? ae('message_stop', { type: 'message_stop' }) : sseDone());
    const { result } = await collect(0, 'anthropic-messages', () => ({ headers: SSE_HEADERS, body: frames }), makeRequest());
    assert.equal(result.kind, stop ? 'provider_terminal_error' : 'provider_retryable_error');
  }
});

test('Anthropic preflight rejects orphan, duplicate and incomplete tool receipts before HTTP', async () => {
  const call = { callId: 'c1', name: 'read', arguments: {} };
  const assistant = { role: 'assistant', content: '', toolCalls: [call] };
  const tool = { role: 'tool', content: 'ok', callId: 'c1' };
  for (const messages of [[tool], [assistant], [assistant, tool, tool], [assistant, { role: 'user', content: 'continue' }]]) {
    const { result, requests } = await collect(0, 'anthropic-messages', () => { throw new Error('must not dispatch'); }, makeRequest({ messages }));
    assert.equal(result.kind, 'provider_terminal_error');
    assert.equal(requests.length, 0);
  }
});

test('host generation parameters cannot increase the pinned output budget', async () => {
  for (const [protocol, key] of [['openai-chat', 'max_tokens'], ['openai-chat', 'max_completion_tokens'], ['anthropic-messages', 'max_tokens']]) {
    for (const value of [64, 9999, -1]) {
      const { result, requests } = await collect(0, protocol, () => ({ headers: JSON_HEADERS, body: '{}' }), makeRequest({ profile: makeProfile({ maxOutputTokens: 128 }) }), { bindingExtra: { parameters: { [key]: value } } });
      if (value < 0) {
        assert.equal(result.kind, 'provider_terminal_error');
        assert.equal(requests.length, 0);
      } else assert.equal(JSON.parse(requests[0].body)[key], Math.min(value, 128));
    }
  }
});

test('inline image budget covers the complete current user input, including URL prefixes', async () => {
  const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } };
  const bytes = Buffer.byteLength(image.image_url.url);
  for (const protocol of ['openai-chat', 'anthropic-messages']) {
    for (const [media, limit, allowed] of [[[image], bytes, true], [[image], bytes - 1, false], [[image, image], bytes, false]]) {
      const request = { ...makeRequest({ messages: [{ role: 'user', content: 'look', media }] }), maxInlineImageBytes: limit };
      const before = structuredClone({ messages: request.messages });
      const { requests } = await collect(0, protocol, () => ({ headers: JSON_HEADERS, body: '{}' }), request);
      assert.equal(requests.length, allowed ? 1 : 0);
      assert.deepEqual(request.messages, before.messages);
    }
  }
});

test('historical image omissions retain textual receipts and the newest fitting images without mutating history', async () => {
  const image = (value) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${value}` } });
  const old = image('YQ==');
  const recent = image('Yg==');
  const current = image('Yw==');
  const messages = [
    { role: 'user', content: 'old pixels', media: [old] },
    { role: 'assistant', content: '', toolCalls: [{ callId: 'c', name: 'read', arguments: {} }] },
    { role: 'tool', callId: 'c', content: 'file unchanged; operation already executed', media: [recent] },
    { role: 'user', content: 'now', media: [current] },
  ];
  for (const protocol of ['openai-chat', 'anthropic-messages']) {
    const request = { ...makeRequest({ messages }), maxInlineImageBytes: Buffer.byteLength(current.image_url.url) * 2 };
    const before = structuredClone(messages);
    const { requests } = await collect(0, protocol, () => ({ headers: JSON_HEADERS, body: '{}' }), request);
    const wire = requests[0].body;
    assert.ok(!wire.includes(old.image_url.url));
    assert.ok(wire.includes('Yg==') && wire.includes('Yw=='));
    assert.ok(wire.includes('not_sent_in_this_request') && wire.includes('operation already executed'));
    assert.deepEqual(messages, before);
  }
});

test('zero media budget omits historical images but cannot hide malformed historical media', async () => {
  for (const url of ['data:image/png;base64,YQ==', 'data:image/png;base64,bad!']) {
    const request = { ...makeRequest({ messages: [{ role: 'user', content: 'then', media: [{ type: 'image_url', image_url: { url } }] }, { role: 'user', content: 'now' }] }), maxInlineImageBytes: 0 };
    const { requests } = await collect(0, 'openai-chat', () => ({ headers: JSON_HEADERS, body: '{}' }), request);
    assert.equal(requests.length, url.endsWith('YQ==') ? 1 : 0);
    if (requests.length) assert.ok(requests[0].body.includes('not_sent_in_this_request'));
  }
});

test('a protocol terminal seals the attempt without waiting for socket EOF', async () => {
  for (const protocol of ['openai-chat', 'anthropic-messages']) {
    const frames = protocol === 'openai-chat' ? [sse(ochunk({ content: 'done' }, 'stop')), sseDone()] : anthropicFinalText('done');
    const { result } = await collect(0, protocol, () => ({ headers: SSE_HEADERS, body: [...frames, { delay: 1000 }] }), makeRequest({ profile: makeProfile({ requestTimeoutMs: 300 }) }));
    assert.equal(result.kind, 'final_candidate');
    assert.equal(result.text, 'done');
  }
});

test('caller cancellation while reading a 400 body still propagates', async () => {
  const controller = new AbortController();
  await withServer(() => ({ status: 400, headers: JSON_HEADERS, body: [{ delay: 1000 }, '{}'] }), async (server) => {
    const port = makePort({ port: server.port, protocol: 'openai-chat' });
    const timer = setTimeout(() => controller.abort(new Error('cancel-test')), 30);
    try { await assert.rejects(port.generate(makeRequest({ signal: controller.signal })), /cancel-test/); }
    finally { clearTimeout(timer); }
  });
});
