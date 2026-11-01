// Lifecycle doubles exercise refusal/abort/race boundaries; the mounted Host
// verifier separately exercises the real Agent, projections and approval log.
import test from 'node:test';
import assert from 'node:assert/strict';
import { requestStudioA2aApproval } from '../src/host/services/a2a-control-approval.mjs';
function fixture({ open = false } = {}) {
  const log = [], abort = new AbortController();
  const auditObservers = new Set();
  let boundary = { lastTurn: open ? 1 : 0, openTurnStartSeq: open ? 0 : null }, pending = null, busy = false;
  let decide = async () => 'allowed-once', durable = async () => true, asks = 0, flushes = 0;
  const agent = { session: { id: 'session' } };
  const executeTurn = async (owner, execute) => {
    assert.equal(busy, false); busy = true;
    try { const result = await execute({ ownership: owner, turn: owner.turn, signal: abort.signal });
      log.push(['end', result.reason.kind]); pending = null; boundary.openTurnStartSeq = null; return result;
    } finally { busy = false; }
  };
  agent.externalTurns = { contract: 'dsh.external-turn-host/v1', idleAdmissionContract: 'dsh.external-turn-start/v1', pending: () => pending,
    start: async (prepare, execute) => {
      assert.equal(busy, false); assert.equal(boundary.openTurnStartSeq, null); boundary = { lastTurn: boundary.lastTurn + 1, openTurnStartSeq: log.length };
      log.push(['start']); pending = await prepare({ turn: boundary.lastTurn, signal: abort.signal }); log.push(['owner', pending.engine]);
      return executeTurn(pending, execute);
    },
    resume: async (engine, execute) => { assert.equal(pending.engine, engine); log.push(['resume']); return executeTurn(pending, execute); },
  };
  const services = { sessionProjections: { stateOf: () => ({ ...boundary }) },
    sessions: { flush: async () => { flushes++; log.push(['flush']); return durable(); } },
    approval: { request: async req => { asks++; log.push(['ask']); assert.equal(req.agent, agent); return decide(req); } } };
  const ctx = { get: key => services[key], on(name, fn) {
    assert.equal(name, 'session/event'); auditObservers.add(fn); return () => auditObservers.delete(fn);
  } };
  const request = (signal, requireReceipt = false) => requestStudioA2aApproval({ ctx, agent, presetId: 'preset', assertCurrent: () => true, requireReceipt,
    request: { agent, toolName: 'a2a_continue_task', callId: 'exact-command', signal: signal ?? new AbortController().signal } });
  return { agent, log, request, abort, services, counts: () => ({ asks, flushes }), decide: value => { decide = value; },
    audit: (event, source = agent.session) => { for (const observer of auditObservers) observer(source, event); },
    observers: () => auditObservers.size,
    durable: value => { durable = value; }, boundary: value => { boundary = value; }, pending: value => { pending = value; } };
}
test('idle approval owns and durably closes a real lifecycle before returning a grant', async () => {
  const f = fixture(); assert.equal(await f.request(), 'allowed-once');
  assert.deepEqual(f.log.map(row => row[0]), ['start', 'owner', 'flush', 'ask', 'flush', 'end', 'flush']);
  assert.equal(f.agent.externalTurns.pending(), null);
});
test('an interrupted approval owner asks fresh consent when explicitly recovered', async () => {
  const f = fixture(); f.boundary({ lastTurn: 4, openTurnStartSeq: 10 });
  f.pending({ contract: 'dsh.external-turn/v1', turn: 4, engine: 'agentkit.a2a-human-control/v1',
    binding: JSON.stringify({ contract: 'agentkit.a2a-human-control/v1', presetId: 'preset', sessionId: 'session' }) });
  assert.equal(await f.request(), 'allowed-once'); assert.equal(f.counts().asks, 1);
  assert.deepEqual(f.log.map(row => row[0]), ['resume', 'flush', 'ask', 'flush', 'end', 'flush']);
});
test('a recovered approval cannot adopt another preset owner', async () => {
  const f = fixture(); f.boundary({ lastTurn: 4, openTurnStartSeq: 10 });
  f.pending({ turn: 4, engine: 'agentkit.a2a-human-control/v1', binding: 'different-preset' });
  await assert.rejects(f.request(), /STUDIO_A2A_APPROVAL_OWNER_CHANGED/); assert.equal(f.counts().asks, 0);
});
test('an active original turn is borrowed without closing or replacing its owner', async () => {
  const f = fixture({ open: true }); assert.equal(await f.request(), 'allowed-once');
  assert.deepEqual(f.log.map(row => row[0]), ['ask', 'flush']);
});
test('a borrowed turn closing during consent discards its grant before effects', async () => {
  const f = fixture({ open: true }); f.decide(async () => { f.boundary({ lastTurn: 1, openTurnStartSeq: null }); return 'allowed-once'; });
  await assert.rejects(f.request(), /STUDIO_A2A_APPROVAL_TURN_CHANGED/); assert.equal(f.counts().flushes, 0);
});
test('ownership or audit flush failure cannot return a grant', async () => {
  for (const failAt of [1, 2, 3]) {
    const f = fixture(); let count = 0; f.durable(async () => ++count !== failAt);
    await assert.rejects(f.request(), /STUDIO_A2A_APPROVAL_NOT_DURABLE/);
    assert.equal(f.counts().asks, failAt === 1 ? 0 : 1);
  }
});
test('denial commits its owned ending and never becomes a grant', async () => {
  const f = fixture(); f.decide(async () => 'rejected'); assert.equal(await f.request(), 'rejected');
  assert.equal(f.agent.externalTurns.pending(), null); assert.deepEqual(f.log.at(-1), ['flush']);
});
test('Agent cancellation aborts an uncooperative answerer and discards a late grant', async () => {
  const f = fixture(); let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  f.decide(() => { entered(); return new Promise(resolve => { release = resolve; }); });
  const running = f.request(); await waiting; f.abort.abort(Error('agent-stopped'));
  await assert.rejects(running, /agent-stopped/); release('allowed-once'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.counts().asks, 1); assert.equal(f.agent.externalTurns.pending(), null);
});
test('a receipt requires the exact committed ask/decision pair; phantom and foreign audits fail closed', async () => {
  for (const mode of ['missing', 'foreign-session', 'foreign-call', 'foreign-id', 'duplicate', 'wrong-outcome']) {
    const f = fixture({ open: true });
    f.decide(async () => {
      const source = mode === 'foreign-session' ? { id: 'session' } : f.agent.session;
      const asked = { type: 'approval/asked', seq: 0,
        data: { id: 'real-request', toolName: 'a2a_continue_task', callId: mode === 'foreign-call' ? 'different' : 'exact-command' } };
      if (mode !== 'missing') {
        f.audit(asked, source); if (mode === 'duplicate') f.audit(asked, source);
        f.audit({ type: 'approval/decided', seq: 1, data: { id: mode === 'foreign-id' ? 'different' : 'real-request',
          outcome: mode === 'wrong-outcome' ? 'rejected' : 'allowed-once' } }, source);
      }
      return 'allowed-once';
    });
    await assert.rejects(f.request(undefined, true), { code: 'STUDIO_A2A_APPROVAL_AUDIT_MISMATCH' }); assert.equal(f.observers(), 0);
  }
});
test('a live audit receipt includes physical seq zero and survives only a successful durability barrier', async () => {
  const f = fixture({ open: true });
  f.decide(async () => {
    f.audit({ type: 'approval/asked', seq: 0, data: { id: 'real-request', toolName: 'a2a_continue_task', callId: 'exact-command' } });
    f.audit({ type: 'approval/decided', seq: 1, data: { id: 'real-request', outcome: 'allowed-once' } }); return 'allowed-once';
  });
  const result = await f.request(undefined, true); assert.equal(result.receipt.askedSeq, 0);
  assert.equal(result.receipt.requestId, 'real-request'); assert.equal(result.receipt.decidedSeq, 1); assert.equal(f.observers(), 0);
  f.durable(async () => false); await assert.rejects(f.request(undefined, true), { code: 'STUDIO_A2A_APPROVAL_NOT_DURABLE' });
  assert.equal(f.observers(), 0);
});
