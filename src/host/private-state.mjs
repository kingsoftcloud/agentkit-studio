// Studio's private host files and SQLite locks. Persisted files and error codes
// are kept compatible with earlier Studio releases.
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

function check(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { name: 'LocalCommandError', code });
}

function noSymlinks(path) {
  for (let part = resolve(path);; part = dirname(part)) {
    try { check(!lstatSync(part).isSymbolicLink(), 'background_state_symlink'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (dirname(part) === part) break;
  }
}
function hasPrivatePermissions(path, stat) {
  return process.platform === 'win32' ? verifyWindowsPrivateState(resolve(path), stat)
    : stat.uid === process.getuid() && (stat.mode & 0o077) === 0;
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
  check(stat.isDirectory() && hasPrivatePermissions(path, stat), 'background_state_not_private');
}
export function privateFile(path, allowMissing = false) {
  try {
    const stat = lstatSync(path);
    check(stat.isFile() && hasPrivatePermissions(path, stat),
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
      // Host writers atomically replace files. A read opened
      // across that publication must retry the newly verified private inode.
      // Never retry writes, unsafe permissions/links, or persistent churn.
      if (flags !== constants.O_RDONLY || error.code !== 'background_state_changed' || attempt >= 3) throw error;
    }
  }
}
export function syncDirectory(directory) {
  // Node opens directory handles read-only on Windows. File data is still
  // flushed before rename, and SQLite journals use their native Windows VFS.
  if (process.platform === 'win32') return;
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
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
// SQLite releases the write lock if the owner exits or crashes. Guard both
// the database pathname and SQLite sidecars before attempting to lock.
export function tryLock(path, busyTimeoutMs = 0) {
  check(Number.isSafeInteger(busyTimeoutMs) && busyTimeoutMs >= 0 && busyTimeoutMs <= 5000, 'invalid_lock_timeout');
  privateDirectory(dirname(path));
  if (!privateFile(path, true)) {
    try { createPrivate(path); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const before = privateFile(path);
  for (const suffix of ['-journal', '-wal', '-shm']) {
    try { privateFile(path + suffix, true); }
    catch (error) {
      // SQLite may unlink a sidecar while another owner checks its lstat.
      // No lock has been acquired or effect dispatched: treat this transient
      // tombstone as contention, then verify the next acquisition afresh.
      // Main database drift, links and unsafe permissions remain hard errors.
      if (error.code === 'background_state_changed') return null;
      throw error;
    }
  }
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
export async function lockUntil(path, deadline, signal) {
  for (;;) {
    signal?.throwIfAborted();
    const release = tryLock(path);
    if (release) return release;
    check(performance.now() < deadline, 'background_command_lock_timeout');
    await delay(20, undefined, { signal });
  }
}
export function readAll(path) {
  const fd = openPrivate(path, constants.O_RDONLY);
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(fd)); }
  finally { closeSync(fd); }
}

// Windows mode bits and uid do not describe NTFS access. Resolve security
// identifiers directly so the check does not depend on localized account names.
const checkAcl = Buffer.from(String.raw`
$ErrorActionPreference = 'Stop'
$sidType = [System.Security.Principal.SecurityIdentifier]
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$trusted = @($user, 'S-1-5-18', 'S-1-5-32-544')
$acl = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $env:AGENTKIT_WINDOWS_PRIVATE_STATE_PATH
if ($acl.GetOwner($sidType).Value -notin $trusted) { exit 2 }
foreach ($entry in $acl.GetAccessRules($true, $true, $sidType)) {
  if ($entry.AccessControlType -ne 'Allow') { continue }
  $principal = $entry.IdentityReference.Value
  if ($principal -in $trusted) { continue }
  $inheritOnly = $entry.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly
  if ($principal -eq 'S-1-3-0' -and $inheritOnly) { continue }
  exit 2
}
`, 'utf16le').toString('base64');

const verified = new Map();

function verifyWindowsPrivateState(path, stat) {
  const identity = [stat.dev, stat.ino, stat.birthtimeMs, stat.ctimeMs].join(':');
  if (verified.get(path) === identity) return true;
  const root = process.env.SystemRoot;
  if (!root) return false;
  const executable = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', checkAcl], {
    env: { SystemRoot: root, AGENTKIT_WINDOWS_PRIVATE_STATE_PATH: path },
    stdio: 'ignore', windowsHide: true, timeout: 5000,
  });
  if (result.status !== 0 || result.error) return false;
  // Only the accepted principals can change an accepted ACL. File replacement
  // or metadata changes require a fresh check.
  if (verified.size >= 1024) verified.clear();
  verified.set(path, identity);
  return true;
}
