import { createHash } from 'node:crypto';
import { canonical, copy, invariant, scopeKey, sourceReadBudgetForState, activePlanMode,
  projectRunToolAuthority } from '@kingsoftcloud/agentkit-harness-core';
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');

/** A DSH registration/permission decision alone cannot authorize a later
 * publication after waiting for a workspace lock. Re-read the Native ledger. */
export function createNativeToolAuthority({ scope, sessionId, store, isClosed = () => false, expectedHostBindingDigest }) {
  const read = createNativeToolAuthorityReader({ scope, sessionId, store, isClosed, expectedHostBindingDigest });
  return request => read(request) !== null;
}

/** Read one validated current authority view. Callers may inspect its immutable
 * identity; it grants no authority after another wait or generation change. */
export function createNativeToolAuthorityReader({ scope, sessionId, store, isClosed = () => false, expectedHostBindingDigest }) {
  scopeKey(scope);
  invariant(typeof sessionId === 'string' && sessionId.trim() && typeof store?.load === 'function'
    && typeof isClosed === 'function' && (expectedHostBindingDigest === undefined
      || typeof expectedHostBindingDigest === 'string' && expectedHostBindingDigest.trim() && expectedHostBindingDigest.length <= 1024), 'studio_native_tool_authority_binding_invalid');
  const fixedScope = copy(scope);
  return request => {
    try {
      if (isClosed() || !(request.signal instanceof AbortSignal) || request.signal.aborted
        || canonical(request.scope) !== canonical(fixedScope) || request.sessionId !== sessionId) return null;
      let current;
      if (store.toolAuthority) current = store.toolAuthority(fixedScope, request.runId);
      else {
        const record = store.authority?.(fixedScope, request.runId) ?? store.load(fixedScope, request.runId);
        current = projectRunToolAuthority({ ...record, pendingIntent: 'pendingIntent' in record ? record.pendingIntent
          : record.intents.find(item => item.operationKey === record.snapshot.pendingIntent) ?? null });
      }
      const snapshot = current.snapshot;
      if (expectedHostBindingDigest !== undefined && current.configuration.hostBindingDigest !== expectedHostBindingDigest) return null;
      if (request.resultGovernance !== (current.configuration.artifactPolicy === 'runtime-artifacts/v1'
        ? 'runtime-artifacts/v1' : undefined)) return null;
      if (!snapshot || snapshot.phase !== 'executing_tools'
        || !['sessionId', 'runId', 'turnId', 'buildId', 'parentRunId', 'taskChainId'].every(key => request[key] === snapshot[key])
        || !current.lease || current.lease.expiresAt <= Date.now()
        || !Number.isSafeInteger(request.executionFence) || request.executionFence <= 0
        || current.lease.fence !== request.executionFence) return null;
      const intent = current.pendingIntent;
      if (intent?.kind !== 'tool' || intent.status !== 'running' || intent.claimedFence !== request.executionFence
        || !Array.isArray(intent.payload?.calls)) return null;
      const index = intent.payload.calls.findIndex(call => canonical(call) === canonical(request.call));
      if (index < 0 || request.operationKey !== (intent.payload.calls.length === 1
        ? intent.operationKey : `${intent.operationKey}:call:${index + 1}`)) return null;
      if (request.definition.approvalPolicy === 'durable-preflight/v1'
        && canonical(request.interaction ?? null) !== canonical(intent.payload.interaction ?? null)) return null;
      const definition = current.configuration.tools.find(tool => tool.name === request.call.name);
      if (request.planMode !== (activePlanMode(snapshot, current.configuration)
        && definition?.planModeCommandPolicy ? 'session-plan/v1' : undefined)) return null;
      if (canonical(request.sourceReadBudget ?? null) !== canonical(sourceReadBudgetForState(snapshot, current.configuration,
        current.sourceReadMessage, request.call, hash) ?? null)) return null;
      return definition && canonical(definition) === canonical(request.definition) ? current : null;
    } catch { return null; }
  };
}

/** Current read intent authority never grants execution rights to the old tool. */
export function createNativeToolReceiptAuthority(options) {
  return originalEffectAuthority(options, false);
}
/** A new operator write claim; a receipt-read claim is never interchangeable. */
export function createNativeWorkspaceRepairAuthority(options) {
  return originalEffectAuthority(options, true);
}
function originalEffectAuthority({ scope, sessionId, store, isClosed = () => false }, repair) {
  scopeKey(scope); const fixedScope = copy(scope);
  invariant(typeof sessionId === 'string' && sessionId.trim() && typeof store?.load === 'function',
    'studio_native_tool_receipt_binding_invalid');
  return request => {
    try {
      if (isClosed() || !(request.signal instanceof AbortSignal) || request.signal.aborted
        || request.contract !== (repair ? 'agentkit.workspace-compensation/v1' : 'agentkit.tool-receipt-observation/v1')
        || canonical(request.scope) !== canonical(fixedScope) || request.sessionId !== sessionId) return false;
      const record = store.load(fixedScope, request.runId), snapshot = record.snapshot;
      if (snapshot.phase !== 'reconciling_tool' || !record.lease || record.lease.expiresAt <= Date.now()
        || record.lease.fence !== request.executionFence
        || !['sessionId', 'runId', 'turnId', 'buildId', 'parentRunId', 'taskChainId'].every(key => request[key] === snapshot[key])
        || snapshot.toolReconciliation?.operationKey !== request.originalOperationKey
        || snapshot.toolReconciliation?.callId !== request.call?.callId) return false;
      const query = record.intents.find(item => item.operationKey === snapshot.pendingIntent);
      if (query?.kind !== (repair ? 'workspace_repair' : 'tool_receipt') || query.status !== 'running' || query.claimedFence !== request.executionFence
        || query.operationKey !== request.operationKey || query.payload.contract !== request.contract
        || query.payload.originalOperationKey !== request.originalOperationKey
        || query.payload.originalClaimedFence !== request.originalClaimedFence || query.payload.callId !== request.call.callId) return false;
      const original = record.intents.find(item => item.operationKey === request.originalOperationKey);
      const receipt = record.receipts.find(item => item.operationKey === request.originalOperationKey);
      const definition = record.configuration.tools.find(item => item.name === request.call.name);
      return original?.kind === 'tool' && original.status === 'running' && original.claimedFence === request.originalClaimedFence
        && Array.isArray(original.payload.calls) && original.payload.calls.length === 1
        && canonical(original.payload.calls[0]) === canonical(request.call)
        && Boolean(receipt && (receipt.status === 'uncertain' || receipt.result.results?.[0]?.status === 'uncertain'))
        && definition?.recoveryPolicy === 'receipt-observation/v1'
        && (!repair || definition.workspaceRepairPolicy === 'preimage-compensation/v1')
        && canonical(definition) === canonical(request.definition);
    } catch { return false; }
  };
}
