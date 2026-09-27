import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { CanonicalDshSessionAdapter, validateInteractionAnswer } from '../src/session-adapter.mjs';

const fixture = JSON.parse(await readFile(new URL('./fixtures/runtime-events.json', import.meta.url)));
const p1Matrix = JSON.parse(await readFile(new URL('./fixtures/p1-runtime-matrix.json', import.meta.url)));

test('projects a canonical snapshot with identity, watermark, and DSH wire fields', () => {
  const adapter = new CanonicalDshSessionAdapter();
  const snapshot = adapter.projectSnapshot(fixture);
  assert.equal(snapshot.watermark, 4);
  assert.deepEqual(snapshot.events.map(event => event.seq), [0, 1, 2, 3]);
  assert.equal(snapshot.events[1].type, 'user/message');
  assert.deepEqual(adapter.wireEvent(snapshot.events[1]), {
    type: 'user/message', seq: 1, time: 1700000000100, surfaceOp: 'append',
    data: {
      id: 'user-item-1', role: 'user',
      content: [{ type: 'text', text: 'open studio' }],
      source: { kind: 'user' },
      _ksadk: {
        schema_version: 2, event_id: 'studio-event-1', event_type: 'item.completed',
        run_id: 'studio-run-1', scope_id: 'studio-run-1',
        source: { framework: 'ksadk', protocol: 'a2ui', metadata: { role: 'user' } },
      },
    },
  });
  assert.equal(snapshot.events[2].ignorable, true);
});

test('deduplicates exact replay and rejects ID/sequence collisions', () => {
  const adapter = new CanonicalDshSessionAdapter();
  const events = [fixture.events[1], fixture.events[1], fixture.events[2]];
  assert.equal(adapter.projectEvents(fixture.session_id, events).length, 2);
  assert.throws(() => adapter.projectEvents(fixture.session_id, [
    fixture.events[1], { ...fixture.events[2], seq: fixture.events[1].seq },
  ]), /two event IDs share one session sequence/);
  assert.throws(() => adapter.projectEvents(fixture.session_id, [
    fixture.events[1], { ...fixture.events[1], snapshot: { parts: [] } },
  ]), /changed during replay/);
});

test('interaction revisions are explicit and reject stale/missing actions', () => {
  assert.deepEqual(validateInteractionAnswer({ interaction_id: 'i-1', expected_revision: 2, action: 'approve' }), {
    interaction_id: 'i-1', expected_revision: 2, action: 'approve',
  });
  assert.throws(() => validateInteractionAnswer({ interaction_id: 'i-1', expected_revision: 0, action: 'approve' }), /positive/);
  assert.throws(() => validateInteractionAnswer({ interaction_id: 'i-1', expected_revision: 1, action: 'unknown' }), /unsupported/);
});

test('P1 matrix maps the proven DSH lifecycle and preserves unsupported families', () => {
  const adapter = new CanonicalDshSessionAdapter();
  const projected = adapter.projectSnapshot(p1Matrix);
  assert.equal(projected.watermark, 20);
  assert.equal(projected.events.length, 21);
  assert.equal(projected.events[1].type, 'user/message');
  assert.equal(projected.events[1].ignorable, false);
  assert.equal(projected.events.find(event => event.source_event_id === 'p1-00').type, 'turn/start');
  assert.equal(projected.events.find(event => event.source_event_id === 'p1-02').type, 'step/start');
  const assistant = projected.events.find(event => event.source_event_id === 'p1-04');
  assert.equal(assistant.type, 'assistant/message');
  assert.deepEqual(assistant.data.message.content, [{ type: 'text', text: 'The answer is ready.' }]);
  const toolCall = projected.events.find(event => event.source_event_id === 'p1-09');
  assert.deepEqual({ type: toolCall.type, callId: toolCall.data.callId, name: toolCall.data.name, arguments: toolCall.data.arguments }, {
    type: 'tool/call', callId: 'p1-call', name: 'list_files', arguments: '{"path":"."}',
  });
  const toolResult = projected.events.find(event => event.source_event_id === 'p1-11');
  assert.equal(toolResult.type, 'tool/result');
  assert.equal(toolResult.data.message.source.callId, 'p1-call');
  assert.equal(toolResult.data.message.isError, false);
  assert.equal(projected.events.find(event => event.source_event_id === 'p1-12').type, 'approval/asked');
  assert.deepEqual(projected.events.find(event => event.source_event_id === 'p1-12').data, {
    id: 'p1-approval', toolName: 'list_files', callId: 'p1-call',
  });
  assert.equal(projected.events.find(event => event.source_event_id === 'p1-13').type, 'approval/decided');
  assert.deepEqual(projected.events.find(event => event.source_event_id === 'p1-13').data, {
    id: 'p1-approval', outcome: 'allowed-once',
  });
  assert.equal(projected.events.find(event => event.source_event_id === 'p1-14').type, 'ksadk/item.completed');
  assert.equal(projected.events.find(event => event.source_event_id === 'p1-15').data.reason.kind, 'completed');
  assert.equal(projected.events.find(event => event.source_event_id === 'p1-17').data.reason.error.code, 'RATE_LIMITED');
  const late = projected.events.find(event => event.source_event_id === 'p1-20');
  assert.equal(late.type, 'ksadk/item.completed');
  assert.equal(late.ignorable, true);
  assert.equal(late.data._ksadk.event_type, 'item.completed');
});

