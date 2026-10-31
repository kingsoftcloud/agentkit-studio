// Host-private persistence for local background commands. No workspace imports.
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { validCommandEvidence } from './local-command-evidence.mjs';

export const LOCAL_BACKGROUND_CONTRACT = 'agentkit.local-background-command/v1';
export const START_GRACE_MS = 5000;
export const TERMINAL = new Set(['completed', 'failed', 'canceled', 'timed_out', 'output_limit', 'unknown']);
export class LocalCommandError extends Error { constructor(code) { super(code); this.name = 'LocalCommandError'; this.code = code; } }
export const check = (condition, code) => { if (!condition) throw new LocalCommandError(code); };
export const validId = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export const digest = value => createHash('sha256').update(JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)).digest('hex');

function noSymlinks(path) {
  for (let part = resolve(path);; part = dirname(part)) {
    try { check(!lstatSync(part).isSymbolicLink(), 'background_state_symlink'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (dirname(part) === part) break;
  }
}
export function privateDirectory(path, create = false) {
  noSymlinks(path);
  if (create) {
    const missing = [];
    for (let part = resolve(path); !existsSync(part); part = dirname(part)) missing.push(part);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    for (const part of missing.reverse()) { syncDirectory(part); syncDirectory(dirname(part)); }
  }
  const stat = lstatSync(path);
  check(stat.isDirectory() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0, 'background_state_not_private');
}
export function privateFile(path, allowMissing = false) {
  try {
    const stat = lstatSync(path);
    check(stat.isFile() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0,
      'background_state_not_private');
    // Atomic publication can unlink the inode while lstat is observing it.
    // It is never usable evidence; read-only callers may retry the new inode.
    check(stat.nlink !== 0, 'background_state_changed');
    check(stat.nlink === 1, 'background_state_not_private');
    return stat;
  } catch (error) { if (allowMissing && error.code === 'ENOENT') return null; throw error; }
}
export function openPrivate(path, flags) {
  for (let attempt = 0; ; attempt++) {
    let fd;
    try {
      privateDirectory(dirname(path)); privateFile(path, true);
      fd = openSync(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      const stat = fstatSync(fd), current = privateFile(path);
      check(stat.isFile() && stat.dev === current.dev && stat.ino === current.ino, 'background_state_changed');
      return fd;
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      // The supervisor atomically replaces outputs and records. A read opened
      // across that publication must retry the newly verified private inode.
      // Never retry writes, unsafe permissions/links, or persistent churn.
      if (flags !== constants.O_RDONLY || error.code !== 'background_state_changed' || attempt >= 3) throw error;
    }
  }
}
export function syncDirectory(directory) {
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
// Fsync an existing private file's complete contents in place, without reading
// it into memory. Used by the supervisor to durably persist streamed output files
// before publishing the terminal receipt, so a crash never loses full output
// that the preview-only receipt cannot reconstruct. Never overwrites the file.
export function fsyncPrivate(path) {
  const fd = openPrivate(path, constants.O_WRONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function atomicPrivate(path, bytes) {
  privateDirectory(dirname(path)); privateFile(path, true);
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    const fd = openPrivate(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    privateFile(path, true); renameSync(temporary, path); syncDirectory(dirname(path));
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
export function createPrivate(path) {
  const fd = openPrivate(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL);
  try { fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(dirname(path));
}
export function readRecord(directory, owner, commandId) {
  privateDirectory(directory);
  const fd = openPrivate(join(directory, 'record.json'), constants.O_RDONLY);
  let record;
  try {
    check(fstatSync(fd).size <= 65536, 'invalid_background_record');
    try { record = JSON.parse(readFileSync(fd, 'utf8')); }
    catch { throw new LocalCommandError('invalid_background_record'); }
  } finally { closeSync(fd); }
  check(record && record.schemaVersion === LOCAL_BACKGROUND_CONTRACT && record.owner === owner && record.commandId === commandId
    && validId(owner) && validId(commandId) && validId(record.requestDigest)
    && ['starting', 'running', ...TERMINAL].includes(record.status)
    && Number.isSafeInteger(record.createdAt) && record.createdAt > 0
    && Number.isSafeInteger(record.timeoutMs) && record.timeoutMs > 0
    && (record.exitCode === null || Number.isSafeInteger(record.exitCode)), 'invalid_background_record');
  check((!['starting', 'running', 'unknown'].includes(record.status) || record.exitCode === null)
    && (record.status !== 'completed' || record.exitCode === 0)
    && (record.status !== 'failed' || Number.isSafeInteger(record.exitCode) && record.exitCode !== 0)
    && (record.status !== 'timed_out' || record.exitCode === 124)
    && (record.status !== 'output_limit' || record.exitCode === 122)
    && (record.supervisorPid === undefined || Number.isSafeInteger(record.supervisorPid) && record.supervisorPid > 0)
    && (record.evidenceIncomplete === undefined || typeof record.evidenceIncomplete === 'boolean')
    && (record.observedExitCode === undefined || record.observedExitCode === null || Number.isSafeInteger(record.observedExitCode)),
    'invalid_background_record');
  check(record.commandEvidence === undefined || validCommandEvidence(record.commandEvidence), 'invalid_background_record');
  return record;
}
export function writeRecord(directory, record) {
  atomicPrivate(join(directory, 'record.json'), JSON.stringify(record) + '\n');
}
export function unknownRecord(directory, record, outcomeReason) {
  const next = { ...record, status: 'unknown', exitCode: null, completedAt: Date.now(), evidenceIncomplete: true, outcomeReason };
  writeRecord(directory, next); return next;
}

// Each command has a separate SQLite lock database. The supervisor holds its
// write transaction for its entire lifetime; command records/output remain
// independently readable. A crash releases the kernel lock, with no PID test.
// node:sqlite has no O_NOFOLLOW option. Private ancestors and inode checks
// reject persistent substitutions; this is not isolation from a malicious uid.
export function tryLock(path, busyTimeoutMs = 0) {
  check(Number.isSafeInteger(busyTimeoutMs) && busyTimeoutMs >= 0 && busyTimeoutMs <= 5000, 'invalid_lock_timeout');
  privateDirectory(dirname(path));
  if (!privateFile(path, true)) {
    try { createPrivate(path); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const before = privateFile(path);
  for (const suffix of ['-journal', '-wal', '-shm']) privateFile(path + suffix, true);
  let db;
  try {
    db = new DatabaseSync(path);
    const after = privateFile(path);
    check(before.dev === after.dev && before.ino === after.ino, 'background_state_changed');
    db.exec(`PRAGMA busy_timeout=${busyTimeoutMs}; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;`);
    return () => { try { db.exec('ROLLBACK'); } finally { db.close(); } };
  } catch (error) {
    db?.close();
    if (error.errcode === 5 || error.errcode === 6) return null;
    throw error;
  }
}
export async function lockUntil(path, deadline) {
  for (;;) {
    const release = tryLock(path);
    if (release) return release;
    check(performance.now() < deadline, 'background_command_lock_timeout');
    await delay(20);
  }
}
export function readWindow(path, cursor, maxBytes) {
  check(Number.isSafeInteger(cursor) && cursor >= 0, 'invalid_background_output_cursor');
  const fd = openPrivate(path, constants.O_RDONLY);
  try {
    const size = fstatSync(fd).size;
    check(cursor <= size, 'background_output_cursor_past_end');
    const data = Buffer.alloc(Math.min(maxBytes, size - cursor));
    const length = readSync(fd, data, 0, data.length, cursor);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data.subarray(0, length), { stream: true }); }
    catch { throw new LocalCommandError('background_output_cursor_not_utf8_boundary'); }
    const next = cursor + Buffer.byteLength(text);
    return { text, cursor: next, hasMore: next < size };
  } finally { closeSync(fd); }
}
export function readAll(path) {
  const fd = openPrivate(path, constants.O_RDONLY);
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(fd)); }
  finally { closeSync(fd); }
}
