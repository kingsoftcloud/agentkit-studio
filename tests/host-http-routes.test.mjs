import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { registerControlPlaneRoutes } from '../src/host/routes/http.mjs';
import { ASSISTANT_UPLOAD_RPC_PATH, ASSISTANT_UPLOAD_RPC_BODY_BYTES } from '../src/contracts/assistant-attachments.mjs';

async function harness(t, options = {}) {
  const routes = new Map(), releases = [], calls = [];
  const webCtx = {
    connection: { admit: options.admit || (() => ({})) },
    webServer: { register: spec => { routes.set(spec.path, spec.handler); return () => routes.delete(spec.path); } },
    effect: setup => releases.push(setup()),
  };
  const ctx = { inject: (_names, mount) => mount(webCtx) };
  await registerControlPlaneRoutes(ctx, {
    models: {},
    dispatch: options.dispatch || (async (...args) => { calls.push(args); return { ok: true, value: 'fixture' }; }),
    serverClientPromise: Promise.resolve(options.serverClient || {}),
    getLegacyLocalConversationHandler: options.getLegacyLocalConversationHandler,
  });
  const server = createServer((request, response) => {
    const path = [...routes.keys()].sort((a, b) => b.length - a.length).find(path => request.url.startsWith(path));
    const handler = routes.get(path);
    if (!handler) { response.writeHead(404); response.end(); return; }
    Promise.resolve(handler(request, response)).catch(error => response.destroy(error));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    unload();
    assert.equal(routes.size, 0);
  });
  const unload = () => releases.splice(0).reverse().forEach(release => release());
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, calls, unload, request: (path, body, method = 'POST') => fetch(base + path, { method, ...(body !== undefined ? { body } : {}) }) };
}

for (const status of [401, 403]) {
  test(`control RPC rejects ${status} before dispatch or JSON parsing`, async t => {
    const host = await harness(t, { admit: () => ({ rejection: status }) });
    const response = await host.request('/agentkit', '{malformed');
    assert.equal(response.status, status);
    assert.equal(await response.text(), status === 401 ? 'unauthorized' : 'forbidden');
    assert.equal(host.calls.length, 0);
  });
}

test('control RPC retains request identity, envelope and EOF cancellation semantics', async t => {
  const host = await harness(t);
  const payload = { agentId: 'fixture-agent' };
  const response = await host.request('/agentkit', JSON.stringify({ method: 'agents/list', payload, rpcId: 42 }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { type: 'server-response', rpcId: '42', result: { ok: true, value: 'fixture' } });
  assert.deepEqual(host.calls[0].slice(0, 2), ['agents/list', payload]);
  assert.ok(host.calls[0][2] instanceof AbortSignal);
  assert.equal(host.calls[0][2].aborted, false, 'normal request EOF and response completion are not cancellation');
});

for (const reason of ['disconnect', 'scope-unload']) {
  test(`pending control RPC cancels on ${reason} after request EOF`, { timeout: 5000 }, async t => {
    const { promise: started, resolve: start } = Promise.withResolvers();
    const { promise: aborted, resolve: abort } = Promise.withResolvers();
    const host = await harness(t, { dispatch: async (_endpoint, _payload, signal) => {
      start();
      await new Promise(resolve => signal?.addEventListener('abort', () => { abort(true); resolve(); }, { once: true }));
      return { ok: false, error: { code: 'gateway/cancelled' } };
    } });
    const request = httpRequest(host.base + '/agentkit', { method: 'POST' });
    request.on('error', () => {});
    request.end(JSON.stringify({ method: 'agents/list', rpcId: 'pending' }));
    await started;
    if (reason === 'disconnect') request.destroy(); else host.unload();
    assert.equal(await Promise.race([aborted, new Promise(resolve => setTimeout(() => resolve(false), 100))]), true);
    request.destroy();
  });
}

test('control RPC rejects non-POST, malformed JSON and requests over one MiB', async t => {
  const host = await harness(t);
  assert.equal((await host.request('/agentkit', undefined, 'GET')).status, 404);
  const malformed = await host.request('/agentkit', '{');
  assert.equal(malformed.status, 400);
  const envelope = await malformed.json();
  assert.equal(envelope.type, 'server-response'); assert.equal(envelope.rpcId, '');
  assert.equal(envelope.result.error.code, 'agentkit/bad-request');
  const oversized = await host.request('/agentkit', 'x'.repeat(1024 * 1024 + 1));
  assert.equal(oversized.status, 413);
  assert.equal(await oversized.text(), 'request too large');
  assert.equal(host.calls.length, 0);
});

test('only the exact authenticated attachment RPC ingress accepts large uploads', async t => {
  const host = await harness(t);
  const payload = { agentId: 'fixture', operation: 'attachment-upload', input: {
    kind: 'file', name: 'large.txt', data: Buffer.alloc(800 * 1024, 97).toString('base64'),
  } };
  const message = { method: 'assistant/execute', rpcId: 'upload', payload };
  const body = JSON.stringify(message);
  for (const path of ['/agentkit/assistant/execute', ASSISTANT_UPLOAD_RPC_PATH + '/other', ASSISTANT_UPLOAD_RPC_PATH + '?large=true']) {
    assert.equal((await host.request(path, body)).status, 413);
  }
  assert.equal(host.calls.length, 0);
  const response = await host.request(ASSISTANT_UPLOAD_RPC_PATH, body);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).rpcId, 'upload');
  assert.deepEqual(host.calls[0].slice(0, 2), ['assistant/execute', payload]);
  for (const invalid of [{ ...message, method: 'agents/list' }, { ...message, payload: { ...payload, operation: 'submit' } }]) {
    assert.equal((await host.request(ASSISTANT_UPLOAD_RPC_PATH, JSON.stringify(invalid))).status, 400);
  }
  assert.equal((await host.request(ASSISTANT_UPLOAD_RPC_PATH, 'x'.repeat(ASSISTANT_UPLOAD_RPC_BODY_BYTES + 1))).status, 413);
  assert.equal(host.calls.length, 1);
});

