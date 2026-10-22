import { webRequest } from './fixtures/native-web-request.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isIP } from 'node:net';
import { resolveWebSearchConfig, resolveWebSsrfPolicy, createNativeDshWebTools, createSsrfPinnedFetch, NATIVE_WEB_TOOLS_CONTRACT } from '../src/providers/native-dsh-web.mjs';
import { createNativeArtifactStore } from '../packages/agentkit-harness/src/native/artifact-store.mjs';

const allowAuthorize = async () => 'allow';
const sig = () => new AbortController().signal;

test('the protecting dispatcher resolves a hostname and actually connects using validated addresses', async t => {
  let requests = 0, lookups = 0;
  const { url, ready, close } = localServer((_req, res) => { requests++; res.end('connected through pinned DNS'); });
  await ready; t.after(close);
  const pinned = createSsrfPinnedFetch({
    // The deterministic transport policy allows this fixture's loopback IP.
    // A hostname must reach DNS, rather than being rejected as an unknown IP.
    ssrfBlockCheck: address => !isIP(address),
    lookupAddress(hostname, options, callback) {
      lookups++; assert.equal(hostname, 'fixture.invalid'); assert.equal(options.all, true);
      callback(null, [{ address: '127.0.0.1', family: 4 }]);
    },
  });
  t.after(() => pinned.close());
  const endpoint = new URL(url()); endpoint.hostname = 'fixture.invalid';
  const response = await pinned.fetch(endpoint, { signal: AbortSignal.timeout(2000) });
  assert.equal(await response.text(), 'connected through pinned DNS');
  assert.equal(lookups, 1); assert.equal(requests, 1);
});

test('the protecting dispatcher rejects the whole DNS answer when one address is disallowed', async t => {
  let requests = 0;
  const { url, ready, close } = localServer((_req, res) => { requests++; res.end('must not connect'); });
  await ready; t.after(close);
  const pinned = createSsrfPinnedFetch({
    ssrfBlockCheck: address => address === '10.0.0.1',
    lookupAddress(_host, _options, callback) {
      callback(null, [{ address: '127.0.0.1', family: 4 }, { address: '10.0.0.1', family: 4 }]);
    },
  });
  t.after(() => pinned.close());
  const endpoint = new URL(url()); endpoint.hostname = 'fixture.invalid';
  await assert.rejects(pinned.fetch(endpoint, { signal: AbortSignal.timeout(2000) }),
    error => error.cause?.code === 'blocked_by_ssrf_policy');
  assert.equal(requests, 0);
});

test('an unconfigured ksyun credential returns a configuration error without network I/O', async t => {
  let requests = 0;
  const tools = createNativeDshWebTools({ config: { sessionId: 's1', authorize: allowAuthorize,
    env: { KSADK_WEB_SEARCH_PROVIDER: 'ksyun' } }, fetch: async () => { requests++; throw new Error('must not fetch'); } });
  t.after(() => tools.close());
  const result = await tools.execute(webRequest({ sessionId: 's1', signal: sig(),
    call: { callId: 'no-key', name: 'web_search', arguments: { query: 'query' } } }));
  assert.equal(result.content.error_type, 'provider_not_configured'); assert.equal(requests, 0);
});

test('a trusted private search service works while the same model-chosen URL remains blocked', async t => {
  let hits = 0;
  const { url, ready, close } = localServer((request, response) => {
    hits++; assert.equal(request.headers.authorization, 'Bearer test-private-service');
    assert.equal(new URL(request.url, url()).searchParams.get('q'), 'service query');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ results: [{ title: 'Internal index', url: 'https://example.com/', snippet: 'Result' }] }));
  });
  await ready; t.after(close);
  const tools = createNativeDshWebTools({ config: { sessionId: 's1', authorize: allowAuthorize,
    providerConfig: { provider: 'http', baseUrl: `${url()}/search`, apiKey: 'test-private-service' } } });
  t.after(() => tools.close());
  const searched = await tools.execute(webRequest({ sessionId: 's1', signal: sig(),
    call: { callId: 'search', name: 'web_search', arguments: { query: 'service query' } } }));
  assert.equal(searched.status, 'ok'); assert.equal(searched.content.results[0].title, 'Internal index');
  const fetched = await tools.execute(webRequest({ sessionId: 's1', signal: sig(),
    call: { callId: 'fetch', name: 'web_fetch', arguments: { url: url() } } }));
  assert.equal(fetched.status, 'error'); assert.equal(fetched.content.error_type, 'blocked_by_ssrf_policy');
  assert.equal(hits, 1);
});
function localServer(handler) {
  const server = createServer(handler);
  const ready = new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
  const url = () => `http://127.0.0.1:${server.address().port}`;
  const close = () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()); });
  return { server, url, ready, close };
}

