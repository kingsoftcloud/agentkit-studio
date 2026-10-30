import { canonical, copy, invariant, toolInputRejection, matchesToolExecutionContract } from '@kingsoftcloud/agentkit-harness-core';
import { loadSessionChild, accountedChildDelivery } from '@kingsoftcloud/agentkit-harness-node/native/owned-child';
import { createNativeToolAuthority } from './tool-authority.mjs';

export const STUDIO_NATIVE_CHILD_MERGE = 'native.child-file-merge/v2';
export function nativeChildMergeDefinition() {
  return { name: 'native_child_merge',
    description: 'Merge the isolated files of an accounted completed writing child into the parent workspace. Conflicts publish nothing. Inspect partial or unknown publication before continuing. Child findings and merged files do not verify the parent task.',
    parameters: { type: 'object', additionalProperties: false, required: ['child_run_id'],
      properties: { child_run_id: { type: 'string', minLength: 1, maxLength: 256 } } },
    readOnly: false, concurrentSafe: false, permissions: ['workspace:write'], timeoutMs: 120000,
    contextRole: 'none', observationRole: 'none', progressObservation: false, contextRetention: 'normal' };
}

/** Called only inside the admitted Host tool pipeline. The Native ledger is
 * still checked independently, including after the synchronous filesystem lock. */
export function createStudioNativeChildMerge({ scope, sessionId, store, roles, fileWorkspaces,
  previousPublication, authorize, isClosed = () => false }) {
  invariant(fileWorkspaces && typeof previousPublication === 'function' && typeof authorize === 'function',
    'studio_native_child_merge_binding_missing');
  const boundScope = copy(scope), boundRoles = copy(roles);
  const childScopes = boundRoles.map(role => ({ ...boundScope, agentId: `${boundScope.agentId}:child:${role.name}` }));
  const byRole = new Map(boundRoles.map(role => [role.name, role]));
  const definition = nativeChildMergeDefinition();
  const authority = createNativeToolAuthority({ scope: boundScope, sessionId, store, isClosed });
  const error = code => ({ status: 'error', content: { error_code: code, executed: false } });
  return { definition: copy(definition), contract: STUDIO_NATIVE_CHILD_MERGE,
    async execute(request) {
      const signal = request?.signal;
      const body = () => { const value = { ...request }; delete value.signal; return value; };
      let snapshot;
      try { snapshot = canonical(body()); }
      catch { return error('child_merge_identity_invalid'); }
      let childCurrent = () => true;
      const guard = () => {
        try {
          return request.signal === signal && signal instanceof AbortSignal && !signal.aborted
            && canonical(body()) === snapshot
            && matchesToolExecutionContract(request.definition, definition) && authority(request) && childCurrent()
            && (() => {
              const current = store.load(boundScope, request.runId);
              const allowed = (current.snapshot.taskContract ?? current.configuration.contract).allowedToolNames;
              return allowed == null || Array.isArray(allowed) && allowed.includes(definition.name);
            })();
        } catch { return false; }
      };
      if (!guard()) return error('child_merge_authority_lost');
      const rejection = toolInputRejection(definition, request.call);
      if (rejection) return { status: 'error', content: rejection };
      const original = copy({ scope: request.scope, runId: request.runId, sessionId, operationKey: request.operationKey,
        child_run_id: request.call.arguments.child_run_id });
      let publicationStarted = false;
      const uncertain = (code, applied = []) => ({ status: 'uncertain', workspaceChangedPaths: [...applied],
        content: { schema_version: STUDIO_NATIVE_CHILD_MERGE, error_code: code, ...original, applied: [...applied],
          instruction: 'Inspect the original child and parent files and the saved operation before continuing. Do not repeat an unknown publication automatically.' } });
      try {
        const decision = await authorize({ ...copy(body()), signal });
        if (!guard()) return error('child_merge_authority_lost');
        if (decision !== 'allow') return decision?.status === 'approval_required' && typeof decision.interactionId === 'string'
          && decision.interactionId ? decision : error('child_merge_permission_denied');
        const parent = store.load(boundScope, request.runId).snapshot;
        const resolved = loadSessionChild({ store, childScopes, parent, childRunId: original.child_run_id });
        if (!resolved || !accountedChildDelivery(resolved.parent, resolved.child)) return error('child_not_accounted');
        const child = resolved.child, childSnapshot = child.snapshot;
        const role = byRole.get(child.configuration.childOwnerBinding?.role);
        const writing = role?.tools.some(name => ['write_workspace_file', 'write_workspace_files', 'edit_workspace_file',
          'multi_edit_workspace_file', 'delete_workspace_file', 'apply_workspace_patch', 'rewind_workspace_files'].includes(name));
        const head = store.sessionHead(childSnapshot.scope, childSnapshot.sessionId);
        if (!writing || role.concurrentSafe || childSnapshot.phase !== 'completed'
          || ['failed', 'blocked', 'budget_exhausted'].includes(childSnapshot.outcome)
          || head?.runId !== childSnapshot.runId || !childSnapshot.workspaceRevision) return error('child_merge_unavailable');
        const childSeal = canonical(childSnapshot);
        childCurrent = () => store.sessionHead(childSnapshot.scope, childSnapshot.sessionId)?.runId === childSnapshot.runId
          && canonical(store.load(childSnapshot.scope, childSnapshot.runId).snapshot) === childSeal;
        const expectedBinding = child.configuration.hostRecoveryBinding?.childWorkspace;
        if (!expectedBinding) return error('child_workspace_unbound');
        const bound = fileWorkspaces.bind({ scope: childSnapshot.scope, sessionId: childSnapshot.sessionId, role,
          existing: true, expectedBinding });
        const previous = await previousPublication({ store, childScopes, parent, child });
        if (!guard()) return error('child_merge_authority_lost');
        // The directory publisher owns all remaining synchronous work and checks
        // the live intent/fence again after acquiring every shared lock.
        publicationStarted = true;
        const result = fileWorkspaces.files.merge(bound.workspace, {
          expectedRevision: childSnapshot.workspaceRevision, previous, assertCurrent: guard });
        if (!guard()) return uncertain('child_merge_authority_lost', result.applied);
        if (!result.ok && result.error_code === 'child_workspace_publish_failed')
          return uncertain(result.error_code, result.applied);
        return { status: result.ok ? 'ok' : 'error', workspaceChangedPaths: [...result.applied],
          content: { schema_version: STUDIO_NATIVE_CHILD_MERGE, child_run_id: childSnapshot.runId, ...result } };
      } catch (failure) {
        if (failure?.effectStarted || publicationStarted && failure?.code !== 'child_workspace_guard_failed')
          return uncertain(failure?.code || 'child_merge_publication_unknown', failure?.applied);
        return error(failure?.code || 'child_workspace_merge_unavailable');
      }
    },
  };
}
