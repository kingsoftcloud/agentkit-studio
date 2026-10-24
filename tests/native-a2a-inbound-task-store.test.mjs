import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createA2aInboundTaskStore } from '../src/providers/native-a2a-inbound-task-store.mjs';
import { kernelFact, targetBinding, platformTaskId, targetVersionId } from './fixtures/native-a2a-inbound.mjs';

const identity = { ...targetBinding, callerPrincipalType: 'runtime', callerPrincipalId: 'caller', callerRuntimeId: 'runtime-caller',
  subAccountId: null, targetAgentId: targetBinding.agentId, targetRuntimeId: targetBinding.runtimeId, targetA2aAgentId: targetBinding.a2aAgentId,
  taskBinding: { platformTaskId, targetVersionId, operation: 'send_message' } };
const message = { messageId: 'message', role: 'ROLE_USER', parts: [{ text: 'Original' }] };
const ids = { taskId: 'task-original', contextId: 'context-original' };
const submission = { sessionId: 'a2a-kernel-original', agentId: targetBinding.agentId,
  receipt: { status: 'accepted', run_id: 'run-original' } };
const runtime = (seq, payload) => kernelFact(seq, { family: 'runtime', family_version: 2, event_type: payload.event_type,
  payload: { schema_version: 2, run_id: 'run-original', scope_id: 'scope', ...payload } });
const transition = (seq, state) => kernelFact(seq, { payload: { run_id: 'run-original', state } });
function fixture(t, options = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'a2a-task-store-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = { directory, assertCurrent: () => true, ...options }, store = createA2aInboundTaskStore(config);
  const prepare = store.prepare(identity, { ...ids, message });
  store.admitted(identity, { ...ids, message, submission });
  return { directory, config, store, prepare };
}
const update = (seq, text, extra = {}) => runtime(seq, { event_type: 'item.updated', item_id: 'answer', item_kind: 'message', op: 'append',
  update: { content_type: 'text', part_id: 'p1', text }, ...extra });
const completion = seq => runtime(seq, { event_type: 'run.completed', status: 'completed', output_refs: [{ scope_id: 'scope', item_id: 'answer', part_id: null }] });

test('Task and UUID projection receipts survive cold reopen; replay does not duplicate streamed parts', t => {
  const { store, config } = fixture(t), fact = update(1, 'Hello😀');
  const first = store.apply(identity, ids, fact); assert.equal(first.updates[0].artifactUpdate.append, false);
  const cold = createA2aInboundTaskStore(config), replay = cold.apply(identity, ids, fact);
  assert.equal(replay.duplicate, true); assert.deepEqual(replay.updates, first.updates);
  assert.equal(cold.get(identity, ids).task.artifacts[0].parts[0].text, 'Hello😀');
  assert.throws(() => cold.apply(identity, ids, { ...fact, payload: { ...fact.payload, update: { ...fact.payload.update, text: 'altered' } } }),
    { code: 'A2A_INBOUND_EVENT_CONFLICT' });
  assert.throws(() => cold.apply(identity, ids, update(1, 'new UUID same seq')), { code: 'A2A_INBOUND_EVENT_ORDER_CONFLICT' });
});

test('runtime completed alone leaves working; canonical control completion requires original output refs in their order', t => {
  const { store } = fixture(t);
  store.apply(identity, ids, update(1, 'A'));
  store.apply(identity, ids, update(2, 'B', { update: { content_type: 'text', part_id: 'p2', text: 'B' } }));
  store.apply(identity, ids, update(3, 'C'));
  store.apply(identity, ids, runtime(4, { event_type: 'run.completed', output_refs: [
    { scope_id: 'scope', item_id: 'answer', part_id: 'p2' }, { scope_id: 'scope', item_id: 'answer', part_id: 'p1' }] }));
  assert.equal(store.get(identity, ids).task.status.state, 'TASK_STATE_WORKING');
  const done = store.apply(identity, ids, transition(5, 'completed'));
  assert.equal(done.task.status.message.parts[0].text, 'BAC'); assert.equal(done.updates.at(-1).statusUpdate.final, true);
  assert.throws(() => store.apply(identity, ids, transition(6, 'cancelled')), { code: 'A2A_INBOUND_TERMINAL_CONFLICT' });
});

