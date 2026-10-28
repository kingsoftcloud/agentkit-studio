// Real workspace read/write tools for the Native RPC entry.
//
// Mirrors the confinement in examples/native-standalone/host.mjs: reject paths
// outside the workspace root and all symlink components (including dangling and
// parent-directory aliases), and final opens use O_NOFOLLOW where supported.
// The workspace root and the granted permission set are fixed at startup; the
// RPC protocol cannot change them. This module depends only on node: builtins
// — never on the core package — so it is unit-testable in isolation.
import { constants, lstatSync, realpathSync } from 'node:fs';
import { mkdir, open, appendFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

export const WORKSPACE_TOOL_READ = {
  name: 'read', description: 'Read a file from the workspace.',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  readOnly: true, concurrentSafe: true, permissions: ['workspace:read'], timeoutMs: 5000,
  contextRole: 'none', observationRole: 'none', progressObservation: false, contextRetention: 'normal',
};
export const WORKSPACE_TOOL_WRITE = {
  name: 'write', description: 'Write a file to the workspace.',
  parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  readOnly: false, concurrentSafe: false, permissions: ['workspace:write'], timeoutMs: 5000,
  contextRole: 'none', observationRole: 'none', progressObservation: false, contextRetention: 'normal',
};
export const WORKSPACE_TOOLS = [WORKSPACE_TOOL_READ, WORKSPACE_TOOL_WRITE];

// Reject lexical '..' traversal and any symlink component on the path,
// including dangling links that realpath cannot resolve. Assumes the workspace
// tree is not concurrently replaced by another process.
export function confinePath(workspaceDir, workspaceReal, path) {
  if (!path || typeof path !== 'string') return null;
  if (realpathSync(workspaceDir) !== workspaceReal) return null;
  const target = resolve(workspaceDir, path);
  if (!target.startsWith(workspaceDir + sep)) return null;
  let current = workspaceReal;
  for (const part of relative(workspaceDir, target).split(sep)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) return null;
    } catch (error) {
      if (error.code !== 'ENOENT') return null;
    }
  }
  return current;
}

/**
 * Build the workspace tool executor. The granted set and workspace root are
 * fixed at construction. This local adapter assumes no untrusted process is
 * concurrently replacing the workspace tree; it is not an OS sandbox.
 */
export function createWorkspaceToolExecutor({ workspaceDir, workspaceReal, granted, execLogPath = null }) {
  const maxBytes = 1024 * 1024;
  const log = async (entry) => {
    if (execLogPath) { try { await appendFile(execLogPath, JSON.stringify({ ts: Date.now(), ...entry }) + '\n'); } catch {} }
  };
  return async function executeTool(request) {
    request.signal.throwIfAborted();
    const call = request.call;
    const def = WORKSPACE_TOOLS.find(tool => tool.name === call.name);
    const entry = { callId: call.callId, name: call.name, status: 'error' };
    if (!def) return { status: 'error', content: { code: 'unknown_tool' } };
    for (const perm of def.permissions) {
      if (!granted.has(perm)) {
        entry.code = 'permission_denied'; entry.required = perm;
        await log(entry);
        return { status: 'error', content: { code: 'permission_denied', required: perm } };
      }
    }
    const argPath = call.arguments?.path;
    if (typeof argPath !== 'string' || argPath.length > 4096)
      return { status: 'error', content: { code: 'invalid_path' } };
    const resolved = confinePath(workspaceDir, workspaceReal, argPath);
    if (!resolved) {
      entry.code = 'invalid_path'; entry.path = argPath;
      await log(entry);
      return { status: 'error', content: { code: 'invalid_path', path: argPath } };
    }
    if (def.name === 'read') {
      try {
        const file = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        let content;
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.size > maxBytes) return { status: 'error', content: { code: 'file_not_regular_or_too_large' } };
          const bytes = Buffer.alloc(maxBytes + 1);
          const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
          if (bytesRead > maxBytes) return { status: 'error', content: { code: 'file_too_large' } };
          content = bytes.subarray(0, bytesRead).toString('utf8');
        } finally { await file.close(); }
        entry.status = 'ok'; entry.path = argPath; entry.bytes = Buffer.byteLength(content);
        await log(entry);
        return { status: 'ok', content };
      } catch (error) {
        entry.code = 'read_failed'; entry.errorCode = String(error.code);
        await log(entry);
        return { status: 'error', content: { code: 'read_failed', errorCode: String(error.code) } };
      }
    }
    if (def.name === 'write') {
      const content = call.arguments?.content;
      if (typeof content !== 'string' || Buffer.byteLength(content) > maxBytes)
        return { status: 'error', content: { code: 'invalid_or_large_content' } };
      try { if (!lstatSync(resolved).isFile()) return { status: 'error', content: { code: 'not_regular_file' } }; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await mkdir(dirname(resolved), { recursive: true });
      request.signal.throwIfAborted();
      const file = await open(resolved, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(content, 'utf8'); await file.sync(); } finally { await file.close(); }
      entry.status = 'ok'; entry.path = argPath; entry.bytes = Buffer.byteLength(content);
      await log(entry);
      return { status: 'ok', content: { path: argPath, bytes: Buffer.byteLength(content) }, workspaceChangedPaths: [argPath] };
    }
    entry.code = 'unknown_tool'; entry.name = def.name;
    await log(entry);
    return { status: 'error', content: { code: 'unknown_tool', name: def.name } };
  };
}
