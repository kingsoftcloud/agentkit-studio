import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionRoutes } from './fixtures/retired-session-routes.mjs';

test('Studio Native approval RPC exposes a scoped status and decision operation', async () => {
  const calls = [];
  const route = createSessionRoutes({ getNativeHost: async () => ({
    nativeApprovalStatus: input => { calls.push(['status', input]); return { contract: 'agentkit.studio-native-approval/v1', pending: [] }; },
    nativeApprovalDecision: input => { calls.push(['decision', input]); return { accepted: true, outcome: 'allowed-once' }; },
  }) });
  assert.deepEqual((await route('sessions/native-approval-status', { agentId: 'agent', sessionId: 'session' })).value.pending, []);
  assert.deepEqual((await route('sessions/native-approval-decision', {
    agentId: 'agent', sessionId: 'session', runId: 'run', interactionId: 'run:approval', requestId: 'native-appr-1',
    expectedGeneration: 'generation', decision: 'allow',
  })).value, { accepted: true, outcome: 'allowed-once' });
  assert.deepEqual(calls, [
    ['status', { agentId: 'agent', sessionId: 'session' }],
    ['decision', { agentId: 'agent', sessionId: 'session', runId: 'run', interactionId: 'run:approval', requestId: 'native-appr-1', expectedGeneration: 'generation', decision: 'allow' }],
  ]);
});

test('Studio Native approval RPC rejects malformed or forged input before loading Host', async () => {
  let loaded = 0;
  const route = createSessionRoutes({ getNativeHost: async () => { loaded++; throw Error('must not load'); } });
  for (const payload of [{}, { agentId: 'agent', sessionId: 'session', decision: 'allow' },
    { agentId: 'agent', sessionId: 'session', runId: 'run', interactionId: 'i', requestId: 'r', expectedGeneration: 'g', decision: 'maybe' }]) {
    const endpoint = payload.decision === 'maybe' ? 'sessions/native-approval-decision' : 'sessions/native-approval-status';
    await assert.rejects(route(endpoint, payload), error => error.code === 'STUDIO_NATIVE_APPROVAL_STATUS_INVALID'
      || error.code === 'STUDIO_NATIVE_APPROVAL_DECISION_INVALID');
  }
  assert.equal(loaded, 0);
});
