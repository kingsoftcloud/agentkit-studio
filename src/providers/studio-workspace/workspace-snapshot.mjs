import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readlinkSync, readSync } from 'node:fs';
import { join } from 'node:path';

const MAX_ENTRIES = 2048;
const MAX_HASHED_BYTES = 64 * 1024 * 1024;

class CaptureError extends Error {
  constructor(code) { super(code); this.code = code; this.name = 'CaptureError'; }
}

export function captureWorkspace(root) {
  const first = captureInventory(root), second = captureInventory(root);
  if (first.digest !== second.digest || first.entryCount !== second.entryCount || !entriesEqual(first.entries, second.entries))
    throw new CaptureError('workspace_changed_during_capture');
  return { revision: 'sha256:' + second.digest, entries: { ...second.byPath } };
}

function captureInventory(root) {
  const hash = createHash('sha256');
  hash.update('ksadk.directory-workspace/v1\0');
  const state = { entries: 0, hashedBytes: 0, list: [], byPath: Object.create(null), buffer: Buffer.allocUnsafe(1024 * 1024) };
  scanDir(root, '', hash, state);
  state.list.sort();
  return { digest: hash.digest('hex'), entryCount: state.entries, entries: state.list, byPath: state.byPath };
}

/** Compare two sorted entry-identity lists for exact equality. */
function entriesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function scanDir(real, rel, hash, state) {
  const dir = rel ? join(real, rel) : real;
  let dirents;
  try { dirents = readdirSync(dir, { withFileTypes: true }); } catch { throw new CaptureError('capture_failed'); }
  dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const d of dirents) {
    const entryRel = rel ? `${rel}/${d.name}` : d.name;
    if (entryRel.includes('\\') || entryRel.includes('\0')) throw new CaptureError('unsupported_workspace_path');
    state.entries += 1;
    if (state.entries > MAX_ENTRIES) throw new CaptureError('capture_limit_exceeded');
    const abs = join(real, entryRel);
    let info;
    try { info = lstatSync(abs, { bigint: true }); } catch { throw new CaptureError('capture_failed'); }
    // Re-stat after opening files below would race; record the pre-read identity
    // and verify it again at the end of the entry so a mid-entry change is caught.
    const before = entryIdentity(info);
    hash.update(`\0path\0${entryRel}`);
    hash.update(`\0mode:${Number(info.mode & 0o777n).toString(8)}`);
    if (info.isDirectory() && !info.isSymbolicLink()) {
      hash.update('\0directory');
      scanDir(real, entryRel, hash, state);
    } else if (info.isSymbolicLink()) {
      let target;
      try { target = readlinkSync(abs); } catch { throw new CaptureError('capture_failed'); }
      const tb = Buffer.from(target, 'utf-8');
      state.hashedBytes += tb.length;
      if (state.hashedBytes > MAX_HASHED_BYTES) throw new CaptureError('capture_limit_exceeded');
      hash.update('\0symlink\0');
      hash.update(tb);
      state.list.push(`${entryRel}\tsymlink\t${before}`);
    } else if (info.isFile()) {
      if (state.hashedBytes + Number(info.size) > MAX_HASHED_BYTES) throw new CaptureError('capture_limit_exceeded');
      const fileHash = createHash('sha256');
      const fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let readBytes = 0;
      try {
        const opened = fstatSync(fd, { bigint: true });
        if (opened.dev !== info.dev || entryIdentity(opened) !== before)
          throw new CaptureError('workspace_changed_during_capture');
        let remaining = Number(info.size);
        const { buffer } = state;
        while (remaining > 0) {
          const n = readSync(fd, buffer, 0, Math.min(buffer.length, remaining), null);
          if (n === 0) break; // short read: file shrank under us
          readBytes += n;
          state.hashedBytes += n;
          if (state.hashedBytes > MAX_HASHED_BYTES) throw new CaptureError('capture_limit_exceeded');
          fileHash.update(buffer.subarray(0, n));
          remaining -= n;
        }
      } finally { closeSync(fd); }
      // A short read (fewer bytes than lstat reported) means the file changed
      // during the read; treat the capture as changing rather than locking
      // in a truncated digest as if it were the whole file.
      if (readBytes !== Number(info.size)) throw new CaptureError('workspace_changed_during_capture');
      // Compute the file digest once; Hash.digest() finalizes the hash and a
      // second call throws "Digest already called".
      const fileDigest = fileHash.digest();
      hash.update('\0file\0');
      hash.update(fileDigest);
      state.list.push(`${entryRel}\tfile\t${before}\t${fileDigest.toString('hex')}`);
    } else {
      throw new CaptureError('unsupported_workspace_entry');
    }
    // Verify the entry's identity is unchanged since the start of this entry;
    // a rename/replace/truncate that landed during the read is a change.
    let after;
    try { after = entryIdentity(lstatSync(abs, { bigint: true })); } catch { throw new CaptureError('capture_failed'); }
    if (after !== before) throw new CaptureError('workspace_changed_during_capture');
    state.byPath[entryRel] = info.isDirectory() ? `directory:${before}` : state.list.at(-1);
    if (state.hashedBytes > MAX_HASHED_BYTES) throw new CaptureError('capture_limit_exceeded');
  }
}

/** Stable identity tuple for an entry: mode, size, mtimeNs, ctimeNs, ino. */
function entryIdentity(info) {
  return `${info.mode}|${info.size}|${info.mtimeNs}|${info.ctimeNs}|${info.ino}`;
}
