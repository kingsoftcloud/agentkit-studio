/**
 * Native Node artifact storage adapter.
 *
 * Exports {@link createNativeArtifactStore}, a factory that binds one
 * trusted {@link RunScope} to a directory and returns an object that
 * structurally satisfies the core ArtifactPort (write/read/search) plus a
 * usageBytes helper for later persistent budget reconciliation.
 *
 * Design contract (see contracts.mts ArtifactPort / ArtifactRef /
 * PortContext). This stage covers durable storage, integrity, pagination
 * and current-run search only. Core overflow scheduling, the ArtifactRead
 * retention tool, available_artifacts permissions, cross-turn inheritance
 * and the full context page-budget are wired by Codex later; do not assume
 * they exist here.
 *
 * Publication protocol: content first, then a JSON sidecar, each published
 * by writing a same-directory temp file, fsyncing it, and atomically
 * linking it into place (link is non-overwriting, so a concurrent same
 * identity racer cannot produce two artifacts). Sealed = content + meta
 * both linked. A crash between the two leaves an orphan content file that
 * the next same-identity write reconciles; a crash after both leaves a
 * sealed artifact the caller never received, which usageBytes still counts.
 */

import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertNonEmptyString, buildArtifactUri, canonicalStringify, decodeUtf8Fatal,
  encodeUtf8, identityDigest, jsonEquals, parseArtifactUri, runDigest,
  safeJsonParse, scopeDigest, scopeEquals, sha256Hex, sliceByCodePoints,
  tempNonce, validateMediaType, validateMetadataObject, validateRef,
  validateScope, validateBytesOption, validateLimitOption,
} from './artifact-codec.mjs';

const DEFAULT_MAX_READ_CHARS = 32000;
const DEFAULT_MAX_SEARCH_MATCHES = 16;
const DEFAULT_MAX_QUERY_CHARS = 1024;
const DEFAULT_MAX_SCAN_BYTES = 1024 * 1024;
const DEFAULT_MAX_ITEM_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;

const CONTENT_SUFFIX = '.content';
const META_SUFFIX = '.meta.json';
const TMP_INFIX = '.tmp.';
const HEX64 = /^[0-9a-f]{64}$/;

function err(code, message) {
  return Object.assign(new Error(message || code), { code });
}

function checkSignal(signal) {
  if (signal && signal.aborted) {
    if (signal.reason instanceof Error) throw signal.reason;
    throw err('artifact_aborted', 'artifact_aborted');
  }
}

/** Test-only crash hook: exit at a controlled publish position. Inert when unset. */
function crashHook(point) {
  if (process.env.NATIVE_ARTIFACT_CRASH_AFTER === point) {
    process.exit(0);
  }
}

function nowIso() {
  return new Date().toISOString();
}

function isWithin(realPath, rootReal) {
  return realPath === rootReal || realPath.startsWith(rootReal + '/');
}

/**
 * Resolve the artifacts root, creating it. Returns the realpath of the
 * artifacts directory; every accessed file must realpath inside it.
 */
async function initRoot(directory) {
  if (typeof directory !== 'string' || directory.length === 0) {
    throw err('invalid_artifact_directory', 'invalid_artifact_directory');
  }
  // Relative paths resolve against the current working directory, not the
  // module location; absolute paths and file: URLs are used verbatim.
  const resolved = directory.startsWith('file:') ? fileURLToPath(new URL(directory)) : resolve(directory);
  const artifactsDir = join(resolved, 'artifacts');
  await fs.mkdir(artifactsDir, { recursive: true });
  const rootReal = await fs.realpath(artifactsDir);
  return { root: resolved, rootReal };
}

