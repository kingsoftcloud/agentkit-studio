import test from 'node:test';
import { bindNativeContext } from '../src/providers/native-context.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createManagedNativeKernel, managedNativeRunId } from '../src/providers/native-managed-kernel.mjs';
import { createA2aInboundTaskStore } from '../src/providers/native-a2a-inbound-task-store.mjs';
import { permitIssuer, command, target, scope, binding, response, tool } from './fixtures/native-managed-kernel.mjs';
import { assertManagedRuntimeFacts } from './fixtures/native-managed-runtime-schema.mjs';
import { SqliteRunStore } from '../packages/agentkit-harness/src/native/sqlite-store.mjs';

function fixture(t, options = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'managed-native-'))), issuer = permitIssuer();
  const config = { directory, target, permitVerifier: issuer.verifier, resolveBinding: ({ command }) => binding(command),
    assertCurrent: () => true, autoStart: false, ...options };
  let runtime = createManagedNativeKernel(config);
  t.after(async () => { await runtime.close(); rmSync(directory, { recursive: true, force: true }); });
  const query = (sessionId, operation) => { const value = { tenant_id: target.tenantId, agent_instance_id: target.agentInstanceId,
    session_id: sessionId, authorization_ref: randomUUID() }; return [value, issuer.issue(value, operation)]; };
  return { directory, issuer, config, get runtime() { return runtime; },
    receive: (cmd, permit = issuer.issue(cmd)) => runtime.receive(cmd, permit),
    status: id => runtime.getStatus(...query(id, 'get_status')),
    async facts(id) { const controller = new AbortController(), source = await runtime.subscribe(...query(id, 'subscribe_events'), { signal: controller.signal });
      const values = []; try { for await (const fact of source) { values.push(fact); if (fact.event_type === 'control.run_transition'
        && ['completed', 'cancelled', 'failed', 'interrupted', 'waiting'].includes(fact.payload.state)) break; } } finally { controller.abort(); }
      assertManagedRuntimeFacts(values); return values;
    },
    async reopen() { await runtime.close(); runtime = createManagedNativeKernel(config); return runtime; },
  };
}

for (const asynchronous of [false, true]) test(`trusted worker diagnostics preserve the original error and cannot turn observer failure into execution (async=${asynchronous})`, async t => {
  const failure = Object.assign(Error('private binding detail'), { code: 'session/writer-held' });
  const observed = []; let executions = 0;
  const f = fixture(t, { resolveBinding: request => {
    if (request.stage === 'execute') throw failure;
    return binding(request.command, { model: { generate: async () => { executions++; return response(); } }, tools: { execute: async () => assert.fail() } });
  }, onWorkerError: event => {
    observed.push(event);
    if (asynchronous) return Promise.reject(Error('observer failed asynchronously'));
    throw Error('observer failed synchronously');
  } });
  const cmd = command(), receipt = await f.receive(cmd);
  await assert.rejects(f.runtime.drain(cmd.session_id), error => error === failure);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(observed.length, 1); assert.equal(observed[0].sessionId, cmd.session_id); assert.equal(observed[0].error, failure);
  const view = f.runtime.inspectSession({ scope, sessionId: cmd.session_id, runId: receipt.run_id });
  assert.equal(view.workerError, 'NATIVE_KERNEL_WORKER_FAILED'); assert.equal(view.commandState, 'accepted');
  assert.equal(view.record, null); assert.equal(executions, 0);
  assert.equal((await f.status(cmd.session_id)).runs.length, 1);
});

test('trusted worker diagnostic configuration must be callable', async t => {
  const f = fixture(t);
  assert.throws(() => createManagedNativeKernel({ ...f.config, onWorkerError: {} }), { code: 'NATIVE_KERNEL_CONFIGURATION_INVALID' });
});

test('trusted managed inspection is scoped, read-only and cannot resume paused or approval work', async t => {
  let models = 0;
  const f = fixture(t, { resolveBinding: ({ command }) => binding(command, {
    model: { generate: async () => { models++; return response(); } }, tools: { execute: async () => assert.fail() },
  }) });
  const cmd = command(), receipt = await f.receive(cmd);
  const query = { scope, sessionId: cmd.session_id, runId: receipt.run_id };
  const bytes = () => ['commands.sqlite', 'commands.sqlite-wal', 'runs.sqlite', 'runs.sqlite-wal']
    .map(name => readFileSync(join(f.directory, name)));
  const before = bytes();
  assert.equal(f.runtime.inspectSession(query).record, null);
  assert.equal(f.runtime.inspectSession(query).retryable, true);
  for (const change of [{ scope: { ...scope, userId: 'other' } }, { scope: { ...scope, workspaceId: 'other' } },
    { scope: { ...scope, agentId: 'other' } }, { sessionId: 'other' }]) {
    assert.throws(() => f.runtime.inspectSession({ ...query, ...change }), { code: 'NATIVE_MANAGED_STATUS_IDENTITY_MISMATCH' });
    assert.throws(() => f.runtime.retryAcceptedRun({ ...query, ...change }), { code: 'NATIVE_MANAGED_STATUS_IDENTITY_MISMATCH' });
  }
  assert.deepEqual(bytes(), before, 'reads and rejected cross-scope controls cannot change either SQLite ledger');
  assert.equal(models, 0);
  await f.receive(command({ command_type: 'pause', payload: { run_id: receipt.run_id } }));
  await f.runtime.drain(cmd.session_id);
  assert.equal(f.runtime.inspectSession(query).record.snapshot.phase, 'paused');
  const paused = bytes();
  assert.throws(() => f.runtime.retryAcceptedRun(query), { code: 'NATIVE_MANAGED_SERVER_CONTROL_REQUIRED' });
  assert.deepEqual(bytes(), paused); assert.equal(models, 0);
  await f.receive(command({ command_type: 'resume', payload: { target: { kind: 'run', id: receipt.run_id } } }));
  await f.runtime.drain(cmd.session_id); // Only the signed Server resume authorizes continuation.
  assert.equal(models, 1); assert.equal(f.runtime.retryAcceptedRun(query).record.snapshot.phase, 'completed');
  await f.reopen();
  assert.equal(f.runtime.inspectSession(query).commandState, 'settled');
  f.runtime.retryAcceptedRun(query); assert.equal(models, 1);
});

