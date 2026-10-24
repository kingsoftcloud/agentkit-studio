// Real HTTP transport, private journal and cross-process admission locks.
// Explicit Host authority/audit is a declared double; the maintained-service
// verifier separately proves actual Session approval audit integration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { prepareNativeA2AHost, prepareDshA2AHost } from '../src/providers/native-a2a-host.mjs';
import { normalizeA2aInputParts } from '../src/providers/native-a2a-decision.mjs';
import { internalPeer, scope, spec } from './fixtures/native-a2a-internal-peer.mjs';
import { controlConsent } from './fixtures/native-a2a-control-consent.mjs';
const signal = () => new AbortController().signal;
const task = (schema, messageId = 'question') => ({ id: 'original-remote', contextId: 'original-context',
  status: { state: 'TASK_STATE_INPUT_REQUIRED', message: { messageId, role: 'ROLE_AGENT', parts: [{ text: 'Answer' }],
    metadata: { input_schema: schema } } } });
async function setup(t, { dsh = false, schema = { type: 'string' }, answer = 'Shanghai', ...options } = {}) {
  const f = await internalPeer({ initialTask: task(schema), expectedContinuationParts: [{ data: answer }], ...options });
  const fields = dsh ? { agentId: 'agent', agentRevision: 1, buildId: null } : { scope };
  let consent = controlConsent, factory, owner;
  const factories = [];
  const open = () => {
    factory = (dsh ? prepareDshA2AHost : prepareNativeA2AHost)({ env: f.env, bindings: [spec] }); factories.push(factory);
    owner = factory.forSession({ ...fields, sessionId: 'session', stateRoot: join(f.root, 'state'), workspaceRoot: f.workspaceRoot,
      assertCurrent: () => true, assertControl: () => true, authorizeControl: input => input.readOnly ? 'allow' : consent(input) });
    f.owners.push(owner);
  };
  open(); t.after(async () => { await Promise.all(factories.map(item => item.close())); await f.close(); });
  const request = await owner.invocation.resolve({ agent: 'research', message: 'initial', signal: signal(),
    [dsh ? 'dshRequest' : 'nativeRequest']: { ...fields, sessionId: 'session', ...(dsh ? {} : { runId: 'run' }),
      operationKey: 'operation', call: { callId: 'call' } } });
  assert.equal((await owner.invocation.dispatch({ request, signal: signal() })).state, 'input_required');
  const get = () => owner.control.execute({ kind: 'get', commandId: 'read', operation_locator: request.identity, authority: {}, signal: signal() });
  const before = await get();
  const command = (parts = [{ data: answer }], commandId = 'answer', pauseDigest = before.pauseDigest) => ({
    kind: 'continue', commandId, parts, pauseDigest, operation_locator: request.identity, authority: {}, signal: signal() });
  return { ...f, before, command, get, execute: input => owner.control.execute(input),
    authorize: value => { consent = value; },
    reopen: async () => { await factory.close(); open(); },
    decisions: () => f.record().managed.events.log.filter(event => event.event_type === 'interaction.resolved'),
  };
}

for (const dsh of [false, true]) test(`${dsh ? 'DSH' : 'Native'} input: actual answer and audit share the durable effect intent`, async t => {
  const f = await setup(t, { dsh }); const input = f.command([{ data: { result: 'Shanghai' } }]);
  assert.equal(f.before.input.request.request_type, 'structured_input');
  f.setHook(call => {
    if (call.wireMethod !== 'SendMessage') return;
    const record = f.record(), entry = Object.values(record.controls).find(entry => entry.command.commandId === input.commandId);
    assert.equal(entry.phase, 'sending');
    assert.deepEqual(entry.command.parts, [{ data: 'Shanghai' }]);
    assert.equal(entry.hostDecision.kind, 'structured_input');
    assert.equal(f.decisions().length, 1);
    assert.deepEqual(f.decisions()[0].response, { response_type: 'structured_input', data: 'Shanghai' });
    assert.equal(f.decisions()[0].source.metadata.command_digest, entry.digest);
    assert.equal(f.decisions()[0].source.metadata.host_outcome, 'submitted');
  });
  const result = await f.execute(input); assert.equal(result.outcome, 'submitted');
  assert.equal(f.decisions().length, 1, 'remote completion cannot overwrite or duplicate the submitted answer');
  const calls = f.calls.filter(call => call.wireMethod).length, saved = f.decisions();
  await f.reopen();
  assert.deepEqual(await f.execute({ ...input, signal: signal() }), result);
  assert.deepEqual(await f.execute(f.command()), result, 'equivalent normalized input keeps the same command');
  assert.equal(f.calls.filter(call => call.wireMethod).length, calls); assert.deepEqual(f.decisions(), saved);
  await assert.rejects(f.execute(f.command([{ data: 'different' }])), { code: 'A2A_CONTROL_IDEMPOTENCY_CONFLICT' });
});

test('a confirmed continuation opens a fresh identical question; repeated reads cannot create another opportunity', async t => {
  const f = await setup(t, { continuationTasks: [task({ type: 'string' })] });
  await f.execute(f.command()); const second = await f.get();
  assert.notEqual(second.input.interactionId, f.before.input.interactionId);
  assert.notEqual(second.pauseDigest, f.before.pauseDigest); assert.equal(second.input.decision, null);
  assert.deepEqual((await f.get()).input, second.input);
  await f.execute(f.command([{ data: 'Shanghai' }], 'second-answer', second.pauseDigest));
  assert.equal(f.decisions().length, 2); assert.notEqual(f.decisions()[0].interaction_id, f.decisions()[1].interaction_id);
});

