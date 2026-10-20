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
 * serialized by a per-run advisory lock file (`.lock`) acquired with
 * O_EXCL, so two writers across separate processes/instances never publish
 * to the same run concurrently. Under the lock the writer (a) reconciles an
 * existing sealed record for the identity (idempotent / conflict), else (b)
 * writes a pending-intent sidecar pinning the *complete* write identity
 * (content digest + size + mediaType + metadata) before publishing content,
 * then (c) enforces the per-run byte quota atomically, (d) publishes
 * content, (e) seals with the meta sidecar, (f) deletes the intent. A crash
 * leaves an orphan content + intent pair; the next same-identity write
 * reconciles it against the locked intent (rejecting changed type/metadata).
 * A crash after sealing leaves a sealed artifact the caller may not have
 * received, which usageBytes still counts. Stale lock takeover completes the
 * interrupted publication rather than racing a new one, so there is never a
 * window with two active writers for the same run.
 */

import { promises as fs, constants as fsConstants } from 'node:fs';
const O_NOFOLLOW = fsConstants.O_NOFOLLOW;
const O_RDONLY = fsConstants.O_RDONLY;
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
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

// Heartbeat interval while waiting for a stale lock, and the staleness
// threshold for a lock whose owner appears to have died.
const LOCK_POLL_MS = 50;
const LOCK_STALE_MS = 30000;

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
// Cross-process per-run lock
//
// A `.lock` file in the run directory records the writer's pid, host, and a
// monotonic heartbeat timestamp. Acquisition is O_EXCL (atomic across
// processes). A would-be taker waits for the lock or, if the holder's
// heartbeat is older than LOCK_STALE_MS, takes over: it renames the stale
// lock aside and creates its own (both atomic in the run directory, so no
// two takers can both succeed). Before publishing anything new, a taker
// completes the interrupted publication the dead holder started, so there
// is never a window with two active writers producing different results.

function lockPath(dir) {
  return join(dir, LOCK_NAME);
}

function lockPayload(pid, bornAt, heartbeatAt) {
  return { pid, host: HOST, bornAt, heartbeatAt };
}

async function tryAcquireLock(dir, root, pid) {
  const path = lockPath(dir);
  const payload = lockPayload(pid, nowIso(), Date.now());
  let fh;
  try {
    fh = await fs.open(path, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') return { acquired: false };
    throw error;
  }
  try {
    await fh.writeFile(canonicalStringify(payload));
    await fh.sync();
  } finally {
    await fh.close();
  }
  return { acquired: true };
}

async function readLock(path) {
  let bytes;
  try {
    bytes = await fs.readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.code === 'EISDIR' || error.code === 'ELOOP') return { corrupt: true };
    return null;
  }
  // A lock file may be observed empty or partially written while the holder
  // is still fsyncing it (the file is created with O_EXCL, then written).
  // Treat an empty/partial file as "busy" so the waiter retries, and only
  // treat a fully-formed but structurally invalid record as corrupt.
  if (bytes.length === 0) return { busy: true };
  try {
    const obj = safeJsonParse(bytes, 'artifact_lock_corrupt');
    if (!obj || typeof obj.pid !== 'number' || typeof obj.heartbeatAt !== 'number') return { corrupt: true };
    return obj;
  } catch {
    // A partial write that is not yet valid JSON is transient, not corrupt.
    return { busy: true };
  }
}

/**
 * Decide whether a recorded lock holder is plausibly still alive. A holder
 * on the same host is checked directly via kill(pid,0): if the pid is gone
 * (ESRCH) the lock is stale and may be taken over immediately, even if the
 * recorded heartbeat is fresh (a crash leaves a fresh timestamp behind).
 * For a remote host we cannot check the pid, so we fall back to the
 * heartbeat age: older than LOCK_STALE_MS is treated as stale.
 */
async function holderAlive(lock, root) {
  if (!lock || lock.corrupt) return false;
  if (lock.host === HOST) {
    try {
      process.kill(lock.pid, 0);
      return true; // process exists; respect the lock
    } catch (error) {
      if (error.code === 'ESRCH') return false; // pid is gone → stale
      if (error.code === 'EPERM') return true; // alive, not ours
      return true; // unknown; be conservative
    }
  }
  // Remote host: cannot probe the pid; trust the heartbeat age.
  return Date.now() - lock.heartbeatAt < LOCK_STALE_MS;
}

