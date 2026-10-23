// No throw-as-crash simulation: peer-observed effects pause an actual child
// process, SIGKILL it, and open the same private journal in a distinct PID.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { internalPeer } from './fixtures/native-a2a-internal-peer.mjs';
function worker(f, action, request) {
  const messages = [], child = fork(new URL('./fixtures/native-a2a-internal-worker.mjs', import.meta.url), [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; }); child.stdout.resume();
  child.on('message', value => messages.push(value));
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal, stderr, pid: child.pid }));
  });
  child.send({ root: f.root, workspaceRoot: f.workspaceRoot, env: f.env, action, request });
  return { child, messages, exited };
}
for (const boundary of ['prepare', 'bind', 'send']) test(`actual SIGKILL after ${boundary} admission preserves intent and cold dispatch never repeats HTTP`, { timeout: 15000 }, async t => {
  const f = await internalPeer(); t.after(() => f.close());
  let reached, resume; const paused = new Promise(resolve => { reached = resolve; });
  f.setHook(call => {
    if (boundary === 'prepare' && call.action === 'PrepareA2ACall' || boundary === 'bind' && call.action === 'BindA2ARemoteTask'
      || boundary === 'send' && call.wireMethod === 'SendMessage') {
      reached(); return new Promise(resolve => { resume = resolve; });
    }
  });
  const first = worker(f, 'dispatch'); t.after(() => first.child.kill('SIGKILL'));
  await Promise.race([paused, first.exited.then(exit => assert.fail('Original exited before boundary: ' + JSON.stringify(exit)))]);
  const request = first.messages.find(value => value.type === 'request')?.request; assert.ok(request);
  const original = JSON.stringify(f.record()), calls = f.calls.length;
  assert.ok(Object.values(f.record().managed.operations).some(value => value.phase === (boundary === 'prepare' ? 'preparing' : 'transport')));
  if (boundary === 'bind') assert.equal(f.record().managed.remote.phase, 'binding');
  first.child.kill('SIGKILL'); const killed = await first.exited; assert.equal(killed.signal, 'SIGKILL');
  f.setHook(undefined); resume();
  const cold = worker(f, 'dispatch', request); t.after(() => cold.child.kill('SIGKILL'));
  const reopened = await cold.exited; assert.equal(reopened.code, 0, reopened.stderr); assert.notEqual(reopened.pid, killed.pid);
  assert.equal(cold.messages.find(value => value.type === 'result')?.result.state, 'unknown');
  assert.equal(f.calls.length, calls); assert.equal(JSON.stringify(f.record()), original);
  if (boundary === 'bind') {
    // The server applied Bind before SIGKILL. A separately approved Get can
    // reconcile that fact; it must not replay Bind or the original message.
    const inspector = worker(f, 'get', request); t.after(() => inspector.child.kill('SIGKILL'));
    const exit = await inspector.exited; assert.equal(exit.code, 0, exit.stderr);
    assert.equal(inspector.messages.find(value => value.type === 'result')?.result.state, 'completed');
    assert.equal(f.record().managed.remote.phase, 'bound');
    assert.equal(f.calls.filter(value => value.action === 'BindA2ARemoteTask').length, 1);
    assert.equal(f.calls.filter(value => value.wireMethod === 'SendMessage').length, 1);
  }
  t.diagnostic(JSON.stringify({ boundary, killedPid: killed.pid, coldPid: reopened.pid, signal: killed.signal, unchangedColdJournal: true, coldHttp: 0 }));
});
