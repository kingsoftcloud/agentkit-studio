import { createHash } from 'node:crypto';
import { canonical, copy, effectiveRunConfiguration, invariant, scopeKey, webDelivery } from '@kingsoftcloud/agentkit-harness-core';
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');

/** A verifier may observe through a granted tool while its own verify intent
 * is claimed. It cannot borrow ordinary tool-dispatch authority or execute an
 * old model call. Every publication after permission waits re-reads this claim. */
export function createNativeVerificationAuthority({ scope, sessionId, store, toolName, isClosed = () => false }) {
  scopeKey(scope); const boundScope = copy(scope);
  invariant(typeof sessionId === 'string' && sessionId && typeof store?.load === 'function'
    && typeof toolName === 'string' && toolName && typeof isClosed === 'function', 'native_verification_authority_binding_invalid');
  return request => {
    try {
      if (isClosed() || !(request.signal instanceof AbortSignal) || request.signal.aborted
        || canonical(request.scope) !== canonical(boundScope) || request.sessionId !== sessionId) return false;
      const current = store.authority?.(boundScope, request.runId) ?? store.load(boundScope, request.runId), snapshot = current.snapshot;
      if (snapshot.phase !== 'verifying' || !current.lease || current.lease.expiresAt <= Date.now()
        || !Number.isSafeInteger(request.executionFence) || request.executionFence <= 0
        || current.lease.fence !== request.executionFence
        || !['sessionId', 'runId', 'turnId', 'buildId', 'parentRunId', 'taskChainId'].every(key => request[key] === snapshot[key])) return false;
      const intent = 'pendingIntent' in current ? current.pendingIntent
        : current.intents.find(item => item.operationKey === snapshot.pendingIntent);
      if (intent?.kind !== 'verify' || intent.status !== 'running' || intent.claimedFence !== request.executionFence
        || intent.operationKey !== request.operationKey || !snapshot.candidate
        || request.candidateId !== snapshot.candidate.candidateId
        || canonical(request.candidate) !== canonical(snapshot.candidate)
        || canonical(intent.payload.candidate) !== canonical(snapshot.candidate)
        || request.snapshot?.revision !== snapshot.revision || request.snapshot?.configDigest !== snapshot.configDigest) return false;
      const config = effectiveRunConfiguration(snapshot, current.configuration, digest);
      if (canonical(request.contract) !== canonical(config.contract)
        || !config.tools.some(tool => tool.name === toolName && tool.observationRole === 'browser')
        || config.contract.allowedToolNames !== null && !config.contract.allowedToolNames.includes(toolName)) return false;
      const entry = webDelivery(snapshot);
      return typeof request.entryPath === 'string' && request.entryPath.length > 0 && (!entry || entry.path === request.entryPath);
    } catch { return false; }
  };
}
