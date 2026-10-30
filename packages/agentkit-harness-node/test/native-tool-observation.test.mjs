import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceNativeToolObservation, nativeObservedToolStates } from '../src/native/tool-observation.mjs';

const call = { callId: 'original', name: 'write', arguments: { private: 'PRIVATE_ARGUMENT' } };
const intent = (operationKey, status) => ({ kind: 'tool', operationKey, status, payload: { calls: [call] } });
const receipt = (operationKey, status) => ({ operationKey, status: 'committed', result: { results: [
  { status, content: { private: 'PRIVATE_RESULT' } }] } });
const prepared = (seq, operationKey) => ({ seq, kind: 'effect.prepared', payload: { kind: 'tool', operationKey } });
const completed = (seq, status) => ({ seq, kind: 'tool.completed', payload: { callId: call.callId, status } });
const observe = (record, phase = 'canceled') => nativeObservedToolStates(advanceNativeToolObservation(null, record), { phase });

test('closed preflight evidence is undispatched, while a later claimed attempt remains unknown', () => {
  const original = { intents: [intent('approval', 'running')], receipts: [receipt('approval', 'approval_required')], events: [prepared(1, 'approval')] };
  assert.deepEqual(observe(original, 'awaiting_interaction'), [{ callId: call.callId, status: 'waiting' }]);
  assert.deepEqual(observe(original), [{ callId: call.callId, status: 'not_dispatched' }]);
  const later = { ...original, intents: [...original.intents, intent('later', 'running')], events: [...original.events, prepared(3, 'later')] };
  assert.deepEqual(observe(later), [{ callId: call.callId, status: 'uncertain' }]);
  assert.doesNotMatch(JSON.stringify(advanceNativeToolObservation(null, later)), /PRIVATE_ARGUMENT|PRIVATE_RESULT|write/);
  const retired = { ...original, receipts: [{ operationKey: 'approval', status: 'not_dispatched', result: {} }] };
  assert.deepEqual(observe({ ...later, receipts: retired.receipts }), [{ callId: call.callId, status: 'uncertain' }]);
});

test('an old completion cannot hide a later claim; exact receipt reconciliation can resolve it', () => {
  const record = { intents: [intent('first', 'running'), intent('second', 'running')],
    receipts: [receipt('first', 'ok')], events: [prepared(1, 'first'), completed(2, 'ok'), prepared(3, 'second')] };
  assert.deepEqual(observe(record), [{ callId: call.callId, status: 'uncertain' }]);
  record.intents.push({ kind: 'tool_receipt', operationKey: 'query', payload: { originalOperationKey: 'second', callId: call.callId } });
  record.receipts.push({ operationKey: 'query', status: 'committed', result: { result: { status: 'ok', content: 'PRIVATE_QUERY_RESULT' } } });
  assert.deepEqual(observe(record), [{ callId: call.callId, status: 'completed' }]);
  record.events.push({ seq: 4, kind: 'tool.not_dispatched', payload: { callId: call.callId } });
  assert.deepEqual(observe(record), [{ callId: call.callId, status: 'not_dispatched' }]);
});

test('incremental tool evidence matches full replay across prepare, claim, approval, retry and terminal boundaries', () => {
  const stages = [
    { intents: [intent('first', 'prepared')], receipts: [], events: [prepared(1, 'first')], phase: 'executing_tools' },
    { intents: [intent('first', 'running')], receipts: [], events: [], phase: 'executing_tools' },
    { intents: [], receipts: [receipt('first', 'approval_required')], events: [], phase: 'awaiting_interaction' },
    { intents: [intent('later', 'prepared')], receipts: [], events: [prepared(3, 'later')], phase: 'executing_tools' },
    { intents: [intent('later', 'running')], receipts: [], events: [], phase: 'executing_tools' },
    { intents: [], receipts: [], events: [], phase: 'canceled' },
  ];
  let partial = null;const full = { intents: [], receipts: [], events: [] };
  for (const stage of stages) {
    for (const value of stage.intents) { const index = full.intents.findIndex(old => old.operationKey === value.operationKey);
      if (index < 0) full.intents.push(value); else full.intents[index] = value; }
    full.receipts.push(...stage.receipts);full.events.push(...stage.events);
    partial = advanceNativeToolObservation(partial, stage);
    assert.deepEqual(partial, advanceNativeToolObservation(null, full));
    assert.deepEqual(nativeObservedToolStates(partial, { phase: stage.phase }), observe(full, stage.phase));
  }
  assert.deepEqual(nativeObservedToolStates(partial, { phase: 'canceled' }), [{ callId: call.callId, status: 'uncertain' }]);
});
