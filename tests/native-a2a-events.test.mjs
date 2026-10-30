import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { a2aIdentity, checkpointA2ADescriptor, enqueueA2AEvents } from '../src/providers/native-a2a-events.mjs';
import { spec, taskId, scope } from './fixtures/native-a2a-internal-peer.mjs';
const record = dsh => ({ managed: { taskId }, createdAt: 1792790000000, phase: 'sending', projection: { state: 'submitted' },
  request: { spec, scopeId: 'child', trigger: { scope_id: dsh ? 'child' : 'run', item_id: 'call', call_id: 'call' },
    [dsh ? 'dsh' : 'native']: { scope, agentId: 'agent', sessionId: 'session', runId: 'run' } } });
for (const dsh of [false, true]) test(`${dsh ? 'DSH' : 'Native'} canonical child lifecycle is durable, monotonic and owns no root run events`, () => {
  const r = record(dsh); assert.equal(checkpointA2ADescriptor(r), true);
  let journal = r.managed.events;
  assert.deepEqual(journal.log.map(e => e.event_type), ['item.started', 'item.snapshot_replaced']);
  assert.deepEqual(journal.log.map(e => e.seq), [1, 2]);
  assert.equal(journal.log[0].initial.parts[0].data.status, 'submitted');
  const parent = dsh ? a2aIdentity('scope', 'dsh', 'agent', 'session') : 'run';
  for (const event of journal.log) {
    assert.equal(event.run_id, parent); assert.equal(event.parent_scope_id, parent); assert.equal(event.scope_id, 'child');
    assert.notEqual(event.scope_id, event.parent_scope_id); assert.equal(event.item_kind, 'status');
    assert.equal(event.source.metadata.schema, 'execution.scope/v1'); assert.equal(event.event_type.startsWith('run.'), false);
  }
  assert.equal(checkpointA2ADescriptor(r), false);
  r.projection.state = 'auth_required'; checkpointA2ADescriptor(r);
  assert.equal(journal.descriptor.status, 'input_required'); assert.equal(journal.descriptor.ended_at, null);
  r.projection.state = 'working'; checkpointA2ADescriptor(r);
  r.phase = 'terminal'; r.projection.state = 'cancelled'; checkpointA2ADescriptor(r);
  assert.equal(journal.log.at(-1).event_type, 'item.completed');
  assert.equal(journal.descriptor.cancel.request_state, 'confirmed'); assert.equal(journal.descriptor.cancel.capability, 'supported');
  assert.ok(journal.descriptor.ended_at >= journal.descriptor.started_at);
  const terminal = JSON.stringify(journal); r.projection.state = 'working';
  assert.equal(checkpointA2ADescriptor(r), false); assert.equal(JSON.stringify(journal), terminal);
  assert.equal(new Set(journal.log.map(event => event.event_id)).size, journal.log.length);
  assert.equal(journal.pending.length, journal.log.length);
});
test('unknown sends close only their local descriptor and a later private receipt cannot reopen it', () => {
  const r = record(false); checkpointA2ADescriptor(r); r.phase = 'unknown'; checkpointA2ADescriptor(r);
  assert.equal(r.managed.events.descriptor.status, 'failed'); const bytes = JSON.stringify(r.managed.events);
  r.phase = 'terminal'; r.projection.state = 'completed'; assert.equal(checkpointA2ADescriptor(r), false);
  assert.equal(JSON.stringify(r.managed.events), bytes);
});
test('canonical enqueue deduplicates identical events and rejects changed payloads, batches or journal capacity', () => {
  const r = record(false); checkpointA2ADescriptor(r); const journal = r.managed.events, before = JSON.stringify(journal);
  assert.equal(enqueueA2AEvents(r, [journal.log[0]]), false); assert.equal(JSON.stringify(journal), before);
  assert.throws(() => enqueueA2AEvents(r, [{ ...journal.log[0], timestamp: 1 }]), { code: 'A2A_EVENT_ID_CONFLICT' });
  assert.throws(() => enqueueA2AEvents(r, []), { code: 'A2A_EVENT_BATCH_TOO_LARGE' });
  assert.throws(() => enqueueA2AEvents(r, Array(101).fill(journal.log[0])), { code: 'A2A_EVENT_BATCH_TOO_LARGE' });
  const event = { ...journal.log[0], event_id: 'different', seq: 3 };
  assert.throws(() => enqueueA2AEvents(r, [{ ...event, seq: 1 }]), { code: 'A2A_EVENT_SEQUENCE_CONFLICT' });
  journal.log = Array(8192).fill(journal.log.at(-1)); assert.throws(() => enqueueA2AEvents(r, [event]), { code: 'A2A_EVENT_JOURNAL_LIMIT' });
});
const oracle = JSON.parse(readFileSync(new URL('./fixtures/a2a-event-identity-reference.json', import.meta.url), 'utf8'));
for (const row of oracle.cases) test(`identity matches actual reference: ${row.label}`, () => {
  assert.equal(a2aIdentity(row.kind, row.framework, ...row.components), row.expected);
});
