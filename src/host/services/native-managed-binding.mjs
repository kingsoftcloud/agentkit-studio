import { canonical, copy, invariant } from '@kingsoftcloud/agentkit-harness-core';
import { setTimeout as delay } from 'node:timers/promises';
import { consumeNativeCompletedTurn } from '@kingsoftcloud/agentkit-harness-node/native/dsh-turn-runtime';
import { createNativeSessionDelivery } from '@kingsoftcloud/agentkit-harness-node/native/session-delivery';
import { managedNativeInputParts, admitManagedNativeInput, STUDIO_MANAGED_NATIVE_INPUT } from './native-managed-input.mjs';

/** Trusted product composition. Server permits select a Session; its live
 * preset supplies resources. Neither persisted facts nor command payloads
 * may manufacture a principal, select a different Agent or replace a Build. */
export function createStudioManagedNativeBinding({ ctx, target, principal, resolveHost, execution } = {}) {
  const boundTarget = copy(target ?? null), boundPrincipal = copy(principal ?? null);
  invariant(typeof boundTarget?.tenantId === 'string' && boundTarget.tenantId.trim()
    && typeof boundTarget.agentInstanceId === 'string' && boundTarget.agentInstanceId.trim()
    && typeof boundPrincipal?.userId === 'string' && boundPrincipal.userId.trim()
    && typeof resolveHost === 'function' && typeof execution?.run === 'function', 'NATIVE_MANAGED_STUDIO_BINDING_INVALID');
  const resolveBinding = async request => {
    const { command, signal, store, admission, runId } = request;
    signal.throwIfAborted();
    invariant(command.tenant_id === boundTarget.tenantId && command.agent_instance_id === boundTarget.agentInstanceId
      && command.command_type === 'enqueue' && ['admit', 'execute'].includes(request.stage)
      && typeof store?.load === 'function', 'NATIVE_MANAGED_STUDIO_TARGET_CHANGED');
    const controller = ctx.get('sessionController');
    invariant(typeof controller?.resolveAgent === 'function', 'NATIVE_MANAGED_OWNER_HOST_UNAVAILABLE');
    let found;
    const attachmentDeadline = Date.now() + 10000;
    for (;;) {
      found = await controller.resolveAgent(command.session_id); signal.throwIfAborted();
      // SDK restoration can hold its Session writer before publishing the
      // live Agent. Only an already-admitted command may wait for that narrow
      // race; every retry still goes through the original ownership API.
      if (found.error?.code !== 'session/writer-held' || request.stage !== 'execute'
        || !admission || Date.now() >= attachmentDeadline) break;
      await delay(50, undefined, { signal });
    }
    if (found.error) throw found.error;
    invariant(found.agent?.session.id === command.session_id && typeof found.agent.whenIdle === 'function', 'NATIVE_MANAGED_OWNER_SESSION_CHANGED');
    await found.agent.whenIdle(); signal.throwIfAborted();
    const parts = managedNativeInputParts(command.payload.content);
    // The shared assembler restores input from the sealed original capsule.
    // Upload receipts may already have expired after admission or a restart.
    const content = admission ? [] : await admitManagedNativeInput({ ctx, agent: found.agent, parts, signal });
    const host = await resolveHost(); signal.throwIfAborted();
    let prepareInput;
    const payload = { agent: found.agent, signal,
      input: { kind: 'enter', messages: [{ id: command.command_id, role: 'user',
        source: { kind: 'user', rpcId: command.command_id }, content }] },
      prepareInput: step => {
        invariant(typeof prepareInput === 'function', 'NATIVE_MANAGED_OWNER_INPUT_UNAVAILABLE');
        return prepareInput(step);
      } };
    const binding = await host.resolveManagedBinding(payload, { store, admission, runId,
      target: boundTarget, principal: boundPrincipal });
    let promptFiles;
    const uploads = ctx.get('fileUploads');
    try {
      signal.throwIfAborted();
      invariant(binding.scope.tenantId === boundTarget.tenantId && binding.scope.agentId === boundTarget.agentInstanceId
        && binding.scope.userId === boundPrincipal.userId, 'NATIVE_MANAGED_STUDIO_TARGET_CHANGED');
      const receiptIds = [...new Set(parts.filter(part => part.type === 'file').map(part => part.receiptId))];
      if (!admission && receiptIds.length) {
        invariant(typeof uploads?.bindPrompt === 'function' && typeof uploads?.retirePrompt === 'function',
          'NATIVE_MANAGED_STUDIO_ATTACHMENT_UNAVAILABLE');
        promptFiles = uploads.bindPrompt(found.agent, receiptIds, command.command_id);
      }
    } catch (error) {
      await binding.releaseResources?.({ scope: binding.scope, sessionId: command.session_id, runId, stage: request.stage, signal });
      throw error;
    }
    let released = false, activeBinding;
    const release = async request => {
      if (released) return;
      released = true;
      try { await binding.releaseResources?.(request); }
      finally {
        // The managed admission now durably owns the file references/bytes.
        // Like a consumed inbox occurrence, it no longer needs staged receipts.
        // Rejected admissions roll back the temporary receipt binding instead.
        try {
          if (promptFiles && request.admitted === true) {
            promptFiles.commit(); uploads.retirePrompt(found.agent, command.command_id);
          }
        } finally { promptFiles?.[Symbol.dispose](); }
      }
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
        let live;
        try {
          activeBinding = await host.resolveManagedBinding({ ...payload, signal: effectSignal }, { store,
            admission: { scope: binding.scope, buildId: binding.buildId, configuration: binding.configuration },
            runId, target: boundTarget, principal: boundPrincipal });
          invariant(canonical(activeBinding.configuration) === canonical(binding.configuration)
            && canonical(activeBinding.scope) === canonical(binding.scope) && activeBinding.buildId === binding.buildId,
          'native_dsh_recovery_configuration_changed');
          let onCheckpoint = options?.onCheckpoint, onStream = options?.onStream;
          if (options?.ownership) {
            const capsule = activeBinding.configuration.hostRecoveryBinding, sessions = ctx.get('sessions');
            const deliver = createNativeSessionDelivery({ store, scope: binding.scope, runId,
              session: found.agent.session, turn: options.turn, managedOwnership: options.ownership,
              projections: ctx.get('sessionProjections'), flush: session => sessions.flush(session),
              inputMessages: capsule.messages, systemText: capsule.systemPrompt, source: capsule.source,
              isStreamPending: key => Boolean(live?.pending(key)), onStreamSettled: (...args) => live?.settled(...args) });
            live = activeBinding.createLiveStream?.({ turn: options.turn, beginStep: deliver.beginStream });
            onStream = (identity, event, record) => {
              if (effectSignal.aborted) return;
              live?.accept(identity, record);
              options.onStream?.(identity, event, record);
            };
            onCheckpoint = async snapshot => { effectSignal.throwIfAborted(); await deliver(snapshot);
              effectSignal.throwIfAborted(); await options.onCheckpoint?.(snapshot); };
          }
          const onActive = activeBinding.bindControls ? control => activeBinding.bindControls({
            ownership: options?.ownership, signal: effectSignal }, control) : undefined;
          const onIdle = activeBinding.onIdle ? (snapshot, { signal: idleSignal, assertCurrent }) => activeBinding.onIdle(snapshot,
            { signal: AbortSignal.any([effectSignal, idleSignal]), assertCurrent }) : undefined;
          const snapshot = await request.execute({ ...options, onCheckpoint, onStream, onActive, onIdle });
          if (activeBinding.consumeCompletedTurn)
            await consumeNativeCompletedTurn(activeBinding, store.load(binding.scope, runId), effectSignal);
          return snapshot;
        } finally {
          live?.abandon();
          try { await activeBinding?.releaseResources?.({ scope: binding.scope, sessionId: command.session_id,
            runId, stage: 'execute', signal: effectSignal }); }
          finally { activeBinding = undefined; prepareInput = undefined; }
        }
      } }),
      release,
    };
  };
  return Object.freeze(Object.assign(resolveBinding, {
    async resolveInjectionScope({ command, signal }) {
      signal.throwIfAborted();
      invariant(command.tenant_id === boundTarget.tenantId && command.agent_instance_id === boundTarget.agentInstanceId,
        'NATIVE_MANAGED_STUDIO_TARGET_CHANGED');
      const host = await resolveHost(); signal.throwIfAborted();
      const scope = await host.resolveInjectionScope({ agentId: boundTarget.agentInstanceId, sessionId: command.session_id }, signal);
      signal.throwIfAborted();
      return { ...scope, tenantId: boundTarget.tenantId, userId: boundPrincipal.userId };
    },
    enqueueContentFormats: Object.freeze(['text/plain', STUDIO_MANAGED_NATIVE_INPUT]),
  }));
}
