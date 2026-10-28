/**
 * Scoped Node child file workspaces and version-checked publication.
 *
 * Ports ksadk.harness.workspace_adapters.native_isolation @355059d to a pure
 * Node/ESM module. These are immutable input assets, not a second Run ledger:
 * file tools are confined to the child directory; arbitrary host-user processes
 * are not a sandbox. The host keeps workspaces for follow-up and recovery.
 *
 * Faithful to the reference semantics that matter:
 *  - ``prepare`` freezes the actual input files ONCE, preserving dirty and
 *    untracked content; it is idempotent and never resets a child's changes.
 *  - ``merge`` prechecks ALL conflicts before writing; an unrelated parent
 *    change is preserved; an OS failure reports the real applied prefix
 *    (multi-file publication is NOT an atomic transaction).
 *  - a previous publication is granted ONLY by a caller-supplied receipt
 *    (``previous``) whose immutable inventory is verified against disk; a
 *    saved inventory existing on disk never authorizes another merge.
 *  - identity is a Host-supplied 64-hex string; model paths are never accepted.
 *  - .git/.agentkit/.harness-tools/.artifacts are ignored; symlinks and special
 *    files are rejected; the 64 MiB payload limit is enforced.
 *
 * Cross-process coordination uses a per-path SQLite BEGIN IMMEDIATE transaction
 * (the same primitive the Node workspace state store uses). SQLite's busy_timeout
 * retries a contended BEGIN, but that retry is a SYNCHRONOUS busy-wait that
 * blocks the Node event loop — callers must not hold the lock across an await.
 * The OS releases the lock when the process exits (no stale lockfile recovery).
 * Production workspace-tools.mjs acquires the same source-mutation lock for
 * builtin writes. Arbitrary commands and external editors do not participate.
 * The Host owns Run/fence/approval and
 * child-completion checks; this module provides the synchronous final guard
 * checkpoints and never loosens a boundary after an await.
 */
