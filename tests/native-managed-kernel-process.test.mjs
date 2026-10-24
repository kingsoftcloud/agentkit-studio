import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, realpathSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { permitIssuer, command, target, scope } from './fixtures/native-managed-kernel.mjs';
import { createManagedNativeKernel } from '../src/providers/native-managed-kernel.mjs';
import { assertManagedRuntimeFacts } from './fixtures/native-managed-runtime-schema.mjs';

const lines = path => existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
function worker(t, message) {
  const child = fork(new URL('./fixtures/native-managed-kernel-worker.mjs', import.meta.url), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    serialization: 'advanced', env: { ...process.env, PATH: '/unavailable/bin', AGENTKIT_KSADK_PYTHON: '/unavailable/python' } });
  t.after(() => child.kill('SIGKILL')); let stderr = ''; const messages = [];
  child.stderr.on('data', data => { stderr += data; });
  let reached; const boundary = new Promise(resolve => { reached = resolve; });
  child.on('message', message => { messages.push(message); if (message.type === 'boundary') reached(message); });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal, pid: child.pid, stderr })); });
  child.send(message); return { child, messages, boundary, exited };
}

test('a paused whole-Run worker observes another process delivering its durable resume', { timeout: 15000 }, async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'managed-owner-wake-'))); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const issuer = permitIssuer(), cmd = command();
  const query = { tenant_id: target.tenantId, agent_instance_id: target.agentInstanceId, session_id: cmd.session_id, authorization_ref: randomUUID() };
  const subscription = { ...query, authorization_ref: randomUUID(), after_seq: 0 };
  const common = { directory, publicKeyPem: issuer.publicKeyPem, sessionId: cmd.session_id, query, readPermit: issuer.issue(query, 'get_status'),
    subscription, subscribePermit: issuer.issue(subscription, 'subscribe_events') };
  const { managedNativeRunId } = await import('../src/providers/native-managed-kernel.mjs');
  const runId = managedNativeRunId(cmd), pause = command({ command_type: 'pause', payload: { run_id: runId } });
  const owner = worker(t, { ...common, command: cmd, permit: issuer.issue(cmd), withExecution: true, boundary: 'paused',
    controls: [{ command: pause, permit: issuer.issue(pause) }] });
  await Promise.race([owner.boundary, owner.exited.then(exit => assert.fail(JSON.stringify({ exit, messages: owner.messages })))]);
  assert.equal(lines(join(directory, 'models.jsonl')).length, 0); assert.equal(lines(join(directory, 'effects.jsonl')).length, 0);
  const resume = command({ command_type: 'resume', payload: { target: { kind: 'run', id: runId } } });
  const receiver = worker(t, { ...common, command: resume, permit: issuer.issue(resume), receiveOnly: true });
  const receiverExit = await receiver.exited; assert.equal(receiverExit.code, 0, JSON.stringify(receiver.messages));
  const ownerExit = await owner.exited; assert.equal(ownerExit.code, 0, JSON.stringify(owner.messages));
  assert.notEqual(ownerExit.pid, receiverExit.pid);
  const result = owner.messages.find(message => message.type === 'result'); assert.equal(result.status.runs[0].runId, runId);
  assert.equal(result.status.runs[0].phase, 'completed'); assertManagedRuntimeFacts(result.facts);
  const models = lines(join(directory, 'models.jsonl')), effects = lines(join(directory, 'effects.jsonl'));
  assert.equal(models.length, 2); assert.equal(effects.length, 1);
  assert.ok([...models, ...effects].every(row => row.pid === ownerExit.pid));
  t.diagnostic(JSON.stringify({ boundary: 'paused-cross-process-resume', ownerPid: ownerExit.pid, receiverPid: receiverExit.pid,
    runId, models: 2, fileWrites: 1, receiverEffects: 0, finalState: 'completed' }));
});

