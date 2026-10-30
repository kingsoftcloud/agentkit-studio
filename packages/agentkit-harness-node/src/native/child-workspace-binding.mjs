import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { canonical, invariant, scopeKey } from '@kingsoftcloud/agentkit-harness-core';
import { DirectoryChildWorkspaces } from '@kingsoftcloud/agentkit-harness-node/native/child-workspaces';

export const STUDIO_NATIVE_CHILD_WORKSPACE_BINDING = 'agentkit.native-child-workspace-binding/v1';
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');

/** Trusted Host inputs only. No model path or model-provided isolation id. */
export function createStudioNativeChildWorkspaces({ workspaceRoot, stateDir }) {
  const files = new DirectoryChildWorkspaces({ source: workspaceRoot, storage: join(stateDir, 'child-workspaces') });
  const sourceRootDigest = hash(files.source), storageRootDigest = hash(files.storage);
  return {
    contract: STUDIO_NATIVE_CHILD_WORKSPACE_BINDING,
    bindingDigest: hash({ contract: STUDIO_NATIVE_CHILD_WORKSPACE_BINDING, sourceRootDigest, storageRootDigest }),
    files,
    bind({ scope, sessionId, role, existing = false, expectedBinding }) {
      scopeKey(scope);
      invariant(typeof sessionId === 'string' && sessionId.trim(), 'studio_native_child_workspace_session_missing');
      const isolationId = hash({ contract: STUDIO_NATIVE_CHILD_WORKSPACE_BINDING, scope, sessionId, role, source: files.source });
      const workspace = existing ? files.load(isolationId) : files.prepare(isolationId);
      const binding = { contract: STUDIO_NATIVE_CHILD_WORKSPACE_BINDING, isolationId, baseRevision: workspace.baseRevision,
        sourceRootDigest, storageRootDigest, roleDigest: hash(role) };
      invariant(expectedBinding === undefined || canonical(expectedBinding) === canonical(binding),
        'studio_native_child_workspace_binding_changed');
      return { workspace, root: workspace.root, binding, observer: files.observer(workspace) };
    },
  };
}
