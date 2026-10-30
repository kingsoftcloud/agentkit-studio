import { webRequest } from '../../../tests/fixtures/native-web-request.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeWebTools, nativeWebToolDefinitions, isBlockedAddress } from '../src/native/web-tools.mjs';
import { createNativeArtifactStore } from '../src/native/artifact-store.mjs';

const allowAuthorize = async () => 'allow';
// Every execute requires a real AbortSignal; reuse a fresh non-aborted one.
const sig = () => new AbortController().signal;

test('execute refuses incomplete Run authority before authorization or network I/O', async () => {
  let authorizations = 0, requests = 0;
  const tools = createNativeWebTools({ sessionId: 's1', authorize: async () => { authorizations++; return 'allow'; },
    fetch: async () => { requests++; return new Response('unreachable'); } });
  for (const [key, value] of [['scope', null], ['runId', ''], ['operationKey', null], ['buildId', null],
    ['taskChainId', ''], ['executionFence', 0], ['parentRunId', undefined]]) {
    const request = webRequest({ sessionId: 's1', signal: sig(),
      call: { callId: 'c', name: 'web_fetch', arguments: { url: 'https://example.com/' } }, [key]: value });
    assert.equal((await tools.execute(request)).content.code, 'invalid_request', key);
  }
  const noDefinition = webRequest({ sessionId: 's1', signal: sig(), definition: null,
    call: { callId: 'c', name: 'web_search', arguments: { query: 'test' } } });
  assert.equal((await tools.execute(noDefinition)).content.code, 'web_definition_mismatch');
  assert.equal(authorizations, 0); assert.equal(requests, 0);
});

// A local HTTP server that resolves ready before the URL is used and closes
// all connections so the test process never hangs on a lingering socket.
function localServer(handler) {
  const server = createServer(handler);
  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const url = () => `http://127.0.0.1:${server.address().port}`;
  const close = () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()); });
  return { server, url, ready, close };
}

test('web tool definitions are sealed read-only and returned as deep copies', () => {
  const tools = createNativeWebTools({ fetch: async () => ({}), providerConfig: {}, authorize: allowAuthorize, sessionId: 's1' });
  const defs = tools.definitions;
  assert.deepEqual(defs.map(d => d.name), ['web_fetch', 'web_search']);
  for (const d of defs) {
    assert.equal(d.readOnly, true);
    assert.equal(d.concurrentSafe, true);
    assert.deepEqual(d.permissions, []);
    assert.equal(d.contextRole, 'none');
    assert.equal(d.observationRole, 'none');
    assert.equal(d.progressObservation, false);
    assert.equal(d.contextRetention, 'normal');
  }
  // Mutating a returned definition must not affect the next execute's formal map.
  defs[0].readOnly = false;
  const fresh = createNativeWebTools({ fetch: async () => ({}), providerConfig: {}, authorize: allowAuthorize, sessionId: 's1' }).definitions;
  assert.equal(fresh[0].readOnly, true);
});

test('web_fetch returns parse5-sanitized text, status, content_type and code-point budget', async t => {
  const { url, ready, close } = localServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<html><head><title>X</title><script>evil()</script><style>x{}</style></head><body><p>Hello &amp; <b>world</b></p><br><p>第二段</p></body></html>');
  });
  await ready; t.after(close);
  const tools = createNativeWebTools({ fetch, providerConfig: {}, ssrfPolicy: { allowPrivate: true }, authorize: allowAuthorize, sessionId: 's1' });
  const r = await tools.execute(webRequest({ sessionId: 's1', signal: sig(), call: { callId: 'c', name: 'web_fetch', arguments: { url: url() } } }));
  assert.equal(r.status, 'ok');
  assert.equal(r.content.ok, true);
  assert.equal(r.content.status_code, 200);
  assert.equal(r.content.text, 'Hello & world 第二段');
  assert.equal(r.content.text.includes('evil'), false);
  assert.equal(r.content.truncated, false);
  assert.equal(r.content.original_chars, 'Hello & world 第二段'.length);
});

