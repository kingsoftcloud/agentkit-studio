/** Cooperative cross-process exclusion for synchronous workspace publications.
 * Never hold this lock across an await: a same-process contender would block
 * the event loop needed by its owner. SQLite releases it on process death.
 */
import { createHash } from 'node:crypto';
import { closeSync, constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openPrivate, privateDirectory, privateFile } from '../../host/private-state.mjs';
import { realpathExisting } from './workspace-paths.mjs';

const failure = code => Object.assign(new Error(code), { code });
// Keep the native handle strongly reachable even when a caller only uses the
// returned release function for its side effect. V8 may otherwise collect an
// unused closure (and its DatabaseSync) while the lock is intentionally held.
const activeDatabases = new Set();

function workspaceMutationLockPath(path) {
  const target = realpathExisting(resolve(path));
  return join(dirname(target), '.native-locks', `lock-${createHash('sha256').update(target).digest('hex')}.sqlite`);
}

export function acquireWorkspaceMutationLock(path, { timeoutMs = 10000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 120000) throw failure('workspace_lock_timeout_invalid');
  const filename = workspaceMutationLockPath(path);
  privateDirectory(dirname(filename), true);
  // Open/create through the no-follow private file checks before SQLite opens
  // it, including every auxiliary file SQLite might use in this directory.
  const fd = openPrivate(filename, constants.O_RDWR | constants.O_CREAT); closeSync(fd);
  for (const suffix of ['-journal', '-wal', '-shm']) privateFile(filename + suffix, true);
  let db;
  try {
    db = new DatabaseSync(filename);
    // BEGIN IMMEDIATE alone does not necessarily acquire a write lock on a
    // brand-new empty database. Keep a single durable sentinel row so a
    // second process reliably contends on the same SQLite write transaction.
    db.exec(`PRAGMA busy_timeout=${timeoutMs}; CREATE TABLE IF NOT EXISTS workspace_lock (id INTEGER PRIMARY KEY CHECK (id = 1)); BEGIN IMMEDIATE; INSERT OR IGNORE INTO workspace_lock (id) VALUES (1);`);
    activeDatabases.add(db);
  } catch (error) {
    try { db?.close(); } catch {}
    if ([5, 6].includes(error.errcode)) throw failure('workspace_mutation_busy');
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { db.exec('ROLLBACK'); } finally { activeDatabases.delete(db); db.close(); }
  };
}
