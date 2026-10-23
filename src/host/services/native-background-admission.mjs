import { createHash } from 'node:crypto';
import { BACKGROUND_COMMAND_CONTRACT, BACKGROUND_NOTIFICATION_ADMISSION, NativeKernel, admitBackgroundNotification, canonical, invariant, terminal } from '../../../packages/agentkit-harness-core/dist/index.mjs';
import { nativeDshOwnershipHost } from '../../../packages/agentkit-harness/src/native/dsh-turn-ownership.mjs';
import { NATIVE_DSH_BACKGROUND_TURN_CONTRACT, nativeDshBackgroundOwnership, nativeDshIdleOwnershipHost,
  readNativeDshBackgroundOwnership, verifyNativeDshBackgroundOwnership } from '../../../packages/agentkit-harness/src/native/dsh-background-ownership.mjs';
import { assertNativeRecoveryPreset, readNativeRecoveryBinding } from '../../providers/native-recovery-binding.mjs';

const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const text = value => typeof value === 'string' && value.trim() && value.length <= 256;
const cause = reason => ['user', 'parent', 'disposed'].includes(reason?.kind) ? { kind: reason.kind }
  : reason?.kind === 'hook' && typeof reason.reason === 'string' ? { kind: 'hook', reason: reason.reason } : { kind: 'disposed' };
async function live(operation, signal) {
  signal.throwIfAborted();
  let abort;
  const stopped = new Promise((_, reject) => {
    abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
  });
  try {
    const value = await Promise.race([Promise.resolve().then(operation), stopped]);
    signal.throwIfAborted(); return value;
  } finally { signal.removeEventListener('abort', abort); }
}

/** Internal Host admission, never an inbox message or an executable command port. */
export function createStudioNativeBackgroundAdmission({ ctx, store, workspaceId, lifetime, active, execute, agentEvents }) {
  const driving = new Set();
  const drive = async ({ agent, agentId, sourceRunId, taskId, signal: callerSignal }) => {
    invariant(text(agentId) && text(sourceRunId) && /^[a-f0-9]{64}$/.test(taskId)
      && text(agent?.session?.id), 'studio_native_background_request_invalid');
    const signal = callerSignal ? AbortSignal.any([callerSignal, lifetime.signal]) : lifetime.signal;
    signal.throwIfAborted();
    const scope = { tenantId: 'local', workspaceId, userId: 'local-user', agentId };
    const key = canonical({ scope, sessionId: agent.session.id });
    invariant(!driving.has(key), 'studio_native_background_already_active');
    driving.add(key);
    let prepared, preparedSignal;
    try {
      const source = store.load(scope, sourceRunId);
      const capsule = readNativeRecoveryBinding(source, { agentId, sessionId: agent.session.id, runId: sourceRunId });
      const runId = 'wake_' + hash({ contract: BACKGROUND_NOTIFICATION_ADMISSION, scope, sourceRunId, taskId });
      const host = nativeDshOwnershipHost(agent), pending = host.pending();
      if (pending) {
        invariant(pending.engine === NATIVE_DSH_BACKGROUND_TURN_CONTRACT, 'studio_native_background_session_busy');
        const owner = readNativeDshBackgroundOwnership(pending, { sessionId: agent.session.id, turn: pending.turn });
        invariant(canonical(owner.identity.scope) === canonical(scope) && owner.identity.runId === runId,
          'studio_native_background_session_busy');
        await execute.resumeBackground({ agent, signal });
        return { status: 'admitted', runId };
      }
      let existing;
      try { existing = store.load(scope, runId); }
      catch (error) { if (error.code !== 'run_not_found') throw error; }
      if (existing) {
        await verifyNativeDshBackgroundOwnership(nativeDshBackgroundOwnership({ record: existing, turn: 1 }),
          { store, scope, sessionId: agent.session.id, turn: 1, signal });
        if (terminal(existing.snapshot.phase)) return { status: 'discarded', runId, reason: 'notice_terminal' };
        invariant(existing.snapshot.phase !== 'interrupted', 'studio_native_background_reconciliation_required');
      }
      const idle = nativeDshIdleOwnershipHost(agent);
      invariant(agent.status === 'idle', 'studio_native_background_session_busy');
      invariant(typeof agentEvents === 'function', 'studio_native_recovery_dispatch_unavailable');
      const binding = await live(() => agentEvents(ctx, agent).serial('agentkit/native-recovery-binding', {}), signal);
      signal.throwIfAborted();
      assertNativeRecoveryPreset(capsule, binding);
      let observer;
      if (!existing) {
        invariant(typeof binding.nativeTools?.backgroundObserver === 'function', 'studio_native_background_observer_unavailable');
        observer = binding.nativeTools.backgroundObserver(agent, { scope, store });
        invariant(observer?.contract === BACKGROUND_COMMAND_CONTRACT && typeof observer.observeCompletion === 'function',
          'studio_native_background_observer_unavailable');
        const head = store.sessionHead(scope, agent.session.id);
        invariant(head?.phase === 'completed', 'studio_native_background_session_busy');
        const command = source.snapshot.backgroundCommands.find(row => row.ref.taskId === taskId && !row.notified);
        invariant(command && command.ref.sourceRunId === sourceRunId, 'background_notification_task_unavailable');
        const observation = await live(() => observer.observeCompletion({ contract: BACKGROUND_NOTIFICATION_ADMISSION, scope,
          sourceRunId, sessionId: agent.session.id, sourceConfigDigest: source.snapshot.configDigest,
          sourceRevision: source.snapshot.revision, headRunId: head.runId, ref: structuredClone(command.ref), signal }), signal);
        signal.throwIfAborted();
        if (!observation || ['unknown', 'unavailable'].includes(observation.status))
          return { status: observation === null ? 'watching' : 'pending_admission', runId: null, reason: 'command_not_terminal' };
      }
      // Re-read the backend under the SDK's exclusive idle reservation. The
      // earlier read only avoids opening empty turns for still-running tasks.
      // Admission persists before the owner is returned; no model can run until
      // the shared executor has claimed and flushed that owner.
      await idle.start(async payload => {
        preparedSignal = AbortSignal.any([signal, payload.signal]);
        preparedSignal.throwIfAborted();
        const admitted = await admitBackgroundNotification({ store, scope, sourceRunId, taskId, digest: hash,
          signal: preparedSignal, observe: request => {
            invariant(observer, 'studio_native_background_admission_missing');
            return observer.observeCompletion(request);
          } });
        prepared = store.load(scope, admitted.snapshot.runId);
        preparedSignal.throwIfAborted();
        return nativeDshBackgroundOwnership({ record: prepared, turn: payload.turn });
      }, payload => execute.background({ ...payload, agent, signal: AbortSignal.any([signal, payload.signal]) }));
      return { status: 'admitted', runId };
    } catch (error) {
      if (prepared && preparedSignal?.aborted) {
        try {
          const { snapshot } = store.load(scope, prepared.snapshot.runId);
          if (!terminal(snapshot.phase)) {
            const commandId = `${snapshot.runId}:dsh-turn-cancel`;
            const previous = store.load(scope, snapshot.runId).commands.find(row => row.command.commandId === commandId)?.command;
            new NativeKernel({ store, digest: hash, owner: 'studio-background-admission-cancel', ports: {} })
              .submit(scope, snapshot.runId, previous ?? { commandId, kind: 'cancel', payload: { dshCancelReason: cause(preparedSignal.reason) } });
          }
        } catch (cancelError) { throw new AggregateError([error, cancelError], 'Studio background admission cancellation requires recovery'); }
      }
      throw error;
    } finally { driving.delete(key); }
  };
  return request => {
    lifetime.signal.throwIfAborted();
    const promise = drive(request);
    active.add(promise); void promise.finally(() => active.delete(promise)).catch(() => {});
    return promise;
  };
}

