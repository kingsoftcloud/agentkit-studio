// Actual Native Kernel/SQLite, HTTP peer/control-plane, original private
// journal and cross-process locks. Human presentation and operation receipts
// are explicit doubles; maintained services are verified separately.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { NativeKernel, initialSnapshot, emptyUsage } from '../packages/agentkit-harness-core/dist/index.mjs';
import { fixture, digest } from '../packages/agentkit-harness-core/test/fixtures.mjs';
import { SqliteRunStore } from '../packages/agentkit-harness/src/native/sqlite-store.mjs';
import { createNativeA2aToolPort, nativeA2aToolDefinitions } from '../packages/agentkit-harness/src/native/a2a-tools.mjs';
import { prepareNativeA2AHost } from '../src/providers/native-a2a-host.mjs';
import { createNativeToolAuthority } from '../src/providers/native-tool-authority.mjs';
import { createNativeA2aReceiptObserver, createNativeA2aReceiptWaiter, createNativeA2aQuestionTerminator } from '../src/providers/native-a2a-receipt.mjs';
import { internalPeer, scope, spec } from './fixtures/native-a2a-internal-peer.mjs';
import { controlConsent } from './fixtures/native-a2a-control-consent.mjs';
import { nativeRecoveryBinding } from '../src/providers/native-recovery-binding.mjs';
const remoteTask = (approval = false) => ({ id: 'original-remote', contextId: 'original-context', status: {
  state: 'TASK_STATE_INPUT_REQUIRED', message: { messageId: 'question', role: 'ROLE_AGENT', parts: [{ text: 'City?' }], metadata: {
    input_schema: { type: 'string', ...(approval ? { enum: ['approve', 'reject'] } : {}) },
    ...(approval ? { ksadk_interaction: { version: 1, kind: 'approval', allowed_decisions: ['approve', 'reject'],
      presentation: { title: 'remote-write', description: '{"arguments":{}}' } } } : {}) } } } });
async function setup(t, { approval = false, timeout = 90, rootRecovery = false, ...options } = {}) {
  const f = await internalPeer({ initialTask: remoteTask(approval), expectedContinuationParts: [{ data: approval ? 'approve' : 'Shanghai' }], ...options });
  const bindings = [{ ...spec, timeout_seconds: timeout }], path = join(f.root, 'runs.sqlite');
  let store = new SqliteRunStore(path), closed = false;
  const a2a = prepareNativeA2AHost({ env: f.env, bindings });
  const ownedScope = rootRecovery ? { ...scope, userId: 'local-user' } : scope;
  const fields = { a2a, scope: ownedScope, sessionId: 'session', stateRoot: join(f.root, 'state'), workspaceRoot: f.workspaceRoot, isClosed: () => closed };
  const authority = createNativeToolAuthority({ scope: ownedScope, sessionId: 'session', store });
  const owner = a2a.forSession({ ...fields, assertCurrent: authority }); f.owners.push(owner);
  t.after(async () => { closed = true; await a2a.close(); store.close(); await f.close(); });
  const port = createNativeA2aToolPort({ ...owner, scope: ownedScope, sessionId: 'session', spaceId: spec.space_id,
    authorize: () => 'allow', assertCurrent: authority, receiptObservation: true });
  let models = 0;
  const ports = { model: { generate: async () => ++models === 1 ? { kind: 'tool_calls', text: '', usage: emptyUsage(),
    toolCalls: [{ callId: 'call', name: 'call_a2a_agent', arguments: { agent: 'research', message: 'original' } }] }
    : { kind: 'final_candidate', text: 'finished', toolCalls: [], usage: emptyUsage() } },
    tools: { execute: request => port.execute(request), observeReceipt: request => createNativeA2aReceiptObserver({ ...fields, store })(request) } };
  let kernel = new NativeKernel({ store, digest, owner: 'original', ports });
  const hostRecoveryBinding = rootRecovery ? nativeRecoveryBinding({ binding: { agentId: ownedScope.agentId, agentRevision: 1 },
    input: { messages: [{ role: 'user', id: 'input', content: [{ type: 'text', text: 'original' }] }] },
    source: { provider: 'fixture', model: 'original' }, selection: {}, systemPrompt: 'system' }) : undefined;
  const { config } = fixture({ tools: nativeA2aToolDefinitions({ receiptObservation: true }), hostRecoveryBinding });
  kernel.start(initialSnapshot({ scope: ownedScope, sessionId: 'session', runId: 'run', turnId: 'turn', buildId: 'build',
    parentRunId: null, taskChainId: 'chain' }, config, digest(config)), config);
  const snapshot = await kernel.runUntilIdle(ownedScope, 'run'); assert.equal(snapshot.phase, 'awaiting_reconciliation');
  return { ...f, fields, bindings, path, snapshot, models: () => models, get store() { return store; },
    wait: (questionHost, signal = new AbortController().signal) => createNativeA2aReceiptWaiter({ ...fields, store })({ snapshot, signal, questionHost }),
    resume: async command => { kernel.submit(ownedScope, 'run', command); return kernel.runUntilIdle(ownedScope, 'run'); },
    reopen: () => { store.close(); store = new SqliteRunStore(path); kernel = new NativeKernel({ store, digest, owner: 'cold', ports }); },
  };
}
const submit = () => ({ action: 'submit', parts: [{ data: 'Shanghai' }] });
const host = (present = submit, authorizeControl = controlConsent) => ({ present, authorizeControl });

