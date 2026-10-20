import type { CommitBatch, EffectIntent, EffectKind, EffectReceipt, Message, NativeEvent, ObjectValue, Phase, RunCommand, RunSnapshot } from './contracts.mjs';
import { terminal } from './contracts.mjs';
import { canonical, copy, invariant, runKey } from './values.mjs';

export function transition(snapshot: RunSnapshot, changes: Partial<RunSnapshot>, facts: { kind: string; payload: ObjectValue }[] = [],
  options: { intents?: EffectIntent[]; receipts?: EffectReceipt[]; commandId?: string; requireNoPendingCommands?: boolean } = {}): CommitBatch {
  invariant(!terminal(snapshot.phase), 'terminal_immutable');
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
export function reduceCommand(snapshot: RunSnapshot, command: RunCommand, pending: EffectIntent | null = null): CommitBatch {
  const original = snapshot;
  const retiring = ['guide', 'steer'].includes(command.kind) && typeof command.payload.text === 'string'
    && command.payload.text.trim().length > 0 && pending?.status === 'prepared' && pending.operationKey === snapshot.pendingIntent;
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
        changes = { phase: 'executing_tools', pendingInteraction: null,
          interaction: { interactionId: pending.hostInteractionId, callId: pending.callId, decision: command.payload.decision } };
        facts.push({ kind: 'approval.resolved', payload: { interactionId: pending.interactionId, callId: pending.callId, decision: command.payload.decision } });
      }
      break;
    }
    case 'steer':
      if (typeof command.payload.text !== 'string' || !command.payload.text.trim()) reason = 'invalid_steering';
      else if (snapshot.reason === 'effect_outcome_unknown' || snapshot.reason === 'recovery_retry_exhausted') reason = 'recovery_required';
      else if (snapshot.pendingIntent !== null) reason = 'effect_in_flight';
      else {
        changes = { goal: command.payload.text, goalRevision: snapshot.goalRevision + 1, phase: 'preparing_context',
          hookState: null, stopHookContinuations: 0,
          preparedContext: null, queuedGuidance: [], finalText: '', outcome: null, reason: null,
          pendingTools: [], pendingInteraction: null, interaction: null, candidate: null, verification: null,
          messages: [...snapshot.messages, ...snapshot.pendingTools.map(call => ({ role: 'tool' as const, callId: call.callId, name: call.name,
            content: canonical({ status: 'not_dispatched', reason: 'goal_steered', executed: false }) })),
          ...snapshot.queuedGuidance, { role: 'user', content: command.payload.text, kind: 'steering', persistent: true }],
          context: { ...snapshot.context, preparedCursor: null } };
        for (const call of snapshot.pendingTools) facts.push({ kind: 'tool.not_dispatched', payload: {
          callId: call.callId, name: call.name, reason: 'goal_steered' } });
      }
      break;
    case 'guide':
      if (typeof command.payload.text !== 'string' || !command.payload.text.trim()) reason = 'invalid_guidance';
      else if (snapshot.reason === 'effect_outcome_unknown' || snapshot.reason === 'recovery_retry_exhausted') reason = 'recovery_required';
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
    default:
      reason = 'child_lifecycle_command_pending';
  }
  facts.push({ kind: 'command.applied', payload: { commandId: command.commandId, kind: command.kind, reason } });
  if (changes.phase && terminal(changes.phase)) facts.push({ kind: 'run.terminal', payload: {
    phase: changes.phase, outcome: changes.outcome ?? null, reason: changes.reason ?? null } });
  return transition(original, { ...changes, ...(retiring ? { pendingIntent: null } : {}) }, facts,
    { commandId: command.commandId, requireNoPendingCommands: false, receipts });
}
