import { createHash } from 'node:crypto';
import { BACKGROUND_NOTIFICATION_ADMISSION, NATIVE_JSON_CODEC, NativeError, admitBackgroundNotification,
  canonical, configure, invariant, parseNativeJson, scopeKey } from '@kingsoftcloud/agentkit-harness-core';
import { nativeDshOwnershipHost } from './dsh-turn-ownership.mjs';

export const NATIVE_DSH_BACKGROUND_TURN_CONTRACT = 'agentkit.native-dsh-background-turn/v1';
export const NATIVE_DSH_BACKGROUND_ADMISSION = 'agentkit.native-dsh-background-admission/v1';
export const NATIVE_DSH_IDLE_ADMISSION = 'dsh.external-turn-start/v1';
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const text = value => typeof value === 'string' && value.trim().length > 0;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fields = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === names;
const identityOf = snapshot => Object.fromEntries(['scope', 'runId', 'sessionId', 'turnId', 'buildId', 'parentRunId', 'taskChainId']
  .map(key => [key, snapshot[key]]));

/** Serialize facts about an already admitted notice; no ports or new user input.
 * Native notice IDs remain stable across crashes before DSH ownership is flushed.
 * The numeric DSH turn is a separate delivery position, never a replacement ID.
 */
export function nativeDshBackgroundOwnership({ record, turn }) {
  const admission = { contract: NATIVE_DSH_BACKGROUND_ADMISSION, jsonCodec: NATIVE_JSON_CODEC,
    identity: identityOf(record.snapshot), configuration: record.configuration,
    configDigest: record.snapshot.configDigest, notification: record.snapshot.backgroundNotification };
  const ownership = { contract: 'dsh.external-turn/v1', engine: NATIVE_DSH_BACKGROUND_TURN_CONTRACT,
    turn, binding: canonical(admission) };
  readNativeDshBackgroundOwnership(ownership, { sessionId: record.snapshot.sessionId, turn });
  return ownership;
}

/** Parse detached recovery facts. Matching these facts never grants execution authority. */
export function readNativeDshBackgroundOwnership(ownership, { sessionId, turn }) {
  invariant(fields(ownership, 'binding,contract,engine,turn') && ownership.contract === 'dsh.external-turn/v1'
    && ownership.engine === NATIVE_DSH_BACKGROUND_TURN_CONTRACT && ownership.turn === turn
    && Number.isSafeInteger(turn) && turn > 0 && text(ownership.binding), 'native_dsh_background_ownership_invalid');
  const admission = parseNativeJson(ownership.binding);
  invariant(fields(admission, 'configDigest,configuration,contract,identity,jsonCodec,notification')
    && admission.contract === NATIVE_DSH_BACKGROUND_ADMISSION && admission.jsonCodec === NATIVE_JSON_CODEC
    && canonical(admission) === ownership.binding, 'native_dsh_background_admission_invalid');
  const { identity, configuration, notification } = admission;
  invariant(fields(identity, 'buildId,parentRunId,runId,scope,sessionId,taskChainId,turnId')
    && text(identity.sessionId) && identity.sessionId === sessionId && text(identity.buildId)
    && text(identity.taskChainId) && text(identity.parentRunId), 'native_dsh_background_identity_invalid');
  scopeKey(identity.scope);
  invariant(fields(notification, 'admissionElapsedMs,contract,requestDigest,sourceConfigDigest,sourceRunId,taskId')
    && notification.contract === BACKGROUND_NOTIFICATION_ADMISSION && text(notification.sourceRunId)
    && notification.sourceRunId !== identity.runId && digest(notification.taskId) && digest(notification.requestDigest)
    && digest(notification.sourceConfigDigest) && Number.isSafeInteger(notification.admissionElapsedMs)
    && notification.admissionElapsedMs >= 0, 'native_dsh_background_origin_invalid');
  invariant(identity.runId === 'wake_' + hash({ contract: BACKGROUND_NOTIFICATION_ADMISSION, scope: identity.scope,
    sourceRunId: notification.sourceRunId, taskId: notification.taskId }) && identity.turnId === identity.runId,
  'native_dsh_background_identity_invalid');
  invariant(hash(configuration) === admission.configDigest && canonical(configure(configuration)) === canonical(configuration)
    && configuration.backgroundNotificationPolicy === 'completed-before-model/v1' && configuration.inputMessages === null,
  'native_dsh_background_configuration_invalid');
  return admission;
}

function assertStoredAdmission(admission, record) {
  invariant(canonical(identityOf(record.snapshot)) === canonical(admission.identity)
    && record.snapshot.configDigest === admission.configDigest && hash(record.configuration) === admission.configDigest
    && canonical(record.configuration) === canonical(admission.configuration)
    && canonical(record.snapshot.backgroundNotification ?? null) === canonical(admission.notification),
  'native_dsh_background_stored_admission_changed');
}

/** Recheck the real ledger and original launch before trusted Host port rebinding.
 * This only takes the core admission's duplicate path: a missing record cannot
 * poll, recreate a notice, start a model or relaunch a command. A live notice
 * must remain the session head; terminal notices can still be delivered again.
 */
export async function verifyNativeDshBackgroundOwnership(ownership, { store, scope, sessionId, turn, signal }) {
  invariant(signal instanceof AbortSignal, 'native_dsh_background_signal_required');
  signal.throwIfAborted();
  scopeKey(scope);
  const admission = readNativeDshBackgroundOwnership(ownership, { sessionId, turn });
  invariant(canonical(admission.identity.scope) === canonical(scope), 'native_dsh_background_scope_mismatch');
  const { identity, notification } = admission;
  assertStoredAdmission(admission, store.load(scope, identity.runId));
  const duplicate = await admitBackgroundNotification({ store, scope, sourceRunId: notification.sourceRunId,
    taskId: notification.taskId, digest: hash, signal,
    observe: async () => { throw new NativeError('native_dsh_background_admission_missing'); } });
  signal.throwIfAborted();
  invariant(duplicate.created === false && duplicate.snapshot.runId === identity.runId,
    'native_dsh_background_admission_missing');
  const record = store.load(scope, identity.runId);
  assertStoredAdmission(admission, record);
  const source = store.load(scope, notification.sourceRunId);
  invariant(source.snapshot.sessionId === sessionId && source.snapshot.buildId === identity.buildId
    && source.snapshot.taskChainId === identity.taskChainId && canonical(source.snapshot.scope) === canonical(scope),
  'native_dsh_background_source_identity_changed');
  signal.throwIfAborted();
  return { admission, record, source };
}

/** Require both the maintained provider version and its actual idle-start API. */
export function nativeDshIdleOwnershipHost(agent) {
  const host = nativeDshOwnershipHost(agent);
  invariant(host.idleAdmissionContract === NATIVE_DSH_IDLE_ADMISSION && typeof host.start === 'function',
    'native_dsh_idle_ownership_host_required');
  return host;
}