test('answer is durable before separate operation consent and original Run resumes once', async t => {
  const f = await setup(t); let questions = 0, grants = 0;
  const command = await f.wait(host(() => { questions++; return submit(); }, input => {
    if (!input.readOnly) {
      grants++; const entry = Object.values(f.record().managed.questions.entries)[0];
      assert.equal(entry.status, 'submitted'); assert.equal(entry.stage, 'awaiting_permission');
      assert.deepEqual(entry.parts, [{ data: 'Shanghai' }]);
      assert.equal(f.record().managed.events.log.filter(event => event.event_type === 'interaction.resolved').length, 0);
      assert.equal(f.calls.filter(call => call.wireMethod === 'SendMessage').length, 1);
      assert.equal(Object.values(f.record().controls ?? {}).filter(entry => entry.phase === 'sending').length, 0);
    }
    return controlConsent(input);
  }));
  assert.equal(questions, 1); assert.equal(grants, 1);
  assert.equal((await f.resume(command)).phase, 'completed'); assert.equal(f.models(), 2);
  assert.equal(f.store.load(scope, 'run').intents.filter(intent => intent.kind === 'tool').length, 1);
  assert.equal(f.calls.filter(call => call.wireMethod === 'SendMessage').length, 2);
  const localEvents = f.record().managed.questions.log;
  assert.equal(localEvents.length, 3); assert.deepEqual(localEvents.map(event => event.seq), [1, 2, 3]);
  await delay(80);
  const remoteEvents = f.calls.filter(call => call.action === 'AppendA2ATaskEvents').flatMap(call => call.body.Events);
  assert.ok(localEvents.every(event => !remoteEvents.some(remote => remote.event_id === event.event_id)), 'question ledger is local-only');
});

