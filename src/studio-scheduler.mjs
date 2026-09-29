/** Local schedule store and cron engine for the Studio plugin Node host.
 *
 * Port of the legacy Studio scheduler: SQLite-backed schedules and
 * occurrences, a 30-second tick that fires due tasks, and misfire handling.
 * The runner is injected; until a run contract exists, due occurrences are
 * recorded as `failed` with an honest gap message.
 */
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync as Database } from 'node:sqlite';

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
  const dbPath = join(storeDir, 'scheduler.sqlite3');
  let db = null;
  let timer = null;
  const runOccurrence = async (row, scheduledFor = new Date(clock.now())) => {
    const occurrenceId = `occ_${randomUUID().replace(/-/g, '')}`;
    const sessionId = `ses_${randomUUID().replace(/-/g, '')}`;
    const scheduledAt = scheduledFor.toISOString();
    db.prepare('INSERT INTO occurrences (occurrence_id, task_id, scheduled_for, session_id, state, attempt, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(occurrenceId, row.task_id, scheduledAt, sessionId, 'running', 1, scheduledAt);
    db.prepare('UPDATE schedules SET last_fired_at = ?, updated_at = ? WHERE task_id = ?').run(scheduledAt, scheduledAt, row.task_id);
    if (typeof runner === 'function') {
      try {
        const result = await runner({ occurrenceId, taskId: row.task_id, agentId: row.agent_id, sessionId, input: row.prompt });
        db.prepare('UPDATE occurrences SET state = ?, completed_at = ?, run_id = ? WHERE occurrence_id = ?').run('succeeded', new Date(clock.now()).toISOString(), String(result?.runId || ''), occurrenceId);
      } catch {
        db.prepare('UPDATE occurrences SET state = ?, completed_at = ? WHERE occurrence_id = ?').run('failed', new Date(clock.now()).toISOString(), occurrenceId);
      }
    } else {
      db.prepare('UPDATE occurrences SET state = ?, completed_at = ? WHERE occurrence_id = ?').run('failed', new Date(clock.now()).toISOString(), occurrenceId);
    }
    return rowToOccurrence(db.prepare('SELECT * FROM occurrences WHERE occurrence_id = ?').get(occurrenceId));
  };

  const tick = async () => {
    if (!db) return;
    const now = new Date(clock.now());
    const rows = db.prepare('SELECT * FROM schedules WHERE enabled = 1').all();
    for (const row of rows) {
      let fire = false;
      if (row.kind === 'once') { if (new Date(row.next_fire_at) <= now) fire = true; }
      else if (row.kind === 'interval') { const last = row.last_fired_at ? new Date(row.last_fired_at) : new Date(row.created_at); if (new Date(last.getTime() + Number(row.every_seconds) * 1000) <= now) fire = true; }
      else if (row.kind === 'cron') { const fields = JSON.parse(row.cron_fields); if (cronMatches(now, fields)) fire = true; }
      if (!fire) continue;
      if (row.kind === 'once' && row.last_fired_at) continue;
      await runOccurrence(row, now);
    }
  };

  async function ensureReady() {
    if (db) return;
    await mkdir(storeDir, { recursive: true, mode: 0o700 });
    db = new Database(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS schedules (task_id TEXT PRIMARY KEY, agent_id TEXT, display_name TEXT, kind TEXT, at TEXT, every_seconds INTEGER, expression TEXT, cron_fields TEXT, misfire_policy TEXT DEFAULT 'skip', prompt TEXT, enabled INTEGER DEFAULT 1, created_at TEXT, updated_at TEXT, last_fired_at TEXT, next_fire_at TEXT);
      CREATE TABLE IF NOT EXISTS occurrences (occurrence_id TEXT PRIMARY KEY, task_id TEXT, scheduled_for TEXT, session_id TEXT, state TEXT DEFAULT 'claimed', attempt INTEGER DEFAULT 1, run_id TEXT, started_at TEXT, completed_at TEXT);
      CREATE INDEX IF NOT EXISTS idx_occ_task ON occurrences(task_id);
    `);
    timer = setInterval(() => { void tick(); }, tickIntervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    void tick();
  }

  function validateSpec(spec) {
    const kind = String(spec.kind || '');
    if (!SCHEDULE_KINDS.has(kind)) throw new StudioSchedulerError('SCHEDULE_KIND_INVALID', `kind 必须是 once/interval/cron`);
    if (kind === 'once' && !spec.at) throw new StudioSchedulerError('SCHEDULE_SPEC_INVALID', 'once 需要 at');
    if (kind === 'interval' && (!spec.everySeconds || Number(spec.everySeconds) < 1)) throw new StudioSchedulerError('SCHEDULE_SPEC_INVALID', 'interval 需要 everySeconds');
    if (kind === 'cron') { const fields = parseCron(spec.expression); return JSON.stringify(fields); }
    return null;
  }

  async function createSchedule(agentId, spec = {}) {
    await ensureReady();
    const taskId = String(spec.taskId || `task-${randomUUID().slice(0, 8)}`);
    if (!TASK_ID_RE.test(taskId)) throw new StudioSchedulerError('TASK_ID_INVALID', 'task_id 格式必须是 ^[a-z][a-z0-9-]{2,62}$');
    const cronFields = validateSpec(spec);
    const now = new Date(clock.now()).toISOString();
    db.prepare('INSERT INTO schedules (task_id, agent_id, display_name, kind, at, every_seconds, expression, cron_fields, misfire_policy, prompt, enabled, created_at, updated_at, last_fired_at, next_fire_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)').run(taskId, String(agentId || ''), String(spec.displayName || ''), String(spec.kind), String(spec.at || ''), Number(spec.everySeconds) || 0, String(spec.expression || ''), cronFields, String(spec.misfirePolicy || 'skip'), String(spec.prompt || ''), 1, now, now, spec.at || null);
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
    const current = db.prepare('SELECT * FROM schedules WHERE task_id = ?').get(taskId);
    if (!current) throw new StudioSchedulerError('SCHEDULE_NOT_FOUND', '调度任务不存在', { taskId });
    const merged = { ...rowToSchedule(current), ...patch };
    const cronFields = patch.kind || patch.expression ? validateSpec(merged) : current.cron_fields;
    db.prepare('UPDATE schedules SET display_name = ?, kind = ?, at = ?, every_seconds = ?, expression = ?, cron_fields = ?, misfire_policy = ?, prompt = ?, enabled = ?, updated_at = ? WHERE task_id = ?').run(String(merged.displayName || ''), String(merged.kind || current.kind), String(merged.at || ''), Number(merged.everySeconds) || 0, String(merged.expression || ''), cronFields, String(merged.misfirePolicy || 'skip'), String(merged.prompt || ''), merged.enabled !== false ? 1 : 0, new Date(clock.now()).toISOString(), taskId);
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
    return { taskId: row.task_id, agentId: row.agent_id, displayName: row.display_name, kind: row.kind, at: row.at, everySeconds: row.every_seconds, expression: row.expression, misfirePolicy: row.misfire_policy, prompt: row.prompt, enabled: Boolean(row.enabled), createdAt: row.created_at, updatedAt: row.updated_at, lastFiredAt: row.last_fired_at };
  }
  function rowToOccurrence(row) {
    return { occurrenceId: row.occurrence_id, taskId: row.task_id, scheduledFor: row.scheduled_for, sessionId: row.session_id, state: row.state, attempt: row.attempt, runId: row.run_id, startedAt: row.started_at, completedAt: row.completed_at };
  }

  return { createSchedule, listSchedules, getSchedule, updateSchedule, deleteSchedule, listOccurrences, runNow, ensureReady, tick };
}