test('resolveWebSearchConfig mirrors the Python env keys for each provider', () => {
  assert.deepEqual(resolveWebSearchConfig({}), { provider: '' });
  assert.deepEqual(resolveWebSearchConfig({ KSADK_WEB_SEARCH_PROVIDER: 'FAKE' }), { provider: 'fake' });
  const http = resolveWebSearchConfig({ KSADK_WEB_SEARCH_PROVIDER: 'http', KSADK_WEB_SEARCH_BASE_URL: 'https://api.example.com/s', OPENCLAW_WEB_SEARCH_API_KEY: 'k' });
  assert.equal(http.provider, 'http');
  assert.equal(http.baseUrl, 'https://api.example.com/s');
  assert.equal(http.apiKey, 'k');
  const ksyun = resolveWebSearchConfig({ KSADK_WEB_SEARCH_PROVIDER: 'ksyun', KSADK_MCP_KEY: 'mk', KSADK_WEB_SEARCH_SCOPE: 'scholar' });
  assert.equal(ksyun.provider, 'ksyun');
  assert.equal(ksyun.apiKey, 'mk');
  assert.equal(ksyun.scope, 'scholar');
  assert.equal(ksyun.baseUrl, '');
  const ksyunFallback = resolveWebSearchConfig({ KSADK_WEB_SEARCH_PROVIDER: 'ksyun', KSC_AIPRO_API_KEY: 'ap' });
  assert.equal(ksyunFallback.apiKey, 'ap');
});

test('resolveWebSsrfPolicy parses the env JSON and tolerates invalid input', () => {
  assert.deepEqual(resolveWebSsrfPolicy({}), {});
  assert.deepEqual(resolveWebSsrfPolicy({ KSADK_WEB_SSRF_POLICY_JSON: '{"allow_private":true}' }), { allow_private: true });
  assert.deepEqual(resolveWebSsrfPolicy({ OPENCLAW_BROWSER_SSRF_POLICY_JSON: 'not json' }), {});
  assert.deepEqual(resolveWebSsrfPolicy({ KSADK_WEB_SSRF_POLICY_JSON: '[1,2]' }), {});
});

test('createNativeDshWebTools redacts the api key and sanitizes baseUrl (strips user/pass/query)', () => {
  const t = createNativeDshWebTools({ config: { sessionId: 's1', authorize: allowAuthorize, providerConfig: { provider: 'http', baseUrl: 'https://user:pass@api.example.com/s?secret=LEAK', apiKey: 'SECRET' } }, fetch: async () => ({}) });
  assert.equal(t.providerConfig.apiKey, '<redacted>');
  assert.equal(t.providerConfig.baseUrl, 'https://api.example.com/s');
  assert.equal(t.providerConfig.provider, 'http');
  assert.doesNotMatch(t.bindingDigest, /SECRET|LEAK|user|pass/);
  assert.doesNotMatch(JSON.stringify(t.providerConfig), /SECRET|LEAK|user:pass/);
  assert.equal(t.bindingDigest.length, 64);
  assert.equal(t.contract, NATIVE_WEB_TOOLS_CONTRACT);
  assert.deepEqual(t.definitions.map(d => d.name), ['web_fetch', 'web_search']);
});

test('bindingDigest differs when the provider route query changes (no plaintext leak)', () => {
  const a = createNativeDshWebTools({ config: { sessionId: 's1', authorize: allowAuthorize, providerConfig: { provider: 'http', baseUrl: 'https://api.example.com/s?scope=a' } }, fetch: async () => ({}) });
  const b = createNativeDshWebTools({ config: { sessionId: 's1', authorize: allowAuthorize, providerConfig: { provider: 'http', baseUrl: 'https://api.example.com/s?scope=b' } }, fetch: async () => ({}) });
  assert.notEqual(a.bindingDigest, b.bindingDigest, 'route change detected');
  assert.doesNotMatch(a.bindingDigest, /scope/);
  assert.doesNotMatch(b.bindingDigest, /scope/);
});

test('bindingDigest differs when the api key changes (opaque fingerprint, no plaintext)', () => {
  const a = createNativeDshWebTools({ config: { sessionId: 's1', authorize: allowAuthorize, providerConfig: { provider: 'http', baseUrl: 'https://api.example.com/s', apiKey: 'KEY-A' } }, fetch: async () => ({}) });
  const b = createNativeDshWebTools({ config: { sessionId: 's1', authorize: allowAuthorize, providerConfig: { provider: 'http', baseUrl: 'https://api.example.com/s', apiKey: 'KEY-B' } }, fetch: async () => ({}) });
  assert.notEqual(a.bindingDigest, b.bindingDigest);
  assert.doesNotMatch(a.bindingDigest, /KEY-A/);
  assert.doesNotMatch(b.bindingDigest, /KEY-B/);
});

