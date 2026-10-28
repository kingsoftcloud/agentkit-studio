// Real control-plane/peer HTTP, private fsynced journal and SQLite admission
// locks. Only the explicit Host consent/audit authority is a declared double.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { prepareNativeA2AHost, prepareDshA2AHost } from '../src/providers/native-a2a-host.mjs';
import { A2A_HOST_DECISION, a2aDecisionDigest } from '../src/providers/native-a2a-decision.mjs';
import { internalPeer, scope, spec } from './fixtures/native-a2a-internal-peer.mjs';

export const remoteApprovalTask = () => ({ id: 'original-remote', contextId: 'original-context',
  status: { state: 'TASK_STATE_INPUT_REQUIRED', message: { messageId: 'approval-question', role: 'ROLE_AGENT',
    parts: [{ text: 'Approval required' }], metadata: { input_schema: { type: 'string', enum: ['approve', 'reject'] },
      ksadk_interaction: { version: 1, kind: 'approval', allowed_decisions: ['approve', 'reject'],
        presentation: { title: 'remote_write', description: '{"arguments":{"path":"report.txt"}}' } } } } } });
const signal = () => new AbortController().signal;
async function setup(t, dsh = false, options = {}) {
  const f = await internalPeer({ initialTask: remoteApprovalTask(), expectedContinuationParts: [{ data: 'approve' }], ...options });
  const prepare = dsh ? prepareDshA2AHost : prepareNativeA2AHost;
  const fields = dsh ? { agentId: 'agent', agentRevision: 1, buildId: null } : { scope };
  const factories = []; let authorize, hostCurrent = true;
  const consent = async ({ command }) => authorize ? authorize(command) : { decision: 'allow', commandDigest: a2aDecisionDigest(command),
    receipt: { contract: A2A_HOST_DECISION, sessionId: 'session', presetId: 'preset', requestId: 'host-request',
      callId: 'exact-command', toolName: `a2a_${command.kind}_task`, requestDigest: 'a'.repeat(64),
      outcome: 'allowed-once', askedSeq: 0, decidedSeq: 1 } };
  function open() {
    const factory = prepare({ env: f.env, bindings: [spec] }); factories.push(factory);
    const owner = factory.forSession({ ...fields, sessionId: 'session', stateRoot: join(f.root, 'state'), workspaceRoot: f.workspaceRoot,
      assertCurrent: () => true, assertControl: () => hostCurrent, authorizeControl: consent });
    f.owners.push(owner); return { factory, owner };
  }
  let { factory, owner } = open();
  t.after(async () => { await Promise.all(factories.map(value => value.close())); await f.close(); });
  const request = await owner.invocation.resolve({ agent: 'research', message: 'initial', signal: signal(),
    [dsh ? 'dshRequest' : 'nativeRequest']: { ...fields, sessionId: 'session', ...(dsh ? {} : { runId: 'run' }),
      operationKey: 'operation', call: { callId: 'call' } } });
  assert.equal((await owner.invocation.dispatch({ request, signal: signal() })).state, 'input_required');
  await owner.eventDelivery.flush();
  const get = () => owner.control.execute({ kind: 'get', commandId: 'read', operation_locator: request.identity, authority: {}, signal: signal() });
  const before = await get();
  const input = (kind = 'continue', commandId = 'decision', extra = {}) => ({ kind, commandId, operation_locator: request.identity,
    authority: {}, signal: signal(), ...(kind === 'continue' ? { pauseDigest: before.pauseDigest, parts: [{ data: 'approve' }] }
      : kind === 'reject' ? { pauseDigest: before.pauseDigest } : {}), ...extra });
  return { ...f, request, before, input, get, execute: input => owner.control.execute(input),
    authorize: value => { authorize = value; }, revoke: () => { hostCurrent = false; },
    async reopen() { await factory.close(); ({ factory, owner } = open()); },
    async flush() { await owner.eventDelivery.flush(); },
    decisions: () => f.record().managed.events.log.filter(event => event.event_type === 'interaction.resolved') };
}
for (const dsh of [false, true]) for (const kind of ['continue', 'cancel', 'reject']) test(`${dsh ? 'DSH' : 'Native'} ${kind}: durable Host decision and intent precede the original remote effect`, async t => {
  const f = await setup(t, dsh); assert.equal(f.before.approval.request.request_type, 'approval');
  const request = f.input(kind), interaction = f.before.approval.interactionId;
  f.setHook(call => {
    if (call.wireMethod === (kind === 'continue' ? 'SendMessage' : 'CancelTask')) {
      const record = f.record(), [event] = f.decisions(); assert.ok(event);
      assert.equal(event.interaction_id, interaction); assert.equal(event.source.metadata.host_decision.requestId, 'host-request');
      const entry = Object.values(record.controls).find(value => value.command.commandId === request.commandId);
      assert.equal(entry.phase, 'sending'); assert.equal(entry.digest, event.source.metadata.command_digest);
    }
  });
  const result = await f.execute(request); await f.flush();
  assert.equal(result.outcome, kind === 'continue' ? 'submitted' : 'remote_cancelled');
  const [decision] = f.decisions(); assert.equal(f.decisions().length, 1);
  assert.deepEqual(decision.response, { response_type: 'approval', decision: kind === 'continue' ? 'approved' : kind === 'reject' ? 'rejected' : 'canceled', data: null });
  const log = f.record().managed.events.log; assert.deepEqual(log.map(event => event.seq), log.map((_, i) => i + 1));
  assert.ok(log.every(event => !event.event_type.startsWith('run.')));
  assert.deepEqual(f.calls.filter(call => call.action === 'AppendA2ATaskEvents').flatMap(call => call.body.Events), log);
  const network = f.calls.filter(call => call.wireMethod).length; await f.reopen();
  assert.deepEqual(await f.execute({ ...request, signal: signal() }), result);
  assert.equal(f.calls.filter(call => call.wireMethod).length, network); assert.deepEqual(f.decisions(), [decision]);
});
test('remote progress alone never creates a Host decision', async t => {
  const f = await setup(t); f.setTask({ ...remoteApprovalTask(), status: { state: 'TASK_STATE_COMPLETED' } });
  await f.get(); assert.deepEqual(f.decisions(), []);
});
test('a bare allow, invalid audit, foreign session, mismatched command or non-approve input cannot authorize an approval', async t => {
  const f = await setup(t);
  for (const value of ['allow', { decision: 'allow', commandDigest: 'b'.repeat(64) },
    { decision: 'allow', receipt: {} }, { decision: 'allow', receipt: { contract: A2A_HOST_DECISION, sessionId: 'foreign' } }]) {
    f.authorize(command => typeof value === 'string' ? value : { commandDigest: a2aDecisionDigest(command), ...value });
    await assert.rejects(f.execute(f.input()), /A2A_HOST_DECISION/);
  }
  f.authorize(undefined);
  for (const parts of [[{ text: 'approve' }], [{ data: 'reject' }], [{ data: { type: 'approve' } }], [{ data: 'approve', metadata: {} }]])
    await assert.rejects(f.execute(f.input('continue', 'invalid-input', { parts })), { code: 'A2A_APPROVAL_RESPONSE_INVALID' });
  assert.deepEqual(f.decisions(), []);
  assert.equal(f.calls.filter(call => call.wireMethod === 'SendMessage').length, 1);
  assert.equal(f.calls.filter(call => call.wireMethod === 'CancelTask').length, 0);
});
test('lost continuation response retains the decided fact and never reuses it to resend', async t => {
  const f = await setup(t); f.setMode('send-lost'); const request = f.input();
  assert.equal((await f.execute(request)).outcome, 'unknown'); const decisions = f.decisions(); assert.equal(decisions.length, 1);
  await f.reopen(); assert.equal((await f.execute({ ...request, signal: signal() })).outcome, 'unknown');
  assert.equal((await f.execute(f.input('continue', 'fresh-id'))).outcome, 'already_terminal');
  assert.deepEqual(f.decisions(), decisions); assert.equal(f.calls.filter(call => call.wireMethod === 'SendMessage').length, 2);
});
test('revoked Host authority during consent cannot commit a decision or enter a transport', async t => {
  const f = await setup(t); f.authorize(() => { f.revoke(); return 'allow'; });
  await assert.rejects(f.execute(f.input()), { code: 'A2A_CONTROL_AUTHORITY_LOST' }); assert.deepEqual(f.decisions(), []);
  assert.equal(f.calls.filter(call => call.wireMethod === 'SendMessage').length, 1);
});
test('rejection must target the original still-pending approval and exact pause', async t => {
  const f = await setup(t);
  await assert.rejects(f.execute(f.input('reject', 'stale', { pauseDigest: 'b'.repeat(64) })), { code: 'A2A_APPROVAL_REJECTION_NOT_ALLOWED' });
  assert.deepEqual(f.decisions(), []); assert.equal(f.calls.filter(call => call.wireMethod === 'CancelTask').length, 0);
});
test('a confirmed response may ask the identical approval again, while repeated reads cannot create another decision opportunity', async t => {
  const f = await setup(t, false, { continuationTasks: [remoteApprovalTask()] });
  const first = await f.execute(f.input()); assert.equal(first.state, 'input_required');
  assert.notEqual(first.approval.interactionId, f.before.approval.interactionId); assert.equal(first.approval.decision, null);
  const interactions = () => f.record().managed.events.log.filter(event => event.event_type === 'interaction.requested');
  assert.equal(interactions().length, 2); await f.get(); await f.get(); assert.equal(interactions().length, 2);
  const second = await f.execute(f.input('continue', 'second-approval', { pauseDigest: first.pauseDigest }));
  assert.equal(second.state, 'completed'); assert.equal(f.decisions().length, 2);
  assert.notEqual(f.decisions()[0].interaction_id, f.decisions()[1].interaction_id);
  assert.equal(f.record().managed.events.log.filter(event => event.event_type === 'continuation.resumed').length, 2);
});
for (const kind of ['continue', 'reject']) test(`${kind}: a changed question after consent cannot receive the previous decision`, async t => {
  const f = await setup(t), next = remoteApprovalTask(); next.status.message.messageId = 'different-question';
  f.setTask(next);
  await assert.rejects(f.execute(f.input(kind)), { code: kind === 'continue' ? 'A2A_CONTINUATION_NOT_ALLOWED' : 'A2A_APPROVAL_REJECTION_NOT_ALLOWED' });
  assert.deepEqual(f.decisions(), []); assert.equal(f.calls.filter(call => call.wireMethod === 'SendMessage').length, 1);
  assert.equal(f.calls.filter(call => call.wireMethod === 'CancelTask').length, 0);
});
test('a typed prompt whose canonical wait was retired cannot fall back to ordinary input authorization', async t => {
  const f = await setup(t);
  f.setTask({ ...remoteApprovalTask(), status: { state: 'TASK_STATE_WORKING' } }); await f.get();
  f.setTask(remoteApprovalTask()); const paused = await f.get(); assert.equal(paused.state, 'input_required');
  f.authorize(() => 'allow');
  await assert.rejects(f.execute(f.input('continue', 'retired-prompt', { pauseDigest: paused.pauseDigest })), { code: 'A2A_APPROVAL_REQUEST_MISSING' });
  assert.deepEqual(f.decisions(), []); assert.equal(f.calls.filter(call => call.wireMethod === 'SendMessage').length, 1);
  assert.equal((await f.execute(f.input('cancel', 'retire-remote'))).outcome, 'remote_cancelled');
});
