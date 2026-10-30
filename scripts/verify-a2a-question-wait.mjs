/** Real maintained question/approval/Session services + Native Kernel/SQLite
 * and HTTP. Answerers, live-agent registry, sandbox-policy lookup and fsynced
 * persistence carrier are explicit fixtures, not a mounted Studio/browser. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { openSync, closeSync, fsyncSync, readFileSync, writeFileSync } from 'node:fs';
import { NativeKernel, initialSnapshot, emptyUsage, canonical } from '@kingsoftcloud/agentkit-harness-core';
import { fixture, digest } from '../tests/fixtures/native-core.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { createNativeA2aToolPort, nativeA2aToolDefinitions } from '@kingsoftcloud/agentkit-harness-node/native/a2a-tools';
import { prepareNativeA2AHost } from '../src/providers/native-a2a-host.mjs';
import { createNativeToolAuthority } from '../src/providers/native-tool-authority.mjs';
import { createNativeA2aReceiptObserver, createNativeA2aReceiptWaiter } from '../src/providers/native-a2a-receipt.mjs';
import { createNativeHostInteraction } from '../src/providers/native-host-interaction.mjs';
import { createStudioA2aSessionSink, A2A_SESSION_EVENT } from '../src/host/services/a2a-session-events.mjs';
import { dshPresetId } from '../src/agent-preset-admission.mjs';
import { internalPeer, scope, spec } from '../tests/fixtures/native-a2a-internal-peer.mjs';

const { values } = parseArgs({ options: { source: { type: 'string' }, evidence: { type: 'string' } } });
assert.ok(values.source, '--source <built maintained DSH checkout> required');
const source = resolve(values.source), require = createRequire(join(source, 'packages/core/session/package.json'));
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
const imported = async path => import(pathToFileURL(join(source, path, 'lib/index.js')).href);
const { default: Sessions } = await imported('packages/core/session');
const { default: Projections } = await imported('packages/session/session-projection');
const { default: Approvals } = await imported('packages/interaction/user-approval');
const { default: Questions } = await imported('packages/interaction/user-questions');
const { agentPresetProjectionDefinition } = await imported('packages/preset/agent-preset-registry');
const { turnBoundaryProjectionDefinition } = await imported('packages/core/agent-loop');
const evidence = { node: process.version, source, cases: [], limitation: 'Actual maintained question/approval/Session/Projection services, Native Kernel/SQLite/private journal and controlled HTTP. Explicit controlled answerers, minimal live-root registry and sandbox-policy lookup, fsynced test persistence carrier; not mounted Studio, human/browser, fresh install, Electron, real models or online services.' };

for (const approval of [false, true]) for (const answer of ['accept', 'reject', 'denied']) await test(`actual managed ${approval ? 'approval' : 'input'} ${answer}: original Host idle -> question -> durable answer -> separate audit -> original receipt`, async t => {
  const task = { id: 'original-remote', contextId: 'original-context', status: { state: 'TASK_STATE_INPUT_REQUIRED', message: {
    messageId: 'question', role: 'ROLE_AGENT', parts: [{ text: 'Remote question' }], metadata: {
      input_schema: { type: 'string', ...(approval ? { enum: ['approve', 'reject'] } : {}) },
      ...(approval ? { ksadk_interaction: { version: 1, kind: 'approval', allowed_decisions: ['approve', 'reject'],
        presentation: { title: 'remote-write', description: '{"arguments":{"path":"report"}}' } } } : {}) } } } };
  const f = await internalPeer({ initialTask: task, expectedContinuationParts: [{ data: approval ? 'approve' : 'Shanghai' }] });
  const ctx = new Context();
  await ctx.plugin(Sessions); await ctx.plugin(Projections); await ctx.plugin(Approvals); await ctx.plugin(Questions);
  ctx.sessionProjections.register(agentPresetProjectionDefinition); ctx.sessionProjections.register(turnBoundaryProjectionDefinition);
  ctx.sessionProjections.register({ key: 'questionVerification', stateVersion: 1, init: () => [], stateSchema: { parse: value => value },
    apply: (state, event) => [...state, event] });
  const session = ctx.sessions.create('session', { meta: { agentPreset: dshPresetId('agent', 1) } });
  session.append('turn/start', { turn: 1 }); const agent = { id: 'live-root', session };
  ctx.provide('agents', { get: id => id === agent.id ? agent : undefined, roots: () => [agent] });
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write' }) });
  const log = () => ctx.sessionProjections.stateOf(session, 'questionVerification');
  const historyFile = join(f.root, 'question-history.json');
  ctx.on('session/flush', selected => {
    assert.equal(selected, session); writeFileSync(historyFile, canonical(log()));
    const fd = openSync(historyFile, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
  });
  let questions = 0, permissions = 0;
  ctx.on('user-questions/request', async request => {
    questions++; assert.equal(request.agent, agent); assert.equal(request.questions.length, 1);
    const question = request.questions[0];
    assert.equal(f.calls.filter(call => call.wireMethod === 'SendMessage').length, 1);
    return { answers: [{ id: question.id, selected: answer === 'reject' ? [approval ? '拒绝远端操作' : '拒绝输入']
      : approval ? ['批准远端操作'] : [], ...(!approval && answer !== 'reject' ? { custom: 'Shanghai' } : {}) }] };
  });
  ctx.on('approval/request', async () => {
    permissions++;
    const entry = Object.values(f.record().managed.questions.entries)[0];
    assert.equal(entry.stage, 'awaiting_permission'); assert.notEqual(entry.status, 'pending');
    assert.equal(f.calls.filter(call => call.wireMethod === 'SendMessage').length, 1);
    assert.equal(Object.keys(f.record().controls ?? {}).length, 0);
    return answer === 'denied' ? 'rejected' : 'allowed-once';
  });
  const sink = createStudioA2aSessionSink({ ctx });
  const a2a = prepareNativeA2AHost({ env: f.env, bindings: [spec], sessionEvents: sink.forPreset({ agentId: 'agent' }) });
  const store = new SqliteRunStore(join(f.root, 'runs.sqlite'));
  const fields = { a2a, scope, sessionId: 'session', store, stateRoot: join(f.root, 'state'), workspaceRoot: f.workspaceRoot, isClosed: () => false };
  const authority = createNativeToolAuthority({ scope, sessionId: 'session', store });
  const owner = a2a.forSession({ ...fields, assertCurrent: authority }); f.owners.push(owner);
  t.after(async () => { await a2a.close(); await sink.close(); store.close(); await ctx.fiber.dispose(); await f.close(); });
  const port = createNativeA2aToolPort({ ...owner, scope, sessionId: 'session', spaceId: spec.space_id,
    authorize: () => 'allow', assertCurrent: authority, receiptObservation: true });
  let models = 0;
  const kernel = new NativeKernel({ store, digest, owner: 'question-services', ports: {
    model: { generate: async () => ++models === 1 ? { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [
      { callId: 'call', name: 'call_a2a_agent', arguments: { agent: 'research', message: 'initial' } }] }
      : { kind: 'final_candidate', text: 'finished', toolCalls: [], usage: emptyUsage() } },
    tools: { execute: request => port.execute(request), observeReceipt: createNativeA2aReceiptObserver(fields) },
  } });
  const { config } = fixture({ tools: nativeA2aToolDefinitions({ receiptObservation: true }) });
  kernel.start(initialSnapshot({ scope, sessionId: 'session', runId: 'run', turnId: 'turn', buildId: 'build', parentRunId: null,
    taskChainId: 'chain' }, config, digest(config)), config);
  const snapshot = await kernel.runUntilIdle(scope, 'run'); assert.equal(snapshot.phase, 'awaiting_reconciliation');
  const beforeMessages = session.deriveMessages();
  const command = await createNativeHostInteraction({ ctx, store })({ agent, signal: new AbortController().signal }, snapshot,
    { waitForToolReceipt: createNativeA2aReceiptWaiter(fields) });
  assert.equal(questions, 1); assert.equal(permissions, !approval && answer === 'reject' ? 0 : 1);
  kernel.submit(scope, 'run', command); assert.equal((await kernel.runUntilIdle(scope, 'run')).phase, 'completed'); assert.equal(models, 2);
  await owner.eventDelivery.flush(); await owner.eventDelivery.flushSession();
  const saved = f.record(), local = saved.managed.questions.log, remote = saved.managed.events.log;
  const history = JSON.parse(readFileSync(historyFile, 'utf8'));
  const events = history.filter(event => event.type === A2A_SESSION_EVENT);
  const localEvents = events.filter(event => JSON.parse(event.data.eventJson).source.metadata?.host_question === true);
  assert.deepEqual(localEvents.map(event => JSON.parse(event.data.eventJson)), local);
  assert.equal(new Set(localEvents.map(event => event.data.sourceKey)).size, 1);
  assert.ok(events.filter(event => !localEvents.includes(event)).every(event => event.data.sourceKey !== localEvents[0].data.sourceKey));
  assert.equal(saved.managed.questions.sessionDelivery.through, local.length);
  assert.equal(saved.managed.events.sessionDelivery.through, remote.length);
  assert.equal(saved.managed.events.pending.length, 0); assert.deepEqual(session.deriveMessages(), beforeMessages);
  const asked = history.filter(event => event.type === 'approval/asked'), decided = history.filter(event => event.type === 'approval/decided');
  assert.equal(asked.length, permissions); assert.equal(decided.length, permissions);
  if (permissions) assert.equal(decided[0].data.id, asked[0].data.id);
  const sends = f.calls.filter(call => call.wireMethod === 'SendMessage').length, cancels = f.calls.filter(call => call.wireMethod === 'CancelTask').length;
  assert.equal(sends, answer === 'reject' || answer === 'denied' ? 1 : 2);
  assert.equal(cancels, approval && answer === 'reject' ? 1 : 0);
  const before = log().length; await owner.eventDelivery.flushSession(); assert.equal(log().length, before);
  assert.ok(f.calls.filter(call => call.action === 'AppendA2ATaskEvents').flatMap(call => call.body.Events)
    .every(event => !event.source.metadata?.host_question), 'local-only questions never reach remote Append');
  evidence.cases.push({ approval, answer, questions, permissions, sends, cancels, local, remote, audit: { asked, decided } });
});
if (values.evidence) writeFileSync(resolve(values.evidence), JSON.stringify(evidence, null, 2) + '\n');
