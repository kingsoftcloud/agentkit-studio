// Real SIGKILL at subscription permit and open transport boundaries. The same
// original task is reopened by a distinct Node PID, without automatic reconnect.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { internalPeer, spec, scope } from './fixtures/native-a2a-internal-peer.mjs';
import { prepareNativeA2AHost } from '../src/providers/native-a2a-host.mjs';
import { join } from 'node:path';

const effects = calls => calls.filter(call => call.action !== 'AppendA2ATaskEvents');
function worker(f, action, request) {
  const messages = [], child = fork(new URL('./fixtures/native-a2a-internal-worker.mjs', import.meta.url), [], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, AGENTKIT_KSADK_PYTHON: '/unavailable/python' } });
  let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; }); child.stdout.resume();
  child.on('message', value => messages.push(value));
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal, pid: child.pid, stderr }));
  });
  child.send({ root: f.root, workspaceRoot: f.workspaceRoot, env: f.env, action, request });
  return { child, messages, exited };
}
for (const boundary of ['prepare', 'transport']) test(`subscription SIGKILL during ${boundary}: cold owner does not reconnect or send`, { timeout: 15000 }, async t => {
  const f = await internalPeer({ mode: 'pause', streaming: true }); t.after(() => f.close());
  const factory = prepareNativeA2AHost({ env: f.env, bindings: [spec] }); t.after(() => factory.close());
  const owner = factory.forSession({ scope, sessionId: 'session', workspaceRoot: f.workspaceRoot,
    stateRoot: join(f.root, 'state'), assertCurrent: () => true, assertControl: () => true, authorizeControl: () => 'allow' });
  f.owners.push(owner);
  const signal = new AbortController().signal;
  const request = await owner.invocation.resolve({ agent: 'research', message: 'Hello😀', signal,
    nativeRequest: { scope, sessionId: 'session', runId: 'run', operationKey: 'original-operation', call: { callId: 'call' } } });
  const originalResult = await owner.invocation.dispatch({ request, signal }); assert.equal(originalResult.state, 'input_required'); owner.close();
  let reached, release; const ready = new Promise(resolve => { reached = resolve; });
  f.setHook(call => {
    if (boundary === 'prepare' && call.action === 'PrepareA2ATaskOperation' && call.body.Operation === 'subscribe_to_task'
      || boundary === 'transport' && call.wireMethod === 'SubscribeToTask') {
      reached(); return new Promise(resolve => { release = resolve; });
    }
  });
  const observing = worker(f, 'subscribe', request); t.after(() => observing.child.kill('SIGKILL'));
  await Promise.race([ready, observing.exited.then(exit => assert.fail(JSON.stringify(exit)))]);
  const saved = f.record(), network = effects(f.calls).length;
  const killed = observing.exited; observing.child.kill('SIGKILL');
  const original = await killed; assert.equal(original.signal, 'SIGKILL');
  assert.throws(() => process.kill(original.pid, 0), { code: 'ESRCH' });
  f.setHook(undefined); release();
  const cold = worker(f, 'dispatch', request); t.after(() => cold.child.kill('SIGKILL'));
  const restored = await cold.exited; assert.equal(restored.code, 0, restored.stderr); assert.notEqual(restored.pid, original.pid);
  assert.deepEqual(cold.messages.find(value => value.type === 'result')?.result, originalResult);
  assert.equal(effects(f.calls).length, network);
  assert.deepEqual(f.record().managed.operations, saved.managed.operations);
  assert.deepEqual(f.record().controls, saved.controls);
  assert.equal(f.calls.filter(call => call.wireMethod?.startsWith('Send')).length, 1);
  t.diagnostic(JSON.stringify({ boundary, killedPid: original.pid, coldPid: restored.pid, originalSends: 1,
    coldTaskHttp: 0, subscriptionIntentsUnchanged: true, signal: 'SIGKILL' }));
});