for (const approval of [false, true]) test(`${approval ? 'approval' : 'input'} answer survives local permission denial without cancellation`, async t => {
  const f = await setup(t, { approval });
  const command = await f.wait(host(() => approval ? { action: 'approve' } : submit(), () => 'deny'));
  assert.equal(f.record().managed.questionOutcome.outcome, 'operation_denied');
  assert.equal(Object.values(f.record().managed.questions.entries)[0].status, approval ? 'approved' : 'submitted');
  assert.equal(f.calls.filter(call => call.wireMethod === 'SendMessage').length, 1);
  assert.equal(f.calls.filter(call => call.wireMethod === 'CancelTask').length, 0);
  assert.equal((await f.resume(command)).phase, 'completed');
  const saved = f.store.load(scope, 'run');
  const readIntent = saved.intents.find(intent => intent.kind === 'tool_receipt');
  const receipt = saved.receipts.find(receipt => receipt.operationKey === readIntent?.operationKey);
  assert.equal(receipt?.result.result.status, 'error');
  assert.equal(receipt.result.result.content.error_type, 'A2A_APPROVAL_DENIED');
  assert.equal(receipt.result.result.content.remote_state, 'input_required');
  assert.equal(saved.events.filter(event => event.kind === 'tool.completed'
    && event.payload.content?.error_type === 'A2A_APPROVAL_DENIED').length, 1);
});

test('ordinary input rejection ends the original call locally without remote cancellation or operation consent', async t => {
  const f = await setup(t);
  const command = await f.wait(host(() => ({ action: 'reject' }), () => assert.fail('input rejection is not a remote operation')));
  assert.equal(f.record().managed.questionOutcome.errorCode, 'A2A_INPUT_REJECTED');
  assert.equal(f.record().projection.state, 'input_required');
  assert.equal(f.calls.filter(call => call.wireMethod === 'CancelTask').length, 0);
  assert.equal(f.calls.filter(call => call.wireMethod === 'SendMessage').length, 1);
  assert.equal((await f.resume(command)).phase, 'completed');
});

test('remote approval rejection separately authorizes original CancelTask, never supplemental reject', async t => {
  const f = await setup(t, { approval: true }); let grants = 0;
  const command = await f.wait(host(() => ({ action: 'reject' }), input => {
    if (!input.readOnly) { grants++; assert.equal(input.command.kind, 'reject');
      assert.equal(Object.values(f.record().managed.questions.entries)[0].status, 'rejected'); }
    return controlConsent(input);
  }));
  assert.equal(grants, 1); assert.equal(f.calls.filter(call => call.wireMethod === 'CancelTask').length, 1);
  assert.equal(f.calls.filter(call => call.wireMethod === 'SendMessage').length, 1);
  assert.equal((await f.resume(command)).phase, 'completed');
});

test('original deadline expires an uncooperative question without sending or cancelling', async t => {
  const f = await setup(t, { timeout: 1 }); const deadline = f.record().deadlineAt;
  const command = await f.wait(host(() => new Promise(() => {}), () => assert.fail('expired question cannot authorize a send')));
  assert.equal(f.record().deadlineAt, deadline); assert.equal(f.record().managed.questionOutcome.errorCode, 'A2A_OVERALL_TIMEOUT');
  assert.equal(f.calls.filter(call => call.wireMethod === 'SendMessage').length, 1);
  assert.equal(f.calls.filter(call => call.wireMethod === 'CancelTask').length, 0);
  assert.equal((await f.resume(command)).phase, 'completed');
});

test('withdrawn presentation cannot commit a late answer; SQLite reopen may ask the original unresolved question', async t => {
  const f = await setup(t); let entered, late;
  const ready = new Promise(resolve => { entered = resolve; }), controller = new AbortController();
  const work = f.wait(host(() => { entered(); return new Promise(resolve => { late = resolve; }); }), controller.signal);
  const stopped = assert.rejects(work, /withdraw/); await ready; controller.abort(Error('withdraw')); await stopped;
  late(submit()); await delay(30);
  assert.equal(Object.values(f.record().managed.questions.entries)[0].status, 'pending');
  f.reopen(); let asks = 0;
  const command = await f.wait(host(() => { asks++; return submit(); }));
  assert.equal(asks, 1); assert.equal((await f.resume(command)).phase, 'completed');
  assert.equal(f.calls.filter(call => call.wireMethod === 'SendMessage').length, 2);
});

