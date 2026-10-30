import type { StoredRun } from './contracts.mjs';
import { backgroundCommandObservation } from './background-contract.mjs';
import { canonical, invariant } from './values.mjs';

export interface BackgroundInterruptionReview {
  contract: 'agentkit.background-interruption-review/v1';
  commandId: string;
  eventSeq: number;
  confirmedStopped: true;
}

/** An operator may stop waiting for owned background results, never forgive an
 * unclaimed effect, an unknown tool write, or a live descendant. */
export function reviewableBackgroundInterruption(record: StoredRun): boolean {
  const s = record.snapshot;
  if (s.phase !== 'interrupted' || s.reason !== 'effect_outcome_unknown' || s.pendingIntent
    || s.toolReconciliation || s.children.some(child => !['completed', 'failed', 'canceled'].includes(child.state))
    || s.childBudgetReservations.some(row => row.settledUsageDigest === null)
    || !s.backgroundCommands.length || s.backgroundCommands.some(row => !row.notified)
    || record.commands.some(row => !row.consumed)) return false;
  if (record.intents.some(intent => intent.status === 'running'
    && !record.receipts.some(receipt => receipt.operationKey === intent.operationKey))
    || record.receipts.some(receipt => Array.isArray(receipt.result.results) && receipt.result.results.some(result => result
        && typeof result === 'object' && !Array.isArray(result) && result.status === 'uncertain')
      || receipt.status === 'uncertain' && record.intents.find(intent => intent.operationKey === receipt.operationKey)?.kind !== 'model')) return false;
  try {
    const observations = new Map(s.messages.filter(message => message.kind === 'background_command_observation')
      .flatMap(message => {
        const value = JSON.parse(message.content) as { commands: unknown[] };
        invariant(Array.isArray(value.commands), 'invalid_background_review_observation');
        return value.commands.map(input => { const observation = backgroundCommandObservation(input); return [observation.ref.taskId, observation] as const; });
      }));
    const unknown = [...observations.values()].filter(item => ['unknown', 'unavailable'].includes(item.status));
    return unknown.length > 0 && unknown.every(item => item.ref.sourceRunId === s.runId
      && s.backgroundCommands.some(row => canonical(row.ref) === canonical(item.ref))
      && record.receipts.some(receipt => receipt.operationKey === item.ref.operationKey && receipt.status === 'committed'));
  } catch { return false; }
}

export function reviewedBackgroundInterruption(record: StoredRun): boolean {
  const review = record.backgroundInterruptionReview;
  return review?.contract === 'agentkit.background-interruption-review/v1'
    && review.confirmedStopped === true && typeof review.commandId === 'string' && !!review.commandId.trim()
    && review.eventSeq === record.snapshot.eventSeq && reviewableBackgroundInterruption(record);
}