import { createHash } from 'node:crypto';
import {
  chmodSync, closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, readlinkSync, readSync, realpathSync,
  renameSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { publishWorkspaceBytes, sha256, isInside, realpathExisting } from './workspace-paths.mjs';
import { acquireWorkspaceMutationLock } from './workspace-mutation-lock.mjs';

export const CHILD_FILE_WORKSPACE_VERSION = 'native-child-files/v1';
export const CHILD_FILE_PUBLICATION_VERSION = 'native-child-publication/v1';
export const IGNORED_PATH_PARTS = new Set(['.git', '.agentkit', '.harness-tools', '.artifacts']);
export const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
const HEX64 = /^[0-9a-f]{64}$/u;
const REVISION_RE = /^sha256:[0-9a-f]{64}$/u;

/** A safe host diagnostic that contains no source text or credentials. */
export class ChildWorkspaceError extends Error {
  constructor(reason) { super(reason); this.name = 'ChildWorkspaceError'; this.code = reason; }
}

/** A frozen child workspace input snapshot. */
export class ChildFileWorkspace {
  constructor(isolationId, root, baseline, baseRevision) {
    this.isolationId = isolationId;
    this.root = root;
    this.baseline = baseline;
    this.baseRevision = baseRevision;
  }
}

/** A host grant from an acknowledged merge, never inferred from disk. */
export class ChildFilePublication {
  constructor(revision, inventoryDigest) {
    this.revision = revision;
    this.inventoryDigest = inventoryDigest;
  }
}

/** A directory entry in the immutable inventory. */
export class DirectoryEntry {
  constructor(path, kind, mode, contentDigest) {
    this.path = path;
    this.kind = kind;
    this.mode = mode;
    this.contentDigest = contentDigest ?? null;
  }
  equals(other) {
    return other && this.path === other.path && this.kind === other.kind
      && this.mode === other.mode && (this.contentDigest ?? null) === (other.contentDigest ?? null);
  }
}

// ---- cross-process coordination ----------------------------------------------

/** Acquire shared workspace-mutation locks for one or more paths, all-or-nothing
 *  by sorted canonical order. Uses the shared workspace-mutation-lock.mjs so
 *  builtin workspace-tools workers (which the Host wires to the same lock)
 *  coordinate with this module. SQLite BEGIN IMMEDIATE; synchronous busy-wait
 *  BLOCKS the event loop — never hold across an await. The OS releases on
 *  process exit. */
function lockPaths(paths, { timeoutMs = 10000 } = {}) {
  const sorted = [...new Set(paths.filter(Boolean).map(p => resolve(p)))].sort();
  const releases = [];
  try {
    for (const p of sorted) releases.push(acquireWorkspaceMutationLock(p, { timeoutMs }));
  } catch (error) {
    for (const r of releases) { try { r(); } catch { /* best-effort */ } }
    if (error.code === 'workspace_mutation_busy') throw new ChildWorkspaceError('child_workspace_lock_timeout');
    throw error;
  }
  return () => { for (const r of releases) { try { r(); } catch { /* best-effort */ } } };
}

// ---- inventory capture -------------------------------------------------------

const MAX_INVENTORY_ENTRIES = 2048;
const MAX_INVENTORY_BYTES = 64 * 1024 * 1024;

/** Capture a stable inventory: two passes must agree. Mirrors the reference
 *  double-capture (native_directory) and the Node workspace-tools observe.
 *  Exported for testing and for the Host's final guard checkpoint. */
export function captureInventory(root) {
  const first = scanInventory(root);
  const second = scanInventory(root);
  if (first.digest !== second.digest || first.entryCount !== second.entryCount
    || !entriesIdentical(first.list, second.list)) {
    throw new ChildWorkspaceError('child_workspace_changed_during_capture');
  }
  return { revision: 'sha256:' + second.digest, entries: second.byPath };
}

function entriesIdentical(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function scanInventory(root) {
  const hash = createHash('sha256');
  hash.update('ksadk.directory-workspace/v1\0');
  const state = { entries: 0, hashedBytes: 0, list: [], byPath: Object.create(null) };
  scanDir(root, '', hash, state, root);
  state.list.sort();
  return { digest: hash.digest('hex'), entryCount: state.entries, list: state.list, byPath: state.byPath };
}

function isIgnored(name) { return IGNORED_PATH_PARTS.has(name); }

function scanDir(root, rel, hash, state, rootReal) {
  const dir = rel ? join(root, rel) : root;
  let dirents;
  try { dirents = readdirSync(dir, { withFileTypes: true }); } catch { throw new ChildWorkspaceError('child_workspace_capture_failed'); }
  dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const d of dirents) {
    if (isIgnored(d.name)) continue;
    const entryRel = rel ? `${rel}/${d.name}` : d.name;
    if (entryRel.includes('\\') || entryRel.includes('\0')) throw new ChildWorkspaceError('child_workspace_unsupported_path');
    state.entries += 1;
    if (state.entries > MAX_INVENTORY_ENTRIES) throw new ChildWorkspaceError('child_workspace_capture_limit');
    const abs = join(root, entryRel);
    let info;
    try { info = lstatSync(abs, { bigint: true }); } catch { throw new ChildWorkspaceError('child_workspace_capture_failed'); }
    if (info.isSymbolicLink()) throw new ChildWorkspaceError('child_workspace_symlink_entry');
    // The digest hashes ONLY path, mode, kind and content digest — NOT mtimeNs
    // or ino (a copy of the same content has a different mtime/ino but is the
    // same workspace revision). The before/after identity (including mtime/ino)
    // is a per-entry change-detection check within ONE scan, not part of the
    // revision or the cross-scan comparison.
    const before = entryIdentity(info);
    hash.update(`\0path\0${entryRel}`);
    hash.update(`\0mode:${Number(info.mode & 0o777n).toString(8)}`);
    if (info.isDirectory()) {
      hash.update('\0directory');
      scanDir(root, entryRel, hash, state, rootReal);
      state.list.push(entryRel);
      state.byPath[entryRel] = new DirectoryEntry(entryRel, 'directory', Number(info.mode & 0o777n), null);
    } else if (info.isFile()) {
      if (state.hashedBytes + Number(info.size) > MAX_INVENTORY_BYTES) throw new ChildWorkspaceError('child_workspace_capture_limit');
      const { raw, hex, readBytes } = hashFile(abs, Number(info.size));
      if (readBytes !== Number(info.size)) throw new ChildWorkspaceError('child_workspace_changed_during_capture');
      // Feed the RAW 32-byte file digest into the directory hash (matching
      // workspace-tools.mjs), not the 64-char hex string.
      hash.update('\0file\0');
      hash.update(raw);
      state.hashedBytes += readBytes;
      state.list.push(entryRel);
      state.byPath[entryRel] = new DirectoryEntry(entryRel, 'file', Number(info.mode & 0o777n), 'sha256:' + hex);
    } else {
      throw new ChildWorkspaceError('child_workspace_special_entry');
    }
    let after;
    try { after = entryIdentity(lstatSync(abs, { bigint: true })); } catch { throw new ChildWorkspaceError('child_workspace_capture_failed'); }
    if (after !== before) throw new ChildWorkspaceError('child_workspace_changed_during_capture');
  }
}

function entryIdentity(info) {
  return `${info.mode}|${info.size}|${info.mtimeNs}|${info.ctimeNs}|${info.ino}`;
}

function hashFile(abs, size) {
  const fileHash = createHash('sha256');
  const fd = openSync(abs, 'r');
  let readBytes = 0;
  try {
    let remaining = size;
    const buf = Buffer.alloc(1024 * 1024);
    while (remaining > 0) {
      const n = readSync(fd, buf, 0, Math.min(buf.length, remaining), null);
      if (n === 0) break;
      readBytes += n;
      fileHash.update(buf.subarray(0, n));
      remaining -= n;
    }
  } finally { closeSync(fd); }
  // Return the RAW 32-byte digest for the directory hash (matching
  // workspace-tools.mjs which feeds fileHash.digest() directly into the
  // directory hash, NOT the 64-char hex string). Also return the hex form
  // for the DirectoryEntry content_digest ('sha256:' + hex).
  const raw = fileHash.digest();
  return { raw, hex: raw.toString('hex'), readBytes };
}

/** Read a file payload bounded by MAX_PAYLOAD_BYTES, verifying its content
 *  digest matches the expected entry. Rejects symlinks, specials, and a changed
 *  digest (the file was modified after the inventory capture). */
function readPayload(root, rel, expected) {
  const target = join(root, rel);
  let info;
  try { info = lstatSync(target, { bigint: true }); } catch { throw new ChildWorkspaceError('child_workspace_file_changed'); }
  if (info.isSymbolicLink() || !info.isFile()) throw new ChildWorkspaceError('child_workspace_file_changed');
  const fd = openSync(target, 'r');
  let value;
  try {
    value = Buffer.alloc(0);
    const chunks = [];
    let total = 0;
    const buf = Buffer.alloc(1024 * 1024);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      total += n;
      if (total > MAX_PAYLOAD_BYTES) throw new ChildWorkspaceError('child_workspace_file_changed');
      chunks.push(Buffer.from(buf.subarray(0, n)));
    }
    value = Buffer.concat(chunks);
  } finally { closeSync(fd); }
  if ('sha256:' + sha256(value) !== expected.contentDigest) throw new ChildWorkspaceError('child_workspace_file_changed');
  return value;
}

