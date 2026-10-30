import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createDshNodeWebTools, DSH_NODE_WEB_CONTRACT } from '../src/providers/dsh-node-web-tools.mjs';
import { createRuntimeBridge } from '../src/host/runtime-bridge.mjs';
import { nativeWebToolDefinitions } from '@kingsoftcloud/agentkit-harness-node/native/web-tools';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const response = text => new Response(text, { headers: { 'content-type': 'text/plain' } });
function fixture(t, options = {}) {
  const calls = [], port = createDshNodeWebTools({ agentId: 'bound-agent',
    fetchImpl: async (url, init) => { calls.push({ url, init }); return response('原始结果 😀'); }, ...options });
  t.after(() => port.close());
  const args = { url: 'https://8.8.8.8/page' };
  const controller = new AbortController();
  const exec = { name: 'web_fetch', callId: 'real-call', arguments: args, signal: controller.signal,
    agent: { session: { id: 'real-session' } } };
  return { port, calls, args, exec, controller, run: () => port.execute('web_fetch', args, exec) };
}

test('shared formal schemas are independent of every public copy', async t => {
  const f = fixture(t);
  assert.equal(f.port.contract, DSH_NODE_WEB_CONTRACT);
  assert.deepEqual(f.port.definitions, nativeWebToolDefinitions());
  f.port.definitions[0].parameters.additionalProperties = true;
  f.args.extra = true;
  assert.equal((await f.run()).status, 'error'); assert.equal(f.calls.length, 0);
  delete f.args.extra;
  const result = await f.run();
  assert.equal(result.status, 'ok'); assert.equal(result.content.text, '原始结果 😀');
  assert.equal(f.calls.length, 1);
  assert.equal(f.port.supports('web_fetch'), true); assert.equal(f.port.supports('run_command'), false);
});

test('default SSRF policy admits a public literal and denies private addresses before dispatch', async t => {
  const f = fixture(t);
  assert.equal((await f.run()).status, 'ok');
  f.args.url = 'http://127.0.0.1/';
  const blocked = await f.run();
  assert.equal(blocked.content.error_type, 'blocked_by_ssrf_policy'); assert.equal(f.calls.length, 1);
});

test('real local HTTP preserves DOM extraction, Unicode budget, redirect and complete persistence context', async t => {
  const server = createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: '/page' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<script>secret</script><p>😀甲乙</p>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const persisted = [];
  const f = fixture(t, { fetchImpl: globalThis.fetch, ssrfPolicy: { allowPrivate: true },
    persistOutput: async (request, text, metadata) => { persisted.push({ request, text, metadata }); return { path: 'actual-output.txt' }; } });
  f.args.url = `http://127.0.0.1:${server.address().port}/redirect`; f.args.max_chars = 1;
  const result = await f.run();
  assert.equal(result.status, 'ok'); assert.equal(result.content.text, '😀'); assert.equal(result.content.truncated, true);
  assert.equal(result.content.final_url, f.args.url.replace('/redirect', '/page'));
  assert.equal(result.content.persisted.path, 'actual-output.txt'); assert.equal(persisted[0].text, '😀甲乙');
  assert.equal(persisted[0].request.agentId, 'bound-agent'); assert.equal(persisted[0].request.sessionId, 'real-session');
  assert.deepEqual(persisted[0].request.call, { callId: 'real-call', name: 'web_fetch', arguments: f.args });
  for (const key of ['scope', 'runId', 'turnId', 'executionFence', 'operationKey']) assert.equal(key in persisted[0].request, false);
});

for (const field of ['agent', 'session', 'sessionId', 'callId', 'name', 'signal', 'args', 'execArguments']) {
  test(`drift of original ${field} blocks redirect and output persistence`, async t => {
    const ready = deferred(), release = deferred(); let dispatches = 0, writes = 0;
    const f = fixture(t, { fetchImpl: async () => { dispatches++; ready.resolve(); return release.promise; },
      persistOutput: async () => { writes++; return { path: 'forbidden' }; } });
    f.args.max_chars = 1;
    const pending = f.run(); await ready.promise;
    switch (field) {
      case 'agent': f.exec.agent = { session: f.exec.agent.session }; break;
      case 'session': f.exec.agent.session = { id: 'real-session' }; break;
      case 'sessionId': f.exec.agent.session.id = 'foreign'; break;
      case 'callId': f.exec.callId = 'foreign'; break;
      case 'name': f.exec.name = 'web_search'; break;
      case 'signal': f.exec.signal = new AbortController().signal; break;
      case 'args': f.args.url += '/changed'; break;
      case 'execArguments': f.exec.arguments = { url: 'https://8.8.4.4/' }; break;
    }
    release.resolve(new Response('', { status: 302, headers: { location: '/next' } }));
    const result = await pending;
    assert.equal(result.status, 'error'); assert.equal(result.content.error_type, 'dsh_node_web_request_drifted');
    assert.equal(dispatches, 1); assert.equal(writes, 0);
  });
}

