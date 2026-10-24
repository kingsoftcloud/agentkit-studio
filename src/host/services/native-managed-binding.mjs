import { canonical, copy, invariant } from '../../../packages/agentkit-harness-core/dist/index.mjs';
import { consumeNativeCompletedTurn } from '../../../packages/agentkit-harness/src/native/dsh-turn-runtime.mjs';

/** Trusted product composition. Server permits select a Session; its live
 * preset supplies resources. Neither persisted facts nor command payloads
 * may manufacture a principal, select a different Agent or replace a Build. */
export function createStudioManagedNativeBinding({ ctx, target, principal, resolveHost, execution } = {}) {
  const boundTarget = copy(target ?? null), boundPrincipal = copy(principal ?? null);
  invariant(typeof boundTarget?.tenantId === 'string' && boundTarget.tenantId.trim()
    && typeof boundTarget.agentInstanceId === 'string' && boundTarget.agentInstanceId.trim()
    && typeof boundPrincipal?.userId === 'string' && boundPrincipal.userId.trim()
    && typeof resolveHost === 'function' && typeof execution?.run === 'function', 'NATIVE_MANAGED_STUDIO_BINDING_INVALID');
  return async request => {
    const { command, signal, store, admission, runId } = request;
    signal.throwIfAborted();
    invariant(command.tenant_id === boundTarget.tenantId && command.agent_instance_id === boundTarget.agentInstanceId
      && command.command_type === 'enqueue' && ['admit', 'execute'].includes(request.stage)
      && typeof store?.load === 'function', 'NATIVE_MANAGED_STUDIO_TARGET_CHANGED');
    const controller = ctx.get('sessionController');
    invariant(typeof controller?.resolveAgent === 'function', 'NATIVE_MANAGED_OWNER_HOST_UNAVAILABLE');
    const found = await controller.resolveAgent(command.session_id); signal.throwIfAborted();
    if (found.error) throw found.error;
    invariant(found.agent?.session.id === command.session_id && typeof found.agent.whenIdle === 'function', 'NATIVE_MANAGED_OWNER_SESSION_CHANGED');
    await found.agent.whenIdle(); signal.throwIfAborted();
    // Structured content needs its explicit Host codec. Refuse unsupported
    // shapes rather than stringify them and silently lose attachment semantics.
    invariant(typeof command.payload.content === 'string', 'NATIVE_MANAGED_STUDIO_INPUT_UNSUPPORTED');
    const host = await resolveHost(); signal.throwIfAborted();
    let prepareInput;
    const payload = { agent: found.agent, signal,
      input: { kind: 'enter', messages: [{ id: command.command_id, role: 'user',
        source: { kind: 'user' }, content: [{ type: 'text', text: command.payload.content }] }] },
      prepareInput: step => {
        invariant(typeof prepareInput === 'function', 'NATIVE_MANAGED_OWNER_INPUT_UNAVAILABLE');
        return prepareInput(step);
      } };
    const binding = await host.resolveManagedBinding(payload, { store, admission, runId,
      target: boundTarget, principal: boundPrincipal });
    try {
      signal.throwIfAborted();
      invariant(binding.scope.tenantId === boundTarget.tenantId && binding.scope.agentId === boundTarget.agentInstanceId
        && binding.scope.userId === boundPrincipal.userId, 'NATIVE_MANAGED_STUDIO_TARGET_CHANGED');
    } catch (error) {
      await binding.releaseResources?.({ scope: binding.scope, sessionId: command.session_id, runId, stage: request.stage, signal });
      throw error;
    }
    let released = false, activeBinding;
    const release = async request => {
      if (released) return;
      released = true; await binding.releaseResources?.(request);
    };
    // Resource discovery cannot retain a Session-scoped Memory/vision owner
    // while waiting for SDK ownership. Release the preview, then reconstruct
    // and compare the same complete binding inside the exclusive SDK turn.
    if (request.stage === 'execute') await release({ scope: binding.scope, sessionId: command.session_id,
      runId, stage: request.stage, signal });
    const deferredPort = (preview, select) => {
      if (!preview) return preview;
      const tokens = preview.tokens ? deferredPort(preview.tokens, () => select()?.tokens) : undefined;
      return new Proxy({ ...preview }, { get(_target, key) {
        if (key === 'tokens' && tokens) return tokens;
        const value = Reflect.get(preview, key, preview);
        if (typeof value !== 'function') return value;
        return (...args) => {
          const current = select();
          invariant(current && typeof current[key] === 'function', 'NATIVE_MANAGED_OWNER_PORT_UNAVAILABLE');
          return current[key](...args);
        };
      } });
    };
    const ports = Object.fromEntries(Object.entries(binding.ports)
      .map(([name, port]) => [name, deferredPort(port, () => activeBinding?.ports[name])]));
    return { scope: copy(binding.scope), buildId: binding.buildId, configuration: binding.configuration, ports,
      withExecution: request => execution.run({ ...request, execute: async options => {
        invariant(canonical(request.identity.scope) === canonical(binding.scope), 'NATIVE_MANAGED_STUDIO_TARGET_CHANGED');
        if (options?.replayOnly || options?.cancelOnly) return request.execute(options);
        prepareInput = options?.prepareInput;
        const effectSignal = AbortSignal.any([signal, ...(options?.signal ? [options.signal] : [])]);
        try {
          activeBinding = await host.resolveManagedBinding({ ...payload, signal: effectSignal }, { store,
            admission: { scope: binding.scope, buildId: binding.buildId, configuration: binding.configuration },
            runId, target: boundTarget, principal: boundPrincipal });
          invariant(canonical(activeBinding.configuration) === canonical(binding.configuration)
            && canonical(activeBinding.scope) === canonical(binding.scope) && activeBinding.buildId === binding.buildId,
          'native_dsh_recovery_configuration_changed');
          const snapshot = await request.execute(options);
          if (activeBinding.consumeCompletedTurn)
            await consumeNativeCompletedTurn(activeBinding, store.load(binding.scope, runId), effectSignal);
          return snapshot;
        } finally {
          try { await activeBinding?.releaseResources?.({ scope: binding.scope, sessionId: command.session_id,
            runId, stage: 'execute', signal: effectSignal }); }
          finally { activeBinding = undefined; prepareInput = undefined; }
        }
      } }),
      release,
    };
  };
}
