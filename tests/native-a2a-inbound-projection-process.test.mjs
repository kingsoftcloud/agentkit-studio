import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { join } from 'node:path';
import { canonical } from '@kingsoftcloud/agentkit-harness-core';
import { createA2aInboundTaskStore } from '../src/providers/native-a2a-inbound-task-store.mjs';
import { inboundFixture, ipcRequest, kernelFact, input, targetBinding } from './fixtures/native-a2a-inbound.mjs';

function worker(t, f, action, rows) {
  const child = fork(new URL('./fixtures/native-a2a-inbound-projection-worker.mjs', import.meta.url), [], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'advanced',
    env: { ...process.env, AGENTKIT_KSADK_PYTHON: '/unavailable/python', PATH: '/unavailable/bin' } });
  t.after(() => child.kill('SIGKILL')); let stderr = ''; const messages = [];
  child.stderr.on('data', data => { stderr += data; });
  let ready; const reached = new Promise(resolve => { ready = resolve; });
  child.on('message', message => { messages.push(message); if (message.type === 'boundary') ready(message); });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal, pid: child.pid, stderr })); });
  child.send({ directory: f.directory, taskDirectory: join(f.root, 'tasks'), publicKeyPem: f.signer.publicKeyPem,
    targetBinding, baseUrl: f.baseUrl, action, rows, request: ipcRequest(f.signer.request('get_task')) });
  return { child, messages, reached, exited };
}
for (const boundary of ['before-projection', 'after-projection-before-ack'])
  test(`actual SIGKILL ${boundary}: cold observation replays unacknowledged fact, preserves Task and does not admit work`, { timeout: 15000 }, async t => {
    const f = await inboundFixture(t), message = { messageId: 'original-message', parts: [{ text: 'original' }] },
      request = f.signer.request('send_message', { body: canonical({ jsonrpc: '2.0', id: 'request', method: 'SendMessage', params: { message } }) });
    const identity = f.verifier.verify(request), taskDirectory = join(f.root, 'tasks');
    const store = createA2aInboundTaskStore({ directory: taskDirectory, assertCurrent: () => true });
    const ids = { taskId: 'remote-original', contextId: 'context-original' };
    store.prepare(identity, { ...ids, message }); const submission = await f.service.submit(input(request));
    store.admitted(identity, { ...ids, message, submission });
    const rows = [kernelFact(1), kernelFact(2, { family: 'runtime', family_version: 2, event_type: 'run.completed', payload: {
      schema_version: 2, event_type: 'run.completed', run_id: 'run-original', scope_id: 'scope', output_refs: [] } }),
    kernelFact(3, { payload: { run_id: 'run-original', state: 'completed' } })];
    const first = worker(t, f, boundary, rows);
    const reached = await Promise.race([first.reached, first.exited.then(exit => assert.fail(JSON.stringify({ exit, messages: first.messages })))]);
    assert.equal(reached.cursor, boundary === 'before-projection' ? 0 : 1);
    const operation = Object.values(f.record().operations)[0]; assert.equal(operation.cursor, 0); assert.equal(operation.observedCursor, 1);
    first.child.kill('SIGKILL'); const killed = await first.exited;
    assert.equal(killed.signal, 'SIGKILL'); assert.throws(() => process.kill(killed.pid, 0), { code: 'ESRCH' });
    const cold = worker(t, f, 'drain', rows), exit = await cold.exited;
    assert.equal(exit.code, 0, JSON.stringify({ exit, messages: cold.messages })); assert.notEqual(exit.pid, killed.pid);
    const result = cold.messages.find(message => message.type === 'result');
    assert.deepEqual(result.duplicates, [boundary === 'after-projection-before-ack', false, false]);
    assert.equal(result.view.task.status.state, 'TASK_STATE_COMPLETED'); assert.equal(result.view.cursor, 3);
    assert.equal(result.view.task.history.length, 1); assert.equal(f.calls.length, 1); assert.equal(f.admitted.size, 1);
    assert.equal(Object.values(f.record().operations)[0].cursor, 3);
    t.diagnostic(JSON.stringify({ boundary, killedPid: killed.pid, coldPid: exit.pid, signal: killed.signal,
      replayDuplicate: result.duplicates[0], coldAdmissionHttp: 0, serverCommands: 1, finalTask: result.view.task.status.state }));
  });