test('promotes official goal and deliverable event shapes only when their contracts are complete', () => {
  const adapter = new CanonicalDshSessionAdapter();
  const base = {
    schema_version: 2, timestamp: 1700000000, run_id: 'run-goal', scope_id: 'run-goal',
    source: { framework: 'ksadk', metadata: { turn: 1, step: 1 } },
  };
  const goalChange = {
    ...base, event_id: 'goal-change', seq: 0, event_type: 'item.completed', item_id: 'goal-data', item_kind: 'data',
    snapshot: { parts: [{ content_type: 'data', part_id: 'goal-part', data: {
      type: 'goal/change', data: { kind: 'goal/change', version: 1, operation: 'create',
        goal: { id: 'goal-1', revision: 1, objective: 'ship', phase: 'active', maxGoalRounds: 3 },
        roundsStarted: 0, createdAt: 1, updatedAt: 1 },
    } }] },
  };
  const presented = {
    ...base, event_id: 'presented', seq: 1, event_type: 'item.completed', item_id: 'artifact-data', item_kind: 'data',
    snapshot: { parts: [{ content_type: 'data', part_id: 'presented-part', data: {
      type: 'deliverables/presented', data: { turn: 1, callId: 'present', files: [{ path: '/tmp/report.txt' }] },
    } }] },
  };
  const opaqueArtifact = {
    ...base, event_id: 'artifact', seq: 2, event_type: 'item.completed', item_id: 'artifact-item', item_kind: 'artifact',
    snapshot: { parts: [{ content_type: 'artifact', part_id: 'artifact-part', artifact_id: 'artifact-1', name: 'report.txt', uri: 'artifact://artifact-1', data: null }] },
  };
  const projected = adapter.projectEvents('session-goal', [goalChange, presented, opaqueArtifact]);
  assert.equal(projected[0].type, 'goal/change');
  assert.equal(projected[0].ignorable, false);
  assert.equal(projected[1].type, 'deliverables/presented');
  assert.deepEqual(projected[1].data.files, [{ path: '/tmp/report.txt' }]);
  assert.equal(projected[2].type, 'ksadk/item.completed');
});

test('snapshot tail replay is idempotent across reconnect and paging', () => {
  const adapter = new CanonicalDshSessionAdapter();
  const firstPage = p1Matrix.events.slice(0, 12);
  const tail = [...p1Matrix.events.slice(10, 16), ...p1Matrix.events.slice(16)];
  const replay = adapter.projectEvents(p1Matrix.session_id, [...firstPage, ...tail, p1Matrix.events[7]]);
  assert.deepEqual(replay.map(event => event.seq), Array.from({ length: 21 }, (_, index) => index));
  assert.equal(replay.filter(event => event.source_event_id === 'p1-07').length, 1);
  assert.equal(adapter.projectSnapshot({ ...p1Matrix, events: tail }).watermark, 20);
});

test('a permuted history page cannot revive an item after run cancellation', () => {
  const adapter = new CanonicalDshSessionAdapter();
  const canonicalOrder = adapter.projectEvents(p1Matrix.session_id, p1Matrix.events);
  const reverseOrder = adapter.projectEvents(p1Matrix.session_id, [...p1Matrix.events].reverse());
  assert.deepEqual(reverseOrder, canonicalOrder);
  const late = reverseOrder.find(event => event.source_event_id === 'p1-20');
  assert.equal(late.type, 'ksadk/item.completed');
  assert.equal(late.ignorable, true);
});

test('snapshot watermark must cover the event tail', () => {
  const adapter = new CanonicalDshSessionAdapter();
  assert.throws(() => adapter.projectSnapshot({ ...p1Matrix, watermark: 19 }), /watermark must cover/);
});
