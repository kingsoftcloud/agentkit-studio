import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrozenResponseProjection, FROZEN_RESPONSE_PROJECTION_EVENT } from '../src/frozen-response-projection.mjs';
import { createRuntimeResponsesContract, runtimeResponse } from '../src/runtime-responses-contract.mjs';
import { startBuildRuntimeHttp } from '../src/build-runtime-http.mjs';
import { readSse } from '../src/sse.mjs';

const agentId = 'projection-agent', buildId = 'build_0123456789abcdef0123', token = 'projection-private-runtime-token';
const payload = { input: 'inspect', session_id: 'conversation', request_id: 'once', model: 'fixed' };
const contract = createRuntimeResponsesContract({ agentId, buildId, token, model: 'fixed', models: ['fixed'] });
const request = { ...contract.parse(payload, {}), agentId, buildId };
const response = runtimeResponse(request, { output: 'done' }, 'completed');
const events = [{ type: 'response.tool_result', data: { call_id: 'call', output: [{ type: 'text', text: 'result' }], is_error: false } }];
const signal = () => new AbortController().signal;
function fixture() {
  const rows = []; let flush = async () => true;
  const session = { id: request.sessionId, snapshotEvents: () => rows, append: (type, data, options) => {
    assert.deepEqual(options, { ignorable: true }); rows.push({ seq: rows.length, type, data, ...options });
  } };
  const services = { sessionController: { projections: async () => ({}), resolveAgent: async () => ({ agent: { session } }) },
    sessions: { flush: value => { assert.equal(value, session); return flush(); } } };
  return { rows, session, services, setFlush: value => { flush = value; },
    create: () => createFrozenResponseProjection({ getService: name => services[name] }) };
}

test('a cold presentation reuses its full original response and tool results without overwriting or aliasing them', async () => {
  const f = fixture(), first = f.create();
  assert.equal(await first.load(request, signal()), null);
  const saved = await first.save(request, response, events, signal());
  assert.equal(f.rows.length, 1); assert.equal(f.rows[0].type, FROZEN_RESPONSE_PROJECTION_EVENT);
  saved.response.created_at = 0; saved.events[0].data.output[0].text = 'mutated';
  const cold = f.create();
  assert.deepEqual(await cold.load(request, signal()), { response, events });
  const replacement = { ...response, created_at: response.created_at + 10 };
  assert.deepEqual(await cold.save(request, replacement, [], signal()), { response, events });
  assert.equal(f.rows.length, 1);
});

test('conflicting input, malformed presentation, and duplicate records cannot reset a completed response', async () => {
  const f = fixture(); await f.create().save(request, response, events, signal());
  await assert.rejects(f.create().load({ ...request, input: 'different' }, signal()), { code: 'RUNTIME_REQUEST_CONFLICT' });
  const original = structuredClone(f.rows[0]);
  f.rows[0].data.events.push({ type: 'execute-tool', data: {} });
  await assert.rejects(f.create().load(request, signal()), { code: 'RESPONSES_PROJECTION_INVALID' });
  f.rows.splice(0, 1, original, structuredClone(original));
  await assert.rejects(f.create().load(request, signal()), { code: 'RESPONSES_PROJECTION_INVALID' });
  assert.equal(f.rows.length, 2);
});

test('success requires a durable flush, including retry of an appended but unflushed projection', async () => {
  const f = fixture(); let flushes = 0;
  f.setFlush(async () => { flushes++; return false; });
  await assert.rejects(f.create().save(request, response, events, signal()), { code: 'RESPONSES_PROJECTION_NOT_DURABLE' });
  assert.equal(f.rows.length, 1);
  f.setFlush(async () => { flushes++; return true; });
  assert.deepEqual(await f.create().save(request, { ...response, created_at: 0 }, [], signal()), { response, events });
  assert.equal(flushes, 2); assert.equal(f.rows.length, 1);
  delete f.services.sessions;
  await assert.rejects(f.create().save(request, response, events, signal()), { code: 'RESPONSES_PROJECTION_PERSISTENCE_UNAVAILABLE' });
});

