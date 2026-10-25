import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { prepareNativeA2AHost, prepareDshA2AHost } from '../src/providers/native-a2a-host.mjs';
import { internalPeer, scope, spec } from './fixtures/native-a2a-internal-peer.mjs';
import { A2A_TOOL_ACTIVITY_URI } from '../src/providers/native-a2a-tool-activity.mjs';
const signal = () => new AbortController().signal;
const appends = f => f.calls.filter(call => call.action === 'AppendA2ATaskEvents');
const taskCalls = f => f.calls.filter(call => call.action !== 'AppendA2ATaskEvents');
async function setup(t, dsh = false, options = {}) {
  const f = await internalPeer(options), prepare = dsh ? prepareDshA2AHost : prepareNativeA2AHost;
  const ownerFields = dsh ? { agentId: 'agent', agentRevision: 1, buildId: null } : { scope };
  const factory = prepare({ env: f.env, bindings: [spec] });
  const owner = factory.forSession({ ...ownerFields, sessionId: 'session', stateRoot: join(f.root, 'state'), workspaceRoot: f.workspaceRoot,
    assertCurrent: () => true, assertControl: () => true, authorizeControl: async () => 'allow' });
  f.owners.push(owner); t.after(async () => { await factory.close(); await f.close(); });
  const request = await owner.invocation.resolve({ agent: 'research', message: 'Hello😀', signal: signal(),
    [dsh ? 'dshRequest' : 'nativeRequest']: { ...ownerFields, sessionId: 'session', ...(dsh ? {} : { runId: 'run' }),
      operationKey: 'operation', call: { callId: 'call' } } });
  return { ...f, prepare, factory, owner, request, ownerFields, dispatch: () => owner.invocation.dispatch({ request, signal: signal() }) };
}
for (const dsh of [false, true]) test(`${dsh ? 'DSH' : 'Native'} actual managed Host appends canonical lifecycle facts, retains replay and reopens without a turn`, async t => {
  const f = await setup(t, dsh); assert.equal((await f.dispatch()).state, 'completed');
  await f.owner.eventDelivery.flush(); const log = f.owner.eventDelivery.replay(f.request.identity);
  assert.deepEqual(log.map(e => (e.initial ?? e.snapshot).parts[0].data.status), ['submitted', 'working', 'completed']);
  assert.deepEqual(appends(f).flatMap(call => call.body.Events), log);
  assert.equal(f.owner.eventDelivery.status().pending, 0); assert.equal(f.record().managed.events.delivered, 3);
  assert.equal(log.at(-1).event_type, 'item.completed'); assert.ok(log.every(e => !e.event_type.startsWith('run.')));
  assert.doesNotMatch(JSON.stringify(log), /private-permit|Bearer|public-token|external-key/);
  const original = JSON.stringify(f.record()), calls = f.calls.length; await f.factory.close();
  const replacement = f.prepare({ env: f.env, bindings: [spec] }); t.after(() => replacement.close());
  assert.equal(replacement.restoreEvents({ stateRoot: join(f.root, 'state'), workspaceRoot: f.workspaceRoot }), 0);
  await replacement.close(); assert.equal(f.calls.length, calls); assert.equal(JSON.stringify(f.record()), original);
});
test('lost event acknowledgement retries identical facts with rotated task-sink auth and no task effect replay', async t => {
  const f = await setup(t); let lost = true;
  f.setHook((call, res) => { if (call.action === 'AppendA2ATaskEvents' && lost) res.destroy(); });
  assert.equal((await f.dispatch()).state, 'completed'); await f.owner.eventDelivery.flush({ raiseOnError: false });
  assert.ok(f.owner.eventDelivery.status().pending > 0); const before = taskCalls(f).length, first = appends(f)[0];
  const log = f.owner.eventDelivery.replay(f.request.identity), beforeRotation = appends(f).length; f.rotate('a2a-task-sink', 9); lost = false;
  await f.owner.eventDelivery.flush(); assert.equal(f.owner.eventDelivery.status().pending, 0);
  const retry = appends(f).slice(beforeRotation).find(call => call.body.Events[0].event_id === first.body.Events[0].event_id);
  assert.ok(retry); assert.deepEqual(retry.body, first.body); assert.notEqual(retry.headers.authorization, first.headers.authorization);
  assert.equal(taskCalls(f).length, before); assert.deepEqual(f.owner.eventDelivery.replay(f.request.identity), log);
});
test('permanent delivery failure is durable and visible after all later batches are delivered', async t => {
  const f = await setup(t); let poison = true;
  f.setHook((call, res) => { if (call.action === 'AppendA2ATaskEvents' && poison) {
    poison = false; res.statusCode = 400; res.end(JSON.stringify({ Code: 400, Message: 'private-permit',
      Data: { ErrorCode: 'A2A_EVENT_REF_INVALID', Details: { token: 'secret' } } }));
  } });
  assert.equal((await f.dispatch()).state, 'completed'); await assert.rejects(f.owner.eventDelivery.flush(), { code: 'A2A_EVENT_REF_INVALID' });
  const status = f.owner.eventDelivery.status(); assert.equal(status.pending, 0); assert.equal(status.deadLetters, 1);
  assert.equal(status.error, 'A2A_EVENT_REF_INVALID'); assert.equal(f.record().managed.events.deadLetters[0].lastError, 'A2A_EVENT_REF_INVALID');
  assert.doesNotMatch(JSON.stringify(f.record().managed.events), /private-permit|secret|Bearer/);
  const inspect = owner => owner.control.execute({ kind: 'get', commandId: 'inspect-delivery',
    operation_locator: f.request.identity, authority: { user: 'approved' }, signal: signal() });
  const before = taskCalls(f).length, view = await inspect(f.owner);
  assert.equal(view.state, 'completed');
  assert.deepEqual(view.eventDelivery, { contract: 'agentkit.a2a-event-delivery-status/v1', state: 'failed',
    pendingBatches: 0, acknowledgedBatches: f.record().managed.events.delivered, failedBatches: 1, errorCode: 'A2A_EVENT_REF_INVALID' });
  assert.equal(taskCalls(f).length, before, 'reading delivery status never re-executes the completed task or GetTask');
  f.owner.close(); const replacement = f.factory.forSession({ ...f.ownerFields, sessionId: 'session', stateRoot: join(f.root, 'state'),
    workspaceRoot: f.workspaceRoot, assertCurrent: () => true, assertControl: () => true, authorizeControl: async () => 'allow' }); f.owners.push(replacement);
  await assert.rejects(replacement.eventDelivery.flush(), { code: 'A2A_EVENT_REF_INVALID' });
  assert.deepEqual((await inspect(replacement)).eventDelivery, view.eventDelivery);
  assert.equal(taskCalls(f).length, before);
});
for (const dsh of [false, true]) test(`${dsh ? 'DSH' : 'Native'} actual SSE content and final GetTask checkpoint commit with the outbox`, async t => {
  const remote = { taskId: 'original-remote', contextId: 'original-context' };
  const f = await setup(t, dsh, { streaming: true,
    initialTask: { id: remote.taskId, contextId: remote.contextId, status: { state: 'TASK_STATE_COMPLETED' },
      artifacts: [{ artifactId: 'report', name: 'report', parts: [{ text: 'authoritative result' }, { raw: 'AAEC/w==', mediaType: 'application/octet-stream' },
        { data: { ok: true }, metadata: { kind: 'tool_result', call_id: 'remote-tool', is_error: {} } }] }],
      history: [{ messageId: 'answer', role: 'ROLE_AGENT', parts: [{ text: 'final message' }] }] },
    streamUpdates: [{ artifactUpdate: { ...remote, artifact: { artifactId: 'report', parts: [{ text: 'provisional' }] }, lastChunk: true, metadata: { event_id: 'first', seq: 1 } } },
      { statusUpdate: { ...remote, status: { state: 'TASK_STATE_COMPLETED' } } }] });
  assert.equal((await f.dispatch()).state, 'completed'); await f.owner.eventDelivery.flush();
  assert.equal(f.calls.filter(call => call.wireMethod === 'GetTask').length, 1);
  const journal = f.record().managed.events, completed = journal.log.find(e => e.item_kind === 'artifact' && e.event_type === 'item.completed');
  assert.deepEqual(completed.snapshot.parts.map(part => part.content_type), ['text', 'artifact', 'tool_result']);
  assert.equal(completed.snapshot.parts[0].text, 'authoritative result'); assert.equal(completed.snapshot.parts[1].data.base64, 'AAEC/w==');
  assert.equal(completed.snapshot.parts[2].is_error, false); assert.equal(journal.descriptor.output_refs.length, 2);
  assert.equal(journal.adapter.terminalFingerprint.length, 64); assert.equal(journal.pending.length, 0);
  assert.deepEqual(appends(f).flatMap(call => call.body.Events), journal.log);
  const before = JSON.stringify(f.record()), effects = taskCalls(f).length;
  assert.equal((await f.dispatch()).state, 'completed'); assert.equal(taskCalls(f).length, effects); assert.equal(JSON.stringify(f.record()), before);
});
test('lost authoritative GetTask receipt leaves send unknown and cold dispatch cannot send or read again', async t => {
  const f = await setup(t, false, { mode: 'get-lost' }); assert.equal((await f.dispatch()).state, 'unknown');
  await f.owner.eventDelivery.flush(); const original = f.record();
  assert.equal(original.projection.state, 'working'); assert.equal(original.projection.pendingTerminal, 'completed');
  assert.equal(original.managed.events.adapter.terminalFingerprint, undefined);
  const before = taskCalls(f).length; assert.equal((await f.dispatch()).state, 'unknown'); assert.equal(taskCalls(f).length, before);
  assert.equal(f.calls.filter(call => call.wireMethod === 'SendMessage').length, 1);
  assert.equal(f.calls.filter(call => call.wireMethod === 'GetTask').length, 1);
});
test('actual direct Message maps content without remote Task binding or fabricated GetTask', async t => {
  const f = await setup(t, false, { directMessage: { messageId: 'direct', role: 'ROLE_AGENT', parts: [{ text: 'answer' }] } });
  assert.equal((await f.dispatch()).state, 'completed'); await f.owner.eventDelivery.flush();
  assert.deepEqual(f.calls.filter(call => call.wireMethod).map(call => call.wireMethod), ['SendMessage']);
  assert.equal(f.record().managed.remote, undefined);
  const events = f.record().managed.events.log;
  assert.deepEqual(events.filter(event => event.item_kind === 'message').map(e => e.event_type), ['item.started', 'item.updated', 'item.completed']);
  assert.equal(f.record().managed.events.descriptor.output_refs.length, 1);
});
for (const dsh of [false, true]) test(`${dsh ? 'DSH' : 'Native'} public tool activity travels through actual SSE/GetTask and durable outbox without local execution`, async t => {
  const remote = { taskId: 'original-remote', contextId: 'original-context' };
  const value = { event_id: 'started', item_id: 'remote-item', call_id: 'remote-call', item_kind: 'tool_call', operation: 'started',
    execution_status: 'running', name: 'remote_execute', arguments: { command: 'displayed only', apiKey: '[REDACTED]' } };
  const activity = data => ({ artifactId: 'remote-tool', metadata: { extension_uri: A2A_TOOL_ACTIVITY_URI }, parts: [{ data }] });
  const first = { artifactUpdate: { ...remote, artifact: activity(value), lastChunk: true } };
  const f = await setup(t, dsh, { streaming: true,
    streamUpdates: [first, first, { artifactUpdate: { ...remote, artifact: activity({ ...value, arguments: { apiKey: 'NEVER_ECHO' } }) } }],
    initialTask: { id: remote.taskId, contextId: remote.contextId, status: { state: 'TASK_STATE_COMPLETED' },
      artifacts: [activity({ ...value, event_id: 'completed', operation: 'completed', execution_status: 'completed' }),
        { artifactId: 'result', parts: [{ text: 'actual final result' }] }] } });
  assert.equal((await f.dispatch()).state, 'completed'); await f.owner.eventDelivery.flush();
  assert.equal(f.calls.filter(call => call.wireMethod === 'SendStreamingMessage').length, 1);
  assert.equal(f.calls.filter(call => call.wireMethod === 'GetTask').length, 1);
  const journal = f.record().managed.events, tools = journal.log.filter(event => event.item_kind === 'tool_call');
  assert.deepEqual(tools.map(event => event.event_type), ['item.started', 'item.updated', 'item.completed']);
  assert.equal(tools[1].update.name, 'remote_execute');
  assert.deepEqual(tools[2].snapshot.parts, [tools[1].update]);
  assert.ok(tools.every(event => event.source.metadata.remote_observation === true));
  assert.doesNotMatch(JSON.stringify(journal), /NEVER_ECHO/);
  assert.doesNotMatch(JSON.stringify(f.record().projection), /NEVER_ECHO/);
  assert.equal(journal.descriptor.output_refs.length, 1);
  assert.equal(journal.pending.length, 0);
  assert.deepEqual(appends(f).flatMap(call => call.body.Events), journal.log);
  assert.equal(f.record().projection.output_refs.length, 1);
  assert.deepEqual(Object.values(f.record().projection.snapshots), [{ p0: 'actual final result' }]);
  const bytes = JSON.stringify(f.record()), count = taskCalls(f).length;
  assert.equal((await f.dispatch()).state, 'completed');
  assert.equal(taskCalls(f).length, count); assert.equal(JSON.stringify(f.record()), bytes);
});