test('expired live worker cannot overwrite a takeover or cause its unknown file tool to be dispatched again', { timeout: 15000 }, async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'managed-kernel-fence-'))); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const issuer = permitIssuer(), cmd = command();
  const query = { tenant_id: target.tenantId, agent_instance_id: target.agentInstanceId, session_id: cmd.session_id, authorization_ref: randomUUID() };
  const subscription = { ...query, authorization_ref: randomUUID(), after_seq: 0 };
  const common = { directory, publicKeyPem: issuer.publicKeyPem, sessionId: cmd.session_id, query, readPermit: issuer.issue(query, 'get_status'),
    subscription, subscribePermit: issuer.issue(subscription, 'subscribe_events') };
  const old = worker(t, { ...common, command: cmd, permit: issuer.issue(cmd), boundary: 'after-effect' });
  await Promise.race([old.boundary, old.exited.then(exit => assert.fail(JSON.stringify({ exit, messages: old.messages })))]);
  old.child.kill('SIGSTOP'); await delay(1100);
  const takeover = worker(t, common), takeoverExit = await takeover.exited;
  assert.equal(takeoverExit.code, 0, JSON.stringify({ takeoverExit, messages: takeover.messages }));
  const recovered = takeover.messages.find(message => message.type === 'result'); assert.equal(recovered.status.runs[0].phase, 'interrupted');
  old.child.kill('SIGCONT'); old.child.send({ type: 'continue' });
  const retired = await old.exited; assert.equal(retired.code, 1);
  const error = old.messages.find(message => message.type === 'failure'); assert.equal(error.code, 'stale_fence');
  const reader = worker(t, common), readExit = await reader.exited; assert.equal(readExit.code, 0, JSON.stringify(reader.messages));
  const final = reader.messages.find(message => message.type === 'result'); assert.deepEqual(final.facts, recovered.facts);
  assert.equal(final.status.runs[0].phase, 'interrupted'); assert.equal(lines(join(directory, 'effects.jsonl')).length, 1);
  assert.equal(lines(join(directory, 'models.jsonl')).length, 1); assertManagedRuntimeFacts(final.facts);
  t.diagnostic(JSON.stringify({ oldPid: retired.pid, takeoverPid: takeoverExit.pid, readerPid: readExit.pid,
    oldWorkerFailure: error.code, fileWrites: 1, takeoverFileWrites: 0, finalState: final.status.runs[0].phase, factsUnchanged: true }));
});

test('cold automatic scheduling waits for an unexpired killed-worker lease without a new command or drain', { timeout: 15000 }, async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'managed-kernel-auto-'))); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const issuer = permitIssuer(), cmd = command();
  const query = { tenant_id: target.tenantId, agent_instance_id: target.agentInstanceId, session_id: cmd.session_id, authorization_ref: randomUUID() };
  const subscription = { ...query, authorization_ref: randomUUID(), after_seq: 0 };
  const common = { directory, publicKeyPem: issuer.publicKeyPem, sessionId: cmd.session_id, query, readPermit: issuer.issue(query, 'get_status'),
    subscription, subscribePermit: issuer.issue(subscription, 'subscribe_events') };
  const initial = worker(t, { ...common, boundary: 'after-effect', command: cmd, permit: issuer.issue(cmd) });
  await Promise.race([initial.boundary, initial.exited.then(exit => assert.fail(JSON.stringify({ exit, messages: initial.messages })))]);
  initial.child.kill('SIGKILL'); assert.equal((await initial.exited).signal, 'SIGKILL');
  const cold = worker(t, { ...common, autoStart: true, observeAutomatic: true }), exit = await cold.exited;
  assert.equal(exit.code, 0, JSON.stringify(cold.messages));
  const result = cold.messages.find(row => row.type === 'result');
  assert.equal(result.status.runs[0].phase, 'interrupted'); assert.equal(result.status.workerError, null);
  assert.equal(lines(join(directory, 'effects.jsonl')).length, 1); assert.equal(lines(join(directory, 'models.jsonl')).length, 1);
  t.diagnostic(JSON.stringify({ killedPid: initial.child.pid, coldPid: exit.pid, noCommandOrDrain: true, models: 1, fileWrites: 1, finalState: 'interrupted' }));
});