test('cancel during an uncooperative flush rejects promptly and observes its late rejection', async () => {
  const f = fixture(), abort = new AbortController(); let rejectFlush, entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.setFlush(() => { entered(); return new Promise((_, reject) => { rejectFlush = reject; }); });
  const saving = f.create().save(request, response, events, abort.signal);
  await started; abort.abort(Object.assign(new Error('cancel'), { code: 'RUNTIME_CANCELLED' }));
  await assert.rejects(saving, { code: 'RUNTIME_CANCELLED' });
  rejectFlush(new Error('late persistence rejection'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.rows.length, 1);
});

test('HTTP completion waits for the Session flush; warm and cold SSE replay preserve every delivery fact', async t => {
  const f = fixture(); let resolveFlush, entered, turns = 0, validations = 0;
  const started = new Promise(resolve => { entered = resolve; });
  f.setFlush(() => { entered(); return new Promise(resolve => { resolveFlush = resolve; }); });
  const runner = async req => {
    if (req.requireReplay) { validations++; return { output: 'done' }; }
    turns++;
    for (const [callId, isError] of [['ok', false], ['denied', true]]) {
      req.onFrame({ kind: 'event', value: { type: 'tool/call', data: { callId, name: 'inspect', arguments: '{}' } } });
      req.onFrame({ kind: 'event', value: { type: 'tool/result', data: { message: {
        source: { callId }, content: [{ type: 'text', text: isError ? 'denied' : 'result' }], isError } } } });
    }
    req.onFrame({ kind: 'assistant', value: { type: 'chunk', attemptId: 'answer', chunk: { type: 'text-delta', index: 0, text: 'done' } } });
    req.onFrame({ kind: 'assistant', value: { type: 'end', attemptId: 'answer', outcome: { kind: 'committed', eventType: 'assistant/message' } } });
    return { output: 'done' };
  };
  let runtime;
  const start = async () => { runtime = await startBuildRuntimeHttp({ agentId, buildId, token, runner,
    responseProjection: f.create(), model: 'fixed', models: ['fixed'], port: 0 }); };
  const post = stream => fetch(`http://127.0.0.1:${runtime.address.port}/v1/responses`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, stream }) });
  const collect = async response => { const frames = []; for await (const frame of readSse(response.body)) frames.push(frame); return frames; };
  await start(); t.after(() => runtime.close());
  let published = false;
  const firstDelivery = collect(await post(true)).then(frames => { published = true; return frames; });
  await started; await new Promise(resolve => setImmediate(resolve)); assert.equal(published, false);
  resolveFlush(true); f.setFlush(async () => true);
  const firstFrames = await firstDelivery, completed = firstFrames.at(-1).response;
  assert.equal(firstFrames.at(-1).type, 'response.completed');
  assert.equal(firstFrames.filter(frame => frame.type === 'response.tool_result').length, 2);
  assert.equal(completed.output.filter(item => item.type === 'function_call').length, 1);
  assert.deepEqual(await (await post(false)).json(), completed);
  await runtime.close(); await start();
  assert.deepEqual(await collect(await post(true)), firstFrames);
  assert.equal(turns, 1); assert.equal(validations, 2); assert.equal(f.rows.length, 1);
});

test('HTTP flush failure emits a failure with no completed response', async t => {
  const f = fixture(); f.setFlush(async () => false);
  const runtime = await startBuildRuntimeHttp({ agentId, buildId, token, model: 'fixed', models: ['fixed'],
    responseProjection: f.create(), runner: async () => ({ output: 'done' }), port: 0 });
  t.after(() => runtime.close());
  const result = await fetch(`http://127.0.0.1:${runtime.address.port}/v1/responses`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, stream: true }) });
  const frames = []; for await (const frame of readSse(result.body)) frames.push(frame);
  assert.equal(frames.some(frame => frame.type === 'response.completed'), false);
  assert.equal(frames.at(-1).response.error.code, 'RESPONSES_PROJECTION_NOT_DURABLE');
});