test('web_fetch truncates by Unicode code points (😀😀😀 at limit 1 is truncated)', async t => {
  const { url, ready, close } = localServer((req, res) => { res.setHeader('content-type', 'text/plain'); res.end('😀😀😀'); });
  await ready; t.after(close);
  const tools = createNativeWebTools({ fetch, providerConfig: {}, ssrfPolicy: { allowPrivate: true }, authorize: allowAuthorize, sessionId: 's1' });
  const r = await tools.execute(webRequest({ sessionId: 's1', signal: sig(), call: { callId: 'c', name: 'web_fetch', arguments: { url: url(), max_chars: 1 } } }));
  assert.equal(r.content.text, '😀');
  assert.equal(r.content.truncated, true);
  assert.equal(r.content.original_chars, 3);
  assert.equal(r.content.preview_chars, 1);
});

test('web_fetch follows up to 5 manual redirects, canceling each redirect body', async t => {
  let hops = 0;
  const { url, ready, close } = localServer((req, res) => {
    if (req.url === '/final') { res.setHeader('content-type', 'text/plain'); res.end('done'); return; }
    hops++; res.statusCode = 302; res.setHeader('location', '/final'); res.end();
  });
  await ready; t.after(close);
  const tools = createNativeWebTools({ fetch, providerConfig: {}, ssrfPolicy: { allowPrivate: true }, authorize: allowAuthorize, sessionId: 's1' });
  const r = await tools.execute(webRequest({ sessionId: 's1', signal: sig(), call: { callId: 'c', name: 'web_fetch', arguments: { url: url() } } }));
  assert.equal(r.content.ok, true);
  assert.equal(r.content.text, 'done');
  assert.equal(r.content.final_url, `${url()}/final`);
  assert.equal(hops, 1);
});

test('web_fetch rechecks Native authority before following a redirect', async t => {
  let hops = 0, current = true;
  const { url, ready, close } = localServer((_req, res) => {
    hops++;
    if (hops === 1) { res.statusCode = 302; res.setHeader('location', '/final'); current = false; res.end(); }
    else res.end('should not fetch');
  });
  await ready; t.after(close);
  const tools = createNativeWebTools({ fetch, ssrfPolicy: { allowPrivate: true }, authorize: allowAuthorize, sessionId: 's1' });
  const result = await tools.execute({ ...webRequest({ sessionId: 's1', signal: sig(),
    call: { callId: 'c', name: 'web_fetch', arguments: { url: url() } } }), assertCurrent: () => current });
  assert.equal(result.content.code, 'web_authority_stale');
  assert.equal(hops, 1);
});

test('web_fetch returns too_many_redirects after 5 hops', async t => {
  let hops = 0;
  const { url, ready, close } = localServer((req, res) => { hops++; res.statusCode = 302; res.setHeader('location', '/loop'); res.end(); });
  await ready; t.after(close);
  const tools = createNativeWebTools({ fetch, providerConfig: {}, ssrfPolicy: { allowPrivate: true }, authorize: allowAuthorize, sessionId: 's1' });
  const r = await tools.execute(webRequest({ sessionId: 's1', signal: sig(), call: { callId: 'c', name: 'web_fetch', arguments: { url: url() } } }));
  assert.equal(r.content.ok, false);
  assert.equal(r.content.error_type, 'too_many_redirects');
  assert.equal(hops, 5);
});

test('web_fetch returns timeout when the server exceeds the deadline', async t => {
  const { url, ready, close } = localServer((req, res) => { setTimeout(() => { try { res.end('late'); } catch {} }, 3000); });
  await ready; t.after(close);
  const tools = createNativeWebTools({ fetch, providerConfig: {}, ssrfPolicy: { allowPrivate: true }, authorize: allowAuthorize, sessionId: 's1' });
  const r = await tools.execute(webRequest({ sessionId: 's1', signal: sig(), call: { callId: 'c', name: 'web_fetch', arguments: { url: url(), timeout: 1 } } }));
  assert.equal(r.content.ok, false);
  assert.equal(r.content.error_type, 'timeout');
});

