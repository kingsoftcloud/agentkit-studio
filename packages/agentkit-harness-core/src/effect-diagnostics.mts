import type { EffectKind, ObjectValue } from './contracts.mjs';

const causes = new Set(['effect_timeout', 'wall_time_hard_limit', 'lease_lost', 'effect_aborted',
  'effect_port_error', 'tool_timeout', 'tool_preflight_aborted']);
export const effectFailureCause = (code: string, nativeError: boolean): string =>
  causes.has(code) ? code : nativeError ? 'native_error' : 'effect_port_error';
/** Persist only bounded driver facts. An adapter's error message, name,
 * arbitrary code and stack can contain credentials or tool content.
 * Missing dispatch evidence is never evidence that execution did not occur.
 */
export function observedEffectFailure(input: { operationKey: string; kind: EffectKind; code: string; nativeError: boolean;
  signalAborted: boolean; elapsedMs: number; initialTimeoutMs: number; observedAtMs: number;
  proofs: { dispatched: boolean }[] }): { kind: string; payload: ObjectValue } {
  const count = input.proofs.filter(proof => proof.dispatched).length;
  return { kind: 'effect.failure_observed', payload: { contract: 'agentkit.effect-failure/v1',
    operationKey: input.operationKey, kind: input.kind,
    cause: effectFailureCause(input.code, input.nativeError),
    signalAborted: input.signalAborted, elapsedMs: Math.max(0, Math.floor(input.elapsedMs)),
    initialTimeoutMs: Math.max(0, Math.floor(input.initialTimeoutMs)), observedAtMs: input.observedAtMs,
    dispatchEvidence: !input.proofs.length ? 'unavailable' : count ? 'some_dispatched' : 'none_dispatched',
    observedProofs: input.proofs.length, dispatchedProofs: count } };
}
