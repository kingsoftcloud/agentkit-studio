import test from 'node:test';
import assert from 'node:assert/strict';
import { startBuildRuntimeHttp } from '../src/build-runtime-http.mjs';
import { readSse } from '../src/sse.mjs';
import { observeNativeRun } from '../src/frozen-build-runtime.mjs';

const token = 'runtime-test-token-with-at-least-24-characters';
const buildId = 'build_0123456789abcdef0123';
async function setup(t, runner, options = {}) {
  const server = await startBuildRuntimeHttp({ agentId: 'ar-local-test', buildId, token, runner, port: 0, ...options });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address.port}`;
  const post = (value, path = '/runs', headers = {}) => fetch(base + path, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify(value) });
  return { base, post };
}

test('runtime logs correlate a streamed run without delaying deltas or exposing content', async t => {
  const logs = [];
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const { post } = await setup(t, async request => {
    request.onFrame({ kind: 'assistant', value: { type: 'chunk', chunk: { type: 'text-delta', text: 'private-answer' } } });
    await gate;
    return { output: 'private-answer' };
  }, { runLog: entry => logs.push(entry) });
  t.after(() => finish());
  const response = await post({ input: 'private-prompt', sessionId: 'session-log', requestId: 'invocation-log', stream: true });
  const events = readSse(response.body)[Symbol.asyncIterator]();
  await events.next();
  assert.equal((await events.next()).value.chunk.text, 'private-answer');
  assert.deepEqual(logs.map(entry => entry.event), ['runtime.run.started']);
  finish();
  await events.next();
  assert.equal((await events.next()).done, true);
  assert.deepEqual(logs.map(entry => entry.event), ['runtime.run.started', 'runtime.run.completed']);
  for (const entry of logs) {
    assert.equal(entry.agentId, 'ar-local-test');
    assert.equal(entry.buildId, buildId);
    assert.equal(entry.sessionId, 'session-log');
    assert.equal(entry.invocationId, 'invocation-log');
    assert.match(entry.runId, /^run_/);
    assert.ok(Number.isFinite(Date.parse(entry.at)));
  }
  assert.ok(logs[1].durationMs >= 0);
  assert(!JSON.stringify(logs).includes('private-'));
  assert(!JSON.stringify(logs).includes(token));
});

test('failed and cancelled runs log a single safe terminal outcome', async t => {
  for (const cancelled of [false, true]) {
    const logs = [];
    const { post } = await setup(t, request => {
      if (!cancelled) throw new Error('private-upstream-token and raw response');
      return new Promise((resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }));
    }, { runLog: entry => logs.push(entry) });
    const response = await post({ input: 'private-prompt', requestId: 'outcome-log', stream: true });
    const events = readSse(response.body)[Symbol.asyncIterator]();
    const first = (await events.next()).value;
    if (cancelled) assert.equal((await post({}, `/runs/${first.runId}/cancel`)).status, 202);
    await events.next();
    assert.equal((await events.next()).done, true);
    assert.deepEqual(logs.map(entry => entry.event),
      ['runtime.run.started', cancelled ? 'runtime.run.cancelled' : 'runtime.run.failed']);
    assert.equal(logs[1].code, cancelled ? 'RUNTIME_CANCELLED' : 'RUNTIME_RUN_FAILED');
    assert(!JSON.stringify(logs).includes('private-'));
  }
});

test('a failed log sink cannot fail or repeat a successful run', async t => {
  let runs = 0, attempts = 0;
  const { post } = await setup(t, async () => { runs++; return { output: 'ok' }; },
    { runLog: () => { attempts++; throw Error('fixture log sink unavailable'); } });
  const response = await post({ input: 'hello', requestId: 'sink-failure' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).output, 'ok');
  assert.equal(runs, 1);
  assert.equal(attempts, 2);
});

test('HTTP authentication, scope and malformed input cannot start a run', async t => {
  let calls = 0;
  const { post, base } = await setup(t, async () => { calls++; return {}; });
  assert.equal((await fetch(base + '/health')).status, 200);
  const request = { input: 'hello', requestId: 'one' };
  assert.equal((await post(request, '/runs', { authorization: 'Bearer invalid' })).status, 401);
  assert.equal((await post(request, '/runs', { authorization: token })).status, 401);
  assert.equal((await post(request, '/runs', { origin: 'http://localhost' })).status, 401);
  assert.equal((await post({ ...request, agentId: 'another-agent' })).status, 400);
  assert.equal((await post({ ...request, requestId: '../bad' })).status, 400);
  assert.equal((await post({ ...request, input: 'x'.repeat(256 * 1024) })).status, 413);
  assert.equal(calls, 0);
});

test('runtime failures do not expose upstream messages or credentials', async t => {
  const { post } = await setup(t, async () => { throw new Error('Authorization: Bearer private-upstream-token'); });
  const response = await post({ input: 'hello', requestId: 'one' });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: { code: 'RUNTIME_RUN_FAILED' } });
});

test('a runner resolving after cancellation cannot turn a cancelled request into success', async t => {
  const { post } = await setup(t, request => new Promise(resolve => {
    request.signal.addEventListener('abort', () => resolve({ output: 'late output' }), { once: true });
  }));
  const response = await post({ input: 'wait', requestId: 'late', stream: true });
  const events = readSse(response.body)[Symbol.asyncIterator]();
  const { runId } = (await events.next()).value;
  assert.equal((await post({}, `/runs/${runId}/cancel`)).status, 202);
  assert.equal((await events.next()).value.error.code, 'RUNTIME_CANCELLED');
  assert.equal((await events.next()).done, true);
});

test('HTTP streams real-time native attempts before final completion and isolates session IDs', async t => {
  let finish, observed;
  const gate = new Promise(resolve => { finish = resolve; });
  const { post } = await setup(t, async request => {
    observed = request;
    request.onFrame({ kind: 'assistant', value: { type: 'chunk', attemptId: 'attempt-1', chunk: { type: 'text-delta', text: 'partial' } } });
    await gate;
    return { output: 'final', sessionId: request.sessionId };
  });
  const response = await post({ input: 'hello', sessionId: 'native-user-session', requestId: 'one', stream: true });
  const events = readSse(response.body)[Symbol.asyncIterator]();
  const started = (await events.next()).value;
  assert.equal(started.event, 'run.started');
  assert.equal(started.buildId, buildId);
  assert.notEqual(observed.sessionId, 'native-user-session');
  const partial = (await events.next()).value;
  assert.equal(partial.event, 'dsh.assistant');
  assert.equal(partial.chunk.text, 'partial');
  finish();
  assert.equal((await events.next()).value.output, 'final');
  assert.equal((await events.next()).done, true);
});

test('explicit cancel aborts the native request and never emits completion', async t => {
  let cancelled = false;
  const { post } = await setup(t, request => new Promise((resolve, reject) => {
    request.signal.addEventListener('abort', () => { cancelled = true; reject(request.signal.reason); }, { once: true });
  }));
  const response = await post({ input: 'wait', requestId: 'cancel-me', stream: true });
  const events = readSse(response.body)[Symbol.asyncIterator]();
  const { runId } = (await events.next()).value;
  assert.equal((await post({}, `/runs/${runId}/cancel`)).status, 202);
  const terminal = (await events.next()).value;
  assert.equal(terminal.event, 'run.failed');
  assert.equal(terminal.error.code, 'RUNTIME_CANCELLED');
  assert.equal(cancelled, true);
  assert.equal((await events.next()).done, true);
});

test('duplicate active request is rejected; client disconnect aborts running work', async t => {
  let aborted; const stopped = new Promise(resolve => { aborted = resolve; });
  const { post } = await setup(t, request => new Promise((resolve, reject) => {
    request.signal.addEventListener('abort', () => { aborted(); reject(request.signal.reason); }, { once: true });
  }));
  const request = { input: 'hello', requestId: 'same', stream: true };
  const response = await post(request);
  assert.equal((await post(request)).status, 409);
  await response.body.cancel();
  await stopped;
});

test('observer forwards only the exact native Agent and disposes both listeners', () => {
  const listeners = new Map();
  const ctx = { on(name, callback) { listeners.set(name, callback); return () => listeners.delete(name); } };
  const agent = { session: {} }, frames = [];
  const stop = observeNativeRun(ctx, agent, frame => frames.push(frame));
  listeners.get('agent/assistant-stream')({ agent: {}, frame: { type: 'chunk' } });
  listeners.get('session/event')({}, { type: 'tool/result' });
  assert.equal(frames.length, 0);
  listeners.get('agent/assistant-stream')({ agent, frame: { type: 'start', attemptId: 'one' } });
  listeners.get('session/event')(agent.session, { type: 'tool/call' });
  listeners.get('session/event')(agent.session, { type: 'agentkit/codex-tool' });
  assert.deepEqual(frames.map(frame => frame.kind), ['assistant', 'event', 'event']);
  stop(); assert.equal(listeners.size, 0);
});

test('authenticated version probe reports the serving bundle without starting a model or session', async t => {
  const bundleSha256 = 'a'.repeat(64);
  const server = await startBuildRuntimeHttp({ agentId: 'ar-local-test', buildId, bundleSha256, token,
    runner: () => assert.fail('probe must not invoke model'), port: 0 });
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address.port}/v1/agentkit/runtime`;
  assert.equal((await fetch(url)).status, 401);
  const body = await (await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(body.format, 'agentkit.runtime-identity/v1');
  assert.equal(body.buildId, buildId); assert.equal(body.bundleSha256, bundleSha256);
  assert(!JSON.stringify(body).includes(token));
});