for (const boundary of ['before-start', 'after-effect', 'before-projection']) {
  test(`SIGKILL ${boundary}: cold worker keeps original receipt/Run and never repeats an unknown write`, { timeout: 15000 }, async t => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'managed-kernel-crash-'))); t.after(() => rmSync(directory, { recursive: true, force: true }));
    const issuer = permitIssuer(), cmd = command();
    const query = { tenant_id: target.tenantId, agent_instance_id: target.agentInstanceId, session_id: cmd.session_id, authorization_ref: randomUUID() };
    const subscription = { ...query, authorization_ref: randomUUID(), after_seq: 0 };
    const common = { directory, publicKeyPem: issuer.publicKeyPem, sessionId: cmd.session_id, query, readPermit: issuer.issue(query, 'get_status'),
      subscription, subscribePermit: issuer.issue(subscription, 'subscribe_events') };
    const initial = worker(t, { ...common, boundary, command: cmd, permit: issuer.issue(cmd) });
    const reached = await Promise.race([initial.boundary, initial.exited.then(exit => assert.fail(JSON.stringify({ exit, messages: initial.messages })))]);
    assert.equal(reached.boundary, boundary); const receipt = initial.messages.find(message => message.type === 'receipt').receipt;
    assert.equal(receipt.status, 'accepted');
    const before = { effects: lines(join(directory, 'effects.jsonl')).length, models: lines(join(directory, 'models.jsonl')).length };
    assert.equal(before.effects, boundary === 'before-start' ? 0 : 1);
    initial.child.kill('SIGKILL'); const killed = await initial.exited;
    assert.equal(killed.signal, 'SIGKILL'); assert.throws(() => process.kill(killed.pid, 0), { code: 'ESRCH' });
    await delay(1100); // Expire the *actual* 1000ms Native execution lease.
    const cold = worker(t, { ...common, command: cmd, permit: issuer.issue(cmd) }), exit = await cold.exited;
    assert.equal(exit.code, 0, JSON.stringify({ exit, messages: cold.messages })); assert.notEqual(exit.pid, killed.pid);
    const duplicate = cold.messages.find(message => message.type === 'receipt').receipt, result = cold.messages.find(message => message.type === 'result');
    assert.equal(duplicate.status, 'duplicate'); assert.equal(duplicate.message_id, receipt.message_id); assert.equal(duplicate.run_id, receipt.run_id);
    assert.equal(result.status.runs[0].runId, receipt.run_id); assert.equal(result.status.runs[0].phase, boundary === 'after-effect' ? 'interrupted' : 'completed');
    assert.equal(lines(join(directory, 'effects.jsonl')).length, 1);
    assert.equal(lines(join(directory, 'models.jsonl')).length, boundary === 'after-effect' ? 1 : 2);
    assert.equal(new Set(result.facts.map(fact => fact.event_id)).size, result.facts.length);
    assert.deepEqual(result.facts.map(fact => fact.seq), result.facts.map((_, index) => index + 1));
    assert.equal(result.facts.at(-1).payload.state, boundary === 'after-effect' ? 'interrupted' : 'completed');
    assertManagedRuntimeFacts(result.facts);
    const observer = createManagedNativeKernel({ directory, target, autoStart: false, assertCurrent: () => true,
      permitVerifier: issuer.verifier, resolveBinding: () => assert.fail('Status and terminal confirmation cannot rebind execution') });
    try {
      const inspection = { scope, sessionId: cmd.session_id, runId: receipt.run_id };
      assert.equal(observer.inspectSession(inspection).record.snapshot.phase, result.status.runs[0].phase);
      assert.equal(observer.retryAcceptedRun(inspection).record.snapshot.phase, result.status.runs[0].phase);
      assert.equal(lines(join(directory, 'effects.jsonl')).length, 1);
      assert.equal(lines(join(directory, 'models.jsonl')).length, boundary === 'after-effect' ? 1 : 2);
    } finally { await observer.close(); }
    t.diagnostic(JSON.stringify({ boundary, killedPid: killed.pid, coldPid: exit.pid, signal: killed.signal, nativeRunId: receipt.run_id,
      originalMessageId: receipt.message_id, fileWrites: 1, coldFileWrites: boundary === 'before-start' ? 1 : 0,
      coldModelCalls: boundary === 'before-start' ? 2 : 0, finalState: result.status.runs[0].phase }));
  });
}