// ---- DirectoryChildWorkspaces ------------------------------------------------

export class DirectoryChildWorkspaces {
  /** @param {{source:string, storage:string, sourceDatabase?:string}} opts */
  constructor({ source, storage, sourceDatabase } = {}) {
    if (!source) throw new TypeError('DirectoryChildWorkspaces requires source');
    if (!storage) throw new TypeError('DirectoryChildWorkspaces requires storage');
    // Canonicalize roots: resolve symlinks for existing paths (macOS /var is a
    // symlink to /private/var — this normalizes it). For a not-yet-created
    // storage, resolve the closest existing ancestor and append the tail
    // lexically. Pin the canonical forms; every prepare/load/merge re-checks
    // the live realpath against these to detect a root or ancestor swap.
    this.source = canonicalRoot(source);
    this.storage = canonicalRoot(storage);
    this.sourceDatabase = sourceDatabase ? resolve(sourceDatabase) : null;
    // The storage must NOT be inside the source: a capture of the source would
    // then recurse into the storage tree. Reject symlinked source/storage roots
    // and a storage that is the source or beneath it. Use canonical paths so a
    // symlinked alias cannot bypass this.
    if (isSymlink(resolve(source)) || isSymlink(resolve(storage)))
      throw new ChildWorkspaceError('child_workspace_root_symlink');
    if (this.storage === this.source || isInside(this.storage, this.source))
      throw new ChildWorkspaceError('child_workspace_storage_inside_source');
  }

