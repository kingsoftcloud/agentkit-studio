import { createHash } from 'node:crypto';
import { canonical, configure, invariant, NATIVE_JSON_CODEC, parseNativeJson, scopeKey } from '@kingsoftcloud/agentkit-harness-core';
import { NATIVE_DSH_TURN_CONTRACT } from './dsh-turn-contract.mjs';

export const NATIVE_DSH_ADMISSION_CONTRACT = 'agentkit.native-dsh-admission/v1';
export const NATIVE_DSH_OWNERSHIP_HOST = 'dsh.external-turn-host/v1';
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const text = value => typeof value === 'string' && value.trim().length > 0;
const fields = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === names;

/** Complete admission data, never live ports, credentials or execution authority. */
export function nativeDshOwnership({ identity, configuration, input, source }) {
  const admission = { contract: NATIVE_DSH_ADMISSION_CONTRACT, jsonCodec: NATIVE_JSON_CODEC,
    identity, configuration, configDigest: hash(configuration), messages: input.messages, source };
  const ownership = { contract: 'dsh.external-turn/v1', engine: NATIVE_DSH_TURN_CONTRACT,
    turn: Number(identity.turnId), binding: canonical(admission) };
  readNativeDshOwnership(ownership, { sessionId: identity.sessionId, turn: ownership.turn });
  return ownership;
}

/** Validate persisted facts before a trusted Host resolves the original preset. */
export function readNativeDshOwnership(ownership, { sessionId, turn }) {
  invariant(fields(ownership, 'binding,contract,engine,turn') && ownership.contract === 'dsh.external-turn/v1'
    && ownership.engine === NATIVE_DSH_TURN_CONTRACT && ownership.turn === turn
    && Number.isSafeInteger(turn) && turn > 0 && text(ownership.binding), 'native_dsh_ownership_invalid');
  const admission = parseNativeJson(ownership.binding);
  invariant(fields(admission, 'configDigest,configuration,contract,identity,jsonCodec,messages,source')
    && admission.contract === NATIVE_DSH_ADMISSION_CONTRACT && admission.jsonCodec === NATIVE_JSON_CODEC
    && canonical(admission) === ownership.binding, 'native_dsh_admission_invalid');
  const { identity, configuration, source, messages } = admission;
  invariant(fields(identity, 'buildId,parentRunId,runId,scope,sessionId,taskChainId,turnId')
    && text(identity.sessionId) && identity.sessionId === sessionId && identity.turnId === String(turn)
    && text(identity.buildId) && text(identity.taskChainId)
    && (identity.parentRunId === null || text(identity.parentRunId)), 'native_dsh_admission_identity_invalid');
  scopeKey(identity.scope);
  invariant(identity.runId === `native-dsh-${hash({ contract: NATIVE_DSH_TURN_CONTRACT,
    scope: identity.scope, sessionId, turn })}`, 'native_dsh_admission_identity_invalid');
  invariant(fields(source, 'model,provider') && text(source.model) && text(source.provider)
    && Array.isArray(messages) && messages.length > 0
    && messages.every(message => message?.role === 'user' && text(message.id) && Array.isArray(message.content)),
  'native_dsh_admission_input_invalid');
  invariant(hash(configuration) === admission.configDigest
    && canonical(configure(configuration)) === canonical(configuration), 'native_dsh_admission_configuration_invalid');
  return admission;
}

/** The Host must provide the maintained lifecycle capability before any dispatch. */
export function nativeDshOwnershipHost(agent) {
  const host = agent?.externalTurns;
  invariant(host?.contract === NATIVE_DSH_OWNERSHIP_HOST && typeof host.claim === 'function'
    && typeof host.pending === 'function' && typeof host.resume === 'function', 'native_dsh_ownership_host_required');
  return host;
}
