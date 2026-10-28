import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeToolOutcomeFact } from '../src/native/session-delivery.mjs';

test('opaque execution identities retain their original Run while a validated SDK turn positions unknown outcomes', () => {
  const identity = { scope: { tenantId: 'tenant', workspaceId: 'workspace', userId: 'user', agentId: 'agent' },
    runId: 'managed-native-run', sessionId: 'sdk-session', turnId: 'submission-opaque-uuid' };
  const before = structuredClone(identity), fact = nativeToolOutcomeFact(identity, 'original-call', 'uncertain', 7);
  assert.equal(fact.turn, 7); assert.equal(fact.runId, identity.runId); assert.equal(fact.sessionId, identity.sessionId);
  assert.equal(fact.status, 'uncertain'); assert.match(fact.callId, /^ak-native-[a-f0-9]{64}$/);
  assert.deepEqual(identity, before);
  assert.throws(() => nativeToolOutcomeFact(identity, 'original-call', 'uncertain'), { code: 'native_tool_outcome_identity_invalid' });
  for (const turn of [0, -1, 1.5, '7', null])
    assert.throws(() => nativeToolOutcomeFact(identity, 'original-call', 'uncertain', turn), { code: 'native_tool_outcome_identity_invalid' });
});
