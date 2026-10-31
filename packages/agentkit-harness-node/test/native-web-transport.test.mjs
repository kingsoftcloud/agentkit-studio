import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebToolTransport, createNativeWebTools, nativeWebToolDefinitions } from '../src/native/web-tools.mjs';
import { webRequest } from '../../../tests/fixtures/native-web-request.mjs';

const signal = () => new AbortController().signal;
const definition = name => nativeWebToolDefinitions().find(item => item.name === name);
const request = (name, args) => ({ sessionId: 'dsh-session', call: { callId: 'actual-dsh-call', name, arguments: args }, definition: definition(name), signal: signal() });

test('the same network implementation preserves Native content with a real DSH call and no invented Native identity', async () => {
  let fetches = 0, authorizations = 0;
  const options = { fetch: async () => { fetches++; return new Response('<p>hello 😀</p><script>ignore()</script>', { headers: { 'content-type': 'text/html' } }); },
    ssrfPolicy: { allowPrivate: true } };
  const transport = createWebToolTransport(options);
  const native = createNativeWebTools({ ...options, sessionId: 'dsh-session', authorize: async () => { authorizations++; return 'allow'; } });
  const neutralRequest = request('web_fetch', { url: 'http://127.0.0.1/', max_chars: 7 });
  assert.deepEqual(await transport.execute(neutralRequest), await native.execute(webRequest(neutralRequest)));
  assert.equal(fetches, 2); assert.equal(authorizations, 1);
  assert.equal('scope' in neutralRequest, false); assert.equal('runId' in neutralRequest, false);
  assert.equal('executionFence' in neutralRequest, false);
});

test('the transport keeps the locked schema and does not silently enable a fake search provider', async () => {
  let fetches = 0;
  const transport = createWebToolTransport({ fetch: async () => { fetches++; throw Error('must not fetch'); } });
  transport.definitions[0].parameters.additionalProperties = true;
  const rejected = await transport.execute(request('web_fetch', { url: 'https://8.8.8.8/', unexpected: true }));
  assert.equal(rejected.status, 'error'); assert.equal(fetches, 0);
  const search = await transport.execute(request('web_search', { query: 'question' }));
  assert.equal(search.status, 'error'); assert.equal(search.content.error_type, 'provider_not_configured');
  assert.equal(fetches, 0);
});

test('oversized-output persistence receives the original call and Session even when the caller mutates them during fetch', async () => {
  let release, entered, saved;
  const started = new Promise(resolve => { entered = resolve; });
  const transport = createWebToolTransport({ ssrfPolicy: { allowPrivate: true },
    fetch: async () => { entered(); await new Promise(resolve => { release = resolve; }); return new Response('original output'); },
    persistOutput: async (req, text) => { saved = { req, text }; return { uri: 'artifact://original' }; } });
  const req = request('web_fetch', { url: 'http://127.0.0.1/', max_chars: 1 });
  const originalSignal = req.signal, pending = transport.execute(req);
  await started;
  req.sessionId = 'foreign'; req.call.callId = 'foreign'; req.call.arguments.max_chars = 99; req.signal = signal();
  release();
  const result = await pending;
  assert.equal(result.status, 'ok'); assert.equal(result.content.text, 'o');
  assert.equal(result.content.persisted.path, 'artifact://original');
  assert.equal(saved.req.sessionId, 'dsh-session'); assert.equal(saved.req.call.callId, 'actual-dsh-call');
  assert.equal(saved.req.signal, originalSignal); assert.equal(saved.text, 'original output');
});