/** lstat a path; null on ENOENT, throw on symlink (final component). */
async function lstatSafe(absPath) {
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

/** Verify a real path stays inside the artifacts root. */
function assertWithin(realPath, rootReal) {
  if (!isWithin(realPath, rootReal)) throw err('artifact_path_escape', 'artifact_path_escape');
}

/** Read a file after symlink + containment checks; returns Buffer. */
async function safeReadFile(absPath, rootReal) {
  const st = await lstatSafe(absPath);
  if (!st) throw err('artifact_content_missing', 'artifact_content_missing');
  if (st.isSymbolicLink()) throw err('artifact_symlink_rejected', 'artifact_symlink_rejected');
  const real = await fs.realpath(absPath);
  assertWithin(real, rootReal);
  return fs.readFile(absPath);
}

/** Read + strictly parse a meta sidecar. */
async function safeReadMeta(absPath, rootReal) {
  const bytes = await safeReadFile(absPath, rootReal);
  const meta = safeJsonParse(bytes.toString('utf8'), 'invalid_artifact_record');
  if (!meta || typeof meta !== 'object') throw err('invalid_artifact_record', 'invalid_artifact_record');
  return meta;
}

/** Boolean exists check (symlink-safe). */
async function safeExists(absPath, rootReal) {
  const st = await lstatSafe(absPath);
  if (!st) return false;
  const real = await fs.realpath(absPath);
  assertWithin(real, rootReal);
  return true;
}

/** Ensure a directory exists and is contained within the root (no ancestor symlink escape). */
async function ensureDirSafe(absPath, rootReal) {
  await fs.mkdir(absPath, { recursive: true });
  const real = await fs.realpath(absPath);
  assertWithin(real, rootReal);
}

/** fsync a directory so a link/rename is durable across a power loss. */
async function fsyncDir(absPath) {
  let fh;
  try {
    fh = await fs.open(absPath, 'r');
    await fh.sync();
  } catch (error) {
    // Some platforms cannot fsync directories; the link is still atomic.
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
 * link() is non-overwriting: it fails with EEXIST if the target exists,
 * so concurrent same-identity racers cannot both win. Returns 'published'
 * or 'exists'. Own temp is always cleaned up on the publishing path.
 */
async function atomicPublish(finalPath, bytes, rootReal, hook) {
  const dir = dirname(finalPath);
  const tmpPath = finalPath + TMP_INFIX + tempNonce();
  const fh = await fs.open(tmpPath, 'w', 0o600);
  try {
    await fh.writeFile(bytes);
    await fh.sync();
  } finally {
    await fh.close();
  }
  crashHook(hook?.afterTmp);
  let published = false;
  try {
    await fs.link(tmpPath, finalPath);
    published = true;
  } catch (error) {
    if (error.code === 'EEXIST') {
      await safeUnlink(tmpPath);
      return 'exists';
    }
    await safeUnlink(tmpPath);
    throw error;
  }
  await fsyncDir(dir);
  crashHook(hook?.afterLink);
  await safeUnlink(tmpPath);
  return 'published';
}

/** Parse run-directory entries into sealed and orphan identities. */
async function scanRun(dir, rootReal) {
  let names;
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return { byId: new Map(), names: [] };
    throw error;
  }
  const real = await fs.realpath(dir);
  assertWithin(real, rootReal);
  const byId = new Map();
  for (const name of names) {
    if (name.includes(TMP_INFIX)) continue; // never treat temps as published
    let id = null;
    let kind = null;
    if (name.endsWith(CONTENT_SUFFIX)) {
      id = name.slice(0, name.length - CONTENT_SUFFIX.length);
      kind = 'content';
    } else if (name.endsWith(META_SUFFIX)) {
      id = name.slice(0, name.length - META_SUFFIX.length);
      kind = 'meta';
    } else {
      continue; // unknown file: ignore, never delete
    }
    if (!HEX64.test(id)) continue; // not one of ours
    let entry = byId.get(id);
    if (!entry) { entry = { id, content: null, meta: null }; byId.set(id, entry); }
    entry[kind] = join(dir, name);
  }
  return { byId, names };
}

/**
 * Compute durable usage for a run. Sealed artifacts (content + meta that
 * match) count meta.sizeBytes; orphan content (published, meta absent)
 * counts the content file length — both are "published but the caller may
 * not have received the result". Each identity is counted exactly once.
 * Corruption (meta without content, digest/size mismatch, unparseable
 * meta) throws fail-closed so the budget never silently shrinks.
 */
async function computeUsage(dir, rootReal) {
  const { byId } = await scanRun(dir, rootReal);
  let total = 0;
  for (const entry of byId.values()) {
    if (entry.meta) {
      const meta = await safeReadMeta(entry.meta, rootReal);
      if (!entry.content) throw err('artifact_record_corrupt', 'artifact_record_corrupt');
      const content = await safeReadFile(entry.content, rootReal);
      if (sha256Hex(content) !== String(meta.digest).slice(7) || content.length !== Number(meta.sizeBytes)) {
        throw err('artifact_record_corrupt', 'artifact_record_corrupt');
      }
      total += Number(meta.sizeBytes);
    } else if (entry.content) {
      const st = await lstatSafe(entry.content);
      if (!st) continue;
      const real = await fs.realpath(entry.content);
      assertWithin(real, rootReal);
      total += st.size;
    }
  }
  return total;
}

/** Remove stale temp files (older than maxAgeMs) inside a run directory. */
async function cleanupStaleTempsIn(dir, rootReal, maxAgeMs) {
  let names;
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
  const real = await fs.realpath(dir);
  assertWithin(real, rootReal);
  const now = Date.now();
  let removed = 0;
  for (const name of names) {
    if (!name.includes(TMP_INFIX)) continue;
    const abs = join(dir, name);
    const st = await lstatSafe(abs);
    if (!st) continue;
    if (st.isSymbolicLink()) continue;
    if (now - st.mtimeMs < maxAgeMs) continue;
    await safeUnlink(abs);
    removed += 1;
  }
  return removed;
}

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
    const uri = buildArtifactUri(scopeDigestValue, rd, id);

    const contentBytes = encodeUtf8(request.content);
    const digest = 'sha256:' + sha256Hex(contentBytes);
    const sizeBytes = contentBytes.length;
    const ref = { uri, digest, mediaType: request.mediaType, sizeBytes, metadata };
    const metaRecord = { uri, digest, mediaType: request.mediaType, sizeBytes, metadata, createdAt: nowIso() };
    const metaBytes = Buffer.from(canonicalStringify(metaRecord), 'utf8');

    // Phase 1: reconcile any existing sealed record for this identity.
    // No directory is created here: safeExists returns false when the path
    // is absent, and a present meta/content implies the directory exists.
    if (await safeExists(metaPath, rootReal)) {
      const meta = await safeReadMeta(metaPath, rootReal);
      const content = await safeReadFile(contentPath, rootReal);
      if (sha256Hex(content) !== String(meta.digest).slice(7) || content.length !== Number(meta.sizeBytes)) {
        throw err('artifact_record_corrupt', 'artifact_record_corrupt');
      }
      if (
        meta.uri !== ref.uri || meta.digest !== ref.digest || meta.mediaType !== ref.mediaType
        || Number(meta.sizeBytes) !== ref.sizeBytes || !jsonEquals(meta.metadata, metadata)
      ) {
        throw err('artifact_identity_conflict', 'artifact_identity_conflict');
      }
      return ref; // idempotent
    }

    // Phase 2: publish content if it is not already on disk.
    const contentOnDisk = await safeExists(contentPath, rootReal);
    if (!contentOnDisk) {
      // Budget is enforced before any file or directory is touched. The
      // run directory may not exist yet; computeUsage returns 0 then.
      if (sizeBytes > maxItemBytes) throw err('artifact_too_large', 'artifact_too_large');
      const usage = await computeUsage(dir, rootReal);
      if (usage + sizeBytes > maxTotalBytes) throw err('artifact_budget_exceeded', 'artifact_budget_exceeded');
      checkSignal(request.signal);
      await ensureDirSafe(dir, rootReal);
      const result = await atomicPublish(contentPath, contentBytes, rootReal, { afterTmp: 'content-tmp', afterLink: 'content' });
      if (result === 'exists') {
        const existing = await safeReadFile(contentPath, rootReal);
        if (sha256Hex(existing) !== digest.slice(7) || existing.length !== sizeBytes) {
          throw err('artifact_identity_conflict', 'artifact_identity_conflict');
        }
      }
    } else {
      // Orphan content from a prior interrupted publication: reconcile.
      const existing = await safeReadFile(contentPath, rootReal);
      if (sha256Hex(existing) !== digest.slice(7) || existing.length !== sizeBytes) {
        throw err('artifact_identity_conflict', 'artifact_identity_conflict');
      }
    }

    // Phase 3: publish the metadata sidecar to seal the artifact.
    await ensureDirSafe(dir, rootReal);
    checkSignal(request.signal);
    const result = await atomicPublish(metaPath, metaBytes, rootReal, { afterTmp: 'meta-tmp', afterLink: 'meta' });
    if (result === 'exists') {
      const meta = await safeReadMeta(metaPath, rootReal);
      if (
        meta.uri !== ref.uri || meta.digest !== ref.digest || meta.mediaType !== ref.mediaType
        || Number(meta.sizeBytes) !== ref.sizeBytes || !jsonEquals(meta.metadata, metadata)
      ) {
        throw err('artifact_identity_conflict', 'artifact_identity_conflict');
      }
      const content = await safeReadFile(contentPath, rootReal);
      if (sha256Hex(content) !== String(meta.digest).slice(7) || content.length !== Number(meta.sizeBytes)) {
        throw err('artifact_record_corrupt', 'artifact_record_corrupt');
      }
    }
    return ref;
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
    if (
      meta.uri !== request.ref.uri || meta.digest !== request.ref.digest || meta.mediaType !== request.ref.mediaType
      || Number(meta.sizeBytes) !== request.ref.sizeBytes || !jsonEquals(meta.metadata, request.ref.metadata)
    ) {
      throw err('artifact_ref_changed', 'artifact_ref_changed');
    }
    const content = await safeReadFile(contentPath, rootReal);
    if (sha256Hex(content) !== request.ref.digest.slice(7) || content.length !== request.ref.sizeBytes) {
      throw err('artifact_content_integrity_mismatch', 'artifact_content_integrity_mismatch');
    }
    if (sha256Hex(content) !== String(meta.digest).slice(7) || content.length !== Number(meta.sizeBytes)) {
      throw err('artifact_record_corrupt', 'artifact_record_corrupt');
    }
    checkSignal(request.signal);
    const text = decodeUtf8Fatal(content);
    return sliceByCodePoints(text, request.offset, request.limit, maxReadChars);
  }

  /**
   * Literal, case-sensitive substring search over the current run's sealed
   * artifacts. Returns bounded refs in deterministic (URI) order. Only the
   * current run is scanned; other scopes or runs are never consulted.
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
      if (!entry.meta) continue; // orphan content (published, not sealed) is not searchable
      if (!entry.content) {
        // meta present without content is corruption: fail closed, never skip
        throw err('artifact_record_corrupt', 'artifact_record_corrupt');
      }
      const meta = await safeReadMeta(entry.meta, rootReal); // fail closed on corrupt meta
      if (Number(meta.sizeBytes) > maxScanBytes) continue; // too large to scan this pass
      const content = await safeReadFile(entry.content, rootReal); // fail closed if missing
      if (sha256Hex(content) !== String(meta.digest).slice(7) || content.length !== Number(meta.sizeBytes)) {
        throw err('artifact_record_corrupt', 'artifact_record_corrupt');
      }
      const text = decodeUtf8Fatal(content); // fail closed on bad UTF-8
      if (text.includes(request.query)) {
        matches.push({
          uri: meta.uri, digest: meta.digest, mediaType: meta.mediaType,
          sizeBytes: Number(meta.sizeBytes),
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
    return computeUsage(runDir(rd), rootReal);
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
