import { commandPriority, terminal } from './contracts.mjs';
import type { CommandReceipt, CommitBatch, EffectIntent, Lease, NativeEvent, RunCommand, RunConfiguration, RunScope, RunScanHead, RunSnapshot, RunStore, StoredRun } from './contracts.mjs';
import { canonical, copy, invariant, runKey, scopeKey } from './values.mjs';
import { outstandingChildCalls, validateChildBudgetTransition } from './child-budget.mjs';
import { transcriptExtends } from './context-view.mjs';
import { isCommandObservationBatch } from './background-runtime.mjs';
import { isChildReadyBatch } from './child-runtime.mjs';
import { validateChildControlDelivery } from './child-control.mjs';
import { guidanceRunnable } from './guidance.mjs';
import { isContextSourceRefreshBatch } from './context-source-refresh.mjs';
import { isOutputRestartBatch } from './output-recovery.mjs';
import { isWallBudgetStopBatch } from './deadline-delivery.mjs';
import { reviewableBackgroundInterruption } from './background-interruption.mjs';
import type { BackgroundInterruptionReview } from './background-interruption.mjs';

/** The backend must serialize read/modify/write atomically, including failures. */
export interface LedgerBackend {
  /** Optional compact, deterministic identity for a canonical commit batch. */
  commitFingerprint?(canonicalBatch: string): string;
  /** Atomic metadata-only updates avoid materializing the history for heartbeats. */
  updateLease?<T>(key: string, change: (current: Pick<StoredRun, 'lease' | 'fence'> | null) => {
    record: Pick<StoredRun, 'lease' | 'fence'>; value: T;
  }): T;
  /** Read a bounded event suffix without loading unrelated receipts or commits. */
  eventsAfter?(key: string, after: number): NativeEvent[] | null;
  commands?(key: string): StoredRun['commands'] | null;
  get(key: string): StoredRun | null;
  values(): StoredRun[];
  snapshots?(scope: RunScope, sessionId?: string): RunSnapshot[];
  heads?(scope: RunScope, sessionId?: string): RunScanHead[];
  sessionHead(scope: RunScope, sessionId: string): RunSnapshot | null;
  update<T>(key: string, change: (current: StoredRun | null,
    sessionHead: LedgerBackend['sessionHead']) => { record: StoredRun; value: T }): T;
  updatePair<T>(keys: [string, string], change: (records: [StoredRun | null, StoredRun | null]) => {
    records: [StoredRun, StoredRun]; value: T;
  }): T;
}
function found<T>(record: T | null): T {
  invariant(record, 'run_not_found');
  return record;
}
function fenced(record: Pick<StoredRun, 'lease'>, lease: Lease, now: number): void {
  invariant(Number.isFinite(now) && now >= 0, 'invalid_clock');
  invariant(record.lease && record.lease.owner === lease.owner && record.lease.fence === lease.fence
    && record.lease.expiresAt > now, 'stale_fence');
}
function unique<T>(items: T[], key: (item: T) => string): void {
  invariant(new Set(items.map(key)).size === items.length, 'duplicate_batch_key');
}
function immutableIdentity(previous: RunSnapshot, next: RunSnapshot): void {
  invariant(canonical(previous.conversationBranch ?? null) === canonical(next.conversationBranch ?? null), 'run_identity_changed');
  invariant(canonical(previous.backgroundNotification ?? null) === canonical(next.backgroundNotification ?? null), 'run_identity_changed');
  for (const field of ['schemaVersion', 'scope', 'runId', 'sessionId', 'turnId', 'buildId', 'parentRunId', 'taskChainId', 'configDigest'] as const) {
    invariant(canonical(previous[field]) === canonical(next[field]), 'run_identity_changed');
  }
}
export function pendingCommands(record: Pick<StoredRun, 'commands'>): RunCommand[] {
  return record.commands.filter(row => !row.consumed).map(row => copy(row.command))
    .sort((a, b) => commandPriority[b.kind] - commandPriority[a.kind]);
}
export function runnableCommands(record: StoredRun): RunCommand[] {
  return pendingCommands(record).filter(command => guidanceRunnable(record.snapshot, command, record.configuration));
}