test('canonical completion without runtime completion cannot become successful', t => {
  const { store } = fixture(t);
  assert.throws(() => store.apply(identity, ids, transition(1, 'completed')), { code: 'A2A_INBOUND_COMPLETION_UNCONFIRMED' });
  assert.equal(store.get(identity, ids).cursor, 0); assert.equal(store.get(identity, ids).task.status.state, 'TASK_STATE_WORKING');
});

test('runtime interruption survives cold reopen and requires a matching control boundary', t => {
  const { store, config } = fixture(t);
  store.apply(identity, ids, runtime(1, { event_type: 'run.interrupted', status: 'interrupted', reason: 'effect_outcome_unknown' }));
  assert.equal(store.get(identity, ids).task.status.state, 'TASK_STATE_WORKING');
  const cold = createA2aInboundTaskStore(config);
  assert.throws(() => cold.apply(identity, ids, transition(2, 'failed')), { code: 'A2A_INBOUND_TERMINAL_CONFLICT' });
  const boundary = transition(2, 'interrupted'), done = cold.apply(identity, ids, boundary);
  assert.equal(done.task.status.state, 'TASK_STATE_FAILED');
  assert.equal(done.updates.at(-1).statusUpdate.final, true);
  assert.equal(cold.apply(identity, ids, boundary).duplicate, true);
});

test('cancelled and failed canonical boundaries commit independently of transport EOF', t => {
  for (const [state, expected] of [['cancelled', 'TASK_STATE_CANCELED'], ['failed', 'TASK_STATE_FAILED'], ['interrupted', 'TASK_STATE_FAILED']]) {
    const { store } = fixture(t);
    const result = store.apply(identity, ids, transition(1, state)); assert.equal(result.task.status.state, expected);
    assert.equal(result.task.history.length, 1); assert.equal(result.pending, null);
  }
});

test('owner, principal type, caller Runtime, target Runtime and target version cannot select another Task', t => {
  const { store } = fixture(t);
  for (const changes of [{ accountId: 'other' }, { tenantId: 'other' }, { callerPrincipalId: 'other' }, { callerRuntimeId: 'other' },
    { targetRuntimeId: 'other' }, { targetAgentId: 'ar-other' }, { targetA2aAgentId: 'other' },
    { callerPrincipalType: 'user', callerRuntimeId: null, subAccountId: 'sub' }]) {
    assert.throws(() => store.get({ ...identity, ...changes }, ids), { code: 'A2A_INBOUND_TASK_NOT_FOUND' });
  }
  assert.throws(() => store.get({ ...identity, taskBinding: { ...identity.taskBinding, targetVersionId: 'other' } }, ids),
    { code: 'A2A_INBOUND_TASK_BINDING_CONFLICT' });
  assert.throws(() => store.get(identity, { ...ids, contextId: 'other' }), { code: 'A2A_INBOUND_TASK_NOT_FOUND' });
});

test('Task address is allocated once before admission and a changed original Message cannot be treated as retry', t => {
  const { store } = fixture(t);
  const retry = store.prepare(identity, { message }); assert.equal(retry.task.id, ids.taskId); assert.equal(retry.task.history.length, 1);
  assert.throws(() => store.prepare(identity, { message: { ...message, parts: [{ text: 'altered' }] } }), { code: 'A2A_INBOUND_COMMAND_CONFLICT' });
  assert.throws(() => store.prepare(identity, { message: { ...message, messageId: 'next' } }), { code: 'A2A_INBOUND_CONTINUATION_CONFLICT' });
  store.admitted(identity, { ...ids, message, submission }); assert.equal(store.get(identity, ids).task.history.length, 1);
});

