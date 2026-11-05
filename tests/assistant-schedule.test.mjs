import test from 'node:test';
import assert from 'node:assert/strict';
import { assistantScheduleExpected, executeAssistantSchedule } from '../src/assistant-schedule.mjs';
const record = { id: 'task', kind: 'weekly', title: 'Review', prompt: 'Review reports', scheduledAt: '2030-01-01T09:00:00.000Z', time: '09:00:00.000', timeZone: 'UTC', weekdays: [1, 3] };
const native = (overrides = {}) => ({ ...record, target: { kind: 'session', sessionId: 'current' }, involvedSessionIds: ['current'],
  status: 'active', createdAt: '2029-12-31T00:00:00.000Z', updatedAt: '2029-12-31T00:00:00.000Z', ...overrides });
const foreign = () => native({ id: 'foreign', target: { kind: 'session', sessionId: 'other' }, involvedSessionIds: ['other'], status: 'ended' });
const deferred = () => Promise.withResolvers();
function fixture() {
  const calls = [], schedule = {
    catalog: async () => [native(), foreign()],
    history: async request => { calls.push(['history', request]); return { id: request.id, records: [], earlierRecordsUnavailable: false }; },
    edit: async (request, actor, signal) => { calls.push(['edit', request, actor, signal]);
      return request.action === 'delete' ? { id: request.id, deleted: true } : { id: request.id, code: 'schedule_conflict' }; },
    create: async (...args) => { calls.push(['create', ...args]); return native({ id: 'created' }); },
  };
  const run = (operation, payload = {}, signal) => executeAssistantSchedule({ schedule, operation, payload, sessionId: 'current', signal,
    ensure: async id => calls.push(['ensure', id]), serialize: (_id, work) => work() });
  return { calls, schedule, run };
}

test('catalog, legacy list and get only expose exact current Session without activating it', async () => {
  const f = fixture();
  for (const operation of ['schedule-catalog', 'schedule-list']) {
    const result = await f.run(operation); assert.equal(result.sessionId, 'current'); assert.equal(result.items.length, 1);
    assert.deepEqual(result.items[0], { ...record, sessionId: 'current', status: 'active', updatedAt: '2029-12-31T00:00:00.000Z' });
  }
  assert.equal((await f.run('schedule-get', { id: 'foreign' })).item, null);
  assert.equal((await f.run('schedule-get', { id: 'task' })).item.id, 'task'); assert.deepEqual(f.calls, []);
  await assert.rejects(f.run('schedule-catalog', { sessionId: 'other' }), { code: 'ASSISTANT_SCHEDULE_INPUT_INVALID' });
});

test('history, delete and CAS update forward only owned tasks and the complete expected record', async () => {
  const f = fixture(), abort = new AbortController();
  await f.run('schedule-history', { id: 'task', limit: 20, before: 'message' });
  assert.deepEqual(f.calls[0], ['history', { id: 'task', limit: 20, before: 'message' }]);
  assert.deepEqual(await f.run('schedule-history', { id: 'foreign', limit: 20 }), { id: 'foreign', code: 'schedule_not_found' });
  assert.deepEqual(await f.run('schedule-delete', { id: 'foreign' }, abort.signal), { id: 'foreign', deleted: false, code: 'schedule_not_found' });
  assert.deepEqual(await f.run('schedule-delete', { id: 'task' }, abort.signal), { id: 'task', deleted: true });
  const result = await f.run('schedule-update', { id: 'task', expected: record, title: 'New title', change: { kind: 'daily', daily: { time: '10:00:00', time_zone: 'UTC' } } }, abort.signal);
  assert.equal(result.code, 'schedule_conflict');
  assert.deepEqual(f.calls.at(-1)[1], { id: 'task', action: 'update', expectedUpdatedAt: null,
    patch: { title: 'New title', timing: { kind: 'daily', daily: { time: '10:00:00', time_zone: 'UTC' } } } });
  assert.equal(f.calls.at(-1)[3], abort.signal);
  const observed = { ...record, updatedAt: '2029-12-31T00:00:00.000Z' };
  await f.run('schedule-update', { id: 'task', expected: observed, prompt: 'New prompt' });
  assert.equal(f.calls.at(-1)[1].expectedUpdatedAt, '2029-12-31T00:00:00.000Z');
  for (const expected of [{ id: 'task', scheduledAt: record.scheduledAt }, { ...record, id: 'other' }, { ...record, sessionId: 'other' }, { ...record, weekdays: undefined }, { ...record, updatedAt: '' }]) {
    assert.throws(() => assistantScheduleExpected(expected, 'task'), { code: 'ASSISTANT_SCHEDULE_INPUT_INVALID' });
  }
  for (const payload of [{ id: 'task', limit: 0 }, { id: 'task', limit: 101 }, { id: 'task', limit: 20, sessionId: 'other' }]) await assert.rejects(f.run('schedule-history', payload));
});

test('all six native create variants pass through without a custom scheduler', async () => {
  const f = fixture();
  const variants = [{ after_seconds: 12, kind: 'after' }, { at: '2030-01-01T09:00:00Z', kind: 'at' }, { every_seconds: 120, kind: 'every' },
    { daily: { time: '09:00:00', time_zone: 'Asia/Shanghai' }, kind: 'daily' },
    { weekly: { time: '09:00:00', time_zone: 'UTC', weekdays: [2] }, kind: 'weekly' },
    { cron: { expression: '0 9 * * 1-5', time_zone: 'UTC' }, kind: 'cron' }];
  for (const { kind, ...rule } of variants) await f.run('schedule-create', { spec: { title: 'Task', prompt: 'Instruction', ...rule } });
  const creates = f.calls.filter(([operation]) => operation === 'create');
  assert.equal(creates.length, 6);
  assert.deepEqual(creates.map(([, request]) => request.timing.kind), variants.map(variant => variant.kind));
  assert.ok(creates.every(([, request, actor]) => request.target.sessionId === 'current' && actor === 'current'));
  assert.deepEqual(creates[0][1], { title: 'Task', prompt: 'Instruction', timing: { kind: 'after', after_seconds: 12 }, target: { kind: 'session', sessionId: 'current' } });
  await assert.rejects(f.run('schedule-create', { spec: { title: 'Task', prompt: 'Instruction', sessionId: 'other', after_seconds: 12 } }));
  await assert.rejects(f.run('schedule-create', { spec: { title: 'Task', prompt: 'Instruction', after_seconds: 12, every_seconds: 60 } }));
});

test('aborted reads ignore late native results and never activate or cancel an Agent', async () => {
  const f = fixture(), pending = deferred(), abort = new AbortController();
  f.schedule.catalog = () => pending.promise;
  const read = f.run('schedule-catalog', {}, abort.signal);
  abort.abort(); pending.resolve([native()]);
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