/** Resolve only the original Session for a persisted watch. Registry entries
 * are recovery facts, never authority to select another workspace or Agent.
 * Keep the lookup inside the Host lifetime, including a noncooperative cold
 * Session load that returns after shutdown.
 */
export function createStudioNativeBackgroundDispatcher({ ctx, store, workspaceId, lifetime, active, notify }) {
  const drive = async request => {
    invariant(request && typeof request === 'object' && !Array.isArray(request)
      && Object.keys(request).every(key => ['scope', 'sessionId', 'sourceRunId', 'taskId', 'signal'].includes(key))
      && text(request.sessionId) && text(request.sourceRunId) && /^[a-f0-9]{64}$/.test(request.taskId)
      && text(request.scope?.agentId), 'studio_native_background_watch_invalid');
    const { sessionId, sourceRunId, taskId } = request;
    const agentId = request.scope.agentId;
    const scope = { tenantId: 'local', workspaceId, userId: 'local-user', agentId };
    invariant(canonical(request.scope) === canonical(scope), 'studio_native_background_scope_mismatch');
    invariant(request.signal === undefined || request.signal instanceof AbortSignal, 'studio_native_background_signal_invalid');
    const signal = request.signal ? AbortSignal.any([request.signal, lifetime.signal]) : lifetime.signal;
    signal.throwIfAborted();
    const source = store.load(scope, sourceRunId);
    readNativeRecoveryBinding(source, { agentId, sessionId, runId: sourceRunId });
    invariant(source.snapshot.phase === 'completed' && source.configuration.backgroundNotificationPolicy === 'completed-before-model/v1'
      && source.snapshot.backgroundCommands.some(row => row.ref.sourceRunId === sourceRunId && row.ref.taskId === taskId),
    'studio_native_background_source_unavailable');
    const controller = ctx.get('sessionController');
    invariant(typeof controller?.resolveAgent === 'function', 'studio_native_background_controller_unavailable');
    const found = await live(() => controller.resolveAgent(sessionId), signal);
    if (found?.error) throw found.error;
    invariant(found?.agent?.session?.id === sessionId, 'studio_native_background_session_mismatch');
    return notify({ agent: found.agent, agentId, sourceRunId, taskId, signal });
  };
  return request => {
    lifetime.signal.throwIfAborted();
    const promise = drive(request);
    active.add(promise); void promise.finally(() => active.delete(promise)).catch(() => {});
    return promise;
  };
}