/** Shared invariants for memory, SQLite, and other transactional backends. */
export class TransactionalRunStore implements RunStore {
  constructor(private readonly backend: LedgerBackend) {}

  private updateLease<T>(key: string, change: (current: Pick<StoredRun, 'lease' | 'fence'> | null) => {
    record: Pick<StoredRun, 'lease' | 'fence'>; value: T;
  }): T {
    if (this.backend.updateLease) return this.backend.updateLease(key, change);
    return this.backend.update(key, current => {
      const { record, value } = change(current);
      return { record: { ...found(current), ...record }, value };
    });
  }

  create(configuration: RunConfiguration, snapshot: RunSnapshot): RunSnapshot {
    return this.createWithStatus(configuration, snapshot).snapshot;
  }
  createNotification(configuration: RunConfiguration, snapshot: RunSnapshot): { snapshot: RunSnapshot; created: boolean } {
    invariant(snapshot.backgroundNotification?.contract === 'agentkit.background-notification-admission/v1', 'invalid_notification_admission');
    return this.createWithStatus(configuration, snapshot);
  }
  private createWithStatus(configuration: RunConfiguration, snapshot: RunSnapshot): { snapshot: RunSnapshot; created: boolean } {
    return this.backend.update<{ snapshot: RunSnapshot; created: boolean }>(runKey(snapshot.scope, snapshot.runId), (current, sessionHead) => {
      const config = copy(configuration), initial = copy(snapshot);
      if (current) {
        invariant(canonical(current.configuration) === canonical(config)
          && canonical(current.snapshot.backgroundNotification ?? null) === canonical(initial.backgroundNotification ?? null)
          && current.snapshot.configDigest === initial.configDigest
          && current.snapshot.sessionId === initial.sessionId && current.snapshot.turnId === initial.turnId
          && current.snapshot.buildId === initial.buildId && current.snapshot.parentRunId === initial.parentRunId
          && current.snapshot.taskChainId === initial.taskChainId
          && current.configuration.contract.objective === initial.goal, 'run_creation_conflict');
        return { record: current, value: { snapshot: copy(current.snapshot), created: false } };
      }
      invariant(initial.revision === 0 && initial.eventSeq === 0 && initial.phase === 'created'
        && initial.pendingIntent === null, 'invalid_initial_snapshot');
      const parent = sessionHead(initial.scope, initial.sessionId);
      invariant((parent?.runId ?? null) === initial.parentRunId, 'session_head_conflict');
      invariant(!parent || terminal(parent.phase), 'session_already_active');
      const rewind = config.conversationRewind;
      invariant(rewind ? config.conversationSeed && parent && rewind.expectedHeadRunId === parent.runId
        && rewind.generation > (parent.conversationBranch?.generation ?? 0)
        && canonical(initial.conversationBranch) === canonical({ commandId: rewind.commandId, generation: rewind.generation })
        : canonical(initial.conversationBranch ?? null) === canonical(parent?.conversationBranch ?? null), 'conversation_rewind_head_conflict');
      if (rewind) invariant((rewind.retainedBackgroundCommands ?? []).every(row => parent?.backgroundCommands.some(original => canonical(original) === canonical(row)))
        && canonical(initial.backgroundCommands) === canonical(rewind.retainedBackgroundCommands ?? []), 'conversation_rewind_command_not_owned');
      return { record: { configuration: config, snapshot: initial, lease: null, fence: 0,
        events: [], intents: [], receipts: [], commands: [], commits: [], projections: {} }, value: { snapshot: copy(initial), created: true } };
    });
  }
  load(scope: RunScope, runId: string): StoredRun { return copy(found(this.backend.get(runKey(scope, runId)))); }
  pendingCommands(scope: RunScope, runId: string): RunCommand[] {
    if (!this.backend.commands) return pendingCommands(this.load(scope, runId));
    const commands = found(this.backend.commands(runKey(scope, runId)));
    return pendingCommands({ commands });
  }
  sessionHead(scope: RunScope, sessionId: string): RunSnapshot | null {
    scopeKey(scope); invariant(sessionId.trim(), 'invalid_session_id');
    return copy(this.backend.sessionHead(scope, sessionId));
  }
  list(scope: RunScope, sessionId?: string): RunSnapshot[] {
    const key = scopeKey(scope);
    const snapshots = this.backend.snapshots?.(scope, sessionId) ?? this.backend.values().map(record => record.snapshot);
    return snapshots.filter(snapshot => scopeKey(snapshot.scope) === key
      && (sessionId === undefined || snapshot.sessionId === sessionId)).map(snapshot => copy(snapshot));
  }
  listHeads(scope: RunScope, sessionId?: string): RunScanHead[] {
    const key = scopeKey(scope);
    const heads = this.backend.heads?.(scope, sessionId) ?? this.backend.values().map(record => ({
      scope: record.snapshot.scope, runId: record.snapshot.runId, sessionId: record.snapshot.sessionId,
      phase: record.snapshot.phase, revision: record.snapshot.revision, eventSeq: record.snapshot.eventSeq,
      backgroundCommands: record.snapshot.backgroundCommands, lease: record.lease,
    }));
    return heads.filter(head => scopeKey(head.scope) === key
      && (sessionId === undefined || head.sessionId === sessionId)).map(head => copy(head));
  }
  acquire(scope: RunScope, runId: string, owner: string, now: number, ttlMs: number): Lease {
    invariant(owner.trim() && Number.isFinite(now) && now >= 0 && Number.isFinite(ttlMs) && ttlMs > 0, 'invalid_lease');
    return this.updateLease(runKey(scope, runId), current => {
      const record = found(current);
      invariant(!record.lease || record.lease.expiresAt <= now, 'lease_busy');
      const lease = { owner, fence: record.fence + 1, expiresAt: now + ttlMs };
      invariant(Number.isFinite(lease.expiresAt), 'invalid_lease');
      return { record: { ...record, lease, fence: lease.fence }, value: copy(lease) };
    });
  }
  renew(scope: RunScope, runId: string, lease: Lease, now: number, ttlMs: number): Lease {
    invariant(Number.isFinite(ttlMs) && ttlMs > 0 && Number.isFinite(now + ttlMs), 'invalid_lease');
    return this.updateLease(runKey(scope, runId), current => {
      const record = found(current); fenced(record, lease, now);
      const next = { ...lease, expiresAt: Math.max(record.lease!.expiresAt, now + ttlMs) };
      return { record: { ...record, lease: next }, value: copy(next) };
    });
  }
  release(scope: RunScope, runId: string, lease: Lease): void {
    this.updateLease(runKey(scope, runId), current => {
      const record = found(current);
      invariant(record.lease?.owner === lease.owner && record.lease.fence === lease.fence, 'stale_fence');
      return { record: { ...record, lease: null }, value: undefined };
    });
  }
  commit(scope: RunScope, runId: string, lease: Lease, now: number, expectedRevision: number, input: CommitBatch): RunSnapshot {
    const batch = copy(input), canonicalBatch = canonical(batch);
    const fingerprint = this.backend.commitFingerprint?.(canonicalBatch) ?? canonicalBatch;
    const apply = (current: StoredRun | null) => {
      const record = found(current); fenced(record, lease, now);
      const duplicate = record.commits.find(item => item.commitId === batch.commitId);
      if (duplicate) {
        // Legacy backends stored the entire canonical batch. Continue to
        // recognize those records when a backend adopts compact identities.
        invariant(duplicate.fingerprint === fingerprint || duplicate.fingerprint === canonicalBatch, 'commit_replay_conflict');
        return { record, value: copy(record.snapshot) };
      }
      const previous = record.snapshot, next = batch.snapshot;
      invariant(!terminal(previous.phase), 'terminal_immutable');
      invariant(previous.revision === expectedRevision && next.revision === expectedRevision + 1, 'revision_conflict');
      immutableIdentity(previous, next);
      invariant(transcriptExtends(previous.messages, next.messages) || isOutputRestartBatch(record, batch), 'transcript_is_append_only');
      for (const key of ['inputTokens', 'outputTokens', 'modelCalls', 'toolCalls', 'cost'] as const) {
        invariant(Number.isFinite(next.usage[key]) && next.usage[key] >= previous.usage[key]
          && Number.isFinite(next.descendantUsage[key]) && next.descendantUsage[key] >= previous.descendantUsage[key], 'usage_cannot_decrease');
      }
      for (const group of ['usage', 'descendantUsage'] as const) for (const key of ['cachedInputTokens', 'cacheWriteInputTokens', 'reasoningTokens'] as const) {
        if (next[group][key] === undefined && previous[group][key] === undefined) continue;
        const current = next[group][key] ?? 0, before = previous[group][key] ?? 0;
        invariant(Number.isSafeInteger(current) && current >= before, 'usage_cannot_decrease');
      }
      invariant(Number.isFinite(next.activeElapsedMs) && next.activeElapsedMs >= previous.activeElapsedMs, 'execution_clock_cannot_decrease');
      validateChildBudgetTransition(previous, next);
      const addedPromotions = (next.promotedChildRunIds ?? []).slice((previous.promotedChildRunIds ?? []).length);
      const promotionEvents = batch.events.filter(event => event.kind === 'child.promoted');
      if (addedPromotions.length || promotionEvents.length) {
        const command = record.commands.find(row => !row.consumed && row.command.commandId === batch.consumedCommandId)?.command;
        invariant(addedPromotions.length === 1 && promotionEvents.length === 1
          && record.configuration.childPromotionPolicy === 'owned-child-promotion/v1'
          && command?.kind === 'promote_child' && command.payload.childRunId === addedPromotions[0]
          && promotionEvents[0]!.payload.childRunId === addedPromotions[0]
          && promotionEvents[0]!.payload.commandId === command.commandId, 'child_promotion_requires_command');
      }
      invariant(Number.isSafeInteger(next.recoveryRetriesUsed) && next.recoveryRetriesUsed >= previous.recoveryRetriesUsed,
        'recovery_retries_cannot_decrease');
      invariant(batch.commitId.trim(), 'invalid_commit_id');
      unique(batch.events, event => event.eventId);
      unique(batch.intents, intent => intent.operationKey);
      unique(batch.receipts, receipt => receipt.operationKey);
      for (const [index, event] of batch.events.entries()) {
        invariant(event.seq === previous.eventSeq + index + 1 && event.runId === runId
          && event.turnId === previous.turnId && event.eventId === `${runKey(scope, runId)}:event:${event.seq}`
          && !record.events.some(old => old.eventId === event.eventId), 'invalid_event_sequence');
      }
      invariant(next.eventSeq === previous.eventSeq + batch.events.length, 'invalid_event_sequence');
      for (const intent of batch.intents) {
        invariant(intent.status === 'prepared' && intent.operationKey.trim()
          && !record.intents.some(item => item.operationKey === intent.operationKey), 'intent_immutable');
      }
      for (const receipt of batch.receipts) {
        const intent = record.intents.find(item => item.operationKey === receipt.operationKey);
        const command = record.commands.find(row => !row.consumed && row.command.commandId === batch.consumedCommandId)?.command;
        const steeringRetired = command && ['guide', 'steer'].includes(command.kind)
          && typeof command.payload.text === 'string' && command.payload.text.trim()
          && receipt.result.commandId === command.commandId && receipt.result.code === 'superseded_before_dispatch'
          && receipt.result.executed === false;
        const browserRetired = receipt.result.code === 'browser_session_unavailable' && receipt.result.executed === false
          && next.phase === 'finalizing' && next.reason === 'browser_session_unavailable' && next.outcome === 'unverified'
          && next.candidate === null && next.lastBrowserObservation === null
          && (previous.browserSessionRefs?.length || previous.lastBrowserObservation)
          && batch.events.some(event => event.kind === 'browser.recovered' && ['lost', 'restarted'].includes(String(event.payload.status)))
          && batch.requireNoPendingCommands;
        const backgroundRetired = intent?.kind === 'model' && receipt.result.code === 'superseded_by_background_observation'
          && receipt.result.executed === false && isCommandObservationBatch(previous, record.configuration, batch, intent);
        const childRetired = intent?.kind === 'model' && receipt.result.code === 'superseded_by_child_observation'
          && receipt.result.executed === false && isChildReadyBatch(previous, record.configuration, batch, intent);
        const childCancelRetired = command && ['cancel', 'policy_revoked'].includes(command.kind)
          && record.configuration.childLifecyclePolicy === 'owned-background/v2'
          && (previous.childBudgetReservations ?? []).some(item => item.settledUsageDigest === null)
          && next.phase === 'finalizing' && next.childTerminalPhase === (command.kind === 'cancel' ? 'canceled' : 'failed')
          && receipt.result.commandId === command.commandId && receipt.result.code === 'superseded_before_dispatch'
          && receipt.result.executed === false;
        const sourceRefreshed = intent?.kind === 'model' && receipt.result.code === 'context_source_refresh_required'
          && isContextSourceRefreshBatch(previous, record.configuration, intent, lease.fence, batch);
        const deadlineRetired = intent && receipt.result.reason === 'wall_time_hard_limit' && receipt.result.executed === false
          && isWallBudgetStopBatch(previous, record.configuration, intent, batch);
        const undispatched = receipt.status === 'not_dispatched' && intent?.status === 'prepared'
          && previous.pendingIntent === receipt.operationKey && next.pendingIntent === null
          && (steeringRetired || browserRetired || backgroundRetired || childRetired || childCancelRetired || sourceRefreshed || deadlineRetired);
        invariant((receipt.status === 'not_dispatched' ? undispatched : intent?.status === 'running')
          && !record.receipts.some(item => item.operationKey === receipt.operationKey), 'receipt_without_claim');
      }
      const unsettled = [...record.intents, ...batch.intents].filter(intent =>
        ![...record.receipts, ...batch.receipts].some(receipt => receipt.operationKey === intent.operationKey));
      invariant(next.pendingIntent === null || unsettled.some(intent => intent.operationKey === next.pendingIntent), 'pending_intent_missing');
      if (!terminal(next.phase)) invariant(unsettled.length <= 1 && (unsettled[0]?.operationKey ?? null) === next.pendingIntent, 'orphaned_effect');
      if (batch.consumedCommandId !== null) invariant(record.commands.some(row =>
        !row.consumed && row.command.commandId === batch.consumedCommandId), 'command_not_pending');
      if (batch.requireNoPendingCommands) invariant(!runnableCommands(record).some(command =>
        command.commandId !== batch.consumedCommandId), 'pending_command_conflict');
      const commands = record.commands.map(row => ({ ...row,
        consumed: row.consumed || terminal(next.phase) || row.command.commandId === batch.consumedCommandId }));
      // Read accepted inbox entries under the same write lock as cancellation.
      // Validate/idempotently fingerprint the original request, then derive the
      // terminal settlement facts; an enqueue in another process cannot vanish.
      const discarded = terminal(next.phase) && batch.consumedCommandId !== null
        && record.configuration.guidancePolicy === 'boundary-guide/v1'
        ? pendingCommands(record).filter(command => command.commandId !== batch.consumedCommandId).map(command => ({
          kind: 'command.discarded', payload: { commandId: command.commandId, kind: command.kind, status: 'discarded',
            reason: 'run_terminal', terminalReason: next.reason, terminatingCommandId: batch.consumedCommandId },
        })) : [];
      const terminalIndex = batch.events.findIndex(event => event.kind === 'run.terminal');
      const entries = [...batch.events];
      if (discarded.length) entries.splice(terminalIndex < 0 ? entries.length : terminalIndex, 0,
        ...discarded.map(fact => ({ ...fact, eventId: '', runId, turnId: next.turnId, seq: 0 })));
      const events = discarded.length ? entries.map((event, index) => ({ ...event,
        seq: previous.eventSeq + index + 1, eventId: `${runKey(scope, runId)}:event:${previous.eventSeq + index + 1}` })) : entries;
      const finalSnapshot = discarded.length ? { ...next, eventSeq: previous.eventSeq + events.length } : next;
      const updated = { ...record, snapshot: finalSnapshot, commands,
        events: [...record.events, ...events], intents: [...record.intents, ...batch.intents],
        receipts: [...record.receipts, ...batch.receipts], commits: [...record.commits, { commitId: batch.commitId, fingerprint }] };
      return { record: updated, value: copy(finalSnapshot) };
    };
    const delivery = batch.childControlDelivery;
    if (!delivery) return this.backend.update(runKey(scope, runId), apply);
    const target = delivery.target;
    const keys: [string, string] = [runKey(scope, runId), runKey(target.scope, target.runId)];
    invariant(keys[0] !== keys[1], 'child_control_origin_changed');
    return this.backend.updatePair(keys, ([current, child]) => {
      const parent = found(current), childRecord = found(child), updated = apply(parent);
      const previous = childRecord.commands.find(row => row.command.commandId === delivery.command.commandId);
      if (parent.commits.some(item => item.commitId === batch.commitId)) {
        invariant(previous && canonical(previous.command) === canonical(delivery.command), 'child_control_delivery_missing');
        return { records: [updated.record, childRecord], value: updated.value };
      }
      const command = parent.commands.find(row => !row.consumed && row.command.commandId === batch.consumedCommandId)?.command;
      invariant(command, 'child_control_command_missing');
      validateChildControlDelivery(parent, childRecord, command, delivery);
      invariant(batch.events.some(event => event.kind === (command.kind === 'message_child' ? 'child.input_queued' : 'child.cancel_requested')
        && event.payload.commandId === command.commandId && event.payload.childRunId === target.runId), 'child_control_event_missing');
      invariant(!previous || canonical(previous.command) === canonical(delivery.command), 'command_replay_conflict');
      return { records: [updated.record, previous ? childRecord : { ...childRecord,
        commands: [...childRecord.commands, { command: copy(delivery.command), consumed: false }] }], value: updated.value };
    });
  }
  claim(scope: RunScope, runId: string, lease: Lease, now: number, operationKey: string): EffectIntent {
    return this.backend.update(runKey(scope, runId), current => {
      const record = found(current); fenced(record, lease, now);
      invariant(!terminal(record.snapshot.phase) && record.snapshot.phase !== 'paused', 'run_not_dispatchable');
      const intent = record.intents.find(item => item.operationKey === operationKey);
      invariant(intent?.status === 'prepared' && record.snapshot.pendingIntent === operationKey
        && !record.receipts.some(receipt => receipt.operationKey === operationKey), 'effect_already_claimed');
      invariant(runnableCommands(record).length === 0, 'pending_command_conflict');
      const running = { ...intent, status: 'running' as const, claimedAtMs: now, claimedFence: lease.fence };
      // A prepared request reserves execution order, not provider usage. Charge
      // its attempt atomically with the claim, including claims lost in a crash.
      const snapshot = intent.kind === 'model' ? { ...record.snapshot, usage: {
        ...record.snapshot.usage, modelCalls: record.snapshot.usage.modelCalls + 1,
      } } : record.snapshot;
      invariant(Number.isSafeInteger(snapshot.usage.modelCalls), 'usage_overflow');
      if (intent.kind === 'model') invariant(record.configuration.limits.maxModelCalls === null
        || snapshot.usage.modelCalls + snapshot.descendantUsage.modelCalls + outstandingChildCalls(snapshot, 'model') <= record.configuration.limits.maxModelCalls, 'model_budget_exhausted');
      return { record: { ...record, snapshot, intents: record.intents.map(item => item === intent ? running : item) }, value: copy(running) };
    });
  }
  enqueue(scope: RunScope, runId: string, input: RunCommand): CommandReceipt {
    const command = copy(input);
    invariant(command.commandId.trim() && Object.hasOwn(commandPriority, command.kind), 'invalid_command');
    return this.backend.update<CommandReceipt>(runKey(scope, runId), current => {
      const record = found(current), existing = record.commands.find(row => row.command.commandId === command.commandId);
      if (existing) {
        invariant(canonical(existing.command) === canonical(command), 'command_replay_conflict');
        return { record, value: { commandId: command.commandId, status: 'duplicate' as const, reason: null } };
      }
      if (terminal(record.snapshot.phase)) return { record, value: { commandId: command.commandId, status: 'rejected' as const, reason: 'run_terminal' } };
      return { record: { ...record, commands: [...record.commands, { command, consumed: false }] },
        value: { commandId: command.commandId, status: 'accepted' as const, reason: null } };
    });
  }
  events(scope: RunScope, runId: string, after = 0) {
    invariant(Number.isSafeInteger(after) && after >= 0, 'invalid_event_cursor');
    if (this.backend.eventsAfter) return copy(found(this.backend.eventsAfter(runKey(scope, runId), after)));
    return this.load(scope, runId).events.filter(event => event.seq > after);
  }
  acknowledge(scope: RunScope, runId: string, projection: string, through: number): void {
    this.backend.update(runKey(scope, runId), current => {
      const record = found(current);
      invariant(projection.trim() && Number.isSafeInteger(through) && through >= (record.projections[projection] ?? 0)
        && through <= record.snapshot.eventSeq, 'invalid_projection_cursor');
      return { record: { ...record, projections: { ...record.projections, [projection]: through } }, value: undefined };
    });
  }
  reviewBackgroundInterruption(scope: RunScope, runId: string, review: BackgroundInterruptionReview, now: number): void {
    invariant(review?.contract === 'agentkit.background-interruption-review/v1'
      && Object.keys(review).sort().join(',') === 'commandId,confirmedStopped,contract,eventSeq'
      && typeof review.commandId === 'string' && !!review.commandId.trim() && review.commandId.length <= 256
      && Number.isSafeInteger(review.eventSeq) && review.eventSeq >= 0 && review.confirmedStopped === true
      && Number.isFinite(now) && now >= 0, 'invalid_background_interruption_review');
    this.backend.update(runKey(scope, runId), (current, head) => {
      const record = found(current);
      if (record.backgroundInterruptionReview) {
        invariant(canonical(record.backgroundInterruptionReview) === canonical(review), 'command_replay_conflict');
        return { record, value: undefined };
      }
      invariant(head(scope, record.snapshot.sessionId)?.runId === runId
        && record.snapshot.eventSeq === review.eventSeq, 'background_interruption_review_changed');
      invariant(!record.lease || record.lease.expiresAt <= now, 'background_interruption_still_owned');
      invariant(reviewableBackgroundInterruption(record), 'background_interruption_not_reviewable');
      return { record: { ...record, backgroundInterruptionReview: copy(review) }, value: undefined };
    });
  }
}

export class MemoryRunStore extends TransactionalRunStore {
  constructor() {
    const records = new Map<string, StoredRun>();
    const sessionHead: LedgerBackend['sessionHead'] = (scope, sessionId) => {
      const key = scopeKey(scope);
      const matches = [...records.values()].filter(record => scopeKey(record.snapshot.scope) === key
        && record.snapshot.sessionId === sessionId);
      return copy(matches.at(-1)?.snapshot ?? null);
    };
    super({
      get: key => copy(records.get(key) ?? null),
      values: () => copy([...records.values()]),
      sessionHead,
      update: (key, change) => {
        const result = change(copy(records.get(key) ?? null), sessionHead);
        records.set(key, copy(result.record));
        return result.value;
      },
      updatePair: (keys, change) => {
        const result = change([copy(records.get(keys[0]) ?? null), copy(records.get(keys[1]) ?? null)]);
        const next = result.records.map(record => copy(record));
        records.set(keys[0], next[0]!); records.set(keys[1], next[1]!);
        return result.value;
      },
    });
  }
}
