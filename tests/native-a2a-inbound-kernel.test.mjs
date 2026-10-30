import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { canonical, parseNativeJson } from '@kingsoftcloud/agentkit-harness-core';
import { parseA2aInboundSubmission, streamA2aInboundKernelFacts } from '../src/providers/native-a2a-inbound-kernel.mjs';
import { createInternalA2AControlPlane } from '../src/providers/native-a2a-control-plane.mjs';

const command = '11111111-1111-4111-8111-111111111111', message = '22222222-2222-4222-8222-222222222222';
const session = 'a2a-kernel-admitted', agent = 'ar-target';
const wire = () => ({ SessionId: session, AgentId: agent, CommandId: command,
  Receipt: { schema_version: 1, command_id: command, status: 'accepted', message_id: message, accepted_seq: 1000 } });
const fact = (seq, state = 'pending', runId = 'original-run', causationId = command) => ({
  schema_version: 1, event_id: randomUUID(), session_id: session, seq, timestamp: '2026-10-24T00:00:00Z',
  family: 'control', family_version: 1, event_type: 'control.run_transition', run_id: runId,
  causation_id: causationId, payload: { run_id: runId, state },
});
const options = fields => ({ signal: new AbortController().signal, assertCurrent: () => true, ...fields });
const events = (rows, calls = []) => ({ async *subscribe(id, cursor) { calls.push({ id, cursor }); yield* rows; } });
const collect = async iterator => { const result = []; for await (const row of iterator) result.push(row); return result; };

test('finite reconciliation drains validated read pages without opening a live subscription or treating EOF as completion', async () => {
  const rows = [fact(1, 'running'), fact(2, 'running')], calls = [];
  const source = { subscribe() { assert.fail('A finite query must not open a live stream'); },
    async read(id, cursor, limit, { signal }) { calls.push({ id, cursor, limit }); signal.throwIfAborted();
      return rows.filter(row => row.seq > cursor).slice(0, limit); } };
  assert.deepEqual(await collect(streamA2aInboundKernelFacts(parseA2aInboundSubmission(wire()), source,
    options({ snapshotOnly: true }))), rows);
  assert.deepEqual(calls.map(call => call.cursor), [0, 2]);
  assert.equal(calls[0].limit, 100);
  await assert.rejects(collect(streamA2aInboundKernelFacts(parseA2aInboundSubmission(wire()),
    { read: async () => [rows[1], rows[0]] }, options({ snapshotOnly: true }))), { code: 'A2A_INBOUND_EVENT_SOURCE_INVALID' });
});

test('Server receipt enforces durable acceptance, command identity and errors while preserving optional fields/lossless sequence', () => {
  const raw = wire(); raw.Receipt.accepted_seq = 9007199254740993n; raw.Receipt.future = { keep: true };
  const parsed = parseA2aInboundSubmission(raw); assert.equal(parsed.receipt.accepted_seq, 9007199254740993n);
  assert.deepEqual(parsed.receipt.future, { keep: true }); assert.notEqual(parsed.receipt, raw.Receipt);
  for (const mutate of [row => row.SessionId = 'another', row => row.AgentId = 'other', row => row.CommandId = randomUUID(),
    row => delete row.Receipt.message_id, row => row.Receipt.accepted_seq = null, row => row.Receipt.accepted_seq = 0,
    row => row.Receipt.schema_version = 2, row => row.Receipt.status = 'success', row => row.Receipt.status = 'rejected']) {
    const value = wire(); mutate(value); assert.throws(() => parseA2aInboundSubmission(value), { code: 'A2A_INBOUND_SUBMISSION_INVALID' });
  }
  const rejected = wire(); rejected.Receipt.status = 'persistence_uncertain'; rejected.Receipt.message_id = null;
  rejected.Receipt.error = { code: 'persistence_uncertain', message: 'unconfirmed', retryable: true };
  assert.equal(parseA2aInboundSubmission(rejected).receipt.status, 'persistence_uncertain');
});

for (const boundary of ['waiting', 'completed', 'failed', 'cancelled', 'interrupted'])
  test(`facts select only the admitted command Run through its ${boundary} boundary, not accepted_seq`, async () => {
    const calls = [], rows = [fact(1, 'completed', 'another', randomUUID()), fact(2), fact(3, boundary), fact(4, 'completed')];
    const result = await collect(streamA2aInboundKernelFacts(parseA2aInboundSubmission(wire()), events(rows, calls), options()));
    assert.deepEqual(result.map(row => row.seq), [2, 3]); assert.deepEqual(calls, [{ id: session, cursor: 0 }]);
  });

test('persisted event cursor and admitted run survive lossless bigint replay, and waiting can be skipped explicitly', async () => {
  const raw = wire(); raw.Receipt.run_id = 'original-run';
  const cursor = 9007199254740993n, calls = [];
  const result = await collect(streamA2aInboundKernelFacts(parseA2aInboundSubmission(raw),
    events([fact(cursor), fact(cursor + 1n, 'waiting'), fact(cursor + 2n, 'completed')], calls),
    options({ afterSeq: cursor, expectedRunId: 'original-run', stopAtWaiting: false })));
  assert.deepEqual(result.map(row => row.seq), [cursor + 1n, cursor + 2n]); assert.equal(calls[0].cursor, cursor);
});