for (const status of [401, 403]) {
  test(`attachment ingress preserves admission ${status} before parsing`, async t => {
    const host = await harness(t, { admit: () => ({ rejection: status }) });
    assert.equal((await host.request(ASSISTANT_UPLOAD_RPC_PATH, '{malformed')).status, status);
    assert.equal(host.calls.length, 0);
  });
}

test('cloud SSE keeps action input, incremental bytes and cancellation signal', async t => {
  let received;
  const host = await harness(t, { serverClient: { streamAction: async (...args) => {
    received = args;
    return { body: (async function* () { yield 'data: one\n\n'; yield 'data: two\n\n'; })() };
  } } });
  const response = await host.request('/agentkit/cloud-conversation', JSON.stringify({
    agentId: ' agent-fixture ', sessionId: ' session-fixture ',
    input: { inputId: 'input-fixture', parts: [{ kind: 'text', text: 'one' }, { kind: 'text', text: 'two' }] },
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  assert.equal(await response.text(), 'data: one\n\ndata: two\n\n');
  assert.deepEqual(received.slice(0, 2), ['RunAgent', {
    AgentId: 'agent-fixture', SessionId: 'session-fixture', Messages: [{ role: 'user', content: 'onetwo' }],
    Stream: true, ApiFormat: 'responses', InvocationId: 'input-fixture',
  }]);
  assert.equal(received[2].signal.aborted, false);
});

test('cloud SSE retains invalid-input and method responses', async t => {
  const host = await harness(t);
  assert.equal((await host.request('/agentkit/cloud-conversation', undefined, 'GET')).status, 404);
  const invalid = await host.request('/agentkit/cloud-conversation', '{}');
  assert.equal(invalid.status, 502);
  assert.equal((await invalid.json()).error.code, 'INVALID_CONVERSATION_INPUT');
});

for (const path of ['/agentkit/cloud-conversation', '/agentkit/local-conversation']) {
  test(`${path} cancels upstream work when the HTTP consumer disconnects`, { timeout: 5000 }, async t => {
    let resolveAbort;
    const aborted = new Promise(resolve => { resolveAbort = resolve; });
    async function* stream(signal) {
      yield 'data: started\n\n';
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => {
        resolveAbort(); reject(Object.assign(new Error('fixture abort'), { name: 'AbortError' }));
      }, { once: true }));
    }
    const host = await harness(t, {
      serverClient: { streamAction: async (_action, _body, { signal }) => ({ body: stream(signal) }) },
      getLegacyLocalConversationHandler: async () => async (_request, response, { signal }) => {
        for await (const part of stream(signal)) response.write(part);
        response.end();
      },
    });
    // The controlled legacy handler rejects when cancelled; the real adapter
    // intentionally suppresses that diagnostic after the response is destroyed.
    t.mock.method(console, 'error', () => {});
    const request = httpRequest(host.base + path, { method: 'POST' });
    request.on('error', () => {});
    request.end(JSON.stringify({ agentId: 'fixture', sessionId: 'fixture', input: 'fixture' }));
    const [response] = await once(request, 'response');
    await once(response, 'data'); response.destroy();
    await aborted;
  });
}

test('legacy local route constructs its handler per request with the Host signal', async t => {
  let constructions = 0;
  const signals = [];
  const host = await harness(t, { getLegacyLocalConversationHandler: async () => {
    constructions++;
    return async (_request, response, { signal }) => { signals.push(signal); response.end('fixture'); };
  } });
  for (let index = 0; index < 2; index++) {
    assert.equal(await (await host.request('/agentkit/local-conversation', '{}')).text(), 'fixture');
  }
  assert.equal(constructions, 2);
  assert.notEqual(signals[0], signals[1]);
  assert.ok(signals.every(signal => !signal.aborted));
});

for (const path of ['/agentkit/cloud-conversation', '/agentkit/local-conversation']) {
  test(`${path} cancels owned upstream work when its registration scope unloads`, async t => {
    let resolveAbort;
    const aborted = new Promise(resolve => { resolveAbort = resolve; });
    async function* stream(signal) {
      yield 'data: started\n\n';
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => {
        resolveAbort(true); reject(new Error('fixture abort'));
      }, { once: true }));
    }
    const host = await harness(t, {
      serverClient: { streamAction: async (_action, _body, { signal }) => ({ body: stream(signal) }) },
      getLegacyLocalConversationHandler: async () => async (_request, response, { signal }) => {
        for await (const part of stream(signal)) response.write(part);
        response.end();
      },
    });
    t.mock.method(console, 'error', () => {});
    const request = httpRequest(host.base + path, { method: 'POST' }); request.on('error', () => {});
    request.end(JSON.stringify({ agentId: 'fixture', sessionId: 'fixture', input: 'fixture' }));
    const [response] = await once(request, 'response'); await once(response, 'data');
    host.unload();
    assert.equal(await Promise.race([aborted, new Promise(resolve => setTimeout(() => resolve(false), 80))]), true, 'scope teardown must cancel work while the client is still connected');
    response.destroy();
  });
}

