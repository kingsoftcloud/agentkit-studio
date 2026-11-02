import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { invariant } from '@kingsoftcloud/agentkit-harness-core';

/** Bind one preset's tools to its owning Session, after that Session exists.
 * Managed runtimes retain their deployment-owned filesystem boundary. */
export function bindNativeSessionWorkspace({ ctx, agent, fallbackRoot, managed = false }) {
  invariant(agent?.session?.id, 'studio_native_workspace_session_missing');
  const session = agent.session, directory = ctx.get?.('workingDirectory');
  const selected = () => managed ? fallbackRoot : directory?.get?.(session) ?? fallbackRoot;
  const physical = () => {
    const path = selected();
    invariant(typeof path === 'string' && isAbsolute(path), 'studio_native_workspace_path_invalid');
    const root = realpathSync(path);
    invariant(statSync(root).isDirectory(), 'studio_native_workspace_not_directory');
    return root;
  };
  const workspaceRoot = physical();
  return { workspaceRoot, assertWorkspace(current) {
    invariant(current?.session === session && physical() === workspaceRoot,
      'studio_native_session_workspace_changed');
    return true;
  } };
}
