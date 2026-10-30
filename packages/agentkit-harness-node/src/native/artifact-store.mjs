/**
 * Native Node artifact storage adapter.
 *
 * Exports {@link createNativeArtifactStore}, a factory that binds one
 * trusted {@link RunScope} to a directory and returns an object that
 * structurally satisfies the core ArtifactPort (write/read/search) plus a
 * usageBytes helper for later persistent budget reconciliation.
 *
 * Design contract (see contracts.mts ArtifactPort / ArtifactRef /
 * PortContext). This stage covers durable storage, content integrity,
 * pagination and current-run search only. Core overflow scheduling, the
 * ArtifactRead retention tool, available_artifacts permissions, cross-turn
 * inheritance and the full context page-budget are wired by Codex later; do
 * not assume they exist here.
 *
 * Cross-process publication discipline: every write to a run directory is
 * serialized by a per-run SQLite database acquired with BEGIN IMMEDIATE (see
 * the lock section below), so two writers across separate processes/instances
 * never publish to the same run concurrently. Under the lock the writer (a)
 * reconciles an existing sealed record for the identity (idempotent /
 * conflict), else (b) writes a pending-intent sidecar pinning the *complete*
 * write identity (content digest + size + mediaType + metadata) before
 * publishing content, then (c) enforces the per-run byte quota atomically,
 * (d) publishes content, (e) seals with the meta sidecar, (f) deletes the
 * intent. A crash leaves an orphan content + intent pair; the next
 * same-identity write reconciles it against the locked intent (rejecting
 * changed type/metadata). A crash after sealing leaves a sealed artifact the
 * caller may not have received, which usageBytes still counts. The lock is
 * owned by the holder's LIVE database connection: when the owning process
 * dies the OS reclaims its file descriptors and SQLite drops the write lock
 * automatically, so there is NO stale-lock takeover and NO window in which
 * two writers both believe they hold the lock — the next writer simply
 * acquires fresh and finishes any interrupted publication under its own
 * transaction.
 */

import { promises as fs, constants as fsConstants, realpathSync } from 'node:fs';
const O_NOFOLLOW = fsConstants.O_NOFOLLOW;
const O_RDONLY = fsConstants.O_RDONLY;
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { parseNativeJson } from '@kingsoftcloud/agentkit-harness-core/model-json';
import {
  assertNonEmptyString, buildArtifactUri, canonicalStringify, decodeUtf8Fatal,
  encodeUtf8, identityDigest, jsonEquals, parseArtifactUri, runDigest,
  safeJsonParse, scopeDigest, scopeEquals, sha256Hex, sliceByCodePoints,
  tempNonce, validateMediaType, validateMetadataObject, validateRef,
  validateScope, validateBytesOption, validateLimitOption, validateDurableRecord,
} from './artifact-codec.mjs';

const DEFAULT_MAX_READ_CHARS = 32000;
const DEFAULT_MAX_SEARCH_MATCHES = 16;
const DEFAULT_MAX_QUERY_CHARS = 1024;
const DEFAULT_MAX_SCAN_BYTES = 1024 * 1024;
const DEFAULT_MAX_ITEM_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;

const CONTENT_SUFFIX = '.content';
const META_SUFFIX = '.meta.json';
const INTENT_SUFFIX = '.intent.json';
const LOCK_NAME = '.lock';
const TMP_INFIX = '.tmp.';
const HEX64 = /^[0-9a-f]{64}$/;
const HOST = hostname();

// Async retry interval while waiting for a busy SQLite lock. This is never a
// synchronous wait (see acquireRunLock): busy_timeout is 0 so a contending
// taker throws immediately and retries via setTimeout, leaving the event loop
// free for a same-process owner's pending filesystem await to proceed.
const LOCK_POLL_MS = 50;
// Safety bound only. A crashed holder releases immediately — the OS reclaims the
// connection's file descriptors and SQLite drops the write lock — so this bounds
// only the wait for a live but slow holder. It is NOT a staleness threshold and
// there is no stale-lock takeover.
const LOCK_TIMEOUT_MS = 120000;
// Safety bound for the LIVE release commit only. COMMIT may briefly get
// SQLITE_BUSY when a concurrent taker is opening the lock database (a transient
// SHARED lock during its schema read); the transient reader releases in
// milliseconds, so this only bounds a pathologically stuck contender. Process
// death never reaches release() — the OS reclaims the fd and SQLite drops the
// lock — so this does not affect crash release.
const LOCK_RELEASE_TIMEOUT_MS = 10000;
const SQLITE_BUSY = 5;

// SQLite auxiliary files that may be created beside the lock database. The
// rollback journal (-journal) is created and removed per transaction in the
// default journal mode; -wal/-shm exist only under WAL (never enabled here).
// An attacker who can write the lock directory could pre-create any of them as
// a symlink/hardlink trap so SQLite writes journal contents outside the root,
// so every path SQLite may touch is validated before the database is opened.
const SQLITE_AUX_SUFFIXES = ['-journal', '-wal', '-shm'];

function err(code, message) {
  return Object.assign(new Error(message || code), { code });
}

function checkSignal(signal) {
  if (signal && signal.aborted) {
    if (signal.reason instanceof Error) throw signal.reason;
    throw err('artifact_aborted', 'artifact_aborted');
  }
}

/** Test-only crash hook: exit at a controlled publish position. Inert when
 * unset OR when no point is supplied (so the null-hook recovery path never
 * trips the hook). */
function crashHook(point) {
  if (point !== undefined && point !== null && process.env.NATIVE_ARTIFACT_CRASH_AFTER === point) {
    process.exit(0);
  }
}

/** Test-only hold hook: pause at a controlled publish position while still
 * holding the run lock, so a deterministic boundary-scheduling test can prove a
 * concurrent taker waits (SQLITE_BUSY retry) rather than split-braining. Inert
 * unless NATIVE_ARTIFACT_HOLD_AT matches the point AND NATIVE_ARTIFACT_HOLD_MS
 * is a positive number. Never affects production (env unset). */
async function holdHook(point) {
  if (point !== undefined && point !== null && process.env.NATIVE_ARTIFACT_HOLD_AT === point) {
    const ms = Number(process.env.NATIVE_ARTIFACT_HOLD_MS);
    if (Number.isFinite(ms) && ms > 0) await new Promise((r) => setTimeout(r, ms));
  }
}

/** Test-only signal: atomically drop a sentinel file once the run lock is held,
 * so a boundary-scheduling test can deterministically start a competing taker
 * AFTER the holder has acquired (no spawn-timing race). Inert unless
 * NATIVE_ARTIFACT_SIGNAL_LOCK_FILE is set. Never affects production. */