  /** Re-verify the live canonical roots match the pinned roots. A symlink or
   *  ancestor swap after construction changes the realpath; that is a new root,
   *  not the one this module was bound to. */
  _checkRoots() {
    if (canonicalRoot(this.source) !== this.source) throw new ChildWorkspaceError('child_workspace_root_changed');
    if (canonicalRoot(this.storage) !== this.storage) throw new ChildWorkspaceError('child_workspace_root_changed');
  }

  /** Verify a workspace object's root/baseline actually belong to THIS storage
   *  under the original identity and were not swapped to an external directory.
   *  Also verify the workspace's own manifest fields (source, base_revision,
   *  isolation_id) match this module's binding. A forged workspace.root must
   *  never publish outside the bound source. */
  _validateWorkspace(workspace) {
    if (!workspace || typeof workspace.isolationId !== 'string' || !HEX64.test(workspace.isolationId))
      throw new ChildWorkspaceError('child_workspace_identity_invalid');
    this._checkRoots();
    const expectedTarget = canonicalRoot(join(this.storage, workspace.isolationId));
    const expectedRoot = join(expectedTarget, 'work');
    const expectedBaseline = join(expectedTarget, 'base');
    // Use realpath (via canonicalRoot) so a symlink swap on the workspace root
    // or an ancestor is detected — resolve() alone only lexical-normalizes and
    // does NOT follow symlinks for the non-existent tail.
    if (canonicalRoot(workspace.root) !== expectedRoot || canonicalRoot(workspace.baseline) !== expectedBaseline)
      throw new ChildWorkspaceError('child_workspace_path_escape');
    if (isSymlink(workspace.root) || isSymlink(workspace.baseline)
      || isSymlink(expectedTarget) || isSymlink(join(this.storage, workspace.isolationId)))
      throw new ChildWorkspaceError('child_workspace_path_escape');
    // The root and baseline must still be directories (not replaced with a file).
    if (!isDir(workspace.root) || !isDir(workspace.baseline))
      throw new ChildWorkspaceError('child_workspace_path_escape');
    const original = this.load(workspace.isolationId);
    if (workspace.baseRevision !== original.baseRevision)
      throw new ChildWorkspaceError('child_workspace_identity_changed');
  }

