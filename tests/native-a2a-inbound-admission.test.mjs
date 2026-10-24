import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createA2aInboundAdmission } from '../src/providers/native-a2a-inbound-admission.mjs';
import { inboundFixture, input, kernelFact } from './fixtures/native-a2a-inbound.mjs';
const collect = async iterator => { const result = []; for await (const row of iterator) result.push(row); return result; };

for (const product of [false, true]) test(`${product ? 'product key' : 'runtime'} signed requests preserve original message and durable intent before actual Server HTTP`, async t => {
  const f = await inboundFixture(t); f.setHook(() => {
    const ops = Object.values(f.record().operations); assert.equal(ops.length, 1); assert.equal(ops[0].phase, 'prepared');
    assert.equal(ops[0].fields.message.metadata.integer, 9007199254740993n);
  });
  const request = f.signer.request('send_message', { product }), submitted = await f.service.submit(input(request));
  assert.equal(submitted.receipt.status, 'accepted'); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].body.Message.message_id, 'original-message'); assert.equal(f.calls[0].body.Message.extra, 'preserved');
  assert.equal(f.calls[0].body.Message.metadata.integer, 9007199254740993n);
  const record = f.record(); assert.equal(Object.values(record.operations)[0].phase, 'resolved');
  assert.doesNotMatch(JSON.stringify(record.binding), /assertion|registry-workload|Bearer/);
  assert.deepEqual(await f.service.submit(input(request)), submitted); assert.equal(f.calls.length, 1);
  const cold = createA2aInboundAdmission({ directory: f.directory, verifier: f.verifier, controlPlane: f.client, events: f.events, assertCurrent: () => true });
  t.after(() => cold.close());
  assert.deepEqual(await cold.submit(input(request)), submitted); assert.equal(f.calls.length, 1);
  const status = cold.inspect(input(f.signer.request('get_task', { product })));
  assert.equal(status.submission.receipt.command_id, submitted.receipt.command_id); assert.equal(status.runId, 'run-original');
});

test('lost admission receipt stays unknown, a different message cannot bypass it, explicit same admission can reconcile', async t => {
  let lost = true; const f = await inboundFixture(t, { respond(call, data, response) { if (lost) { lost = false; response.destroy(); } } });
  const request = f.signer.request('send_message');
  await assert.rejects(f.service.submit(input(request)), { code: 'A2A_CONTROL_PLANE_UNAVAILABLE' });
  assert.equal(Object.values(f.record().operations)[0].phase, 'unknown'); assert.equal(f.admitted.size, 1);
  await assert.rejects(f.service.submit(input(f.signer.request('send_message', { messageId: 'other-message' }))), { code: 'A2A_INBOUND_PRIOR_OUTCOME_UNKNOWN' });
  assert.equal(f.calls.length, 1);
  const result = await f.service.submit(input(request)); assert.equal(result.receipt.status, 'duplicate');
  assert.equal(f.calls.length, 2); assert.equal(f.admitted.size, 1);
  assert.deepEqual(f.calls[0].body, f.calls[1].body); assert.deepEqual(f.service.inspect(input(f.signer.request('get_task'))).uncertainOperations, []);
});

test('tampered request, changed caller/remote/target version, and conflicting message bytes cannot enter Server', async t => {
  const f = await inboundFixture(t), request = f.signer.request('send_message'); await f.service.submit(input(request));
  await assert.rejects(f.service.submit(input({ ...request, body: Buffer.from('{}') })), { code: 'A2A_INGRESS_IDENTITY_INVALID' });
  await assert.rejects(f.service.submit({ ...input(request), remoteTaskId: 'another' }), { code: 'A2A_INBOUND_BINDING_CONFLICT' });
  await assert.rejects(f.service.submit(input(f.signer.request('send_message', { claims: { target_version_id: 'a2a-version-44444444444444448444444444444444' } }))), { code: 'A2A_INBOUND_BINDING_CONFLICT' });
  const body = Buffer.from(request.body).toString().replace('原始消息', '修改消息');
  await assert.rejects(f.service.submit(input(f.signer.request('send_message', { body }))), { code: 'A2A_INBOUND_COMMAND_CONFLICT' });
  assert.throws(() => f.service.inspect(input(f.signer.request('get_task', { claims: { caller_principal_id: 'another' } }))), { code: 'A2A_INBOUND_TASK_NOT_FOUND' });
  assert.equal(f.calls.length, 1);
});