for (const failure of ['eof', 'session', 'command-run', 'rejected', 'payload-run', 'version'])
  test(`facts reject ${failure} without treating EOF or a foreign transition as success`, async () => {
    const rows = [fact(1)]; let code = 'A2A_INBOUND_STREAM_UNCONFIRMED';
    if (failure === 'session') { rows.push({ ...fact(2, 'completed'), session_id: 'other' }); code = 'A2A_INBOUND_FACT_INVALID'; }
    if (failure === 'command-run') { rows.push(fact(2, 'completed', 'another')); code = 'A2A_INBOUND_RUN_CONFLICT'; }
    if (failure === 'rejected') { rows.push({ ...fact(2), event_type: 'control.command_rejected', payload: { command_id: command } }); code = 'A2A_INBOUND_COMMAND_REJECTED'; }
    if (failure === 'payload-run') { rows.push({ ...fact(2, 'completed'), payload: { run_id: 'another', state: 'completed' } }); code = 'A2A_INBOUND_RUN_INVALID'; }
    if (failure === 'version') { rows.push({ ...fact(2, 'completed'), family_version: 2 }); code = 'A2A_INBOUND_FACT_INVALID'; }
    await assert.rejects(collect(streamA2aInboundKernelFacts(parseA2aInboundSubmission(wire()), events(rows), options())), { code });
  });

test('event authority loss and cancellation bound a noncooperative next and return without unhandled rejections', async () => {
  const controller = new AbortController(); let started, settle; const ready = new Promise(resolve => { started = resolve; });
  let returned = 0;
  const source = { subscribe() { return { [Symbol.asyncIterator]() { return this; },
    next() { started(); return new Promise((_, reject) => { settle = reject; }); }, return() { returned++; return new Promise(() => {}); } }; } };
  const pending = collect(streamA2aInboundKernelFacts(parseA2aInboundSubmission(wire()), source, options({ signal: controller.signal })));
  await ready; controller.abort(); await assert.rejects(pending, { name: 'AbortError' }); assert.equal(returned, 1);
  settle(Error('late private error')); await new Promise(resolve => setImmediate(resolve));
  for (const verdict of [false, Promise.reject(Error('private'))])
    await assert.rejects(collect(streamA2aInboundKernelFacts(parseA2aInboundSubmission(wire()), events([]), options({ assertCurrent: () => verdict }))),
      { code: 'A2A_INBOUND_AUTHORITY_LOST' });
});

test('actual registry HTTP submits the original unnormalized Message/continuation and cancels the exact admitted Run', async t => {
  const calls = [], tokens = [], server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    calls.push({ path: request.url, authorization: request.headers.authorization, body: parseNativeJson(raw) });
    response.end(canonical({ Code: 0, Data: wire() }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = createInternalA2AControlPlane({ baseUrl: `http://127.0.0.1:${server.address().port}`,
    tokenProvider: { getToken({ audience, assertCurrent }) { assertCurrent(); tokens.push(audience); return `registry-${tokens.length}`; } } });
  t.after(async () => { client.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const fields = { platformTaskId: 'a2a-task-33333333333343338333333333333333', targetVersionId: 'a2a-version-44444444444444448444444444444444',
    remoteTaskId: 'remote', remoteContextId: 'context', signal: new AbortController().signal, assertCurrent: () => true };
  const original = { message_id: 'source-message', parts: [{ text: '你好' }], metadata: { extra: 9007199254740993n }, unknown: true };
  const continuation = { run_id: 'original-run', interaction_id: 'input', expected_revision: 2, kind: 'structured_input' };
  assert.equal((await client.submitInboundMessage({ ...fields, message: original, continuation })).receipt.command_id, command);
  await client.cancelInboundTask({ ...fields, runId: 'original-run' });
  assert.deepEqual(tokens, ['a2a-registry', 'a2a-registry']);
  assert.equal(calls[0].path, '/agentengine/internal/v1/a2a/SubmitA2AInboundMessage');
  assert.deepEqual(calls[0].body.Message, original); assert.deepEqual(calls[0].body.Continuation, continuation);
  assert.equal(calls[0].authorization, 'Bearer registry-1');
  assert.equal(calls[1].path, '/agentengine/internal/v1/a2a/CancelA2AInboundTask');
  assert.equal(calls[1].body.RunId, 'original-run'); assert.equal(calls[1].body.A2ATaskId, fields.platformTaskId);
  await assert.rejects(client.submitInboundMessage({ ...fields, message: null }), { code: 'A2A_CONTROL_PLANE_INBOUND_INVALID' });
  assert.equal(calls.length, 2);
});
