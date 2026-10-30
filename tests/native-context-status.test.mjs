import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeContextStatus } from '../packages/agentkit-harness-node/src/native/context-status.mjs';
const record = () => ({ configuration: { contextPolicy: { enabled: true, triggerRatio: .72, targetRatio: .45 },
  profile: { contextWindow: 10000, maxOutputTokens: 1000 } },
  snapshot: { runId: 'r', revision: 7, phase: 'compacting', contextState: { compactions: 1, compaction: { proposal: 'private summary' } },
    usage: { inputTokens: 500000 }, messages: [{ content: 'private message' }] },
  events: [{ kind: 'context.planned', seq: 1, payload: { action: 'ready', admission: { countedInputTokens: 6000, sourceDigest: 'private hash' } } },
    { kind: 'context.summary_completed', seq: 2, payload: { proposalAvailable: true } }] });
test('context quote uses the last admitted input, never cumulative usage or an unadopted summary', () => {
  const r = record(); const value = nativeContextStatus(r, { driving: true });
  assert.equal(value.lastRequestInputTokens, 6000); assert.equal(value.compactions, 1); assert.equal(value.state, 'compacting');
  assert.equal(value.lastAdmissionSeq, 1);
  assert.doesNotMatch(JSON.stringify(value), /private|500000|proposal|messages/);
  assert.equal(nativeContextStatus(r).state, 'interrupted');
  r.snapshot.phase = 'completed'; r.snapshot.contextState = { compactions: 2, compaction: null };
  r.events.push({ kind: 'context.planned', seq: 3, payload: { action: 'ready', admission: { countedInputTokens: 2000 } } });
  assert.equal(nativeContextStatus(r).compactions, 2); assert.equal(nativeContextStatus(r).lastRequestInputTokens, 2000);
});
test('legacy or unmeasured runs stay unknown, not zero input', () => {
  assert.equal(nativeContextStatus(null), null);
  const r = record(); delete r.configuration.contextPolicy; assert.equal(nativeContextStatus(r), null);
  r.configuration.contextPolicy = { enabled: false }; r.events = []; r.snapshot.contextState = null;
  assert.equal(nativeContextStatus(r).lastRequestInputTokens, null);
});