  /** Freeze actual input files once, preserving dirty and untracked content.
   *  Idempotent: a re-prepare for the same identity reuses the existing child
   *  and never resets its changes. */
  prepare(identity) {
    if (typeof identity !== 'string' || !HEX64.test(identity)) throw new ChildWorkspaceError('child_workspace_identity_invalid');
    this._checkRoots();
    mkdirSync(this.storage, { recursive: true });
    const target = join(this.storage, identity);
    // Lock BOTH source and target (sorted canonical order) so the parent source
    // cannot be written while we capture and copy its files. The lock is
    // synchronous and released in a finally — never held across an await.
    const release = lockPaths([this.source, target]);
    try {
      if (existsSync(target)) return this.load(identity);
      const temporary = join(this.storage, `.child-input-${identity.slice(0, 12)}-${process.pid}`);
      mkdirSync(temporary, { recursive: true });
      try {
        if (existsSync(target)) return this.load(identity);
        const { revision, entries } = captureInventory(this.source);
        mkdirSync(join(temporary, 'base'), { recursive: true });
        mkdirSync(join(temporary, 'work'), { recursive: true });
        const sortedEntries = Object.entries(entries).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
        // Copy files first, then set directory modes in reverse so a parent
        // mode is not overridden by a later mkdir.
        for (const [, entry] of sortedEntries) {
          if (entry.kind === 'directory') {
            mkdirSync(join(temporary, 'base', entry.path), { recursive: true });
            mkdirSync(join(temporary, 'work', entry.path), { recursive: true });
          }
        }
        for (const [, entry] of sortedEntries) {
          if (entry.kind === 'file') {
            const payload = readPayload(this.source, entry.path, entry);
            for (const tree of ['base', 'work']) {
              const dest = join(temporary, tree, entry.path);
              mkdirSync(dirname(dest), { recursive: true });
              writeFileSync(dest, payload);
              chmodSync(dest, entry.mode);
            }
          }
        }
        for (let i = sortedEntries.length - 1; i >= 0; i--) {
          const [, entry] = sortedEntries[i];
          if (entry.kind === 'directory') {
            chmodSync(join(temporary, 'base', entry.path), entry.mode);
            chmodSync(join(temporary, 'work', entry.path), entry.mode);
          }
        }
        // Re-verify the source did not change during the copy (held under the
        // source lock, but a concurrent non-coordinated writer could still change
        // it; the double-capture catches that).
        const current = captureInventory(this.source);
        if (current.revision !== revision) throw new ChildWorkspaceError('child_workspace_source_changed');
        writeFileSync(join(temporary, 'inputs.json'), JSON.stringify({
          version: CHILD_FILE_WORKSPACE_VERSION, identity, source: this.source, base_revision: revision,
        }));
        try { renameSync(temporary, target); }
        catch (error) {
          if (error.code === 'ENOTEMPTY' || error.code === 'EEXIST') {
            // Another process published the same identity; reuse it.
            return this.load(identity);
          }
          throw error;
        }
        return this.load(identity);
      } finally {
        if (existsSync(temporary)) { try { rmdirRecursive(temporary); } catch { /* best-effort */ } }
      }
    } finally { release(); }
  }

  /** Load an existing frozen workspace, verifying its manifest identity. */
  load(identity) {
    if (typeof identity !== 'string' || !HEX64.test(identity)) throw new ChildWorkspaceError('child_workspace_identity_invalid');
    this._checkRoots();
    const target = join(this.storage, identity);
    if (!existsSync(target)) throw new ChildWorkspaceError('child_workspace_not_prepared');
    const manifestPath = join(target, 'inputs.json');
    if (isSymlink(manifestPath) || isSymlink(target)) throw new ChildWorkspaceError('child_workspace_identity_changed');
    let data;
    try { data = JSON.parse(readFileSync(manifestPath, 'utf-8')); } catch { throw new ChildWorkspaceError('child_workspace_identity_changed'); }
    if (data.version !== CHILD_FILE_WORKSPACE_VERSION || data.identity !== identity
      || data.source !== this.source || isSymlink(join(target, 'work')) || !isDir(join(target, 'work'))
      || !REVISION_RE.test(data.base_revision) || !isDir(join(target, 'base'))
      || isSymlink(join(target, 'base'))) throw new ChildWorkspaceError('child_workspace_identity_changed');
    return new ChildFileWorkspace(identity, join(target, 'work'), join(target, 'base'), data.base_revision);
  }

  /** Return an observer bound to the workspace root, sharing the double-capture
   *  revision algorithm with createNativeWorkspaceTools().observe. */
  observer(workspace) {
    return {
      observe: () => {
        // Reject a forged workspace.root — the observer must not vouch for an
        // arbitrary external path. This validates ownership before capturing.
        try { this._validateWorkspace(workspace); } catch (error) {
          if (error instanceof ChildWorkspaceError)
            return { revision: null, changedPaths: [], status: 'unavailable', reason: error.code };
          throw error;
        }
        try {
          const { revision } = captureInventory(workspace.root);
          return { revision, changedPaths: [], status: 'ok', reason: null };
        } catch (error) {
          if (error instanceof ChildWorkspaceError) return { revision: null, changedPaths: [], status: 'unavailable', reason: error.code };
          return { revision: null, changedPaths: [], status: 'unavailable', reason: 'capture_failed' };
        }
      },
    };
  }

