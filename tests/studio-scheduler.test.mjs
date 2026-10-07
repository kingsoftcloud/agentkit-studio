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

test('manual run creates an occurrence instead of only listing history', async () => {
  const store = await makeStore();
  const scheduler = createStudioScheduler({ storeDir: store, tickIntervalMs: 600000, runner: null });
  try {
    await scheduler.createSchedule('ar-1', { taskId: 'manual-run', kind: 'interval', everySeconds: 3600, prompt: 'go' });
    const occurrence = await scheduler.runNow('manual-run');
    assert.equal(occurrence.taskId, 'manual-run');
    assert.equal(occurrence.state, 'failed');
    assert.equal((await scheduler.listOccurrences('manual-run')).length, 1);
  } finally { await rm(store, { recursive: true, force: true }).catch(() => {}); }
});

test('the actual Studio form contract round-trips target, command, schedule and enable changes', async () => {
  const store = await makeStore();
  const scheduler = createStudioScheduler({ storeDir: store, tickIntervalMs: 600000, runner: async () => ({ runId: 'native-run' }) });
  try {
    const task = await scheduler.createSchedule('agent-a', { displayName: 'Skill probe', prompt: 'run probe', schedule: { kind: 'interval', everySeconds: 86400, timezone: 'Asia/Shanghai' } });
    assert.equal(task.target.agentId, 'agent-a'); assert.equal(task.command.payload.content, 'run probe');
    assert.equal(task.schedule.everySeconds, 86400);
    const changed = await scheduler.updateSchedule(task.taskId, { prompt: 'edited', enabled: false, schedule: { kind: 'interval', everySeconds: 7200, timezone: 'Asia/Shanghai' } });
    assert.equal(changed.command.payload.content, 'edited'); assert.equal(changed.schedule.everySeconds, 7200); assert.equal(changed.enabled, false);
    await assert.rejects(() => scheduler.runNow(task.taskId), error => error.code === 'SCHEDULE_DISABLED');
    await scheduler.updateSchedule(task.taskId, { enabled: true });
    const occurrence = await scheduler.runNow(task.taskId); assert.equal(occurrence.runId, 'native-run'); assert.equal(occurrence.state, 'succeeded');
  } finally { await rm(store, { recursive: true, force: true }); }
});

test('Cron uses the requested time zone and does not fire twice within one matching minute', async () => {
  const store = await makeStore(); let now = Date.parse('2026-10-07T01:00:05Z');
  const scheduler = createStudioScheduler({ storeDir: store, clock: { now: () => now }, tickIntervalMs: 600000, runner: async () => ({ runId: 'cron-run' }) });
  try {
    await scheduler.createSchedule('a', { taskId: 'cron-local', schedule: { kind: 'cron', expression: '0 9 * * 1-5', timezone: 'Asia/Shanghai' } });
    await scheduler.createSchedule('a', { taskId: 'cron-utc', schedule: { kind: 'cron', expression: '0 9 * * 1-5', timezone: 'UTC' } });
    await scheduler.tick(); now += 30000; await scheduler.tick();
    assert.equal((await scheduler.listOccurrences('cron-local')).length, 1);
    assert.equal((await scheduler.listOccurrences('cron-utc')).length, 0);
  } finally { await scheduler.dispose(); await rm(store, { recursive: true, force: true }); }
});