test('concurrent waiters share one question owner and deterministic original receipt command', async t => {
  const f = await setup(t); let entered, answer, asks = 0, grants = 0;
  const ready = new Promise(resolve => { entered = resolve; });
  const services = host(() => { asks++; entered(); return new Promise(resolve => { answer = resolve; }); }, input => {
    if (!input.readOnly) grants++; return controlConsent(input);
  });
  const first = f.wait(services); await ready; const second = f.wait(services); await delay(150);
  assert.equal(asks, 1); answer(submit()); const commands = await Promise.all([first, second]);
  assert.deepEqual(commands[0], commands[1]); assert.equal(asks, 1); assert.equal(grants, 1);
  assert.equal(f.calls.filter(call => call.wireMethod === 'SendMessage').length, 2);
});

test('confirmed identical questions receive distinct answers/permissions without another initial invocation', async t => {
  const f = await setup(t, { continuationTasks: [remoteTask()] }); let asks = 0, grants = 0;
  const command = await f.wait(host(() => { asks++; return submit(); }, input => { if (!input.readOnly) grants++; return controlConsent(input); }));
  assert.equal(asks, 2); assert.equal(grants, 2); assert.equal(Object.keys(f.record().managed.questions.entries).length, 2);
  assert.equal((await f.resume(command)).phase, 'completed');
  assert.equal(f.calls.filter(call => call.wireMethod === 'SendMessage').length, 3);
});

test('a stale answer cannot replace a remote question that changed during presentation', async t => {
  const f = await setup(t); let asks = 0;
  const command = await f.wait(host(() => { asks++; return submit(); }, input => {
    if (asks === 1) f.setTask({ ...remoteTask(), status: { ...remoteTask().status,
      message: { ...remoteTask().status.message, messageId: 'changed-question' } } });
    return controlConsent(input);
  }));
  assert.equal(asks, 2); assert.equal(Object.keys(f.record().managed.questions.entries).length, 2);
  assert.equal(f.calls.filter(call => call.wireMethod === 'SendMessage').length, 2);
  assert.equal((await f.resume(command)).phase, 'completed');
});

for (const approval of [false, true]) test(`${approval ? 'approval' : 'input'} permission wait retains the original absolute deadline`, async t => {
  const f = await setup(t, { approval, timeout: 1 }); let pending;
  const command = await f.wait(host(() => approval ? { action: 'reject' } : submit(), () => new Promise(resolve => { pending = resolve; })));
  assert.equal(f.record().managed.questionOutcome.errorCode, 'A2A_OVERALL_TIMEOUT');
  const entry = Object.values(f.record().managed.questions.entries)[0];
  assert.equal(entry.status, approval ? 'rejected' : 'submitted'); assert.equal(entry.stage, 'expired');
  assert.equal(f.calls.filter(call => call.wireMethod === 'SendMessage').length, 1);
  assert.equal(f.calls.filter(call => call.wireMethod === 'CancelTask').length, 0);
  pending('allow'); await delay(30);
  assert.equal(Object.values(f.record().controls ?? {}).length, 0, 'late permission cannot admit an expired effect');
  assert.equal((await f.resume(command)).phase, 'completed');
});

