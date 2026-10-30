// Actual token files, HTTP Actions, peer JSON-RPC/REST/SSE, private journals and
// SQLite locks. Host authority/consent are explicit callbacks, not browser UI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { prepareNativeA2AHost, prepareDshA2AHost } from '../src/providers/native-a2a-host.mjs';
import { internalPeer, spec, scope, taskId } from './fixtures/native-a2a-internal-peer.mjs';
import { controlConsent } from './fixtures/native-a2a-control-consent.mjs';
const signal = () => new AbortController().signal;
async function setup(t, options = {}) {
  const f = await internalPeer(options), factory = (options.dsh ? prepareDshA2AHost : prepareNativeA2AHost)({ env: f.env, bindings: [spec] });
  let current = true;
  const ownerBinding = options.dsh ? { agentId: 'agent', agentRevision: 3, buildId: 'build' } : { scope };
  const owner = () => {
    const value = factory.forSession({ ...ownerBinding, sessionId: 'session', workspaceRoot: f.workspaceRoot, stateRoot: join(f.root, 'state'),
      assertCurrent: () => current, assertControl: () => true, authorizeControl: controlConsent }); f.owners.push(value); return value;
  };
  const original = owner(), request = await original.invocation.resolve({ agent: 'research', message: 'Hello😀', signal: signal(),
    [options.dsh ? 'dshRequest' : 'nativeRequest']: { ...ownerBinding, sessionId: 'session', ...(options.dsh ? {} : { runId: 'run' }),
      operationKey: 'original-operation', call: { callId: 'call' } } });
  const dispatch = target => (target ?? original).invocation.dispatch({ request, signal: signal() });
  const control = (target, kind, commandId, extra = {}) => target.control.execute({ kind, commandId,
    operation_locator: request.identity, authority: { user: 'approved' }, signal: signal(), ...extra });
  t.after(async () => { await factory.close(); await f.close(); });
  return { ...f, original, owner, request, dispatch, control, revoke: () => { current = false; } };
}
for (const dsh of [false, true]) for (const protocol of ['JSONRPC', 'HTTP+JSON']) for (const streaming of [false, true]) {
  test(`${dsh ? 'DSH' : 'Native'} ${protocol} ${streaming ? 'SSE' : 'JSON'}: rotating workload tokens, durable permits and original task binding`, async t => {
    const f = await setup(t, { dsh, protocol, streaming }), result = await f.dispatch();
    assert.equal(result.state, 'completed'); assert.equal(result.task_id, taskId);
    assert.equal(f.record().managed.remote.phase, 'bound'); assert.equal(f.record().projection.taskId, 'original-remote');
    assert.equal(f.calls.filter(value => value.action === 'BindA2ARemoteTask').length, 1);
    assert.equal(f.calls.filter(value => value.wireMethod?.startsWith('Send')).length, 1);
    const ledger = f.calls.length; assert.deepEqual(await f.dispatch(f.owner()), result); assert.equal(f.calls.length, ledger);
    const bytes = JSON.stringify(f.record());
    assert.doesNotMatch(bytes, /private-permit|private-handle|public-token-must-not-leak|external-key|Bearer/u);
    if (dsh) assert.equal(Object.hasOwn(f.record().owner, 'scope'), false);
    else assert.equal(f.record().request.native.runId, 'run');
  });
}
for (const protocol of ['JSONRPC', 'HTTP+JSON']) test(`${protocol}: external broker injects credentials and quoted cookies only into prepared route`, async t => {
  const f = await setup(t, { protocol, kind: 'external_vpc' }); assert.equal((await f.dispatch()).state, 'completed');
  assert.equal(f.calls.filter(value => value.action === 'ResolveA2ACredential').length, 2);
  assert.doesNotMatch(JSON.stringify(f.record()), /external-key|external-query|two words/u);
});
test('explicit public egress gating and credential collision stop before remote dispatch', async t => {
  for (const options of [{ kind: 'external_public' }, { kind: 'external_vpc', mode: 'credential-conflict' }, { kind: 'external_vpc', mode: 'query-conflict' }]) {
    const f = await setup(t, options); assert.equal((await f.dispatch()).state, 'unknown');
    assert.equal(f.calls.filter(value => value.wireMethod).length, 0);
  }
});
test('explicitly enabled public egress uses broker credentials and prepared non-streaming capability', async t => {
  const f = await setup(t, { kind: 'external_public', publicEgress: true, streaming: true, preparedStreaming: false });
  assert.equal((await f.dispatch()).state, 'completed');
  assert.deepEqual(f.calls.filter(value => value.wireMethod).map(value => value.wireMethod), ['SendMessage', 'GetTask']);
});
test('expired permits and authority loss after Prepare cannot admit peer HTTP', async t => {
  const expired = await setup(t, { mode: 'expired-permit' }); assert.equal((await expired.dispatch()).state, 'unknown');
  assert.equal(expired.calls.filter(value => value.wireMethod).length, 0);
  const revoked = await setup(t); revoked.setHook(call => { if (call.action === 'PrepareA2ACall') revoked.revoke(); });
  assert.equal((await revoked.dispatch()).state, 'unknown'); assert.equal(revoked.calls.filter(value => value.wireMethod).length, 0);
});
test('invalid peer Task shape is rejected before publishing a Bind effect', async t => {
  const f = await setup(t, { mode: 'invalid-task' }); assert.equal((await f.dispatch()).state, 'unknown');
  assert.equal(f.calls.filter(value => value.action === 'BindA2ARemoteTask').length, 0);
});
test('explicit read failures cannot expose credential-bearing peer parser messages or causes', async t => {
  const f = await setup(t, { kind: 'external_vpc', mode: 'pause' }); assert.equal((await f.dispatch()).state, 'input_required');
  f.setMode('malformed-get');
  await assert.rejects(f.control(f.owner(), 'get', 'inspect'), error => {
    assert.equal(error.code, 'A2A_REMOTE_HTTP_FAILED'); assert.equal(error.cause, undefined);
    assert.doesNotMatch(String(error), /private-permit|external-key|external-query/u); return true;
  });
});
test('prepared target/version drift refuses the peer and never falls back to public discovery', async t => {
  const f = await setup(t, { mode: 'version-drift' }); assert.equal((await f.dispatch()).state, 'unknown');
  assert.equal(f.calls.filter(value => value.wireMethod).length, 0);
  assert.equal(f.calls.some(value => value.path.includes('ListAToASpaceAgents')), false);
});
for (const streaming of [false, true]) test(`already bound initial idempotency result (${streaming ? 'SSE' : 'JSON'}) reads the original Task without another initial send`, async t => {
  const f = await setup(t, { initialExisting: true, streaming }); assert.equal((await f.dispatch()).state, 'completed');
  assert.deepEqual(f.calls.filter(value => value.wireMethod).map(value => value.wireMethod), ['GetTask']);
  assert.equal(f.calls.filter(value => value.action === 'BindA2ARemoteTask').length, 0);
});
test('a lost Prepare or Send receipt stays unknown on a replacement Host and never re-prepares or re-sends', async t => {
  for (const mode of ['prepare-lost', 'send-lost']) {
    const f = await setup(t, { mode }); assert.equal((await f.dispatch()).state, 'unknown');
    const before = f.calls.length; f.original.close(); assert.equal((await f.dispatch(f.owner())).state, 'unknown');
    assert.equal(f.calls.length, before);
  }
});
test('a lost Bind acknowledgement is reconciled only by explicit Get permission on the original platform task', async t => {
  const f = await setup(t, { mode: 'bind-lost' }); assert.equal((await f.dispatch()).state, 'unknown');
  assert.equal(f.record().managed.remote.phase, 'binding'); assert.equal(f.record().projection.taskId, null);
  f.original.close(); f.setMode('complete'); const replacement = f.owner();
  const result = await f.control(replacement, 'get', 'explicit-get');
  assert.equal(result.state, 'completed'); assert.equal(result.task_id, taskId);
  assert.equal(f.record().managed.remote.phase, 'bound');
  assert.equal(f.calls.filter(value => value.action === 'BindA2ARemoteTask').length, 1);
  assert.equal(f.calls.filter(value => value.wireMethod === 'SendMessage').length, 1);
});
for (const kind of ['continue', 'cancel']) test(`fresh approved ${kind} prepares the original managed task and keeps the command idempotent`, async t => {
  const f = await setup(t, { mode: 'pause' }); assert.equal((await f.dispatch()).state, 'input_required');
  f.original.close(); const replacement = f.owner(), before = await f.control(replacement, 'get', 'inspect');
  const extra = kind === 'continue' ? { pauseDigest: before.pauseDigest, parts: [{ data: { answer: 1 } }] } : {};
  const result = await f.control(replacement, kind, 'command', extra);
  assert.equal(result.state, kind === 'continue' ? 'completed' : 'cancelled'); assert.equal(result.task_id, taskId);
  const ledger = f.calls.length; assert.deepEqual(await f.control(replacement, kind, 'command', extra), result); assert.equal(f.calls.length, ledger);
  const prepared = f.calls.filter(value => value.action === 'PrepareA2ATaskOperation');
  assert.ok(prepared.some(value => value.body.Operation === (kind === 'continue' ? 'send_message' : 'cancel_task')));
});
for (const dsh of [false, true]) test(`${dsh ? 'DSH' : 'Native'} internal busy cancellation preserves all command facts against a late working stream`, { timeout: 10000 }, async t => {
  const f = await setup(t, { streaming: true, mode: 'hold-stream', dsh }), running = f.dispatch();
  const deadline = Date.now() + 5000;
  while (f.record()?.managed.remote?.phase !== 'bound') {
    assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10));
  }
  const result = await f.control(f.owner(), 'cancel', 'cancel-busy'); assert.equal(result.state, 'cancelled');
  f.finishStream(); assert.equal((await running).state, 'cancelled');
  assert.equal(f.record().projection.state, 'cancelled'); assert.equal(f.record().phase, 'terminal');
  assert.equal(Object.values(f.record().controls)[0].phase, 'resolved');
  assert.equal(f.calls.filter(value => value.wireMethod === 'CancelTask').length, 1);
  assert.equal(f.calls.filter(value => value.wireMethod === 'SendStreamingMessage').length, 1);
});
