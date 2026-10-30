// Real temporary-filesystem path-containment regressions for the SQLite-backed
// per-run artifact lock. The parent reviewer demonstrated that a symlinked
// FINAL component of the lock DB path makes DatabaseSync follow it and write the
// lock_owner schema into a SQLite database OUTSIDE the pinned root. These
// regressions pin every actual dangerous path SQLite may touch — the lock DB
// itself, each SQLite auxiliary file (-journal/-wal/-shm), and the lock
// directory ancestors — plus the TOCTOU boundary between the pre-open
// existence check and the open.
//
// Each regression is on a REAL temp filesystem and asserts the outside file's
// BYTES and SCHEMA are completely unchanged after the rejected write.
//
// Run with: node --test test/native-artifact-lock-paths.test.mjs
// (also run on the Node22 binary; see artifact-path-review-evidence.txt)

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, mkdtempSync, existsSync, rmSync, statSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createNativeArtifactStore } from '../src/native/artifact-store.mjs';
import { scopeDigest, runDigest } from '../src/native/artifact-codec.mjs';

const SCOPE = Object.freeze({ tenantId: 'tenant', workspaceId: 'ws', userId: 'user', agentId: 'agent' });
const HARNESS_DIR = new URL('..', import.meta.url).pathname;

function freshDir() { return mkdtempSync(join(tmpdir(), 'native-art-lock-paths-')); }

function lockPaths(directory, runId) {
  const sd = scopeDigest(SCOPE);
  const rd = runDigest(SCOPE, runId);
  const lockDir = join(directory, 'artifacts', '.locks', sd);
  return { sd, rd, lockDir, lockDb: join(lockDir, rd + '.sqlite') };
}