test('trusted retry never supplies an approval or re-executes the accepted command', async t => {
  let writes = 0, models = 0;
  const f = fixture(t, { authorizeInteraction: () => true, resolveBinding: ({ command }) => binding(command, {
    model: { generate: async () => ++models === 1 ? response({ kind: 'tool_calls', text: '',
      toolCalls: [{ callId: 'write', name: 'write', arguments: {} }] }) : response() },
    tools: { execute: async request => { if (!request.interaction) return { status: 'approval_required', interactionId: 'approval', content: {} };
      writes++; return { status: 'ok', content: 'written' }; } },
  }, { tools: [tool()] }) });
  const cmd = command(), receipt = await f.receive(cmd), query = { scope, sessionId: cmd.session_id, runId: receipt.run_id };
  f.runtime.retryAcceptedRun(query); await f.runtime.drain(cmd.session_id);
  assert.equal(f.runtime.inspectSession(query).record.snapshot.phase, 'awaiting_interaction');
  assert.throws(() => f.runtime.retryAcceptedRun(query), { code: 'NATIVE_MANAGED_SERVER_CONTROL_REQUIRED' });
  assert.equal(writes, 0); assert.equal(models, 1);
  await f.reopen();
  assert.throws(() => f.runtime.retryAcceptedRun(query), { code: 'NATIVE_MANAGED_SERVER_CONTROL_REQUIRED' });
  assert.equal(writes, 0); assert.equal(models, 1);
});

test('managed status selects the oldest accepted command and a later queued Run cannot start another owner', async t => {
  let models = 0;
  const f = fixture(t, { resolveBinding: ({ command }) => binding(command, {
    model: { generate: async () => { models++; return response(); } }, tools: { execute: () => assert.fail() },
  }) });
  const first = command(), a = await f.receive(first), b = await f.receive(command());
  const query = { scope, sessionId: first.session_id };
  assert.equal(f.runtime.inspectSession(query).runId, a.run_id);
  assert.equal(f.runtime.inspectSession({ ...query, runId: b.run_id }).retryable, false);
  assert.throws(() => f.runtime.retryAcceptedRun({ ...query, runId: b.run_id }), { code: 'NATIVE_MANAGED_SERVER_CONTROL_REQUIRED' });
  assert.equal(models, 0);
  const active = f.runtime.retryAcceptedRun({ ...query, runId: a.run_id }); assert.equal(active.active, true);
  await f.runtime.drain(first.session_id); assert.equal(models, 2);
  assert.equal(f.runtime.inspectSession(query).runId, b.run_id);
});