test('web_fetch SSRF blocks IPv4/IPv6 loopback, private, CGNAT and mapped addresses', async () => {
  const tools = createNativeWebTools({ fetch: async () => ({}), providerConfig: {}, authorize: allowAuthorize, sessionId: 's1' });
  assert.equal(isBlockedAddress('127.0.0.1'), true);
  assert.equal(isBlockedAddress('10.5.5.5'), true);
  assert.equal(isBlockedAddress('169.254.1.1'), true);
  assert.equal(isBlockedAddress('100.64.10.5'), true);
  assert.equal(isBlockedAddress('::1'), true);
  assert.equal(isBlockedAddress('fe80::1'), true);
  assert.equal(isBlockedAddress('::ffff:127.0.0.1'), true);
  assert.equal(isBlockedAddress('8.8.8.8'), false);
  assert.equal(isBlockedAddress('1.1.1.1'), false);
  for (const u of ['http://127.0.0.1/x', 'http://10.5.5.5/x', 'http://[::1]/', 'http://100.64.10.5/']) {
    const r = await tools.execute(webRequest({ sessionId: 's1', signal: sig(), call: { callId: 'c', name: 'web_fetch', arguments: { url: u } } }));
    assert.equal(r.content.error_type, 'blocked_by_ssrf_policy', u);
  }
});

test('web_fetch preserves timeout classification after receiving headers and partial body', async t => {
  let received = 0;
  const { url, ready, close } = localServer((_req, res) => {
    received++; res.writeHead(200, { 'content-type': 'text/plain' }); res.write('partial');
  });
  await ready; t.after(close);
  const tools = createNativeWebTools({ fetch, ssrfPolicy: { allowPrivate: true }, authorize: allowAuthorize, sessionId: 's1' });
  const result = await tools.execute(webRequest({ sessionId: 's1', signal: sig(),
    call: { callId: 'partial-body', name: 'web_fetch', arguments: { url: url(), timeout: 1 } } }));
  assert.equal(received, 1);
  assert.equal(result.status, 'error');
  assert.equal(result.content.error_type, 'timeout');
});

test('web_fetch propagates caller cancellation during a streamed body', async t => {
  let started;
  const headers = new Promise(resolve => { started = resolve; });
  const { url, ready, close } = localServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' }); res.write('partial'); started();
  });
  await ready; t.after(close);
  const controller = new AbortController();
  const tools = createNativeWebTools({ fetch, ssrfPolicy: { allowPrivate: true }, authorize: allowAuthorize, sessionId: 's1' });
  const result = tools.execute(webRequest({ sessionId: 's1', signal: controller.signal,
    call: { callId: 'cancel-body', name: 'web_fetch', arguments: { url: url() } } }));
  await headers; controller.abort(new Error('cancel streamed body'));
  await assert.rejects(result, /cancel streamed body/);
});

test('web_fetch allowPrivate must be strict boolean true (string "false" does not bypass)', async () => {
  const tools = createNativeWebTools({ fetch: async () => ({}), providerConfig: {}, ssrfPolicy: { allowPrivate: 'false' }, authorize: allowAuthorize, sessionId: 's1' });
  const r = await tools.execute(webRequest({ sessionId: 's1', signal: sig(), call: { callId: 'c', name: 'web_fetch', arguments: { url: 'http://127.0.0.1/' } } }));
  assert.equal(r.content.error_type, 'blocked_by_ssrf_policy');
});

test('web_fetch rejects unsupported schemes and empty urls', async () => {
  const tools = createNativeWebTools({ fetch: async () => ({}), providerConfig: {}, authorize: allowAuthorize, sessionId: 's1' });
  assert.equal((await tools.execute(webRequest({ sessionId: 's1', signal: sig(), call: { callId: 'c', name: 'web_fetch', arguments: { url: 'ftp://x' } } }))).content.error_type, 'unsupported_scheme');
  assert.equal((await tools.execute(webRequest({ sessionId: 's1', signal: sig(), call: { callId: 'c', name: 'web_fetch', arguments: { url: '' } } }))).content.error_type, 'url_required');
});

test('web_fetch propagates request cancellation instead of swallowing it', async t => {
  const { url, ready, close } = localServer((req, res) => { setTimeout(() => { try { res.end('late'); } catch {} }, 3000); });
  await ready; t.after(close);
  const tools = createNativeWebTools({ fetch, providerConfig: {}, ssrfPolicy: { allowPrivate: true }, authorize: allowAuthorize, sessionId: 's1' });
  const controller = new AbortController();
  const promise = tools.execute(webRequest({ sessionId: 's1', signal: controller.signal, call: { callId: 'c', name: 'web_fetch', arguments: { url: url() } } }));
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(promise);
});

