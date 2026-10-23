import { addUsage, canonical, copy, invariant, terminal } from '../../../packages/agentkit-harness-core/dist/index.mjs';
import { readNativeDshOwnership } from '../../../packages/agentkit-harness/src/native/dsh-turn-ownership.mjs';
import { NATIVE_DSH_BACKGROUND_TURN_CONTRACT, verifyNativeDshBackgroundOwnership } from '../../../packages/agentkit-harness/src/native/dsh-background-ownership.mjs';

export const STUDIO_NATIVE_RECOVERY_CONTRACT = 'agentkit.studio-native-recovery/v1';
export const STUDIO_NATIVE_USAGE_CONTRACT = 'agentkit.studio-native-usage/v1';
const text = value => typeof value === 'string' && value.trim() && value.length <= 256;
const ended = record => record && ['completed', 'failed', 'canceled'].includes(record.snapshot.phase);

// Resolving a Session can outlive the request or Host. A late result grants no
// authority to start work. The real SessionController owns its lookup lifetime.
async function live(operation, signal) {
  signal.throwIfAborted();
  let abort;
  const stopped = new Promise((_, reject) => {
    abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
  });
  try {
    const result = await Promise.race([Promise.resolve().then(operation), stopped]);
    signal.throwIfAborted(); return result;
  } finally { signal.removeEventListener('abort', abort); }
}

/** Authenticated product recovery. No queued prompt, replacement Run or defaults. */
export function createStudioNativeRecovery({ ctx, store, workspaceId, lifetime, active, controls, controlKey, execute }) {
  const attempts = new Map();
  const inspect = async (request, callerSignal) => {
    invariant(text(request?.agentId) && text(request.sessionId)
      && (request.runId === undefined || text(request.runId)), 'studio_native_recovery_request_invalid');
    const signal = callerSignal ? AbortSignal.any([callerSignal, lifetime.signal]) : lifetime.signal;
    const controller = ctx.get('sessionController');
    invariant(typeof controller?.resolveAgent === 'function', 'studio_native_recovery_controller_unavailable');
    const found = await live(() => controller.resolveAgent(request.sessionId), signal);
    if (found.error) throw found.error;
    const agent = found.agent;
    invariant(agent?.session?.id === request.sessionId, 'studio_native_recovery_identity_mismatch');
    const scope = { tenantId: 'local', workspaceId, userId: 'local-user', agentId: request.agentId };
    const owner = agent.externalTurns?.pending();
    if (!owner) {
      let record = null;
      const runId = request.runId ?? store.sessionHead(scope, request.sessionId)?.runId;
      if (runId) {
        try { record = store.load(scope, runId); }
        catch (error) { if (error.code !== 'run_not_found') throw error; }
        invariant(!record || record.snapshot.sessionId === request.sessionId, 'studio_native_recovery_identity_mismatch');
      }
      return { agent, scope, admission: null, record };
    }
    const background = owner.engine === NATIVE_DSH_BACKGROUND_TURN_CONTRACT;
    const verified = background ? await verifyNativeDshBackgroundOwnership(owner, { store, scope,
      sessionId: request.sessionId, turn: owner.turn, signal }) : null;
    const admission = verified?.admission ?? readNativeDshOwnership(owner, { sessionId: request.sessionId, turn: owner.turn });
    invariant(canonical(admission.identity.scope) === canonical(scope)
      && (!request.runId || request.runId === admission.identity.runId), 'studio_native_recovery_identity_mismatch');
    let record = null;
    try { record = store.load(scope, admission.identity.runId); }
    catch (error) { if (error.code !== 'run_not_found') throw error; }
    return { agent, scope, admission, record, turn: owner.turn, background };
  };
  const summary = (request, inspected) => {
    const { admission, record } = inspected;
    const runId = admission?.identity.runId ?? record?.snapshot.runId ?? request.runId ?? null;
    const attempt = attempts.get(controlKey(request.agentId, request.sessionId));
    const applicable = attempt?.runId === runId ? attempt : null;
    const driving = applicable?.running || Boolean(admission && controls.get(controlKey(request.agentId, request.sessionId))?.runId === admission.identity.runId);
    const snapshot = record?.snapshot;
    const incomplete = snapshot && (snapshot.diagnostics.providerUsageIncomplete === true || snapshot.diagnostics.descendantUsageIncomplete === true);
    // This is a read-only view of the original ledger, not usage attributed to
    // a synthetic assistant message or another provider. Unknown counters stay
    // explicit lower bounds; neither a closed DSH turn nor zero makes them free.
    const accounting = snapshot ? { contract: STUDIO_NATIVE_USAGE_CONTRACT, runId: snapshot.runId,
      snapshotRevision: snapshot.revision, own: copy(snapshot.usage), descendant: copy(snapshot.descendantUsage),
      total: addUsage(snapshot.usage, snapshot.descendantUsage), final: terminal(snapshot.phase),
      incomplete, complete: terminal(snapshot.phase) && !incomplete } : null;
    return { contract: STUDIO_NATIVE_RECOVERY_CONTRACT, agentId: request.agentId, sessionId: request.sessionId,
      runId, turn: admission ? inspected.turn : null, accounting,
      state: driving ? 'recovering' : !admission ? 'closed'
        : record?.snapshot.phase === 'interrupted' ? 'reconciliation_required' : applicable?.error ? 'failed' : 'available',
      phase: record?.snapshot.phase ?? (admission ? 'admitted' : null),
      canResume: Boolean(admission && !driving && record?.snapshot.phase !== 'interrupted'),
      error: applicable?.error ?? null };
  };
  const status = async (request, signal) => summary(request, await inspect(request, signal));
  const resume = (request, signal) => {
    invariant(text(request?.runId) && text(request.agentId) && text(request.sessionId), 'studio_native_recovery_request_invalid');
    lifetime.signal.throwIfAborted(); signal?.throwIfAborted();
    const key = controlKey(request.agentId, request.sessionId), previous = attempts.get(key);
    if (previous?.running) {
      invariant(previous.runId === request.runId, 'studio_native_recovery_identity_mismatch');
      return previous.acknowledgment;
    }
    const acknowledgment = Promise.withResolvers();
    const attempt = { runId: request.runId, running: true, error: null, acknowledgment: acknowledgment.promise };
    attempts.set(key, attempt);
    const task = (async () => {
      const inspected = await inspect(request, signal);
      if (!inspected.admission && ended(inspected.record)) {
        acknowledgment.resolve({ ...summary(request, inspected), state: 'closed', canResume: false });
        return;
      }
      invariant(inspected.admission, 'studio_native_recovery_turn_not_open');
      invariant(inspected.record?.snapshot.phase !== 'interrupted', 'studio_native_recovery_reconciliation_required');
      invariant(!controls.has(key), 'studio_native_recovery_already_active');
      signal?.throwIfAborted(); lifetime.signal.throwIfAborted();
      return execute[inspected.background ? 'resumeBackground' : 'resume']({ agent: inspected.agent, signal: lifetime.signal,
        recoveryStarted: control => {
          invariant(control.runId === request.runId, 'studio_native_recovery_identity_mismatch');
          acknowledgment.resolve({ ...summary(request, inspected), state: 'recovering', canResume: false });
        } });
    })();
    active.add(task);
    void task.catch(error => {
      attempt.error = { code: typeof error?.code === 'string' ? error.code : 'STUDIO_NATIVE_RECOVERY_FAILED',
        message: '原运行尚未恢复，请核对配置或恢复状态。' };
      acknowledgment.reject(error);
    }).finally(() => { attempt.running = false; active.delete(task); });
    return acknowledgment.promise;
  };
  return { status, resume };
}