/**
 * Take over a stale lock: rename the stale lock aside (atomic in the dir)
 * and create a fresh one. The rename uses link+unlink (cross-device safe
 * within one dir; rename would also work but link is consistent with the
 * publish path). Only one taker succeeds: the link is O_EXCL on the fresh
 * name, and the rename of the stale lock is best-effort (the winner is the
 * one that links the fresh lock). On success returns true.
 */
async function takeoverLock(dir, root, stalePath, pid) {
  const takenPath = dir + '.lock.taken-' + tempNonce();
  try {
    await fs.link(stalePath, takenPath);
  } catch (error) {
    if (error.code === 'ENOENT') return { acquired: false }; // someone else took it
    throw error;
  }
  // We captured the stale lock's contents; remove the original so another
  // taker sees it gone, then create our own.
  await safeUnlink(stalePath);
  const payload = lockPayload(pid, nowIso(), Date.now());
  let fh;
  try {
    fh = await fs.open(stalePath, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') {
      await safeUnlink(takenPath);
      return { acquired: false }; // someone else won
    }
    await safeUnlink(takenPath);
    throw error;
  }
  try {
    await fh.writeFile(canonicalStringify(payload));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await safeUnlink(takenPath);
  return { acquired: true };
}

async function heartbeatLock(path, pid) {
  // Rewrite atomically via temp+rename to avoid a torn write.
  const tmp = path + TMP_INFIX + tempNonce();
  let fh;
  try {
    fh = await fs.open(tmp, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') throw err('artifact_temp_collision', 'artifact_temp_collision');
    throw error;
  }
  try {
    await fh.writeFile(canonicalStringify(lockPayload(pid, nowIso(), Date.now())));
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fs.rename(tmp, path);
  } catch (error) {
    await safeUnlink(tmp);
    throw error;
  }
}

async function releaseLock(path) {
  await safeUnlink(path);
}

/**
 * Acquire the per-run lock, completing any interrupted publication left by a
 * dead holder first. Resolves to a handle with release(); throws on abort or
 * unrecoverable lock corruption.
 */
async function acquireRunLock(dir, root, expectedScopeDigest, expectedRunDigest, signal) {
  const pid = process.pid;
  const path = lockPath(dir);
  const start = Date.now();
  // The run directory must exist to host a lock. Create it contained first.
  await ensureDirSafe(dir, root);
  while (true) {
    checkSignal(signal);
    const got = await tryAcquireLock(dir, root, pid);
    if (got.acquired) return { dir, path, pid };
    const existing = await readLock(path);
    if (existing && existing.corrupt) {
      // A structurally invalid lock file blocks all writers; do not take over.
      throw err('artifact_lock_corrupt', 'artifact_lock_corrupt');
    }
    if (existing && existing.busy) {
      // The holder is still writing the lock file; retry shortly.
      if (Date.now() - start > LOCK_STALE_MS * 4) throw err('artifact_lock_timeout', 'artifact_lock_timeout');
      await new Promise((r) => setTimeout(r, LOCK_POLL_MS, undefined));
      continue;
    }
    if (!(await holderAlive(existing, root))) {
      const taken = await takeoverLock(dir, root, path, pid);
      if (taken.acquired) return { dir, path, pid };
      continue; // lost the takeover race; retry
    }
    if (Date.now() - start > LOCK_STALE_MS * 4) {
      throw err('artifact_lock_timeout', 'artifact_lock_timeout');
    }
    await new Promise((r) => setTimeout(r, LOCK_POLL_MS, undefined));
  }
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

    const lock = await acquireRunLock(dir, rootReal, scopeDigestValue, rd, request.signal);
    try {
      // Finish any publication a dead predecessor left interrupted, so a
      // takeover never races a brand-new write for the same run.
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
      await releaseLock(lock.path);
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
          metadata: JSON.parse(canonicalStringify(meta.metadata)),
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