test('Connection Fetch download keeps GET/HEAD registration and late portable ownership', async () => {
  const { registerBuildDownload } = await import('../src/host/routes/download.mjs');
  let registered, portableReads = 0;
  const calls = [];
  const artifact = { filename: 'fixture.zip', base64: Buffer.from('zip-fixture').toString('base64'), bytes: 11, contentType: 'application/zip' };
  const ctx = { connection: { fetch: { register: spec => { registered = spec; } } } };
  await registerBuildDownload(ctx, {
    studioBuildPromise: Promise.resolve({ build: { download: async (...args) => { calls.push(['build', ...args]); return artifact; } } }),
    getPortableBundles: () => { portableReads++; return { download: async (...args) => { calls.push(['portable', ...args]); return artifact; } }; },
  });
  assert.equal(registered.path, '/api/agentkit.build.download');
  assert.deepEqual(registered.methods, ['GET', 'HEAD']); assert.equal(registered.requestBody, 'buffered');
  assert.equal(portableReads, 0);
  const url = 'http://localhost/api/agentkit.build.download?agentId=fixture&buildId=build_aaaaaaaaaaaaaaaaaaaa';
  const get = await registered.fetch(new Request(url));
  assert.equal(await get.text(), 'zip-fixture');
  const head = await registered.fetch(new Request(url + '&bundleId=portable-fixture', { method: 'HEAD' }));
  assert.equal(await head.text(), ''); assert.equal(head.headers.get('content-length'), '11');
  assert.equal(portableReads, 1);
  assert.deepEqual(calls, [['build', 'fixture', 'build_aaaaaaaaaaaaaaaaaaaa'], ['portable', 'fixture', 'build_aaaaaaaaaaaaaaaaaaaa', 'portable-fixture']]);
});
