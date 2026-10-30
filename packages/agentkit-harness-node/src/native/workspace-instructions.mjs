import { constants, realpathSync } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { canonical, invariant, INSTRUCTION_SCOPES, validateInstructionScopes } from '@kingsoftcloud/agentkit-harness-core';
import { validateNativeWorkspaceContext } from './workspace-context.mjs';
import { isInside, realpathExisting } from './workspace-paths.mjs';

const CONTRACT = 'agentkit.native-instruction-files/v1';
const CANDIDATES = ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md'];
const MAX_FILE_BYTES = 65536, MAX_TOTAL_BYTES = 98304;
const hash = value => createHash('sha256').update(value).digest('hex');
const missing = error => ['ENOENT', 'ENOTDIR'].includes(error.code);
const sameFile = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);

/** Stable bounded reads, using the physical file identity both before and after
 * open. A concurrent replacement causes a retryable source failure, not stale
 * guidance or a partially read instruction file. */
async function readFile(root, path, signal) {
  signal.throwIfAborted();
  let physical, before, handle;
  try {
    physical = await realpath(path);
    invariant(isInside(physical, root), 'workspace_instruction_path_escape');
    before = await stat(physical, { bigint: true });
    if (!before.isFile()) return null;
    invariant(before.size <= BigInt(MAX_FILE_BYTES), 'workspace_instruction_file_too_large');
    handle = await open(physical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    invariant(sameFile(before, await handle.stat({ bigint: true })) && await realpath(path) === physical,
      'workspace_instruction_file_changed');
    const parts = []; let bytes = 0;
    for await (const part of handle.createReadStream({ autoClose: false, signal, end: MAX_FILE_BYTES })) {
      bytes += part.length; invariant(bytes <= MAX_FILE_BYTES, 'workspace_instruction_file_too_large'); parts.push(part);
    }
    signal.throwIfAborted();
    invariant(sameFile(before, await handle.stat({ bigint: true })) && await realpath(path) === physical,
      'workspace_instruction_file_changed');
    return Buffer.concat(parts).toString('utf8');
  } catch (error) {
    // Absence is current state. Once opened, disappearance is a changed read.
    if (!handle && missing(error)) return null;
    throw error;
  } finally { await handle?.close(); }
}

/** Node-owned live source. Only discovery directories are durable; file bodies
 * and deletion state never depend on a summary or a process-local cache. */
export function createNativeWorkspaceInstructions(binding) {
  validateNativeWorkspaceContext(binding);
  invariant(binding.instructionSource?.contract === CONTRACT, 'workspace_instruction_source_unbound');
  const root = binding.workspaceRoot, roots = structuredClone(binding.instructionSource.globalRoots);
  const source = Object.freeze({ contract: 'agentkit.native-context-source/v1', sourceId: 'native.workspace-instructions',
    bindingDigest: hash(canonical({ contract: CONTRACT, root, roots, candidates: CANDIDATES, MAX_FILE_BYTES, MAX_TOTAL_BYTES })),
    instructionPolicy: 'current-files/v1', priority: 1000, required: true, timeoutMs: 5000, maxTokens: 32768, maxBytes: 131072 });
  const initialScopes = () => ({ contract: INSTRUCTION_SCOPES, sourceId: source.sourceId,
    bindingDigest: source.bindingDigest, directories: [''] });
  const scopesOf = state => state === undefined ? initialScopes() : validateInstructionScopes(state, { contextSources: [source] });
  return {
    source,
    workspaceRoot: root,
    async scopes(previous, touches, signal) {
      const result = scopesOf(previous), directories = new Set(result.directories);
      directories.add('');
      invariant(realpathSync(root) === root, 'workspace_instruction_root_changed');
      for (const touch of touches) {
        signal.throwIfAborted();
        const target = realpathExisting(resolve(root, touch));
        invariant(isInside(target, root), 'workspace_instruction_path_escape');
        let directory = dirname(target);
        try { if ((await stat(target)).isDirectory()) directory = target; }
        catch (error) { if (!missing(error)) throw error; }
        while (isInside(directory, root)) {
          directories.add(relative(root, directory).split(sep).join('/'));
          if (directory === root) break;
          directory = dirname(directory);
        }
      }
      result.directories = [...directories].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
      return validateInstructionScopes(result, { contextSources: [source] });
    },
    async readSource({ source: requested, snapshot, signal }) {
      invariant(canonical(requested) === canonical(source), 'workspace_instruction_source_changed');
      invariant(await realpath(root) === root, 'workspace_instruction_root_changed');
      const scopes = scopesOf(snapshot.context.instructionScopes), files = [], dedup = new Set(); let bytes = 0;
      async function add(directory, path, display, scope, group) {
        const content = await readFile(directory, path, signal);
        if (content === null || !content.trim()) return;
        const key = group + ':' + hash(content.trim());
        if (dedup.has(key)) return;
        dedup.add(key); bytes += Buffer.byteLength(content);
        invariant(bytes <= MAX_TOTAL_BYTES && files.length < 256, 'workspace_instruction_source_too_large');
        files.push({ path: display, scope, sha256: hash(content), content });
      }
      for (const [index, globalRoot] of roots.entries()) {
        // A newly introduced symlink cannot widen a frozen global root.
        invariant(realpathExisting(globalRoot) === globalRoot, 'workspace_instruction_root_changed');
        await add(globalRoot, join(globalRoot, 'AGENTS.md'), `global:${index}/AGENTS.md`, 'user-global', 'user-global');
      }
      for (const directory of scopes.directories) for (const name of CANDIDATES) {
        const path = directory ? `${directory}/${name}` : name;
        await add(root, join(root, path), path, directory || '.', directory);
      }
      // Empty files is significant: it retires all previously active versions.
      return { items: [{ contract: CONTRACT, workspaceRoot: root, directories: scopes.directories, files }] };
    },
  };
}
