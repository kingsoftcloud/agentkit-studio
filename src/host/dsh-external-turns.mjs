import { invariant } from '../contracts/native-values.mjs';

export function requireDshIdleTurns(agent) {
  const host = agent?.externalTurns;
  invariant(host?.contract === 'dsh.external-turn-host/v1' && typeof host.claim === 'function'
    && typeof host.pending === 'function' && typeof host.resume === 'function', 'native_dsh_ownership_host_required');
  invariant(host.idleAdmissionContract === 'dsh.external-turn-start/v1' && typeof host.start === 'function',
    'native_dsh_idle_ownership_host_required');
  return host;
}