  // ---- publication inventory -------------------------------------------------

  _publicationPath(workspace, revision) {
    if (typeof revision !== 'string' || !REVISION_RE.test(revision)) throw new ChildWorkspaceError('child_publication_identity_invalid');
    return join(dirname(workspace.root), 'publications', `${revision.slice(7)}.json`);
  }

  /** Verify a caller-supplied previous publication against its immutable disk
   *  inventory. A missing/tampered/foreign inventory returns null (no grant). */
  _verifyPreviousPublication(workspace, previous) {
    if (!previous || typeof previous.revision !== 'string' || typeof previous.inventoryDigest !== 'string') return null;
    const target = this._publicationPath(workspace, previous.revision);
    if (!existsSync(target) || isSymlink(target) || isSymlink(dirname(target))) return null;
    let value;
    try { value = readFileSync(target); } catch { return null; }
    if ('sha256:' + sha256(value) !== previous.inventoryDigest) return null;
    let data;
    try { data = JSON.parse(value); } catch { return null; }
    if (data.version !== CHILD_FILE_PUBLICATION_VERSION || data.isolation_id !== workspace.isolationId
      || data.source !== this.source || data.base_revision !== workspace.baseRevision
      || data.child_revision !== previous.revision) return null;
    const entries = Object.create(null);
    for (const e of data.entries) entries[e.path] = new DirectoryEntry(e.path, e.kind, e.mode, e.content_digest);
    return entries;
  }

  _savePublication(workspace, revision, entries) {
    const target = this._publicationPath(workspace, revision);
    const value = Buffer.from(JSON.stringify({
      version: CHILD_FILE_PUBLICATION_VERSION, isolation_id: workspace.isolationId,
      source: this.source, base_revision: workspace.baseRevision,
      child_revision: revision, entries: Object.values(entries).map(e => ({
        path: e.path, kind: e.kind, mode: e.mode, content_digest: e.contentDigest,
      })),
    }), 'utf-8');
    mkdirSync(dirname(target), { recursive: true });
    if (isSymlink(target) || isSymlink(dirname(target))) throw new ChildWorkspaceError('child_publication_inventory_changed');
    if (existsSync(target)) {
      if (readFileSync(target).toString('utf-8') !== value.toString('utf-8')) throw new ChildWorkspaceError('child_publication_inventory_changed');
    } else {
      publishWorkspaceBytes(target, value, { createOnly: true });
    }
    return { revision, inventory_digest: 'sha256:' + sha256(value) };
  }

