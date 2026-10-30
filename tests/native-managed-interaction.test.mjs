import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { canonical, copy } from '@kingsoftcloud/agentkit-harness-core';
import { createManagedNativeKernel } from '../src/providers/native-managed-kernel.mjs';
import { permitIssuer, command, target, scope, binding, response, tool } from './fixtures/native-managed-kernel.mjs';
import Ajv2020 from 'ajv/dist/2020.js';
import { streamA2aInboundKernelFacts } from '../src/providers/native-a2a-inbound-kernel.mjs';

// Exact interaction/v1 schema from readonly KsADK355059d; raw response, kind,
// revision, original scoped identities and resolved actor are wire requirements.
const validateInteraction = new Ajv2020({ strict: false, validateFormats: false }).compile(JSON.parse(readFileSync(
  new URL('./fixtures/native-managed-interaction-v1.schema.json', import.meta.url), 'utf8')));

const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
async function until(check) {
  const deadline = Date.now() + 5000;
  for (;;) { const value = await check(); if (value) return value;
    assert.ok(Date.now() < deadline, 'expected original interaction transition'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
function fixture(t, { kind = 'structured_input', schema = { type: 'object', required: ['answer'], properties: { answer: { type: 'integer' } } },
  local, stopAfterAnswer = false } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'managed-native-input-'))), issuer = permitIssuer();
  let runtime, models = 0, writes = 0, reads = 0, presentations = 0, answers = [], entered, stopped = false, failAfter = 0;
  const config = { directory, target, permitVerifier: issuer.verifier, assertCurrent: () => true, autoStart: false,
    beforeCommit() { if (failAfter > 0 && --failAfter === 0) throw Error('interaction commit failed'); },
    authorizeInteraction: ({ command }) => command.payload.token_ref === 'original-token',
    resolveBinding: ({ command: cmd }) => ({ ...binding(cmd, {
      model: { generate: async () => ++models === 1 ? response({ kind: 'tool_calls', text: '',
        toolCalls: [{ callId: 'original-remote', name: 'call_a2a_agent', arguments: {} }] }) : response() },
      tools: { execute: async () => { writes++; return { status: 'uncertain', content: 'Remote asks original question' }; },
        observeReceipt: async request => { reads++; assert.equal(answers.length, 1);
          return { contract: request.contract, originalOperationKey: request.originalOperationKey,
            callId: request.call.callId, result: { status: 'ok', content: copy(answers[0]) } }; } },
    }, { tools: [tool({ name: 'call_a2a_agent', recoveryPolicy: 'receipt-observation/v1' })] }),
    withExecution: ({ identity, execute }) => execute({ onIdle: async (snapshot, context) => {
      const question = { contract: 'agentkit.a2a-question-wait/v1', interactionId: 'original-remote-question', continuationId: 'original-continuation',
        request: { request_type: kind, schema, prompt: 'Original question' }, deadlineAt: deadline,
        scopeId: 'original-remote-scope', taskId: 'original-remote-task', target: { local_name: 'remote', target_agent_id: 'remote-agent' },
        pauseDigest: hash('original-pause') };
      entered = { snapshot, context, question };
      const answer = await runtime.presentA2aInteraction({ query: { scope, sessionId: identity.sessionId, runId: identity.runId,
        sourceRunId: identity.runId }, snapshot, wait: { ...question, questionDigest: hash(question) }, ...context,
        presentLocal: local ? async input => { presentations++; return local(input); } : undefined });
      context.assertCurrent();
      if (stopAfterAnswer && !stopped) { stopped = true; throw Error('stopped before original journal delivery'); }
      answers.push(answer);
      return { commandId: 'original-read', kind: 'reconcile_tool', payload: { originalOperationKey: snapshot.toolReconciliation.operationKey } };
    } }),
  }) };
  const deadline = Date.now() + 60000;
  runtime = createManagedNativeKernel(config);
  t.after(async () => { await runtime.close(); rmSync(directory, { recursive: true, force: true }); });
  const db = new DatabaseSync(join(directory, 'commands.sqlite')); t.after(() => db.close());
  const pending = () => db.prepare('SELECT * FROM managed_interactions').get();
  return { issuer, db, directory, config, failCommitAfter: count => { failAfter = count; }, get runtime() { return runtime; }, get entered() { return entered; },
    counts: () => ({ models, writes, reads, presentations, answers }), pending,
    receive: cmd => runtime.receive(cmd, issuer.issue(cmd)),
    reply(fields = {}) { const found = pending(); return command({ command_type: 'submit_interaction', payload: {
      run_id: found.run_id, interaction_id: found.interaction_id, expected_revision: 1, action: kind === 'approval' ? 'approve' : 'submit',
      response: { answer: 7 }, token_ref: 'original-token', ...fields } }); },
    async start() { const cmd = command(), receipt = await runtime.receive(cmd, issuer.issue(cmd));
      const driving = runtime.drain(cmd.session_id); void driving.catch(() => {});
      await until(() => pending()?.owner_until > Date.now()); return { cmd, receipt, driving }; },
    async reopen() { await runtime.close(); runtime = createManagedNativeKernel(config); },
  };
}

