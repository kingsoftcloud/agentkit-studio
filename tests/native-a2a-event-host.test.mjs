import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { prepareNativeA2AHost, prepareDshA2AHost } from '../src/providers/native-a2a-host.mjs';
import { internalPeer, scope, spec } from './fixtures/native-a2a-internal-peer.mjs';
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
  f.owner.close(); const replacement = f.factory.forSession({ ...f.ownerFields, sessionId: 'session', stateRoot: join(f.root, 'state'),
    workspaceRoot: f.workspaceRoot, assertCurrent: () => false }); f.owners.push(replacement);
  await assert.rejects(replacement.eventDelivery.flush(), { code: 'A2A_EVENT_REF_INVALID' });
});