function questionWorker(f, action, approval) {
  const child = fork(new URL('./fixtures/a2a-question-wait-worker.mjs', import.meta.url), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; const messages = [];
  child.stderr.on('data', bytes => { stderr += bytes; }); child.on('message', message => messages.push(message));
  const exit = new Promise((resolve, reject) => { child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, pid: child.pid, stderr })); });
  const boundary = new Promise(resolve => child.on('message', message => {
    if (message.type === 'answer-durable-before-permission') resolve(message);
  }));
  child.send({ root: f.root, workspaceRoot: f.workspaceRoot, env: f.env, bindings: f.bindings, action, approval });
  return { child, messages, exit, boundary };
}
for (const approval of [false, true]) test(`SIGKILL after ${approval ? 'approval' : 'input'} answer: cold process reuses answer but requests fresh operation permission`, { timeout: 15000 }, async t => {
  const f = await setup(t, { approval }); await f.fields.a2a.close();
  const original = f.store.load(scope, 'run');
  const first = questionWorker(f, 'answer', approval); t.after(() => first.child.kill('SIGKILL'));
  await Promise.race([first.boundary, first.exit.then(result => assert.fail(JSON.stringify(result)))]);
  const before = f.record(), entry = Object.values(before.managed.questions.entries)[0];
  assert.equal(entry.status, approval ? 'approved' : 'submitted'); assert.equal(entry.stage, 'awaiting_permission');
  assert.equal(before.managed.questionOutcome, undefined); assert.equal(Object.keys(before.controls ?? {}).length, 0);
  assert.equal(f.calls.filter(call => call.wireMethod === 'SendMessage').length, 1);
  first.child.kill('SIGKILL'); const killed = await first.exit; assert.equal(killed.signal, 'SIGKILL');
  const second = questionWorker(f, 'recover', approval); t.after(() => second.child.kill('SIGKILL'));
  const recovered = await second.exit; assert.equal(recovered.code, 0, recovered.stderr);
  const result = second.messages.find(message => message.type === 'result');
  assert.equal(result.snapshot.phase, 'completed'); assert.equal(result.presentations, 0); assert.equal(result.permissions, 1);
  assert.equal(result.modelCalls, 1); assert.equal(result.snapshot.usage.toolCalls, 1);
  assert.equal(f.calls.filter(call => call.wireMethod === 'SendMessage').length, 2);
  const after = f.record(), completed = f.store.load(scope, 'run');
  const saved = Object.values(after.managed.questions.entries)[0];
  assert.equal(saved.answerDigest, entry.answerDigest); assert.equal(saved.answeredAt, entry.answeredAt);
  assert.equal(after.managed.questions.log.filter(event => event.event_type === 'item.started').length, 1);
  assert.deepEqual(completed.intents.find(intent => intent.kind === 'tool'), original.intents.find(intent => intent.kind === 'tool'));
  assert.deepEqual(completed.receipts.find(receipt => receipt.operationKey === f.snapshot.toolReconciliation.operationKey),
    original.receipts.find(receipt => receipt.operationKey === f.snapshot.toolReconciliation.operationKey));
  assert.equal(completed.events.filter(event => event.kind === 'tool.receipt_reconciled').length, 1);
  const requests = f.calls.filter(call => call.wireMethod).length;
  const third = questionWorker(f, 'recover', approval); t.after(() => third.child.kill('SIGKILL'));
  const replayed = await third.exit; assert.equal(replayed.code, 0, replayed.stderr);
  assert.equal(third.messages.find(message => message.type === 'result').modelCalls, 0);
  assert.equal(f.calls.filter(call => call.wireMethod).length, requests);
  assert.equal(new Set([killed.pid, recovered.pid, replayed.pid]).size, 3);
  t.diagnostic(JSON.stringify({ approval, killedPid: killed.pid, coldPid: recovered.pid, thirdPid: replayed.pid,
    presentationsAfterRestart: 0, freshPermission: 1, originalToolCalls: 1, supplementalSends: 1 }));
});

