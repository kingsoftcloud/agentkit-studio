import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { canonical, parseNativeJson } from '@kingsoftcloud/agentkit-harness-core';
import { createA2aInboundServer } from '../src/providers/native-a2a-inbound-server.mjs';
import { inboundFixture, kernelFact } from './fixtures/native-a2a-inbound.mjs';

const runtime = (seq, payload) => kernelFact(seq, { family: 'runtime', family_version: 2, event_type: payload.event_type,
  payload: { schema_version: 2, run_id: 'run-original', scope_id: 'scope', ...payload } });
const transition = (seq, state) => kernelFact(seq, { payload: { run_id: 'run-original', state } });
const answer = seq => runtime(seq, { event_type: 'item.updated', item_id: 'answer', item_kind: 'message', op: 'append',
  update: { content_type: 'text', part_id: 'p', text: 'Hello😀' } });
const completed = seq => runtime(seq, { event_type: 'run.completed', status: 'completed', output_refs: [{ scope_id: 'scope', item_id: 'answer', part_id: null }] });
const message = (id = 'original-message', extra = {}) => ({ messageId: id, role: 'ROLE_USER', parts: [{ text: 'Hello' }], ...extra });
const rpcBody = (method, params, id = 'request') => canonical({ jsonrpc: '2.0', id, method, params });
async function fixture(t, options = {}) {
  const f = await inboundFixture(t, { respond: options.serverRespond }), rows = options.rows ?? [transition(1, 'running'), answer(2), completed(3), transition(4, 'completed')];
  const eventCalls = [], events = options.events ?? { async *subscribe(sessionId, cursor) {
    eventCalls.push({ sessionId, cursor }); for (const row of rows) if (row.seq > cursor) yield row;
  } };
  let app, server;
  const config = { card: { name: 'Native', baseUrl: 'http://127.0.0.1', streaming: options.streaming ?? true, ...options.card },
    admissionDirectory: join(f.root, 'admission'), taskDirectory: join(f.root, 'tasks'), verifier: f.verifier,
    controlPlane: f.client, events, publicToolPolicy: options.publicToolPolicy, assertCurrent: options.assertCurrent ?? (() => true) };
  const mount = async () => {
    app = createA2aInboundServer(config); server = createServer(app.handle);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${server.address().port}`;
  };
  const stop = async () => { await app.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
  let baseUrl = await mount(); t.after(stop);
  const send = (operation, body, options = {}) => {
    const request = f.signer.request(operation, { body, ...options });
    return fetch(baseUrl + request.path + (request.query ? '?' + request.query : ''), {
      method: request.method, headers: request.headers, ...(request.method === 'GET' ? {} : { body: request.body }),
      signal: AbortSignal.timeout(10000),
    });
  };
  return { ...f, rows, eventCalls, send, get app() { return app; }, get baseUrl() { return baseUrl; },
    async restart() { await stop(); baseUrl = await mount(); } };
}
const json = async response => parseNativeJson(await response.text());
const rpc = async (f, operation, method, params, options) => json(await f.send(operation, rpcBody(method, params), options));
const waitFor = async predicate => { for (let count = 0; count < 100; count++) { const value = await predicate(); if (value) return value;
  await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('Expected condition did not become true'); };

test('actual JSON-RPC Server admission and durable fact projection returns final Task; reopen reads original without new HTTP', async t => {
  const f = await fixture(t), first = await rpc(f, 'send_message', 'SendMessage', { message: message() });
  assert.equal(first.result.task.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(first.result.task.status.message.parts[0].text, 'Hello😀'); assert.equal(f.calls.length, 1);
  const original = first.result.task; await f.restart();
  const get = await rpc(f, 'get_task', 'GetTask', { id: original.id }); assert.deepEqual(get.result, original);
  const retry = await rpc(f, 'send_message', 'SendMessage', { message: message() }); assert.deepEqual(retry.result.task, original);
  assert.equal(f.calls.length, 1); assert.equal(f.eventCalls.length, 1);
  t.diagnostic(`HTTP composed admission+TaskStore; platformAdmissions=${f.calls.length}, eventSubscriptions=${f.eventCalls.length}; controlled Server+facts, no model execution`);
});

test('actual REST send/get and JSON-RPC read share the same owner-scoped durable Task', async t => {
  const f = await fixture(t), response = await f.send('send_message', canonical({ message: message() }), { path: '/a2a/v1/message:send' });
  assert.equal(response.status, 200); const task = (await json(response)).task;
  const get = await f.send('get_task', '', { path: `/a2a/v1/tasks/${task.id}`, httpMethod: 'GET', query: 'historyLength=0' });
  const got = await json(get); assert.equal(got.id, task.id); assert.deepEqual(got.history, []);
  assert.equal((await rpc(f, 'get_task', 'tasks/get', { id: task.id })).result.history.length, 1);
  const denied = await rpc(f, 'get_task', 'GetTask', { id: task.id }, { claims: { caller_principal_id: 'other' } });
  assert.equal(denied.error.code, -32001); assert.equal(f.calls.length, 1);
});

test('JSON-RPC SSE publishes committed snapshots/artifact replacements and canonical terminal with stable UUID IDs', async t => {
  const f = await fixture(t), response = await f.send('send_message', rpcBody('SendStreamingMessage', { message: message() }));
  assert.match(response.headers.get('content-type'), /text\/event-stream/u);
  const text = await response.text(), rows = text.split('\n\n').filter(Boolean).map(frame => {
    const id = frame.split('\n').find(line => line.startsWith('id: '))?.slice(4);
    return { id, payload: parseNativeJson(frame.split('\n').find(line => line.startsWith('data: ')).slice(6)) };
  });
  assert.ok(rows.every(row => row.payload.id === 'request' && row.payload.jsonrpc === '2.0'));
  const task = rows[0].payload.result.task; assert.equal(task.status.state, 'TASK_STATE_WORKING');
  assert.equal(rows.find(row => row.payload.result.artifactUpdate).payload.result.artifactUpdate.artifact.parts[0].text, 'Hello😀');
  assert.equal(rows.at(-1).payload.result.statusUpdate.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(rows.at(-2).payload.result.artifactUpdate.lastChunk, true);
  assert.equal(rows.at(-1).id, `${f.rows.at(-1).event_id}:1`);
  assert.equal((await rpc(f, 'get_task', 'GetTask', { id: task.id })).result.status.state, 'TASK_STATE_COMPLETED');
});

test('unconfirmed EOF returns a protocol error and cannot mark Task completed', async t => {
  const f = await fixture(t, { rows: [transition(1, 'running'), answer(2), completed(3)] });
  const result = await rpc(f, 'send_message', 'SendMessage', { message: message() }); assert.equal(result.error.code, -32603);
  // Stable address was committed before the Server request, even though its
  // response did not reach a confirmed Task boundary.
  const streamed = await f.send('send_message', rpcBody('SendStreamingMessage', { message: message() }));
  const text = await streamed.text(); assert.match(text, /TASK_STATE_WORKING/u); assert.doesNotMatch(text, /TASK_STATE_COMPLETED/u);
  assert.equal(f.calls.length, 1);
});

test('streaming disabled rejects before allocating or admitting a Task', async t => {
  const f = await fixture(t, { streaming: false });
  const result = await rpc(f, 'send_message', 'SendStreamingMessage', { message: message() });
  assert.equal(result.error.code, -32004); assert.equal(f.calls.length, 0); assert.equal(f.eventCalls.length, 0);
});

test('verified operation cannot be substituted and malformed JSON errors contain no raw input', async t => {
  const f = await fixture(t);
  const mismatch = await rpc(f, 'get_task', 'SendMessage', { message: message() }); assert.equal(mismatch.error.code, -32600);
  const bad = await json(await f.send('send_message', '{"secret":"never-echo",')); assert.equal(bad.error.code, -32700);
  assert.doesNotMatch(JSON.stringify(bad), /never-echo/u);
  const unknown = await rpc(f, 'send_message', 'UnknownMethod', {}, {});
  assert.equal(unknown.id, 'request'); assert.equal(unknown.error.code, -32601); assert.equal(f.calls.length, 0);
});

test('AgentCard probe requires actual signed method/path/body/target binding', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.baseUrl + '/.well-known/agent-card.json')).status, 401);
  const response = await f.send('get_task', '', { path: '/.well-known/agent-card.json', httpMethod: 'GET' });
  assert.equal(response.status, 200); const card = await json(response);
  assert.equal(card.supportedInterfaces[0].protocolVersion, '1.0'); assert.equal(card.capabilities.streaming, true);
  const changed = await f.send('get_task', '', { path: '/.well-known/agent-card.json', httpMethod: 'GET', claims: { target_runtime_id: 'other' } });
  assert.equal(changed.status, 401); assert.equal(f.calls.length, 0);
});

test('WAITING structured input can continue original Task; replaying the original input does not answer it', async t => {
  const question = kernelFact(2, { family: 'interaction', event_type: 'interaction.requested', payload: { interaction_id: 'private-question',
    revision: 7, kind: 'structured_input', request: { request_schema: { type: 'string' }, presentation: { description: 'Which?' } } } });
  const f = await fixture(t, { rows: [transition(1, 'running'), question, transition(3, 'waiting')] });
  const first = (await rpc(f, 'send_message', 'SendMessage', { message: message() })).result.task;
  assert.equal(first.status.state, 'TASK_STATE_INPUT_REQUIRED');
  assert.doesNotMatch(JSON.stringify(first), /private-question|expected_revision/u);
  // Retrying the initial input must not attach the newly observed question.
  assert.equal((await rpc(f, 'send_message', 'SendMessage', { message: message() })).result.task.id, first.id);
  assert.equal(f.calls.length, 1);
  f.rows.push(transition(4, 'running'), answer(5), completed(6), transition(7, 'completed'));
  const followup = message('answer', { taskId: first.id, parts: [{ text: 'this' }] });
  const next = await rpc(f, 'send_message', 'SendMessage', { message: followup }); assert.equal(next.result.task.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(next.result.task.id, first.id); assert.equal(next.result.task.contextId, first.contextId);
  assert.equal(f.calls[1].body.Continuation.interaction_id, 'private-question');
  assert.equal(f.calls[1].body.Continuation.expected_revision, 7);
  await f.restart(); assert.equal((await rpc(f, 'send_message', 'SendMessage', { message: followup })).result.task.id, first.id);
  assert.equal(f.calls.length, 2);
});

test('cancel only becomes canceled after original canonical cancel fact, not after admission receipt', async t => {
  let release, entered; const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { events: { async *subscribe(sessionId, cursor, { signal }) {
    if (cursor === 0) { yield transition(1, 'running'); entered(); await gate; signal.throwIfAborted(); }
    yield transition(2, 'cancelled');
  } } });
  const first = await rpc(f, 'send_message', 'SendMessage', { message: message(), configuration: { returnImmediately: true } });
  const task = first.result.task; assert.equal(task.status.state, 'TASK_STATE_WORKING'); await started;
  const pending = rpc(f, 'cancel_task', 'CancelTask', { id: task.id });
  await waitFor(() => f.calls.length === 2);
  // Cancellation has its own event subscription, which confirms canceled;
  // the original Send observer remains blocked and cannot overwrite it.
  const canceled = await pending; assert.equal(canceled.result.status.state, 'TASK_STATE_CANCELED'); release();
  const get = await rpc(f, 'get_task', 'GetTask', { id: task.id }); assert.equal(get.result.status.state, 'TASK_STATE_CANCELED');
  assert.equal(f.calls.filter(call => call.action === 'CancelA2AInboundTask').length, 1);
});

test('product caller commits lifecycle facts with Task projection and delivers original facts using task-sink authority', async t => {
  const f = await fixture(t), response = await rpc(f, 'send_message', 'SendMessage', { message: message() }, { product: true });
  assert.equal(response.result.task.status.state, 'TASK_STATE_COMPLETED');
  await f.app.flushProductFacts();
  const batches = f.calls.filter(call => call.action === 'AppendA2AProductKernelFacts');
  assert.ok(batches.length > 0); assert.ok(batches.every(call => call.authorization === 'Bearer task-sink-workload'));
  const facts = batches.flatMap(call => call.body.Events);
  assert.deepEqual(facts.map(fact => fact.event_id), [f.rows[0].event_id, f.rows[3].event_id]);
  assert.ok(batches.every(call => call.body.RemoteTaskId === response.result.task.id && call.body.RemoteContextId === response.result.task.contextId));
  const directory = join(f.root, 'tasks'), file = readdirSync(directory).find(name => name.endsWith('.json'));
  const stored = parseNativeJson(readFileSync(join(directory, file), 'utf8'));
  assert.equal(stored.task.status.state, 'TASK_STATE_COMPLETED');
  assert.ok(Object.values(stored.productOutbox).every(row => row.state === 'acknowledged'));
  const count = f.calls.length; await f.restart(); await f.app.flushProductFacts(); assert.equal(f.calls.length, count);
});

test('lost product fact ACK retries only immutable fact UUIDs, never admission or model work', async t => {
  let lost = true; const acceptedIds = new Set();
  const f = await fixture(t, { serverRespond(call, data, response) {
    if (call.action !== 'AppendA2AProductKernelFacts') return;
    for (const fact of call.body.Events) acceptedIds.add(fact.event_id);
    if (lost) { lost = false; response.destroy(); }
  } });
  const result = await rpc(f, 'send_message', 'SendMessage', { message: message() }, { product: true });
  assert.equal(result.result.task.status.state, 'TASK_STATE_COMPLETED');
  await f.app.flushProductFacts().catch(() => {}); await f.app.flushProductFacts();
  assert.equal(f.calls.filter(call => call.action === 'SubmitA2AInboundMessage').length, 1);
  assert.deepEqual([...acceptedIds], [f.rows[0].event_id, f.rows[3].event_id]);
  const facts = f.calls.filter(call => call.action === 'AppendA2AProductKernelFacts').flatMap(call => call.body.Events);
  assert.ok(facts.length > acceptedIds.size);
  assert.deepEqual(facts.filter(fact => fact.event_id === f.rows[0].event_id)[0], f.rows[0]);
});

test('closing SSE only stops observation; a fresh signed REST subscription reads original Task without another Send', async t => {
  let enter, close; const started = new Promise(resolve => { enter = resolve; }), disconnected = new Promise(resolve => { close = resolve; });
  const rows = [transition(1, 'running'), answer(2), completed(3), transition(4, 'completed')];
  let reads = 0;
  const f = await fixture(t, { events: { async *subscribe(sessionId, cursor, { signal }) {
    assert.equal(sessionId, 'a2a-kernel-original'); reads++;
    if (reads === 1) { signal.addEventListener('abort', close, { once: true }); enter(); await new Promise(() => {}); }
    for (const row of rows) if (row.seq > cursor) yield row;
  } } });
  const response = await f.send('send_message', rpcBody('SendStreamingMessage', { message: message() }));
  const reader = response.body.getReader(), first = await reader.read();
  const snapshot = parseNativeJson(new TextDecoder().decode(first.value).split('\n').find(line => line.startsWith('data: ')).slice(6));
  const task = snapshot.result.task; await started; await reader.cancel();
  await Promise.race([disconnected, new Promise((_, reject) => setTimeout(() => reject(new Error('SSE disconnect did not stop observation')), 1000))]);
  assert.equal(f.calls.length, 1);
  const resubscribe = await f.send('subscribe_to_task', '', { path: `/a2a/v1/tasks/${task.id}:subscribe` });
  const text = await resubscribe.text(); assert.match(text, /TASK_STATE_COMPLETED/u); assert.equal(reads, 2);
  assert.equal(f.calls.length, 1); assert.equal(f.admitted.size, 1);
  assert.equal(f.calls.filter(call => call.action === 'CancelA2AInboundTask').length, 0);
});

test('explicit retry of a lost cancel receipt reconciles the same command instead of being blocked by its unknown marker', async t => {
  let lost = true, entered; const started = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { serverRespond(call, data, response) {
    if (call.action === 'CancelA2AInboundTask' && lost) { lost = false; response.destroy(); }
  }, events: { async *subscribe(sessionId, cursor) {
    if (cursor === 0) { yield transition(1, 'running'); entered(); await new Promise(() => {}); }
    yield transition(2, 'cancelled');
  } } });
  const first = await rpc(f, 'send_message', 'SendMessage', { message: message(), configuration: { returnImmediately: true } });
  await started; const taskId = first.result.task.id;
  const unknown = await rpc(f, 'cancel_task', 'CancelTask', { id: taskId }); assert.equal(unknown.error.code, -32603);
  const reconciled = await rpc(f, 'cancel_task', 'CancelTask', { id: taskId }); assert.equal(reconciled.result.status.state, 'TASK_STATE_CANCELED');
  const cancels = f.calls.filter(call => call.action === 'CancelA2AInboundTask'); assert.equal(cancels.length, 2);
  assert.deepEqual(cancels[0].body, cancels[1].body); assert.equal(f.admitted.size, 2, 'one Send and one original Cancel command');
});

test('Host close destroys an open SSE response even when its fact iterator ignores cancellation', async t => {
  let enter; const started = new Promise(resolve => { enter = resolve; });
  const f = await fixture(t, { events: { async *subscribe() { enter(); await new Promise(() => {}); } } });
  const response = await f.send('send_message', rpcBody('SendStreamingMessage', { message: message() }));
  const reader = response.body.getReader(); await reader.read(); await started;
  const pending = reader.read(); await f.app.close();
  await assert.rejects(Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error('Host socket remained open')), 1000))]),
    failure => failure.message !== 'Host socket remained open');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].action, 'SubmitA2AInboundMessage');
});

test('cold GetTask reconciles original durable interruption before replying without submitting a new command', async t => {
  const rows = [transition(1, 'running')], reads = [];
  let entered; const started = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { events: {
    async *subscribe() { yield rows[0]; entered(); await new Promise(() => {}); },
    async read(sessionId, cursor, limit) { reads.push({ sessionId, cursor }); return rows.filter(row => row.seq > cursor).slice(0, limit); },
  } });
  const first = await rpc(f, 'send_message', 'SendMessage', { message: message(), configuration: { returnImmediately: true } });
  await started; await f.restart(); rows.push(transition(2, 'interrupted'));
  const current = await rpc(f, 'get_task', 'GetTask', { id: first.result.task.id });
  assert.equal(current.result.status.state, 'TASK_STATE_FAILED');
  assert.equal(current.result.id, first.result.task.id); assert.equal(reads[0].cursor, 1);
  assert.equal(f.calls.length, 1); assert.equal(f.admitted.size, 1);
  const repeated = await rpc(f, 'get_task', 'GetTask', { id: first.result.task.id });
  assert.deepEqual(repeated.result, current.result); assert.equal(reads.length, 1);
});

test('authenticated wire publishes only trusted public tool fields and advertises its real producer', async t => {
  const call = runtime(2, { event_type: 'item.completed', item_kind: 'tool_call', item_id: 'private-tool-item', snapshot: { parts: [{
    content_type: 'tool_call', part_id: 'call', call_id: 'private-call', name: 'private_lookup',
    arguments: { query: 'hello', private: 'never-public' },
  }] } });
  const result = runtime(3, { event_type: 'item.completed', item_kind: 'tool_result', item_id: 'private-result-item', snapshot: { parts: [{
    content_type: 'tool_result', part_id: 'result', call_id: 'private-call', result: { answer: 'found', password: 'never-public' }, is_error: false,
  }] } });
  const f = await fixture(t, { publicToolPolicy: { tools: { private_lookup: { name: 'lookup', arguments: ['query'], results: ['answer'] } } },
    rows: [transition(1, 'running'), call, result, runtime(4, { event_type: 'run.completed', output_refs: [] }), transition(5, 'completed')] });
  const task = (await rpc(f, 'send_message', 'SendMessage', { message: message() })).result.task;
  assert.equal(task.status.state, 'TASK_STATE_COMPLETED'); assert.equal(task.artifacts.length, 2);
  assert.deepEqual(task.artifacts[0].parts[0].data.arguments, { query: 'hello' });
  assert.deepEqual(task.artifacts[1].parts[0].data.result, { answer: 'found' });
  assert.doesNotMatch(JSON.stringify(task), /private_lookup|private-call|private-tool|never-public|password/u);
  const probe = await f.send('get_task', '', { path: '/.well-known/agent-card.json', httpMethod: 'GET' });
  const card = await json(probe);
  assert.equal(card.capabilities.extensions[0].uri, 'urn:ksadk:a2a:tool-activity:v1');
  await f.restart();
  assert.deepEqual((await rpc(f, 'get_task', 'GetTask', { id: task.id })).result.artifacts, task.artifacts);
});
