import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRunStore, emptyUsage, BACKGROUND_COMMAND_CONTRACT } from '@kingsoftcloud/agentkit-harness-core';
import { createNativeDshTurnExecutor } from '@kingsoftcloud/agentkit-harness-node/native/dsh-turn-runtime';
import { nativeDeliveryProjection } from '@kingsoftcloud/agentkit-harness-node/native/session-delivery';
import { fixture, scope as fixtureScope, tool } from './fixtures/native-core.mjs';
import { nativeOwnershipHost } from './fixtures/native-ownership-host.mjs';
import { createNativeRecoveryState } from '../src/client/state/native-recovery.mjs';
import { nativeRunPresentation } from '../src/client/state/native-outcome.mjs';
import { createStudioNativeRecovery, validateNativeBackgroundReviewRequest } from '../src/host/services/native-recovery.mjs';
import { createSessionRoutes } from '../src/host/routes/sessions.mjs';
const scope = { ...fixtureScope, tenantId: 'local', userId: 'local-user' };

test('review closes only the presentation owner; a fresh task retains unknown facts without repeating a launch', async () => {
  const store = new MemoryRunStore(), events = [], projection = nativeDeliveryProjection(); let state = projection.init();
  const session = { id: 'session', append(type, data, options) {
    const event = { type, data: structuredClone(data), ...options, seq: events.length + 1 };
    events.push(event); state = projection.apply(state, event);
  } };
  session.append('turn/start', { turn: 1 });
  const agent = { session, externalTurns: nativeOwnershipHost(session, events) };
  agent.externalTurns.resume = async (_engine, execute) => {
    const ownership = agent.externalTurns.pending();
    const result = await execute({ turn: ownership.turn, ownership, signal: new AbortController().signal });
    session.append('turn/end', { turn: ownership.turn, ...result }); return result;
  };
  let models = 0, launches = 0;
  const configuration = fixture({ tools: [tool({ name: 'run_command', readOnly: false, concurrentSafe: false,
    backgroundCommandPolicy: 'owned-command-launch/v1' })], backgroundNotificationPolicy: 'completed-before-model/v1',
  inputMessages: [{ role: 'user', content: 'Start background work' }] }).config;
  const input = { kind: 'enter', messages: [{ id: 'task', role: 'user', content: [{ type: 'text', text: 'Start background work' }] }] };
  const binding = { scope, buildId: 'build', configuration, source: { provider: 'fixture', model: 'fixture' }, ports: {
    model: { generate: async request => {
      if (++models === 1) return { kind: 'tool_calls', text: '', usage: emptyUsage(),
        toolCalls: [{ callId: 'launch', name: 'run_command', arguments: {} }] };
      const observation = request.messages.find(row => row.kind === 'background_command_observation');
      assert.ok(observation); assert.equal(JSON.parse(observation.content).commands[0].status, 'unknown');
      return { kind: 'final_candidate', text: 'The previous result is still unknown.', toolCalls: [], usage: emptyUsage() };
    } },
    tools: { execute: async request => { launches++; return { status: 'ok', content: {},
      backgroundCommandRef: { sourceRunId: request.runId, taskId: 'a'.repeat(64), operationKey: request.operationKey } }; } },
    background: { contract: BACKGROUND_COMMAND_CONTRACT, observe: async request => request.refs.map(ref => ({ ref, status: 'unknown' })) },
  } };
  const executor = createNativeDshTurnExecutor({ store, resolveTurn: async () => binding, durableOwnership: true,
    projections: { stateOf: () => state }, flush: async () => true });
  const payload = { agent, input, turn: 1, signal: new AbortController().signal };
  await assert.rejects(executor(payload), { code: 'NATIVE_TURN_FAILED' });
  const runId = store.sessionHead(scope, session.id).runId, before = store.load(scope, runId);
  await assert.rejects(executor.closeReviewedBackgroundInterruption({ agent, scope, runId }), /owner_mismatch/);
  store.reviewBackgroundInterruption(scope, runId, { contract: 'agentkit.background-interruption-review/v1', commandId: 'review-1',
    eventSeq: before.snapshot.eventSeq, confirmedStopped: true }, Date.now());
  const ending = await executor.closeReviewedBackgroundInterruption({ agent, scope, runId });
  assert.equal(ending.reason.kind, 'error'); assert.equal(ending.reason.error.code, 'NATIVE_BACKGROUND_RESULT_UNKNOWN');
  assert.equal(agent.externalTurns.pending(), null); assert.equal(models, 1); assert.equal(launches, 1);
  const after = store.load(scope, runId);
  for (const field of ['snapshot', 'events', 'receipts', 'intents', 'commits', 'commands']) assert.deepEqual(after[field], before[field]);
  session.append('turn/start', { turn: 2 });
  assert.equal((await executor({ ...payload, turn: 2 })).reason.kind, 'completed');
  assert.equal(models, 2); assert.equal(launches, 1);
  assert.equal(store.load(scope, runId).snapshot.phase, 'interrupted');
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } });
  session.append('turn/start', { turn: 3 });
  agent.externalTurns.claim({ contract: 'dsh.external-turn/v1', turn: 3, engine: 'another-runtime', binding: 'new-owner' });
  const newOwner = agent.externalTurns.pending();
  agent.externalTurns.resume = () => assert.fail('Retry must not resume a newer owner');
  const lifetime = new AbortController();
  const service = createStudioNativeRecovery({ store, workspaceId: scope.workspaceId, lifetime,
    ctx: { get: name => ({ sessionController: { resolveAgent: async () => ({ agent }) },
      sessions: { flush: async () => true } })[name] }, active: new Set(), controls: new Map(), controlKey: () => 'control', execute: {} });
  const replay = await service.reviewBackground({ agentId: scope.agentId, sessionId: session.id, runId,
    commandId: 'review-1', eventSeq: before.snapshot.eventSeq, confirmedStopped: true });
  assert.equal(replay.state, 'closed'); assert.equal(replay.runId, runId);
  assert.deepEqual(agent.externalTurns.pending(), newOwner); assert.equal(launches, 1); assert.equal(models, 2);
});

