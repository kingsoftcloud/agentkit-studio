import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { canonical } from '../packages/agentkit-harness-core/dist/index.mjs';
import { inboundFixture, ipcRequest, targetBinding } from './fixtures/native-a2a-inbound.mjs';
function worker(t, f, action, request) {
  const messages = [], child = fork(new URL('./fixtures/native-a2a-inbound-worker.mjs', import.meta.url), [], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env, AGENTKIT_KSADK_PYTHON: '/unavailable/python', PATH: '/unavailable/bin' } });
  t.after(() => child.kill('SIGKILL')); let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; });
  child.on('message', value => messages.push(value));
  const exited = new Promise((resolve, reject) => { child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, pid: child.pid, stderr })); });
  child.send({ directory: f.directory, publicKeyPem: f.signer.publicKeyPem, targetBinding, baseUrl: f.baseUrl, action, request: ipcRequest(request) });
  return { child, messages, exited };
}
for (const boundary of ['before-server-admission', 'admitted-response-lost'])
  test(`actual inbound SIGKILL ${boundary}: new PID inspects unchanged intent, explicit original admission alone may reconcile`, { timeout: 15000 }, async t => {
    const f = await inboundFixture(t); let reached, release;
    const ready = new Promise(resolve => { reached = resolve; });
    const hook = () => { reached(); return new Promise(resolve => { release = resolve; }); };
    if (boundary === 'before-server-admission') f.setBeforeAdmit(hook); else f.setHook(hook);
    const request = f.signer.request('send_message'), original = worker(t, f, 'submit', request);
    await Promise.race([ready, original.exited.then(exit => assert.fail(JSON.stringify(exit)))]);
    const saved = canonical(f.record()); assert.equal(Object.values(f.record().operations)[0].phase, 'prepared');
    original.child.kill('SIGKILL'); const killed = await original.exited;
    assert.equal(killed.signal, 'SIGKILL'); assert.throws(() => process.kill(killed.pid, 0), { code: 'ESRCH' });
    f.setBeforeAdmit(undefined); f.setHook(undefined); release(false);
    const cold = worker(t, f, 'inspect', f.signer.request('get_task')), coldExit = await cold.exited;
    assert.equal(coldExit.code, 0, coldExit.stderr); assert.notEqual(killed.pid, coldExit.pid);
    assert.equal(cold.messages[0].result.submission, null); assert.equal(cold.messages[0].result.uncertainOperations.length, 1);
    assert.equal(f.calls.length, 1); assert.equal(canonical(f.record()), saved);
    assert.equal(f.admitted.size, boundary === 'admitted-response-lost' ? 1 : 0);
    const explicit = worker(t, f, 'submit', request), restored = await explicit.exited;
    assert.equal(restored.code, 0, restored.stderr); assert.notEqual(restored.pid, coldExit.pid);
    assert.equal(explicit.messages[0].result.receipt.status, boundary === 'admitted-response-lost' ? 'duplicate' : 'accepted');
    assert.equal(f.calls.length, 2); assert.equal(f.admitted.size, 1); assert.deepEqual(f.calls[0].body, f.calls[1].body);
    t.diagnostic(JSON.stringify({ boundary, killedPid: killed.pid, coldPid: coldExit.pid, reconciledPid: restored.pid,
      signal: killed.signal, unchangedColdIntent: true, coldAdmissionHttp: 0, explicitAdmissionHttp: 1, serverCommands: 1, remoteSends: 0 }));
  });
