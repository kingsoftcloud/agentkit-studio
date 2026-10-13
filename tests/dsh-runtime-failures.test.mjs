import test from 'node:test';
import assert from 'node:assert/strict';
import { createDshRuntimeAdapter, unbindDshAgentRoutes } from '../src/providers/dsh-runtime.mjs';
import { createLocalConversationHandler } from '../src/local-runtime.mjs';
import { apply as applyRuntimePreset } from '../src/providers/dsh-runtime-plugin.mjs';

const sse = value => `data: ${JSON.stringify(value)}\n\n`;
const fixture = (fetchImpl, resourceAdapter) => createLocalConversationHandler({
  agentStore: async () => ({ get: async () => ({ spec: { bindings: {} } }) }),
  modelService: { profile: async () => ({ baseUrl: 'http://model.invalid/v1', apiKey: 'test-key', modelName: 'test' }) },
  fetchImpl, resourceAdapter,
});
async function collect(handler, options = {}) {
  const adapter = createDshRuntimeAdapter({ localHandler: async () => handler });
  return Array.fromAsync(adapter.stream({ model: 'local:failure-proof', studioNativeTools: true, messages: [{ role: 'user', content: 'test' }], ...options }));
}

for (const [name, response, code] of [
  ['temporary server failure', () => Response.json({ error: { message: 'private upstream body' } }, { status: 503 }), 'SERVER'],
  ['rate limit with server delay', () => Response.json({}, { status: 429, headers: { 'retry-after': '2' } }), 'RATE_LIMIT'],
  ['authentication failure', () => Response.json({}, { status: 401 }), 'AUTH'],
  ['quota on HTTP 429', () => Response.json({ error: { code: 'insufficient_quota' } }, { status: 429 }), 'QUOTA'],
  ['context overflow', () => Response.json({ error: { code: 'context_length_exceeded' } }, { status: 400 }), 'CONTEXT_WINDOW_EXCEEDED'],
  ['in-band capacity failure', () => new Response(sse({ error: { type: 'overloaded_error', message: 'private upstream body' } })), 'SERVER'],
  ['connection failure', () => { throw new TypeError('fetch failed: private endpoint'); }, 'TRANSPORT'],
  ['empty completion', () => new Response(sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n'), 'EMPTY_RESPONSE'],
]) test(`${name} reaches DSH as a safe public failure finish`, async () => {
  const chunks = await collect(fixture(response));
  const finish = chunks.at(-1);
  assert.equal(finish.type, 'finish');
  assert.equal(finish.reason.kind, 'error');
  assert.equal(finish.reason.failure.code, code);
  assert.doesNotMatch(JSON.stringify(chunks), /private|test-key/);
  if (code === 'RATE_LIMIT') assert.equal(finish.reason.failure.providerRetryAfterMs, 2000);
});

test('a broken partial stream ends in failure, preserving the partial block for native history', async () => {
  const handler = fixture(() => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(sse({ choices: [{ delta: { content: 'partial' } }] })));
    setTimeout(() => controller.error(new TypeError('socket closed')), 1);
  } })));
  const chunks = await collect(handler);
  assert.equal(chunks.find(chunk => chunk.type === 'text-delta').text, 'partial');
  assert.equal(chunks.at(-1).reason.failure.code, 'TRANSPORT');
});

test('a complete SSE frame without completion cannot silently become a successful answer', async () => {
  await assert.rejects(collect(fixture(() => new Response(sse({ choices: [{ delta: { content: 'partial' } }] })))), { code: 'UPSTREAM_STREAM_TRUNCATED' });
});

test('standalone Harness loops are never promoted to retryable DSH steps', async () => {
  await assert.rejects(collect(fixture(() => Response.json({}, { status: 503 })), { studioNativeTools: false }), { code: 'MODEL_STREAM_FAILED' });
});

test('a text-only Agent preset uses the native model-step failure contract too', async t => {
  t.after(() => unbindDshAgentRoutes('text-only-proof'));
  const listeners = new Map();
  applyRuntimePreset({ tools: {}, on: (event, handler) => { listeners.set(event, handler); } }, { agentId: 'text-only-proof', runtime: 'harness', local: true });
  await listeners.get('agent/request')({ agent: { id: 'text-only-session' } }, async () => ({}));
  const chunks = await collect(fixture(() => Response.json({}, { status: 503 })), { sessionId: 'text-only-session', studioNativeTools: false });
  assert.equal(chunks.at(-1).reason.failure.code, 'SERVER');
});

test('user cancellation does not become a retryable transport failure', async () => {
  const controller = new AbortController();
  const chunks = await collect(fixture(() => { controller.abort(); throw new Error('closed'); }), { signal: controller.signal });
  assert.equal(chunks.some(chunk => chunk.type === 'finish' && chunk.reason.kind === 'error'), false);
});
