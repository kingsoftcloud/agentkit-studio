import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeSessionToolOutcomes } from '../src/host/services/native-session-tool-outcomes.mjs';
const scope = { tenantId: 't', workspaceId: 'w', userId: 'u', agentId: 'a' };
const record = (runId, turnId, projections = {}) => ({ snapshot: { scope, runId, turnId }, projections });
const fact = (runId, turnId) => ({ runId, turnId, callId: 'call' });
test('an opaque execution turn uses its own committed SDK presentation position', () => {
  const old = record('old', 'wake-id', { ['dsh:s:7:v1:' + 'a'.repeat(64)]: {} });
  const current = record('current', '2');
  const store = { uncertainToolCalls: () => [fact('old', 'wake-id'), fact('current', '2')],
    load: (givenScope, runId) => { assert.deepEqual(givenScope, scope); assert.equal(runId, 'old'); return old; } };
  const value = nativeSessionToolOutcomes(store, current, 's', 9);
  assert.deepEqual(value.facts.map(f => [f.runId, f.turn, f.status]), [['old', 7, 'uncertain'], ['current', 9, 'uncertain']]);
  assert.equal(value.unmappedCount, 0);
});
test('unknown standalone results stay unknown without a fabricated SDK turn or a failed status view', () => {
  const current = record('current', 'standalone-turn');
  const store = { uncertainToolCalls: () => [fact('current', 'standalone-turn')] };
  const value = nativeSessionToolOutcomes(store, current, 's');
  assert.deepEqual(value.facts, []); assert.equal(value.unmappedCount, 1);
  assert.equal(current.snapshot.turnId, 'standalone-turn');
});
test('another session projection cannot provide presentation authority', () => {
  const current = record('current', 'wake', { ['dsh:foreign:3:v1:' + 'a'.repeat(64)]: {} });
  assert.equal(nativeSessionToolOutcomes({ uncertainToolCalls: () => [fact('current', 'wake')] }, current, 's').unmappedCount, 1);
});

test('historical unknown results read only their scoped delivery positions once per Run', () => {
  const current = record('current', '2'); let reads = 0;
  const store = { uncertainToolCalls: () => [fact('old', 'wake'), { ...fact('old', 'wake'), callId: 'second' }],
    load: () => assert.fail('status cannot hydrate historical receipts'),
    projectionCursors: (given, runId) => {
      assert.deepEqual(given, scope); assert.equal(runId, 'old'); reads++;
      return { ['dsh:s:7:v1:' + 'a'.repeat(64)]: 100, ['dsh:foreign:9:v1:' + 'b'.repeat(64)]: 200 };
    } };
  const value = nativeSessionToolOutcomes(store, current, 's', 2);
  assert.equal(reads, 1); assert.equal(value.unmappedCount, 0);
  assert.deepEqual(value.facts.map(fact => [fact.turn, fact.status]), [[7, 'uncertain'], [7, 'uncertain']]);
});

test('the generic scoped outcome reader carries non-dispatch facts without conflating them with uncertainty', () => {
  const current = record('current', '2');
  const store = { sessionToolOutcomes: (given, sessionId) => {
    assert.deepEqual(given, scope);assert.equal(sessionId, 's');
    return [{ ...fact('current', '2'), status: 'not_dispatched' }];
  }, uncertainToolCalls: () => assert.fail('the legacy reader is a fallback only') };
  const value = nativeSessionToolOutcomes(store, current, 's', 2);
  assert.equal(value.facts[0].status, 'not_dispatched');assert.equal(value.facts[0].turn, 2);
});