for (const kind of ['structured_input', 'approval']) test(`signed ${kind} answer is durable, exact and cannot become a Native tool approval`, async t => {
  const f = fixture(t, { kind }), { cmd, receipt, driving } = await f.start();
  const pending = f.pending(), descriptor = JSON.parse(pending.data);
  assert.equal(descriptor.pending.kind, kind); assert.equal(descriptor.pending.nativeTarget.remoteInteractionId, 'original-remote-question');
  const answer = f.reply({ response: kind === 'approval' ? {} : { answer: 7 } });
  assert.equal((await f.receive(answer)).status, 'accepted');
  assert.notEqual(f.pending().answer, null, 'answer is durable before command ACK');
  await driving;
  assert.deepEqual(f.counts(), { models: 2, writes: 1, reads: 1, presentations: 0,
    answers: [kind === 'approval' ? { action: 'approve' } : { action: 'submit', parts: [{ data: { answer: 7 } }] }] });
  const record = f.runtime.inspectSession({ scope, sessionId: cmd.session_id, runId: receipt.run_id }).record;
  assert.equal(record.snapshot.phase, 'completed');
  assert.equal(record.commands.filter(row => row.command.kind === 'submit_interaction').length, 0);
  const before = copy(f.counts());
  assert.equal((await f.receive({ ...answer, payload: { ...answer.payload, token_ref: 'rotated-token' } })).status, 'duplicate');
  const events = f.db.prepare('SELECT data FROM managed_events ORDER BY seq').all().map(row => JSON.parse(row.data));
  const interactions = events.filter(event => event.family === 'interaction');
  assert.deepEqual(interactions.map(row => row.event_type), ['interaction.requested', 'interaction.resolved']);
  for (const event of interactions) assert.equal(validateInteraction(event.payload), true, JSON.stringify(validateInteraction.errors));
  assert.equal(interactions[1].payload.revision, 2); assert.deepEqual(interactions[1].payload.response, answer.payload.response);
  await f.reopen(); await f.runtime.drain(cmd.session_id); assert.deepEqual(f.counts(), before);
  assert.deepEqual(f.runtime.inspectSession({ scope, sessionId: cmd.session_id, runId: receipt.run_id }).record, record);
});

test('wrong token, schema, action, kind, version and foreign target cannot settle the original input', async t => {
  const f = fixture(t), { driving } = await f.start();
  const before = f.pending().answer;
  for (const fields of [{ token_ref: 'wrong' }, { response: { answer: 'wrong' } }, { action: 'approve' },
    { a2a_interaction_kind: 'approval' }, { expected_revision: 2 }, { run_id: 'foreign' }, { interaction_id: 'foreign' }]) {
    assert.equal((await f.receive(f.reply(fields))).status, 'rejected'); assert.equal(f.pending().answer, before);
  }
  assert.equal((await f.receive(f.reply())).status, 'accepted'); await driving;
  assert.equal(f.counts().writes, 1);
});

test('concurrent signed answers have one winner; conflicting later submissions cannot change it', async t => {
  const f = fixture(t), { driving } = await f.start();
  const attempts = [f.reply({ response: { answer: 1 } }), f.reply({ response: { answer: 2 } })];
  const replies = await Promise.all(attempts.map(f.receive));
  assert.deepEqual(replies.map(r => r.status).sort(), ['accepted', 'rejected']); await driving;
  const winner = attempts[replies.findIndex(r => r.status === 'accepted')];
  assert.deepEqual(f.counts().answers, [{ action: 'submit', parts: [{ data: winner.payload.response }] }]);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM managed_events WHERE json_extract(data,'$.event_type')='interaction.resolved'").get().n, 1);
});

