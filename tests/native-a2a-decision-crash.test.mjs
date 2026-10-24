// Genuine process death at both sides of the durable decision+intent boundary.
// The child uses a declared receipt double; actual audit service integration is
// independently exercised by verify-a2a-host-decisions.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { join } from 'node:path';
import { prepareNativeA2AHost, prepareDshA2AHost } from '../src/providers/native-a2a-host.mjs';
import { internalPeer, scope, spec } from './fixtures/native-a2a-internal-peer.mjs';
const signal = () => new AbortController().signal;
function worker(f, input) {
  const messages = [], child = fork(new URL('./fixtures/a2a-decision-crash-worker.mjs', import.meta.url), [],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); let stderr = '';
  child.stdout.resume(); child.stderr.on('data', bytes => { stderr += bytes; }); child.on('message', value => messages.push(value));
  const exit = new Promise((resolve, reject) => { child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, pid: child.pid, stderr })); });
  child.send({ root: f.root, workspaceRoot: f.workspaceRoot, env: f.env, ...input });
  return { child, messages, exit };
}
for (const dsh of [false, true]) for (const kind of ['continue', 'reject']) for (const boundary of ['before-transport', 'after-remote-apply'])
  test(`SIGKILL ${dsh ? 'DSH' : 'Native'} ${kind} ${boundary}: decision survives without replaying the effect`, { timeout: 20000 }, async t => {
    const metadata = { input_schema: { type: 'string', enum: ['approve', 'reject'] },
      ksadk_interaction: { version: 1, kind: 'approval', allowed_decisions: ['approve', 'reject'],
        presentation: { title: 'remote-change', description: '{"arguments":{}}' } } };
    const initialTask = { id: 'original-remote', contextId: 'original-context',
      status: { state: 'TASK_STATE_INPUT_REQUIRED', message: { messageId: 'question', role: 'ROLE_AGENT',
        parts: [{ text: 'Approve remote change' }], metadata } } };
    const f = await internalPeer({ initialTask, expectedContinuationParts: [{ data: 'approve' }] }); t.after(() => f.close());
    const factory = (dsh ? prepareDshA2AHost : prepareNativeA2AHost)({ env: f.env, bindings: [spec] });
    const fields = dsh ? { agentId: 'agent', agentRevision: 1, buildId: null } : { scope };
    const owner = factory.forSession({ ...fields, sessionId: 'session', stateRoot: join(f.root, 'state'), workspaceRoot: f.workspaceRoot,
      assertCurrent: () => true, assertControl: () => true, authorizeControl: async () => 'allow' }); f.owners.push(owner);
    t.after(() => factory.close());
    const request = await owner.invocation.resolve({ agent: 'research', message: 'initial', signal: signal(),
      [dsh ? 'dshRequest' : 'nativeRequest']: { ...fields, sessionId: 'session', ...(dsh ? {} : { runId: 'run' }),
        operationKey: 'operation', call: { callId: 'call' } } });
    assert.equal((await owner.invocation.dispatch({ request, signal: signal() })).state, 'input_required');
    const before = await owner.control.execute({ kind: 'get', commandId: 'inspect', operation_locator: request.identity, authority: {}, signal: signal() });
    await owner.eventDelivery.flush(); await factory.close();
    const command = { kind, commandId: 'crash-decision', operation_locator: request.identity, authority: {}, pauseDigest: before.pauseDigest,
      ...(kind === 'continue' ? { parts: [{ data: 'approve' }] } : {}) };
    let reached, release;
    const entered = new Promise(resolve => { reached = resolve; });
    if (boundary === 'after-remote-apply') f.setHook(call => {
      if (kind === 'continue' ? call.wireMethod === 'SendMessage' : call.wireMethod === 'CancelTask') {
        reached(); return new Promise(resolve => { release = resolve; });
      }
    });
    const first = worker(f, { action: 'control', boundary, dsh, command }); t.after(() => first.child.kill('SIGKILL'));
    if (boundary === 'before-transport') first.child.on('message', value => { if (value.type === 'boundary') reached(); });
    await Promise.race([entered, first.exit.then(result => assert.fail('ended before crash boundary: ' + JSON.stringify({ result, messages: first.messages })))]);
    const committed = f.record(), decisions = committed.managed.events.log.filter(event => event.event_type === 'interaction.resolved');
    assert.equal(decisions.length, 1); assert.equal(decisions[0].response.decision, kind === 'continue' ? 'approved' : 'rejected');
    assert.equal(Object.values(committed.controls).find(entry => entry.command.commandId === command.commandId).phase, 'sending');
    const tasks = f.calls.filter(call => call.wireMethod).length;
    first.child.kill('SIGKILL'); const killed = await first.exit; assert.equal(killed.signal, 'SIGKILL');
    f.setHook(undefined); release?.();
    const second = worker(f, { action: 'confirm', dsh, command }); t.after(() => second.child.kill('SIGKILL'));
    const cold = await second.exit; assert.equal(cold.code, 0, JSON.stringify({ cold, messages: second.messages }));
    assert.notEqual(killed.pid, cold.pid); assert.equal(second.messages.find(value => value.type === 'result')?.result.outcome, 'unknown');
    assert.equal(f.calls.filter(call => call.wireMethod).length, tasks);
    assert.deepEqual(f.record().managed.events.log, committed.managed.events.log);
    const third = worker(f, { action: 'confirm', dsh, command: { kind: 'get', commandId: 'explicit-read', operation_locator: request.identity, authority: {} } });
    t.after(() => third.child.kill('SIGKILL')); const observed = await third.exit;
    assert.equal(observed.code, 0, JSON.stringify({ observed, messages: third.messages })); assert.notEqual(observed.pid, cold.pid);
    const result = third.messages.find(value => value.type === 'result')?.result;
    assert.equal(result.state, boundary === 'before-transport' ? 'input_required' : kind === 'continue' ? 'completed' : 'cancelled');
    assert.equal(f.calls.filter(call => call.wireMethod).length, tasks + 1, 'explicit original GetTask is the only new task request');
    assert.deepEqual(f.record().managed.events.log.filter(event => event.event_type === 'interaction.resolved'), decisions);
    assert.equal(f.calls.filter(call => call.wireMethod === 'SendMessage').length, kind === 'continue' && boundary === 'after-remote-apply' ? 2 : 1);
    assert.equal(f.calls.filter(call => call.wireMethod === 'CancelTask').length, kind === 'reject' && boundary === 'after-remote-apply' ? 1 : 0);
    t.diagnostic(JSON.stringify({ dsh, kind, boundary, killedPid: killed.pid, coldPid: cold.pid, thirdPid: observed.pid,
      immutableDecisions: decisions.length, coldTaskRequests: 0, explicitGetTask: 1 }));
  });
