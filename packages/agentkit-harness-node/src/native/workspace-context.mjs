import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { realpathExisting } from './workspace-paths.mjs';
import { invariant } from '@kingsoftcloud/agentkit-harness-core';

export const NATIVE_WORKSPACE_CONTEXT = 'agentkit.native-workspace-context/v1';

/** Execution workspace identity, not a filesystem permission or a Session storage address. */
export function nativeWorkspaceContextBinding(workspaceRoot, { instructionRoots } = {}) {
  return validateNativeWorkspaceContext({ contract: NATIVE_WORKSPACE_CONTEXT, workspaceRoot: realpathSync(workspaceRoot),
    ...(instructionRoots === undefined ? {} : { instructionSource: { contract: 'agentkit.native-instruction-files/v1',
      globalRoots: [...new Set(instructionRoots.map(root => realpathExisting(root)))] } }) });
}

export function validateNativeWorkspaceContext(binding) {
  invariant(binding && Object.keys(binding).sort().join(',') === ['contract', 'workspaceRoot',
    ...(binding.sourceRoot === undefined ? [] : ['sourceRoot']),
    ...(binding.instructionSource === undefined ? [] : ['instructionSource'])].sort().join(',')
    && binding.contract === NATIVE_WORKSPACE_CONTEXT && typeof binding.workspaceRoot === 'string'
    && isAbsolute(binding.workspaceRoot) && (binding.sourceRoot === undefined
      || typeof binding.sourceRoot === 'string' && isAbsolute(binding.sourceRoot)), 'native_workspace_context_binding_invalid');
  const source = binding.instructionSource;
  invariant(source === undefined || source && Object.keys(source).sort().join(',') === 'contract,globalRoots'
    && source.contract === 'agentkit.native-instruction-files/v1' && Array.isArray(source.globalRoots) && source.globalRoots.length <= 8
    && new Set(source.globalRoots).size === source.globalRoots.length
    && source.globalRoots.every(root => typeof root === 'string' && isAbsolute(root)), 'native_workspace_instruction_binding_invalid');
  return structuredClone(binding);
}

/** Freeze where the initial Host context came from. Its validity cannot be
 * recomputed from a later directory after the execution owner has aligned it. */
export function admitNativeWorkspaceContext(binding, directory) {
  validateNativeWorkspaceContext(binding);
  const current = directory.get();
  invariant(typeof current === 'string' && isAbsolute(current), 'native_workspace_context_directory_invalid');
  let sourceRoot = current;
  try { sourceRoot = realpathSync(current); }
  catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
  return validateNativeWorkspaceContext({ ...binding, sourceRoot });
}

/** Align the context port inside the durable input effect. The execution owner
 * supplies the root; the Host supplies its supported Session directory APIs.
 * Historical absence stays absent. Input bytes and inbox claims belong to the
 * Kernel's input port; directory alignment never rewrites admitted messages.
 * No command, filesystem mutation tool or permission decision is invoked. */
export async function ensureNativeWorkspaceContext({ binding, directory, signal }) {
  if (binding === undefined) return;
  validateNativeWorkspaceContext(binding);
  invariant(directory && ['get', 'set', 'ensure'].every(name => typeof directory[name] === 'function'), 'native_workspace_context_port_missing');
  signal.throwIfAborted();
  const current = directory.get();
  invariant(typeof current === 'string' && isAbsolute(current), 'native_workspace_context_directory_invalid');
  let same = false;
  try { same = realpathSync(current) === binding.workspaceRoot; }
  catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
  if (same) return;
  await directory.set(binding.workspaceRoot, signal);
  signal.throwIfAborted();
  invariant(realpathSync(await directory.ensure(signal)) === binding.workspaceRoot, 'native_workspace_context_directory_changed');
}
