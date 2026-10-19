import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createAssistantApprovalBridge } from '../src/assistant-approval-bridge.mjs';
import { createAssistantLocalHandoff, createSimulatedLocalExecutor } from '../src/assistant-local-handoff.mjs';
import { createPersonalAssistantRuntime } from '../src/personal-assistant-runtime.mjs';
import { cloudAssistantComposerCapability } from '../src/assistant-interaction-scope.mjs';

function fixture(sessionId = 'assistant-one') {
  let agent = { session: { id: sessionId } }, boundary = { lastTurn: 1, openTurnStartSeq: 0 }, policy = 'ask', time = 1000;
  const listeners = new Set();
  const services = { agents: { get: id => id === agent.session.id ? agent : undefined },
    sessionProjections: { stateOf: () => boundary },
    approval: { setPolicy: () => { throw new Error('Never change deployment policy'); } } };
  const ctx = { get: name => services[name], on: (event, listener) => {
    assert.equal(event, 'approval/request'); listeners.add(listener); return () => listeners.delete(listener);
  } };
  const options = { ctx, hostId: 'cloud-build-one', ownsSession: id => id === sessionId, now: () => time };
  const emit = (request = {}, fallback = () => 'unavailable') => {
    const listener = [...listeners][0];
    return Promise.resolve(listener ? listener({ agent, toolName: 'read_file', callId: 'call-one', reason: 'Read the selected report once.', ...request }, fallback) : fallback());
  };
  return { options, services, listeners, emit, policyOf: () => policy, sessionId,
    setPolicy: value => { policy = value; }, advance: () => { boundary = { lastTurn: 2, openTurnStartSeq: 10 }; },
    finish: () => { boundary.openTurnStartSeq = null; }, tick: value => { time = value; },
    replaceAgent: () => { agent = { session: { id: sessionId } }; } };
}

const firstApproval = (bridge, f) => bridge.snapshot(f.sessionId).pending[0];
const decide = (bridge, f, view, decision = 'allowed-once') => bridge.decide(f.sessionId, { ...view, decision });
const action = { kind: 'read-file', path: 'reports/result.txt', maxBytes: 1024 };

test('default approval bridge is disabled and never installs a listener or changes policy', () => {
  const f = fixture(), bridge = createAssistantApprovalBridge(f.options);
  assert.equal(f.listeners.size, 0);
  assert.deepEqual(bridge.snapshot(f.sessionId), { capabilities: { interactive: false, reason: 'disabled' }, pending: [] });
  assert.deepEqual(decide(bridge, f, { requestId: 'old-audit-id' }), { accepted: false, reason: 'request-stale' });
  bridge.dispose();
});

test('approval is a live one-shot answer, bound to the exact Host, Session, turn, and generation', async () => {
  const f = fixture(), bridge = createAssistantApprovalBridge({ ...f.options, enabled: true, policyOf: f.policyOf });
  const result = f.emit({ reason: 'Read protected report. Authorization: Bearer must-stay-private' });
  const view = firstApproval(bridge, f);
  assert.equal(view.kind, 'approval'); assert.equal(view.turn, 1); assert.equal(view.turnStartSeq, 0);
  assert.ok(!view.reason.includes('must-stay-private'));
  assert.equal(bridge.snapshot(f.sessionId).capabilities.interactive, true);
  for (const mismatch of [{ hostId: 'other' }, { sessionId: 'other' }, { turn: 2 }, { turnStartSeq: 4 }, { generation: 'old-generation' }]) {
    assert.deepEqual(decide(bridge, f, { ...view, ...mismatch }), { accepted: false, reason: 'request-stale' });
  }
  assert.deepEqual(bridge.snapshot('other').pending, []);
  assert.deepEqual(bridge.decide('other', { ...view, decision: 'allowed-once' }), { accepted: false, reason: 'request-stale' });
  assert.deepEqual(decide(bridge, f, view), { accepted: true, outcome: 'allowed-once' });
  assert.equal(await result, 'allowed-once');
  assert.deepEqual(decide(bridge, f, view), { accepted: false, reason: 'request-stale' });
  assert.equal(firstApproval(bridge, f), undefined);
  bridge.dispose();
});

