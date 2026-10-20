/**
 * Path resolution, escape/symlink protection and atomic publication for the
 * Native Node workspace tools. No external dependencies; Node >=22.19 builtins.
 *
 * The Python reference (ksadk.toolsets.workspace) resolves workspace paths with
 * pathlib.Path.resolve(), which follows symlinks for the existing portion of a
 * path and leaves a non-existent tail lexical. We reproduce that here so a
 * symlink inside the workspace that points outside is rejected before any read
 * or write, while a symlink that stays inside is followed.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync, closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, realpathSync, renameSync, unlinkSync, writeSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

export const TWO_MB = 2 * 1024 * 1024;

/** sha256 hex digest of a string (utf-8) or Buffer. */
export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

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
 * Resolve a workspace-relative path and enforce it stays inside the root.
 * Leading slashes and backslashes are normalized the way the Python port does:
 * backslashes become '/', a leading '/' is stripped, empty becomes '.'.
 * Throws a WorkspacePathError when the resolved target escapes the root.
 */
export function resolveWorkspacePath(root, rootReal, relativePath) {
  const raw = String(relativePath ?? '').trim().replace(/\\/g, '/').replace(/^\/+/, '') || '.';
  const lexical = resolve(rootReal, raw);
  if (!isInside(lexical, rootReal)) {
    throw new WorkspacePathError('workspace path must stay inside the workspace root');
  }
  const real = realpathExisting(lexical);
  if (!isInside(real, rootReal)) {
    throw new WorkspacePathError('workspace path must stay inside the workspace root');
  }
  return real;
}

/** Workspace-relative posix path for a resolved absolute target. */
export function workspaceRelative(rootReal, target) {
  const rel = relative(rootReal, target);
  return rel.split(sep).join('/');
}

export class WorkspacePathError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WorkspacePathError';
    this.code = 'workspace_path_escape';
  }
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

export class WorkspaceMutationError extends Error {
  constructor(message, code = 'workspace_mutation_failed') {
    super(message);
    this.name = 'WorkspaceMutationError';
    this.code = code;
  }
}

function randomHex(bytes) {
  return randomBytes(bytes).toString('hex');
}

/** fnmatch-style glob test (case-sensitive, matching POSIX normcase identity). */
export function fnmatch(name, pattern) {
  return globToRegex(pattern).test(name);
}

export function globToRegex(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      out += '.*';
    } else if (c === '?') {
      out += '.';
    } else if (c === '[') {
      const parsed = parseCharClass(pattern, i);
      if (parsed) {
        out += parsed.regex;
        i = parsed.next - 1;
      } else {
        out += '\\[';
      }
    } else if ('^$.+(){}|\\'.includes(c)) {
      out += '\\' + c;
    } else {
      out += c;
    }
  }
  return new RegExp('^' + out + '$');
}

function parseCharClass(pattern, start) {
  let j = start + 1;
  let negate = false;
  if (j < pattern.length && (pattern[j] === '!' || pattern[j] === '^')) {
    negate = true;
    j++;
  }
  let cls = '';
  if (j < pattern.length && pattern[j] === ']') {
    cls += '\\]';
    j++;
  }
  while (j < pattern.length && pattern[j] !== ']') {
    const ch = pattern[j];
    if (ch === '\\') cls += '\\\\';
    else if ('^$.+*?(){}|['.includes(ch)) cls += '\\' + ch;
    else cls += ch;
    j++;
  }
  if (j >= pattern.length) return null; // no closing bracket; treat '[' literally
  return { regex: '[' + (negate ? '^' : '') + cls + ']', next: j + 1 };
}

/** Escape a literal string for use in a RegExp. */
export function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