async function readTables(path) {
  const db = new DatabaseSync(path);
  try {
    return db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((x) => x.name);
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

// Make a real outside SQLite database with a sentinel table + bytes, returning
// { path, bytes, tables }. The bytes are read AFTER close so they reflect the
// committed header + schema pages.
async function makeOutsideDb(dir, name) {
  const path = join(dir, name);
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE original(value TEXT)');
  db.exec("INSERT INTO original VALUES ('sentinel')");
  db.close();
  return { path, bytes: await fs.readFile(path), tables: await readTables(path) };
}

async function attemptWrite(directory, runId) {
  const store = await createNativeArtifactStore({ directory, scope: SCOPE });
  try {
    await store.write({
      scope: SCOPE, runId, sessionId: 's', turnId: 't', buildId: 'b', parentRunId: null, taskChainId: 'c',
      operationKey: 'op', signal: new AbortController().signal,
      content: 'data', mediaType: 'text/plain', metadata: {},
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, code: e.code || String(e.message) };
  }
}

// ---------------------------------------------------------------------------
// A. lock DB final component = symlink to an EXISTING outside SQLite database.
//    Without the fix DatabaseSync follows the symlink and adds lock_owner to
//    the outside DB. The fix rejects at the pre-open lstat; the outside DB's
//    bytes and schema must be byte-identical.

test('lock DB final component is a symlink to an outside SQLite DB: rejected, outside bytes+schema unchanged', async () => {
  const directory = freshDir();
  try {
    const { lockDir, lockDb } = lockPaths(directory, 'run-a');
    await fs.mkdir(lockDir, { recursive: true });
    const outside = await makeOutsideDb(directory, 'outside.sqlite');
    await fs.symlink(outside.path, lockDb);

    const res = await attemptWrite(directory, 'run-a');
    assert.equal(res.ok, false, 'write rejected');
    assert.equal(res.code, 'artifact_symlink_rejected', 'rejected as a symlink final component');

    const afterBytes = await fs.readFile(outside.path);
    assert.ok(afterBytes.equals(outside.bytes), 'outside DB bytes are byte-identical (no header/schema write)');
    assert.deepEqual(await readTables(outside.path), outside.tables, 'outside DB schema unchanged: only [original], no lock_owner');
    assert.ok(!existsSync(lockDb) || lstatSync(lockDb).isSymbolicLink(), 'no real DB created at the symlink path');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// B. lock DB final component = a DANGLING symlink (target does not exist).
//    Without the fix DatabaseSync CREATES a file at the outside target during
//    construction. The fix rejects at the pre-open lstat; no file may appear at
//    the outside target.

test('lock DB final component is a dangling symlink: rejected, no file created at the outside target', async () => {
  const directory = freshDir();
  try {
    const { lockDir, lockDb } = lockPaths(directory, 'run-b');
    await fs.mkdir(lockDir, { recursive: true });
    const danglingTarget = join(directory, 'never-created.sqlite');
    await fs.symlink(danglingTarget, lockDb);

    const res = await attemptWrite(directory, 'run-b');
    assert.equal(res.ok, false, 'write rejected');
    assert.equal(res.code, 'artifact_symlink_rejected', 'rejected as a symlink final component');
    assert.ok(!existsSync(danglingTarget), 'no file created at the dangling outside target');
    assert.ok(!existsSync(lockDb) || statSync(lockDb).isSymbolicLink(), 'the symlink itself remains, no real DB');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// C. ancestor: artifacts/.locks is a symlink to an outside directory.
//    ensureDirSafe's realpath probe catches it before any DB file is opened; no
//    file is created outside.

test('lock ancestor .locks is a symlink to an outside dir: rejected, no file created outside', async () => {
  const directory = freshDir();
  try {
    await fs.mkdir(join(directory, 'artifacts'), { recursive: true });
    const outsideDir = join(directory, 'outside-locks');
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.symlink(outsideDir, join(directory, 'artifacts', '.locks'));

    const res = await attemptWrite(directory, 'run-c');
    assert.equal(res.ok, false, 'write rejected');
    assert.match(res.code, /artifact_path_escape|artifact_symlink_rejected/, 'rejected as an ancestor escape');
    // Nothing created inside the symlinked-outside lock dir.
    const outsideLockRoot = join(outsideDir, lockPaths(directory, 'run-c').sd);
    assert.ok(!existsSync(outsideLockRoot), 'no lock directory created outside the root through the symlink');
    assert.equal((await fs.readdir(outsideDir)).length, 0, 'outside dir stays empty');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// D. ancestor: artifacts/.locks/{scopeDigest} is a symlink to an outside dir.
//    ensureDirSafe catches it (realpath through the symlink, or EEXIST+ lstat
//    on the symlink); no file is created outside.

test('lock ancestor scopeDigest dir is a symlink to an outside dir: rejected, no file created outside', async () => {
  const directory = freshDir();
  try {
    const { sd, lockDir } = lockPaths(directory, 'run-d');
    await fs.mkdir(join(directory, 'artifacts', '.locks'), { recursive: true });
    const outsideSd = join(directory, 'outside-sd');
    await fs.mkdir(outsideSd, { recursive: true });
    await fs.symlink(outsideSd, lockDir);

    const res = await attemptWrite(directory, 'run-d');
    assert.equal(res.ok, false, 'write rejected');
    assert.match(res.code, /artifact_path_escape|artifact_symlink_rejected/, 'rejected as an ancestor escape');
    assert.equal((await fs.readdir(outsideSd)).length, 0, 'outside scopeDigest dir stays empty, no DB created through the symlink');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// E. lock DB = a HARDLINK to an outside SQLite database (same inode, nlink > 1).
//    Without the fix DatabaseSync opens the hardlinked inode and adds lock_owner
//    to the outside DB. The fix rejects at the pre-open nlink check; the outside
//    DB's bytes and schema must be unchanged.

test('lock DB is a hardlink to an outside SQLite DB: rejected, outside bytes+schema unchanged', async () => {
  const directory = freshDir();
  try {
    const { lockDir, lockDb } = lockPaths(directory, 'run-e');
    await fs.mkdir(lockDir, { recursive: true });
    const outside = await makeOutsideDb(directory, 'outside-hl.sqlite');
    await fs.link(outside.path, lockDb);
    assert.equal(statSync(lockDb).nlink, 2, 'hardlink established (nlink == 2)');

    const res = await attemptWrite(directory, 'run-e');
    assert.equal(res.ok, false, 'write rejected');
    assert.equal(res.code, 'artifact_path_escape', 'rejected as a hardlink (nlink > 1)');

    const afterBytes = await fs.readFile(outside.path);
    assert.ok(afterBytes.equals(outside.bytes), 'outside DB bytes are byte-identical');
    assert.deepEqual(await readTables(outside.path), outside.tables, 'outside DB schema unchanged: only [original], no lock_owner');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// F. SQLite rollback journal path (-journal) is a symlink to an outside file.
//    During BEGIN IMMEDIATE SQLite writes journal pages to that path; without
//    the fix the outside file's bytes change. The fix rejects at the pre-open
//    lstat of the aux path; the outside file's bytes must be unchanged.

test('lock DB -journal aux path is a symlink to an outside file: rejected, outside bytes unchanged', async () => {
  const directory = freshDir();
  try {
    const { lockDir, lockDb } = lockPaths(directory, 'run-f');
    await fs.mkdir(lockDir, { recursive: true });
    const sentinel = Buffer.from('JOURNAL-SENTINEL-OUTSIDE');
    const outsideJournal = join(directory, 'outside-journal.bin');
    await fs.writeFile(outsideJournal, sentinel);
    await fs.symlink(outsideJournal, lockDb + '-journal');

    const res = await attemptWrite(directory, 'run-f');
    assert.equal(res.ok, false, 'write rejected');
    assert.equal(res.code, 'artifact_symlink_rejected', 'rejected as a symlink aux path');
    const after = await fs.readFile(outsideJournal);
    assert.ok(after.equals(sentinel), 'outside journal file bytes unchanged (SQLite never wrote through the symlink)');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// G. SQLite WAL path (-wal) is a symlink to an outside file. Same defense; WAL
//    is never enabled here but an attacker could pre-create the trap, and a
//    future WAL change must stay covered.

test('lock DB -wal aux path is a symlink to an outside file: rejected, outside bytes unchanged', async () => {
  const directory = freshDir();
  try {
    const { lockDir, lockDb } = lockPaths(directory, 'run-g');
    await fs.mkdir(lockDir, { recursive: true });
    const sentinel = Buffer.from('WAL-SENTINEL-OUTSIDE');
    const outsideWal = join(directory, 'outside-wal.bin');
    await fs.writeFile(outsideWal, sentinel);
    await fs.symlink(outsideWal, lockDb + '-wal');

    const res = await attemptWrite(directory, 'run-g');
    assert.equal(res.ok, false, 'write rejected');
    assert.equal(res.code, 'artifact_symlink_rejected', 'rejected as a symlink aux path');
    const after = await fs.readFile(outsideWal);
    assert.ok(after.equals(sentinel), 'outside WAL file bytes unchanged');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// H. SQLite shared-memory path (-shm) is a symlink to an outside file.

test('lock DB -shm aux path is a symlink to an outside file: rejected, outside bytes unchanged', async () => {
  const directory = freshDir();
  try {
    const { lockDir, lockDb } = lockPaths(directory, 'run-h');
    await fs.mkdir(lockDir, { recursive: true });
    const sentinel = Buffer.from('SHM-SENTINEL-OUTSIDE');
    const outsideShm = join(directory, 'outside-shm.bin');
    await fs.writeFile(outsideShm, sentinel);
    await fs.symlink(outsideShm, lockDb + '-shm');

    const res = await attemptWrite(directory, 'run-h');
    assert.equal(res.ok, false, 'write rejected');
    assert.equal(res.code, 'artifact_symlink_rejected', 'rejected as a symlink aux path');
    const after = await fs.readFile(outsideShm);
    assert.ok(after.equals(sentinel), 'outside SHM file bytes unchanged');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// I. TOCTOU boundary: the path passes the pre-open existence check, then is
//    swapped to a symlink to an outside SQLite DB before DatabaseSync opens it.
//    This is the boundary a pure existence check cannot cover. The post-open
//    realpath guard in openAndAcquireLock must close BEFORE BEGIN IMMEDIATE so
//    the lock_owner schema is never written outside the root. Driven by the
//    env-gated NATIVE_ARTIFACT_SWAP_LOCK_DB_TO test hook (inert in production).

test('TOCTOU swap of the lock DB to an outside symlink between check and open: rejected, outside bytes+schema unchanged', async () => {
  const directory = freshDir();
  process.env.NATIVE_ARTIFACT_SWAP_LOCK_DB_TO = ''; // ensure clean baseline
  try {
    const { lockDb } = lockPaths(directory, 'run-i');
    const outside = await makeOutsideDb(directory, 'outside-toctou.sqlite');
    process.env.NATIVE_ARTIFACT_SWAP_LOCK_DB_TO = outside.path;

    const res = await attemptWrite(directory, 'run-i');
    assert.equal(res.ok, false, 'write rejected');
    assert.equal(res.code, 'artifact_path_escape', 'post-open realpath guard rejected the escaped DB before BEGIN IMMEDIATE');

    const afterBytes = await fs.readFile(outside.path);
    assert.ok(afterBytes.equals(outside.bytes), 'outside DB bytes are byte-identical (no schema write)');
    assert.deepEqual(await readTables(outside.path), outside.tables, 'outside DB schema unchanged: only [original], no lock_owner');
    // The swap hook left a symlink at the lock DB path; the real lock DB was
    // never created at an outside location.
    assert.ok(!existsSync(lockDb) || lstatSync(lockDb).isSymbolicLink(), 'the symlink remains in place; no real DB created outside');
  } finally {
    delete process.env.NATIVE_ARTIFACT_SWAP_LOCK_DB_TO;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// J. control: with NO trap, a normal write still succeeds and the lock DB is a
//    regular file inside the root. Ensures the new path checks do not reject a
//    legitimate lock DB.

test('control: no trap — a normal write succeeds and the lock DB is a regular in-root file', async () => {
  const directory = freshDir();
  try {
    const store = await createNativeArtifactStore({ directory, scope: SCOPE });
    const ref = await store.write({
      scope: SCOPE, runId: 'run-j', sessionId: 's', turnId: 't', buildId: 'b', parentRunId: null, taskChainId: 'c',
      operationKey: 'op', signal: new AbortController().signal,
      content: 'data', mediaType: 'text/plain', metadata: {},
    });
    assert.ok(ref.uri, 'write succeeded');
    const { lockDb } = lockPaths(directory, 'run-j');
    assert.ok(existsSync(lockDb), 'lock DB exists');
    const st = statSync(lockDb);
    assert.ok(st.isFile(), 'lock DB is a regular file');
    assert.equal(st.nlink, 1, 'lock DB is not hardlinked (nlink == 1)');
    assert.ok(!st.isSymbolicLink(), 'lock DB is not a symlink');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