test('explicit rejection is final; unsupported persistent approval decisions are rejected', async () => {
  const f = fixture(), bridge = createAssistantApprovalBridge({ ...f.options, enabled: true, policyOf: f.policyOf });
  const result = f.emit(), view = firstApproval(bridge, f);
  assert.throws(() => decide(bridge, f, view, 'allow-always'), { code: 'ASSISTANT_APPROVAL_DECISION_INVALID' });
  assert.deepEqual(decide(bridge, f, view, 'rejected'), { accepted: true, outcome: 'rejected' });
  assert.equal(await result, 'rejected'); bridge.dispose();
});

test('localized displayReason is preferred and credentials are removed before presentation', async () => {
  const f = fixture(), bridge = createAssistantApprovalBridge({ ...f.options, enabled: true, policyOf: f.policyOf });
  const result = f.emit({ reason: 'Fallback reason', displayReason: { en: 'Read the selected report.', zh: '读取选中的报告。Bearer private-secret' } });
  const view = firstApproval(bridge, f);
  assert.equal(view.reason, 'Fallback reason'); assert.match(view.presentation, /读取选中的报告/);
  assert.equal(view.canAllow, true); assert.equal(JSON.stringify(view).includes('private-secret'), false);
  assert.deepEqual(decide(bridge, f, view), { accepted: true, outcome: 'allowed-once' });
  assert.equal(await result, 'allowed-once'); bridge.dispose();
});

test('missing, blank, or fully redacted details can only be rejected even with forged choices', async () => {
  for (const request of [{ reason: undefined }, { reason: ' ', displayReason: { zh: ' ', en: '' } }, { reason: 'Bearer private-secret' }]) {
    const f = fixture(), bridge = createAssistantApprovalBridge({ ...f.options, enabled: true, policyOf: f.policyOf });
    const result = f.emit(request), view = firstApproval(bridge, f);
    assert.equal(view.canAllow, false); assert.deepEqual(view.choices, ['rejected']); assert.match(view.presentation, /未提供具体操作说明/);
    assert.deepEqual(decide(bridge, f, { ...view, canAllow: true, choices: ['allowed-once'] }), { accepted: false, reason: 'details-unavailable' });
    assert.equal(decide(bridge, f, view, 'rejected').accepted, true); assert.equal(await result, 'rejected'); bridge.dispose();
  }
});

for (const transition of ['abort', 'turn', 'agent', 'finish', 'expiry', 'policy', 'disconnect', 'dispose']) {
  test(`approval cannot survive ${transition} or revive through a late response`, async () => {
    const f = fixture(), bridge = createAssistantApprovalBridge({ ...f.options, enabled: true, policyOf: f.policyOf, requestTimeoutMs: 50 });
    const abort = new AbortController(), result = f.emit({ signal: abort.signal }), view = firstApproval(bridge, f);
    if (transition === 'abort') abort.abort();
    if (transition === 'turn') f.advance();
    if (transition === 'agent') f.replaceAgent();
    if (transition === 'finish') f.finish();
    if (transition === 'expiry') f.tick(1050);
    if (transition === 'policy') f.setPolicy('never');
    if (transition === 'disconnect') bridge.disconnect(f.sessionId);
    if (transition === 'dispose') bridge.dispose();
    assert.deepEqual(decide(bridge, f, view), { accepted: false, reason: 'request-stale' });
    assert.notEqual(await result, 'allowed-once'); bridge.dispose();
  });
}

test('never policy fails closed even if a caller enables the bridge; foreign requests delegate', async () => {
  const f = fixture(), bridge = createAssistantApprovalBridge({ ...f.options, enabled: true });
  assert.equal(await f.emit(), 'rejected'); assert.deepEqual(bridge.snapshot(f.sessionId).pending, []);
  assert.equal(bridge.snapshot(f.sessionId).capabilities.reason, 'policy-never');
  assert.equal(await f.emit({ agent: { session: { id: 'foreign' } } }, () => 'delegated'), 'delegated');
  bridge.dispose();
});

test('a pending native never override wins even when the composition policy callback is stale', async () => {
  const f = fixture(); let nativePolicy;
  f.services.approval.overrideOf = () => nativePolicy;
  const bridge = createAssistantApprovalBridge({ ...f.options, enabled: true, policyOf: () => 'ask' });
  const result = f.emit(), view = firstApproval(bridge, f);
  nativePolicy = 'never';
  assert.deepEqual(decide(bridge, f, view), { accepted: false, reason: 'request-stale' });
  assert.equal(await result, 'rejected'); assert.equal(bridge.snapshot(f.sessionId).capabilities.interactive, false);
  bridge.dispose();
});

