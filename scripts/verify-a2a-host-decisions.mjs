/** Actual maintained Session/Projection/Approval services, real Node A2A
 * transport, journal and both delivery workers. Controlled answerers and HTTP
 * peers; this is not a full mounted Studio/browser or live-human proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { openSync, closeSync, fsyncSync, readFileSync, writeFileSync } from 'node:fs';
import { canonical } from '../packages/agentkit-harness-core/dist/index.mjs';
import { dshPresetId } from '../src/agent-preset-admission.mjs';
import { prepareNativeA2AHost, prepareDshA2AHost } from '../src/providers/native-a2a-host.mjs';
import { a2aDecisionDigest } from '../src/providers/native-a2a-decision.mjs';
import { requestStudioA2aApproval } from '../src/host/services/a2a-control-approval.mjs';
import { createStudioA2aSessionSink, A2A_SESSION_EVENT } from '../src/host/services/a2a-session-events.mjs';
import { internalPeer, scope, spec } from '../tests/fixtures/native-a2a-internal-peer.mjs';
const { values } = parseArgs({ options: { source: { type: 'string' }, evidence: { type: 'string' } } });
assert.ok(values.source, '--source <built maintained DSH checkout> required');
const source = resolve(values.source), require = createRequire(join(source, 'packages/core/session/package.json'));
const evidence = { node: process.version, source, cases: [], limitation: 'Actual maintained Session/Projection/Approval services and transport/journal/delivery; controlled answerers/HTTP peers, an explicit fsynced test persistence carrier and a minimal agent containing the real Session. Not a mounted Studio Agent/controller, live human, browser, online service, fresh installation or Electron proof.' };
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
const imported = async path => import(pathToFileURL(join(source, path, 'lib/index.js')).href);
const { default: SessionStore } = await imported('packages/core/session');
const { default: Projections } = await imported('packages/session/session-projection');
const { default: ApprovalService } = await imported('packages/interaction/user-approval');
const { turnBoundaryProjectionDefinition } = await imported('packages/core/agent-loop');
const { agentPresetProjectionDefinition } = await imported('packages/preset/agent-preset-registry');
const signal = () => new AbortController().signal;
const remoteTask = () => ({ id: 'original-remote', contextId: 'original-context', status: { state: 'TASK_STATE_INPUT_REQUIRED',
  message: { messageId: 'question', role: 'ROLE_AGENT', parts: [{ text: 'Approve remote write' }],
    metadata: { input_schema: { type: 'string', enum: ['approve', 'reject'] }, ksadk_interaction: { version: 1,
      kind: 'approval', allowed_decisions: ['approve', 'reject'], presentation: { title: 'write', description: '{"arguments":{"path":"report"}}' } } } } } });
async function harness(t, { dsh = false, outcome = 'allowed-once', failFlush = false, spoof = false } = {}) {
  const f = await internalPeer({ initialTask: remoteTask(), expectedContinuationParts: [{ data: 'approve' }] });
  const ctx = new Context(); await ctx.plugin(SessionStore); await ctx.plugin(Projections); await ctx.plugin(ApprovalService);
  ctx.sessionProjections.register(turnBoundaryProjectionDefinition); ctx.sessionProjections.register(agentPresetProjectionDefinition);
  ctx.sessionProjections.register({ key: 'decisionVerificationLog', stateVersion: 1, init: () => [],
    stateSchema: { parse: value => value }, apply: (state, event) => [...state, event] });
  const presetId = dshPresetId('agent', 1), session = ctx.sessions.create('session', { meta: { agentPreset: presetId } });
  session.append('turn/start', { turn: 1 });
  const log = () => ctx.sessionProjections.stateOf(session, 'decisionVerificationLog');
  const historyFile = join(f.root, 'decision-history.json'); let failure = failFlush;
  ctx.on('session/flush', selected => {
    assert.equal(selected, session); if (failure) throw Error('intentional audit durability failure');
    writeFileSync(historyFile, canonical(log())); const fd = openSync(historyFile, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
  });
  ctx.on('approval/request', async () => outcome);
  const sink = createStudioA2aSessionSink({ ctx }), writer = sink.forPreset({ agentId: 'agent' });
  const agent = { session }; // Service contract consumes only this actual Session.
  const assertCurrent = () => {
    assert.equal(agent.session, session); assert.equal(ctx.sessionProjections.stateOf(session, 'agentPreset'), presetId); return true;
  };
  const authorizeControl = async ({ command, readOnly }) => {
    if (readOnly) return 'allow';
    if (spoof) return 'allow';
    const result = await requestStudioA2aApproval({ ctx, agent, presetId, assertCurrent, requireReceipt: true,
      request: { agent, toolName: `a2a_${command.kind}_task`, callId: `command:${command.commandId}`,
        reason: canonical(command), signal: signal() } });
    return { decision: result.outcome === 'allowed-once' ? 'allow' : 'deny', commandDigest: a2aDecisionDigest(command), receipt: result.receipt };
  };
  const fields = dsh ? { agentId: 'agent', agentRevision: 1, buildId: null } : { scope };
  const factory = (dsh ? prepareDshA2AHost : prepareNativeA2AHost)({ env: f.env, bindings: [spec], sessionEvents: writer });
  const owner = factory.forSession({ ...fields, sessionId: 'session', stateRoot: join(f.root, 'state'), workspaceRoot: f.workspaceRoot,
    assertCurrent, assertControl: assertCurrent, authorizeControl }); f.owners.push(owner);
  t.after(async () => { await factory.close(); await sink.close(); await ctx.fiber.dispose(); await f.close(); });
  const request = await owner.invocation.resolve({ agent: 'research', message: 'initial', signal: signal(),
    [dsh ? 'dshRequest' : 'nativeRequest']: { ...fields, sessionId: 'session', ...(dsh ? {} : { runId: 'run' }),
      operationKey: 'operation', call: { callId: 'call' } } });
  assert.equal((await owner.invocation.dispatch({ request, signal: signal() })).state, 'input_required');
  await owner.eventDelivery.flushSession({ raiseOnError: !failFlush });
  const before = await owner.control.execute({ kind: 'get', commandId: 'read', authority: {}, operation_locator: request.identity, signal: signal() });
  return { ...f, ctx, agent, owner, request, log, historyFile, before, presetId, assertCurrent,
    flushWorks() { failure = false; },
    execute(kind) { return owner.control.execute({ kind, commandId: 'actual-decision', authority: {}, operation_locator: request.identity,
      ...(kind === 'continue' ? { parts: [{ data: 'approve' }], pauseDigest: before.pauseDigest }
        : kind === 'reject' ? { pauseDigest: before.pauseDigest } : {}), signal: signal() }); } };
}
for (const dsh of [false, true]) for (const kind of ['continue', 'cancel', 'reject']) await test(`${dsh ? 'DSH' : 'Native'} ${kind}: actual audit -> decision+intent -> remote effect -> actual persistent Session`, async t => {
  const f = await harness(t, { dsh }), originalModelHistory = f.agent.session.deriveMessages();
  await f.execute(kind); await f.owner.eventDelivery.flush(); await f.owner.eventDelivery.flushSession();
  const history = JSON.parse(readFileSync(f.historyFile, 'utf8'));
  const asked = history.filter(event => event.type === 'approval/asked'), decided = history.filter(event => event.type === 'approval/decided');
  assert.equal(asked.length, 1); assert.equal(decided.length, 1); assert.equal(decided[0].data.id, asked[0].data.id);
  const log = f.record().managed.events.log, resolutions = log.filter(event => event.event_type === 'interaction.resolved');
  assert.equal(resolutions.length, 1); const [resolution] = resolutions, receipt = resolution.source.metadata.host_decision;
  assert.equal(receipt.requestId, asked[0].data.id); assert.equal(receipt.askedSeq, asked[0].seq); assert.equal(receipt.decidedSeq, decided[0].seq);
  assert.equal(receipt.sessionId, 'session'); assert.equal(receipt.presetId, f.presetId);
  assert.equal(resolution.response.decision, kind === 'continue' ? 'approved' : kind === 'reject' ? 'rejected' : 'canceled');
  assert.deepEqual(history.filter(event => event.type === A2A_SESSION_EVENT).map(event => JSON.parse(event.data.eventJson)), log);
  assert.deepEqual(f.agent.session.deriveMessages(), originalModelHistory);
  assert.equal(f.record().managed.events.sessionDelivery.through, log.length);
  assert.equal(f.record().managed.events.pending.length, 0);
  evidence.cases.push({ dsh, kind, events: log, audit: { asked, decided }, sessionThrough: f.record().managed.events.sessionDelivery.through });
  const before = f.calls.filter(call => call.wireMethod).length; await f.execute(kind);
  assert.equal(f.calls.filter(call => call.wireMethod).length, before); assert.equal(f.log().filter(event => event.type === 'approval/asked').length, 1);
});
for (const outcome of ['rejected', 'unavailable', 'cancelled']) await test(`actual ${outcome} cannot publish a remote approval decision or effect`, async t => {
  const f = await harness(t, { outcome }); await assert.rejects(f.execute('continue'), { code: 'A2A_CONTROL_PERMISSION_DENIED' });
  assert.equal(f.log().filter(event => event.type === 'approval/decided')[0].data.outcome, outcome);
  assert.equal(f.record().managed.events.log.filter(event => event.event_type === 'interaction.resolved').length, 0);
  assert.equal(f.calls.filter(call => call.wireMethod === 'SendMessage').length, 1);
});
await test('actual audit flush failure cannot admit a remote effect', async t => {
  const f = await harness(t, { failFlush: true }); await assert.rejects(f.execute('continue'), /intentional audit durability failure/);
  assert.equal(f.record().managed.events.log.filter(event => event.event_type === 'interaction.resolved').length, 0);
  assert.equal(f.calls.filter(call => call.wireMethod === 'SendMessage').length, 1);
  f.flushWorks(); await f.owner.eventDelivery.flushSession();
});
await test('a bare allow without an actual audit is rejected despite valid remote approval hints', async t => {
  const f = await harness(t, { spoof: true }); await assert.rejects(f.execute('continue'), { code: 'A2A_HOST_DECISION_REQUIRED' });
  assert.equal(f.calls.filter(call => call.wireMethod === 'SendMessage').length, 1);
});
if (values.evidence) writeFileSync(resolve(values.evidence), JSON.stringify(evidence, null, 2));
