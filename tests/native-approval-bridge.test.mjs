import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeApprovalBridge, STUDIO_NATIVE_APPROVAL_CONTRACT } from '../src/providers/native-approval-bridge.mjs';

function fixture(options = {}) {
  let handler, decisionHandler, released = false, decisionReleased = false;
  const ctx = { on(name, callback) {
    if (name === 'approval/request') { handler = callback; return () => { released = true; }; }
    assert.equal(name, 'approval/decision'); decisionHandler = callback; return () => { decisionReleased = true; };
  } };
  const bridge = createNativeApprovalBridge({ ctx, timeoutMs: options.timeoutMs ?? 5000, now: options.now ?? (() => 1000) });
  const controller = new AbortController();
  const request = (extra = {}) => handler({ signal: controller.signal, ...extra, studioNativeApproval: {
    contract: STUDIO_NATIVE_APPROVAL_CONTRACT, agentId: 'agent', sessionId: 'session', runId: 'run',
    interactionId: 'run:approval', hostInteractionId: 'native-tool', callId: 'call', toolName: 'write_workspace_file',
    reason: 'Native tool write_workspace_file requires approval.', assertCurrent: options.assertCurrent,
  } }, () => Promise.resolve('delegated'));
  return { bridge, request, decide: (value, next = () => Promise.resolve()) => decisionHandler(value, next), controller,
    released: () => released, decisionReleased: () => decisionReleased };
}

test('Native approval bridge publishes an exact live identity and settles one-shot allow', async () => {
  const f = fixture(); const waiting = f.request();
  const view = f.bridge.snapshot({ agentId: 'agent', sessionId: 'session', runId: 'run' });
  assert.equal(view.contract, STUDIO_NATIVE_APPROVAL_CONTRACT);
  assert.equal(view.pending.length, 1);
  assert.deepEqual(view.pending[0].choices, ['allow', 'deny']);
  const decided = f.bridge.decide({ agentId: 'agent', sessionId: 'session', runId: 'run',
    interactionId: 'run:approval', requestId: view.pending[0].requestId, expectedGeneration: view.generation, decision: 'allow' });
  assert.deepEqual(decided, { accepted: true, outcome: 'allowed-once', interactionId: 'run:approval', runId: 'run' });
  assert.equal(await waiting, 'allowed-once');
  assert.equal(f.bridge.snapshot({ agentId: 'agent', sessionId: 'session', runId: 'run' }).pending.length, 0);
  assert.deepEqual(f.bridge.decide({ agentId: 'agent', sessionId: 'session', runId: 'run',
    interactionId: 'run:approval', requestId: view.pending[0].requestId, expectedGeneration: view.generation, decision: 'allow' }),
  { accepted: false, reason: 'request-stale' });
  f.bridge.dispose(); assert.equal(f.released(), true);
  assert.equal(f.decisionReleased(), true);
});

test('Native approval bridge consumes the public DSH decision waterfall identity', async () => {
  const f = fixture(); const waiting = f.request({ requestId: 'dsh-approval-id' });
  const view = f.bridge.snapshot({ agentId: 'agent', sessionId: 'session', runId: 'run' });
  assert.equal(view.pending[0].requestId, 'dsh-approval-id');
  const result = await f.decide({ requestId: view.pending[0].requestId, decision: 'allowed-once' });
  assert.deepEqual(result, { accepted: true, outcome: 'allowed-once' });
  assert.equal(await waiting, 'allowed-once');
  assert.equal(f.bridge.snapshot({ agentId: 'agent', sessionId: 'session', runId: 'run' }).pending.length, 0);
  f.bridge.dispose();
});

test('Native approval bridge rejects stale scope and never grants after authority loss', async () => {
  const f = fixture({ assertCurrent: () => { throw Object.assign(new Error('stale'), { code: 'STALE' }); } });
  const waiting = f.request();
  const view = f.bridge.snapshot({ agentId: 'agent', sessionId: 'session', runId: 'run' });
  assert.throws(() => f.bridge.decide({ agentId: 'agent', sessionId: 'session', runId: 'run',
    interactionId: 'run:approval', requestId: view.pending[0].requestId, expectedGeneration: view.generation, decision: 'later' }),
  { code: 'STUDIO_NATIVE_APPROVAL_DECISION_INVALID' });
  assert.deepEqual(f.bridge.decide({ agentId: 'other', sessionId: 'session', runId: 'run',
    interactionId: 'run:approval', requestId: view.pending[0].requestId, expectedGeneration: view.generation, decision: 'allow' }),
  { accepted: false, reason: 'request-stale' });
  assert.deepEqual(f.bridge.decide({ agentId: 'agent', sessionId: 'session', runId: 'run',
    interactionId: 'run:approval', requestId: view.pending[0].requestId, expectedGeneration: view.generation, decision: 'deny' }),
  { accepted: false, reason: 'request-stale' });
  assert.equal(await waiting, 'cancelled');
  f.bridge.dispose();
});

test('Native approval bridge withdraws pending requests on abort and expiry', async () => {
  let clock = 1000; const f = fixture({ timeoutMs: 1000, now: () => clock });
  const first = f.request(); f.controller.abort(); assert.equal(await first, 'cancelled');
  const g = fixture({ timeoutMs: 1000, now: () => clock }); const second = g.request(); clock = 3000;
  assert.equal(g.bridge.snapshot({ agentId: 'agent', sessionId: 'session', runId: 'run' }).pending.length, 0);
  assert.equal(await second, 'unavailable'); f.bridge.dispose(); g.bridge.dispose();
});