test('reconstruction after durable answer but before original journal delivery consumes that exact answer without asking again', async t => {
  const f = fixture(t, { stopAfterAnswer: true }), { cmd, receipt, driving } = await f.start();
  assert.equal((await f.receive(f.reply())).status, 'accepted');
  await assert.rejects(driving, /stopped before original journal delivery/);
  assert.deepEqual(f.counts(), { models: 1, writes: 1, reads: 0, presentations: 0, answers: [] });
  await f.reopen(); await f.runtime.drain(cmd.session_id);
  assert.deepEqual(f.counts().answers, [{ action: 'submit', parts: [{ data: { answer: 7 } }] }]);
  assert.equal(f.counts().writes, 1); assert.equal(f.counts().models, 2);
  assert.equal(f.runtime.inspectSession({ scope, sessionId: cmd.session_id, runId: receipt.run_id }).record.snapshot.phase, 'completed');
});

test('local answer and signed Server answer share first-wins persistence and withdraw the late local presenter', async t => {
  const release = Promise.withResolvers(); let localSignal;
  const f = fixture(t, { local: async ({ signal }) => { localSignal = signal; return release.promise; } }), { driving } = await f.start();
  await until(() => localSignal);
  assert.equal((await f.receive(f.reply())).status, 'accepted'); await driving;
  assert.equal(localSignal.aborted, true); const answer = f.pending().answer;
  release.resolve({ action: 'submit', parts: [{ data: { answer: 99 } }] });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.pending().answer, answer);
  assert.deepEqual(f.counts().answers, [{ action: 'submit', parts: [{ data: { answer: 7 } }] }]);
});

test('signed input rejection remains a rejected question answer, never approval or remote cancellation', async t => {
  const f = fixture(t), { driving } = await f.start();
  assert.equal((await f.receive(f.reply({ action: 'reject', response: null }))).status, 'accepted'); await driving;
  assert.deepEqual(f.counts().answers, [{ action: 'reject' }]); assert.equal(f.counts().writes, 1);
});

test('raw string result-envelope is retained until the original A2A journal normalizes it', async t => {
  const f = fixture(t, { schema: { type: 'string' } }), { driving } = await f.start();
  const raw = { result: 'Shanghai' };
  assert.equal((await f.receive(f.reply({ response: raw }))).status, 'accepted'); await driving;
  assert.deepEqual(f.counts().answers, [{ action: 'submit', parts: [{ data: raw }] }]);
});

test('pausing withdraws live answer authority and resume restores the original interaction instead of creating another', async t => {
  const f = fixture(t), { cmd, receipt, driving } = await f.start();
  const original = f.pending().interaction_id;
  assert.equal((await f.receive(command({ command_type: 'pause', payload: { run_id: receipt.run_id } }))).status, 'accepted');
  await until(() => f.runtime.inspectSession({ scope, sessionId: cmd.session_id, runId: receipt.run_id }).record.snapshot.phase === 'paused');
  assert.equal((await f.receive(f.reply())).status, 'rejected'); assert.equal(f.pending().answer, null);
  assert.equal((await f.receive(command({ command_type: 'resume', payload: { target: { kind: 'run', id: receipt.run_id } } }))).status, 'accepted');
  await until(() => f.pending()?.owner_until > Date.now());
  assert.equal(f.pending().interaction_id, original);
  assert.equal((await f.receive(f.reply())).status, 'accepted'); await driving;
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM managed_interactions').get().n, 1);
  assert.equal(f.counts().writes, 1);
});

test('expired durable waiter registration refuses a Server answer until the original owner renews it', async t => {
  const f = fixture(t), { driving } = await f.start();
  f.db.prepare('UPDATE managed_interactions SET owner_until=0').run();
  assert.equal((await f.receive(f.reply())).status, 'rejected'); assert.equal(f.pending().answer, null);
  await until(() => f.pending()?.owner_until > Date.now());
  assert.equal((await f.receive(f.reply())).status, 'accepted'); await driving;
  assert.equal(f.counts().writes, 1);
});