test('identity drift during response body consumption cannot persist oversized output', async t => {
  const ready = deferred(), release = deferred(); let writes = 0;
  const f = fixture(t, { fetchImpl: async () => ({ status: 200, headers: new Headers(),
    text: async () => { ready.resolve(); await release.promise; return 'full original output'; } }),
    persistOutput: async () => { writes++; return { path: 'wrong-session' }; } });
  f.args.max_chars = 1;
  const pending = f.run(); await ready.promise; f.exec.agent.session.id = 'foreign'; release.resolve();
  assert.equal((await pending).content.error_type, 'dsh_node_web_request_drifted'); assert.equal(writes, 0);
});

for (const cancel of ['caller', 'close', 'host', 'registration']) {
  test(`${cancel} cancels the real fetch signal, settles an uncooperative fetch and observes late rejection`, async t => {
    const ready = deferred(), release = deferred(), host = new AbortController(); let fetchSignal;
    const bridge = createRuntimeBridge(); t.after(() => bridge.close());
    let retire;
    const opts = { signal: host.signal, fetchImpl: async (_url, init) => { fetchSignal = init.signal; ready.resolve(); return release.promise; } };
    if (cancel === 'registration') {
      retire = bridge.setBuiltinToolsFactory(input => createDshNodeWebTools({ ...input, agentId: 'bound-agent', fetchImpl: opts.fetchImpl }));
    }
    const f = fixture(t, opts);
    const port = cancel === 'registration' ? bridge.createBuiltinTools({}) : f.port;
    t.after(() => port.close());
    const pending = port.execute('web_fetch', f.args, f.exec); await ready.promise;
    if (cancel === 'caller') f.controller.abort();
    else if (cancel === 'close') port.close();
    else if (cancel === 'host') host.abort();
    else retire();
    let timer;
    const result = await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('cancel did not settle')), 1500); })]).finally(() => clearTimeout(timer));
    assert.equal(fetchSignal.aborted, true); assert.equal(result.status, 'error');
    release.reject(Error('late transport failure with SECRET')); await new Promise(resolve => setImmediate(resolve));
  });
}

test('an invalid async lifetime predicate is observed and refuses network dispatch', async t => {
  const f = fixture(t, { isClosed: () => Promise.reject(Error('SECRET')) });
  assert.equal((await f.run()).content.error_type, 'dsh_node_web_is_closed_invalid');
  assert.equal(f.calls.length, 0); await new Promise(resolve => setImmediate(resolve));
});

test('timeout is seconds, with the same original signal and bounded shared transport', async t => {
  const ready = deferred(), release = deferred(); let signal;
  const f = fixture(t, { fetchImpl: async (_url, init) => { signal = init.signal; ready.resolve(); return release.promise; } });
  f.args.timeout = 1;
  const pending = f.run(); await ready.promise;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(signal.aborted, false, 'one second cannot be interpreted as one millisecond');
  release.resolve(response('actual output')); assert.equal((await pending).status, 'ok');
});

test('trusted search endpoint uses the shared provider protocol; absent provider is an error', async t => {
  const f = fixture(t);
  let exec = { ...f.exec, name: 'web_search', arguments: { query: 'actual query' } };
  const missing = await f.port.execute('web_search', exec.arguments, exec);
  assert.equal(missing.status, 'error'); assert.equal(missing.content.error_type, 'provider_not_configured');
  const seen = [];
  const other = fixture(t, { providerConfig: { provider: 'http', baseUrl: 'https://search.internal/api', apiKey: 'SECRET' },
    searchFetch: async (url, init) => { seen.push({ url, init }); return Response.json({ results: [{ title: '真实结果', url: 'https://example.com', snippet: '证据' }] }); } });
  exec = { ...other.exec, name: 'web_search', arguments: { query: 'actual query', recency_days: 3 } };
  const found = await other.port.execute('web_search', exec.arguments, exec);
  assert.equal(found.status, 'ok'); assert.equal(found.content.results[0].title, '真实结果');
  assert.equal(new URL(seen[0].url).searchParams.get('q'), 'actual query');
  assert.equal(seen[0].init.headers.Authorization, 'Bearer SECRET'); assert.equal(JSON.stringify(found).includes('SECRET'), false);
});
