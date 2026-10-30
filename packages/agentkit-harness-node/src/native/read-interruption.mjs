import { safeReadRecoveryCalls } from '@kingsoftcloud/agentkit-harness-core';

/** Classify an original complete ledger, never a presentation read model. */
export function canCloseNativeReadInterruption(record) {
  if (!record || record.snapshot.phase !== 'interrupted' || record.snapshot.reason !== 'effect_outcome_unknown'
    || record.snapshot.pendingIntent || record.snapshot.toolReconciliation
    || record.snapshot.children?.length || record.snapshot.backgroundCommands?.length
    || record.snapshot.childBudgetReservations?.some(row => row.settledUsageDigest === null)) return false;
  const unknown = record.receipts.filter(receipt => receipt.status === 'uncertain'
    || receipt.result.results?.some(result => result.status === 'uncertain'));
  return unknown.length > 0 && unknown.every(receipt => {
    const intent = record.intents.find(item => item.operationKey === receipt.operationKey);
    return intent?.kind === 'tool' && safeReadRecoveryCalls(intent.payload.calls, record.configuration);
  }) && !record.intents.some(intent => ['tool', 'hook', 'child', 'input'].includes(intent.kind)
    && intent.status === 'running' && !record.receipts.some(receipt => receipt.operationKey === intent.operationKey));
}