test('conversation execution modes are declared, narrowed by the ceiling and validated per request', async t => {
  const modes = [], requestIds = ['req-one', 'req-two', 'req-three', 'req-four'];
  const server = await startBuildRuntimeHttp({ agentId: 'ar-local-test', buildId, token,
    executionPolicy: { format: 'agentkit.execution-policy/v1', permissionMode: 'workspace-write', approvalPolicy: 'never', approvalSource: 'runtime-policy' },
    executionPolicyMax: 'workspace-write',
    runner: async request => { modes.push(request.permissionMode); return {}; }, port: 0 });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address.port}`;
  const identity = await (await fetch(base + '/v1/agentkit/runtime', { headers: { authorization: `Bearer ${token}` } })).json();
  assert.deepEqual(identity.allowedPermissionModes, ['read-only', 'workspace-write']);
  assert.equal(identity.capabilities.includes('cloud-execution-policy/v1'), true);
  const post = mode => fetch(base + '/runs', { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(mode ? { 'x-agentkit-permission-mode': mode } : {}) },
    body: JSON.stringify({ input: 'hi', requestId: requestIds.shift() }) });
  assert.equal((await post('danger-full-access')).status, 403);
  assert.equal((await post('unconfined')).status, 400);
  assert.equal((await post('read-only')).status, 200);
  assert.equal((await post()).status, 200);
  assert.deepEqual(modes, ['read-only', 'workspace-write']);
});

test('a failed settlement cannot hide the original run failure', async t => {
  const logs = [];
  const originalFailure = Object.assign(new Error('model gateway unavailable'),
    { code: 'MODEL_UPSTREAM_UNAVAILABLE', status: 502 });
  const settlementFailure = Object.assign(new Error('request absent from native history'),
    { code: 'CHANNEL_REQUEST_NOT_FOUND' });
  const platformActions = {
    setRunControl() {},
    async checkRun() {},
    async flushRun() {},
    async settleRun() { throw settlementFailure; },
    async parseResponses() {
      return { input: 'hello', sessionId: 'native-session', requestId: 'req-settlement',
        stream: true, runId: 'run_settlement_fixture', model: 'model', responseId: 'resp_settlement',
        createdAt: Date.now(), conversationId: 'conv-settlement', publicSessionId: 'public-session',
        platformSession: { sessionId: 'public-session', nativeSessionId: 'native-session' }, metadata: {} };
    },
  };
  const { post } = await setup(t, async () => { throw originalFailure; },
    { platformActions, runLog: entry => logs.push(entry) });
  const response = await post({ input: 'hello' });
  assert.equal(response.status, 200);
  const events = [];
  for await (const event of readSse(response.body)) events.push(event);
  const failed = events.find(event => event.type === 'response.failed');
  assert.ok(failed, 'expected a failed response event');
  assert.equal(failed.response.error.code, 'MODEL_UPSTREAM_UNAVAILABLE');
  assert.deepEqual(logs.map(entry => entry.event), ['runtime.run.started', 'runtime.run.failed']);
  assert.equal(logs[1].code, 'MODEL_UPSTREAM_UNAVAILABLE');
  assert.equal(logs[1].settlementCode, 'CHANNEL_REQUEST_NOT_FOUND');
});