test('missing native identity service does not pretend a live bridge exists', () => {
  const f = fixture(); delete f.services.sessionProjections;
  const bridge = createAssistantApprovalBridge({ ...f.options, enabled: true, policyOf: f.policyOf });
  assert.equal(bridge.snapshot(f.sessionId).capabilities.reason, 'native-services-unavailable');
  assert.equal(f.listeners.size, 0); bridge.dispose();
});

test('fresh bridge generations never restore pending audit records', async () => {
  const f = fixture(), first = createAssistantApprovalBridge({ ...f.options, enabled: true, policyOf: f.policyOf });
  const result = f.emit(), old = firstApproval(first, f); first.dispose(); assert.equal(await result, 'unavailable');
  const second = createAssistantApprovalBridge({ ...f.options, enabled: true, policyOf: f.policyOf });
  assert.deepEqual(second.snapshot(f.sessionId).pending, []);
  assert.deepEqual(decide(second, f, old), { accepted: false, reason: 'request-stale' }); second.dispose();
});

test('production handoff without an executor cannot offer, validate, or execute', async () => {
  const f = fixture(), handoff = createAssistantLocalHandoff(f.options);
  assert.deepEqual(handoff.capabilities(), { supported: false, mode: 'unavailable', reason: 'executor-unavailable', executesLocally: false });
  assert.deepEqual(handoff.offer(f.sessionId, action), { accepted: false, reason: 'executor-unavailable' });
  assert.deepEqual(handoff.validate(f.sessionId, { requestId: 'old' }), { accepted: false, reason: 'offer-stale' });
  assert.deepEqual(await handoff.execute(f.sessionId, { approved: true }), { accepted: false, reason: 'executor-unavailable' });
  assert.throws(() => createAssistantLocalHandoff({ ...f.options, executor: { kind: 'local', execute() {} } }), /simulation/);
  handoff.dispose();
});

test('simulation requires trusted explicit confirmation and reports no local action was executed', async () => {
  const f = fixture(), executor = createSimulatedLocalExecutor(); let confirmation;
  const handoff = createAssistantLocalHandoff({ ...f.options, executor, requestConfirmation: async offer => { confirmation = offer; return 'allowed-once'; } });
  const { offer } = handoff.offer(f.sessionId, action);
  assert.deepEqual(handoff.validate(f.sessionId, offer), { accepted: true, offer });
  assert.equal(handoff.capabilities().executesLocally, false);
  const result = await handoff.execute(f.sessionId, { ...offer, action: { kind: 'shell', command: 'untrusted' }, approved: true });
  assert.equal(confirmation, offer); assert.deepEqual(confirmation.action, action);
  assert.equal(result.status, 'simulated'); assert.equal(result.receipt.executed, false);
  assert.equal(executor.calls().length, 1);
  assert.deepEqual(await handoff.execute(f.sessionId, offer), { accepted: false, reason: 'offer-stale' }); handoff.dispose();
});

test('handoff rejects unsolicited permissions, credentials, absolute paths, traversal, and unbounded reads', () => {
  const f = fixture(), handoff = createAssistantLocalHandoff({ ...f.options, executor: createSimulatedLocalExecutor(), requestConfirmation: async () => 'allowed-once' });
  for (const invalid of [{ ...action, kind: 'shell' }, { ...action, token: 'must-not-transmit' }, { ...action, path: '/etc/passwd' },
    { ...action, path: '../private' }, { ...action, path: 'nested/../private' }, { ...action, path: 'C:\\private' },
    { ...action, path: 'https://example.invalid/' }, { ...action, maxBytes: Infinity }, { ...action, maxBytes: 2 ** 21 }]) {
    assert.throws(() => handoff.offer(f.sessionId, invalid), { code: 'ASSISTANT_HANDOFF_ACTION_INVALID' });
  }
  handoff.dispose();
});

test('JSON approval cannot replace a missing trusted confirmer or an explicit rejection', async () => {
  const f = fixture(), executor = createSimulatedLocalExecutor(), missing = createAssistantLocalHandoff({ ...f.options, executor });
  assert.equal(missing.capabilities().reason, 'confirmation-unavailable'); missing.dispose();
  const denied = createAssistantLocalHandoff({ ...f.options, executor, requestConfirmation: async () => 'rejected' });
  const { offer } = denied.offer(f.sessionId, action);
  assert.deepEqual(await denied.execute(f.sessionId, { ...offer, approved: true }), { accepted: false, reason: 'rejected' });
  assert.equal(executor.calls().length, 0); denied.dispose();
});