test('frozen real context counters and class-private model state survive managed ownership wrapping', async t => {
  let models = 0;
  class Model {
    #answer = 'Frozen answer';
    async generate() { models++; return response({ text: this.#answer }); }
  }
  const model = Object.freeze(new Model());
  const context = bindNativeContext({ description: { protocol: 'openai-chat', modelName: 'test',
    contextWindow: 8000, maxOutputTokens: 512, parameters: {} } });
  const f = fixture(t, { resolveBinding: ({ command }) => binding(command,
    { model, context: Object.freeze(context.port) }, { contextPolicy: context.policy,
      profile: { profileId: 'managed', profileVersion: '1', providerFamily: 'fixture', compatibilityDigest: 'managed-profile/v1', ...context.profile } }) });
  const cmd = command(); await f.receive(cmd); await f.runtime.drain(cmd.session_id);
  assert.equal(models, 1); assert.equal((await f.status(cmd.session_id)).runs[0].phase, 'completed');
  assert.ok((await f.facts(cmd.session_id)).some(fact => fact.event_type === 'item.completed'
    && fact.payload.snapshot.parts.some(part => part.text === 'Frozen answer')));
});

test('original command Run lookup retains Python UUIDv5 ASCII encoding for supplementary Unicode', () => {
  const cmd = command({ command_id: '00000000-0000-4000-8000-000000000001', session_id: '会话😀' });
  // SHA1 UUIDv5(URL, 'ksadk:execution-grant:' + the reference's exact ASCII JSON).
  assert.equal(managedNativeRunId(cmd), 'd0eab340-91a9-5df3-8938-b39f30641c3f');
});

test('durable Server receipt drives the real Native model/tool/final loop and canonical Task, then cold retry executes nothing', async t => {
  let models = 0, writes = 0;
  const f = fixture(t, { resolveBinding: ({ command }) => binding(command, {
    model: { generate: async request => {
      if (++models === 1) return response({ kind: 'tool_calls', text: '', toolCalls: [{ callId: 'write-1', name: 'write', arguments: {} }] });
      assert.equal(request.messages.at(-1).role, 'tool'); return response();
    } }, tools: { execute: async () => { writes++; return { status: 'ok', content: 'Written' }; } },
  }, { tools: [tool()] }) });
  const cmd = command(), first = await f.receive(cmd); assert.equal(first.status, 'accepted'); assert.equal(models, 0);
  await f.runtime.drain(cmd.session_id); const facts = await f.facts(cmd.session_id);
  assert.equal(models, 2); assert.equal(writes, 1);
  assert.deepEqual(facts.map(f => f.seq), facts.map((_, index) => index + 1));
  assert.equal(facts.at(-2).event_type, 'run.completed'); assert.equal(facts.at(-1).payload.state, 'completed');
  const store = createA2aInboundTaskStore({ directory: join(f.directory, 'task'), assertCurrent: () => true });
  const identity = { accountId: 'account', tenantId: target.tenantId, callerPrincipalType: 'runtime', callerPrincipalId: 'caller', callerRuntimeId: 'caller-runtime',
    subAccountId: null, targetAgentId: target.agentInstanceId, targetRuntimeId: 'runtime', targetA2aAgentId: 'registration',
    taskBinding: { platformTaskId: 'task-platform', targetVersionId: 'version' } };
  const ids = { taskId: 'task-public', contextId: 'context-public' }, message = { messageId: 'message', parts: [{ text: 'work' }] };
  store.prepare(identity, { ...ids, message }); store.admitted(identity, { ...ids, message,
    submission: { sessionId: cmd.session_id, agentId: target.agentInstanceId, receipt: first } });
  for (const fact of facts) if (fact.run_id === first.run_id) store.apply(identity, ids, fact);
  assert.equal(store.get(identity, ids).task.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(store.get(identity, ids).task.status.message.parts[0].text, 'Managed answer');
  await f.reopen(); const retry = await f.receive({ ...cmd, authorization_ref: randomUUID(), source: { ...cmd.source, ref: 'retry-request' } });
  assert.equal(retry.status, 'duplicate'); assert.equal(retry.message_id, first.message_id); assert.equal(retry.run_id, first.run_id);
  await f.runtime.drain(cmd.session_id); assert.equal(models, 2); assert.equal(writes, 1); assert.deepEqual(await f.facts(cmd.session_id), facts);
  assert.equal((await f.receive(command({ command_type: 'interrupt', payload: { run_id: first.run_id } }))).error.code, 'native_run_terminal');
  assert.deepEqual(await f.facts(cmd.session_id), facts);
});

test('concurrent admissions and fresh permits preserve one original command; changed payload and stolen nonce reject', async t => {
  const f = fixture(t), cmd = command(), permit = f.issuer.issue(cmd);
  const receipts = await Promise.all([f.receive(cmd, permit), f.receive(cmd, permit)]);
  assert.deepEqual(receipts.map(value => value.status).sort(), ['accepted', 'duplicate']);
  assert.equal(receipts[0].run_id, receipts[1].run_id);
  const changed = { ...cmd, payload: { content: 'different' } }; assert.equal((await f.receive(changed)).error.code, 'idempotency_conflict');
  const another = command(), stolen = f.issuer.issue(another, 'enqueue', { nonce: permit.nonce });
  await assert.rejects(f.receive(another, stolen), { code: 'NATIVE_KERNEL_NONCE_REUSED' });
  await f.reopen(); await assert.rejects(f.receive(another, stolen), { code: 'NATIVE_KERNEL_NONCE_REUSED' });
});

test('queued commands execute FIFO and Native inherits prior tool history instead of starting a second loop', async t => {
  const inputs = [];
  const f = fixture(t, { resolveBinding: ({ command }) => binding(command, { model: { generate: async request => {
    inputs.push(request.messages.filter(m => m.role === 'user').map(m => m.content)); return response();
  } }, tools: { execute: async () => assert.fail('No tools expected') } }) });
  const first = command({ payload: { content: 'first' } }), second = command({ payload: { content: 'second' } });
  await f.receive(first); await f.receive(second); await f.runtime.drain(first.session_id);
  assert.deepEqual(inputs, [['first'], ['first', 'second']]); assert.deepEqual((await f.status(first.session_id)).runs.map(run => run.phase), ['completed', 'completed']);
});

test('durable cancel before Native start prevents all model/tool calls', async t => {
  let calls = 0; const f = fixture(t, { resolveBinding: ({ command }) => binding(command, {
    model: { generate: async () => { calls++; return response(); } }, tools: { execute: async () => assert.fail() },
  }) });
  const cmd = command(), accepted = await f.receive(cmd);
  const cancel = command({ command_type: 'interrupt', payload: { run_id: accepted.run_id } }); await f.receive(cancel);
  await f.reopen(); await f.runtime.drain(cmd.session_id); assert.equal(calls, 0);
  assert.equal((await f.status(cmd.session_id)).runs[0].phase, 'canceled'); assert.equal((await f.facts(cmd.session_id)).at(-1).payload.state, 'cancelled');
});

test('signed cancel interrupts an active Native model and does not depend on the HTTP observation lifetime', async t => {
  let entered; const ready = new Promise(resolve => { entered = resolve; });
  const f = fixture(t, { resolveBinding: ({ command }) => binding(command, { model: { generate: async request => {
    entered(); await new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(new Error('private secret')), { once: true }));
  } }, tools: { execute: async () => assert.fail() } }) });
  const cmd = command(), accepted = await f.receive(cmd), working = f.runtime.drain(cmd.session_id); await ready;
  await f.receive(command({ command_type: 'interrupt', payload: { run_id: accepted.run_id } })); await working;
  const facts = await f.facts(cmd.session_id); assert.equal(facts.at(-1).payload.state, 'cancelled'); assert.doesNotMatch(JSON.stringify(facts), /private secret/u);
});

test('pause/resume preserve the same Run and approval requires a trusted interaction authority', async t => {
  let models = 0, writes = 0;
  const f = fixture(t, { authorizeInteraction: ({ command }) => command.payload.token_ref === 'server-interaction-ref',
    resolveBinding: ({ command }) => binding(command, { model: { generate: async () => ++models === 1
      ? response({ kind: 'tool_calls', text: '', toolCalls: [{ callId: 'write', name: 'write', arguments: {} }] }) : response() },
    tools: { execute: async request => { if (!request.interaction) return { status: 'approval_required', interactionId: 'host-question', content: {} };
      assert.equal(request.interaction.decision, 'allow'); writes++; return { status: 'ok', content: 'written' }; } },
  }, { tools: [tool()] }) });
  const cmd = command(), accepted = await f.receive(cmd);
  await f.receive(command({ command_type: 'pause', payload: { run_id: accepted.run_id } })); await f.runtime.drain(cmd.session_id);
  assert.equal((await f.status(cmd.session_id)).runs[0].phase, 'paused'); assert.equal(models, 0);
  await f.receive(command({ command_type: 'resume', payload: { target: { kind: 'run', id: accepted.run_id } } })); await f.runtime.drain(cmd.session_id);
  const facts = await f.facts(cmd.session_id), pending = facts.find(fact => fact.event_type === 'interaction.requested');
  assert.equal(writes, 0); await f.reopen();
  const reply = command({ command_type: 'submit_interaction', payload: { run_id: accepted.run_id,
    interaction_id: pending.payload.interaction_id, expected_revision: 1, token_ref: 'wrong', response: 'approve' } });
  assert.equal((await f.receive(reply)).error.code, 'native_interaction_authority_invalid');
  reply.payload.token_ref = 'server-interaction-ref'; const confirmed = await f.receive(reply); assert.equal(confirmed.status, 'accepted');
  await f.runtime.drain(cmd.session_id); assert.equal(writes, 1); assert.equal(models, 2);
  assert.equal((await f.receive({ ...reply, authorization_ref: randomUUID(), payload: { ...reply.payload, token_ref: 'rotated-reference' } })).status, 'duplicate');
});

test('queue bound, unsupported controls and target/config changes fail explicitly', async t => {
  const f = fixture(t, { queueLimit: 1 }), cmd = command(); await f.receive(cmd);
  assert.equal((await f.receive(command())).status, 'queue_full');
  assert.equal((await f.receive(command({ command_type: 'inject', payload: { context: 'content' } }))).status, 'unsupported');
  assert.equal((await f.receive(command({ payload: { content: 'work', execution_grant_id: 'grant' } }))).error.code, 'execution_grant_not_found');
  f.config.resolveBinding = ({ command }) => binding(command, undefined, { hostBindingDigest: 'changed' });
  await f.reopen(); await assert.rejects(f.runtime.drain(cmd.session_id), { code: 'NATIVE_KERNEL_BINDING_CHANGED' });
  await f.runtime.close(); assert.throws(() => createManagedNativeKernel({ ...f.config, target: { ...target, tenantId: 'other' } }), { code: 'NATIVE_KERNEL_TARGET_CHANGED' });
});

test('two actual SQLite owners cannot drive the same admitted model concurrently', async t => {
  let entered, finish, calls = 0;
  const ready = new Promise(resolve => { entered = resolve; }), waiting = new Promise(resolve => { finish = resolve; });
  const f = fixture(t, { resolveBinding: ({ command }) => binding(command, { model: { generate: async () => {
    calls++; entered(); await waiting; return response();
  } }, tools: { execute: async () => assert.fail() } }) });
  const cmd = command(), accepted = await f.receive(cmd), active = f.runtime.drain(cmd.session_id); await ready;
  const peer = createManagedNativeKernel(f.config); t.after(() => peer.close());
  const duplicate = await peer.receive(cmd, f.issuer.issue(cmd)); assert.equal(duplicate.run_id, accepted.run_id);
  await assert.rejects(peer.drain(cmd.session_id), { code: 'lease_busy' }); assert.equal(calls, 1);
  finish(); await active; await peer.drain(cmd.session_id); assert.equal(calls, 1); await peer.close();
});

test('admission rollback does not leave a consumed nonce or an executable command', async t => {
  let commits = 0, fail = true;
  const f = fixture(t, { beforeCommit: () => { if (++commits === 2 && fail) throw new Error('injected before admission commit'); } });
  const cmd = command(), permit = f.issuer.issue(cmd);
  await assert.rejects(f.receive(cmd, permit), /injected before admission commit/u);
  fail = false; assert.deepEqual((await f.status(cmd.session_id)).runs, []);
  const replacement = command(), fresh = f.issuer.issue(replacement, 'enqueue', { nonce: permit.nonce });
  assert.equal((await f.receive(replacement, fresh)).status, 'accepted');
});

test('resource binding lifetime is released after admission/execution/rejection and a Session cannot change scope', async t => {
  let released = 0;
  const f = fixture(t, { resolveBinding: ({ command }) => ({ ...binding(command),
    ...(command.payload.content === 'other-workspace' ? { scope: { ...binding(command).scope, workspaceId: 'other' } } : {}),
    release: async () => { released++; },
  }) });
  const cmd = command(); await f.receive(cmd); assert.equal(released, 1);
  await f.runtime.drain(cmd.session_id); assert.equal(released, 2);
  const other = command({ payload: { content: 'other-workspace' } });
  assert.equal((await f.receive(other)).error.code, 'native_session_binding_changed'); assert.equal(released, 3);
  assert.equal((await f.status(cmd.session_id)).runs.length, 1);
});

test('class-based Host ports retain their receiver and shutdown bounds a noncooperative effect without cancelling its durable Run', async t => {
  let entered; const ready = new Promise(resolve => { entered = resolve; });
  class Model {
    #calls = 0;
    async generate() { this.#calls++; entered(); return new Promise(() => {}); }
    get calls() { return this.#calls; }
  }
  const model = new Model(), f = fixture(t, { resolveBinding: ({ command }) => binding(command, { model, tools: { execute: async () => assert.fail() } }) });
  const cmd = command(); await f.receive(cmd); const driving = f.runtime.drain(cmd.session_id); await ready;
  await f.runtime.close(); await assert.rejects(driving); assert.equal(model.calls, 1);
  // Close aborts the owner effect; it does not issue Native's user-cancel command.
  f.config.resolveBinding = ({ command }) => binding(command);
  await f.reopen(); const status = await f.status(cmd.session_id); assert.notEqual(status.runs[0].phase, 'canceled');
});

test('a permit expiring during an asynchronous binding lookup cannot admit work', async t => {
  let now = Date.now(), releases = 0;
  const issuer = permitIssuer({ clock: () => now });
  const f = fixture(t, { permitVerifier: issuer.verifier, resolveBinding: ({ command }) => {
    now += 61000; return { ...binding(command), release: async () => { releases++; } };
  } });
  const cmd = command(); await assert.rejects(f.runtime.receive(cmd, issuer.issue(cmd)), { code: 'NATIVE_KERNEL_PERMIT_INVALID' });
  assert.equal(releases, 1); await f.runtime.drain(cmd.session_id);
});

test('cold binding reconstructs admitted input bytes and receives the actual Native ledger and release identity', async t => {
  const requests = [], released = [], modelInputs = [];
  let resourcePath;
  const f = fixture(t, { resolveBinding: request => {
    requests.push(request);
    const resolved = binding(request.command, { model: { generate: async input => {
      modelInputs.push(input.messages.filter(message => message.role === 'user').map(message => message.content)); return response();
    } }, tools: { execute: async () => assert.fail('No tool expected') } });
    if (request.admission) resolved.configuration = request.admission.configuration;
    else resolved.configuration = { ...resolved.configuration, inputMessages: [{ role: 'user', content: readFileSync(resourcePath, 'utf8') }] };
    return { ...resolved, release: async identity => { released.push(identity); } };
  } });
  resourcePath = join(f.directory, 'mutable-resource.txt'); writeFileSync(resourcePath, 'original admitted resource');
  const cmd = command(), receipt = await f.receive(cmd);
  assert.equal(requests[0].stage, 'admit'); assert.equal(requests[0].admission, null);
  assert.equal(requests[0].runId, receipt.run_id); assert.equal(requests[0].recovery, false);
  writeFileSync(resourcePath, 'changed after admission');
  await f.reopen(); await f.runtime.drain(cmd.session_id);
  assert.equal(requests.length, 2); assert.equal(requests[1].stage, 'execute'); assert.equal(requests[1].recovery, true);
  assert.equal(requests[1].runId, receipt.run_id);
  assert.equal(requests[1].store.load(requests[1].admission.scope, receipt.run_id).snapshot.phase, 'completed');
  assert.deepEqual(modelInputs, [['original admitted resource']]);
  assert.deepEqual(released.map(({ stage, runId, sessionId }) => ({ stage, runId, sessionId })),
    ['admit', 'execute'].map(stage => ({ stage, runId: receipt.run_id, sessionId: cmd.session_id })));
  assert.notEqual(requests[0].store, requests[1].store); // The cold owner actually reopened SQLite.
});

test('binding admission retirement rejects promptly and releases a late provider without admitting a command', { timeout: 3000 }, async t => {
  const entered = Promise.withResolvers(), provider = Promise.withResolvers(), released = Promise.withResolvers();
  const f = fixture(t, { resolveBinding: request => { entered.resolve(request); return provider.promise; } });
  const cmd = command(), receiving = f.receive(cmd); const stopped = assert.rejects(receiving, /Native owner closed/);
  const request = await entered.promise; await f.runtime.close(); await stopped; assert.equal(request.signal.aborted, true);
  provider.resolve({ ...binding(cmd), release: async identity => { released.resolve(identity); } });
  const identity = await released.promise; assert.equal(identity.runId, request.runId); assert.equal(identity.reason, 'owner_retired');
  f.config.resolveBinding = ({ command }) => binding(command);
  await f.reopen(); assert.deepEqual((await f.status(cmd.session_id)).runs, []);
});

test('binding execution retirement releases late resources and leaves the original admitted Run pending', { timeout: 3000 }, async t => {
  const entered = Promise.withResolvers(), provider = Promise.withResolvers(), released = Promise.withResolvers();
  let modelCalls = 0;
  const f = fixture(t, { resolveBinding: request => {
    if (request.stage === 'admit') return binding(request.command);
    entered.resolve(request); return provider.promise;
  } });
  const cmd = command(), receipt = await f.receive(cmd), driving = f.runtime.drain(cmd.session_id);
  const stopped = assert.rejects(driving, /Native owner closed/); const request = await entered.promise;
  await f.runtime.close(); await stopped; assert.equal(request.signal.aborted, true);
  provider.resolve({ ...binding(cmd, { model: { generate: async () => { modelCalls++; return response(); } } }),
    release: async identity => { released.resolve(identity); } });
  assert.equal((await released.promise).runId, receipt.run_id); assert.equal(modelCalls, 0);
  f.config.resolveBinding = ({ command }) => binding(command);
  await f.reopen(); assert.equal((await f.status(cmd.session_id)).runs[0].phase, 'pending');
  const duplicate = await f.receive(cmd); assert.equal(duplicate.run_id, receipt.run_id);
  await f.runtime.drain(cmd.session_id); assert.equal((await f.status(cmd.session_id)).runs[0].phase, 'completed');
});

test('mutating a recovered binding snapshot cannot rewrite the admitted configuration or execute changed input', async t => {
  let calls = 0;
  const f = fixture(t, { resolveBinding: request => {
    const resolved = binding(request.command, { model: { generate: async () => { calls++; return response(); } } });
    if (request.admission) {
      request.admission.configuration.inputMessages[0].content = 'unadmitted replacement';
      resolved.configuration = request.admission.configuration;
    }
    return resolved;
  } });
  const cmd = command(), receipt = await f.receive(cmd);
  await assert.rejects(f.runtime.drain(cmd.session_id), { code: 'NATIVE_KERNEL_BINDING_CHANGED' }); assert.equal(calls, 0);
  f.config.resolveBinding = request => {
    assert.equal(request.admission.configuration.inputMessages[0].content, cmd.payload.content);
    return binding(request.command);
  };
  await f.reopen(); await f.runtime.drain(cmd.session_id);
  assert.equal((await f.status(cmd.session_id)).runs[0].runId, receipt.run_id);
  assert.equal((await f.status(cmd.session_id)).runs[0].phase, 'completed');
});

test('an invalid resource binding still releases its owner without masking the admission error', async t => {
  let released;
  const f = fixture(t, { resolveBinding: ({ command }) => {
    const value = binding(command); delete value.scope;
    return { ...value, release: async identity => { released = identity; } };
  } });
  const cmd = command(); await assert.rejects(f.receive(cmd), { code: 'NATIVE_KERNEL_COMMAND_INVALID' });
  assert.equal(released.runId, managedNativeRunId(cmd)); assert.equal(released.stage, 'admit');
  assert.equal(released.scope, undefined); assert.deepEqual((await f.status(cmd.session_id)).runs, []);
});

test('a whole-Session execution boundary starts no effects before its owner permits entry', async t => {
  const entered = Promise.withResolvers(), allowed = Promise.withResolvers(); let calls = 0;
  const f = fixture(t, { resolveBinding: ({ command }) => ({ ...binding(command, {
    model: { generate: async () => { calls++; return response(); } } }),
    withExecution: async ({ execute }) => { entered.resolve(); await allowed.promise; return execute(); },
  }) });
  const cmd = command(); await f.receive(cmd); const driving = f.runtime.drain(cmd.session_id);
  await entered.promise; assert.equal(calls, 0); assert.equal((await f.status(cmd.session_id)).runs[0].phase, 'pending');
  allowed.resolve(); await driving; assert.equal(calls, 1); assert.equal((await f.status(cmd.session_id)).runs[0].phase, 'completed');
});

test('Host readiness explicitly starts the original persisted command without another input or drain', async t => {
  let models = 0;
  const f = fixture(t, { resolveBinding: ({ command }) => binding(command, { model: {
    generate: async () => { models++; return response(); },
  } }) });
  const cmd = command(), receipt = await f.receive(cmd); await f.reopen();
  await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(models, 0);
  f.runtime.startRecovery(); f.runtime.startRecovery();
  const deadline = Date.now() + 2000;
  while ((await f.status(cmd.session_id)).runs[0].phase !== 'completed') {
    assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(models, 1); assert.equal((await f.status(cmd.session_id)).runs[0].runId, receipt.run_id);
});

test('binding cleanup distinguishes durable acceptance from a full queue without executing either input', async t => {
  const released = [];
  const f = fixture(t, { queueLimit: 1, resolveBinding: ({ command }) => ({ ...binding(command),
    release: request => released.push({ command: command.command_id, stage: request.stage, admitted: request.admitted }),
  }) });
  const first = command(), second = command({ session_id: first.session_id });
  assert.equal((await f.receive(first)).status, 'accepted');
  assert.equal((await f.receive(second)).status, 'queue_full');
  assert.deepEqual(released, [{ command: first.command_id, stage: 'admit', admitted: true },
    { command: second.command_id, stage: 'admit', admitted: false }]);
});

test('managed delivery checkpoints precede model dispatch and the second owner pins its actual Native parent', async t => {
  const identities = [], delivered = new Set();
  let models = 0;
  const f = fixture(t, { resolveBinding: ({ command }) => ({ ...binding(command, {
    model: { generate: async () => { assert.ok(delivered.has(managedNativeRunId(command))); models++; return response(); } } }),
    withExecution: async ({ identity, execute }) => {
      identities.push(identity);
      return execute({ onCheckpoint: async snapshot => {
        assert.equal(snapshot.runId, identity.runId); assert.equal(snapshot.parentRunId, identity.parentRunId);
        delivered.add(snapshot.runId);
      } });
    },
  }) });
  const first = command(); await f.receive(first); await f.runtime.drain(first.session_id);
  await f.reopen();
  const second = command({ session_id: first.session_id }); await f.receive(second); await f.runtime.drain(second.session_id);
  assert.equal(models, 2); assert.equal(identities.length, 2);
  assert.equal(identities[0].parentRunId, null); assert.equal(identities[1].parentRunId, managedNativeRunId(first));
});

for (const failCheckpoint of [false, true]) test(`managed live controls release before binding ports, including checkpoint failure=${failCheckpoint}`, async t => {
  let current = null, models = 0;
  const order = [];
  const f = fixture(t, { resolveBinding: ({ command }) => ({ ...binding(command, {
    model: { generate: async () => { assert.equal(current.runId, managedNativeRunId(command)); models++; return response(); } },
  }), release: ({ stage }) => { if (stage === 'execute') { assert.equal(current, null); order.push(`ports:${command.command_id}`); } },
  withExecution: ({ identity, execute }) => execute({
    onActive(control) {
      assert.equal(current, null, 'the previous exclusive Run must release before another one installs');
      assert.deepEqual(control.scope, scope); assert.equal(control.runId, identity.runId); assert.equal(control.sessionId, identity.sessionId);
      assert.equal(typeof control.wake, 'function'); assert.equal(typeof control.kernel.cancelChild, 'function');
      assert.equal(f.runtime.inspectSession({ scope, sessionId: identity.sessionId, runId: identity.runId }).record.snapshot.runId, identity.runId);
      current = control; order.push(`active:${command.command_id}`);
      return () => { assert.equal(current, control); current = null; order.push(`release:${command.command_id}`); };
    }, onCheckpoint() { if (failCheckpoint) throw Error('delivery checkpoint failed'); },
  }),
  }) });
  const commands = [command(), command(), command()];
  for (const cmd of commands) cmd.session_id = commands[0].session_id;
  for (const cmd of commands) await f.receive(cmd);
  if (failCheckpoint) {
    await assert.rejects(f.runtime.drain(commands[0].session_id), /delivery checkpoint failed/);
    assert.equal(models, 0); assert.deepEqual(order, [`active:${commands[0].command_id}`, `release:${commands[0].command_id}`, `ports:${commands[0].command_id}`]);
  } else {
    await f.runtime.drain(commands[0].session_id); assert.equal(models, 3);
    assert.deepEqual(order, commands.flatMap(cmd => [`active:${cmd.command_id}`, `release:${cmd.command_id}`, `ports:${cmd.command_id}`]));
  }
  assert.equal(current, null);
});

test('managed live model observers receive the original identity before completion without controlling effects', async t => {
  const streamed = [];
  const f = fixture(t, { resolveBinding: ({ command }) => ({ ...binding(command, {
    model: { generate: async (_request, emit) => {
      emit({ kind: 'text', text: 'Live answer' });
      assert.equal(streamed.length, 1, 'callback must run before the model result settles');
      return response({ text: 'Live answer' });
    } }, tools: { execute: async () => assert.fail('No tool requested') } }),
    withExecution: ({ identity, execute }) => execute({ onStream: (actual, event, record) => {
      assert.equal(actual.runId, identity.runId); assert.deepEqual(actual.scope, identity.scope);
      streamed.push({ event, record }); throw Error('display unavailable');
    } }),
  }) });
  const cmd = command(); await f.receive(cmd); await f.runtime.drain(cmd.session_id);
  assert.equal(streamed.length, 1); assert.equal(streamed[0].event.text, 'Live answer');
  assert.equal((await f.status(cmd.session_id)).runs[0].phase, 'completed');
});

function receiptWaitFixture(t, onIdle) {
  let models = 0, writes = 0, reads = 0;
  const f = fixture(t, { resolveBinding: request => ({ ...binding(request.command, {
    model: { generate: async () => ++models === 1 ? response({ kind: 'tool_calls', text: '',
      toolCalls: [{ callId: 'original-write', name: 'write', arguments: {} }] }) : response() },
    tools: {
      execute: async () => { writes++; return { status: 'uncertain', content: 'Original result unknown' }; },
      observeReceipt: async request => { reads++; return { contract: request.contract,
        originalOperationKey: request.originalOperationKey, callId: request.call.callId,
        result: { status: 'ok', content: 'Original write confirmed' } }; },
    },
  }, { tools: [tool({ recoveryPolicy: 'receipt-observation/v1' })] }),
  withExecution: ({ execute }) => execute({ onIdle: (snapshot, context) => onIdle(snapshot, context) }),
  }) });
  return Object.assign(f, { counts: () => ({ models, writes, reads }) });
}
const receiptCommand = (snapshot, commandId = 'original-receipt-read') => ({ commandId, kind: 'reconcile_tool',
  payload: { originalOperationKey: snapshot.toolReconciliation.operationKey } });
async function until(check) {
  const deadline = Date.now() + 2000;
  while (!await check()) { assert.ok(Date.now() < deadline, 'expected durable transition'); await new Promise(resolve => setTimeout(resolve, 10)); }
}

test('managed idle receipt callback cannot answer an original Server Native tool approval', { timeout: 5000 }, async t => {
  let models = 0, writes = 0;
  const f = fixture(t, { authorizeInteraction: ({ command }) => command.payload.token_ref === 'server-interaction-ref', resolveBinding: ({ command }) => ({ ...binding(command, {
    model: { generate: async () => ++models === 1 ? response({ kind: 'tool_calls', text: '',
      toolCalls: [{ callId: 'write', name: 'write', arguments: {} }] }) : response() },
    tools: { execute: async request => { if (!request.interaction) return { status: 'approval_required', interactionId: 'approval', content: {} };
      writes++; return { status: 'ok', content: 'written' }; } },
  }, { tools: [tool()] }), withExecution: ({ execute }) => execute({ onIdle: () => assert.fail('receipt callback cannot approve a Server interaction') }),
  }) });
  const cmd = command(), receipt = await f.receive(cmd), driving = f.runtime.drain(cmd.session_id);
  await until(async () => (await f.status(cmd.session_id)).runs[0].phase === 'awaiting_interaction');
  assert.equal(writes, 0); assert.equal(models, 1);
  const pending = f.runtime.inspectSession({ scope, sessionId: cmd.session_id, runId: receipt.run_id }).record.snapshot.pendingInteraction;
  const decision = command({ command_type: 'submit_interaction', payload: { run_id: receipt.run_id, interaction_id: pending.interactionId,
    token_ref: 'server-interaction-ref', response: 'approve' } });
  assert.equal((await f.receive(decision)).status, 'accepted'); await driving;
  assert.equal(writes, 1); assert.equal(models, 2); assert.equal((await f.status(cmd.session_id)).runs[0].phase, 'completed');
});

test('managed idle receipt observation keeps one owner and never replays the original uncertain write', async t => {
  let attempts = 0;
  const f = receiptWaitFixture(t, (snapshot, context) => {
    attempts++; assert.equal(snapshot.phase, 'awaiting_reconciliation');
    assert.equal(context.assertCurrent(), true); assert.equal(context.signal.aborted, false);
    assert.deepEqual(f.counts(), { models: 1, writes: 1, reads: 0 });
    return receiptCommand(snapshot);
  });
  const cmd = command(), receipt = await f.receive(cmd); await f.runtime.drain(cmd.session_id);
  const query = { scope, sessionId: cmd.session_id, runId: receipt.run_id }, original = f.runtime.inspectSession(query).record;
  assert.equal(original.snapshot.phase, 'completed'); assert.equal(attempts, 1);
  assert.deepEqual(f.counts(), { models: 2, writes: 1, reads: 1 });
  assert.equal(original.intents.filter(row => row.kind === 'tool').length, 1);
  assert.equal(original.intents.filter(row => row.kind === 'tool_receipt').length, 1);
  assert.equal(original.commands.filter(row => row.command.kind === 'reconcile_tool').length, 1);
  await f.reopen(); await f.runtime.drain(cmd.session_id);
  assert.deepEqual(f.runtime.inspectSession(query).record, original);
  assert.deepEqual(f.counts(), { models: 2, writes: 1, reads: 1 });
});

for (const invalid of ['submit_interaction', 'resume', 'foreign-receipt']) test(`managed idle Host cannot submit ${invalid}`, async t => {
  const f = receiptWaitFixture(t, snapshot => invalid === 'foreign-receipt'
    ? { ...receiptCommand(snapshot), payload: { originalOperationKey: 'foreign' } }
    : { commandId: 'invalid-host-command', kind: invalid, payload: {} });
  const cmd = command(), receipt = await f.receive(cmd);
  await assert.rejects(f.runtime.drain(cmd.session_id), { code: 'NATIVE_KERNEL_IDLE_COMMAND_INVALID' });
  const record = f.runtime.inspectSession({ scope, sessionId: cmd.session_id, runId: receipt.run_id }).record;
  assert.equal(record.snapshot.phase, 'awaiting_reconciliation'); assert.deepEqual(record.commands, []);
  assert.deepEqual(f.counts(), { models: 1, writes: 1, reads: 0 });
});

for (const control of ['pause', 'interrupt']) test(`another SQLite receiver's ${control} retires a managed idle answer before receipt submission`, { timeout: 5000 }, async t => {
  const entered = Promise.withResolvers(), delayed = Promise.withResolvers(); let attempt = 0, held;
  const f = receiptWaitFixture(t, (snapshot, context) => {
    if (++attempt > 1) return receiptCommand(snapshot);
    held = { snapshot, ...context }; entered.resolve(); return delayed.promise;
  });
  const cmd = command(), receipt = await f.receive(cmd), driving = f.runtime.drain(cmd.session_id); await entered.promise;
  const other = createManagedNativeKernel(f.config); t.after(() => other.close());
  const stop = command({ command_type: control, payload: { run_id: receipt.run_id } });
  assert.equal((await other.receive(stop, f.issuer.issue(stop))).status, 'accepted');
  // This runs before the original receiver's 100ms poll. The durable queue,
  // rather than its process-local wake counter, withdraws effect authority.
  assert.throws(held.assertCurrent, { code: 'NATIVE_KERNEL_IDLE_AUTHORITY_LOST' });
  delayed.resolve(receiptCommand(held.snapshot, 'late-answer'));
  if (control === 'pause') {
    await until(async () => (await f.status(cmd.session_id)).runs[0].phase === 'paused');
    assert.equal(held.signal.aborted, true); assert.deepEqual(f.counts(), { models: 1, writes: 1, reads: 0 });
    const resume = command({ command_type: 'resume', payload: { target: { kind: 'run', id: receipt.run_id } } });
    assert.equal((await other.receive(resume, f.issuer.issue(resume))).status, 'accepted');
  }
  await driving;
  const record = f.runtime.inspectSession({ scope, sessionId: cmd.session_id, runId: receipt.run_id }).record;
  assert.equal(record.snapshot.phase, control === 'pause' ? 'completed' : 'canceled');
  assert.equal(held.signal.aborted, true); assert.equal(record.commands.some(row => row.command.commandId === 'late-answer'), false);
  assert.deepEqual(f.counts(), control === 'pause' ? { models: 2, writes: 1, reads: 1 } : { models: 1, writes: 1, reads: 0 });
});

test('a new execution fence retires a managed idle answer even without a checkpoint revision change', { timeout: 5000 }, async t => {
  const entered = Promise.withResolvers(), delayed = Promise.withResolvers(); let attempts = 0, held;
  const f = receiptWaitFixture(t, (snapshot, context) => {
    if (++attempts > 1) return receiptCommand(snapshot);
    held = { snapshot, ...context }; entered.resolve(); return delayed.promise;
  });
  const cmd = command(), receipt = await f.receive(cmd), driving = f.runtime.drain(cmd.session_id); await entered.promise;
  const other = new SqliteRunStore(join(f.directory, 'runs.sqlite')); t.after(() => other.close());
  const before = other.load(scope, receipt.run_id); assert.equal(before.lease, null, 'idle wait owns no execution lease');
  const lease = other.acquire(scope, receipt.run_id, 'new-observer', Date.now(), 1000);
  other.release(scope, receipt.run_id, lease);
  assert.deepEqual(other.load(scope, receipt.run_id).snapshot, before.snapshot);
  assert.throws(held.assertCurrent, { code: 'NATIVE_KERNEL_IDLE_AUTHORITY_LOST' });
  delayed.resolve(receiptCommand(held.snapshot, 'stale-fence-answer')); await driving;
  const record = other.load(scope, receipt.run_id);
  assert.equal(record.snapshot.phase, 'completed'); assert.equal(attempts, 2);
  assert.equal(record.commands.some(row => row.command.commandId === 'stale-fence-answer'), false);
  assert.deepEqual(f.counts(), { models: 2, writes: 1, reads: 1 });
});

test('Host retirement withdraws a managed receipt wait without manufacturing cancellation or accepting late answers', async t => {
  const entered = Promise.withResolvers(), delayed = Promise.withResolvers(); let held;
  const f = receiptWaitFixture(t, (snapshot, context) => { held = { snapshot, ...context }; entered.resolve(); return delayed.promise; });
  const cmd = command(), receipt = await f.receive(cmd), driving = f.runtime.drain(cmd.session_id);
  const stopped = assert.rejects(driving, { code: 'NATIVE_KERNEL_AUTHORITY_LOST' }); await entered.promise;
  await f.runtime.close(); await stopped; assert.equal(held.signal.aborted, true);
  delayed.resolve(receiptCommand(held.snapshot, 'retired-answer')); await f.reopen();
  const record = f.runtime.inspectSession({ scope, sessionId: cmd.session_id, runId: receipt.run_id }).record;
  assert.equal(record.snapshot.phase, 'awaiting_reconciliation'); assert.deepEqual(record.commands, []);
  assert.deepEqual(f.counts(), { models: 1, writes: 1, reads: 0 });
});

test('a whole-Session owner stays open while Native is paused and resumes the same Run', { timeout: 5000 }, async t => {
  let owners = 0, closed = 0, calls = 0;
  const f = fixture(t, { resolveBinding: ({ command }) => ({ ...binding(command, {
    model: { generate: async () => { calls++; return response(); } } }),
    withExecution: async ({ execute }) => { owners++; const snapshot = await execute(); closed++; return snapshot; },
  }) });
  const cmd = command(), receipt = await f.receive(cmd);
  await f.receive(command({ command_type: 'pause', payload: { run_id: receipt.run_id } }));
  const driving = f.runtime.drain(cmd.session_id), deadline = Date.now() + 2000;
  while ((await f.status(cmd.session_id)).runs[0].phase !== 'paused') {
    assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(owners, 1); assert.equal(closed, 0); assert.equal(calls, 0);
  await f.receive(command({ command_type: 'resume', payload: { target: { kind: 'run', id: receipt.run_id } } }));
  await driving; assert.equal(owners, 1); assert.equal(closed, 1); assert.equal(calls, 1);
  assert.equal((await f.status(cmd.session_id)).runs[0].runId, receipt.run_id);
});

test('the Session cancel signal durably cancels the active Native Run', async t => {
  const entered = Promise.withResolvers(), controller = new AbortController();
  const f = fixture(t, { resolveBinding: ({ command }) => ({ ...binding(command, {
    model: { generate: async () => { entered.resolve(); return new Promise(() => {}); } } }),
    withExecution: ({ execute }) => execute({ signal: controller.signal }),
  }) });
  const cmd = command(); await f.receive(cmd); const driving = f.runtime.drain(cmd.session_id); await entered.promise;
  controller.abort({ kind: 'user' }); await driving;
  assert.equal((await f.status(cmd.session_id)).runs[0].phase, 'canceled');
  await f.reopen(); assert.equal((await f.status(cmd.session_id)).runs[0].phase, 'canceled');
});

test('an owner cannot invent a terminal result or invoke its execution capability after returning', async t => {
  let lateExecute, calls = 0;
  const f = fixture(t, { resolveBinding: ({ command }) => ({ ...binding(command, {
    model: { generate: async () => { calls++; return response(); } } }),
    withExecution: ({ execute }) => { lateExecute = execute; return { phase: 'completed' }; },
  }) });
  const cmd = command(); await f.receive(cmd);
  await assert.rejects(f.runtime.drain(cmd.session_id), { code: 'NATIVE_KERNEL_EXECUTION_RESULT_INVALID' });
  await assert.rejects(lateExecute(), { code: 'NATIVE_KERNEL_EXECUTION_REENTERED' });
  assert.equal(calls, 0); assert.equal((await f.status(cmd.session_id)).runs[0].phase, 'pending');
});

test('a committed Session terminal with a lost receiver ACK replays the original terminal without effects', async t => {
  let calls = 0;
  const f = fixture(t, { resolveBinding: ({ command }) => ({ ...binding(command, {
    model: { generate: async () => { calls++; return response(); } } }),
    withExecution: async ({ execute }) => { await execute(); throw Error('Receiver ACK lost after Session close'); },
  }) });
  const cmd = command(), receipt = await f.receive(cmd);
  await assert.rejects(f.runtime.drain(cmd.session_id), /Receiver ACK lost/); const original = await f.facts(cmd.session_id);
  assert.equal(calls, 1);
  f.config.resolveBinding = ({ command }) => ({ ...binding(command, {
    model: { generate: async () => assert.fail('A closed Session must not call the model') } }),
    withExecution: ({ execute }) => execute({ replayOnly: true, onActive: () => assert.fail('terminal replay cannot install live controls') }),
  });
  await f.reopen(); await f.runtime.drain(cmd.session_id); assert.equal(calls, 1);
  assert.deepEqual(await f.facts(cmd.session_id), original);
  assert.equal((await f.receive(cmd)).run_id, receipt.run_id);
});

test('Host retirement releases a whole-Session wait without converting pause to user cancellation', { timeout: 5000 }, async t => {
  const f = fixture(t, { resolveBinding: ({ command }) => ({ ...binding(command), withExecution: ({ execute }) => execute() }) });
  const cmd = command(), receipt = await f.receive(cmd);
  await f.receive(command({ command_type: 'pause', payload: { run_id: receipt.run_id } }));
  const driving = f.runtime.drain(cmd.session_id), stopped = assert.rejects(driving, /Native owner closed/), deadline = Date.now() + 2000;
  while ((await f.status(cmd.session_id)).runs[0].phase !== 'paused') {
    assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10));
  }
  await f.runtime.close(); await stopped; await f.reopen();
  assert.equal((await f.status(cmd.session_id)).runs[0].phase, 'paused');
});

test('an owner terminal replay cannot execute a pending Run', async t => {
  let calls = 0;
  const f = fixture(t, { resolveBinding: ({ command }) => ({ ...binding(command, {
    model: { generate: async () => { calls++; return response(); } } }), withExecution: ({ execute }) => execute({ replayOnly: true }),
  }) });
  const cmd = command(); await f.receive(cmd); await assert.rejects(f.runtime.drain(cmd.session_id), { code: 'run_not_found' });
  assert.equal(calls, 0); assert.equal((await f.status(cmd.session_id)).runs[0].phase, 'pending');
});

test('cancellation-only ownership refuses an active signal before creating any Native effects', async t => {
  const f = fixture(t, { resolveBinding: ({ command }) => ({ ...binding(command),
    withExecution: ({ execute }) => execute({ cancelOnly: true, signal: new AbortController().signal }),
  }) });
  const cmd = command(); await f.receive(cmd);
  await assert.rejects(f.runtime.drain(cmd.session_id), { code: 'NATIVE_KERNEL_CANCEL_SIGNAL_REQUIRED' });
  assert.equal((await f.status(cmd.session_id)).runs[0].phase, 'pending');
});

test('a paused whole-Session owner observes a resume delivered by another SQLite receiver', { timeout: 5000 }, async t => {
  let owners = 0, calls = 0;
  const f = fixture(t, { resolveBinding: ({ command }) => ({ ...binding(command, {
    model: { generate: async () => { calls++; return response(); } } }),
    withExecution: ({ execute }) => { owners++; return execute(); },
  }) });
  const cmd = command(), receipt = await f.receive(cmd);
  await f.receive(command({ command_type: 'pause', payload: { run_id: receipt.run_id } }));
  const driving = f.runtime.drain(cmd.session_id), deadline = Date.now() + 2000;
  while ((await f.status(cmd.session_id)).runs[0].phase !== 'paused') {
    assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10));
  }
  const other = createManagedNativeKernel(f.config); t.after(() => other.close());
  const resume = command({ command_type: 'resume', payload: { target: { kind: 'run', id: receipt.run_id } } });
  assert.equal((await other.receive(resume, f.issuer.issue(resume))).status, 'accepted');
  await driving; assert.equal(owners, 1); assert.equal(calls, 1);
  assert.equal((await f.status(cmd.session_id)).runs[0].runId, receipt.run_id);
  assert.equal((await f.status(cmd.session_id)).runs[0].phase, 'completed');
});