for (const answered of [false, true]) test(`owning Run cancellation withdraws ${answered ? 'answered' : 'unanswered'} local wait without remote cancellation`, async t => {
  const f = await setup(t); let entered, late;
  const ready = new Promise(resolve => { entered = resolve; }), controller = new AbortController();
  const pause = () => { entered(); return new Promise(resolve => { late = resolve; }); };
  const work = f.wait(host(answered ? submit : pause, answered ? pause : controlConsent), controller.signal);
  const stopped = assert.rejects(work, /withdraw/); await ready; controller.abort(Error('withdraw')); await stopped;
  const end = await f.resume({ commandId: 'cancel-original-run', kind: 'cancel', payload: {} });
  assert.equal(end.phase, 'canceled');
  const settle = createNativeA2aQuestionTerminator({ ...f.fields, store: f.store });
  assert.throws(() => settle({ ...end, revision: end.revision + 1 }), { code: 'A2A_QUESTION_TERMINAL_AUTHORITY_LOST' });
  settle(end); const entry = Object.values(f.record().managed.questions.entries)[0];
  assert.equal(entry.status, answered ? 'submitted' : 'pending'); assert.equal(entry.stage, 'withdrawn');
  assert.equal(f.record().managed.questionOutcome.errorCode, 'A2A_INPUT_WITHDRAWN');
  const events = f.record().managed.questions.log; settle(end);
  assert.deepEqual(f.record().managed.questions.log, events, 'terminal cleanup is idempotent');
  late(answered ? 'allow' : submit()); await delay(30);
  assert.deepEqual(f.record().managed.questions.log, events);
  assert.equal(f.calls.filter(call => call.wireMethod === 'SendMessage').length, 1);
  assert.equal(f.calls.filter(call => call.wireMethod === 'CancelTask').length, 0);
});

function terminalWorker(f, action, guard) {
  const child = fork(new URL('./fixtures/a2a-terminal-cleanup-worker.mjs', import.meta.url), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; const messages = [];
  child.stderr.on('data', bytes => { stderr += bytes; }); child.on('message', value => messages.push(value));
  const exit = new Promise((resolve, reject) => { child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, pid: child.pid, stderr })); });
  const boundary = new Promise(resolve => child.on('message', value => { if (value.type === 'terminal-durable') resolve(value); }));
  child.send({ root: f.root, workspaceRoot: f.workspaceRoot, env: f.env, bindings: f.bindings, scope: f.fields.scope, action, guard });
  return { child, messages, exit, boundary };
}

for (const answered of [false, true]) test(`SIGKILL after owning terminal commit: closed-turn ${answered ? 'answered' : 'pending'} question cleanup replays locally`, { timeout: 15000 }, async t => {
  const f = await setup(t, { rootRecovery: true }); let entered;
  const ready = new Promise(resolve => { entered = resolve; }), controller = new AbortController();
  const pause = () => { entered(); return new Promise(() => {}); };
  const work = f.wait(host(answered ? submit : pause, answered ? pause : controlConsent), controller.signal);
  const stopped = assert.rejects(work); await ready; controller.abort(); await stopped;
  const savedQuestion = Object.values(f.record().managed.questions.entries)[0];
  assert.equal(savedQuestion.status, answered ? 'submitted' : 'pending');
  await f.fields.a2a.close();
  const first = terminalWorker(f, 'terminal'); t.after(() => first.child.kill('SIGKILL'));
  await Promise.race([first.boundary, first.exit.then(value => assert.fail(JSON.stringify(value)))]);
  const terminal = f.store.load(f.fields.scope, 'run');
  assert.equal(terminal.snapshot.phase, 'canceled');
  assert.equal(terminal.projections['agentkit.native-a2a-question-cleanup/v1'], undefined);
  assert.notEqual(Object.values(f.record().managed.questions.entries)[0].stage, 'withdrawn');
  first.child.kill('SIGKILL'); const killed = await first.exit; assert.equal(killed.signal, 'SIGKILL');
  const before = f.record(), calls = f.calls.filter(call => call.wireMethod).length;
  for (const guard of ['archived', 'delegated', 'preset', 'lease']) {
    const rejected = terminalWorker(f, 'recover', guard), result = await rejected.exit;
    assert.equal(result.code, 0, result.stderr);
    if (['archived', 'lease'].includes(guard)) assert.equal(rejected.messages[0].outcome.status, 'deferred');
    else {
      assert.equal(rejected.messages[0].type, 'guarded');
      assert.equal(rejected.messages[0].code, guard === 'preset' ? 'studio_native_recovery_preset_changed' : 'studio_native_recovery_live_root_required');
    }
    assert.deepEqual(f.record(), before, `${guard} cannot settle the original question`);
    assert.equal(f.store.load(f.fields.scope, 'run').projections['agentkit.native-a2a-question-cleanup/v1'], undefined);
  }
  const second = terminalWorker(f, 'recover'), cold = await second.exit;
  assert.equal(cold.code, 0, cold.stderr); assert.equal(second.messages[0].outcome.status, 'cleaned');
  const cleaned = f.store.load(f.fields.scope, 'run'), question = Object.values(f.record().managed.questions.entries)[0];
  assert.equal(question.stage, 'withdrawn'); assert.equal(question.status, savedQuestion.status);
  assert.equal(cleaned.projections['agentkit.native-a2a-question-cleanup/v1'], terminal.snapshot.eventSeq);
  assert.deepEqual(cleaned.snapshot, terminal.snapshot); assert.deepEqual(cleaned.intents, terminal.intents);
  assert.deepEqual(cleaned.receipts, terminal.receipts);
  const after = f.record(), third = terminalWorker(f, 'recover'), replayed = await third.exit;
  assert.equal(replayed.code, 0, replayed.stderr); assert.equal(third.messages[0].outcome.status, 'settled');
  assert.deepEqual(f.record(), after); assert.deepEqual(f.store.load(f.fields.scope, 'run'), cleaned);
  assert.equal(f.calls.filter(call => call.wireMethod).length, calls, 'cleanup never calls Get/Send/Cancel');
  assert.equal(new Set([killed.pid, cold.pid, replayed.pid]).size, 3);
  t.diagnostic(JSON.stringify({ terminalCleanup: true, answered, killedPid: killed.pid, coldPid: cold.pid,
    thirdPid: replayed.pid, newTaskRequests: 0, originalRunId: 'run', phase: cleaned.snapshot.phase }));
});