test('web_fetch persists oversized output via the injected persistOutput callback and reports the ref', async t => {
  const { url, ready, close } = localServer((req, res) => { res.setHeader('content-type', 'text/plain'); res.end('A'.repeat(600)); });
  await ready; t.after(close);
  let captured;
  const tools = createNativeWebTools({ fetch, providerConfig: {}, ssrfPolicy: { allowPrivate: true }, authorize: allowAuthorize, sessionId: 's1', persistOutput: async (req, fullText, meta) => { captured = { fullText, meta }; return { uri: 'artifact://web-fetch/1' }; } });
  const r = await tools.execute(webRequest({ sessionId: 's1', signal: sig(), call: { callId: 'c', name: 'web_fetch', arguments: { url: url(), max_chars: 100 } } }));
  assert.equal(r.content.truncated, true);
  assert.equal(r.content.persisted.path, 'artifact://web-fetch/1');
  assert.equal(captured.fullText.length, 600);
  assert.equal(captured.meta.toolName, 'web_fetch');
});

test('web_fetch reports persisted.failed when persistOutput throws (never claims success)', async t => {
  const { url, ready, close } = localServer((req, res) => { res.setHeader('content-type', 'text/plain'); res.end('B'.repeat(600)); });
  await ready; t.after(close);
  const tools = createNativeWebTools({ fetch, providerConfig: {}, ssrfPolicy: { allowPrivate: true }, authorize: allowAuthorize, sessionId: 's1', persistOutput: async () => { throw new Error('disk full'); } });
  const r = await tools.execute(webRequest({ sessionId: 's1', signal: sig(), call: { callId: 'c', name: 'web_fetch', arguments: { url: url(), max_chars: 100 } } }));
  assert.equal(r.content.persisted.failed, true);
});

test('web_fetch rejects malformed persistence references instead of reporting an empty success', async t => {
  const { url, ready, close } = localServer((_req, res) => { res.setHeader('content-type', 'text/plain'); res.end('B'.repeat(600)); });
  await ready; t.after(close);
  for (const ref of [undefined, null, { status: 'error' }, { uri: '' }, { path: 42 }, { uri: 'bad\0path' }]) {
    const tools = createNativeWebTools({ fetch, providerConfig: {}, ssrfPolicy: { allowPrivate: true },
      authorize: allowAuthorize, sessionId: 's1', persistOutput: async () => ref });
    const r = await tools.execute(webRequest({ sessionId: 's1', signal: sig(),
      call: { callId: 'c', name: 'web_fetch', arguments: { url: url(), max_chars: 100 } } }));
    assert.equal(r.content.persisted.failed, true);
    assert.equal(r.content.persisted.error, 'persist_output_failed');
    assert.equal(r.content.persisted.path, undefined);
  }
});

test('web_fetch reports body_truncated_by_byte_ceiling for an oversized stream', async t => {
  const { url, ready, close } = localServer((req, res) => { res.setHeader('content-type', 'text/plain'); res.end('C'.repeat(11 * 1024 * 1024)); });
  await ready; t.after(close);
  const tools = createNativeWebTools({ fetch, providerConfig: {}, ssrfPolicy: { allowPrivate: true }, authorize: allowAuthorize, sessionId: 's1' });
  const r = await tools.execute(webRequest({ sessionId: 's1', signal: sig(), call: { callId: 'c', name: 'web_fetch', arguments: { url: url() } } }));
  assert.equal(r.content.body_truncated_by_byte_ceiling, true);
  assert.equal(r.content.full_bytes > 0, true);
});

