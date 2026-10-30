import { canonical, terminal } from '@kingsoftcloud/agentkit-harness-core';
import { loadSessionChild, accountedChildDelivery } from './owned-child.mjs';
import { ChildFilePublication } from './child-workspaces.mjs';

export const MERGE_SCHEMA = 'native.child-file-merge/v2';
const bindingContract = 'agentkit.native-child-workspace-binding/v1';
const sha = /^sha256:[0-9a-f]{64}$/;
const same = (left, right) => canonical(left) === canonical(right);
function workspaceBinding(record) {
  const value = record.configuration?.hostRecoveryBinding?.childWorkspace;
  return value?.contract === bindingContract && /^[0-9a-f]{64}$/.test(value.isolationId)
    && sha.test(value.baseRevision) ? value : null;
}

/** Only actual prepared tool effects with canonical committed success grant a
 * publication. A saved inventory, model text and an uncertain receipt do not. */
function confirmedPublication({ store, parent, source }) {
  const visited = new Set();
  for (let cursor = parent; cursor && !visited.has(cursor.runId);) {
    visited.add(cursor.runId);
    const record = store.load(parent.scope, cursor.runId);
    if (!same(record.snapshot.scope, parent.scope) || record.snapshot.sessionId !== parent.sessionId) return null;
    for (const event of [...record.events].reverse()) {
      if (event.kind !== 'effect.prepared' || event.payload.kind !== 'tool') continue;
      const intent = record.intents.find(item => item.operationKey === event.payload.operationKey && item.kind === 'tool');
      const calls = intent?.payload.calls;
      const receipt = record.receipts.find(item => item.operationKey === intent?.operationKey && item.status === 'committed');
      const results = receipt?.result.results;
      if (!Array.isArray(calls) || !Array.isArray(results) || calls.length !== results.length) continue;
      for (let index = calls.length - 1; index >= 0; index--) {
        const call = calls[index], result = results[index];
        if (call?.name !== 'native_child_merge' || !same(call.arguments, { child_run_id: source.runId })
          || result?.status !== 'ok') continue;
        const content = result.content;
        if (content?.schema_version !== MERGE_SCHEMA || content.ok !== true || content.child_run_id !== source.runId
          || content.child_revision !== source.workspaceRevision) continue;
        const grant = content.publication;
        if (!sha.test(source.workspaceRevision) || !grant || grant.revision !== source.workspaceRevision
          || !sha.test(grant.inventory_digest)) throw Error('child_publication_receipt_invalid');
        return new ChildFilePublication(grant.revision, grant.inventory_digest);
      }
    }
    if (!record.snapshot.parentRunId) return null;
    const previous = store.load(parent.scope, record.snapshot.parentRunId).snapshot;
    if (!same(previous.scope, parent.scope) || previous.sessionId !== parent.sessionId || !terminal(previous.phase)) return null;
    cursor = previous;
  }
  return null;
}

/** Resolve only this child's real continuation ancestors, in this parent's
 * Session. Current-child ownership and immutable configuration are re-proved
 * even when a caller supplies a record-shaped object. */
export function previousChildPublication({ store, childScopes, parent, child }) {
  const actual = loadSessionChild({ store, childScopes, parent, childRunId: child.snapshot.runId });
  if (!actual || !same(actual.child.snapshot, child.snapshot) || !same(actual.child.configuration, child.configuration)
    || !accountedChildDelivery(actual.parent, actual.child)) return null;
  const binding = workspaceBinding(child);
  if (!binding) return null;
  const visited = new Set([child.snapshot.runId]);
  let current = child;
  while (current.snapshot.parentRunId) {
    const sourceId = current.snapshot.parentRunId;
    if (visited.has(sourceId) || current.configuration.childOwnerBinding?.continuationOf !== sourceId) return null;
    visited.add(sourceId);
    const resolved = loadSessionChild({ store, childScopes, parent, childRunId: sourceId });
    if (!resolved || !accountedChildDelivery(resolved.parent, resolved.child)) return null;
    const source = resolved.child;
    if (!same(source.snapshot.scope, child.snapshot.scope) || source.snapshot.sessionId !== child.snapshot.sessionId
      || !same(workspaceBinding(source), binding)) return null;
    const publication = confirmedPublication({ store, parent, source: source.snapshot });
    if (publication) return publication;
    current = source;
  }
  return null;
}