test('a duplicate is interpreted against the original schema after another question and a Host restart', async t => {
  const f = await setup(t, { continuationTasks: [task({ type: 'object' }, 'next-question')] });
  const input = f.command([{ data: { result: 'Shanghai' } }]), first = await f.execute(input);
  await f.reopen(); const calls = f.calls.filter(call => call.wireMethod).length;
  assert.deepEqual(await f.execute({ ...input, signal: signal() }), first);
  assert.equal(f.calls.filter(call => call.wireMethod).length, calls);
  assert.equal(f.decisions().length, 1);
});

test('uncertain input retains the answer and cannot resend under an old or fresh command id', async t => {
  const f = await setup(t); f.setMode('send-lost'); const input = f.command();
  assert.equal((await f.execute(input)).outcome, 'unknown'); const saved = f.decisions();
  await f.reopen(); assert.equal((await f.execute({ ...input, signal: signal() })).outcome, 'unknown');
  assert.equal((await f.execute(f.command(undefined, 'new-id'))).outcome, 'already_terminal');
  assert.deepEqual(f.decisions(), saved); assert.equal(f.calls.filter(call => call.wireMethod === 'SendMessage').length, 2);
});

test('invalid input, untrusted consent and denied consent cannot publish an answer or supplemental effect', async t => {
  const f = await setup(t); let asked = 0;
  f.authorize(input => { asked++; return controlConsent(input); });
  for (const parts of [[{ text: 'Shanghai' }], [{ data: 'Shanghai', metadata: {} }], [{ data: 'Shanghai' }, { data: 'extra' }]])
    await assert.rejects(f.execute(f.command(parts)), { code: 'A2A_STRUCTURED_INPUT_REQUIRED' });
  await assert.rejects(f.execute(f.command([{ data: 3 }])), { code: 'A2A_STRUCTURED_INPUT_INVALID' });
  assert.equal(asked, 0, 'invalid answers never ask for an execution grant');
  f.authorize(() => 'allow'); await assert.rejects(f.execute(f.command()), { code: 'A2A_HOST_DECISION_REQUIRED' });
  f.authorize(() => 'deny'); await assert.rejects(f.execute(f.command()), { code: 'A2A_CONTROL_PERMISSION_DENIED' });
  assert.deepEqual(f.decisions(), []); assert.equal(f.calls.filter(call => call.wireMethod === 'SendMessage').length, 1);
  assert.equal(f.calls.filter(call => call.wireMethod === 'CancelTask').length, 0);
});

test('question change during consent cannot redirect an already approved answer', async t => {
  const f = await setup(t);
  f.authorize(input => { f.setTask(task({ type: 'string' }, 'changed-question')); return controlConsent(input); });
  await assert.rejects(f.execute(f.command()), { code: 'A2A_CONTINUATION_NOT_ALLOWED' });
  assert.equal(f.decisions().filter(event => event.source.metadata.host_decision).length, 0);
  assert.equal(f.calls.filter(call => call.wireMethod === 'SendMessage').length, 1);
});

test('nested result envelopes are unwrapped once, while object schemas preserve their result property', async t => {
  for (const [schema, raw, answer] of [[{}, { result: { result: 3 } }, { result: 3 }],
    [{ type: 'object' }, { result: 'Shanghai' }, { result: 'Shanghai' }]]) {
    const f = await setup(t, { schema, answer }); await f.execute(f.command([{ data: raw }]));
    assert.deepEqual(f.decisions()[0].response.data, answer);
  }
});

test('cancellation records withdrawn input without fabricating an answer', async t => {
  const f = await setup(t);
  const input = f.command(); delete input.parts; delete input.pauseDigest; input.kind = 'cancel';
  assert.equal((await f.execute(input)).outcome, 'remote_cancelled');
  assert.equal(f.decisions().length, 1);
  assert.deepEqual(f.decisions()[0].response, { response_type: 'structured_input', data: null });
  assert.equal(f.decisions()[0].source.metadata.host_outcome, 'canceled');
  assert.equal(f.calls.filter(call => call.wireMethod === 'SendMessage').length, 1);
});

// Pure normalization boundary: schema values are facts, never authority.
test('input normalization preserves JSON primitives, arrays, exact integers and negative zero', () => {
  for (const [schema, raw, expected] of [
    [{ type: 'string' }, { result: '' }, ''], [{ type: 'boolean' }, { result: false }, false],
    [{ type: 'array', items: { type: 'number' } }, { result: [1, 2] }, [1, 2]],
    [{ type: 'null' }, { result: null }, null], [{ type: 'number' }, { result: -0 }, -0],
    [{ type: 'integer' }, { result: 9007199254740993n }, 9007199254740993n],
  ]) {
    const record = { projection: { state: 'input_required' }, managed: { events: { adapter: {
      activeInteraction: { id: 'input', kind: 'structured_input', continuation: 'continue' } }, log: [{
      event_type: 'interaction.requested', interaction_id: 'input', interaction_kind: 'structured_input',
      request: { request_type: 'structured_input', schema } }] } } };
    assert.deepEqual(normalizeA2aInputParts(record, [{ data: raw }]), [{ data: expected }]);
  }
});

test('unsupported external input schemas cannot fetch resources or request an execution grant', async t => {
  const f = await setup(t, { schema: { $ref: 'https://example.invalid/schema' } });
  let asked = 0; f.authorize(input => { asked++; return controlConsent(input); });
  await assert.rejects(f.execute(f.command()), { code: 'A2A_INPUT_SCHEMA_INVALID' });
  assert.equal(asked, 0); assert.deepEqual(f.decisions(), []);
});