test('web_search fake/http/ksyun providers and credential isolation', async t => {
  // fake
  const fake = createNativeWebTools({ fetch: async () => ({}), providerConfig: { provider: 'fake' }, authorize: allowAuthorize, sessionId: 's1' });
  const rf = await fake.execute(webRequest({ sessionId: 's1', signal: sig(), call: { callId: 'c', name: 'web_search', arguments: { query: 'hello', max_results: 2 } } }));
  assert.equal(rf.content.provider, 'fake');
  assert.equal(rf.content.results.length, 1);
  // http provider real GET
  let captured;
  const { url, ready, close } = localServer((req, res) => { captured = req.url; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ results: [{ title: 'T1', url: 'https://a.com', snippet: 'S1' }] })); });
  await ready; t.after(close);
  const http = createNativeWebTools({ fetch, providerConfig: { provider: 'http', baseUrl: url(), apiKey: 'secret-key' }, authorize: allowAuthorize, sessionId: 's1' });
  const rh = await http.execute(webRequest({ sessionId: 's1', signal: sig(), call: { callId: 'c', name: 'web_search', arguments: { query: 'q', max_results: 5, recency_days: 7 } } }));
  assert.equal(rh.content.provider, 'http');
  assert.deepEqual(rh.content.results[0], { title: 'T1', url: 'https://a.com', snippet: 'S1', rank: 1, provider: 'http' });
  assert.match(captured, /q=q/);
  assert.match(captured, /recency_days=7/);
  // ksyun provider real POST
  let body, headers;
  const srv2 = createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { body = b; headers = req.headers; res.end(JSON.stringify({ webpages: [{ title: 'K1', url: 'https://k.com', snippet: 'KS1', date: '2026-01-01' }] })); }); });
  await new Promise(r => srv2.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { srv2.closeAllConnections?.(); srv2.close(() => r()); }));
  const ksyun = createNativeWebTools({ fetch, providerConfig: { provider: 'ksyun', baseUrl: `http://127.0.0.1:${srv2.address().port}`, apiKey: 'ksyun-key', scope: 'document' }, authorize: allowAuthorize, sessionId: 's1', ssrfPolicy: { allowPrivate: true } });
  const rk = await ksyun.execute(webRequest({ sessionId: 's1', signal: sig(), call: { callId: 'c', name: 'web_search', arguments: { query: 'q', max_results: 10 } } }));
  assert.equal(rk.content.provider, 'ksyun');
  assert.equal(rk.content.results[0].date, '2026-01-01');
  assert.equal(JSON.parse(body).scope, 'document');
  assert.equal(headers.authorization, 'Bearer ksyun-key');
  // no api key leak on error
  const { url: u3, ready: r3, close: c3 } = localServer((req, res) => { res.statusCode = 500; res.end('boom'); });
  await r3; t.after(c3);
  const errTools = createNativeWebTools({ fetch, providerConfig: { provider: 'http', baseUrl: u3(), apiKey: 'SECRET-LEAK' }, authorize: allowAuthorize, sessionId: 's1', ssrfPolicy: { allowPrivate: true } });
  const re = await errTools.execute(webRequest({ sessionId: 's1', signal: sig(), call: { callId: 'c', name: 'web_search', arguments: { query: 'q' } } }));
  assert.equal(re.content.ok, false);
  assert.doesNotMatch(JSON.stringify(re.content), /SECRET-LEAK/);
  assert.doesNotMatch(JSON.stringify(re.content), /boom/);
});

test('execute enforces session binding, schema, authorization, drift and unknown tools', async () => {
  const tools = createNativeWebTools({ fetch: async () => ({}), providerConfig: { provider: 'fake' }, authorize: allowAuthorize, sessionId: 's1' });
  assert.equal((await tools.execute(webRequest({ sessionId: 'other', call: { callId: 'c', name: 'web_search', arguments: { query: 'q' } } }))).content.code, 'web_session_mismatch');
  assert.equal((await tools.execute(webRequest({ sessionId: 's1', signal: sig(), call: { callId: 'c', name: 'nope', arguments: {} } }))).content.code, 'unknown_tool');
  assert.equal((await tools.execute(webRequest({ sessionId: 's1', signal: sig(), call: { callId: 'c', name: 'web_search', arguments: { query: 123 } } }))).content.code, 'invalid_arguments');
  const denied = createNativeWebTools({ fetch: async () => ({}), providerConfig: { provider: 'fake' }, authorize: async () => ({ status: 'error' }), sessionId: 's1' });
  assert.equal((await denied.execute(webRequest({ sessionId: 's1', signal: sig(), call: { callId: 'c', name: 'web_search', arguments: { query: 'q' } } }))).content.code, 'policy_denied');
});

test('execute rejects context drift after the authorization await (no fetch after drift)', async () => {
  let resolveAuthorize;
  const slowAuthorize = () => new Promise(r => { resolveAuthorize = r; });
  const tools = createNativeWebTools({ fetch: async () => { throw new Error('should not fetch'); }, providerConfig: { provider: 'fake' }, authorize: slowAuthorize, sessionId: 's1' });
  const request = webRequest({ sessionId: 's1', signal: sig(), runId: 'r1', operationKey: 'op1', call: { callId: 'c', name: 'web_search', arguments: { query: 'q' } } });
  const promise = tools.execute(request);
  // Mutate the request after the authorize await has started.
  request.runId = 'r2';
  resolveAuthorize('allow');
  const r = await promise;
  assert.equal(r.status, 'error');
  assert.equal(r.content.code, 'web_context_drift');
});

