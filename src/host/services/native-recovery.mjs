import { nativeVerificationRequired } from '../../providers/native-verification.mjs';
import { nativeContextStatus } from '@kingsoftcloud/agentkit-harness-node/native/context-status';
import { nativeActivityStatus } from '@kingsoftcloud/agentkit-harness-node/native/activity-status';
import { addUsage, canonical, copy, invariant, terminal } from '@kingsoftcloud/agentkit-harness-core';
import { readNativeDshOwnership } from '@kingsoftcloud/agentkit-harness-node/native/dsh-turn-ownership';
import { NATIVE_DSH_BACKGROUND_TURN_CONTRACT, verifyNativeDshBackgroundOwnership } from '@kingsoftcloud/agentkit-harness-node/native/dsh-background-ownership';
import { assertNativeRecoveryPreset, readNativeRecoveryBinding } from '../../providers/native-recovery-binding.mjs';
import { nativePublicTerminalError } from '../../providers/native-terminal-failure.mjs';
import { nativeA2aReceiptWaitSource, NATIVE_A2A_RECEIPT_WAIT, NATIVE_A2A_QUESTION_CLEANUP } from '../../providers/native-a2a-receipt.mjs';
import { nativeChildA2aWaitSource } from '../../providers/native-child-a2a-wait.mjs';
import { NATIVE_DSH_MANAGED_TURN_CONTRACT, readNativeDshManagedOwnership } from '@kingsoftcloud/agentkit-harness-node/native/dsh-managed-ownership';
import { STUDIO_MANAGED_NATIVE_OWNER_PROJECTION } from './native-managed-execution.mjs';
import { nativeToolStates } from '../../providers/native-tool-states.mjs';
import { canCloseNativeReadInterruption } from '@kingsoftcloud/agentkit-harness-node/native/dsh-turn-runtime';
import { nativeToolOutcomeFact } from '@kingsoftcloud/agentkit-harness-node/native/session-delivery';
import { reviewableBackgroundInterruption, reviewedBackgroundInterruption } from '@kingsoftcloud/agentkit-harness-core';

export const STUDIO_NATIVE_RECOVERY_CONTRACT = 'agentkit.studio-native-recovery/v1';
export const STUDIO_NATIVE_USAGE_CONTRACT = 'agentkit.studio-native-usage/v1';
export const STUDIO_MANAGED_NATIVE_RECOVERY_CONTRACT = 'agentkit.studio-managed-native-recovery/v1';
const text = value => typeof value === 'string' && value.trim() && value.length <= 256;
const ended = record => record && (['completed', 'failed', 'canceled'].includes(record.snapshot.phase)
  || canCloseNativeReadInterruption(record));