test('cancellation uses verified cancel provenance and exact admitted Run, cached command is not reissued', async t => {
  const f = await inboundFixture(t); await f.service.submit(input(f.signer.request('send_message')));
  const cancel = { ...input(f.signer.request('cancel_task')), runId: 'run-original' };
  await assert.rejects(f.service.cancel({ ...cancel, runId: 'another' }), { code: 'A2A_INBOUND_RUN_CONFLICT' });
  await assert.rejects(f.service.cancel({ ...cancel, request: f.signer.request('get_task') }), { code: 'A2A_INBOUND_PROVENANCE_INVALID' });
  const result = await f.service.cancel(cancel); assert.equal(result.receipt.status, 'accepted');
  assert.deepEqual(await f.service.cancel(cancel), result); assert.equal(f.calls.length, 2); assert.equal(f.admitted.size, 2);
  assert.equal(f.calls[1].action, 'CancelA2AInboundTask'); assert.equal(f.calls[1].body.RunId, 'run-original');
});

test('only durable selected Run interaction authorizes continuation; event cursor advances after consumer acknowledgement', async t => {
  const rows = [kernelFact(1), kernelFact(2, { family: 'interaction', event_type: 'interaction.requested',
    payload: { interaction_id: 'question', revision: 3, kind: 'structured_input', request: {} } }),
  kernelFact(3, { payload: { run_id: 'run-original', state: 'waiting' } })];
  const f = await inboundFixture(t, { eventRows: rows }); await f.service.submit(input(f.signer.request('send_message')));
  const follow = input(f.signer.request('send_message', { messageId: 'answer' }));
  await assert.rejects(f.service.submit(follow), { code: 'A2A_INBOUND_CONTINUATION_CONFLICT' });
  const stream = f.service.facts(input(f.signer.request('subscribe_to_task')));
  assert.equal((await stream.next()).value.seq, 1); assert.equal(f.service.inspect(input(f.signer.request('get_task'))).cursor, 0);
  assert.equal((await stream.next()).value.seq, 2); await stream.return();
  const first = f.service.inspect(input(f.signer.request('get_task'))); assert.equal(first.cursor, 1);
  assert.deepEqual(first.pending, { run_id: 'run-original', interaction_id: 'question', expected_revision: 3, kind: 'structured_input' });
  const resumed = await collect(f.service.facts(input(f.signer.request('subscribe_to_task'))));
  assert.deepEqual(resumed.map(fact => fact.seq), [2, 3]); assert.deepEqual(f.eventCalls.map(call => call.cursor), [0, 1]);
  await assert.rejects(f.service.submit({ ...follow, continuation: { ...first.pending, expected_revision: 2 } }), { code: 'A2A_INBOUND_CONTINUATION_CONFLICT' });
  assert.equal(f.calls.length, 1);
  const result = await f.service.submit({ ...follow, continuation: first.pending }); assert.equal(result.receipt.status, 'accepted');
  assert.equal(f.calls.length, 2); assert.deepEqual(f.calls[1].body.Continuation, first.pending);
  assert.equal(f.service.inspect(input(f.signer.request('get_task'))).pending, null);
  rows.push(kernelFact(4), kernelFact(5, { payload: { run_id: 'run-original', state: 'completed' } }));
  const after = await collect(f.service.facts(input(f.signer.request('subscribe_to_task'))));
  assert.deepEqual(after.map(row => row.seq), [4, 5]); assert.equal(f.eventCalls.at(-1).cursor, 3);
});

test('cancellation observes past the prior unacknowledged WAITING boundary and never reports acceptance as completion', async t => {
  const rows = [kernelFact(1, { family: 'interaction', event_type: 'interaction.requested',
    payload: { interaction_id: 'approval', revision: 1, kind: 'approval', request: {} } }),
  kernelFact(2, { payload: { run_id: 'run-original', state: 'waiting' } })];
  const f = await inboundFixture(t, { eventRows: rows }); await f.service.submit(input(f.signer.request('send_message')));
  const stream = f.service.facts(input(f.signer.request('subscribe_to_task')));
  await stream.next(); await stream.next(); await stream.return();
  assert.equal(f.service.inspect(input(f.signer.request('get_task'))).cursor, 1);
  const result = await f.service.cancel({ ...input(f.signer.request('cancel_task')), runId: 'run-original' });
  assert.equal(result.receipt.status, 'accepted'); assert.notEqual(f.service.inspect(input(f.signer.request('get_task'))).pending, null);
  rows.push(kernelFact(3, { payload: { run_id: 'run-original', state: 'waiting' } }),
    kernelFact(4, { payload: { run_id: 'run-original', state: 'cancelled' } }));
  const after = await collect(f.service.facts(input(f.signer.request('subscribe_to_task'))));
  assert.deepEqual(after.map(row => row.seq), [3, 4]); assert.equal(f.eventCalls.at(-1).cursor, 2);
  assert.equal(f.service.inspect(input(f.signer.request('get_task'))).pending, null);
});

