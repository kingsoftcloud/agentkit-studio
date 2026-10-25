import type { CommitBatch, EffectIntent, RunConfiguration, RunSnapshot } from './contracts.mjs';
import { canonical } from './values.mjs';
import { transition } from './transitions.mjs';

/** Only an unclaimed task model may be retired for an uncached data refresh.
 * A claimed effect must go through its existing recovery classification first.
 */
export function refreshContextSources(snapshot: RunSnapshot, config: RunConfiguration,
  pending: EffectIntent | null, executionFence: number): CommitBatch | null {
  if (!config.contextSources.length || !snapshot.preparedContext || snapshot.preparedContext.sourceFence === executionFence
    || !(!pending && snapshot.phase === 'preparing_context' || pending?.kind === 'model' && pending.status === 'prepared'
      && pending.operationKey === snapshot.pendingIntent && pending.payload.purpose !== 'compaction')) return null;
  return transition(snapshot, { phase: 'preparing_context', pendingIntent: null, preparedContext: null,
    context: { ...snapshot.context, preparedCursor: null } },
  [{ kind: 'context.sources_invalidated', payload: { reason: 'new_execution_fence', executionFence } }],
  { receipts: pending ? [{ operationKey: pending.operationKey, status: 'not_dispatched',
    result: { code: 'context_source_refresh_required', executed: false } }] : [] });
}

export function isContextSourceRefreshBatch(snapshot: RunSnapshot, config: RunConfiguration, pending: EffectIntent,
  executionFence: number, batch: CommitBatch): boolean {
  const expected = refreshContextSources(snapshot, config, pending, executionFence);
  // Store separately checks the clock cannot decrease; all refresh authority,
  // events and receipt fields must still equal the original pure transition.
  return expected !== null && canonical({ ...expected, snapshot: { ...expected.snapshot,
    activeElapsedMs: batch.snapshot.activeElapsedMs } }) === canonical(batch);
}
