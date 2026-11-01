/** Whole-Session lifecycle for a managed Native Run. This owns delivery, not
 * model/tool execution or permission assembly, which remain separate ports. */
import { createHash } from 'node:crypto';
import { canonical, copy, invariant, terminal } from '@kingsoftcloud/agentkit-harness-core';
import { nativeDshIdleOwnershipHost } from '@kingsoftcloud/agentkit-harness-node/native/dsh-background-ownership';
import { NATIVE_DSH_MANAGED_TURN_CONTRACT, readNativeDshManagedOwnership } from '@kingsoftcloud/agentkit-harness-node/native/dsh-managed-ownership';

export const STUDIO_MANAGED_NATIVE_EXECUTION = NATIVE_DSH_MANAGED_TURN_CONTRACT;
export const STUDIO_MANAGED_NATIVE_OWNER_PROJECTION = 'agentkitManagedNativeOwner';
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const admission = readNativeDshManagedOwnership;
export function managedNativeOwnerProjection() {
  return { key: STUDIO_MANAGED_NATIVE_OWNER_PROJECTION, stateVersion: 1,
    init: () => ({ current: null, lastClosed: null }),
    stateSchema: { parse(state) {
      invariant(object(state) && Object.keys(state).sort().join(',') === 'current,lastClosed', 'NATIVE_MANAGED_OWNER_INVALID');
      for (const owner of [state.current, state.lastClosed]) if (owner !== null) admission(owner);
      return state;
    } },
    apply(state, event) {
      if (event.type === 'turn/start') return { ...state, current: null };
      if (event.type === 'turn/owner' && event.data.engine === STUDIO_MANAGED_NATIVE_EXECUTION) {
        admission(event.data); return { ...state, current: copy(event.data) };
      }
      if (event.type === 'turn/end' && state.current?.turn === event.data.turn)
        return { current: null, lastClosed: state.current };
      return state;
    } };
}

export function createStudioManagedNativeExecution({ ctx, flushTimeoutMs = 10000 } = {}) {
  const projections = ctx?.get('sessionProjections'), sessions = ctx?.get('sessions');
  invariant(typeof projections?.register === 'function' && typeof sessions?.flush === 'function'
    && Number.isSafeInteger(flushTimeoutMs) && flushTimeoutMs > 0, 'NATIVE_MANAGED_OWNER_HOST_UNAVAILABLE');
  const unregister = projections.register(managedNativeOwnerProjection());
  const lifetime = new AbortController();
  const guard = signal => { lifetime.signal.throwIfAborted(); signal?.throwIfAborted();
    invariant(ctx.fiber.uid !== null, 'NATIVE_MANAGED_OWNER_RETIRED'); };
  async function owned(operation, signal, timeout) {
    guard(signal);
    const scoped = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : []), ...(timeout ? [AbortSignal.timeout(timeout)] : [])]);
    let listener;
    const stopped = new Promise((_, reject) => { listener = () => reject(scoped.reason); scoped.addEventListener('abort', listener, { once: true }); });
    try { const result = await Promise.race([Promise.resolve().then(() => { guard(scoped); return operation(); }), stopped]); guard(scoped); return result; }
    finally { scoped.removeEventListener('abort', listener); }
  }
  const status = agent => copy(projections.stateOf(agent.session, STUDIO_MANAGED_NATIVE_OWNER_PROJECTION));
  return Object.freeze({ contract: STUDIO_MANAGED_NATIVE_EXECUTION, status,
    async run({ identity, configuration, signal, execute }) {
      guard(signal);
      const expected = canonical({ contract: STUDIO_MANAGED_NATIVE_EXECUTION, identity, configDigest: hash(configuration) });
      const controller = ctx.get('sessionController');
      invariant(typeof controller?.resolveAgent === 'function' && typeof execute === 'function', 'NATIVE_MANAGED_OWNER_HOST_UNAVAILABLE');
      const found = await owned(() => controller.resolveAgent(identity.sessionId), signal);
      if (found.error) throw found.error;
      const agent = found.agent;
      invariant(agent?.session.id === identity.sessionId && typeof agent.whenIdle === 'function', 'NATIVE_MANAGED_OWNER_SESSION_CHANGED');
      // An accepted Server command queues behind an ordinary active Session
      // turn. Waiting grants no permission and performs no Native effects.
      await owned(() => agent.whenIdle(), signal);
      const host = nativeDshIdleOwnershipHost(agent), previous = status(agent).lastClosed;
      if (previous?.binding === expected) {
        // The Session terminal committed but the receiver ACK was lost. Read
        // the same terminal Run; never append a replacement delivery turn.
        return execute({ replayOnly: true });
      }
      const pending = host.pending();
      if (pending) invariant(pending.engine === STUDIO_MANAGED_NATIVE_EXECUTION && pending.binding === expected,
        'NATIVE_MANAGED_OWNER_CONFLICT');
      let result, entered = false;
      const drive = async payload => {
        entered = true;
        guard(signal); admission(payload.ownership);
        invariant(payload.ownership.binding === expected, 'NATIVE_MANAGED_OWNER_CONFLICT');
        invariant(await owned(() => sessions.flush(agent.session), signal, flushTimeoutMs) === true, 'NATIVE_MANAGED_OWNER_NOT_DURABLE');
        result = await execute({ signal: payload.signal, prepareInput: payload.prepareInput,
          ownership: copy(payload.ownership), turn: payload.turn });
        invariant(terminal(result.phase), 'NATIVE_MANAGED_OWNER_NOT_TERMINAL');
        return { reason: result.phase === 'completed' ? { kind: 'completed' }
          : result.phase === 'canceled' ? { kind: 'aborted', reason: { kind: 'user' } }
            : { kind: 'error', error: { code: 'NATIVE_EXECUTION_NOT_COMPLETED', message: 'Native execution did not complete' } } };
      };
      try {
        if (pending) await host.resume(STUDIO_MANAGED_NATIVE_EXECUTION, drive);
        else await host.start(async ({ turn }) => ({ contract: 'dsh.external-turn/v1', turn,
          engine: STUDIO_MANAGED_NATIVE_EXECUTION, binding: expected }), drive);
      } catch (error) {
        // A user may cancel before the SDK can claim its turn. Recording only
        // Native's cancellation cannot dispatch a model or tool.
        if (!entered && ['user', 'parent', 'hook'].includes(error?.kind) && !signal?.aborted && !lifetime.signal.aborted)
          result = await execute({ signal: AbortSignal.abort(error), cancelOnly: true });
        else throw error;
      }
      guard(signal);
      invariant(result && await owned(() => sessions.flush(agent.session), signal, flushTimeoutMs) === true,
        'NATIVE_MANAGED_OWNER_NOT_DURABLE');
      return result;
    },
    close() { if (!lifetime.signal.aborted) { lifetime.abort(new Error('Managed Session owner retired')); unregister(); } },
  });
}
