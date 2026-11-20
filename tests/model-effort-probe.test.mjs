import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { diagnoseModelEfforts, probeModelEfforts } from '../src/model-effort-probe.mjs';

/** Serve one canned reply per request and record what was sent. */
async function gateway(replyFor) {
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      requests.push({ url: request.url, body: parsed, authorization: request.headers.authorization });
      const { status, payload } = replyFor(parsed);
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(payload ?? {}));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

const OK = { status: 200, payload: { id: 'resp', output: [] } };

test('a 2xx is the only signal that a level is accepted', async () => {
  const server = await gateway(() => OK);
  try {
    const rows = await probeModelEfforts({ baseUrl: server.baseUrl, apiKey: 'sk', modelName: 'kimi-k3.1-pro', levels: ['low', 'xhigh'], wire: 'openai-responses' });
    assert.deepEqual(rows, [{ level: 'low', outcome: 'accepted' }, { level: 'xhigh', outcome: 'accepted' }]);
    // The Responses wire names the level under `reasoning.effort`.
    assert.deepEqual(server.requests[1].body.reasoning, { effort: 'xhigh' });
    assert.equal(server.requests[1].url, '/v1/responses');
    assert.equal(server.requests[1].authorization, 'Bearer sk');
  } finally { await server.close(); }
});

test('the Chat wire names the level under reasoning_effort', async () => {
  const server = await gateway(() => OK);
  try {
    await probeModelEfforts({ baseUrl: server.baseUrl, apiKey: 'sk', modelName: 'm', levels: ['high'], wire: 'openai-chat' });
    assert.equal(server.requests[0].url, '/v1/chat/completions');
    assert.equal(server.requests[0].body.reasoning_effort, 'high');
    assert.equal('reasoning' in server.requests[0].body, false);
  } finally { await server.close(); }
});

test('only a 4xx that names the effort is a rejection', async () => {
  const cases = [
    [400, { error: { message: '***.effort value "minimal" is not supported' } }, 'rejected'],
    [400, { error: { message: '模型 glm-5.3 不支持关闭思考模式，请移除或修正思考关闭参数（reasoning.effort=minimal）' } }, 'rejected'],
    [422, { error: { message: 'invalid reasoning_effort' } }, 'rejected'],
    // A 400 about some other field says nothing about the level.
    [400, { error: { message: 'max_output_tokens must be positive' } }, 'unknown'],
    [404, { error: { message: 'not found' } }, 'unknown'],
    [429, { error: { message: 'rate limited' } }, 'unknown'],
    [500, { error: { message: 'effort exploded' } }, 'unknown'],
    [503, { error: { message: 'unavailable' } }, 'unknown'],
  ];
  for (const [status, payload, expected] of cases) {
    const server = await gateway(() => ({ status, payload }));
    try {
      const rows = await probeModelEfforts({ baseUrl: server.baseUrl, apiKey: 'sk', modelName: 'm', levels: ['minimal'] });
      assert.equal(rows[0].outcome, expected, `${status} ${JSON.stringify(payload)}`);
    } finally { await server.close(); }
  }
});

test('an unreachable or malformed gateway never rejects the caller', async () => {
  for (const options of [
    { baseUrl: 'http://127.0.0.1:1/v1', modelName: 'm', levels: ['low'] },
    { baseUrl: 'not a url', modelName: 'm', levels: ['low'] },
    { baseUrl: 'ftp://example/v1', modelName: 'm', levels: ['low'] },
    { baseUrl: '', modelName: 'm', levels: ['low'] },
    { baseUrl: 'http://127.0.0.1:1/v1', modelName: '', levels: ['low'] },
    { baseUrl: 'http://127.0.0.1:1/v1', modelName: 'm', levels: [] },
  ]) {
    const rows = await probeModelEfforts({ ...options, apiKey: 'sk' });
    assert.ok(rows.every(row => row.outcome === 'unknown'), JSON.stringify(options));
  }
});

test('a silent gateway is bounded by the probe deadline', async () => {
  const server = createServer(() => { /* never respond */ });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const started = Date.now();
    const rows = await probeModelEfforts({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'sk', modelName: 'm', levels: ['low'], timeoutMs: 150 });
    assert.equal(rows[0].outcome, 'unknown');
    assert.ok(Date.now() - started < 3000, 'the probe deadline must bound a silent gateway');
  } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
});

