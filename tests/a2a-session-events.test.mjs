import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical } from '../packages/agentkit-harness-core/dist/index.mjs';
import { A2A_SESSION_CONTRACT, A2A_SESSION_EVENT, a2aSessionProjection } from '../src/host/services/a2a-session-events.mjs';

const sourceKey = 'a'.repeat(64);
function event(sourceSeq = 1, seq = 0, change = {}) {
  const value = { schema_version: 2, event_id: 'event-' + sourceSeq, seq: sourceSeq, timestamp: 1,
    run_id: 'parent', scope_id: 'remote-child', event_type: 'item.started', ...change };
  return { type: A2A_SESSION_EVENT, seq, time: 1, ignorable: true, data: { contract: A2A_SESSION_CONTRACT,
    sourceKey, owner: { kind: 'native', agentId: 'agent', sessionId: 'session' },
    eventId: value.event_id, sourceSeq, eventJson: canonical(value) } };
}
test('independent source sequences share real global positions, duplicate facts retain their first position', () => {
  const fold = a2aSessionProjection(); let state = fold.init();
  state = fold.apply(state, event(1, 0));
  const second = event(1, 4); second.data.sourceKey = 'b'.repeat(64);
  state = fold.apply(state, second); state = fold.apply(state, event(2, 7));
  assert.equal(state.sources[sourceKey].through, 2);
  assert.equal(state.sources[second.data.sourceKey].through, 1);
  assert.equal(state.receipts[sourceKey + ':event-1'].seq, 0);
  assert.equal(state.receipts[sourceKey + ':event-2'].seq, 7);
  assert.equal(fold.apply(state, event(1, 8)), state);
  assert.deepEqual(fold.stateSchema.parse(JSON.parse(JSON.stringify(state))), state);
});
test('conflicting identity, source gap and destination cannot silently advance the index', () => {
  const fold = a2aSessionProjection(), state = fold.apply(fold.init(), event());
  assert.throws(() => fold.apply(state, event(1, 1, { timestamp: 2 })), { code: 'A2A_SESSION_EVENT_CONFLICT' });
  assert.throws(() => fold.apply(state, event(3, 1)), { code: 'A2A_SESSION_SEQUENCE_GAP' });
  const owner = event(2, 1); owner.data.owner.sessionId = 'different';
  assert.throws(() => fold.apply(state, owner), { code: 'A2A_SESSION_OWNER_CONFLICT' });
  assert.equal(state.sources[sourceKey].through, 1);
});
test('observation envelopes cannot acquire model surface, root run or decision authority', () => {
  const fold = a2aSessionProjection();
  for (const value of [{ ...event(), ignorable: false }, { ...event(), surfaceOp: 'append' },
    { ...event(), sourceEventSeqs: [0] }, event(1, 0, { event_type: 'run.completed' })]) {
    assert.throws(() => fold.apply(fold.init(), value), { code: 'A2A_SESSION_EVENT_INVALID' });
  }
  const mismatch = event(); mismatch.data.sourceSeq = 2;
  assert.throws(() => fold.apply(fold.init(), mismatch), { code: 'A2A_SESSION_EVENT_INVALID' });
  const negativeZero = event(1, 0, { initial: { parts: [{ content_type: 'data', data: { value: -0 } }] } });
  assert.ok(Object.is(JSON.parse(negativeZero.data.eventJson).initial.parts[0].data.value, -0));
  const state = fold.apply(fold.init(), negativeZero);
  assert.equal(Object.keys(state.receipts).length, 1);
  assert.equal(JSON.stringify(state).includes('initial'), false, 'projection indexes identities without copying payload');
});