test('an admitted unknown answer remains unresolved after the original deadline and never auto-queries or resends', { timeout: 15000 }, async t => {
  const f = await setup(t, { timeout: 5 }); let asks = 0, grants = 0;
  const initialReads = f.calls.filter(call => call.wireMethod === 'GetTask').length;
  let readsAtSend; const sent = Promise.withResolvers();
  f.setHook(call => { if (call.wireMethod === 'SendMessage') {
    readsAtSend = f.calls.filter(item => item.wireMethod === 'GetTask').length; sent.resolve();
  } });
  const controller = new AbortController();
  t.after(() => controller.abort(Error('test cleanup')));
  const work = f.wait(host(() => { asks++; return submit(); }, input => {
    grants++; f.setMode('send-lost'); return controlConsent(input);
  }), controller.signal);
  const stopped = assert.rejects(work, error => error.code === 'ABORT_ERR' && error.cause === controller.signal.reason);
  // Start measuring after the actual peer observed the admitted Send. A fixed
  // sleep from setup can expire before admission on a busy test worker.
  await sent.promise;
  const deadline = Object.values(f.record().managed.questions.entries)[0].wait.deadlineAt;
  await delay(Math.max(1, deadline - Date.now() + 100));
  assert.ok(Date.now() > deadline);
  controller.abort(Error('stop uncertain wait')); await stopped;
  assert.equal(asks, 1); assert.equal(grants, 1);
  assert.equal(f.record().managed.questionOutcome, undefined);
  assert.equal(Object.values(f.record().managed.questions.entries)[0].stage, 'operation_admitted');
  assert.equal(f.calls.filter(call => call.wireMethod === 'SendMessage').length, 2);
  assert.equal(readsAtSend, initialReads + 1, 'one fresh task check precedes admission of the approved operation');
  assert.equal(f.calls.filter(call => call.wireMethod === 'GetTask').length, readsAtSend,
    'an admitted unknown operation must add zero automatic remote reads');
  assert.equal(f.calls.filter(call => call.wireMethod === 'CancelTask').length, 0);
  assert.equal(f.store.load(scope, 'run').snapshot.phase, 'awaiting_reconciliation');
});
