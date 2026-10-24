import { addUsage, canonical, copy, invariant, terminal } from '../../../packages/agentkit-harness-core/dist/index.mjs';
import { readNativeDshOwnership } from '../../../packages/agentkit-harness/src/native/dsh-turn-ownership.mjs';
import { NATIVE_DSH_BACKGROUND_TURN_CONTRACT, verifyNativeDshBackgroundOwnership } from '../../../packages/agentkit-harness/src/native/dsh-background-ownership.mjs';
import { assertNativeRecoveryPreset, readNativeRecoveryBinding } from '../../providers/native-recovery-binding.mjs';
import { nativeA2aReceiptWaitSource, NATIVE_A2A_RECEIPT_WAIT, NATIVE_A2A_QUESTION_CLEANUP } from '../../providers/native-a2a-receipt.mjs';
import { nativeChildA2aWaitSource } from '../../providers/native-child-a2a-wait.mjs';

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
  const resume = (request, signal, admit) => {
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
          // Request/discovery retirement before admission grants no new driver.
          // Once acknowledged, the owning Host lifetime controls the Run.
          signal?.throwIfAborted(); lifetime.signal.throwIfAborted();
          admit?.();
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
  // Called only by the Host startup owner, never by status/history reads. The
  // ledger is discovery, not authority: resolve and recheck the live root,
  // original external turn, current archive policy, lease and exact capsule.
  const automatic = async (request, callerSignal) => {
    const signal = callerSignal ? AbortSignal.any([callerSignal, lifetime.signal]) : lifetime.signal;
    const archived = () => {
      signal.throwIfAborted();
      const ids = ctx.get('workspaceRegistry')?.archivedSessionIds;
      invariant(Array.isArray(ids), 'studio_native_recovery_archive_policy_unavailable');
      return ids.includes(request.sessionId);
    };
    if (archived()) return { status: 'deferred' };
    // Discovery must not open an absent Session. A user/SDK resume owns that
    // handle; racing it through resolveAgent can create two writers. Only
    // inspect a root already published by the Host, then pin that exact root
    // across the asynchronous original-owner lookup below.
    const registry = ctx.get('agents'), roots = registry?.roots?.() ?? [], registered = registry?.get?.(request.sessionId);
    if (registered?.session?.id === request.sessionId)
      invariant(roots.includes(registered), 'studio_native_recovery_live_root_required');
    const liveRoot = roots.find(root => root.session?.id === request.sessionId && registry?.get?.(root.id) === root);
    if (!liveRoot || liveRoot.status !== 'idle') return { status: 'deferred' };
    const inspected = await inspect(request, signal), { record, agent, scope, admission } = inspected;
    if (archived() || !record || controls.has(controlKey(request.agentId, request.sessionId))) return { status: 'deferred' };
    if (agent.status !== 'idle') return { status: 'deferred' };
    invariant(agent === liveRoot && ctx.get('agents')?.get?.(agent.id) === agent
      && ctx.get('agents')?.roots?.().includes(agent), 'studio_native_recovery_live_root_required');
    if (record.configuration.childOwnerBinding || record.lease && record.lease.expiresAt > Date.now()) return { status: 'deferred' };
    const identity = { agentId: request.agentId, sessionId: request.sessionId, runId: request.runId };
    const capsule = readNativeRecoveryBinding(record, identity);
    const checkpoint = canonical(record.snapshot), configuration = canonical(record.configuration);
    const childWait = nativeChildA2aWaitSource({ store, record });
    const admit = () => {
      invariant(!archived() && agent.session?.id === request.sessionId
        && ctx.get('agents')?.get?.(agent.id) === agent && ctx.get('agents')?.roots?.().includes(agent),
        'studio_native_recovery_live_root_required');
      const current = store.load(scope, request.runId);
      invariant(canonical(current.snapshot) === checkpoint && canonical(current.configuration) === configuration
        && (!current.lease || current.lease.expiresAt <= Date.now())
        && (!childWait || canonical(nativeChildA2aWaitSource({ store, record: current })) === canonical(childWait)),
      'studio_native_recovery_checkpoint_changed');
    };
    if (nativeA2aReceiptWaitSource(record) || childWait) {
      if (!admission || store.sessionHead(scope, request.sessionId)?.runId !== request.runId) return { status: 'deferred' };
      // resume performs its own asynchronous inspection and full frozen
      // configuration/preset/Build/prompt rebind before installing any port.
      await resume(identity, signal, admit); return { status: 'restored' };
    }
    if (!terminal(record.snapshot.phase)) return { status: 'deferred' };
    // Cleanup may have committed before a crash lost the DSH turn/end. Its
    // cursor must never hide the still-open original owner.
    if (admission && ended(record)) { await resume(identity, signal, admit); return { status: 'restored' }; }
    if ((record.projections[NATIVE_A2A_QUESTION_CLEANUP] ?? 0) >= record.snapshot.eventSeq)
      return { status: 'settled' };
    // A closed DSH turn cannot be resumed merely to clear a local question.
    // Use the current trusted preset's local-only cleanup port, retaining the
    // original recorded capsule and the committed terminal checkpoint.
    invariant(typeof agentEvents === 'function', 'studio_native_recovery_dispatch_unavailable');
    const presetId = ctx.get('sessionProjections')?.stateOf?.(agent.session, 'agentPreset');
    invariant(typeof presetId === 'string' && presetId, 'studio_native_recovery_preset_changed');
    const binding = await live(() => agentEvents(ctx, agent).serial('agentkit/native-recovery-binding', {}), signal);
    assertNativeRecoveryPreset(capsule, binding);
    invariant(typeof binding.nativeTools?.settleA2aQuestions === 'function', 'studio_native_a2a_cleanup_unavailable');
    if (archived()) return { status: 'deferred' };
    invariant(ctx.get('agents')?.get?.(agent.id) === agent && ctx.get('agents')?.roots?.().includes(agent)
      && ctx.get('sessionProjections')?.stateOf?.(agent.session, 'agentPreset') === presetId
      && canonical(store.load(scope, request.runId).snapshot) === canonical(record.snapshot),
    'studio_native_recovery_identity_mismatch');
    await live(() => binding.nativeTools.settleA2aQuestions({ scope, sessionId: request.sessionId, runId: request.runId, store }), signal);
    signal.throwIfAborted();
    store.acknowledge(scope, request.runId, NATIVE_A2A_QUESTION_CLEANUP, record.snapshot.eventSeq);
    return { status: 'cleaned' };
  };
  return { status, resume, reconcile, automatic };
}