test('answer, admission and resolved event roll back together when their commit fails', async t => {
  const f = fixture(t), { driving } = await f.start(), answer = f.reply();
  f.failCommitAfter(2); // Read-only duplicate lookup commits first, then actual admission.
  await assert.rejects(f.receive(answer), /interaction commit failed/);
  assert.equal(f.pending().answer, null);
  assert.equal(f.db.prepare('SELECT * FROM managed_commands WHERE command_id=?').get(answer.command_id), undefined);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM managed_events WHERE json_extract(data,'$.event_type')='interaction.resolved'").get().n, 0);
  assert.equal((await f.receive(answer)).status, 'accepted'); await driving;
  assert.equal(f.counts().writes, 1);
});

test('a separate authenticated SQLite receiver delivers the answer to the original live execution without creating another owner', async t => {
  const f = fixture(t), { driving } = await f.start(), other = createManagedNativeKernel(f.config);
  try {
    const answer = f.reply(); assert.equal((await other.receive(answer, f.issuer.issue(answer))).status, 'accepted');
    await driving; assert.deepEqual(f.counts().answers, [{ action: 'submit', parts: [{ data: { answer: 7 } }] }]);
    assert.equal(f.counts().models, 2); assert.equal(f.counts().writes, 1);
  } finally { await other.close(); }
});

test('existing inbound event consumer sees original requested/waiting then accepted/resolved/running and terminal', async t => {
  const f = fixture(t), { cmd, receipt, driving } = await f.start();
  const consume = async (receipt, afterSeq = 0) => {
    const controller = new AbortController(), facts = [];
    try { for await (const fact of streamA2aInboundKernelFacts({ sessionId: cmd.session_id, agentId: target.agentInstanceId, receipt },
      f.runtime.events, { expectedRunId: receipt.run_id, afterSeq, signal: controller.signal, assertCurrent: () => true })) facts.push(fact);
    } finally { controller.abort(); }
    return facts;
  };
  const waiting = await consume(receipt);
  assert.equal(waiting.at(-1).payload.state, 'waiting');
  assert.equal(waiting.find(row => row.event_type === 'interaction.requested').payload.kind, 'structured_input');
  const answer = f.reply(), accepted = await f.receive(answer); await driving;
  const resumed = await consume(accepted, waiting.at(-1).seq);
  const admission = resumed.findIndex(row => row.event_type === 'control.command_accepted' && row.payload.command_id === answer.command_id);
  const resolved = resumed.findIndex(row => row.event_type === 'interaction.resolved');
  assert.ok(admission >= 0 && resolved > admission);
  assert.equal(resumed[resolved].causation_id, answer.command_id); assert.equal(resumed.at(-1).payload.state, 'completed');
});

test('original signed interruption cancels the pending interaction durably; shutdown alone does not resolve it', async t => {
  const f = fixture(t), { cmd, receipt, driving } = await f.start();
  const before = f.pending().interaction_id;
  await f.reopen(); await assert.rejects(driving, { code: 'NATIVE_KERNEL_AUTHORITY_LOST' });
  assert.equal(JSON.parse(f.pending().data).closed, undefined);
  const resumed = f.runtime.drain(cmd.session_id); void resumed.catch(() => {});
  await until(() => f.pending().owner_until > Date.now()); assert.equal(f.pending().interaction_id, before);
  assert.equal((await f.receive(command({ command_type: 'interrupt', payload: { run_id: receipt.run_id } }))).status, 'accepted');
  await resumed; assert.equal(JSON.parse(f.pending().data).closed, true); assert.equal(f.pending().answer, null);
  assert.equal((await f.receive(f.reply())).status, 'rejected');
  const events = f.db.prepare("SELECT data FROM managed_events WHERE json_extract(data,'$.family')='interaction' ORDER BY seq")
    .all().map(row => JSON.parse(row.data));
  assert.deepEqual(events.map(row => row.event_type), ['interaction.requested', 'interaction.cancelled']);
  for (const event of events) assert.equal(validateInteraction(event.payload), true, JSON.stringify(validateInteraction.errors));
  assert.equal(f.counts().reads, 0); assert.equal(f.counts().writes, 1);
});
