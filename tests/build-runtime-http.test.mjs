import test from 'node:test';
import assert from 'node:assert/strict';
import { startBuildRuntimeHttp } from '../src/build-runtime-http.mjs';
import { readSse } from '../src/sse.mjs';
import { observeNativeRun } from '../src/frozen-build-runtime.mjs';

const token = 'runtime-test-token-with-at-least-24-characters';
const buildId = 'build_0123456789abcdef0123';
async function setup(t, runner) {
  const server = await startBuildRuntimeHttp({ agentId: 'ar-local-test', buildId, token, runner, port: 0 });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address.port}`;
  const post = (value, path = '/runs', headers = {}) => fetch(base + path, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify(value) });
  return { base, post };
}

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
  assert.deepEqual(frames.map(frame => frame.kind), ['assistant', 'event']);
  stop(); assert.equal(listeners.size, 0);
});
