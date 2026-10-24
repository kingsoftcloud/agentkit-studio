// Actual lost append acknowledgements across SIGKILL, not throw-as-crash.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { internalPeer } from './fixtures/native-a2a-internal-peer.mjs';
const facts = record => {
  const value = structuredClone(record);
  if (value.managed.events) { delete value.managed.events.pending; delete value.managed.events.delivered; }
  return value;
};
function worker(f, action) {
  const messages = [], child = fork(new URL('./fixtures/native-a2a-internal-worker.mjs', import.meta.url), [],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); let stderr = '';
  child.stdout.resume(); child.stderr.on('data', chunk => { stderr += chunk; }); child.on('message', message => messages.push(message));
  const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal, pid: child.pid, stderr })); });
  child.send({ root: f.root, workspaceRoot: f.workspaceRoot, env: f.env, action });
  return { child, messages, exit };
}
for (const boundary of ['before-response', 'after-remote-apply']) test(`SIGKILL ${boundary}: startup replays immutable event batches, with no model turn or task HTTP`, { timeout: 15000 }, async t => {
  const f = await internalPeer({ initialTask: { id: 'original-remote', contextId: 'original-context', status: { state: 'TASK_STATE_COMPLETED' },
    artifacts: [{ artifactId: 'retained-result', name: 'report', parts: [{ text: 'durable result' }, { raw: 'AAEC/w==', mediaType: 'application/octet-stream' }] }] } });
  t.after(() => f.close());
  const accepted = new Map(), observed = [];
  let reached, resume, pause = true;
  const entered = new Promise(resolve => { reached = resolve; });
  f.setHook((call, res) => {
    if (call.action !== 'AppendA2ATaskEvents') return;
    observed.push(structuredClone(call.body));
    if (boundary === 'after-remote-apply' || !pause) for (const event of call.body.Events) {
      const bytes = JSON.stringify(event); if (accepted.has(event.event_id)) assert.equal(accepted.get(event.event_id), bytes);
      accepted.set(event.event_id, bytes);
    }
    if (pause) { reached(); return new Promise(resolve => { resume = resolve; }); }
  });
  const initial = worker(f, 'dispatch'); t.after(() => initial.child.kill('SIGKILL'));
  await Promise.race([entered, initial.exit.then(value => assert.fail('process ended before append: ' + JSON.stringify(value)))]);
  // Allow the original tool to finish independently of the hung projection
  // sink. The worker closes with a bounded flush, so it remains alive here.
  const deadline = Date.now() + 4000;
  while (f.record().phase !== 'terminal') { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5)); }
  const original = facts(f.record()), originalLog = structuredClone(f.record().managed.events.log), initialBatch = observed[0];
  assert.ok(originalLog.some(event => event.item_kind === 'artifact' && event.event_type === 'item.completed'
    && event.snapshot.parts[1].data.base64 === 'AAEC/w=='));
  assert.equal(f.calls.filter(call => call.wireMethod === 'GetTask').length, 1);
  assert.ok(f.record().managed.events.pending.length > 0);
  const taskRequests = f.calls.filter(call => call.action !== 'AppendA2ATaskEvents').length;
  initial.child.kill('SIGKILL'); const killed = await initial.exit; assert.equal(killed.signal, 'SIGKILL');
  pause = false; resume(); f.rotate('a2a-task-sink', 7);
  const restored = worker(f, 'restore-events'); t.after(() => restored.child.kill('SIGKILL'));
  const cold = await restored.exit; assert.equal(cold.code, 0, cold.stderr); assert.notEqual(cold.pid, killed.pid);
  assert.equal(restored.messages.find(message => message.type === 'restored-events')?.restored, 1);
  assert.equal(f.calls.filter(call => call.action !== 'AppendA2ATaskEvents').length, taskRequests);
  assert.deepEqual(observed[1], initialBatch); assert.deepEqual(facts(f.record()), original);
  assert.equal(f.record().managed.events.pending.length, 0); assert.equal(accepted.size, originalLog.length);
  for (const event of originalLog) assert.equal(accepted.get(event.event_id), JSON.stringify(event));
  const requests = f.calls.length, final = JSON.stringify(f.record()), again = worker(f, 'restore-events');
  const reopened = await again.exit; assert.equal(reopened.code, 0, reopened.stderr);
  assert.equal(again.messages.find(message => message.type === 'restored-events')?.restored, 0);
  assert.equal(f.calls.length, requests); assert.equal(JSON.stringify(f.record()), final);
  t.diagnostic(JSON.stringify({ boundary, killedPid: killed.pid, coldPid: cold.pid, thirdPid: reopened.pid,
    taskRequestsAfterRestart: 0, immutableEvents: originalLog.length, accepted: accepted.size, pending: 0 }));
});