async function signalLockAcquired() {
  const f = process.env.NATIVE_ARTIFACT_SIGNAL_LOCK_FILE;
  if (!f) return;
  const tmp = f + '.tmp.' + tempNonce();
  let fh;
  try {
    fh = await fs.open(tmp, 'wx', 0o600);
    await fh.writeFile(String(process.pid));
    await fh.sync();
  } finally {
    try { if (fh) await fh.close(); } catch { /* ignore */ }
  }
  try {
    await fs.link(tmp, f);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  } finally {
    await safeUnlink(tmp);
  }
}

/** Test-only TOCTOU hook: after the static pre-open validation passes and before
 * the database is opened, replace the lock DB file at `path` with a symlink to
 * NATIVE_ARTIFACT_SWAP_LOCK_DB_TO, deterministically simulating a concurrent swap
 * of the path between the existence check and the open. This lets a regression
 * prove the post-open realpath guard in openAndAcquireLock rejects the escape
 * BEFORE the lock_owner schema is written outside the root. Inert unless the env
 * var is set. Never affects production. */
async function swapHookForLockDb(path) {
  const target = process.env.NATIVE_ARTIFACT_SWAP_LOCK_DB_TO;
  if (!target) return;
  try { await fs.unlink(path); } catch { /* may not exist yet */ }
  await fs.symlink(target, path);
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Platform-independent containment: target is inside root when the relative
 * path from root to target is empty, or a relative path that does not start
 * with '..' and is not absolute. This correctly rejects cross-volume
 * escapes (relative becomes '../..' or absolute on Windows) and does not
 * depend on the path separator. Both inputs must be normalized (we pass
 * realpath-resolved absolute paths). On case-insensitive filesystems the
 * resolved paths reflect the filesystem's own case; on case-sensitive ones
 * a different case resolves outside, as expected.
 */
function isWithin(target, root) {
  if (typeof target !== 'string' || typeof root !== 'string') return false;
  const rel = relative(root, target);
  if (rel === '') return true; // target === root
  if (isAbsolute(rel)) return false; // cross-volume / different drive
  if (rel === '..' || rel.startsWith('..' + sep) || rel.startsWith('..' + '/')) return false;
  // A relative path with no '..' leading segment and not absolute is inside.
  // Also reject any '..' segment anywhere (e.g. 'a/../../b').
  const segs = rel.split(/[\\/]/);
  if (segs.includes('..')) return false;
  return true;
}

function assertWithin(target, root) {
  if (!isWithin(target, root)) throw err('artifact_path_escape', 'artifact_path_escape');
}

/** Resolve the artifacts root, pinning it. Creates {dir}/artifacts and
 * returns both the logical root ({dir}) and the realpath of the artifacts
 * directory (used for containment checks). Run directories live under
 * {root}/artifacts/{scopeDigest}/{runDigest} — a single artifacts layer. */
async function initRoot(directory) {
  if (typeof directory !== 'string' || directory.length === 0) {
    throw err('invalid_artifact_directory', 'invalid_artifact_directory');
  }
  const resolved = directory.startsWith('file:') ? fileURLToPath(new URL(directory)) : resolve(directory);
  const artifactsDir = join(resolved, 'artifacts');
  await fs.mkdir(artifactsDir, { recursive: true });
  const rootReal = await fs.realpath(artifactsDir);
  return { root: resolved, rootReal };
}

/** lstat; null on ENOENT. Throws on a symlink final component (no-follow). */
async function lstatNoFollow(absPath) {
  let st;
  try {
    st = await fs.lstat(absPath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (st.isSymbolicLink()) throw err('artifact_symlink_rejected', 'artifact_symlink_rejected');
  return st;
}

/**
 * Open an existing regular file with O_NOFOLLOW and read it, after a final
 * no-follow stat that rejects symlinks and nonregular files. O_NOFOLLOW on
 * the final component is enforced by the kernel where supported; we add a
 * userspace lstat guard too. Returns a Buffer.
 */
async function safeReadFile(absPath, root) {
  const st = await lstatNoFollow(absPath);
  if (!st) throw err('artifact_content_missing', 'artifact_content_missing');
  if (!st.isFile()) throw err('artifact_record_corrupt', 'artifact_record_corrupt');
  assertWithin(await fs.realpath(absPath), root);
  let fh;
  try {
    // O_NOFOLLOW makes the kernel reject a symlink final component where
    // supported (Linux). The userspace lstat guard above is the portable
    // backstop; O_NOFOLLOW hardens the open against a TOCTOU swap.
    fh = await fs.open(absPath, O_RDONLY | O_NOFOLLOW);
  } catch (error) {
    // EINVAL/ENOTSUP: the platform does not accept numeric flags or does
    // not implement O_NOFOLLOW. Fall back to a plain read open; the lstat
    // guard already excluded a symlink.
    if (error.code === 'EINVAL' || error.code === 'ENOTSUP') {
      fh = await fs.open(absPath, 'r');
    } else {
      throw error;
    }
  }
  try {
    return fh.readFile();
  } finally {
    await fh.close();
  }
}

/**
 * Read + strictly validate a durable sidecar record. Structural / parse
 * failures (duplicate keys, wrong types, invalid uri shape, bad metadata)
 * throw invalid_artifact_record. Integrity / path-mismatch failures are
 * asserted separately by the caller as artifact_record_corrupt.
 */
async function safeReadMeta(absPath, root) {
  const bytes = await safeReadFile(absPath, root);
  return validateDurableRecord(bytes.toString('utf8'), 'invalid_artifact_record');
}
/** Boolean exists check (no-follow, contained). */
async function safeExists(absPath, root) {
  const st = await lstatNoFollow(absPath);
  if (!st) return false;
  if (!st.isFile()) throw err('artifact_record_corrupt', 'artifact_record_corrupt');
  assertWithin(await fs.realpath(absPath), root);
  return true;
}

/**
 * Create a directory inside the pinned root. We mkdir the deepest existing
 * ancestor first, verify it is contained, then mkdir the rest; this avoids
 * creating directories through an ancestor symlink that would escape the
 * root. The final realpath is rechecked at the end.
 */
async function ensureDirSafe(absPath, root) {
  // realpath the longest existing prefix to detect an ancestor symlink that
  // already escapes; then mkdir the remainder and recheck.
  let probe = absPath;
  const checked = [];
  while (true) {
    try {
      const real = await fs.realpath(probe);
      assertWithin(real, root);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      checked.unshift(probe);
      const parent = dirname(probe);
      if (parent === probe) {
        throw err('artifact_path_escape', 'artifact_path_escape');
      }
      probe = parent;
    }
  }
  for (const p of checked) {
    try {
      await fs.mkdir(p, { recursive: false });
    } catch (error) {
      // Another process created the directory between our realpath probe and
      // this mkdir; tolerate it. Anything else (including a non-directory
      // file at this path) must fail closed.
      if (error.code !== 'EEXIST') throw error;
      const st = await lstatNoFollow(p);
      if (!st || !st.isDirectory()) throw err('artifact_path_escape', 'artifact_path_escape');
    }
  }
  const real = await fs.realpath(absPath);
  assertWithin(real, root);
}

async function fsyncDir(absPath) {
  let fh;
  try {
    fh = await fs.open(absPath, 'r');
    await fh.sync();
  } catch (error) {
    if (error.code !== 'EISDIR' && error.code !== 'EINVAL') {
      try { if (fh) await fh.close(); } catch { /* ignore */ }
      throw error;
    }
  } finally {
    try { if (fh) await fh.close(); } catch { /* ignore */ }
  }
}

async function safeUnlink(absPath) {
  try { await fs.unlink(absPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

/**
 * Atomically publish bytes to finalPath via a temp file + fsync + link.
 * The temp is created with O_EXCL and 0o600 inside the same directory as the
 * target. link() is non-overwriting (EEXIST = a concurrent racer already
 * published), so concurrent same-identity writers cannot both win. The temp
 * is always removed on the publishing path.
 */
async function atomicPublish(finalPath, bytes, root, hook) {
  const dir = dirname(finalPath);
  const tmpPath = finalPath + TMP_INFIX + tempNonce();
  let fh;
  try {
    fh = await fs.open(tmpPath, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') throw err('artifact_temp_collision', 'artifact_temp_collision');
    throw error;
  }
  try {
    await fh.writeFile(bytes);
    await fh.sync();
  } finally {
    await fh.close();
  }
  crashHook(hook?.afterTmp);
  try {
    await fs.link(tmpPath, finalPath);
  } catch (error) {
    await safeUnlink(tmpPath);
    if (error.code === 'EEXIST') return 'exists';
    throw error;
  }
  await fsyncDir(dir);
  crashHook(hook?.afterLink);
  await safeUnlink(tmpPath);
  return 'published';
}

/** Parse run-directory entries into sealed / orphan / intent identities. */
async function scanRun(dir, root) {
  let names;
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return { byId: new Map(), names: [] };
    throw error;
  }
  assertWithin(await fs.realpath(dir), root);
  const byId = new Map();
  for (const name of names) {
    if (name === LOCK_NAME) continue;
    if (name.includes(TMP_INFIX)) continue; // never treat temps as published
    let id = null;
    let kind = null;
    if (name.endsWith(CONTENT_SUFFIX)) {
      id = name.slice(0, name.length - CONTENT_SUFFIX.length);
      kind = 'content';
    } else if (name.endsWith(META_SUFFIX)) {
      id = name.slice(0, name.length - META_SUFFIX.length);
      kind = 'meta';
    } else if (name.endsWith(INTENT_SUFFIX)) {
      id = name.slice(0, name.length - INTENT_SUFFIX.length);
      kind = 'intent';
    } else {
      continue; // unknown file: ignore, never delete
    }
    if (!HEX64.test(id)) continue; // not one of ours
    let entry = byId.get(id);
    if (!entry) { entry = { id, content: null, meta: null, intent: null }; byId.set(id, entry); }
    entry[kind] = join(dir, name);
  }
  return { byId, names };
}

/**
 * Compute durable usage for a run. Sealed artifacts (content + meta that
 * match) count meta.sizeBytes; orphan content with a matching intent also
 * counts (published, result not returned); orphan content without intent
 * counts the content file length. Each identity is counted exactly once.
 * Corruption (meta without content, digest/size mismatch, unparseable or
 * invalid meta/intent, a meta whose uri does not match its directory path)
 * throws fail-closed so the budget never silently shrinks.
 */
async function computeUsage(dir, root, expectedScopeDigest, expectedRunDigest) {
  const { byId } = await scanRun(dir, root);
  let total = 0;
  for (const entry of byId.values()) {
    if (entry.meta) {
      const meta = await safeReadMeta(entry.meta, root);
      assertRecordMatchesPath(meta, expectedScopeDigest, expectedRunDigest, entry.id, root);
      if (!entry.content) throw err('artifact_record_corrupt', 'artifact_record_corrupt');
      const content = await safeReadFile(entry.content, root);
      if (sha256Hex(content) !== meta.digest.slice(7) || content.length !== meta.sizeBytes) {
        throw err('artifact_record_corrupt', 'artifact_record_corrupt');
      }
      total += meta.sizeBytes;
    } else if (entry.content) {
      const st = await lstatNoFollow(entry.content);
      if (!st) continue;
      if (!st.isFile()) throw err('artifact_record_corrupt', 'artifact_record_corrupt');
      assertWithin(await fs.realpath(entry.content), root);
      // An orphan with an intent pins a size; trust the intent size if the
      // digest matches the content, else charge the actual file length.
      let charged = st.size;
      if (entry.intent) {
        const intent = await safeReadMeta(entry.intent, root);
        assertRecordMatchesPath(intent, expectedScopeDigest, expectedRunDigest, entry.id, root);
        if (sha256Hex(await safeReadFile(entry.content, root)) === intent.digest.slice(7)) {
          charged = intent.sizeBytes;
        }
      }
      total += charged;
    }
  }
  return total;
}

/**
 * Assert a stored record's uri scope/run/identity match the on-disk directory
 * and the expected values derived from the request path. Prevents a tampered
 * same-scope uri (pointing at another run or identity) from being admitted.
 */
function assertRecordMatchesPath(record, expectedScopeDigest, expectedRunDigest, expectedIdentity, root) {
  const parsed = parseArtifactUri(record.uri);
  if (parsed.scopeDigest !== expectedScopeDigest) {
    throw err('artifact_record_corrupt', 'artifact_record_corrupt');
  }
  if (parsed.runDigest !== expectedRunDigest) {
    throw err('artifact_record_corrupt', 'artifact_record_corrupt');
  }
  if (parsed.identityDigest !== expectedIdentity) {
    throw err('artifact_record_corrupt', 'artifact_record_corrupt');
  }
  void root;
}

/** Remove stale temp files (older than maxAgeMs) inside a run directory. */
async function cleanupStaleTempsIn(dir, root, maxAgeMs) {
  let names;
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
  assertWithin(await fs.realpath(dir), root);
  const now = Date.now();
  let removed = 0;
  for (const name of names) {
    if (!name.includes(TMP_INFIX)) continue;
    const abs = join(dir, name);
    const st = await lstatNoFollow(abs);
    if (!st) continue;
    if (st.isSymbolicLink()) continue;
    if (now - st.mtimeMs < maxAgeMs) continue;
    await safeUnlink(abs);
    removed += 1;
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Cross-process per-run lock (SQLite transaction)
//
// A per-run SQLite database at {root}/artifacts/.locks/{scopeDigest}/{runDigest}.sqlite
// is the real exclusion primitive. Acquisition is `BEGIN IMMEDIATE`, which the
// SQLite library serializes atomically across processes AND connections: the
// first taker gets a RESERVED write lock, every concurrent taker gets SQLITE_BUSY.
// The lock is owned by the LIVE database connection — it is held across the
// writer's filesystem operations and released only when that connection commits
// and closes. When the owning process dies (crash, kill, abort mid-write) the OS
// reclaims the file descriptors and SQLite releases the lock automatically, so
// there is no stale lock to "take over" and no split-brain window in which two
// writers both believe they hold the lock. A would-be taker that finds the lock
// busy retries asynchronously; with busy_timeout = 0 the retry never blocks the
// event loop synchronously, so a same-process owner with a pending filesystem
// await can still make progress (no deadlock).
//
// Owner identity (a per-acquire token, pid, host, bornAt) is recorded in a
// single-row table inside the same transaction, so release is owner-bound: only
// the holder's own connection can delete its row and commit — release is never
// an unconditional unlink of a shared path. An uncommitted owner row left by a
// crash is rolled back by SQLite journal recovery on the next open, so it never
// persists as a stale owner; a partial database left by a creator crash is
// likewise recovered by the rollback journal, so a missing/partial lock never
// permanently prevents recovery.
//
// PATH CONTAINMENT AND TRUSTED-DIRECTORY ASSUMPTION
// The lock DB and its SQLite auxiliary files (-journal/-wal/-shm) live under
// {root}/artifacts/.locks/{scopeDigest}/, whose path components are hex digests
// (no path separators, no '..'); the only writer is this store. SQLite's
// DatabaseSync opens by PATH and follows symlinks, and node:sqlite exposes no
// O_NOFOLLOW option, so a symlinked final component or a symlinked ancestor
// would otherwise redirect the lock_owner schema write (and the journal) to a
// file outside the pinned root — the demonstrated vulnerability. We defend in
// layers, and we do NOT claim a race-free guarantee the API cannot deliver:
//   1. ensureDirSafe: the lock directory is created contained, rejecting a
//      statically-symlinked ancestor at creation time.
//   2. validateLockDbSurface (pre-open): lstat every path SQLite may touch (the
//      DB plus -journal/-wal/-shm) — reject a symlink final component, a
//      non-regular file, a hardlink (nlink > 1), or a realpath escaping the
//      root; re-resolve the lock directory's realpath. This defeats a
//      statically-placed trap. It is an existence check, NOT a race-free guard.
//   3. openAndAcquireLock post-open guard: AFTER `new DatabaseSync(path)`,
//      re-resolve the CURRENT path string with realpathSync(path) and assert
//      it is still within the root; if not, close BEFORE BEGIN IMMEDIATE so the
//      lock_owner schema is never written outside the root. NOTE: this
//      re-resolves the path STRING, not the file descriptor SQLite actually
//      opened — node:sqlite exposes no way to read back that fd's identity, so
//      this guard does NOT prove what DatabaseSync opened, and it does NOT
//      close arbitrary concurrent swaps. It is a bounded single-swap check: it
//      catches a swap whose effect is visible at the path string by the time
//      realpathSync runs (a swap at or before that instant). A swap that
//      happens AFTER realpathSync is not observed here, and SQLite continues
//      holding whatever fd it opened at construction time.
// RESIDUAL (not promised closed): node:sqlite has no O_NOFOLLOW, so a swap to a
// symlink whose target does not yet exist can create an EMPTY file at that
// outside target during DatabaseSync construction; the post-open guard then
// re-resolves the path, detects the escape, and closes before any schema
// write, so no existing outside database is ever corrupted and the lock_owner
// schema never leaves the root. A swap that lands AFTER the post-open
// realpathSync is not caught here (SQLite already holds its in-root fd from
// construction, but the path string now points elsewhere; subsequent opens by
// other takers re-validate independently). This residual requires an attacker
// who can concurrently mutate artifacts/.locks between the checks and the
// open. Under the trusted-directory assumption — the artifacts root and its
// .locks subtree are Host-provided and not concurrently mutated by untrusted
// code — the static checks (ensureDirSafe + validateLockDbSurface) and the
// bounded post-open single-swap check are complete and the residual does not
// arise. We fail closed on every static signal we can detect; we do not
// promise a guarantee the node:sqlite API cannot provide.

function lockDirPath(root, scopeDigestValue) {
  return join(root, 'artifacts', '.locks', scopeDigestValue);
}
function lockDbPath(root, scopeDigestValue, runDigestValue) {
  return join(lockDirPath(root, scopeDigestValue), runDigestValue + '.sqlite');
}

function isSqliteBusy(error) {
  return !!error && (
    error.errcode === SQLITE_BUSY
    || /locked|busy/i.test(String(error.errstr || error.message || ''))
  );
}

/**
 * Commit the holder's transaction, retrying asynchronously on SQLITE_BUSY.
 * COMMIT upgrades the RESERVED write lock to EXCLUSIVE to flush the journal; a
 * concurrent taker opening the database briefly holds a SHARED lock (schema
 * read) and can make COMMIT get SQLITE_BUSY even though this connection is the
 * sole writer. busy_timeout is 0 (so the write-ACQUIRE path never synchronously
 * busy-waits and block a same-process owner's pending filesystem await), so we
 * retry COMMIT the same way the acquire does — via setTimeout, keeping the
 * event loop free. The transient reader releases in milliseconds. This is the
 * LIVE release path only; a crashed holder never reaches here (the OS reclaims
 * the connection's fd and SQLite drops the lock), so crash release is
 * unaffected. A non-busy error, or busy past LOCK_RELEASE_TIMEOUT_MS, propagates
 * (the caller rolls back and closes, releasing the lock).
 */
async function commitWithBusyRetry(db) {
  const start = Date.now();
  while (true) {
    try {
      db.exec('COMMIT');
      return;
    } catch (error) {
      if (!isSqliteBusy(error)) throw error;
      if (Date.now() - start > LOCK_RELEASE_TIMEOUT_MS) throw error;
      await new Promise((r) => setTimeout(r, LOCK_POLL_MS, undefined));
    }
  }
}

/**
 * Pre-open validation of the lock database path and every SQLite auxiliary file
 * SQLite may touch beside it. Rejects a statically-placed symlink (final
 * component), a non-regular file, a hardlink (nlink > 1), or any path whose
 * realpath escapes the pinned root; re-resolves the lock directory's realpath.
 * This defeats the demonstrated attack where the lock DB's final component is a
 * symlink to an outside SQLite file.
 *
 * LIMIT: fs.lstat rejects only a symlink FINAL component; an intermediate
 * ancestor symlink is detected via realpath of the existing file and of the
 * parent directory. This is an existence check, not a race-free guarantee — a
 * concurrent swap between this check and the open is caught by the post-open
 * realpath guard in openAndAcquireLock, and the trusted-directory assumption
 * (see above) bounds the residual.
 */
async function validateLockDbSurface(dbPath, rootReal) {
  const parent = dirname(dbPath);
  // The lock directory must still be contained right before we touch the DB.
  // ensureDirSafe created it contained, but an ancestor swap since then is
  // caught here (realpath resolves ancestor symlinks) before any file is
  // created. If the parent vanished (TOCTOU), fail closed.
  let parentReal;
  try {
    parentReal = await fs.realpath(parent);
  } catch (error) {
    if (error.code === 'ENOENT') throw err('artifact_path_escape', 'artifact_path_escape');
    throw error;
  }
  assertWithin(parentReal, rootReal);
  // The lock DB is persistent (never deleted in normal operation), so a
  // vanished-after-lstat DB is a real signal — validate it with realpath too.
  await validateLockPathEntry(dbPath, rootReal, true);
  // SQLite auxiliary files (-journal/-wal/-shm) are TRANSIENT: the rollback
  // journal is created at BEGIN and deleted at COMMIT by a concurrent holder,
  // so it may appear and disappear between our lstat and any realpath. We
  // therefore validate aux files with lstat only (symlink / non-regular /
  // hardlink) — the parent realpath already pinned the directory, and the DB
  // post-open realpath guard catches an ancestor swap. realpath-ing a transient
  // aux file would fire spuriously on a concurrent committer deleting its own
  // journal.
  for (const sfx of SQLITE_AUX_SUFFIXES) {
    await validateLockPathEntry(dbPath + sfx, rootReal, false);
  }
}

/**
 * Validate one lock-path entry (the DB or one aux file). lstat-based checks
 * (symlink / non-regular / hardlink) defeat a statically-placed trap. When
 * `doRealpath` is true (the persistent DB only), also resolve the realpath and
 * assert containment; a vanished-after-lstat DB fails closed.
 */
async function validateLockPathEntry(p, rootReal, doRealpath) {
  let st;
  try {
    st = await fs.lstat(p);
  } catch (error) {
    if (error.code === 'ENOENT') return; // not present yet: nothing to validate
    throw error;
  }
  if (st.isSymbolicLink()) throw err('artifact_symlink_rejected', 'artifact_symlink_rejected');
  if (!st.isFile()) throw err('artifact_record_corrupt', 'artifact_record_corrupt');
  if (st.nlink > 1) throw err('artifact_path_escape', 'artifact_path_escape'); // hardlink to outside
  if (!doRealpath) return;
  let real;
  try {
    real = await fs.realpath(p);
  } catch (error) {
    if (error.code === 'ENOENT') throw err('artifact_path_escape', 'artifact_path_escape');
    throw error;
  }
  assertWithin(real, rootReal);
}

/**
 * Open the lock database and acquire the write transaction atomically. The
 * schema is created INSIDE the transaction (after BEGIN IMMEDIATE) so a second
 * connection that finds the lock busy never contends on DDL. Owner identity is
 * recorded in a single-row table. Returns the open connection (transaction
 * held). Throws a busy error (errcode 5) if another connection holds the lock;
 * the caller retries asynchronously. Any other SQLite error (corruption) is a
 * hard failure — a partial database is recovered by the journal, not here.
 *
 * POST-OPEN GUARD: node:sqlite's DatabaseSync opens by path and follows
 * symlinks (no O_NOFOLLOW option is exposed), so a concurrent swap of the
 * path between validateLockDbSurface and this open cannot be fully closed in
 * userspace. After `new DatabaseSync(path)` we call realpathSync(path) and
 * assertWithin against the pinned root. This re-resolves the CURRENT path
 * STRING — NOT the file descriptor SQLite actually opened (node:sqlite
 * exposes no way to read that fd back), so the guard does NOT prove the
 * identity of the fd DatabaseSync holds and does NOT close arbitrary
 * concurrent swaps. It is a bounded single-swap check: it catches a swap
 * whose effect is visible at the path string by the time realpathSync runs.
 * If the path now resolves outside the root we close BEFORE BEGIN IMMEDIATE
 * so the lock_owner schema is never written outside the root. A swap landing
 * after this realpathSync is not caught here. Under the trusted-directory
 * assumption above (the artifacts root and .locks subtree are Host-provided
 * and not concurrently mutated by untrusted code) the static checks plus
 * this bounded single-swap check are complete; the residual requires a
 * concurrent attacker inside .locks.
 */
function openAndAcquireLock(path, token, pid, rootReal) {
  const db = new DatabaseSync(path, { timeout: 0 });
  try {
    assertWithin(realpathSync(path), rootReal);
  } catch (error) {
    try { db.close(); } catch { /* best effort before rethrowing */ }
    throw err('artifact_path_escape', 'artifact_path_escape');
  }
  try {
    db.exec('PRAGMA busy_timeout = 0');
    db.exec('BEGIN IMMEDIATE');
    db.exec(
      'CREATE TABLE IF NOT EXISTS lock_owner ('
      + 'id INTEGER PRIMARY KEY CHECK (id = 1), '
      + 'token TEXT NOT NULL, pid INTEGER NOT NULL, host TEXT NOT NULL, born_at TEXT NOT NULL)'
    );
    db.prepare(
      'INSERT INTO lock_owner (id, token, pid, host, born_at) VALUES (1, ?, ?, ?, ?) '
      + 'ON CONFLICT(id) DO UPDATE SET token = excluded.token, pid = excluded.pid, '
      + 'host = excluded.host, born_at = excluded.born_at'
    ).run(token, pid, HOST, nowIso());
    return db;
  } catch (error) {
    try { db.close(); } catch { /* best effort before rethrowing */ }
    throw error;
  }
}

/**
 * Acquire the per-run cross-process lock, retrying asynchronously on busy.
 * Resolves to a handle whose release() commits and closes the owner's OWN
 * connection (owner-bound). Throws artifact_lock_timeout after a safety bound,
 * artifact_aborted on signal, or a SQLite error on unrecoverable corruption.
 */
async function acquireRunLock(root, rootReal, scopeDigestValue, runDigestValue, signal) {
  const pid = process.pid;
  const path = lockDbPath(root, scopeDigestValue, runDigestValue);
  const ldir = lockDirPath(root, scopeDigestValue);
  // The lock directory is a sibling of the scope's run directories, inside the
  // pinned artifacts root; create it contained so a symlinked ancestor that
  // escapes is rejected before any database file is opened.
  await ensureDirSafe(ldir, rootReal);
  const token = tempNonce();
  const start = Date.now();
  let db;
  while (true) {
    checkSignal(signal);
    try {
      // Static pre-open validation of the lock DB path and every SQLite
      // auxiliary file (-journal/-wal/-shm) SQLite may touch beside it: reject a
      // symlink final component, a non-regular file, a hardlink (nlink > 1), or
      // a realpath that escapes the pinned root. This defeats a statically-
      // placed trap. It is NOT a race-free guarantee — see the post-open guard
      // in openAndAcquireLock and the trusted-directory assumption above.
      await validateLockDbSurface(path, rootReal);
      await swapHookForLockDb(path); // test-only TOCTOU simulation; inert in production
      db = openAndAcquireLock(path, token, pid, rootReal);
      break;
    } catch (error) {
      if (!isSqliteBusy(error)) throw error;
      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        throw err('artifact_lock_timeout', 'artifact_lock_timeout');
      }
      // setTimeout yields the event loop so a same-process owner's pending
      // filesystem await can proceed; no synchronous busy-wait.
      await new Promise((r) => setTimeout(r, LOCK_POLL_MS, undefined));
    }
  }
  return {
    path,
    token,
    pid,
    async release() {
      try {
        // Owner-bound release: clear only our own row, then commit and close
        // our own connection. Another process cannot reach this connection,
        // so it cannot release a lock it does not own. COMMIT is retried on
        // transient SQLITE_BUSY (a concurrent opener's brief SHARED lock); see
        // commitWithBusyRetry. The finally still closes our connection on any
        // failure, releasing the SQLite lock so the next writer can proceed.
        db.prepare('DELETE FROM lock_owner WHERE id = 1 AND token = ?').run(token);
        await commitWithBusyRetry(db);
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* best effort */ }
        throw error;
      } finally {
        try { db.close(); } catch { /* ignore */ }
      }
    },
  };
}

/**
 * Before publishing a *new* artifact, a lock taker (including a stale-lock
 * successor) must finish any interrupted publication left in the run: for
 * each identity with content but no meta, if a matching intent exists, seal
 * it; if a non-matching intent exists, this is an unresolved conflict the
 * original writer would have rejected — leave the orphan and let the next
 * same-identity write reconcile. We do not delete content we did not create.
 */
async function finishInterruptedPublications(dir, root, expectedScopeDigest, expectedRunDigest) {
  const { byId } = await scanRun(dir, root);
  for (const entry of byId.values()) {
    if (entry.meta) continue; // already sealed
    if (!entry.content) continue;
    if (!entry.intent) continue;
    // There is an intent; try to seal the content with it.
    try {
      const intent = await safeReadMeta(entry.intent, root);
      assertRecordMatchesPath(intent, expectedScopeDigest, expectedRunDigest, entry.id, root);
      const content = await safeReadFile(entry.content, root);
      if (sha256Hex(content) !== intent.digest.slice(7) || content.length !== intent.sizeBytes) {
        continue; // content does not match the intent; leave for reconciliation
      }
      const metaPath = entry.content.slice(0, -CONTENT_SUFFIX.length) + META_SUFFIX;
      const metaBytes = Buffer.from(canonicalStringify({
        uri: intent.uri, digest: intent.digest, mediaType: intent.mediaType,
        sizeBytes: intent.sizeBytes, metadata: intent.metadata, createdAt: nowIso(),
      }), 'utf8');
      await atomicPublish(metaPath, metaBytes, root, null);
      await safeUnlink(entry.intent);
    } catch {
      // Any failure to finish leaves the orphan in place; a same-identity
      // write will reconcile. We never silently drop content.
    }
  }
}

// ---------------------------------------------------------------------------
// Factory

/**
 * Create a Native artifact store bound to one trusted scope and directory.
 *
 * @param {object} options
 * @param {string} options.directory  Root directory for artifact storage.
 * @param {import('../../../agentkit-harness-core/src/contracts.mts').RunScope} options.scope
 *   Trusted fixed scope; every request must exactly match all four fields.
 * @param {number} [options.maxReadChars]   Max characters per read page (default 32000).
 * @param {number} [options.maxSearchMatches] Max refs per search (default 16).
 * @param {number} [options.maxQueryChars]  Max query length (default 1024).
 * @param {number} [options.maxScanBytes]   Max content bytes scanned per search hit (default 1MiB).
 * @param {number} [options.maxItemBytes]   Max bytes per artifact (default 64MiB).
 * @param {number} [options.maxTotalBytes]   Max total bytes per run (default 512MiB).
 * @returns {Promise<ArtifactStore>}
 */
export async function createNativeArtifactStore(options) {
  if (!options || typeof options !== 'object') throw err('invalid_artifact_options', 'invalid_artifact_options');
  const { directory, scope } = options;
  validateScope(scope);
  const maxReadChars = validateLimitOption(options.maxReadChars, 'max_read_chars', DEFAULT_MAX_READ_CHARS, 1000000);
  const maxSearchMatches = validateLimitOption(options.maxSearchMatches, 'max_search_matches', DEFAULT_MAX_SEARCH_MATCHES, 1000);
  const maxQueryChars = validateLimitOption(options.maxQueryChars, 'max_query_chars', DEFAULT_MAX_QUERY_CHARS, 100000);
  const maxScanBytes = validateBytesOption(options.maxScanBytes, 'max_scan_bytes', DEFAULT_MAX_SCAN_BYTES, Number.MAX_SAFE_INTEGER);
  const maxItemBytes = validateBytesOption(options.maxItemBytes, 'max_item_bytes', DEFAULT_MAX_ITEM_BYTES, Number.MAX_SAFE_INTEGER);
  const maxTotalBytes = validateBytesOption(options.maxTotalBytes, 'max_total_bytes', DEFAULT_MAX_TOTAL_BYTES, Number.MAX_SAFE_INTEGER);

  const { root, rootReal } = await initRoot(directory);
  const scopeDigestValue = scopeDigest(scope);
  const boundScope = { tenantId: scope.tenantId, workspaceId: scope.workspaceId, userId: scope.userId, agentId: scope.agentId };

  const runDir = (runDigestValue) => join(root, 'artifacts', scopeDigestValue, runDigestValue);

  async function assertScope(request) {
    if (!scopeEquals(request.scope, boundScope)) throw err('artifact_scope_mismatch', 'artifact_scope_mismatch');
  }

  /**
   * Persist exact text idempotently for the supplied operation identity.
   * Same identity + same content/type/metadata returns the same ref; same
   * identity with different content/type/metadata is an explicit conflict.
   * Publication is serialized per run across processes by the run lock.
   */
  async function write(request) {
    await assertScope(request);
    assertNonEmptyString(request.runId, 'invalid_run_id');
    assertNonEmptyString(request.operationKey, 'invalid_operation_key');
    validateMediaType(request.mediaType);
    const metadata = validateMetadataObject(request.metadata);
    checkSignal(request.signal);

    const rd = runDigest(boundScope, request.runId);
    const id = identityDigest(boundScope, request.runId, request.operationKey);
    const dir = runDir(rd);
    const contentPath = join(dir, id + CONTENT_SUFFIX);
    const metaPath = join(dir, id + META_SUFFIX);
    const intentPath = join(dir, id + INTENT_SUFFIX);
    const uri = buildArtifactUri(scopeDigestValue, rd, id);

    const contentBytes = encodeUtf8(request.content);
    const digest = 'sha256:' + sha256Hex(contentBytes);
    const sizeBytes = contentBytes.length;
    const ref = { uri, digest, mediaType: request.mediaType, sizeBytes, metadata };
    const intentRecord = { uri, digest, mediaType: request.mediaType, sizeBytes, metadata };
    const metaRecord = { uri, digest, mediaType: request.mediaType, sizeBytes, metadata, createdAt: nowIso() };
    const intentBytes = Buffer.from(canonicalStringify(intentRecord), 'utf8');
    const metaBytes = Buffer.from(canonicalStringify(metaRecord), 'utf8');

    if (sizeBytes > maxItemBytes) throw err('artifact_too_large', 'artifact_too_large');

    const lock = await acquireRunLock(root, rootReal, scopeDigestValue, rd, request.signal);
    try {
      await signalLockAcquired();
      // The run directory hosts the content/meta/intent files; create it
      // contained under the lock so two writers never race on mkdir.
      await ensureDirSafe(dir, rootReal);
      // Finish any publication a dead predecessor left interrupted, so the
      // successor never races a brand-new write for the same run.
      await finishInterruptedPublications(dir, rootReal, scopeDigestValue, rd);
      checkSignal(request.signal);

      // Phase 1: reconcile an existing sealed record for this identity.
      if (await safeExists(metaPath, rootReal)) {
        const meta = await safeReadMeta(metaPath, rootReal);
        assertRecordMatchesPath(meta, scopeDigestValue, rd, id, rootReal);
        const content = await safeReadFile(contentPath, rootReal);
        if (sha256Hex(content) !== meta.digest.slice(7) || content.length !== meta.sizeBytes) {
          throw err('artifact_record_corrupt', 'artifact_record_corrupt');
        }
        if (
          meta.uri !== ref.uri || meta.digest !== ref.digest || meta.mediaType !== ref.mediaType
          || meta.sizeBytes !== ref.sizeBytes || !jsonEquals(meta.metadata, metadata)
        ) {
          throw err('artifact_identity_conflict', 'artifact_identity_conflict');
        }
        // Drop a stale intent from a prior interrupted attempt of this same identity.
        await safeUnlink(intentPath);
        return ref; // idempotent
      }

      // Phase 2: reconcile orphan content (content present, meta absent).
      const contentOnDisk = await safeExists(contentPath, rootReal);
      if (contentOnDisk) {
        // The complete write identity is pinned by the intent sidecar, which is
        // always published BEFORE content. So a legitimate orphan always has a
        // matching intent. Without an intent, the orphan is ambiguous (tamper,
        // or content from before intents existed): we must NOT seal it as the
        // current request, because the bytes were never acknowledged and the
        // original request's type/metadata are unknown. Fail as a conflict.
        const priorIntentExists = await safeExists(intentPath, rootReal);
        if (!priorIntentExists) {
          throw err('artifact_identity_conflict', 'artifact_identity_conflict');
        }
        const priorIntent = await safeReadMeta(intentPath, rootReal);
        assertRecordMatchesPath(priorIntent, scopeDigestValue, rd, id, rootReal);
        const existing = await safeReadFile(contentPath, rootReal);
        if (existing.length !== priorIntent.sizeBytes || ('sha256:' + sha256Hex(existing)) !== priorIntent.digest) {
          // The orphan content does not match its own intent: corrupt.
          throw err('artifact_record_corrupt', 'artifact_record_corrupt');
        }
        // The intent pins the original request; the current write must match it
        // exactly (idempotent retry of the same interrupted write). A different
        // type/metadata/digest/size is a conflict, never a re-seal as a new request.
        if (
          priorIntent.uri !== ref.uri || priorIntent.digest !== ref.digest
          || priorIntent.mediaType !== ref.mediaType || priorIntent.sizeBytes !== ref.sizeBytes
          || !jsonEquals(priorIntent.metadata, metadata)
        ) {
          throw err('artifact_identity_conflict', 'artifact_identity_conflict');
        }
      } else {
        // Phase 3: publish the intent FIRST, pinning the complete identity,
        // then enforce the quota, then publish the content. The quota check
        // is atomic because we hold the run lock across all writers.
        const intentResult = await atomicPublish(intentPath, intentBytes, rootReal, { afterTmp: 'intent-tmp', afterLink: 'intent' });
        if (intentResult === 'exists') {
          const priorIntent = await safeReadMeta(intentPath, rootReal);
          assertRecordMatchesPath(priorIntent, scopeDigestValue, rd, id, rootReal);
          if (
            priorIntent.uri !== ref.uri || priorIntent.digest !== ref.digest
            || priorIntent.mediaType !== ref.mediaType || priorIntent.sizeBytes !== ref.sizeBytes
            || !jsonEquals(priorIntent.metadata, metadata)
          ) {
            throw err('artifact_identity_conflict', 'artifact_identity_conflict');
          }
        }
        checkSignal(request.signal);
        const usage = await computeUsage(dir, rootReal, scopeDigestValue, rd);
        if (usage + sizeBytes > maxTotalBytes) {
          // Roll back the intent so a retried write can re-evaluate budget.
          await safeUnlink(intentPath);
          throw err('artifact_budget_exceeded', 'artifact_budget_exceeded');
        }
        crashHook('before-content');
        await holdHook('before-content');
        const contentResult = await atomicPublish(contentPath, contentBytes, rootReal, { afterTmp: 'content-tmp', afterLink: 'content' });
        if (contentResult === 'exists') {
          const existing = await safeReadFile(contentPath, rootReal);
          if (sha256Hex(existing) !== digest.slice(7) || existing.length !== sizeBytes) {
            throw err('artifact_identity_conflict', 'artifact_identity_conflict');
          }
        }
      }

      // Phase 4: seal with the meta sidecar, then drop the intent.
      checkSignal(request.signal);
      const metaResult = await atomicPublish(metaPath, metaBytes, rootReal, { afterTmp: 'meta-tmp', afterLink: 'meta' });
      if (metaResult === 'exists') {
        const meta = await safeReadMeta(metaPath, rootReal);
        assertRecordMatchesPath(meta, scopeDigestValue, rd, id, rootReal);
        if (
          meta.uri !== ref.uri || meta.digest !== ref.digest || meta.mediaType !== ref.mediaType
          || meta.sizeBytes !== ref.sizeBytes || !jsonEquals(meta.metadata, metadata)
        ) {
          throw err('artifact_identity_conflict', 'artifact_identity_conflict');
        }
        const content = await safeReadFile(contentPath, rootReal);
        if (sha256Hex(content) !== meta.digest.slice(7) || content.length !== meta.sizeBytes) {
          throw err('artifact_record_corrupt', 'artifact_record_corrupt');
        }
      }
      await safeUnlink(intentPath);
      return ref;
    } finally {
      // Owner-bound release: commit + close this holder's own connection. If
      // the write threw, the finally still commits the (empty) lock-owner
      // transaction and closes the connection, releasing the SQLite lock so
      // the next writer can proceed; filesystem orphans are reconciled later.
      await lock.release();
    }
  }

  /**
   * Read a bounded page after enforcing scope, exact typed ref match and
   * content integrity. Pagination uses Unicode code point indices.
   */
  async function read(request) {
    await assertScope(request);
    validateRef(request.ref);
    if (!Number.isInteger(request.offset) || request.offset < 0) throw err('invalid_artifact_offset', 'invalid_artifact_offset');
    if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > maxReadChars) throw err('invalid_artifact_limit', 'invalid_artifact_limit');
    checkSignal(request.signal);

    const parsed = parseArtifactUri(request.ref.uri);
    if (parsed.scopeDigest !== scopeDigestValue) throw err('artifact_ref_outside_scope', 'artifact_ref_outside_scope');
    const dir = join(root, 'artifacts', parsed.scopeDigest, parsed.runDigest);
    const contentPath = join(dir, parsed.identityDigest + CONTENT_SUFFIX);
    const metaPath = join(dir, parsed.identityDigest + META_SUFFIX);

    if (!(await safeExists(metaPath, rootReal))) throw err('artifact_ref_unknown', 'artifact_ref_unknown');
    const meta = await safeReadMeta(metaPath, rootReal);
    assertRecordMatchesPath(meta, parsed.scopeDigest, parsed.runDigest, parsed.identityDigest, rootReal);
    if (
      meta.uri !== request.ref.uri || meta.digest !== request.ref.digest || meta.mediaType !== request.ref.mediaType
      || meta.sizeBytes !== request.ref.sizeBytes || !jsonEquals(meta.metadata, request.ref.metadata)
    ) {
      throw err('artifact_ref_changed', 'artifact_ref_changed');
    }
    const content = await safeReadFile(contentPath, rootReal);
    if (sha256Hex(content) !== request.ref.digest.slice(7) || content.length !== request.ref.sizeBytes) {
      throw err('artifact_content_integrity_mismatch', 'artifact_content_integrity_mismatch');
    }
    if (sha256Hex(content) !== meta.digest.slice(7) || content.length !== meta.sizeBytes) {
      throw err('artifact_record_corrupt', 'artifact_record_corrupt');
    }
    checkSignal(request.signal);
    const text = decodeUtf8Fatal(content);
    return sliceByCodePoints(text, request.offset, request.limit, maxReadChars);
  }

  /**
   * Literal, case-sensitive substring search over the current run's sealed
   * artifacts. Returns bounded refs in deterministic (URI) order. Only the
   * current run is scanned; other scopes or runs are never admitted.
   */
  async function search(request) {
    await assertScope(request);
    assertNonEmptyString(request.runId, 'invalid_run_id');
    if (typeof request.query !== 'string' || request.query.length === 0 || request.query.length > maxQueryChars) {
      throw err('invalid_artifact_search_query', 'invalid_artifact_search_query');
    }
    if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > maxSearchMatches) {
      throw err('invalid_artifact_search_limit', 'invalid_artifact_search_limit');
    }
    checkSignal(request.signal);

    const rd = runDigest(boundScope, request.runId);
    const dir = runDir(rd);
    const { byId } = await scanRun(dir, rootReal);

    // Deterministic order by URI (which embeds identity digest).
    const identities = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const matches = [];
    for (const entry of identities) {
      checkSignal(request.signal);
      if (!entry.meta) continue; // orphan content (not sealed) is not searchable
      if (!entry.content) {
        // meta present without content is corruption: fail closed, never skip
        throw err('artifact_record_corrupt', 'artifact_record_corrupt');
      }
      const meta = await safeReadMeta(entry.meta, rootReal);
      // Strictly validate the record belongs to THIS run and identity.
      assertRecordMatchesPath(meta, scopeDigestValue, rd, entry.id, rootReal);
      if (meta.sizeBytes > maxScanBytes) continue; // too large to scan this pass
      const content = await safeReadFile(entry.content, rootReal);
      if (sha256Hex(content) !== meta.digest.slice(7) || content.length !== meta.sizeBytes) {
        throw err('artifact_record_corrupt', 'artifact_record_corrupt');
      }
      const text = decodeUtf8Fatal(content); // fail closed on bad UTF-8
      if (text.includes(request.query)) {
        matches.push({
          uri: meta.uri, digest: meta.digest, mediaType: meta.mediaType,
          sizeBytes: meta.sizeBytes,
          // normalize the null-prototype parse result to a plain JSON object
          metadata: parseNativeJson(canonicalStringify(meta.metadata)),
        });
        if (matches.length >= request.limit) break;
      }
    }
    return matches;
  }

  /** Durable bytes consumed by a run's published artifacts, for budget reconciliation. */
  async function usageBytes({ scope, runId } = {}) {
    if (!scopeEquals(scope, boundScope)) throw err('artifact_scope_mismatch', 'artifact_scope_mismatch');
    assertNonEmptyString(runId, 'invalid_run_id');
    const rd = runDigest(boundScope, runId);
    return computeUsage(runDir(rd), rootReal, scopeDigestValue, rd);
  }

  /** Remove stale temp files across all run directories of this scope. */
  async function cleanupStaleTemps({ maxAgeMs = 60000 } = {}) {
    if (!Number.isInteger(maxAgeMs) || maxAgeMs < 0) throw err('invalid_temp_age', 'invalid_temp_age');
    const scopeDir = join(root, 'artifacts', scopeDigestValue);
    let runDirs;
    try {
      runDirs = await fs.readdir(scopeDir);
    } catch (error) {
      if (error.code === 'ENOENT') return 0;
      throw error;
    }
    let removed = 0;
    for (const rd of runDirs) {
      if (!HEX64.test(rd)) continue;
      removed += await cleanupStaleTempsIn(join(scopeDir, rd), rootReal, maxAgeMs);
    }
    return removed;
  }

  return {
    write,
    read,
    search,
    usageBytes,
    cleanupStaleTemps,
    // Inspection helpers for tests / core reconciliation; not part of ArtifactPort.
    get scope() { return { ...boundScope }; },
    get directory() { return root; },
    get rootReal() { return rootReal; },
  };
}
