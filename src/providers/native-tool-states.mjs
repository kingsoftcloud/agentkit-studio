import { nativeDeliveryId } from '@kingsoftcloud/agentkit-harness-node/native/delivery-timeline';

/** A control projection of canonical receipts. It carries no parameters or
 * output and does not rewrite already published Session message atoms. */
export function nativeToolStates(record, { driving = false } = {}) {
  if (!record) return null;
  const receipts = new Map(record.receipts.map(receipt => [receipt.operationKey, receipt]));
  const reconciled = new Map();
  for (const intent of record.intents) {
    if (intent.kind !== 'tool_receipt') continue;
    const receipt = receipts.get(intent.operationKey);
    if (receipt?.status === 'committed' && receipt.result.result)
      reconciled.set(intent.payload.originalOperationKey, receipt.result.result);
  }
  const calls = [];
  for (const intent of record.intents) {
    if (intent.kind !== 'tool') continue;
    const receipt = receipts.get(intent.operationKey);
    for (const [index, call] of (intent.payload.calls ?? []).entries()) {
      const result = reconciled.get(intent.operationKey)
        ?? (receipt?.status === 'committed' ? receipt.result.results?.[index] : null);
      const status = { ok: 'completed', error: 'failed', uncertain: 'uncertain', approval_required: 'waiting' }[result?.status]
        ?? (driving && !receipt && record.snapshot.pendingIntent === intent.operationKey
          && record.snapshot.phase === 'executing_tools' ? 'running' : null);
      if (status) calls.push({ callId: nativeDeliveryId(record.snapshot.scope, record.snapshot.runId, `call:${call.callId}`), status });
    }
  }
  return { contract: 'agentkit.native-tool-states/v1', runId: record.snapshot.runId, calls };
}