test('createNativeDshWebTools requires a trusted authorize callback (no default auto-allow)', () => {
  assert.throws(() => createNativeDshWebTools({ config: { sessionId: 's1' }, fetch: async () => ({}) }), { code: 'NATIVE_WEB_AUTHORIZE_REQUIRED' });
});

test('createNativeDshWebTools execute is wired through the pure adapter (fake provider) and requires a signal', async () => {
  const t = createNativeDshWebTools({ config: { sessionId: 's1', authorize: allowAuthorize, providerConfig: { provider: 'fake' } }, fetch: async () => ({}) });
  const r = await t.execute(webRequest({ sessionId: 's1', signal: sig(), call: { callId: 'c1', name: 'web_search', arguments: { query: 'hello' } } }));
  assert.equal(r.status, 'ok');
  assert.equal(r.content.provider, 'fake');
  assert.equal(r.content.results[0].title, 'Fake result for hello');
  // missing signal -> invalid_request
  assert.equal((await t.execute(webRequest({ sessionId: 's1', call: { callId: 'c', name: 'web_search', arguments: { query: 'q' } } }))).content.code, 'invalid_request');
});

test('createNativeDshWebTools exposes close that returns a Promise to release the SSRF-pinned Agent', async () => {
  const t = createNativeDshWebTools({ config: { sessionId: 's1', authorize: allowAuthorize, providerConfig: { provider: 'fake' } }, fetch: async () => ({}) });
  assert.equal(typeof t.close, 'function');
  const result = t.close();
  assert.ok(result && typeof result.then === 'function', 'close returns a Promise');
  await result;
});

test('the production adapter persists oversized output to a real ArtifactStore on disk', async t => {
  const root = mkdtempSync(join(tmpdir(), 'native-web-artifact-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scope = { tenantId: 't1', workspaceId: 'w1', userId: 'u1', agentId: 'a1' };
  const store = await createNativeArtifactStore({ directory: join(root, 'artifacts'), scope });
  const { url, ready, close } = localServer((req, res) => { res.setHeader('content-type', 'text/plain'); res.end('D'.repeat(600)); });
  await ready; t.after(close);
  const tools = createNativeDshWebTools({ config: { sessionId: 's1', authorize: allowAuthorize, providerConfig: {}, ssrfPolicy: { allowPrivate: true }, artifact: { store, scope } }, fetch });
  const r = await tools.execute(webRequest({ sessionId: 's1', signal: sig(), runId: 'run1', operationKey: 'op1', call: { callId: 'c', name: 'web_fetch', arguments: { url: url(), max_chars: 50 } } }));
  assert.equal(r.content.truncated, true);
  assert.ok(r.content.persisted?.path, 'persisted ref returned');
  assert.match(r.content.persisted.path, /artifact:/);
  const files = readdirSync(join(root, 'artifacts'), { recursive: true });
  assert.ok(files.some(f => String(f).endsWith('.content')), 'content file written to disk');
  tools.close();
});

test('the production adapter reports persisted.failed when the ArtifactStore write throws', async t => {
  const { url, ready, close } = localServer((req, res) => { res.setHeader('content-type', 'text/plain'); res.end('E'.repeat(600)); });
  await ready; t.after(close);
  const failingStore = { write: async () => { throw new Error('disk full'); } };
  const tools = createNativeDshWebTools({ config: { sessionId: 's1', authorize: allowAuthorize, providerConfig: {}, ssrfPolicy: { allowPrivate: true }, artifact: { store: failingStore, scope: { tenantId: 't', workspaceId: 'w', agentId: 'a' } } }, fetch });
  const r = await tools.execute(webRequest({ sessionId: 's1', signal: sig(), runId: 'r', operationKey: 'o', call: { callId: 'c', name: 'web_fetch', arguments: { url: url(), max_chars: 50 } } }));
  assert.equal(r.content.persisted.failed, true);
  tools.close();
});

test('the production URL precheck blocks a private literal before any connection', async t => {
  let requests = 0;
  const { url, ready, close } = localServer((req, res) => { requests++; res.setHeader('content-type', 'text/plain'); res.end('should not reach'); });
  await ready; t.after(close);
  // ssrfPolicy default (no allowPrivate): the pinned Agent's connect.lookup
  // rejects 127.0.0.1, so the fetch fails with a blocked-by-ssrf error.
  const tools = createNativeDshWebTools({ config: { sessionId: 's1', authorize: allowAuthorize, providerConfig: {} }, fetch });
  const r = await tools.execute(webRequest({ sessionId: 's1', signal: sig(), call: { callId: 'c', name: 'web_fetch', arguments: { url: url(), timeout: 3 } } }));
  assert.equal(r.content.ok, false);
  // Either the pure adapter's pre-check or the pinned connect rejects it.
  assert.equal(r.content.error_type, 'blocked_by_ssrf_policy');
  assert.equal(requests, 0);
  await tools.close();
});