export function validateNativeReconciliationRequest(request) {
  invariant(request && typeof request === 'object' && !Array.isArray(request)
    && Object.keys(request).every(key => ['agentId', 'sessionId', 'runId', 'operationKey', 'commandId'].includes(key))
    && ['agentId', 'sessionId', 'runId', 'operationKey', 'commandId'].every(key => text(request[key])),
  'STUDIO_NATIVE_RECONCILIATION_INVALID');
}
export function validateNativeBackgroundReviewRequest(request) {
  invariant(request && typeof request === 'object' && !Array.isArray(request)
    && Object.keys(request).sort().join(',') === 'agentId,commandId,confirmedStopped,eventSeq,runId,sessionId'
    && ['agentId', 'sessionId', 'runId', 'commandId'].every(key => text(request[key]))
    && Number.isSafeInteger(request.eventSeq) && request.eventSeq >= 0 && request.confirmedStopped === true,
  'STUDIO_NATIVE_BACKGROUND_REVIEW_INVALID');
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
export function createStudioNativeRecovery({ ctx, store, workspaceId, workspaceRoot, lifetime, active, controls, controlKey, execute, agentEvents, cloudMemoryStatus, memoryExtractionStatus, workspaceStatus, commandProgressStatus }) {
  const attempts = new Map();
  const inspectManaged = (request, agent, owner, localRecord) => {
    const pending = owner?.engine === NATIVE_DSH_MANAGED_TURN_CONTRACT;
    const control = ctx.get('studioManagedNativeSessionControl');
    if (!control || control.agentId !== request.agentId) {
      invariant(!pending, 'NATIVE_MANAGED_STATUS_IDENTITY_MISMATCH'); return null;
    }
    const projection = ctx.get('sessionProjections')?.stateOf(agent.session, STUDIO_MANAGED_NATIVE_OWNER_PROJECTION);
    const knownOwner = pending ? owner : projection?.lastClosed;
    const admitted = knownOwner ? readNativeDshManagedOwnership(knownOwner, { sessionId: request.sessionId }) : null;
    if (pending) invariant(!request.runId || admitted.identity.runId === request.runId,
      'studio_native_recovery_identity_mismatch');
    const query = { ...request, workspaceId,
      ...(pending ? { runId: admitted.identity.runId } : {}) };
    const managed = control.inspect(query);
    invariant(!pending || managed, 'NATIVE_MANAGED_STATUS_IDENTITY_MISMATCH');
    if (!managed) return null;
    const matchingOwner = admitted?.identity.runId === managed.runId ? knownOwner : null;
    // Background Native turn IDs are opaque wake IDs. Their committed public
    // delivery cursor records the numeric SDK position independently.
    const prefix = `dsh:${request.sessionId}:`;
    const positions = Object.keys(localRecord?.projections ?? {}).flatMap(key => {
      const match = key.startsWith(prefix) && /^([1-9][0-9]*):v1:[a-f0-9]{64}$/.exec(key.slice(prefix.length));
      return match && Number.isSafeInteger(Number(match[1])) ? [Number(match[1])] : [];
    });
    const localTurn = positions.length ? Math.max(...positions) : Number(localRecord?.snapshot.turnId);
    // A closed managed projection survives later ordinary turns. Prefer the
    // newer ordinary head unless an accepted managed command is still pending
    // or the caller explicitly asks for that historical managed Run.
    if (!pending && !request.runId && localRecord
      && !(managed.commandState === 'accepted' && !terminal(managed.record?.snapshot.phase))
      && (!matchingOwner || !Number.isSafeInteger(localTurn) || localTurn < 1 || knownOwner.turn < localTurn)) return null;
    if (matchingOwner) {
      invariant(canonical(admitted.identity.scope) === canonical(managed.scope)
        && admitted.identity.buildId === managed.buildId && admitted.identity.turnId === managed.commandId
        && admitted.configDigest === managed.configDigest, 'NATIVE_MANAGED_STATUS_IDENTITY_MISMATCH');
      if (managed.record) invariant(['runId', 'sessionId', 'turnId', 'buildId', 'parentRunId', 'taskChainId']
        .every(key => admitted.identity[key] === managed.record.snapshot[key]), 'NATIVE_MANAGED_STATUS_IDENTITY_MISMATCH');
    }
    return { agent, scope: managed.scope, record: managed.record, admission: pending ? admitted : null,
      turn: matchingOwner?.turn ?? null, managed, managedControl: control,
      managedQuery: { ...query, runId: managed.runId }, owner: owner ?? null };
  };
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
      return inspectManaged(request, agent, owner, record) ?? { agent, scope, admission: null, record };
    }
    if (owner.engine === NATIVE_DSH_MANAGED_TURN_CONTRACT) return inspectManaged(request, agent, owner);
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
    const { admission, record, managed } = inspected;
    const runId = managed?.runId ?? admission?.identity.runId ?? record?.snapshot.runId ?? request.runId ?? null;
    const attempt = attempts.get(controlKey(request.agentId, request.sessionId));
    const applicable = attempt?.runId === runId ? attempt : null;
    const driving = managed ? managed.executing : applicable?.running || Boolean(admission && controls.get(controlKey(request.agentId, request.sessionId))?.runId === admission.identity.runId);
    const snapshot = record?.snapshot;
    const backgroundReviewed = record && reviewedBackgroundInterruption(record);
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
    const managedWaiting = managed && ['paused', 'awaiting_interaction'].includes(snapshot?.phase);
    const deliveryPrefix = `dsh:${request.sessionId}:`;
    const deliveredTurns = Object.keys(record?.projections ?? {}).flatMap(key => {
      const match = key.startsWith(deliveryPrefix) && /^([1-9][0-9]*):v1:[a-f0-9]{64}$/.exec(key.slice(deliveryPrefix.length));
      return match && Number.isSafeInteger(Number(match[1])) ? [Number(match[1])] : [];
    });
    const presentationTurn = Number.isSafeInteger(inspected.turn) ? inspected.turn
      : deliveredTurns.length ? Math.max(...deliveredTurns) : null;
    const discarded = managed?.commandState === 'discarded';
    const grantBlocked = managed?.executionGrant?.blockedReason;
    return { contract: STUDIO_NATIVE_RECOVERY_CONTRACT, agentId: request.agentId, sessionId: request.sessionId,
      runId, turn: admission ? inspected.turn : null, presentationTurn, accounting, toolStates: nativeToolStates(record, { driving }),
      contextStatus: nativeContextStatus(record, { driving }),
      ...(!managed && record && commandProgressStatus ? { commandPreviews: commandProgressStatus(record) } : {}),
      ...(!managed && record && typeof store.uncertainToolCalls === 'function' ? {
        uncertainTools: { contract: 'agentkit.native-session-tool-outcomes/v1', sessionId: request.sessionId,
          facts: store.uncertainToolCalls(record.snapshot.scope, request.sessionId).map(fact => nativeToolOutcomeFact({
            scope: record.snapshot.scope, sessionId: request.sessionId, runId: fact.runId, turnId: fact.turnId }, fact.callId, 'uncertain')) },
      } : {}),
      activity: nativeActivityStatus(record, { driving }),
      ...(!managed && snapshot?.scope.workspaceId === workspaceId && workspaceRoot
        ? { workspace: { contract: 'agentkit.native-execution-workspace/v1', workspaceId, root: workspaceRoot } } : {}),
      ...(snapshot ? { outcome: snapshot.outcome, reason: snapshot.reason,
        verificationRequired: nativeVerificationRequired(record.configuration.contract),
        capabilities: { toolNames: record.configuration.tools.map(tool => tool.name) } } : {}),
      ...(backgroundReviewed ? { backgroundInterruptionReview: copy(record.backgroundInterruptionReview) } : {}),
      canReviewBackground: Boolean(!managed && !inspected.background && admission && !driving
        && record && (!record.lease || record.lease.expiresAt <= Date.now())
        && typeof store.reviewBackgroundInterruption === 'function' && reviewableBackgroundInterruption(record)),
      ...(record ? { backgroundReviewEventSeq: record.snapshot.eventSeq } : {}),
      ...(managed ? { managed: { contract: STUDIO_MANAGED_NATIVE_RECOVERY_CONTRACT,
        commandId: managed.commandId, commandState: managed.commandState, controlAuthority: 'server',
        executionState: managed.executing ? 'running' : managed.active ? 'queued' : 'idle',
        owner: admission ? 'open' : inspected.turn || discarded ? 'closed' : 'pending',
        ...(managed.executionGrant ? { executionGrant: copy(managed.executionGrant) } : {}),
        retryAcceptedCommand: managed.retryable } } : {}),
      ...(a2aTasks.length ? { a2aTasks } : {}),
      ...(record && cloudMemoryStatus ? { cloudMemory: cloudMemoryStatus(record) } : {}),
      ...(record && memoryExtractionStatus ? { memoryExtraction: memoryExtractionStatus(record) } : {}),
      ...(reconciliation ? { reconciliation: copy(reconciliation) } : {}),
      ...(receiptWait ? { receiptWait: { contract: NATIVE_A2A_RECEIPT_WAIT,
        operationKey: reconciliation.operationKey, callId: receiptWait.call.callId } } : {}),
      state: managed ? discarded ? 'closed' : waiting || snapshot?.phase === 'interrupted' ? 'reconciliation_required'
        : terminal(snapshot?.phase) && !admission ? 'closed'
          : managedWaiting || grantBlocked ? 'available' : driving ? 'recovering' : managed.workerError || applicable?.error ? 'failed' : 'available'
        : !admission ? 'closed' : driving ? 'recovering' : waiting ? 'reconciliation_required'
        : record?.snapshot.phase === 'interrupted' ? 'reconciliation_required' : applicable?.error ? 'failed' : 'available',
      phase: record?.snapshot.phase ?? (discarded ? 'discarded' : admission || managed ? 'admitted' : null),
      canResume: managed ? Boolean(managed.retryable && (admission || !terminal(snapshot?.phase)))
        : Boolean(admission && !driving && (!waiting || receiptWait)
          && (record?.snapshot.phase !== 'interrupted' || canCloseNativeReadInterruption(record))),
      canReconcile: !managed && Boolean(admission && waiting),
      canRepairWorkspace: !managed && Boolean(admission && waiting
        && record.configuration.tools.some(tool => tool.name === snapshot.pendingTools[0]?.name
          && tool.workspaceRepairPolicy === 'preimage-compensation/v1')),
      error: applicable?.error ?? (managed?.workerError && !grantBlocked && !discarded ? { code: managed.workerError,
        message: '原托管运行尚未恢复，请核对配置或恢复状态。' }
        : nativePublicTerminalError(snapshot?.phase, snapshot?.reason)) };
  };
  const status = async (request, signal) => {
    const inspected = await inspect(request, signal), result = summary(request, inspected);
    // A remote managed run must never acquire this Host's local file/Git view.
    if (!inspected.record || inspected.managed || inspected.record.snapshot.scope.workspaceId !== workspaceId) return result;
    return workspaceStatus ? { ...result, workspaceStatus: await workspaceStatus(signal) } : result;
  };
  const reviewBackground = async (request, signal) => {
    validateNativeBackgroundReviewRequest(request);
    const requestedReview = { contract: 'agentkit.background-interruption-review/v1', commandId: request.commandId,
      eventSeq: request.eventSeq, confirmedStopped: true };
    const scope = { tenantId: 'local', workspaceId, userId: 'local-user', agentId: request.agentId };
    const previous = store.load(scope, request.runId);
    invariant(previous.snapshot.sessionId === request.sessionId, 'studio_native_background_review_identity_mismatch');
    if (previous.backgroundInterruptionReview) {
      invariant(canonical(previous.backgroundInterruptionReview) === canonical(requestedReview)
        && reviewedBackgroundInterruption(previous), 'command_replay_conflict');
      const effectiveSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
      const found = await live(() => ctx.get('sessionController').resolveAgent(request.sessionId), effectiveSignal);
      if (found.error) throw found.error;
      invariant(found.agent?.session?.id === request.sessionId, 'studio_native_background_review_identity_mismatch');
      // A lost response can be retried after queued work opened a newer turn.
      // Return the old disposition without inspecting/resuming that new owner.
      if (found.agent.externalTurns?.pending()?.turn !== Number(previous.snapshot.turnId)) {
        invariant(await ctx.get('sessions').flush(found.agent.session) === true, 'native_delivery_not_durable');
        return summary(request, { agent: found.agent, scope, record: previous, admission: null });
      }
    }
    const inspected = await inspect(request, signal);
    invariant(!inspected.managed && !inspected.background && inspected.record
      && inspected.record.snapshot.runId === request.runId, 'studio_native_background_review_identity_mismatch');
    const review = requestedReview;
    if (!inspected.admission) {
      invariant(canonical(inspected.record.backgroundInterruptionReview ?? null) === canonical(review)
        && reviewedBackgroundInterruption(inspected.record), 'studio_native_background_review_not_open');
      invariant(await ctx.get('sessions').flush(inspected.agent.session) === true, 'native_delivery_not_durable');
      return status(request, signal);
    }
    const key = controlKey(request.agentId, request.sessionId);
    invariant(!controls.has(key), 'studio_native_recovery_already_active');
    signal?.throwIfAborted(); lifetime.signal.throwIfAborted();
    invariant(typeof store.reviewBackgroundInterruption === 'function', 'studio_native_background_review_unavailable');
    store.reviewBackgroundInterruption(inspected.scope, request.runId, review, Date.now());
    // Once the operator disposition is durable, finish closure under the Host
    // lifetime. Losing the browser response must not turn it into a new request.
    const task = execute.closeReviewedBackgroundInterruption({ agent: inspected.agent, scope: inspected.scope,
      runId: request.runId, signal: lifetime.signal });
    active.add(task);
    try {
      await task;
      invariant(await ctx.get('sessions').flush(inspected.agent.session) === true, 'native_delivery_not_durable');
      return await status(request, lifetime.signal);
    } finally { active.delete(task); }
  };
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
      if (inspected.managed) {
        signal?.throwIfAborted(); lifetime.signal.throwIfAborted();
        invariant(canonical(inspected.agent.externalTurns?.pending() ?? null) === canonical(inspected.owner),
          'studio_native_recovery_identity_mismatch');
        const managed = inspected.managedControl.retry(inspected.managedQuery);
        acknowledgment.resolve(summary(request, { ...inspected, managed, record: managed.record }));
        return;
      }
      if (!inspected.admission && ended(inspected.record)) {
        acknowledgment.resolve({ ...summary(request, inspected), state: 'closed', canResume: false });
        return;
      }
      invariant(inspected.admission, 'studio_native_recovery_turn_not_open');
      invariant(inspected.record?.snapshot.phase !== 'interrupted' || canCloseNativeReadInterruption(inspected.record),
        'studio_native_recovery_reconciliation_required');
      invariant(inspected.record?.snapshot.phase !== 'awaiting_reconciliation'
        || nativeA2aReceiptWaitSource(inspected.record)
        || inspected.record.commands.some(row => !row.consumed && ['reconcile_tool', 'repair_workspace'].includes(row.command.kind)
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
  const reconcile = (request, callerSignal, repair = false) => {
    validateNativeReconciliationRequest(request);
    const original = copy(request), bytes = canonical(request);
    const signal = AbortSignal.any([lifetime.signal, ...(callerSignal ? [callerSignal] : [])]);
    const task = (async () => {
      const inspected = await inspect(original, signal), { agent, scope, record } = inspected;
      invariant(!inspected.managed, 'NATIVE_MANAGED_SERVER_CONTROL_REQUIRED');
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
      const command = { commandId: original.commandId, kind: repair ? 'repair_workspace' : 'reconcile_tool', payload: { originalOperationKey: original.operationKey } };
      const previous = current.record.commands.find(row => row.command.commandId === original.commandId);
      if (previous) {
        invariant(canonical(previous.command) === canonical(command), 'command_replay_conflict');
        if (previous.consumed) return summary(original, current);
      }
      const marker = current.record.snapshot.toolReconciliation;
      invariant(current.admission && current.record.snapshot.phase === 'awaiting_reconciliation'
        && marker?.operationKey === original.operationKey, 'studio_native_recovery_reconciliation_required');
      invariant(!repair || current.record.configuration.tools.some(tool => tool.name === current.record.snapshot.pendingTools[0]?.name
        && tool.workspaceRepairPolicy === 'preimage-compensation/v1'), 'studio_native_workspace_repair_not_admitted');
      const control = controls.get(controlKey(original.agentId, original.sessionId));
      if (control) invariant(control.runId === original.runId && canonical(control.scope) === canonical(scope)
        && typeof control.wake === 'function', 'studio_native_recovery_identity_mismatch');
      // Caller supplies only original identity. Read and compensation commands
      // are distinct; only the leased Kernel can dispatch either new effect.
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
    if (inspected.managed) return { status: 'deferred' }; // The managed receiver owns its startup/retry policy.
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
  return { status, resume, reviewBackground, reconcile, repairWorkspace: (request, signal) => reconcile(request, signal, true), automatic, inspect };
}
