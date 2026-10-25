/** Local schedule store and cron engine for the Studio plugin Node host.
 *
 * Port of the legacy Studio scheduler: SQLite-backed schedules and
 * occurrences, a 30-second tick that fires due tasks, and misfire handling.
 * The runner is injected; until a run contract exists, due occurrences are
 * recorded as `failed` with an honest gap message.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync as Database } from 'node:sqlite';
import { closeSync, constants } from 'node:fs';
import { openPrivate, privateFile } from '../packages/agentkit-harness/src/native/local-command-state.mjs';

export class StudioSchedulerError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'StudioSchedulerError';
    this.code = code;
    this.details = details;
  }
}

const TASK_ID_RE = /^[a-z][a-z0-9-]{2,62}$/;
const SCHEDULE_KINDS = new Set(['once', 'interval', 'cron']);

function parseCron(expr) {
  const fields = String(expr || '').trim().split(/\s+/);
  if (fields.length !== 5) throw new StudioSchedulerError('CRON_INVALID', 'cron 表达式需要 5 个字段', { expression: expr });
  return fields;
}

function cronMatches(date, fields) {
  const m = date.getUTCMinutes(), h = date.getUTCHours(), dom = date.getUTCDate(), mon = date.getUTCMonth() + 1, dow = date.getUTCDay();
  const check = (field, value, min, max) => {
    if (field === '*') return true;
    for (const part of field.split(',')) {
      if (part.includes('/')) {
        const [base, step] = part.split('/');
        const s = Number(step);
        if (!s) continue;
        const start = base === '*' ? min : Number(base);
        if (value >= start && (value - start) % s === 0) return true;
      } else if (part.includes('-')) {
        const [lo, hi] = part.split('-').map(Number);
        if (value >= lo && value <= hi) return true;
      } else if (Number(part) === value) return true;
    }
    return false;
  };
  return check(fields[0], m, 0, 59) && check(fields[1], h, 0, 23) && check(fields[2], dom, 1, 31) && check(fields[3], mon, 1, 12) && check(fields[4], dow, 0, 6);
}

export function createStudioScheduler({ storeDir, runner, tickIntervalMs = 30000, clock = Date } = {}) {
  let db = null;
  let timer = null;
  let owner = null, initialization = null, closing = false;
  const running = new Map();
  function normalized(spec = {}) {
    const schedule = spec.schedule && typeof spec.schedule === 'object' ? spec.schedule : {};
    return { ...spec, ...schedule };
  }
  const executeOccurrence = async (row, scheduledFor = new Date(clock.now())) => {
    const occurrenceId = `occ_${randomUUID().replace(/-/g, '')}`;
    const sessionId = `ses_${randomUUID().replace(/-/g, '')}`;
    const scheduledAt = scheduledFor.toISOString();
    // Claim and advance together, before asking the Agent to execute. A crash
    // cannot leave a once task due after its original occurrence was dispatched.
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO occurrences (occurrence_id, task_id, scheduled_for, session_id, state, attempt, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(occurrenceId, row.task_id, scheduledAt, sessionId, 'running', 1, scheduledAt);
      db.prepare('UPDATE schedules SET last_fired_at = ?, updated_at = ? WHERE task_id = ?').run(scheduledAt, scheduledAt, row.task_id);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    if (typeof runner === 'function') {
      try {
        const result = await runner({ occurrenceId, taskId: row.task_id, agentId: row.agent_id, sessionId, input: row.prompt });
        db.prepare('UPDATE occurrences SET state = ?, completed_at = ?, run_id = ? WHERE occurrence_id = ?').run('succeeded', new Date(clock.now()).toISOString(), String(result?.runId || ''), occurrenceId);
      } catch (error) {
        db.prepare('UPDATE occurrences SET state = ?, completed_at = ?, error = ? WHERE occurrence_id = ?').run('failed', new Date(clock.now()).toISOString(), JSON.stringify({ code: error?.code || 'AUTOMATION_RUN_FAILED', message: error?.message || '自动化运行失败' }), occurrenceId);
      }
    } else {
      db.prepare('UPDATE occurrences SET state = ?, completed_at = ? WHERE occurrence_id = ?').run('failed', new Date(clock.now()).toISOString(), occurrenceId);
    }
    return rowToOccurrence(db.prepare('SELECT * FROM occurrences WHERE occurrence_id = ?').get(occurrenceId));
  };

  const runOccurrence = (row, scheduledFor) => {
    if (closing) throw new StudioSchedulerError('SCHEDULER_CLOSED', '调度器已关闭');
    if (running.has(row.task_id)) throw new StudioSchedulerError('SCHEDULE_RUNNING', '该自动化正在运行', { taskId: row.task_id });
    const work = executeOccurrence(row, scheduledFor).finally(() => running.delete(row.task_id));
    running.set(row.task_id, work); return work;
  };

  const tick = async () => {
    if (!db || closing) return;
    const now = new Date(clock.now());
    const rows = db.prepare('SELECT * FROM schedules WHERE enabled = 1').all();
    const dispatched = [];
    for (const row of rows) {
      let fire = false;
      if (row.kind === 'once') { if (new Date(row.next_fire_at) <= now) fire = true; }
      else if (row.kind === 'interval') { const last = row.last_fired_at ? new Date(row.last_fired_at) : new Date(row.created_at); if (new Date(last.getTime() + Number(row.every_seconds) * 1000) <= now) fire = true; }
      else if (row.kind === 'cron') { const fields = JSON.parse(row.cron_fields); const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: row.timezone || 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(now).map(part => [part.type, part.value])); if (cronMatches(new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute))), fields)) fire = true; }
      if (!fire || running.has(row.task_id)) continue;
      if (row.kind === 'cron' && row.last_fired_at && Math.floor(Date.parse(row.last_fired_at) / 60000) === Math.floor(now.getTime() / 60000)) continue;
      if (row.kind === 'once' && row.last_fired_at) continue;
      dispatched.push(runOccurrence(row, now));
    }
    await Promise.all(dispatched);
  };

  async function ensureReady() {
    if (closing) throw new StudioSchedulerError('SCHEDULER_CLOSED', '调度器已关闭');
    if (db) return;
    if (!initialization) initialization = initialize().finally(() => { initialization = null; });
    await initialization;
  }

  async function initialize() {
    await mkdir(storeDir, { recursive: true, mode: 0o700 });
    const ownedDirectory = await realpath(storeDir);
    if (closing) throw new StudioSchedulerError('SCHEDULER_CLOSED', '调度器已关闭');
    // A separate SQLite transaction owns this scheduler until shutdown. Zero
    // busy timeout also rejects same-process contenders without blocking the
    // event loop. Process death releases ownership; no PID/mtime inference.
    const lock = join(ownedDirectory, 'scheduler-owner.sqlite3');
    const fd = openPrivate(lock, constants.O_RDWR | constants.O_CREAT); closeSync(fd);
    for (const suffix of ['-journal', '-wal', '-shm']) privateFile(lock + suffix, true);
    try {
      owner = new Database(lock);
      owner.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE;');
    } catch (error) {
      owner?.close(); owner = null;
      if ([5, 6].includes(error.errcode)) throw new StudioSchedulerError('SCHEDULER_OWNED', '另一个宿主正在运行此调度器');
      throw error;
    }
    try {
      db = new Database(join(ownedDirectory, 'scheduler.sqlite3'));
      db.exec(`
        CREATE TABLE IF NOT EXISTS schedules (task_id TEXT PRIMARY KEY, agent_id TEXT, display_name TEXT, kind TEXT, at TEXT, every_seconds INTEGER, expression TEXT, cron_fields TEXT, misfire_policy TEXT DEFAULT 'skip', prompt TEXT, enabled INTEGER DEFAULT 1, created_at TEXT, updated_at TEXT, last_fired_at TEXT, next_fire_at TEXT);
        CREATE TABLE IF NOT EXISTS occurrences (occurrence_id TEXT PRIMARY KEY, task_id TEXT, scheduled_for TEXT, session_id TEXT, state TEXT DEFAULT 'claimed', attempt INTEGER DEFAULT 1, run_id TEXT, started_at TEXT, completed_at TEXT);
        CREATE INDEX IF NOT EXISTS idx_occ_task ON occurrences(task_id);
      `);
      const scheduleColumns = db.prepare('PRAGMA table_info(schedules)').all().map(row => row.name);
      if (!scheduleColumns.includes('timezone')) db.exec("ALTER TABLE schedules ADD COLUMN timezone TEXT DEFAULT 'Asia/Shanghai'");
      const occurrenceColumns = db.prepare('PRAGMA table_info(occurrences)').all().map(row => row.name);
      if (!occurrenceColumns.includes('error')) db.exec('ALTER TABLE occurrences ADD COLUMN error TEXT');
      db.prepare("UPDATE occurrences SET state = 'failed', completed_at = ?, error = ? WHERE state IN ('claimed', 'running', 'accepted', 'admitting')")
        .run(new Date(clock.now()).toISOString(), JSON.stringify({ code: 'AUTOMATION_OUTCOME_UNKNOWN',
          message: '原宿主执行中断，结果尚未确认。请通过原会话核对或恢复；调度器不会重放原调用。' }));
      timer = setInterval(() => { void tick().catch(error => console.warn('[agentkit-studio] scheduler tick failed:', error?.message || error)); }, tickIntervalMs);
      if (typeof timer.unref === 'function') timer.unref();
      void tick().catch(error => console.warn('[agentkit-studio] scheduler startup tick failed:', error?.message || error));
    } catch (error) {
      db?.close(); db = null;
      try { owner.exec('ROLLBACK'); } finally { owner.close(); owner = null; }
      throw error;
    }
  }

  function validateSpec(spec) {
    const kind = String(spec.kind || '');
    try { new Intl.DateTimeFormat('en', { timeZone: spec.timezone || 'Asia/Shanghai' }); } catch { throw new StudioSchedulerError('SCHEDULE_TIMEZONE_INVALID', '时区无效'); }
    if (!SCHEDULE_KINDS.has(kind)) throw new StudioSchedulerError('SCHEDULE_KIND_INVALID', `kind 必须是 once/interval/cron`);
    if (kind === 'once' && (!spec.at || !Number.isFinite(Date.parse(spec.at)))) throw new StudioSchedulerError('SCHEDULE_SPEC_INVALID', 'once 需要 at');
    if (kind === 'interval' && (!spec.everySeconds || Number(spec.everySeconds) < 1)) throw new StudioSchedulerError('SCHEDULE_SPEC_INVALID', 'interval 需要 everySeconds');
    if (kind === 'cron') { const fields = parseCron(spec.expression); return JSON.stringify(fields); }
    return null;
  }

  async function createSchedule(agentId, spec = {}) {
    await ensureReady();
    spec = normalized(spec);
    const taskId = String(spec.taskId || `task-${randomUUID().slice(0, 8)}`);
    if (!TASK_ID_RE.test(taskId)) throw new StudioSchedulerError('TASK_ID_INVALID', 'task_id 格式必须是 ^[a-z][a-z0-9-]{2,62}$');
    const cronFields = validateSpec(spec);
    const now = new Date(clock.now()).toISOString();
    db.prepare('INSERT INTO schedules (task_id, agent_id, display_name, kind, at, every_seconds, expression, cron_fields, misfire_policy, prompt, enabled, created_at, updated_at, last_fired_at, next_fire_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)').run(taskId, String(agentId || ''), String(spec.displayName || ''), String(spec.kind), String(spec.at || ''), Number(spec.everySeconds) || 0, String(spec.expression || ''), cronFields, String(spec.misfirePolicy || 'skip'), String(spec.prompt || ''), 1, now, now, spec.at || null);
    db.prepare('UPDATE schedules SET timezone = ?, enabled = ? WHERE task_id = ?').run(String(spec.timezone || 'Asia/Shanghai'), spec.enabled !== false ? 1 : 0, taskId);
    return getSchedule(taskId);
  }

  async function listSchedules(agentId) {
    await ensureReady();
    if (agentId) return db.prepare('SELECT * FROM schedules WHERE agent_id = ? ORDER BY created_at DESC').all(agentId).map(rowToSchedule);
    return db.prepare('SELECT * FROM schedules ORDER BY created_at DESC').all().map(rowToSchedule);
  }

  async function getSchedule(taskId) {
    await ensureReady();
    const row = db.prepare('SELECT * FROM schedules WHERE task_id = ?').get(taskId);
    return row ? rowToSchedule(row) : null;
  }

  async function updateSchedule(taskId, patch = {}) {
    await ensureReady();
    patch = normalized(patch);
    const current = db.prepare('SELECT * FROM schedules WHERE task_id = ?').get(taskId);
    if (!current) throw new StudioSchedulerError('SCHEDULE_NOT_FOUND', '调度任务不存在', { taskId });
    const merged = { ...rowToSchedule(current), ...patch };
    const cronFields = patch.kind || patch.expression ? validateSpec(merged) : current.cron_fields;
    db.prepare('UPDATE schedules SET display_name = ?, kind = ?, at = ?, every_seconds = ?, expression = ?, cron_fields = ?, misfire_policy = ?, prompt = ?, enabled = ?, updated_at = ? WHERE task_id = ?').run(String(merged.displayName || ''), String(merged.kind || current.kind), String(merged.at || ''), Number(merged.everySeconds) || 0, String(merged.expression || ''), cronFields, String(merged.misfirePolicy || 'skip'), String(merged.prompt || ''), merged.enabled !== false ? 1 : 0, new Date(clock.now()).toISOString(), taskId);
    db.prepare('UPDATE schedules SET timezone = ?, agent_id = ? WHERE task_id = ?').run(String(merged.timezone || 'Asia/Shanghai'), String(merged.agentId || current.agent_id), taskId);
    return getSchedule(taskId);
  }

  async function deleteSchedule(taskId) {
    await ensureReady();
    db.prepare('DELETE FROM schedules WHERE task_id = ?').run(taskId);
    db.prepare('DELETE FROM occurrences WHERE task_id = ?').run(taskId);
    return { taskId, deleted: true };
  }

  async function listOccurrences(taskId, agentId) {
    await ensureReady();
    let query = 'SELECT * FROM occurrences';
    const params = [];
    if (taskId) { query += ' WHERE task_id = ?'; params.push(taskId); }
    query += ' ORDER BY scheduled_for DESC LIMIT 200';
    return db.prepare(query).all(...params).map(rowToOccurrence);
  }

  async function runNow(taskId) {
    await ensureReady();
    const row = db.prepare('SELECT * FROM schedules WHERE task_id = ?').get(taskId);
    if (!row) throw new StudioSchedulerError('SCHEDULE_NOT_FOUND', '调度任务不存在', { taskId });
    if (!row.enabled) throw new StudioSchedulerError('SCHEDULE_DISABLED', '已暂停的调度任务不能立即运行', { taskId });
    return runOccurrence(row);
  }

  function rowToSchedule(row) {
    const nextRunAt = row.enabled && row.kind === 'interval' ? new Date(Date.parse(row.last_fired_at || row.created_at) + Number(row.every_seconds) * 1000).toISOString() : row.enabled && row.kind === 'once' && !row.last_fired_at ? row.at : null;
    return { nextRunAt, target: { agentId: row.agent_id }, command: { payload: { content: row.prompt } }, schedule: { kind: row.kind, at: row.at, everySeconds: row.every_seconds, expression: row.expression, timezone: row.timezone || 'Asia/Shanghai' }, timezone: row.timezone || 'Asia/Shanghai', taskId: row.task_id, agentId: row.agent_id, displayName: row.display_name, kind: row.kind, at: row.at, everySeconds: row.every_seconds, expression: row.expression, misfirePolicy: row.misfire_policy, prompt: row.prompt, enabled: Boolean(row.enabled), createdAt: row.created_at, updatedAt: row.updated_at, lastFiredAt: row.last_fired_at };
  }
  function rowToOccurrence(row) {
    return { ...(row.error ? { error: JSON.parse(row.error), errorCode: JSON.parse(row.error).code, detail: JSON.parse(row.error).message } : {}), occurrenceId: row.occurrence_id, taskId: row.task_id, scheduledFor: row.scheduled_for, sessionId: row.session_id, state: row.state, attempt: row.attempt, runId: row.run_id, startedAt: row.started_at, completedAt: row.completed_at };
  }

  return { createSchedule, listSchedules, getSchedule, updateSchedule, deleteSchedule, listOccurrences, runNow, ensureReady, tick, availability: () => ({ triggerActive: typeof runner === 'function' && Boolean(timer), runnerAvailable: typeof runner === 'function' }), dispose: async () => {
    closing = true; clearInterval(timer); timer = null;
    await initialization?.catch(() => {});
    clearInterval(timer); timer = null;
    await Promise.allSettled(running.values()); db?.close(); db = null;
    if (owner) { try { owner.exec('ROLLBACK'); } finally { owner.close(); owner = null; } }
  } };
}