test('execute rejects drift of request.definition during the authorize await', async () => {
  let resolveAuthorize;
  const slowAuthorize = () => new Promise(r => { resolveAuthorize = r; });
  const tools = createNativeWebTools({ fetch: async () => { throw new Error('should not fetch'); }, providerConfig: { provider: 'fake' }, authorize: slowAuthorize, sessionId: 's1' });
  // Start from the real formal definition so the entry check passes; then swap
  // to a different definition during the authorize await.
  const realDef = tools.definitions.find(d => d.name === 'web_search');
  const tamperedDef = { ...realDef, description: 'tampered' };
  const request = webRequest({ sessionId: 's1', signal: sig(), definition: realDef, call: { callId: 'c', name: 'web_search', arguments: { query: 'q' } } });
  const promise = tools.execute(request);
  request.definition = tamperedDef; // swap definition during await
  resolveAuthorize('allow');
  const r = await promise;
  assert.equal(r.content.code, 'web_context_drift');
});

test('createNativeWebTools requires a trusted authorize callback (no default auto-allow)', () => {
  assert.throws(() => createNativeWebTools({ fetch: async () => ({}), providerConfig: {}, sessionId: 's1' }), /native_web_authorize_required/);
});

test('createNativeWebTools seals providerConfig and ssrfPolicy against external mutation', async () => {
  const orig = { provider: 'fake', apiKey: 'k' };
  const tools = createNativeWebTools({ fetch: async () => ({}), providerConfig: orig, authorize: allowAuthorize, sessionId: 's1' });
  orig.provider = 'http';
  const r = await tools.execute(webRequest({ sessionId: 's1', signal: sig(), call: { callId: 'c', name: 'web_search', arguments: { query: 'q' } } }));
  assert.equal(r.content.provider, 'fake');
});

test('execute requires a real AbortSignal and rejects a missing or invalid one', async () => {
  const tools = createNativeWebTools({ fetch: async () => ({}), providerConfig: { provider: 'fake' }, authorize: allowAuthorize, sessionId: 's1' });
  assert.equal((await tools.execute(webRequest({ sessionId: 's1', call: { callId: 'c', name: 'web_search', arguments: { query: 'q' } } }))).content.code, 'invalid_request');
  assert.equal((await tools.execute(webRequest({ sessionId: 's1', signal: {}, call: { callId: 'c', name: 'web_search', arguments: { query: 'q' } } }))).content.code, 'invalid_request');
});

test('execute rejects a request whose definition does not match the locked formal one', async () => {
  const tools = createNativeWebTools({ fetch: async () => ({}), providerConfig: { provider: 'fake' }, authorize: allowAuthorize, sessionId: 's1' });
  const forged = { name: 'web_search', description: 'tampered', parameters: {}, readOnly: true, concurrentSafe: true, permissions: [], timeoutMs: 1, contextRole: 'none', observationRole: 'none', progressObservation: false, contextRetention: 'normal' };
  const r = await tools.execute(webRequest({ sessionId: 's1', signal: sig(), definition: forged, call: { callId: 'c', name: 'web_search', arguments: { query: 'q' } } }));
  assert.equal(r.content.code, 'web_definition_mismatch');
});

test('execute passes the real AbortSignal to the authorize callback so it can cancel its wait', async () => {
  let received;
  const tools = createNativeWebTools({ fetch: async () => ({}), providerConfig: { provider: 'fake' }, authorize: async payload => { received = payload; return 'allow'; }, sessionId: 's1' });
  const controller = new AbortController();
  await tools.execute(webRequest({ sessionId: 's1', signal: controller.signal, call: { callId: 'c', name: 'web_search', arguments: { query: 'q' } } }));
  assert.equal(received.signal, controller.signal, 'authorize received the live AbortSignal by identity');
  assert.equal(typeof received.signal.throwIfAborted, 'function');
  assert.equal(received.definition.name, 'web_search');
  assert.equal(received.executionFence, 1);
});