const status = () => ({ contract: 'agentkit.studio-native-recovery/v1', agentId: 'agent', sessionId: 'session',
  runId: 'run', phase: 'interrupted', reason: 'effect_outcome_unknown', state: 'reconciliation_required',
  canResume: false, canReviewBackground: true, backgroundReviewEventSeq: 8 });
test('operator action retries the identical command after a lost response and preserves unknown presentation', async () => {
  assert.equal(nativeRunPresentation(status()).label, '执行中断，结果待核对');
  const requests = []; let lose = true;
  const client = createNativeRecoveryState({ agentId: 'agent', sessionId: 'session', newCommandId: () => 'review-1', hostRemote: {
    nativeRecoveryStatus: async () => status(), reviewNativeBackground: async request => {
      requests.push(structuredClone(request)); if (lose) { lose = false; throw Error('response lost'); }
      return { ...status(), state: 'closed', canReviewBackground: false, backgroundInterruptionReview: {
        contract: 'agentkit.background-interruption-review/v1', eventSeq: 8, commandId: 'review-1', confirmedStopped: true } };
    },
  } });
  try {
    await client.refresh(); await client.reviewBackground(); assert.ok(client.getSnapshot().pending);
    await client.retry(); assert.deepEqual(requests[0], requests[1]); assert.equal(client.getSnapshot().pending, null);
    const shown = nativeRunPresentation({ ...status(), state: 'closed', backgroundInterruptionReview: {
      contract: 'agentkit.background-interruption-review/v1', confirmedStopped: true } });
    assert.equal(shown.label, '已结束等待，原结果未知'); assert.doesNotMatch(shown.label, /已验证|成功/);
  } finally { client.dispose(); }
});

test('route requires an exact scoped operator confirmation and aborts before mutation', async () => {
  const request = { agentId: 'agent', sessionId: 'session', runId: 'run', commandId: 'review-1', eventSeq: 8, confirmedStopped: true };
  for (const value of [{ ...request, confirmedStopped: false }, { ...request, eventSeq: -1 }, { ...request, extra: true }])
    assert.throws(() => validateNativeBackgroundReviewRequest(value), { code: 'STUDIO_NATIVE_BACKGROUND_REVIEW_INVALID' });
  let calls = 0;
  const route = createSessionRoutes({ getNativeHost: async () => ({ reviewBackgroundInterruption: async received => { calls++; assert.deepEqual(received, request); return status(); } }) });
  assert.equal((await route('sessions/native-background-review', request)).ok, true);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(route('sessions/native-background-review', request, controller.signal)); assert.equal(calls, 1);
});
