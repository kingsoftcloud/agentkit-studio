import { canonical } from '@kingsoftcloud/agentkit-harness-core';

/** Local, read-only classification. This grants neither a receipt query nor
 * execution of the original tool. Rebinding still validates the full Host
 * capsule/configuration before the original external turn can be adopted. */
export function nativeA2aReceiptWaitSource(record) {
  const snapshot = record?.snapshot, marker = snapshot?.toolReconciliation;
  if (snapshot?.phase !== 'awaiting_reconciliation' || snapshot.pendingIntent !== null
    || marker?.contract !== 'agentkit.tool-receipt-observation/v1') return null;
  const intent = record.intents.find(item => item.operationKey === marker.operationKey);
  const call = intent?.payload.calls?.[0], definition = record.configuration.tools.find(item => item.name === call?.name);
  const receipt = record.receipts.find(item => item.operationKey === marker.operationKey);
  if (call?.name !== 'call_a2a_agent' || definition?.recoveryPolicy !== 'receipt-observation/v1'
    || intent.kind !== 'tool' || intent.status !== 'running' || intent.payload.calls.length !== 1
    || !Number.isSafeInteger(intent.claimedFence) || intent.claimedFence <= 0 || call.callId !== marker.callId
    || canonical(snapshot.pendingTools.slice(0, 1)) !== canonical([call])
    || !receipt || !(receipt.status === 'uncertain' || receipt.result.results?.[0]?.status === 'uncertain')) return null;
  return { intent, call, definition };
}
