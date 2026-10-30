/** Cooperative cross-process exclusion for synchronous workspace publications.
 * Never hold this lock across an await: a same-process contender would block
 * the event loop needed by its owner. SQLite releases it on process death.
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { constants } from 'node:fs';
import { canonical } from '@kingsoftcloud/agentkit-harness-core';
import { openPrivate, privateDirectory, privateFile } from './local-command-state.mjs';

export const WORKSPACE_MUTATION_LOCK = 'agentkit.workspace-mutation-lock/v1';
const failure = code => Object.assign(new Error(code), { code });

function canonicalTarget(path) {
  let parent = resolve(path); const missing = [];
  while (!existsSync(parent)) { missing.unshift(basename(parent)); parent = dirname(parent); }
  return join(realpathSync(parent), ...missing);
}

export function workspaceMutationLockPath(path) {
  const target = canonicalTarget(path);
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
    db.exec(`PRAGMA busy_timeout=${timeoutMs}; BEGIN IMMEDIATE;`);
  } catch (error) {
    try { db?.close(); } catch {}
    if ([5, 6].includes(error.errcode)) throw failure('workspace_mutation_busy');
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { db.exec('ROLLBACK'); } finally { db.close(); }
  };
}

/** Detect identity replacement as well as in-place mutation after permission
 * waits or SQLite waits. assertCurrent is the Host's live ledger/fence check. */
export function workspaceMutationGuard(request, assertCurrent, checkRoot) {
  if (assertCurrent != null && typeof assertCurrent !== 'function') throw failure('workspace_authority_invalid');
  const fields = ['scope', 'sessionId', 'runId', 'turnId', 'buildId', 'parentRunId', 'taskChainId',
    'operationKey', 'executionFence', 'call', 'definition', 'interaction', 'contract', 'originalOperationKey', 'originalClaimedFence'];
  const identity = () => canonical(Object.fromEntries(fields.filter(key => request[key] !== undefined).map(key => [key, request[key]])));
  const before = identity(), signal = request.signal;
  return () => {
    checkRoot();
    if (signal !== request.signal || before !== identity()) throw failure('workspace_execution_context_changed');
    signal?.throwIfAborted();
    if (assertCurrent && assertCurrent(request) !== true) throw failure('workspace_execution_authority_changed');
  };
}