test('Server target drift and persistence uncertainty stay nonterminal and cannot authorize a new Message', async t => {
  const f = await inboundFixture(t, { respond(call, data) { data.Receipt.status = 'persistence_uncertain'; data.Receipt.message_id = null;
    data.Receipt.error = { code: 'persistence_uncertain', message: 'unknown', retryable: true }; } });
  const result = await f.service.submit(input(f.signer.request('send_message'))); assert.equal(result.receipt.status, 'persistence_uncertain');
  const status = f.service.inspect(input(f.signer.request('get_task'))); assert.equal(status.submission, null); assert.equal(status.uncertainOperations.length, 1);
  await assert.rejects(f.service.submit(input(f.signer.request('send_message', { messageId: 'another' }))), { code: 'A2A_INBOUND_PRIOR_OUTCOME_UNKNOWN' });
  assert.equal(f.calls.length, 1);
  const changed = await inboundFixture(t, { respond(call, data) { data.AgentId = 'ar-another'; } });
  await assert.rejects(changed.service.submit(input(changed.signer.request('send_message'))), { code: 'A2A_INBOUND_TARGET_CONFLICT' });
  assert.equal(Object.values(changed.record().operations)[0].phase, 'unknown');
});

test('owner loss while Server responds cannot publish a receipt or allow cached reads', async t => {
  let current = true; const f = await inboundFixture(t, { assertCurrent: () => current });
  f.setHook(() => { current = false; });
  await assert.rejects(f.service.submit(input(f.signer.request('send_message'))));
  assert.equal(Object.values(f.record().operations)[0].phase, 'prepared');
  assert.throws(() => f.service.inspect(input(f.signer.request('get_task'))), { code: 'A2A_INBOUND_AUTHORITY_LOST' });
});

test('concurrent older observations cannot overwrite a newer durable interaction or regress the acknowledgement cursor', async t => {
  const question = (seq, revision) => kernelFact(seq, { family: 'interaction', event_type: 'interaction.requested',
    payload: { interaction_id: 'question', revision, kind: 'structured_input', request: {} } });
  const rows = [kernelFact(1), question(2, 1), question(3, 2), kernelFact(4, { payload: { run_id: 'run-original', state: 'waiting' } })];
  const f = await inboundFixture(t, { eventRows: rows }); await f.service.submit(input(f.signer.request('send_message')));
  const older = f.service.facts(input(f.signer.request('subscribe_to_task'))); await older.next();
  await collect(f.service.facts(input(f.signer.request('subscribe_to_task'))));
  assert.equal(f.service.inspect(input(f.signer.request('get_task'))).pending.expected_revision, 2);
  assert.equal((await older.next()).value.seq, 2); await older.return();
  const status = f.service.inspect(input(f.signer.request('get_task')));
  assert.equal(status.pending.expected_revision, 2); assert.equal(status.cursor, 4);
});

test('an unknown cancellation blocks a new continuation until the original cancellation is reconciled', async t => {
  let drop = true;
  const rows = [kernelFact(1, { family: 'interaction', event_type: 'interaction.requested',
    payload: { interaction_id: 'question', revision: 1, kind: 'structured_input', request: {} } }),
  kernelFact(2, { payload: { run_id: 'run-original', state: 'waiting' } })];
  const f = await inboundFixture(t, { eventRows: rows, respond(call, data, response) {
    if (call.action === 'CancelA2AInboundTask' && drop) { drop = false; response.destroy(); }
  } });
  await f.service.submit(input(f.signer.request('send_message')));
  await collect(f.service.facts(input(f.signer.request('subscribe_to_task'))));
  const continuation = f.service.inspect(input(f.signer.request('get_task'))).pending;
  const cancel = { ...input(f.signer.request('cancel_task')), runId: 'run-original' };
  await assert.rejects(f.service.cancel(cancel));
  await assert.rejects(f.service.submit({ ...input(f.signer.request('send_message', { messageId: 'new-answer' })), continuation }),
    { code: 'A2A_INBOUND_PRIOR_OUTCOME_UNKNOWN' });
  assert.equal(f.calls.length, 2);
  assert.equal((await f.service.cancel(cancel)).receipt.status, 'duplicate'); assert.equal(f.calls.length, 3);
});