test('a batch probes serially, deduplicates, and preserves input order', async () => {
  const server = await gateway(body => (body.reasoning?.effort === 'max' ? { status: 400, payload: { error: { message: 'effort value "max" is not supported' } } } : OK));
  try {
    const rows = await probeModelEfforts({ baseUrl: server.baseUrl, apiKey: 'sk', modelName: 'm', levels: ['max', 'low', 'max', '  '], wire: 'openai-responses' });
    assert.deepEqual(rows, [{ level: 'max', outcome: 'rejected' }, { level: 'low', outcome: 'accepted' }]);
    // Serial, so the gateway sees exactly the planned probes in order.
    assert.deepEqual(server.requests.map(request => request.body.reasoning.effort), ['max', 'low']);
  } finally { await server.close(); }
});

test('a rejected control distinguishes accepted, failed, and rejected effort requests', async () => {
  const server = await gateway(({ reasoning_effort: level }) => {
    if (level === 'low' || level === 'max') return { status: 200, payload: { choices: [{ message: { content: 'OK' } }] } };
    if (level === 'medium') return { status: 200, payload: { error: { message: 'Inference failed' } } };
    return { status: 400, payload: { error: { message: 'Unsupported reasoning_effort' } } };
  });
  try {
    const diagnosis = await diagnoseModelEfforts({ baseUrl: server.baseUrl, apiKey: 'fixture', modelName: 'm', levels: ['low', 'medium', 'high', 'max'] });
    assert.deepEqual(diagnosis, { control: 'rejected', outcomes: [
      { level: 'low', outcome: 'accepted' }, { level: 'medium', outcome: 'unknown' },
      { level: 'high', outcome: 'rejected' }, { level: 'max', outcome: 'accepted' },
    ] });
    assert.deepEqual(server.requests.slice(1).map(request => request.body.reasoning_effort), ['low', 'medium', 'high', 'max']);
  } finally { await server.close(); }
});

test('diagnostics stay inconclusive when the gateway silently ignores the requested effort', async () => {
  const server = await gateway(() => ({ status: 200, payload: { choices: [{ message: { content: 'OK' } }], reasoning_effort: 'high' } }));
  try {
    assert.deepEqual((await diagnoseModelEfforts({ baseUrl: server.baseUrl, modelName: 'm', levels: ['low', 'high'] })).outcomes,
      [{ level: 'low', outcome: 'unknown' }, { level: 'high', outcome: 'unknown' }]);
  } finally { await server.close(); }
});

test('an independently returned effective effort confirms only the matching request', async () => {
  const server = await gateway(({ reasoning }) => ({
    status: 200, payload: { reasoning: { effort: reasoning.effort === 'high' ? 'high' : 'medium' }, output: [] },
  }));
  try {
    assert.deepEqual((await diagnoseModelEfforts({ baseUrl: server.baseUrl, modelName: 'm', wire: 'openai-responses', levels: ['low', 'high'] })).outcomes,
      [{ level: 'low', outcome: 'unknown' }, { level: 'high', outcome: 'confirmed' }]);
  } finally { await server.close(); }
});

test('credential failures stop the control and mark planned efforts as untested', async () => {
  const server = await gateway(() => ({ status: 401, payload: { error: { message: 'Invalid API key' } } }));
  try {
    assert.deepEqual(await diagnoseModelEfforts({ baseUrl: server.baseUrl, modelName: 'm', levels: ['low', 'high'] }),
      { control: 'inconclusive', outcomes: [{ level: 'low', outcome: 'untested' }, { level: 'high', outcome: 'untested' }] });
    assert.equal(server.requests.length, 1);
  } finally { await server.close(); }
});

test('a total deadline marks the in-flight effort as timed out and later efforts as untested', async () => {
  const diagnosis = await diagnoseModelEfforts({
    baseUrl: 'https://gateway.test/v1', modelName: 'm', levels: ['low', 'high', 'max'], budgetMs: 100, timeoutMs: 500,
    fetchImpl: async (_url, { body, signal }) => {
      const { reasoning_effort: level } = JSON.parse(body);
      if (level === 'low') return Response.json({ choices: [{ message: { content: 'OK' } }] });
      if (level !== 'high') return Response.json({ error: { message: 'Invalid reasoning_effort' } }, { status: 400 });
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  });
  assert.deepEqual(diagnosis, { control: 'rejected', outcomes: [
    { level: 'low', outcome: 'accepted' }, { level: 'high', outcome: 'timeout' }, { level: 'max', outcome: 'untested' },
  ] });
});