test('handoff checks the exact target and action fingerprint before requesting confirmation', async () => {
  const f = fixture(), executor = createSimulatedLocalExecutor(); let confirmations = 0;
  const handoff = createAssistantLocalHandoff({ ...f.options, executor, requestConfirmation: async () => { confirmations++; return 'allowed-once'; } });
  const { offer } = handoff.offer(f.sessionId, action);
  for (const change of [{ hostId: 'other' }, { sessionId: 'other' }, { turn: 3 }, { turnStartSeq: 2 }, { generation: 'old' },
    { targetExecutorId: 'different-computer' }, { targetGeneration: 2 }, { actionDigest: 'different' }]) {
    assert.deepEqual(await handoff.execute(f.sessionId, { ...offer, ...change }), { accepted: false, reason: 'offer-stale' });
  }
  assert.deepEqual(await handoff.execute('other', offer), { accepted: false, reason: 'offer-stale' });
  assert.equal(confirmations, 0); assert.equal(executor.calls().length, 0); handoff.dispose();
});

for (const transition of ['turn', 'agent', 'finish', 'expiry', 'reconnect', 'cancel', 'dispose']) {
  test(`permission pending during ${transition} never reaches the simulated executor`, async () => {
    const f = fixture(), executor = createSimulatedLocalExecutor(); let answer;
    const handoff = createAssistantLocalHandoff({ ...f.options, executor, offerTimeoutMs: 50,
      requestConfirmation: () => new Promise(resolve => { answer = resolve; }) });
    const { offer } = handoff.offer(f.sessionId, action), result = handoff.execute(f.sessionId, offer);
    await Promise.resolve();
    assert.deepEqual(await handoff.execute(f.sessionId, offer), { accepted: false, reason: 'already-started' });
    if (transition === 'turn') f.advance();
    if (transition === 'agent') f.replaceAgent();
    if (transition === 'finish') f.finish();
    if (transition === 'expiry') f.tick(1050);
    if (transition === 'reconnect') { executor.disconnect(); executor.reconnect(); }
    if (transition === 'cancel') handoff.cancel(f.sessionId, offer.requestId);
    if (transition === 'dispose') handoff.dispose();
    answer('allowed-once');
    assert.equal((await result).accepted, false); assert.equal(executor.calls().length, 0); handoff.dispose();
  });
}

test('unconfirmed execution failures are retired rather than replayed', async () => {
  const f = fixture(), simulated = createSimulatedLocalExecutor(); let attempts = 0;
  const executor = { ...simulated, execute: async () => { attempts++; throw new Error('transport ended'); } };
  const handoff = createAssistantLocalHandoff({ ...f.options, executor, requestConfirmation: async () => 'allowed-once' });
  const { offer } = handoff.offer(f.sessionId, action);
  assert.deepEqual(await handoff.execute(f.sessionId, offer), { accepted: false, reason: 'execution-unconfirmed' });
  assert.deepEqual(await handoff.execute(f.sessionId, offer), { accepted: false, reason: 'offer-stale' });
  assert.equal(attempts, 1); handoff.dispose();
});

function runtimeFixture({ interactive = false } = {}) {
  const sessionId = `assistant-${createHash('sha256').update(JSON.stringify(['a', 'b', 'personal'])).digest('hex').slice(0, 40)}`;
  const f = fixture(sessionId), cleanup = [], permissions = [], policies = [];
  f.options.ctx.effect = factory => { cleanup.push(factory()); return () => {}; };
  f.services.sessionController = {
    projections: async () => ({ asOfSeq: 0 }),
    page: async () => ({ records: [{ type: 'event', event: { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } } }], hasMore: false }),
    resolveAgent: async id => ({ agent: f.services.agents.get(id) }),
    prompt: async () => {},
  };
  f.services.agents.withoutInitiator = operation => operation();
  f.services.commands = { execute: async (_agent, permission) => { permissions.push(permission); return {}; } };
  f.services.approval.setPolicy = (_agent, policy) => { policies.push(policy); f.setPolicy(policy); };
  f.services.sessions = { flush: async () => true };
  const bridge = interactive ? createAssistantApprovalBridge({ ...f.options, enabled: true, policyOf: f.policyOf }) : undefined;
  const runtime = createPersonalAssistantRuntime({ ctx: f.options.ctx, agentId: 'a', buildId: 'b',
    frozen: { spec: { runtime: { type: 'dsh-native' } } }, admit: async () => ({ presetId: 'test' }),
    approvalBridge: bridge, retirement: async work => { await work(); return { closed: true }; } });
  return { ...f, runtime, bridge, permissions, policies, dispose: () => { for (const dispose of cleanup) dispose(); } };
}

