import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createManagedNativeKernel, managedNativeRunId } from '../src/providers/native-managed-kernel.mjs';
import { createA2aInboundTaskStore } from '../src/providers/native-a2a-inbound-task-store.mjs';
import { permitIssuer, command, target, binding, response, tool } from './fixtures/native-managed-kernel.mjs';
import { assertManagedRuntimeFacts } from './fixtures/native-managed-runtime-schema.mjs';

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
  assert.equal((await f.receive(command({ payload: { content: 'work', execution_grant_id: 'grant' } }))).status, 'unsupported');
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