test('concurrent admissions are serialized by the real task lock and duplicates reuse the confirmed receipt', async t => {
  const f = await inboundFixture(t); let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  f.setHook(() => { entered(); return new Promise(resolve => { release = resolve; }); });
  const request = input(f.signer.request('send_message')), first = f.service.submit(request); await ready;
  await assert.rejects(f.service.submit(request), { code: 'A2A_INBOUND_ADMISSION_BUSY' }); assert.equal(f.calls.length, 1);
  release(); const receipt = await first;
  assert.deepEqual(await f.service.submit(request), receipt); assert.equal(f.calls.length, 1);
});

test('closing the owner while the Server holds its response releases admission and preserves the unknown original intent', async t => {
  const f = await inboundFixture(t); let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  f.setHook(() => { entered(); return new Promise(resolve => { release = resolve; }); });
  const pending = f.service.submit(input(f.signer.request('send_message'))); await ready;
  f.service.close(); await assert.rejects(pending, { name: 'AbortError' }); release();
  const cold = createA2aInboundAdmission({ directory: f.directory, verifier: f.verifier, controlPlane: f.client, assertCurrent: () => true });
  t.after(() => cold.close());
  assert.equal(cold.inspect(input(f.signer.request('get_task'))).uncertainOperations.length, 1);
  assert.equal(f.calls.length, 1); assert.equal(Object.values(f.record().operations)[0].phase, 'prepared');
});

test('an explicitly retried uncertain Server receipt cannot change its persisted command or Session identity', async t => {
  let attempt = 0;
  const f = await inboundFixture(t, { respond(call, data) {
    if (++attempt === 1) {
      data.Receipt.status = 'persistence_uncertain'; data.Receipt.message_id = null;
      data.Receipt.error = { code: 'persistence_uncertain', message: 'unknown', retryable: true };
    } else { data.CommandId = randomUUID(); data.Receipt.command_id = data.CommandId; }
  } });
  const request = input(f.signer.request('send_message')); await f.service.submit(request);
  await assert.rejects(f.service.submit(request), { code: 'A2A_INBOUND_COMMAND_CONFLICT' });
  assert.equal(Object.values(f.record().operations)[0].phase, 'unknown'); assert.equal(f.calls.length, 2);
});

for (const changed of ['session', 'run']) test(`cancel admission cannot move the original task to another ${changed}`, async t => {
  const f = await inboundFixture(t, { respond(call, data) {
    if (call.action === 'CancelA2AInboundTask') {
      if (changed === 'session') data.SessionId = 'a2a-kernel-another'; else data.Receipt.run_id = 'another-run';
    }
  } });
  await f.service.submit(input(f.signer.request('send_message')));
  await assert.rejects(f.service.cancel({ ...input(f.signer.request('cancel_task')), runId: 'run-original' }),
    { code: changed === 'session' ? 'A2A_INBOUND_SESSION_CONFLICT' : 'A2A_INBOUND_RUN_CONFLICT' });
  const status = f.service.inspect(input(f.signer.request('get_task')));
  assert.equal(status.sessionId, 'a2a-kernel-original'); assert.equal(status.runId, 'run-original');
  assert.equal(status.uncertainOperations.length, 1); assert.equal(f.calls.length, 2);
});

test('a separately admitted continuation must retain the first Message Server Session', async t => {
  const rows = [kernelFact(1, { family: 'interaction', event_type: 'interaction.requested',
    payload: { interaction_id: 'question', revision: 1, kind: 'structured_input', request: {} } }),
  kernelFact(2, { payload: { run_id: 'run-original', state: 'waiting' } })];
  const f = await inboundFixture(t, { eventRows: rows, respond(call, data) {
    if (call.body.Continuation) data.SessionId = 'a2a-kernel-another';
  } });
  await f.service.submit(input(f.signer.request('send_message')));
  await collect(f.service.facts(input(f.signer.request('subscribe_to_task'))));
  const pending = f.service.inspect(input(f.signer.request('get_task'))).pending;
  await assert.rejects(f.service.submit({ ...input(f.signer.request('send_message', { messageId: 'answer' })), continuation: pending }),
    { code: 'A2A_INBOUND_SESSION_CONFLICT' });
  assert.deepEqual(f.service.inspect(input(f.signer.request('get_task'))).pending, pending);
});
