import type { CommitBatch, EffectIntent, EffectKind, EffectReceipt, Message, NativeEvent, ObjectValue, Phase, RunCommand, RunSnapshot } from './contracts.mjs';
import { terminal } from './contracts.mjs';
import { canonical, copy, invariant, runKey } from './values.mjs';
import { admitSteering } from './task-contract.mjs';
import type { SteeringBindings } from './task-contract.mjs';
import { admitChildPromotion, unsettledChildren } from './child-runtime.mjs';
import { guidanceReason } from './guidance.mjs';
import { bindOperatorInput } from './anthropic-context.mjs';

export function transition(snapshot: RunSnapshot, changes: Partial<RunSnapshot>, facts: { kind: string; payload: ObjectValue }[] = [],
  options: { intents?: EffectIntent[]; receipts?: EffectReceipt[]; commandId?: string; requireNoPendingCommands?: boolean } = {}): CommitBatch {
  invariant(!terminal(snapshot.phase), 'terminal_immutable');
  const pendingGuidanceIds = changes.pendingGuidanceIds ?? snapshot.pendingGuidanceIds;
  if (terminal(changes.phase ?? snapshot.phase) && pendingGuidanceIds?.length) {
    changes = { ...changes, pendingGuidanceIds: [] };
    facts = [...facts.filter(fact => fact.kind !== 'run.terminal'), ...pendingGuidanceIds.map(inputId => ({
      kind: 'input.guidance_discarded', payload: { inputId, reason: changes.reason ?? changes.phase ?? snapshot.phase },
    })), ...facts.filter(fact => fact.kind === 'run.terminal')];
  }
  const diagnostics = changes.diagnostics ?? snapshot.diagnostics;
  facts = facts.map(fact => fact.kind === 'run.terminal' ? { ...fact, payload: { ...fact.payload,
    usageComplete: diagnostics.providerUsageIncomplete !== true && diagnostics.descendantUsageIncomplete !== true,
  } } : fact);
  const prefix = runKey(snapshot.scope, snapshot.runId);
  const events: NativeEvent[] = facts.map((fact, index) => ({ ...copy(fact),
    eventId: `${prefix}:event:${snapshot.eventSeq + index + 1}`, runId: snapshot.runId,
    turnId: snapshot.turnId, seq: snapshot.eventSeq + index + 1,
  }));
  const next = copy({ ...snapshot, ...changes, revision: snapshot.revision + 1, eventSeq: snapshot.eventSeq + events.length });
  return { commitId: `${prefix}:commit:${next.revision}`, snapshot: next, events,
    intents: options.intents ?? [], receipts: options.receipts ?? [], consumedCommandId: options.commandId ?? null,
    requireNoPendingCommands: options.requireNoPendingCommands ?? terminal(next.phase) };
}
export function prepareEffect(snapshot: RunSnapshot, kind: EffectKind, phase: Phase, payload: ObjectValue,
  changes: Partial<RunSnapshot> = {}): CommitBatch {
  invariant(snapshot.pendingIntent === null, 'effect_already_pending');
  const operationKey = `${runKey(snapshot.scope, snapshot.runId)}:effect:${snapshot.revision + 1}:${kind}`;
  return transition(snapshot, { ...changes, phase, pendingIntent: operationKey },
    [{ kind: 'effect.prepared', payload: { operationKey, kind } }],
    { intents: [{ operationKey, kind, payload: copy(payload), status: 'prepared' }] });
}
export function reduceCommand(snapshot: RunSnapshot, command: RunCommand, pending: EffectIntent | null = null,
  bindings: SteeringBindings = {}): CommitBatch {
  if (snapshot.toolReconciliation && !['cancel', 'policy_revoked', 'pause', 'resume'].includes(command.kind)) {
    return transition(snapshot, {}, [{ kind: 'command.applied', payload: { commandId: command.commandId,
      kind: command.kind, reason: 'recovery_required' } }], { commandId: command.commandId, requireNoPendingCommands: false });
  }
  const original = snapshot;
  if (command.kind === 'guide' && Object.hasOwn(command.payload, 'expectedGoalRevision')
    && (!Number.isSafeInteger(command.payload.expectedGoalRevision) || command.payload.expectedGoalRevision !== snapshot.goalRevision)) {
    return transition(snapshot, {}, [{ kind: 'command.applied', payload: { commandId: command.commandId,
      kind: command.kind, reason: 'stale_goal_revision' } }], { commandId: command.commandId, requireNoPendingCommands: false });
  }
  if (snapshot.childTerminalPhase && !['cancel', 'policy_revoked'].includes(command.kind)) {
    return transition(snapshot, {}, [{ kind: 'command.applied', payload: { commandId: command.commandId,
      kind: command.kind, reason: 'run_stopping' } }], { commandId: command.commandId, requireNoPendingCommands: false });
  }
  if (command.kind === 'guide' && bindings.configuration?.guidancePolicy === 'boundary-guide/v1') {
    const reason = guidanceReason(snapshot, command, bindings.configuration);
    const hookState = copy(snapshot.hookState);
    if (hookState) { hookState.stop = null; delete hookState.precompact; }
    return transition(snapshot, reason === 'applied' ? {
      phase: 'preparing_context', messages: [...snapshot.messages, bindOperatorInput(snapshot.messages, { role: 'user', kind: 'guidance',
        content: command.payload.text as string, inputId: command.commandId, inputGoalRevision: snapshot.goalRevision }, bindings.configuration.profile)],
      pendingGuidanceIds: [command.commandId], preparedContext: null,
      context: { ...snapshot.context, preparedCursor: null },
      contextState: snapshot.contextState ? { ...snapshot.contextState, compaction: null } : null,
      candidate: null, verification: null, verificationToolCalls: null,
      hookState, stopHookContinuations: 0, continuations: 0, retryNotBefore: 0,
      outcome: null, finalText: '', reason: null,
    } : {}, [
      ...(reason === 'applied' ? [{ kind: 'input.guidance_applied', payload: {
        inputId: command.commandId, commandId: command.commandId, goalRevision: snapshot.goalRevision, delivery: 'guide' } }] : []),
      { kind: 'command.applied', payload: { commandId: command.commandId, kind: command.kind, reason } },
    ], { commandId: command.commandId, requireNoPendingCommands: false });
  }
  if (command.kind === 'steer' && ['effect_outcome_unknown', 'recovery_retry_exhausted', 'browser_session_unavailable'].includes(snapshot.reason ?? '')) {
    return transition(snapshot, {}, [{ kind: 'command.applied', payload: { commandId: command.commandId,
      kind: command.kind, reason: 'recovery_required' } }], { commandId: command.commandId, requireNoPendingCommands: false });
  }
  const steering = command.kind === 'steer' ? admitSteering(snapshot, command, bindings) : null;
  if (steering && (steering.reason !== 'applied' || snapshot.pendingIntent !== null && pending?.status !== 'prepared')) {
    const inFlight = snapshot.pendingIntent !== null && pending?.status !== 'prepared';
    const reason = inFlight ? 'effect_in_flight' : steering.reason;
    const blocked = !inFlight && !Object.hasOwn(command.payload, 'expectedGoalRevision');
    const retire = blocked && pending?.status === 'prepared' && pending.operationKey === snapshot.pendingIntent;
    const changes: Partial<RunSnapshot> = blocked ? { phase: 'finalizing', outcome: 'blocked', reason,
      pendingIntent: null, pendingTools: [], pendingInteraction: null, interaction: null,
      candidate: null, verification: null, finalText: '', preparedContext: null,
      messages: [...snapshot.messages, ...snapshot.pendingTools.map(call => ({ role: 'tool' as const,
        callId: call.callId, name: call.name, content: canonical({ status: 'not_dispatched', reason, executed: false }) }))] } : {};
    return transition(snapshot, changes, [
      ...(retire ? [{ kind: 'effect.not_dispatched', payload: { operationKey: pending!.operationKey, kind: pending!.kind, commandId: command.commandId } }] : []),
      { kind: 'command.applied', payload: { commandId: command.commandId, kind: command.kind, reason } },
    ], { commandId: command.commandId, requireNoPendingCommands: false,
      receipts: retire ? [{ operationKey: pending!.operationKey, status: 'not_dispatched',
        result: { code: 'contract_revision_required', commandId: command.commandId, executed: false } }] : [] });
  }
  const deferredChildCancel = ['cancel', 'policy_revoked'].includes(command.kind)
    && bindings.configuration?.childLifecyclePolicy === 'owned-background/v2' && unsettledChildren(snapshot).length > 0;
  const retiring = (['guide', 'steer'].includes(command.kind) && typeof command.payload.text === 'string'
    && command.payload.text.trim().length > 0 || deferredChildCancel)
    && pending?.status === 'prepared' && pending.operationKey === snapshot.pendingIntent;
  if (retiring) snapshot = { ...snapshot, pendingIntent: null };
  let changes: Partial<RunSnapshot> = {}, reason = 'applied';
  const facts: { kind: string; payload: ObjectValue }[] = [];
  const receipts: EffectReceipt[] = retiring ? [{ operationKey: pending!.operationKey, status: 'not_dispatched',
    result: { code: 'superseded_before_dispatch', commandId: command.commandId, executed: false } }] : [];
  if (retiring) facts.push({ kind: 'effect.not_dispatched', payload: {
    operationKey: pending!.operationKey, kind: pending!.kind, commandId: command.commandId } });
  switch (command.kind) {
    case 'cancel':
    case 'policy_revoked':
      changes = { phase: command.kind === 'cancel' ? 'canceled' : 'failed',
        outcome: command.kind === 'cancel' ? 'unverified' : 'blocked',
        reason: command.kind === 'cancel' ? 'user_canceled' : 'policy_revoked', finalText: '',
        pendingIntent: null, pendingTools: [], pendingInteraction: null, interaction: null };
      if (deferredChildCancel) Object.assign(changes, { phase: 'finalizing', childLifecycleFailure: null,
        childTerminalPhase: command.kind === 'cancel' ? 'canceled' : 'failed', childApproval: null, candidate: null, verification: null });
      break;
    case 'pause':
      if (snapshot.phase === 'paused') reason = 'already_paused';
      else changes = { phase: 'paused', resumePhase: snapshot.phase };
      break;
    case 'resume':
      if (snapshot.phase !== 'paused') reason = 'not_paused';
      else changes = { phase: snapshot.resumePhase ?? 'preparing_context', resumePhase: null };
      break;
    case 'submit_interaction': {
      const pending = snapshot.pendingInteraction;
      if (snapshot.phase !== 'awaiting_interaction' || !pending || command.payload.interactionId !== pending.interactionId
        || command.payload.decision !== 'allow' && command.payload.decision !== 'deny') reason = 'interaction_mismatch';
      else {
        changes = { phase: snapshot.childApproval ? snapshot.resumePhase ?? 'preparing_context' : 'executing_tools',
          ...(snapshot.childApproval ? { resumePhase: null, childLifecycleCursor: null } : {}), pendingInteraction: null,
          interaction: pending.approvalPolicy === 'durable-preflight/v1' ? null : { interactionId: pending.hostInteractionId, callId: pending.callId, decision: command.payload.decision,
            ...(snapshot.planMode && typeof command.payload.feedback === 'string' ? { feedback: command.payload.feedback } : {}) } };
        facts.push({ kind: 'approval.resolved', payload: { interactionId: pending.interactionId, callId: pending.callId, decision: command.payload.decision } });
      }
      break;
    }
    case 'steer':
      if (typeof command.payload.text !== 'string' || !command.payload.text.trim()) reason = 'invalid_steering';
      else if (['effect_outcome_unknown', 'recovery_retry_exhausted', 'browser_session_unavailable'].includes(snapshot.reason ?? '')) reason = 'recovery_required';
      else if (snapshot.pendingIntent !== null) reason = 'effect_in_flight';
      else {
        changes = { goal: command.payload.text, goalRevision: snapshot.goalRevision + 1,
          phase: snapshot.phase === 'paused' ? 'paused' : 'preparing_context',
          resumePhase: snapshot.phase === 'paused' ? 'preparing_context' : null,
          ...(steering?.contract ? { taskContract: steering.contract, taskContractDigest: steering.contractDigest } : {}),
          lastBrowserObservation: null, unresolvedInteractionObservation: null,
          verificationToolCalls: null, checkpointWebMutationToolCall: null,
          failureFingerprint: null, failureEvidenceDigest: null,
          hookState: null, stopHookContinuations: 0,
          continuations: 0, retryNotBefore: 0, toolErrorStreak: null, workspaceRevision: null,
          ...(snapshot.toolErrorRecovery === undefined ? {} : { toolErrorRecovery: null }),
          ...(snapshot.deliveryReview === undefined ? {} : { deliveryReview: null }),
          contextState: snapshot.contextState ? { ...snapshot.contextState, compaction: null,
            ...(steering?.contract ? { history: null, compactionsWithoutProgress: 0, progressDigest: null } : {}) } : null,
          preparedContext: null, queuedGuidance: [], finalText: '', outcome: null, reason: null,
          pendingTools: [], pendingInteraction: null, interaction: null, candidate: null, verification: null,
          messages: [...snapshot.messages, ...snapshot.pendingTools.map(call => ({ role: 'tool' as const, callId: call.callId, name: call.name,
            content: canonical({ status: 'not_dispatched', reason: 'goal_steered', executed: false }) })),
          ...snapshot.queuedGuidance, ...(bindings.configuration ? [bindOperatorInput(snapshot.messages,
            { role: 'user', content: command.payload.text, kind: 'steering', persistent: true }, bindings.configuration.profile)]
            : [{ role: 'user' as const, content: command.payload.text, kind: 'steering', persistent: true }])],
          context: { ...snapshot.context, preparedCursor: null } };
        for (const call of snapshot.pendingTools) facts.push({ kind: 'tool.not_dispatched', payload: {
          callId: call.callId, name: call.name, reason: 'goal_steered' } });
      }
      break;
    case 'guide':
      if (typeof command.payload.text !== 'string' || !command.payload.text.trim()) reason = 'invalid_guidance';
      else if (['effect_outcome_unknown', 'recovery_retry_exhausted', 'browser_session_unavailable'].includes(snapshot.reason ?? '')) reason = 'recovery_required';
      else if (snapshot.pendingIntent !== null) reason = 'effect_in_flight';
      else {
        const guidance: Message = { role: 'user', content: command.payload.text, kind: 'guidance', persistent: true };
        const postHook = retiring && pending!.kind === 'hook'
          && (pending!.payload.request as ObjectValue | undefined)?.event === 'PostToolUse';
        changes = { preparedContext: null, context: { ...snapshot.context, preparedCursor: null },
          ...(retiring ? { pendingIntent: null, phase: snapshot.phase === 'paused' ? 'paused' as const
            : snapshot.pendingTools.length || postHook ? 'executing_tools' as const : snapshot.phase === 'compacting' ? 'compacting' as const : 'preparing_context' as const,
            ...(snapshot.phase === 'paused' ? { resumePhase: snapshot.pendingTools.length || postHook ? 'executing_tools' as const
              : snapshot.resumePhase === 'compacting' ? 'compacting' as const : 'preparing_context' as const } : {}) } : {}) };
        if (retiring && pending!.kind === 'tool') {
          const interaction = pending!.payload.interaction;
          if (interaction && typeof interaction === 'object' && !Array.isArray(interaction)) changes.interaction = copy(interaction);
        }
        if (snapshot.pendingTools.length) changes.queuedGuidance = [...snapshot.queuedGuidance, guidance];
        else {
          changes.messages = [...snapshot.messages, guidance];
          if (['verifying', 'finalizing'].includes(snapshot.phase) || retiring && snapshot.candidate !== null) Object.assign(changes, {
            phase: snapshot.phase === 'paused' ? 'paused' : 'preparing_context', candidate: null, verification: null, finalText: '', outcome: null, reason: null,
          });
        }
      }
      break;
    case 'promote_child': {
      const promotion = admitChildPromotion(snapshot, bindings.configuration, command, bindings.childTasks);
      changes = promotion.changes; reason = promotion.reason; facts.push(...promotion.facts);
      break;
    }
    default:
      reason = 'child_lifecycle_command_pending';
  }
  facts.push({ kind: 'command.applied', payload: { commandId: command.commandId, kind: command.kind, reason } });
  if (snapshot.pendingGuidanceIds?.length && (['cancel', 'policy_revoked'].includes(command.kind)
    || command.kind === 'steer' && reason === 'applied')) {
    changes.pendingGuidanceIds = [];
    // Deferred child cancellation can remain finalizing; settle input debt now.
    facts.push(...snapshot.pendingGuidanceIds.map(inputId => ({
      kind: 'input.guidance_discarded', payload: { inputId, reason: command.kind },
    })));
  }
  if (changes.phase && terminal(changes.phase)) facts.push({ kind: 'run.terminal', payload: {
    phase: changes.phase, outcome: changes.outcome ?? null, reason: changes.reason ?? null } });
  return transition(original, { ...changes, ...(retiring ? { pendingIntent: null } : {}) }, facts,
    { commandId: command.commandId, requireNoPendingCommands: false, receipts });
}
