import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeChildObservationCache, nativeChildObservation } from '../packages/agentkit-harness-node/src/native/child-observation.mjs';
const scope = { tenantId: 't', workspaceId: 'w', userId: 'u', agentId: 'a' };
const record = () => ({ fence: 2, lease: { expiresAt: Date.now() + 5000 },
  configuration: { profile: { providerThinkingDisplayPolicy: 'provider-visible/v1' } },
  snapshot: { scope, runId: 'r', sessionId: 's', revision: 2, pendingIntent: 'model', goal: 'Read source', phase: 'requesting_model',
    messages: [{ role: 'system', content: 'private system prompt' }, { role: 'assistant', content: 'Read source', toolCalls: [{ callId: 'read', name: 'read', arguments: { path: 'a.mjs' } }], providerReplay: { private: 'signature' } },
      { role: 'tool', callId: 'read', content: 'actual returned output', toolOutcome: 'error' }] },
  events: [{ kind: 'model.completed', payload: { messageIndex: 1, text: 'Read source', displayStream: { records: [{ event: { kind: 'thinking', text: 'Actual public reasoning' } }] } } }],
  intents: [{ operationKey: 'tool', kind: 'tool', payload: { calls: [{ callId: 'read' }] } }],
  receipts: [{ operationKey: 'tool', status: 'committed', result: { results: [{ status: 'error' }] } }] });
test('child observations expose public reasoning and exact receipt status without system or replay data', () => {
  const r = record(), observed = nativeChildObservation(r);
  assert.equal(observed.rows[0].text, 'Actual public reasoning');
  assert.equal(observed.rows.at(-1).status, 'failed'); assert.equal(observed.rows.at(-1).result.text, 'actual returned output');
  assert.doesNotMatch(JSON.stringify(observed), /private system|signature|providerReplay/);
  r.configuration.profile.providerThinkingDisplayPolicy = undefined;
  assert.equal(nativeChildObservation(r).rows.some(row => row.kind === 'thought'), false);
});
test('ephemeral child text is fence-bound, bounded, and vanishes when its result commits', () => {
  const cache = createNativeChildObservationCache({ maxChars: 4 }), r = record();
  const context = { scope, runId: 'r', operationKey: 'model', executionFence: 2, signal: new AbortController().signal };
  cache.accept(context, { event: { kind: 'text', text: 'abcdef' } });
  assert.equal(cache.read(r).text, 'abcd'); assert.equal(cache.read(r).omittedChars, 2);
  r.fence = 3; assert.equal(cache.read(r), null); r.fence = 2;
  r.receipts.push({ operationKey: 'model', status: 'committed' }); assert.equal(cache.read(r), null);
  cache.clear(); assert.equal(cache.read(record()), null);
});
