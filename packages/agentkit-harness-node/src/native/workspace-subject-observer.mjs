import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonical, validateWorkspaceObservationSubject } from '@kingsoftcloud/agentkit-harness-core';

const inside = (root, path) => { const tail = relative(root, path); return !tail || !isAbsolute(tail) && tail !== '..' && !tail.startsWith('..' + sep); };
const identity = info => `${info.dev}:${info.ino}:${info.mode}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
const fail = code => { throw Object.assign(new Error(code), { code }); };

/** Observation only: no execution or verifier authority. Every selected file
 * is hashed twice under one shared byte/entry budget; unrelated trees are never
 * traversed. Like the legacy observer, this is not an atomic filesystem snapshot. */
export async function captureWorkspaceSubject({ root, subject: input, signal, maxEntries = 2048, maxBytes = 64 * 1024 * 1024 }) {
  const subject = validateWorkspaceObservationSubject(input);
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1)
    fail('invalid_workspace_capture_limits');
  const pinned = await realpath(root);
  if (pinned !== root) fail('workspace_root_changed');
  const check = async path => {
    signal?.throwIfAborted();
    if (!inside(root, path) || !inside(root, await realpath(path))) fail('workspace_path_outside_scope');
  };
  const capture = async () => {
    const hash = createHash('sha256').update('agentkit.workspace-subject-revision/v1\0').update(canonical(subject));
    const entries = [], seen = new Set(); let bytes = 0;
    const visit = async (path, tree) => {
      signal?.throwIfAborted();
      if (seen.has(path)) return;
      seen.add(path);
      if (seen.size > maxEntries) fail('capture_limit_exceeded');
      await check(path);
      const before = await lstat(path, { bigint: true }), stamp = identity(before);
      // Following a link would add undeclared dependencies. Refuse to claim a
      // complete observation; no outside file is opened or silently omitted.
      if (before.isSymbolicLink()) fail('unsupported_workspace_entry');
      const rel = relative(root, path).split(sep).join('/') || '.';
      hash.update(`\0path:${rel}\0mode:${before.mode & 0o777n}`);
      if (before.isDirectory()) {
        if (!tree) fail('workspace_subject_file_required');
        hash.update('\0directory');
        for (const name of (await readdir(path)).sort()) {
          // Repository metadata is not a delivered dependency. Dependencies
          // such as node_modules are otherwise included when inside a tree.
          if (name === '.git') continue;
          await visit(join(path, name), true);
        }
      } else if (before.isFile()) {
        if (before.size > BigInt(maxBytes - bytes)) fail('capture_limit_exceeded');
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          if (identity(await handle.stat({ bigint: true })) !== stamp) fail('workspace_changed_during_capture');
          const fileHash = createHash('sha256'), buffer = Buffer.allocUnsafe(65536); let count = 0;
          while (count < Number(before.size)) {
            signal?.throwIfAborted();
            const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, Number(before.size) - count), null);
            if (!bytesRead) fail('workspace_changed_during_capture');
            count += bytesRead; bytes += bytesRead;
            if (bytes > maxBytes) fail('capture_limit_exceeded');
            fileHash.update(buffer.subarray(0, bytesRead));
          }
          if (identity(await handle.stat({ bigint: true })) !== stamp) fail('workspace_changed_during_capture');
          hash.update('\0file\0').update(fileHash.digest());
        } finally { await handle.close(); }
      } else fail('unsupported_workspace_entry');
      await check(path);
      if (identity(await lstat(path, { bigint: true })) !== stamp) fail('workspace_changed_during_capture');
      entries.push(`${rel}\0${stamp}`);
    };
    // Trees before files make overlapping declarations deterministic and avoid
    // accidentally replacing a tree selection with a prior single-file visit.
    const trees = [...new Set(subject.artifacts.filter(item => item.kind === 'web').map(item => item.root))].sort();
    for (const path of trees) await visit(resolve(root, path), true);
    for (const item of [...subject.artifacts].sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      await visit(resolve(root, item.path), false);
    if (await realpath(root) !== pinned) fail('workspace_root_changed');
    entries.sort();
    return { digest: hash.digest('hex'), entries };
  };
  const first = await capture(), second = await capture();
  signal?.throwIfAborted();
  if (first.digest !== second.digest || canonical(first.entries) !== canonical(second.entries)) fail('workspace_changed_during_capture');
  return { revision: 'sha256:' + second.digest, changedPaths: [], status: 'ok', reason: null, subject };
}
