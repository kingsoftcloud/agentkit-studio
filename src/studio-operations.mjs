/** Local async operation framework for the Studio plugin Node host.
 *
 * Port of the legacy Studio Host OperationManager: idempotency-keyed
 * background tasks whose state and event trail persist as one JSON file per
 * operation, with interrupted-run recovery on startup. The plugin Node host
 * is a long-lived process, so timers replace asyncio tasks.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const OPERATION_STATUSES = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled']);

export class OperationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'OperationError';
    this.code = code;
    this.details = details;
  }
}

export function createOperationManager({ storeDir, clock = Date.now } = {}) {
  const root = storeDir;
  const pending = new Map();
  const ready = (async () => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await recover();
  })();

  function pathOf(operationId) {
    return join(root, `${operationId}.json`);
  }

  async function loadAll() {
    let names;
    try { names = await readdir(root); } catch { return []; }
    const records = [];
    for (const name of names.filter(item => item.endsWith('.json')).sort()) {
      try {
        const parsed = JSON.parse(await readFile(join(root, name), 'utf8'));
        if (parsed?.operation?.id) records.push(parsed);
      } catch { /* corrupted operation record is skipped, not fatal */ }
    }
    return records;
  }

  async function write(record) {
    const target = pathOf(record.operation.id);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    // Atomic tmp+rename: readers poll this file while the host writes it, and
    // a plain in-place write would hand JSON.parse a truncated record.
    const payload = JSON.stringify(record, null, 2);
    const tmp = `${target}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(tmp, payload);
    await rename(tmp, target);
  }

  // Per-operation write lock: run() and cancel() read-modify-write the same
  // file, and stale snapshots must not overwrite fresher states (a cancelled
  // operation must stay cancelled even when its runner timer already fired).
  const locks = new Map();
  function withLock(operationId, fn) {
    const prev = locks.get(operationId) || Promise.resolve();
    const next = prev.then(fn, fn);
    locks.set(operationId, next.catch(() => {}));
    return next;
  }

  async function recover() {
    for (const record of await loadAll()) {
      const operation = record.operation;
      if (operation.status === 'queued' || operation.status === 'running') {
        operation.status = 'failed';
        record.events.push({ at: new Date().toISOString(), type: 'operation.interrupted', data: { reason: 'host restarted before completion' } });
        await write(record);
      }
    }
  }

  async function findByKey(idempotencyKey) {
    for (const record of await loadAll()) {
      if (record.idempotencyKey === idempotencyKey) return record;
    }
    return null;
  }

  async function submit({ kind, resourceId, idempotencyKey, metadata = {}, runner }) {
    if (typeof runner !== 'function') throw new OperationError('OPERATION_RUNNER_MISSING', 'operation 需要 runner');
    const existing = await findByKey(idempotencyKey);
    if (existing) return existing.operation;
    const operation = {
      id: `op_${randomUUID().replace(/-/g, '')}`,
      kind: String(kind || 'operation'),
      resourceId: String(resourceId || ''),
      metadata,
      status: 'queued',
      createdAt: new Date(clock()).toISOString(),
      updatedAt: new Date(clock()).toISOString(),
      result: null,
    };
    const record = { operation, events: [{ at: operation.createdAt, type: 'operation.queued', data: { kind: operation.kind } }], idempotencyKey: String(idempotencyKey || `op-${operation.id}`) };
    await write(record);
    const timer = setTimeout(() => { void run(operation.id, runner); }, 0);
    if (typeof timer.unref === 'function') timer.unref();
    pending.set(operation.id, timer);
    return operation;
  }

  async function run(operationId, runner) {
    // Claim phase holds the lock; the runner itself must not (cancel has to
    // be able to land while a runner is in flight).
    await withLock(operationId, async () => {
      const record = await read(operationId);
      if (!record || record.operation.status !== 'queued') return;
      record.operation.status = 'running';
      record.operation.updatedAt = new Date(clock()).toISOString();
      record.events.push({ at: record.operation.updatedAt, type: 'operation.started', data: {} });
      await write(record);
    });
    const finish = async (status, event, data, result) => {
      await withLock(operationId, async () => {
        const fresh = await read(operationId);
        if (!fresh || fresh.operation.status !== 'running') return;
        fresh.operation.status = status;
        if (result !== undefined) fresh.operation.result = result;
        fresh.operation.updatedAt = new Date(clock()).toISOString();
        fresh.events.push({ at: fresh.operation.updatedAt, type: event, data });
        await write(fresh);
      });
    };
    try {
      const result = await runner(operationId);
      await finish('succeeded', 'operation.succeeded', { summary: String(result && typeof result === 'object' ? (result.summary || result.buildId || result.id || '') : String(result ?? '')) }, result ?? null);
    } catch (error) {
      await finish('failed', 'operation.failed', { message: String(error?.message || error).slice(0, 400) });
    } finally {
      pending.delete(operationId);
    }
  }

  async function read(operationId) {
    try { return JSON.parse(await readFile(pathOf(operationId), 'utf8')); } catch { return null; }
  }

  async function get(operationId) {
    const record = await read(operationId);
    return record?.operation || null;
  }

  async function list({ resourceId, kind } = {}) {
    const records = await loadAll();
    return records
      .map(record => record.operation)
      .filter(operation => (!resourceId || operation.resourceId === resourceId) && (!kind || operation.kind === kind))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  async function cancel(operationId) {
    return withLock(operationId, async () => {
      const record = await read(operationId);
      if (!record) throw new OperationError('OPERATION_NOT_FOUND', 'operation 不存在', { operationId });
      if (['succeeded', 'failed', 'cancelled'].includes(record.operation.status)) return record.operation;
      record.operation.status = 'cancelled';
      record.operation.updatedAt = new Date(clock()).toISOString();
      record.events.push({ at: record.operation.updatedAt, type: 'operation.cancelled', data: {} });
      await write(record);
      return record.operation;
    });
  }

  return { ready, submit, get, list, cancel, events: async operationId => (await read(operationId))?.events || [] };
}
