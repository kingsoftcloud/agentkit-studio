import { canonical, invariant, parseNativeJson, scopeKey } from '@kingsoftcloud/agentkit-harness-core';

export const NATIVE_DSH_MANAGED_TURN_CONTRACT = 'agentkit.native-managed-dsh-turn/v1';
const text = value => typeof value === 'string' && value.trim().length > 0;
const fields = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === keys;

/** Persisted delivery identity, never an execution grant. The trusted Host must
 * separately own the SDK turn and rebind the original Native configuration. */
export function readNativeDshManagedOwnership(owner, { sessionId, turn } = {}) {
  invariant(fields(owner, 'binding,contract,engine,turn') && owner.contract === 'dsh.external-turn/v1'
    && owner.engine === NATIVE_DSH_MANAGED_TURN_CONTRACT && Number.isSafeInteger(owner.turn) && owner.turn > 0
    && (turn === undefined || turn === owner.turn) && text(owner.binding), 'NATIVE_MANAGED_OWNER_INVALID');
  const value = parseNativeJson(owner.binding), identity = value.identity;
  invariant(fields(value, 'configDigest,contract,identity') && value.contract === NATIVE_DSH_MANAGED_TURN_CONTRACT
    && canonical(value) === owner.binding && /^[a-f0-9]{64}$/u.test(value.configDigest)
    && fields(identity, 'buildId,parentRunId,runId,scope,sessionId,taskChainId,turnId')
    && ['runId', 'sessionId', 'turnId', 'buildId', 'taskChainId'].every(key => text(identity[key]))
    && (identity.parentRunId === null || text(identity.parentRunId))
    && (sessionId === undefined || identity.sessionId === sessionId), 'NATIVE_MANAGED_OWNER_INVALID');
  scopeKey(identity.scope);
  return value;
}
