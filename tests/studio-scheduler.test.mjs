import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioScheduler } from '../src/studio-scheduler.mjs';

async function makeStore() { return mkdtemp(join(tmpdir(), 'agentkit-sched-')); }

test('schedules CRUD with once/interval/cron kinds', async () => {
  const store = await makeStore();
  const scheduler = createStudioScheduler({ storeDir: store, tickIntervalMs: 600000 });
  try {
    const once = await scheduler.createSchedule('ar-1', { taskId: 'once-task', displayName: 'Once', kind: 'once', at: '2099-01-01T00:00:00Z', prompt: 'hello' });
    assert.equal(once.kind, 'once');
    const interval = await scheduler.createSchedule('ar-1', { taskId: 'interval-task', displayName: 'Interval', kind: 'interval', everySeconds: 3600, prompt: 'tick' });
    assert.equal(interval.kind, 'interval');
    const cron = await scheduler.createSchedule('ar-1', { taskId: 'cron-task', displayName: 'Cron', kind: 'cron', expression: '0 9 * * 1-5', prompt: 'weekday' });
    assert.equal(cron.kind, 'cron');
    const listed = await scheduler.listSchedules();
    assert.equal(listed.length, 3);
    const fetched = await scheduler.getSchedule('once-task');
    assert.equal(fetched.displayName, 'Once');
    const updated = await scheduler.updateSchedule('once-task', { displayName: 'Updated Once' });
    assert.equal(updated.displayName, 'Updated Once');
    await scheduler.deleteSchedule('once-task');
    assert.equal((await scheduler.listSchedules()).length, 2);
  } finally { await rm(store, { recursive: true, force: true }).catch(() => {}); }
});

test('invalid schedule spec and task id are rejected', async () => {
  const store = await makeStore();
  const scheduler = createStudioScheduler({ storeDir: store, tickIntervalMs: 600000 });
  try {
    await assert.rejects(() => scheduler.createSchedule('ar-1', { taskId: 'BAD', kind: 'once', at: '2099-01-01T00:00:00Z' }), error => error.code === 'TASK_ID_INVALID');
    await assert.rejects(() => scheduler.createSchedule('ar-1', { taskId: 'bad-kind', kind: 'invalid' }), error => error.code === 'SCHEDULE_KIND_INVALID');
    await assert.rejects(() => scheduler.createSchedule('ar-1', { taskId: 'bad-once', kind: 'once' }), error => error.code === 'SCHEDULE_SPEC_INVALID');
    await assert.rejects(() => scheduler.createSchedule('ar-1', { taskId: 'bad-cron', kind: 'cron', expression: '* * *' }), error => error.code === 'CRON_INVALID');
  } finally { await rm(store, { recursive: true, force: true }).catch(() => {}); }
});

test('occurrences are recorded as failed without a runner', async () => {
  const store = await makeStore();
  // Use a mock clock set 10 seconds ahead so the interval (1s) is already due.
  let nowMs = Date.now();
  const scheduler = createStudioScheduler({ storeDir: store, tickIntervalMs: 600000, runner: null, clock: { now: () => nowMs } });
  try {
    await scheduler.createSchedule('ar-1', { taskId: 'fire-now', kind: 'interval', everySeconds: 1, prompt: 'go' });
    nowMs += 10000;
    await scheduler.ensureReady();
    await scheduler.tick();
    await new Promise(r => setTimeout(r, 50));
    const occurrences = await scheduler.listOccurrences('fire-now');
    assert.ok(occurrences.length > 0, 'expected at least one occurrence');
    assert.equal(occurrences[0].state, 'failed');
  } finally { await rm(store, { recursive: true, force: true }).catch(() => {}); }
});
