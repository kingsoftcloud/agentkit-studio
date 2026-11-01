import { realpathSync } from 'node:fs';
import { invariant } from '@kingsoftcloud/agentkit-harness-core';
import { nativeWorkspaceContextBinding } from '@kingsoftcloud/agentkit-harness-node/native/workspace-context';
import { nativeInstructionTouches } from './native-instruction-context.mjs';

/** Project instruction discovery and execution directory binding share one physical root. */
export function createNativeDshContextBinding({ ctx, workspace, pinnedRoot, instructionRoots, builtinNames, workspaceToolNames, isClosed }) {
  return {
    instructionTouches(agent, record) {
      // The Host filesystem may canonicalize /var to /private/var when the
      // context directory is bound. Scope discovery compares descendant paths;
      // use its address spelling only after proving the same physical root.
      const current = ctx.get?.('workingDirectory')?.get?.(agent.session);
      let instructionRoot = workspace;
      if (typeof current === 'string') {
        try { if (realpathSync(current) === pinnedRoot) instructionRoot = current; }
        catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
      }
      return nativeInstructionTouches(record, { sessionId: agent.session.id, builtinNames, workspaceToolNames, workspace: instructionRoot });
    },
    workspaceContext(agent) {
      const owner = ctx.get?.('workingDirectory');
      if (!owner || !['get', 'set', 'ensure'].every(name => typeof owner[name] === 'function')) return undefined;
      const sessionId = String(agent.session.id);
      const guard = () => invariant(!isClosed() && String(agent.session?.id) === sessionId
        && realpathSync(workspace) === pinnedRoot, 'studio_native_workspace_context_unbound');
      return { binding: nativeWorkspaceContextBinding(workspace, { instructionRoots }), directory: {
        get: () => { guard(); return owner.get(agent.session); },
        set: (root, signal) => { guard(); invariant(root === pinnedRoot, 'studio_native_workspace_context_unbound'); return owner.set(agent, root, signal); },
        ensure: signal => { guard(); return owner.ensure(agent, signal); },
      } };
    },
  };
}
