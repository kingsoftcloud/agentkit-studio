import test from 'node:test';
import assert from 'node:assert/strict';
import { assistantScheduleExpected, executeAssistantSchedule } from '../src/assistant-schedule.mjs';
const record = { id: 'task', kind: 'weekly', title: 'Review', prompt: 'Review reports', scheduledAt: '2030-01-01T09:00:00.000Z', time: '09:00:00.000', timeZone: 'UTC', weekdays: [1, 3] };
const deferred = () => Promise.withResolvers();
function fixture() {
  const calls = [], schedule = {
    catalog: async () => [{ ...record, sessionId: 'current', status: 'active' }, { ...record, id: 'foreign', sessionId: 'other', status: 'inactive' }],
    history: async request => { calls.push(['history', request]); return { id: request.id, records: [], earlierRecordsUnavailable: false }; },
    update: async (request, signal) => { calls.push(['update', request, signal]); return { id: request.id, updated: false, code: 'schedule_conflict' }; },
    delete: async (request, signal) => { calls.push(['delete', request, signal]); return { id: request.id, deleted: false, code: 'schedule_not_found' }; },
    create: async (...args) => { calls.push(['create', ...args]); return record; },
  };
  const run = (operation, payload = {}, signal) => executeAssistantSchedule({ schedule, operation, payload, sessionId: 'current', signal,
    ensure: async id => calls.push(['ensure', id]), serialize: (_id, work) => work() });
  return { calls, schedule, run };
}

test('catalog, legacy list and get only expose exact current Session without activating it', async () => {
  const f = fixture();
  for (const operation of ['schedule-catalog', 'schedule-list']) {
    const result = await f.run(operation); assert.equal(result.sessionId, 'current'); assert.equal(result.items.length, 1);
  }
  assert.equal((await f.run('schedule-get', { id: 'foreign' })).item, null);
  assert.equal((await f.run('schedule-get', { id: 'task' })).item.id, 'task'); assert.deepEqual(f.calls, []);
  await assert.rejects(f.run('schedule-catalog', { sessionId: 'other' }), { code: 'ASSISTANT_SCHEDULE_INPUT_INVALID' });
});

test('history, delete and CAS update forward only server-derived Session and complete expected record', async () => {
  const f = fixture(), abort = new AbortController();
  await f.run('schedule-history', { id: 'task', limit: 20, before: 'message' });
  await f.run('schedule-delete', { id: 'foreign' }, abort.signal);
  const result = await f.run('schedule-update', { id: 'task', expected: record, title: 'New title', change: { kind: 'daily', daily: { time: '10:00:00', time_zone: 'UTC' } } }, abort.signal);
  assert.equal(result.code, 'schedule_conflict');
  assert.ok(f.calls.every(([, request]) => request.sessionId === 'current'));
  assert.deepEqual(f.calls[2][1].expected, record); assert.equal(f.calls[2][2], abort.signal);
  for (const expected of [{ id: 'task', scheduledAt: record.scheduledAt }, { ...record, id: 'other' }, { ...record, sessionId: 'other' }, { ...record, weekdays: undefined }]) {
    assert.throws(() => assistantScheduleExpected(expected, 'task'), { code: 'ASSISTANT_SCHEDULE_INPUT_INVALID' });
  }
  for (const payload of [{ id: 'task', limit: 0 }, { id: 'task', limit: 101 }, { id: 'task', limit: 20, sessionId: 'other' }]) await assert.rejects(f.run('schedule-history', payload));
});

test('all six native create variants pass through without a custom scheduler', async () => {
  const f = fixture();
  const variants = [{ after_seconds: 12 }, { at: '2030-01-01T09:00:00Z' }, { every_seconds: 120 },
    { daily: { time: '09:00:00', time_zone: 'Asia/Shanghai' } },
    { weekly: { time: '09:00:00', time_zone: 'UTC', weekdays: [2] } }, { cron: { expression: '0 9 * * 1-5', time_zone: 'UTC' } }];
  for (const rule of variants) await f.run('schedule-create', { spec: { title: 'Task', prompt: 'Instruction', ...rule } });
  assert.equal(f.calls.filter(([kind]) => kind === 'create').length, 6);
  assert.ok(f.calls.filter(([kind]) => kind === 'create').every(([, sessionId]) => sessionId === 'current'));
  await assert.rejects(f.run('schedule-create', { spec: { title: 'Task', prompt: 'Instruction', sessionId: 'other', after_seconds: 12 } }));
});

test('aborted reads ignore late native results and never activate or cancel an Agent', async () => {
  const f = fixture(), pending = deferred(), abort = new AbortController();
  f.schedule.catalog = () => pending.promise;
  const read = f.run('schedule-catalog', {}, abort.signal);
  abort.abort(); pending.resolve([{ ...record, sessionId: 'current', status: 'active' }]);
  await assert.rejects(read, { name: 'AbortError' }); assert.deepEqual(f.calls, []);
});

test('create waits for ensure, checks cancellation again, and never retries an unknown write outcome', async () => {
  const pending = deferred(), abort = new AbortController(); let creates = 0;
  const request = executeAssistantSchedule({ schedule: { create: async () => { creates++; throw new Error('ack lost'); } }, operation: 'schedule-create',
    payload: { spec: { title: 'Task', prompt: 'Do it', after_seconds: 1 } }, sessionId: 'current', ensure: () => pending.promise, serialize: (_id, work) => work(), signal: abort.signal });
  abort.abort(); pending.resolve(); await assert.rejects(request, { name: 'AbortError' }); assert.equal(creates, 0);
  const f = fixture(); f.schedule.create = async () => { creates++; throw new Error('ack lost'); };
  await assert.rejects(f.run('schedule-create', { spec: { title: 'Task', prompt: 'Do it', after_seconds: 1 } }), /ack lost/); assert.equal(creates, 1);
});
