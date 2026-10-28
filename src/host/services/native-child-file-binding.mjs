import { createHash } from 'node:crypto';
import { canonical, invariant } from '@kingsoftcloud/agentkit-harness-core';
import { createStudioNativeChildWorkspaces, STUDIO_NATIVE_CHILD_WORKSPACE_BINDING } from '../../providers/native-child-workspace-host.mjs';
import { createNativeChildFileReader } from './native-child-file.mjs';

const hash = value => createHash('sha256').update(canonical(value)).digest('hex');

/** The authenticated parent/child lookup remains with the Host. A browser path
 * cannot select an isolation or turn a child file into a parent workspace file.
 */
export function createStudioNativeChildFile({ workspaceRoot, stateDir, resolveOwnedChild, isClosed }) {
  let owner;
  return createNativeChildFileReader({ isClosed, resolveChild: async (request, signal) => {
    const admitted = await resolveOwnedChild(request, signal);
    owner ??= createStudioNativeChildWorkspaces({ workspaceRoot, stateDir });
    const record = admitted.record, binding = record?.configuration.hostRecoveryBinding?.childWorkspace;
    invariant(record?.snapshot.runId === request.childRunId && binding?.contract === STUDIO_NATIVE_CHILD_WORKSPACE_BINDING
      && binding.sourceRootDigest === hash(owner.files.source) && binding.storageRootDigest === hash(owner.files.storage),
    'studio_native_child_file_workspace_unavailable');
    const workspace = owner.files.load(binding.isolationId);
    invariant(workspace.baseRevision === binding.baseRevision, 'studio_native_child_file_workspace_changed');
    const assertCurrent = () => {
      admitted.assertCurrent();
      const current = owner.files.load(binding.isolationId);
      invariant(current.root === workspace.root && current.baseRevision === workspace.baseRevision,
        'studio_native_child_file_workspace_changed');
      return true;
    };
    assertCurrent();
    return { root: workspace.root, assertCurrent };
  } });
}
