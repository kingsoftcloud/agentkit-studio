// Real HTTP Actions, peer JSON-RPC/REST/SSE, token files, journals and SQLite.
// Gateway/issuer/model services are controlled; authority callbacks are explicit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { prepareNativeA2AHost, prepareDshA2AHost } from '../src/providers/native-a2a-host.mjs';
import { a2aSse } from '../src/providers/native-a2a-protocol.mjs';
import { validateNativeA2aControlRequest } from '../src/host/services/native-a2a-control.mjs';
import { validateDshA2aRequest } from '../src/host/services/dsh-a2a-control.mjs';
import { internalPeer, spec, scope, taskId } from './fixtures/native-a2a-internal-peer.mjs';
import { controlConsent } from './fixtures/native-a2a-control-consent.mjs';

const signal = () => new AbortController().signal;
const task = (state = 'WORKING', extra = {}) => ({ id: 'original-remote', contextId: 'original-context',
  status: { state: `TASK_STATE_${state}` }, ...extra });
async function setup(t, options = {}) {
  const f = await internalPeer({ mode: 'pause', streaming: true, ...options });
  const binding = options.dsh ? { agentId: 'agent', agentRevision: 3, buildId: 'build' } : { scope };
  const factory = (options.dsh ? prepareDshA2AHost : prepareNativeA2AHost)({ env: f.env, bindings: [spec] });
  let allowed = true;
  const owner = () => {
    const value = factory.forSession({ ...binding, sessionId: 'session', workspaceRoot: f.workspaceRoot,
      stateRoot: join(f.root, 'state'), assertCurrent: () => true, assertControl: () => allowed,
      authorizeControl: request => { if (request.command.kind === 'subscribe') assert.equal(request.readOnly, true); return controlConsent(request); } });
    f.owners.push(value); return value;
  };
  const original = owner(), request = await original.invocation.resolve({ agent: 'research', message: 'Hello😀', signal: signal(),
    [options.dsh ? 'dshRequest' : 'nativeRequest']: { ...binding, sessionId: 'session', ...(options.dsh ? {} : { runId: 'run' }),
      operationKey: 'original-operation', call: { callId: 'call' } } });
  assert.equal((await original.invocation.dispatch({ request, signal: signal() })).state, 'input_required');
  const control = (kind = 'subscribe', commandId = 'watch', abortSignal = signal(), target = original) => target.control.execute({
    kind, commandId, operation_locator: request.identity, authority: { human: 'local' }, signal: abortSignal });
  t.after(async () => { await factory.close(); await f.close(); });
  return { ...f, owner, original, request, control, revoke: () => { allowed = false; } };
}

for (const dsh of [false, true]) for (const protocol of ['JSONRPC', 'HTTP+JSON']) {
  test(`${dsh ? 'DSH/Codex' : 'Native'} ${protocol} subscribes to original bound task and confirms terminal with GetTask`, async t => {
    const f = await setup(t, { dsh, protocol }); f.setTask(task('COMPLETED', { artifacts: [{ artifactId: 'answer', parts: [{ text: '完成😀' }] }] }));
    const start = f.calls.length, result = await f.control();
    assert.equal(result.task_id, taskId); assert.equal(result.remote_task_id, 'original-remote');
    assert.equal(result.state, 'completed'); assert.equal(result.outcome, 'observed');
    assert.deepEqual(result.subscription, { contract: 'agentkit.studio-a2a-task-subscription/v1', events: 1, ended: 'boundary' });
    assert.deepEqual(f.calls.slice(start).filter(call => call.wireMethod).map(call => call.wireMethod), ['SubscribeToTask', 'GetTask']);
    assert.deepEqual(f.calls.slice(start).filter(call => call.action === 'PrepareA2ATaskOperation').map(call => call.body.Operation),
      ['subscribe_to_task', 'get_task']);
    assert.equal(f.calls.filter(call => call.action === 'PrepareA2ACall').length, 1);
    assert.equal(f.calls.filter(call => call.action === 'BindA2ARemoteTask').length, 1);
    assert.equal(f.calls.filter(call => call.wireMethod?.startsWith('Send')).length, 1);
    assert.doesNotMatch(JSON.stringify(f.record()), /private-permit|external-key|Bearer/);
    if (dsh) assert.equal(Object.hasOwn(f.record().owner, 'scope'), false);
    else assert.equal(f.record().request.native.runId, 'run');
  });
}

test('EOF while working is not completion; explicit second subscription may reuse stream-local IDs', async t => {
  const f = await setup(t); f.setTask(task());
  const first = await f.control(); assert.equal(first.state, 'working'); assert.equal(first.phase, 'unknown');
  assert.equal(first.subscription.ended, 'eof');
  f.original.close(); const restored = f.owner(), before = f.calls.length;
  // Opening an owner is local-only; another explicit watch uses a fresh permit.
  assert.equal(f.calls.length, before); f.setTask(task('COMPLETED'));
  const second = await f.control('subscribe', 'watch-2', signal(), restored);
  assert.equal(second.state, 'completed'); assert.equal(f.calls.filter(call => call.wireMethod === 'SubscribeToTask').length, 2);
  assert.equal(f.calls.filter(call => call.wireMethod?.startsWith('Send')).length, 1);
});

