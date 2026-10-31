/** Read-only discovery of an original parent collector whose children have
 * sealed receipt waits. A locator never admits execution; the owning Host must
 * still validate the root, original turn and frozen bindings before resuming. */
import { createHash } from 'node:crypto';
import { canonical, childLifecycleRequest, terminal } from '@kingsoftcloud/agentkit-harness-core';
import { loadOwnedDirectChild, hasUnsafeChildReceipt } from '@kingsoftcloud/agentkit-harness-node/native/owned-child';
import { nativeA2aReceiptWaitSource } from './native-a2a-receipt.mjs';

export const NATIVE_CHILD_A2A_WAIT = 'agentkit.native-child-a2a-wait/v1';
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');

export function nativeChildA2aWaitSource({ store, record, now = Date.now() }) {
  const snapshot = record?.snapshot, configuration = record?.configuration;
  if (!snapshot || !configuration || configuration.childOwnerBinding || configuration.childLifecyclePolicy !== 'owned-background/v2'
    || !['preparing_context', 'executing_tools', 'verifying'].includes(snapshot.phase)
    || hash(configuration) !== snapshot.configDigest
    || record.lease && record.lease.expiresAt > now) return null;
  const intent = record.intents.find(row => row.operationKey === snapshot.pendingIntent);
  if (intent?.kind !== 'child' || intent.status !== 'running' || intent.payload.action !== 'wait'
    || !Number.isSafeInteger(intent.claimedFence) || intent.claimedFence <= 0 || intent.claimedFence > record.fence) return null;
  let request;
  try { request = childLifecycleRequest(snapshot, intent, new AbortController().signal); }
  catch { return null; }
  if (request.action !== 'wait' || request.childApproval !== null || request.interaction !== null || !request.reservations.length
    || new Set(request.reservations.map(row => row.childRunId)).size !== request.reservations.length) return null;
  const waiting = [];
  for (const reservation of request.reservations) {
    const child = loadOwnedDirectChild({ store, childScopes: [reservation.childScope], parent: snapshot, childRunId: reservation.childRunId });
    if (!child || child.lease && child.lease.expiresAt > now
      || store.sessionHead(reservation.childScope, child.snapshot.sessionId)?.runId !== child.snapshot.runId) return null;
    if (terminal(child.snapshot.phase)) {
      if (child.snapshot.phase === 'interrupted' || hasUnsafeChildReceipt(child)) return null;
    } else {
      const source = nativeA2aReceiptWaitSource(child);
      if (!source) return null;
      waiting.push({ scope: child.snapshot.scope, runId: child.snapshot.runId,
        operationKey: source.intent.operationKey, callId: source.call.callId, checkpointDigest: hash(child.snapshot) });
    }
  }
  return waiting.length ? { contract: NATIVE_CHILD_A2A_WAIT, operationKey: intent.operationKey, children: waiting } : null;
}