test('runtime advertises the bridge contract but keeps native composer, approval and local execution unavailable', async () => {
  const f = runtimeFixture(), snapshot = await f.runtime('snapshot');
  assert.equal(f.runtime.approvalBridgeSupported, true);
  assert.deepEqual(snapshot.pendingInteractions, []);
  assert.deepEqual(snapshot.capabilities.approval, { interactive: false, reason: 'disabled' });
  assert.deepEqual(snapshot.capabilities.composer, cloudAssistantComposerCapability);
  assert.equal(snapshot.capabilities.localHandoff, false);
  assert.equal(snapshot.capabilities.localHandoffDetails.reason, 'executor-unavailable');
  assert.equal(snapshot.capabilities.execution.permission, 'read-only'); assert.equal(snapshot.capabilities.execution.approval, 'never');
  await f.runtime('submit', { requestId: 'test-submit', text: 'Keep existing confinement.' });
  assert.deepEqual(f.permissions, ['/permission read-only']); assert.deepEqual(f.policies, ['never']);
  assert.deepEqual(await f.runtime('approval-decide', { requestId: 'old-history-approval', decision: 'allowed-once' }), { accepted: false, reason: 'request-stale' });
  f.dispose();
});

test('runtime exposes only live injected questions and derives the decision Session from its own conversation mapping', async () => {
  const f = runtimeFixture({ interactive: true }), result = f.emit();
  const view = (await f.runtime('snapshot')).pendingInteractions[0];
  assert.equal(view.sessionId, f.sessionId);
  assert.deepEqual(await f.runtime('approval-decide', { ...view, conversation: 'different', decision: 'allowed-once' }), { accepted: false, reason: 'request-stale' });
  assert.deepEqual(await f.runtime('approval-decide', { ...view, decision: 'allowed-once' }), { accepted: true, outcome: 'allowed-once' });
  assert.equal(await result, 'allowed-once'); assert.deepEqual(f.policies, []);
  f.dispose();
});

for (const ending of ['close', 'context-dispose']) {
  test(`runtime ${ending} withdraws pending interactions without granting or reviving them`, async () => {
    const f = runtimeFixture({ interactive: true }), result = f.emit();
    const view = (await f.runtime('snapshot')).pendingInteractions[0];
    if (ending === 'close') assert.deepEqual(await f.runtime('close'), { closed: true });
    else f.dispose();
    assert.equal(await result, 'unavailable');
    assert.deepEqual(f.bridge.decide(f.sessionId, { ...view, decision: 'allowed-once' }), { accepted: false, reason: 'request-stale' });
    f.dispose();
  });
}

test('live cloud presence gates both creation and late approval without becoming an authorization', async () => {
  const f = fixture(); let online = false;
  const bridge = createAssistantApprovalBridge({ ...f.options, enabled: true, policyOf: f.policyOf,
    isConnected: id => id === f.sessionId && online });
  assert.equal(await f.emit(), 'unavailable');
  assert.equal(bridge.snapshot(f.sessionId).capabilities.reason, 'offline');
  assert.deepEqual(bridge.snapshot(f.sessionId).pending, []);
  online = true;
  const result = f.emit(), view = firstApproval(bridge, f);
  assert.equal(bridge.snapshot(f.sessionId).capabilities.interactive, true);
  assert.equal(firstApproval(bridge, f).requestId, view.requestId, 'presence alone never approves a pending action');
  online = false;
  assert.deepEqual(decide(bridge, f, view), { accepted: false, reason: 'request-stale' });
  assert.equal(await result, 'unavailable');
  online = true;
  assert.deepEqual(decide(bridge, f, view), { accepted: false, reason: 'request-stale' });
  assert.deepEqual(bridge.snapshot(f.sessionId).pending, []);
  bridge.dispose();
});