test('a terminal stream hint cannot override a working authoritative Task snapshot', async t => {
  const hint = { statusUpdate: { taskId: 'original-remote', contextId: 'original-context', status: { state: 'TASK_STATE_COMPLETED' } } };
  const f = await setup(t, { subscriptionUpdates: [hint] }); f.setTask(task());
  const result = await f.control(); assert.equal(result.state, 'working'); assert.equal(result.phase, 'unknown');
  assert.equal(result.subscription.ended, 'boundary'); assert.equal(f.record().projection.pendingTerminal, undefined);
  assert.equal(f.record().managed.events.log.some(event => event.item?.state === 'completed'), false);
});

test('wrong task or context in subscription cannot publish foreign content or query a replacement', async t => {
  for (const altered of [{ id: 'foreign' }, { contextId: 'foreign' }]) {
    const f = await setup(t, { subscriptionUpdates: [{ task: { ...task(), ...altered } }] });
    const start = f.calls.length;
    await assert.rejects(f.control(), { code: 'A2A_REMOTE_BINDING_CONFLICT' });
    assert.equal(f.record().projection.taskId, 'original-remote'); assert.equal(f.record().projection.contextId, 'original-context');
    assert.equal(f.calls.slice(start).some(call => call.wireMethod === 'GetTask'), false);
  }
});

test('unsupported prepared streaming refuses subscription before peer transport and never sends another message', async t => {
  const f = await setup(t, { preparedStreaming: false });
  const before = f.calls.filter(call => call.wireMethod).length;
  await assert.rejects(f.control(), { code: 'A2A_SUBSCRIPTION_UNSUPPORTED' });
  assert.equal(f.calls.filter(call => call.wireMethod).length, before);
  assert.equal(f.record().controls[Object.keys(f.record().controls)[0]].phase, 'watching');
});

test('authority loss after subscription Prepare prevents peer transport', async t => {
  const f = await setup(t);
  f.setHook(call => { if (call.action === 'PrepareA2ATaskOperation' && call.body.Operation === 'subscribe_to_task') f.revoke(); });
  const before = f.calls.filter(call => call.wireMethod).length;
  await assert.rejects(f.control(), { code: 'A2A_CONTROL_AUTHORITY_LOST' });
  assert.equal(f.calls.filter(call => call.wireMethod).length, before);
});

test('disconnect releases the reader lock; remote cancellation remains independent and is not undone by a late stream', async t => {
  const f = await setup(t); f.setTask(task()); const abort = new AbortController();
  let entered; const ready = new Promise(resolve => { entered = resolve; });
  f.setHook(async (call, res) => {
    if (call.wireMethod !== 'SubscribeToTask') return;
    res.setHeader('Content-Type', 'text/event-stream');
    res.write('data: ' + JSON.stringify({ jsonrpc: '2.0', id: call.body.id, result: { task: task() } }) + '\n\n');
    entered(); await new Promise(resolve => res.on('close', resolve));
  });
  const watching = f.control('subscribe', 'live-watch', abort.signal); await ready;
  const canceled = await f.control('cancel', 'cancel-original'); assert.equal(canceled.state, 'cancelled');
  abort.abort(Error('stop observing')); await assert.rejects(watching);
  const read = await f.control('get', 'after-watch'); assert.equal(read.state, 'cancelled');
  assert.equal(f.record().projection.state, 'cancelled');
  assert.equal(f.calls.filter(call => call.wireMethod === 'CancelTask').length, 1);
  assert.equal(f.calls.filter(call => call.wireMethod?.startsWith('Send')).length, 1);
});

test('cancelled noncooperative SSE read/cancel cannot retain subscription resources', { timeout: 1000 }, async () => {
  const controller = new AbortController(); let cancels = 0, released = false;
  const stream = a2aSse({ getReader: () => ({ read: () => new Promise(() => {}),
    cancel() { cancels++; return new Promise(() => {}); }, releaseLock() { released = true; } }) }, controller.signal);
  const pending = stream.next(); controller.abort(Error('stopped'));
  await assert.rejects(pending, /stopped/); assert.equal(cancels, 1); assert.equal(released, true);
});
test('early SSE iterator return observes throwing cancellation and does not hang', { timeout: 1000 }, async () => {
  const stream = a2aSse({ getReader: () => ({ read: async () => ({ done: false, value: Buffer.from('data: {}\n\n') }),
    cancel() { throw Error('untrusted cancellation'); }, releaseLock() {} }) }, signal());
  assert.deepEqual((await stream.next()).value.payload, {}); await stream.return();
});

test('authenticated native and DSH request validators admit read-only subscriptions without accepting input or authority injection', () => {
  const native = { agentId: 'agent', sessionId: 'session', runId: 'run', operationKey: 'operation', callId: 'call', kind: 'subscribe', commandId: 'watch' };
  validateNativeA2aControlRequest(native);
  assert.throws(() => validateNativeA2aControlRequest({ ...native, parts: [{ text: 'new prompt' }] }));
  assert.throws(() => validateNativeA2aControlRequest({ ...native, authority: true }));
  const dsh = { ...native, agentRevision: 3, buildId: 'build', operationKey: 'dsh-a2a:call' }; delete dsh.runId;
  validateDshA2aRequest(dsh, true); assert.throws(() => validateDshA2aRequest({ ...dsh, runId: 'forged' }, true));
});
