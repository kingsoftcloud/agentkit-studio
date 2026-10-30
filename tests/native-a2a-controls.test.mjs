// Actual JSON-RPC/HTTP+JSON peers, private files and SQLite locks. Only the
// explicit Host consent/current-authority callbacks are test implementations.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareNativeA2AHost, prepareDshA2AHost } from '../src/providers/native-a2a-host.mjs';

const spec = { local_name: 'remote', binding_id: 'binding', space_id: 'space', target_agent_id: 'remote-agent', expected_version_id: 'version' };
const scope = { tenantId: 'local', workspaceId: 'workspace', userId: 'user', agentId: 'agent' };
const pause = number => ({ messageId: `question-${number}`, role: 'ROLE_AGENT', parts: [{ text: '请补充输入' },
  { data: { schema: { type: 'object', required: ['answer'] }, interaction_id: `interaction-${number}` } }] });
async function setup(t, { dsh = false, protocol = 'JSONRPC', timeout, expectedParts = [{ data: { answer: '用户的回答😀' } }] } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'a2a-control-'))), workspaceRoot = join(root, 'workspace');
  mkdirSync(workspaceRoot);
  const counts = { sends: 0, continues: 0, cancels: 0, gets: 0, discovery: 0 }, errors = [], owners = [];
  let mode = 'complete', originalAlive = true, controlAlive = true, consent = 'allow', authorize;
  let task = { id: 'original-task', contextId: 'original-context', status: { state: 'TASK_STATE_INPUT_REQUIRED', message: pause(1) } };
  let held, onContinue;
  function record() {
    const directory = join(root, 'state');
    const owner = readdirSync(directory)[0];
    const file = readdirSync(join(directory, owner)).find(file => file.endsWith('.json'));
    return JSON.parse(readFileSync(join(directory, owner, file)));
  }
  const server = createServer((req, res) => void (async () => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/agentengine/api/v1/ListAToASpaceAgents') {
      counts.discovery++;
      res.end(JSON.stringify({ Code: 0, Data: { Agents: [{ A2AAgentId: spec.target_agent_id, VersionId: 'version', Source: 'hosted',
        AgentCard: { supportedInterfaces: [{ url: origin + '/a2a', protocolBinding: protocol, protocolVersion: '1.0' }] } }] } })); return;
    }
    const method = protocol === 'JSONRPC' ? body.method : req.method === 'GET' ? 'GetTask'
      : req.url.endsWith(':cancel') ? 'CancelTask' : 'SendMessage';
    const params = protocol === 'JSONRPC' ? body.params : body;
    const reply = result => res.end(JSON.stringify(protocol === 'JSONRPC' ? { jsonrpc: '2.0', id: body.id, result } : result));
    assert.equal(req.headers.authorization, 'Bearer test-service-token');
    if (method === 'GetTask') {
      counts.gets++; assert.equal(protocol === 'JSONRPC' ? params.id : decodeURIComponent(req.url.split('/').at(-1)), task.id);
      if (mode === 'cancel-confirmation-lost' && counts.cancels) { res.destroy(); return; }
      reply(mode === 'drift' ? { ...task, contextId: 'different-context' } : task); return;
    }
    if (method === 'CancelTask' || params.message.taskId) {
      const kind = method === 'CancelTask' ? 'cancel' : 'continue';
      const entries = Object.values(record().controls).filter(entry => entry.command.kind === kind && entry.phase === 'sending');
      assert.equal(entries.length, 1, 'fsynced complete control intent before actual remote effect');
      assert.equal(entries[0].command.operation_locator.sessionId, 'session');
      if (kind === 'cancel') {
        counts.cancels++; assert.equal(protocol === 'JSONRPC' ? params.id : req.url, protocol === 'JSONRPC' ? task.id : `/a2a/tasks/${task.id}:cancel`);
        if (mode === 'unsupported') {
          if (protocol === 'JSONRPC') res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32004, message: 'secret-remote-diagnostic' } }));
          else { res.statusCode = 501; res.end('{}'); }
          return;
        }
        if (mode !== 'still-working') task = { ...task, status: { state: mode === 'cancel-raced' ? 'TASK_STATE_COMPLETED' : 'TASK_STATE_CANCELED' } };
        if (mode === 'lost') { res.destroy(); return; }
        if (mode === 'hold') { held = () => reply(task); return; }
        if (mode === 'cancel-conflict') { reply(task); task = { ...task, status: { state: 'TASK_STATE_COMPLETED' } }; return; }
        reply(task); return;
      }
      counts.continues++; assert.deepEqual(entries[0].message, params.message);
      assert.equal(params.message.contextId, task.contextId); assert.equal(params.message.role, 'ROLE_USER');
      assert.deepEqual(params.message.parts, expectedParts);
      task = { ...task, status: mode === 'pause-again' ? { state: 'TASK_STATE_AUTH_REQUIRED', message: pause(2) }
        : mode === 'pause-same' ? { state: 'TASK_STATE_INPUT_REQUIRED', message: pause(1) }
        : { state: 'TASK_STATE_COMPLETED' }, artifacts: [{ artifactId: 'answer', parts: [{ text: '已收到😀' }] }] };
      onContinue?.();
      if (mode === 'lost') { res.destroy(); return; }
      if (mode === 'hold') { held = () => reply({ task }); return; }
      reply({ task }); return;
    }
    counts.sends++; assert.equal(record().phase, 'sending');
    reply({ task });
  })().catch(error => { errors.push(error); res.statusCode = 500; res.end('{}'); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const env = { KSADK_A2A_SERVICE_URL: origin, KSADK_A2A_SERVICE_TOKEN: 'test-service-token', KSADK_A2A_ALLOW_PRIVATE: 'true' };
  const prepared = (dsh ? prepareDshA2AHost : prepareNativeA2AHost)({ env, bindings: [{ ...spec, ...(timeout ? { timeout_seconds: timeout } : {}) }] });
  const ownerBinding = dsh ? { agentId: 'agent', agentRevision: 3, buildId: 'build' } : { scope };
  function owner(extra = {}) {
    const value = prepared.forSession({ ...ownerBinding, sessionId: 'session', stateRoot: join(root, 'state'), workspaceRoot,
      assertCurrent: () => originalAlive, assertControl: ({ authority, operation_locator, kind, owner }) => {
        assert.equal(authority.currentRun, 'fresh-control-run'); assert.equal(operation_locator.sessionId, 'session');
        assert.equal(owner.sessionId, 'session'); assert.ok(['get', 'cancel', 'continue'].includes(kind)); return controlAlive;
      }, authorizeControl: async input => { if (authorize) return authorize(input); return consent; }, ...extra });
    owners.push(value); return value;
  }
  const original = owner();
  const originalRequest = { ...ownerBinding, sessionId: 'session', ...(!dsh ? { runId: 'original-run' } : {}), operationKey: 'original-operation',
    call: { callId: 'original-call' } };
  const request = await original.invocation.resolve({ agent: 'remote', message: 'initial', signal: new AbortController().signal,
    [dsh ? 'dshRequest' : 'nativeRequest']: originalRequest });
  await original.invocation.dispatch({ request, signal: new AbortController().signal });
  const locator = request.identity;
  const input = (kind, commandId, extra = {}) => ({ kind, commandId, operation_locator: structuredClone(locator),
    authority: { currentRun: 'fresh-control-run' }, signal: new AbortController().signal, ...extra });
  const get = (target, commandId = 'inspect') => target.control.execute(input('get', commandId));
  const follow = (target, pauseDigest, commandId = 'reply') => target.control.execute(input('continue', commandId,
    { pauseDigest, parts: [{ data: { answer: '用户的回答😀' } }] }));
  t.after(async () => {
    for (const value of owners) value.close(); await prepared.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  return { root, owner, original, locator, input, get, follow, record, counts, setMode: value => { mode = value; },
    retireOriginal: () => { originalAlive = false; original.close(); }, revoke: () => { controlAlive = false; },
    deny: () => { consent = 'deny'; }, authorize: value => { authorize = value; },
    finish: () => held?.(), onContinue: value => { onContinue = value; },
    setTask: value => { task = value; } };
}

for (const dsh of [false, true]) for (const protocol of ['JSONRPC', 'HTTP+JSON']) {
  test(`${dsh ? 'DSH' : 'Native'} ${protocol}: fresh control authority continues the original task and preserves data input`, async t => {
    const f = await setup(t, { dsh, protocol }); f.retireOriginal();
    const owner = f.owner();
    const before = await f.get(owner); assert.equal(before.state, 'input_required');
    assert.equal(before.pause.messageId, 'question-1'); assert.equal(before.pause.parts[1].data.interaction_id, 'interaction-1');
    const result = await f.follow(owner, before.pauseDigest);
    assert.equal(result.outcome, 'submitted'); assert.equal(result.state, 'completed'); assert.equal(result.remote_task_id, 'original-task');
    assert.deepEqual(await f.follow(owner, before.pauseDigest), result);
    assert.equal(f.counts.continues, 1); assert.equal(f.counts.sends, 1); assert.equal(f.counts.discovery, 1);
    if (dsh) assert.equal(Object.hasOwn(f.record().owner, 'scope'), false);
    else assert.equal(f.record().request.native.runId, 'original-run');
    const changed = f.input('continue', 'reply', { pauseDigest: before.pauseDigest, parts: [{ text: 'different' }] });
    await assert.rejects(owner.control.execute(changed), { code: 'A2A_CONTROL_IDEMPOTENCY_CONFLICT' });
  });
  test(`${dsh ? 'DSH' : 'Native'} ${protocol}: cancellation requires a GetTask confirmation and is idempotent`, async t => {
    const f = await setup(t, { dsh, protocol }); f.retireOriginal(); const owner = f.owner();
    const command = f.input('cancel', 'cancel-once');
    const result = await owner.control.execute(command);
    assert.equal(result.outcome, 'remote_cancelled'); assert.equal(result.state, 'cancelled');
    assert.deepEqual(await owner.control.execute(command), result);
    assert.equal(f.counts.cancels, 1); assert.equal(f.counts.gets, 2); assert.equal(f.counts.sends, 1);
    assert.equal((await owner.control.execute(f.input('cancel', 'another-cancel'))).outcome, 'already_terminal');
    assert.equal(f.counts.cancels, 1);
  });
}

test('lost continuation response is never resent, including with a new command ID for the same pause', async t => {
  const f = await setup(t); const owner = f.original, before = await f.get(owner); f.setMode('lost');
  const result = await f.follow(owner, before.pauseDigest); assert.equal(result.outcome, 'unknown');
  f.retireOriginal(); const replacement = f.owner();
  assert.deepEqual(await f.follow(replacement, before.pauseDigest), result); assert.equal(f.counts.continues, 1);
  const observed = await f.get(replacement, 'cold-inspect'); assert.equal(observed.state, 'completed');
  assert.equal(f.counts.sends, 1); assert.equal(f.counts.discovery, 1);
});
test('continuation cannot receive a fresh deadline after human input or Host replacement', async t => {
  const f = await setup(t, { timeout: 0.3 }), before = await f.get(f.original);
  await new Promise(resolve => setTimeout(resolve, 310)); f.retireOriginal();
  await assert.rejects(f.follow(f.owner(), before.pauseDigest), { code: 'A2A_CONTINUATION_DEADLINE_EXCEEDED' });
  assert.equal(f.counts.continues, 0); assert.equal(f.counts.sends, 1);
});
test('abort during an uncooperative consent callback releases the lock and late allow cannot dispatch', async t => {
  const f = await setup(t), consent = Promise.withResolvers(), entered = Promise.withResolvers();
  f.authorize(() => { entered.resolve(); return consent.promise; });
  const controller = new AbortController(), input = f.input('cancel', 'aborted', { signal: controller.signal });
  const result = f.original.control.execute(input); await entered.promise;
  controller.abort(Object.assign(new Error('caller stopped'), { code: 'TEST_ABORT' }));
  await assert.rejects(result, { code: 'TEST_ABORT' }); consent.resolve('allow');
  f.authorize(undefined); await f.get(f.owner());
  assert.equal(f.counts.cancels, 0); assert.equal(f.counts.gets, 1);
});
test('remote cancellation is distinct from aborting the local control request', async t => {
  const f = await setup(t); f.setMode('hold');
  const controller = new AbortController(), input = f.input('cancel', 'local-abort', { signal: controller.signal });
  const pending = f.original.control.execute(input), deadline = Date.now() + 5000;
  while (!f.counts.cancels) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5)); }
  controller.abort(); const result = await pending; assert.equal(result.outcome, 'unknown');
  assert.equal(result.state, 'input_required', 'a local abort cannot publish unconfirmed remote cancellation');
  assert.equal((await f.get(f.owner(), 'confirm-cancel')).state, 'cancelled'); assert.equal(f.counts.cancels, 1);
});
test('unknown remote task cannot be controlled by another scope or DSH owner', async t => {
  const f = await setup(t);
  const other = f.owner({ scope: { ...scope, userId: 'someone-else' } });
  await assert.rejects(f.get(other), { code: 'A2A_CALL_NOT_FOUND' });
  assert.equal(f.counts.gets, 0); assert.equal(f.counts.cancels, 0);
});
test('new remote question admits a new reply; a stale pause cannot answer it', async t => {
  const f = await setup(t), owner = f.original, before = await f.get(owner); f.setMode('pause-again');
  const result = await f.follow(owner, before.pauseDigest); assert.equal(result.state, 'auth_required');
  await assert.rejects(f.follow(owner, before.pauseDigest, 'stale-reply'), { code: 'A2A_CONTINUATION_NOT_ALLOWED' });
  f.setMode('complete'); assert.equal((await f.follow(owner, result.pauseDigest, 'second-reply')).state, 'completed');
  assert.equal(f.counts.continues, 2);
});
test('confirmed continuation can ask the identical question again without treating the next input as an unknown replay', async t => {
  const f = await setup(t), before = await f.get(f.original); f.setMode('pause-same');
  const next = await f.follow(f.original, before.pauseDigest);
  assert.equal(next.outcome, 'submitted'); assert.deepEqual(next.pause, before.pause); assert.notEqual(next.pauseDigest, before.pauseDigest);
  f.setMode('complete'); assert.equal((await f.follow(f.original, next.pauseDigest, 'corrected-answer')).state, 'completed');
  assert.equal(f.counts.continues, 2);
});
for (const data of [null, false, 42, '字符串😀', [1, 'two']]) test(`supplemental data retains JSON value ${JSON.stringify(data)}`, async t => {
  const parts = [{ data }], f = await setup(t, { expectedParts: parts });
  const before = await f.get(f.original);
  const result = await f.original.control.execute(f.input('continue', 'data', { parts, pauseDigest: before.pauseDigest }));
  assert.equal(result.outcome, 'submitted'); assert.equal(f.counts.continues, 1);
});
test('continuation enforces the reference 64-part and full-message byte limits before any effect', async t => {
  const f = await setup(t), before = await f.get(f.original);
  for (const parts of [Array.from({ length: 65 }, () => ({ text: 'x' })), [{ text: 'x'.repeat(1024 * 1024) }]]) {
    await assert.rejects(f.original.control.execute(f.input('continue', 'too-large', { parts, pauseDigest: before.pauseDigest })), { code: 'A2A_CONTROL_INPUT_INVALID' });
  }
  assert.equal(f.counts.continues, 0); assert.equal(Object.values(f.record().controls).some(entry => entry.command.kind === 'continue'), false);
});
test('HTTP+JSON explicitly reports an unsupported cancel without leaking diagnostics or retrying', async t => {
  const f = await setup(t, { protocol: 'HTTP+JSON' }); f.setMode('unsupported');
  const command = f.input('cancel', 'unsupported');
  const result = await f.original.control.execute(command); assert.equal(result.outcome, 'cancel_requested_but_remote_unsupported');
  assert.deepEqual(await f.original.control.execute(command), result); assert.equal(f.counts.cancels, 1);
});
test('a contradictory terminal from GetTask cannot overwrite the saved CancelTask observation', async t => {
  const f = await setup(t); f.setMode('cancel-conflict');
  const result = await f.original.control.execute(f.input('cancel', 'conflict'));
  assert.equal(result.outcome, 'unknown');
  assert.equal(Object.values(f.record().controls).find(entry => entry.command.kind === 'cancel').cancelReply.state, 'cancelled');
  await assert.rejects(f.get(f.owner(), 'contradictory-get'), { code: 'A2A_TERMINAL_STATE_CONFLICT' });
  assert.equal(f.counts.cancels, 1); assert.equal(f.record().projection.state, 'input_required');
});
test('lost cancel confirmation retains the terminal candidate and later GetTask confirms without another cancel', async t => {
  const f = await setup(t); f.setMode('cancel-confirmation-lost');
  const result = await f.original.control.execute(f.input('cancel', 'lost-confirmation'));
  assert.equal(result.outcome, 'unknown'); assert.equal(result.state, 'input_required');
  f.retireOriginal(); f.setMode('complete');
  assert.equal((await f.get(f.owner(), 'confirm')).state, 'cancelled'); assert.equal(f.counts.cancels, 1);
});
test('remote task/context drift is rejected without a continuation or cancellation', async t => {
  const f = await setup(t); f.setMode('drift');
  await assert.rejects(f.original.control.execute(f.input('cancel', 'drift')), { code: 'A2A_REMOTE_BINDING_CONFLICT' });
  assert.equal(f.counts.cancels, 0); assert.equal(f.counts.continues, 0); assert.equal(f.record().projection.contextId, 'original-context');
});
test('denied, missing, asynchronous or revoked control authority cannot operate a task', async t => {
  const f = await setup(t), owner = f.owner({ assertControl: undefined });
  await assert.rejects(f.get(owner), { code: 'A2A_CONTROL_AUTHORITY_REQUIRED' });
  const asyncOwner = f.owner({ assertControl: async () => true });
  await assert.rejects(f.get(asyncOwner), { code: 'A2A_CONTROL_AUTHORITY_LOST' });
  f.deny(); await assert.rejects(f.original.control.execute(f.input('cancel', 'denied')), { code: 'A2A_CONTROL_PERMISSION_DENIED' });
  f.revoke(); await assert.rejects(f.get(f.original), { code: 'A2A_CONTROL_AUTHORITY_LOST' });
  assert.equal(f.counts.gets, 0); assert.equal(f.counts.cancels, 0);
});
test('request mutation while awaiting consent is rejected before network I/O', async t => {
  const f = await setup(t), input = f.input('cancel', 'drift');
  f.authorize(async () => { input.signal = new AbortController().signal; return 'allow'; });
  await assert.rejects(f.original.control.execute(input), { code: 'A2A_CONTROL_REQUEST_DRIFTED' });
  assert.equal(f.counts.gets, 0); assert.equal(f.counts.cancels, 0);
});
test('authority lost after actual continuation retains unknown instead of resending or confirming', async t => {
  const f = await setup(t), before = await f.get(f.original); f.onContinue(f.revoke);
  const result = await f.follow(f.original, before.pauseDigest); assert.equal(result.outcome, 'unknown');
  assert.equal(f.record().projection.state, 'input_required'); assert.equal(f.counts.continues, 1);
});
test('concurrent control cannot dispatch a second continuation', async t => {
  const f = await setup(t), before = await f.get(f.original); f.setMode('hold');
  const pending = f.follow(f.original, before.pauseDigest);
  const deadline = Date.now() + 5000;
  while (f.counts.continues === 0) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5)); }
  await assert.rejects(f.follow(f.owner(), before.pauseDigest, 'parallel'), { code: 'A2A_CALL_BUSY' });
  f.finish(); assert.equal((await pending).state, 'completed'); assert.equal(f.counts.continues, 1);
});
for (const mode of ['cancel-raced', 'still-working', 'unsupported', 'lost']) {
  test(`cancel ${mode}: remote outcome stays explicit and duplicate does not send`, async t => {
    const f = await setup(t); f.setMode(mode);
    const command = f.input('cancel', 'cancel'); const result = await f.original.control.execute(command);
    assert.equal(result.outcome, { 'cancel-raced': 'already_terminal', 'still-working': 'cancel_requested_but_remote_unknown',
      unsupported: 'cancel_requested_but_remote_unsupported', lost: 'unknown' }[mode]);
    assert.deepEqual(await f.original.control.execute(command), result); assert.equal(f.counts.cancels, 1);
    assert.equal(JSON.stringify(result).includes('secret-remote-diagnostic'), false);
    if (mode === 'still-working') await assert.rejects(f.original.control.execute(f.input('cancel', 'second')), { code: 'A2A_CANCEL_ALREADY_REQUESTED' });
  });
}