test('WAITING projects only public schema; continuation pins original durable interaction even after retry clears pending', t => {
  const { store, config } = fixture(t);
  const requested = kernelFact(1, { family: 'interaction', event_type: 'interaction.requested', payload: {
    interaction_id: 'private-interaction', revision: 2, kind: 'approval', request: { presentation: { title: 'Review', description: 'Allow tool?' },
      secret: 'private-permit' } } });
  store.apply(identity, ids, requested); assert.equal(store.get(identity, ids).task.status.state, 'TASK_STATE_WORKING');
  const waiting = store.apply(identity, ids, transition(2, 'waiting'));
  assert.equal(waiting.task.status.state, 'TASK_STATE_INPUT_REQUIRED');
  assert.deepEqual(waiting.task.status.message.metadata.input_schema.enum, ['approve', 'reject']);
  assert.doesNotMatch(JSON.stringify(waiting.task), /private-interaction|private-permit|expected_revision/);
  assert.equal(store.prepare(identity, { message }).continuation, null, 'original retry never picks up new question');
  const answer = { ...message, messageId: 'answer', taskId: ids.taskId, parts: [{ text: 'approve' }] };
  const prepared = store.prepare(identity, { ...ids, message: answer });
  assert.equal(prepared.continuation.expected_revision, 2);
  store.admitted(identity, { ...ids, message: answer, submission });
  const cold = createA2aInboundTaskStore(config);
  assert.equal(cold.get(identity, ids).pending, null);
  assert.deepEqual(cold.prepare(identity, { ...ids, message: answer }).continuation, prepared.continuation);
});

test('snapshot replaces all ordered parts and reasoning stays private unless Host enabled it', t => {
  const { store } = fixture(t);
  store.apply(identity, ids, update(1, 'old'));
  store.apply(identity, ids, runtime(2, { event_type: 'item.snapshot_replaced', item_id: 'answer', item_kind: 'message',
    snapshot: { parts: [{ content_type: 'text', part_id: 'p2', text: 'new' }] } }));
  store.apply(identity, ids, update(3, 'PRIVATE', { item_id: 'thought', item_kind: 'reasoning' }));
  assert.equal(store.get(identity, ids).task.artifacts.length, 1);
  store.apply(identity, ids, completion(4));
  assert.equal(store.apply(identity, ids, transition(5, 'completed')).task.status.message.parts[0].text, 'new');
  const enabled = fixture(t, { includeReasoning: true });
  assert.equal(enabled.store.apply(identity, ids, update(1, 'thinking', { item_kind: 'reasoning' })).task.artifacts[0].parts[0].metadata.adk_thought, true);
});

test('empty output refs retains Python text fallback order; ADK snapshot/reasoning markers and final artifact closure survive wire projection', t => {
  const { store } = fixture(t);
  const first = store.apply(identity, ids, update(1, 'first'));
  assert.equal(first.task.metadata['https://google.github.io/adk-docs/a2a/a2a-extension/'].adk_agent_executor_v2, true);
  assert.equal(first.updates[0].artifactUpdate.artifact.parts[0].metadata.ksadk_output_snapshot, true);
  store.apply(identity, ids, update(2, 'second', { item_id: 'other' }));
  store.apply(identity, ids, runtime(3, { event_type: 'run.completed', output_refs: [] }));
  const done = store.apply(identity, ids, transition(4, 'completed'));
  assert.equal(done.task.status.message.parts[0].text, 'firstsecond');
  assert.equal(done.updates.filter(update => update.artifactUpdate?.lastChunk).length, 2);
  assert.equal(done.updates.at(-1).statusUpdate.metadata['https://google.github.io/adk-docs/a2a/a2a-extension/'].adk_agent_executor_v2, true);
});

test('wrong Session/Run or conflicting runtime terminal cannot alter persisted Task', t => {
  const { store } = fixture(t);
  for (const fact of [{ ...update(1, 'bad'), session_id: 'other' }, { ...update(1, 'bad'), run_id: 'other' }]) {
    assert.throws(() => store.apply(identity, ids, fact), { code: 'A2A_INBOUND_TASK_BINDING_CONFLICT' });
  }
  assert.equal(store.get(identity, ids).cursor, 0);
  store.apply(identity, ids, completion(1));
  assert.throws(() => store.apply(identity, ids, runtime(2, { event_type: 'run.canceled' })), { code: 'A2A_INBOUND_TERMINAL_CONFLICT' });
  assert.equal(store.get(identity, ids).cursor, 1);
});

test('revoked Host guard rejects both reads and writes without publishing stale facts', t => {
  let current = true; const { store } = fixture(t, { assertCurrent: () => current }); current = false;
  assert.throws(() => store.get(identity, ids), { code: 'A2A_INBOUND_AUTHORITY_LOST' });
  assert.throws(() => store.apply(identity, ids, update(1, 'stale')), { code: 'A2A_INBOUND_AUTHORITY_LOST' });
});