  /** Publish eligible files only when the parent still matches the base.
   *  A conflict publishes nothing. An OS failure reports the real applied
   *  prefix — this is NOT an atomic multi-file transaction.
   *  @param {object} [opts] merge options
   *  @param {string} opts.expectedRevision the current child workspace revision
   *  @param {ChildFilePublication} [opts.previous] a caller-supplied acknowledged publication
   *  @param {function():true} [opts.assertCurrent] a synchronous Host guard the
   *    module calls after acquiring the lock, after the precheck, and before
   *    each real publish/delete. It must return strictly === true; any other
   *    value (or throw) aborts the merge with no further writes. The Host owns
   *    the real ledger/fence/receipt; this module never assumes true by default. */
  merge(workspace, { expectedRevision, previous, assertCurrent } = {}) {
    // Reject a forged workspace whose root/baseline do not belong to this
    // storage under the original identity — before any lock or write.
    this._validateWorkspace(workspace);
    const applied = [];
    const guard = () => {
      if (assertCurrent === undefined) return;
      try {
        if (typeof assertCurrent !== 'function') throw new ChildWorkspaceError('child_workspace_guard_failed');
        const result = assertCurrent();
        if (result !== true) {
          if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {});
          throw new ChildWorkspaceError('child_workspace_guard_failed');
        }
      } catch (error) {
        // A revoked lease after a published prefix cannot become a clean
        // rejection inviting a blind retry. Preserve the actual prefix for
        // the owning Native ToolPort's uncertain receipt.
        const failure = new ChildWorkspaceError('child_workspace_guard_failed');
        failure.applied = [...applied];
        failure.effectStarted = applied.length > 0;
        throw failure;
      }
    };
    guard();
    // All conflict checks happen BEFORE any write. The critical section is
    // synchronous; no boundary is loosened after an await (there is no await).
    const release = lockPaths([this.source, workspace.root, workspace.baseline]);
    try {
      // The post-lock guard is INSIDE the try so a guard failure still releases
      // all locks in the finally below. A guard failure must never leak a lock.
      guard();
      const baseCapture = captureInventory(workspace.baseline);
      if (baseCapture.revision !== workspace.baseRevision) throw new ChildWorkspaceError('child_workspace_baseline_changed');
      const childCapture = captureInventory(workspace.root);
      if (childCapture.revision !== expectedRevision) throw new ChildWorkspaceError('child_workspace_after_delivery_changed');
      const verifiedPrevious = previous ? this._verifyPreviousPublication(workspace, previous) : null;
      const usedPrevious = !!verifiedPrevious;
      const baseline = verifiedPrevious ?? baseCapture.entries;
      const proposal = childCapture.entries;
      // Files that are files in EITHER the baseline or the proposal.
      const files = new Set();
      for (const [path, entry] of Object.entries(baseline)) if (entry.kind === 'file') files.add(path);
      for (const [path, entry] of Object.entries(proposal)) if (entry.kind === 'file') files.add(path);
      const changed = [...files].filter(path => {
        const b = baseline[path], p = proposal[path];
        return !b || !p || !b.equals(p);
      }).sort();
      // A file becoming a directory or vice versa is a hard error.
      for (const path of changed) {
        const b = baseline[path], p = proposal[path];
        if (b && p && b.kind !== p.kind) throw new ChildWorkspaceError('child_workspace_file_kind_changed');
      }
      const directories = new Set();
      for (const [path, entry] of Object.entries(baseline)) if (entry.kind === 'directory') directories.add(path);
      for (const [path, entry] of Object.entries(proposal)) if (entry.kind === 'directory') directories.add(path);
      const changedDirectories = [...directories].filter(path => {
        const b = baseline[path], p = proposal[path];
        return !b || !p || !b.equals(p);
      });
      const removedDirectories = new Set(changedDirectories.filter(path => !proposal[path]));
      // Re-capture the parent to detect conflicts with concurrent changes.
      // The comparison is a strict three-way check: parent.get(path) must be in
      // (baseline.get(path), proposal.get(path)), where null (absent) is a real
      // state. A parent DELETION (null) while the child edited the file is a
      // conflict — the child's edit must not resurrect a parent-deleted file.
      // null === null via entryEquals; both absent is NOT a conflict.
      const parentCapture = captureInventory(this.source);
      const parent = parentCapture.entries;
      const entryEquals = (a, b) => (!a && !b) || (!!a && !!b && a.equals(b));
      const conflicts = [];
      for (const path of changed) {
        if (!entryEquals(parent[path], baseline[path]) && !entryEquals(parent[path], proposal[path]))
          conflicts.push(path);
      }
      for (const path of changedDirectories) {
        if (!entryEquals(parent[path], baseline[path]) && !entryEquals(parent[path], proposal[path]))
          conflicts.push(path);
      }
      // A late parent file added inside a removed directory must be preserved.
      for (const [path] of Object.entries(parent)) {
        if (!baseline[path]) {
          for (const dir of removedDirectories) {
            if (path.startsWith(dir + '/')) { conflicts.push(path); break; }
          }
        }
      }
      if (conflicts.length) {
        return {
          ok: false, error_code: 'child_workspace_merge_conflict',
          conflicts: [...new Set(conflicts)].sort(), applied: [],
          comparison_revision: usedPrevious ? previous.revision : baseCapture.revision,
          instruction: 'Read the current parent file and resolve the conflict with its ordinary authorized editing tools. Nothing was merged.',
        };
      }
      guard();
      // Save the immutable publication inventory BEFORE applying, so a crash
      // after the save but before a partial apply leaves a verifiable receipt.
      const publication = this._savePublication(workspace, childCapture.revision, proposal);
      const payloads = Object.create(null);
      for (const path of changed) {
        if (proposal[path]) payloads[path] = readPayload(workspace.root, path, proposal[path]);
      }
      const alreadyPresent = [];
      // Create/mode directories first (shallow-to-deep), then files, then remove
      // directories (deep-to-shallow) so an empty directory's children are gone.
      const createOrMode = changedDirectories.filter(d => !removedDirectories.has(d))
        .sort((a, b) => (a.split('/').length - b.split('/').length) || (a < b ? -1 : a > b ? 1 : 0));
      const remove = [...removedDirectories].sort((a, b) => (b.split('/').length - a.split('/').length) || (a < b ? -1 : a > b ? 1 : 0));
      const order = [...createOrMode, ...changed, ...remove];
      for (const path of order) {
        // Both absent (parent and proposal both deleted) is already-present
        // (nothing to do); both present and equal is already-present. Use the
        // same entryEquals as the conflict check so null is a real state.
        if (entryEquals(parent[path], proposal[path])) { alreadyPresent.push(path); continue; }
        const target = join(this.source, path);
        guard();
        try {
          if (changedDirectories.includes(path) || removedDirectories.has(path)) {
            if (!proposal[path]) {
              // Never recursively delete: only remove an empty directory.
              rmdirSync(target);
            } else if (!parent[path]) {
              mkdirSync(target, { recursive: true });
            }
            applied.push(path);
            if (proposal[path]) chmodSync(target, proposal[path].mode);
          } else if (proposal[path]) {
            publishWorkspaceBytes(target, payloads[path], { createOnly: !baseline[path] });
            applied.push(path);
            chmodSync(target, proposal[path].mode);
          } else {
            unlinkSync(target);
            applied.push(path);
          }
        } catch (error) {
          if (error instanceof ChildWorkspaceError) throw error;
          return {
            ok: false, error_code: 'child_workspace_publish_failed',
            applied, failed_path: path,
            instruction: 'Inspect the reported files before continuing; this is not an atomic multi-file transaction.',
          };
        }
      }
      return {
        ok: true, applied, already_present: alreadyPresent,
        base_revision: baseCapture.revision, child_revision: childCapture.revision,
        comparison_revision: usedPrevious ? previous.revision : baseCapture.revision,
        publication,
      };
    } finally { release(); }
  }
}

// ---- helpers ----------------------------------------------------------------

/** Canonicalize a root path: resolve symlinks for the existing portion (like
 *  Python's Path.resolve()), normalizing macOS /var → /private/var aliases.
 *  For a not-yet-created path, resolve the closest existing ancestor and
 *  append the non-existent tail lexically. This is NOT a substitute for a
 *  trusted directory fd, but it detects a swap visible at the path string. */
function canonicalRoot(p) {
  const resolved = resolve(p);
  if (existsSync(resolved)) {
    try { return realpathSync(resolved); } catch { return resolved; }
  }
  return realpathExisting(resolved);
}

function isSymlink(p) { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } }
function isDir(p) { try { return lstatSync(p).isDirectory(); } catch { return false; } }
function rmdirRecursive(p) {
  let dirents;
  try { dirents = readdirSync(p, { withFileTypes: true }); } catch { return; }
  for (const d of dirents) {
    const abs = join(p, d.name);
    if (d.isDirectory()) rmdirRecursive(abs);
    else try { unlinkSync(abs); } catch { /* gone */ }
  }
  try { rmdirSync(p); } catch { /* not empty */ }
}
