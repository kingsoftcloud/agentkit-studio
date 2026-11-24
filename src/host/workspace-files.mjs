import { randomBytes } from 'node:crypto';
import {
  chmodSync, closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, realpathSync, renameSync, unlinkSync, writeSync,
} from 'node:fs';
import { dirname, join, sep } from 'node:path';

/** True when target is root or located beneath root (both absolute, posix-comparable). */
export function isInside(target, root) {
  if (target === root) return true;
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  return target.startsWith(rootWithSep);
}

/**
 * Resolve the existing portion of a path through symlinks, leaving a
 * non-existent tail lexical. Mirrors pathlib.Path.resolve(strict=False).
 */
export function realpathExisting(p) {
  if (existsSync(p)) return realpathSync(p);
  const tail = [];
  let head = p;
  // Walk up to the longest existing ancestor; resolve it, then re-append.
  while (!existsSync(head)) {
    const base = dirname(head);
    if (base === head) break; // reached filesystem root
    tail.unshift(head.slice(base.length + 1) || head.slice(base.length));
    head = base;
  }
  const realHead = existsSync(head) ? realpathSync(head) : head;
  return tail.length ? join(realHead, ...tail) : realHead;
}

/**
 * Publish a complete sibling file atomically. Never truncate the target in
 * place: write to a fresh temp sibling, fsync, then link (create-only) or
 * rename (overwrite). Preserves an existing file's mode. A failed publication
 * leaves the original content and read-state unchanged.
 *
 * Mirrors ksadk.toolsets.workspace_mutation.publish_workspace_bytes.
 */
export function publishWorkspaceBytes(target, payload, { createOnly = false } = {}) {
  const parent = dirname(target);
  mkdirSync(parent, { recursive: true });
  let mode = null;
  try {
    const info = lstatSync(target);
    if (!info.isFile()) throw new WorkspaceMutationError('workspace mutation requires a regular file');
    mode = info.mode & 0o777;
  } catch (error) {
    if (error instanceof WorkspaceMutationError) throw error;
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = join(parent, `.${target.split(sep).pop()}.native-${randomHex(12)}`);
  const fd = openSync(temporary, 'wx', 0o666);
  try {
    writeAll(fd, payload);
    closeSync(fd);
    if (mode !== null) applyMode(temporary, mode);
    if (createOnly) {
      linkSync(temporary, target); // fails if target now exists (race-safe create)
    } else {
      renameSync(temporary, target); // atomic replace of the directory entry
    }
  } catch (error) {
    // writeAll/close/chmod/link/rename failed: ensure the fd is closed and the
    // temp sibling is removed. The original target is never touched on this
    // path (link/rename are the only steps that affect it), so its content and
    // the read-state the caller recorded remain intact.
    try { closeSync(fd); } catch { /* already closed or never opened */ }
    safeUnlink(temporary);
    throw error;
  } finally {
    // A successful create-only publication leaves the temporary hard link in
    // place until it is unlinked here. Rename has already removed its name.
    safeUnlink(temporary);
  }
}

function writeAll(fd, payload) {
  // The caller owns closing fd on success; on failure the caller's catch
  // closes it. fsync before returning so the bytes are durable before the
  // atomic link/rename.
  const buffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf-8');
  let offset = 0;
  while (offset < buffer.length) {
    const written = writeSync(fd, buffer, offset);
    if (written <= 0) throw new WorkspaceMutationError('workspace write stalled');
    offset += written;
  }
  fsyncSync(fd);
}

function applyMode(target, mode) {
  try {
    // chmod the temp file to match the pre-existing target's permission bits.
    chmodSync(target, mode);
  } catch {
    /* best-effort; a failed chmod must not abort an otherwise valid publish */
  }
}

function safeUnlink(p) {
  try { unlinkSync(p); } catch { /* already gone */ }
}

class WorkspaceMutationError extends Error {
  constructor(message, code = 'workspace_mutation_failed') {
    super(message);
    this.name = 'WorkspaceMutationError';
    this.code = code;
  }
}

function randomHex(bytes) {
  return randomBytes(bytes).toString('hex');
}
