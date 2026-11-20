import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { probeModelWire, probeModelWires } from '../src/model-wire-probe.mjs';

/** Serve one canned status per model id so a batch can mix outcomes. */
async function gateway(statusFor) {
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      requests.push({ url: request.url, headers: request.headers, body: parsed });
      const status = statusFor(parsed.model);
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(status === 200 ? { id: 'resp_probe', status: 'completed', output: [] } : { error: { message: 'no' } }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

test('a gateway that answers the route speaks Responses', async () => {
  const server = await gateway(() => 200);
  try {
    const wire = await probeModelWire({ baseUrl: server.baseUrl, apiKey: 'sk-probe', modelName: 'kimi-k3.1-pro' });
    assert.equal(wire, 'openai-responses');
    // The probe uses a small legal budget and authenticates via the bearer header.
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0].url, '/v1/responses');
    assert.equal(server.requests[0].headers.authorization, 'Bearer sk-probe');
    assert.deepEqual(server.requests[0].body, {
      model: 'kimi-k3.1-pro',
      max_output_tokens: 32,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'OK' }] }],
    });
  } finally { await server.close(); }
});

test('only a 404 proves the gateway is Chat-only', async () => {
  const server = await gateway(() => 404);
  try {
    assert.equal(await probeModelWire({ baseUrl: server.baseUrl, apiKey: 'sk', modelName: 'qwen3.8-max' }), 'openai-completions');
  } finally { await server.close(); }
});

test('a rejected request proves nothing and stays unknown', async () => {
  // 400/401/429/500 all mean "the route may exist, but this model did not
  // answer" — promoting any of them to a wire would write a guess into a profile.
  for (const status of [400, 401, 403, 429, 500, 503]) {
    const server = await gateway(() => status);
    try {
      assert.equal(await probeModelWire({ baseUrl: server.baseUrl, apiKey: 'sk', modelName: 'm' }), 'unknown', String(status));
    } finally { await server.close(); }
  }
});

test('an unreachable or malformed gateway never rejects the caller', async () => {
  assert.equal(await probeModelWire({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk', modelName: 'm' }), 'unknown');
  assert.equal(await probeModelWire({ baseUrl: 'not a url', apiKey: 'sk', modelName: 'm' }), 'unknown');
  assert.equal(await probeModelWire({ baseUrl: 'ftp://example/v1', apiKey: 'sk', modelName: 'm' }), 'unknown');
  assert.equal(await probeModelWire({ baseUrl: '', apiKey: 'sk', modelName: 'm' }), 'unknown');
  assert.equal(await probeModelWire({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk', modelName: '' }), 'unknown');
});

test('a gateway that never answers is bounded by the probe deadline', async () => {
  const server = createServer(() => { /* never respond */ });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const started = Date.now();
    const wire = await probeModelWire({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'sk', modelName: 'm', timeoutMs: 150 });
    assert.equal(wire, 'unknown');
    assert.ok(Date.now() - started < 3000, 'the probe deadline must bound a silent gateway');
  } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
});

test('a configured request header reaches the probe, so a header-gated gateway can be read', async () => {
  const server = await gateway(() => 200);
  try {
    await probeModelWire({ baseUrl: server.baseUrl, apiKey: 'sk', modelName: 'm', headers: { 'x-company-name': 'studio' } });
    assert.equal(server.requests[0].headers['x-company-name'], 'studio');
  } finally { await server.close(); }
});

test('a batch preserves input order, deduplicates, and keeps per-model outcomes', async () => {
  const server = await gateway(model => (model === 'chat-only' ? 404 : 200));
  try {
    const rows = await probeModelWires({ baseUrl: server.baseUrl, apiKey: 'sk', models: ['responses-model', 'chat-only', 'responses-model', '  '] });
    assert.deepEqual(rows, [
      { modelName: 'responses-model', wire: 'openai-responses' },
      { modelName: 'chat-only', wire: 'openai-completions' },
    ]);
  } finally { await server.close(); }
});
