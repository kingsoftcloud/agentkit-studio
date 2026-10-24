import { addUsage, canonical, copy, invariant, terminal } from '../../../packages/agentkit-harness-core/dist/index.mjs';
import { readNativeDshOwnership } from '../../../packages/agentkit-harness/src/native/dsh-turn-ownership.mjs';
import { NATIVE_DSH_BACKGROUND_TURN_CONTRACT, verifyNativeDshBackgroundOwnership } from '../../../packages/agentkit-harness/src/native/dsh-background-ownership.mjs';
import { assertNativeRecoveryPreset, readNativeRecoveryBinding } from '../../providers/native-recovery-binding.mjs';
import { nativeA2aReceiptWaitSource, NATIVE_A2A_RECEIPT_WAIT } from '../../providers/native-a2a-receipt.mjs';

export const STUDIO_NATIVE_RECOVERY_CONTRACT = 'agentkit.studio-native-recovery/v1';
export const STUDIO_NATIVE_USAGE_CONTRACT = 'agentkit.studio-native-usage/v1';
const text = value => typeof value === 'string' && value.trim() && value.length <= 256;
const ended = record => record && ['completed', 'failed', 'canceled'].includes(record.snapshot.phase);

export function validateNativeReconciliationRequest(request) {
  invariant(request && typeof request === 'object' && !Array.isArray(request)
    && Object.keys(request).every(key => ['agentId', 'sessionId', 'runId', 'operationKey', 'commandId'].includes(key))
    && ['agentId', 'sessionId', 'runId', 'operationKey', 'commandId'].every(key => text(request[key])),
  'STUDIO_NATIVE_RECONCILIATION_INVALID');
}

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
export function createStudioNativeRecovery({ ctx, store, workspaceId, lifetime, active, controls, controlKey, execute, agentEvents }) {
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
    const reconciliation = snapshot?.toolReconciliation;
    const waiting = snapshot?.phase === 'awaiting_reconciliation' && Boolean(reconciliation);
    const receiptWait = nativeA2aReceiptWaitSource(record);
    const incomplete = snapshot && (snapshot.diagnostics.providerUsageIncomplete === true || snapshot.diagnostics.descendantUsageIncomplete === true);
    // This is a read-only view of the original ledger, not usage attributed to
    // a synthetic assistant message or another provider. Unknown counters stay
    // explicit lower bounds; neither a closed DSH turn nor zero makes them free.
    const accounting = snapshot ? { contract: STUDIO_NATIVE_USAGE_CONTRACT, runId: snapshot.runId,
      snapshotRevision: snapshot.revision, own: copy(snapshot.usage), descendant: copy(snapshot.descendantUsage),
      total: addUsage(snapshot.usage, snapshot.descendantUsage), final: terminal(snapshot.phase),
      incomplete, complete: terminal(snapshot.phase) && !incomplete } : null;
    const a2aTasks = record?.intents.filter(intent => intent.kind === 'tool').flatMap(intent =>
      (intent.payload.calls ?? []).filter(call => call.name === 'call_a2a_agent').map(call => ({ runId: snapshot.runId,
        operationKey: intent.operationKey, callId: call.callId }))) ?? [];
    return { contract: STUDIO_NATIVE_RECOVERY_CONTRACT, agentId: request.agentId, sessionId: request.sessionId,
      runId, turn: admission ? inspected.turn : null, accounting,
      ...(a2aTasks.length ? { a2aTasks } : {}),
      ...(reconciliation ? { reconciliation: copy(reconciliation) } : {}),
      ...(receiptWait ? { receiptWait: { contract: NATIVE_A2A_RECEIPT_WAIT,
        operationKey: reconciliation.operationKey, callId: receiptWait.call.callId } } : {}),
      state: !admission ? 'closed' : driving ? 'recovering' : waiting ? 'reconciliation_required'
        : record?.snapshot.phase === 'interrupted' ? 'reconciliation_required' : applicable?.error ? 'failed' : 'available',
      phase: record?.snapshot.phase ?? (admission ? 'admitted' : null),
      canResume: Boolean(admission && !driving && (!waiting || receiptWait) && record?.snapshot.phase !== 'interrupted'),
      canReconcile: Boolean(admission && waiting),
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
      invariant(inspected.record?.snapshot.phase !== 'awaiting_reconciliation'
        || nativeA2aReceiptWaitSource(inspected.record)
        || inspected.record.commands.some(row => !row.consumed && row.command.kind === 'reconcile_tool'
          && row.command.payload.originalOperationKey === inspected.record.snapshot.toolReconciliation?.operationKey),
      'studio_native_recovery_reconciliation_required');
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
  const reconcile = (request, callerSignal) => {
    validateNativeReconciliationRequest(request);
    const original = copy(request), bytes = canonical(request);
    const signal = AbortSignal.any([lifetime.signal, ...(callerSignal ? [callerSignal] : [])]);
    const task = (async () => {
      const inspected = await inspect(original, signal), { agent, scope, record } = inspected;
      const capsule = readNativeRecoveryBinding(record, original), session = agent.session;
      const preset = ctx.get('sessionProjections')?.stateOf?.(session, 'agentPreset');
      invariant(text(preset) && typeof agentEvents === 'function', 'studio_native_recovery_preset_unavailable');
      const binding = await live(() => agentEvents(ctx, agent).serial('agentkit/native-recovery-binding', {}), signal);
      assertNativeRecoveryPreset(capsule, binding);
      // Session resolution and preset queries can wait. Re-read durable turn
      // ownership and configuration before authorizing this new read command.
      const current = await inspect(original, signal);
      signal.throwIfAborted();
      invariant(canonical(request) === bytes && current.agent === agent && agent.session === session
        && ctx.get('sessionProjections')?.stateOf?.(session, 'agentPreset') === preset
        && current.record?.snapshot.configDigest === record.snapshot.configDigest,
      'studio_native_recovery_identity_mismatch');
      const command = { commandId: original.commandId, kind: 'reconcile_tool', payload: { originalOperationKey: original.operationKey } };
      const previous = current.record.commands.find(row => row.command.commandId === original.commandId);
      if (previous) {
        invariant(canonical(previous.command) === canonical(command), 'command_replay_conflict');
        if (previous.consumed) return summary(original, current);
      }
      const marker = current.record.snapshot.toolReconciliation;
      invariant(current.admission && current.record.snapshot.phase === 'awaiting_reconciliation'
        && marker?.operationKey === original.operationKey, 'studio_native_recovery_reconciliation_required');
      const control = controls.get(controlKey(original.agentId, original.sessionId));
      if (control) invariant(control.runId === original.runId && canonical(control.scope) === canonical(scope)
        && typeof control.wake === 'function', 'studio_native_recovery_identity_mismatch');
      // The request carries no result or permission grant. Only the leased
      // Kernel may read the original remote task and commit its new receipt.
      const receipt = store.enqueue(scope, original.runId, command);
      invariant(receipt.status !== 'rejected', 'studio_native_recovery_reconciliation_rejected');
      if (control) { control.wake(); return summary(original, current); }
      return resume({ agentId: original.agentId, sessionId: original.sessionId, runId: original.runId }, signal);
    })();
    active.add(task); void task.finally(() => active.delete(task)).catch(() => {});
    return task;
  };
  return { status, resume, reconcile };
}
