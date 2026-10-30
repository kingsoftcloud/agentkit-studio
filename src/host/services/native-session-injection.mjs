import { canonical, copy, invariant, validateSessionInjection } from '@kingsoftcloud/agentkit-harness-core';
import { NATIVE_DSH_TURN_CONTRACT } from '@kingsoftcloud/agentkit-harness-node/native/dsh-turn-runtime';
import { NATIVE_DSH_MANAGED_TURN_CONTRACT } from '@kingsoftcloud/agentkit-harness-node/native/dsh-managed-ownership';

export function validateNativeInjectionRequest(request) {
  invariant(request && typeof request === 'object' && !Array.isArray(request)
    && Object.keys(request).sort().join(',') === 'agentId,injectionId,sessionId,source,text'
    && ['agentId', 'sessionId'].every(key => typeof request[key] === 'string' && request[key].trim()
      && request[key].length <= 256 && !request[key].includes('\0')), 'STUDIO_NATIVE_INJECTION_INVALID');
  return validateSessionInjection({ injectionId: request.injectionId, text: request.text, source: request.source });
}

/** Resolve ownership without prompt assembly, credentials, model or tool ports. */
export function createStudioNativeSessionInjection({ ctx, store, agents, builds, workspaceId, lifetime, agentEvents }) {
  const wait = async (operation, signal) => {
    signal.throwIfAborted();
    let abort;
    const stopped = new Promise((_, reject) => {
      abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
    });
    try {
      const result = await Promise.race([Promise.resolve().then(operation), stopped]);
      signal.throwIfAborted(); return result;
    } finally { signal.removeEventListener('abort', abort); }
  };
  const resolveOwnedSession = async (raw, callerSignal) => {
    const request = copy(raw);
    const signal = callerSignal ? AbortSignal.any([callerSignal, lifetime.signal]) : lifetime.signal;
    signal.throwIfAborted();
    invariant(typeof agentEvents === 'function', 'STUDIO_NATIVE_INJECTION_UNAVAILABLE');
    const controller = ctx.get('sessionController');
    invariant(typeof controller?.resolveAgent === 'function', 'STUDIO_NATIVE_INJECTION_UNAVAILABLE');
    const found = await wait(() => controller.resolveAgent(request.sessionId), signal);
    if (found.error) throw found.error;
    const agent = found.agent;
    invariant(agent?.session?.id === request.sessionId, 'STUDIO_NATIVE_INJECTION_SESSION_MISMATCH');
    const read = () => agentEvents(ctx, agent).serial('agentkit/native-recovery-binding', {});
    const binding = await wait(read, signal);
    invariant(binding?.agentId === request.agentId && binding.local === true && binding.runtime === 'harness'
      && binding.nativeEngineContract === NATIVE_DSH_TURN_CONTRACT, 'STUDIO_NATIVE_INJECTION_SESSION_MISMATCH');
    const record = await wait(() => binding.buildId ? builds?.resolve(binding.agentId, binding.buildId)
      : agents.getRevision(binding.agentId, binding.agentRevision), signal);
    signal.throwIfAborted();
    invariant(record?.metadata?.id === binding.agentId && record.metadata.local === true
      && record.metadata.revision === binding.agentRevision && record.spec?.runtime?.type === 'harness',
    'STUDIO_NATIVE_INJECTION_BINDING_CHANGED');
    const current = await wait(read, signal);
    const identity = value => ({ agentId: value?.agentId, agentRevision: value?.agentRevision,
      buildId: value?.buildId ?? null, local: value?.local, runtime: value?.runtime, nativeEngineContract: value?.nativeEngineContract });
    invariant(canonical(identity(current)) === canonical(identity(binding)), 'STUDIO_NATIVE_INJECTION_BINDING_CHANGED');
    return { agent, scope: { tenantId: 'local', workspaceId, userId: 'local-user', agentId: request.agentId } };
  };
  return {
    resolveScope: async (request, signal) => (await resolveOwnedSession(request, signal)).scope,
    async inject(raw, signal) {
      const request = copy(raw);
      const input = validateNativeInjectionRequest(request);
      const { agent, scope } = await resolveOwnedSession(request, signal);
      signal?.throwIfAborted(); lifetime.signal.throwIfAborted();
      invariant(agent.externalTurns?.pending()?.engine !== NATIVE_DSH_MANAGED_TURN_CONTRACT,
        'NATIVE_MANAGED_SERVER_CONTROL_REQUIRED');
      invariant(typeof store.inject === 'function', 'STUDIO_NATIVE_INJECTION_UNAVAILABLE');
      return { contract: 'agentkit.session-injection/v1', agentId: request.agentId, sessionId: request.sessionId,
        ...store.inject(scope, request.sessionId, input) };
    },
  };
}
