import { terminal } from '@kingsoftcloud/agentkit-harness-core';

/** Content-free presentation evidence. Never a permission, retry or execution input. */
export const NATIVE_TOOL_OBSERVATION = 'agentkit.native-tool-observation/v1';
export function advanceNativeToolObservation(previous, { intents = [], receipts = [], events = [] }) {
  const calls = new Map((previous?.calls ?? []).map(call => [call.callId, { ...call }]));
  const byKey = new Map(intents.map(intent => [intent.operationKey, intent]));
  for (const intent of intents) {
    if (intent.kind !== 'tool') continue;
    for (const [index, call] of (intent.payload.calls ?? []).entries()) {
      const old = calls.get(call.callId), same = old?.operationKey === intent.operationKey;
      calls.set(call.callId, same ? { ...old, claimed: intent.status === 'running' ? true : old.claimed }
        : { callId: call.callId, operationKey: intent.operationKey, index,
          claimed: intent.status === 'running' ? true : intent.status === 'prepared' ? false : null,
          preparedSeq: 0, receiptStatus: null, resultStatus: null, eventStatus: null, reconciledStatus: null,
          notDispatched: old?.notDispatched === true });
    }
  }
  const byOperation = new Map();
  for (const call of calls.values()) {
    if (!byOperation.has(call.operationKey)) byOperation.set(call.operationKey, []);
    byOperation.get(call.operationKey).push(call);
  }
  for (const receipt of receipts) {
    const intent = byKey.get(receipt.operationKey);
    if (intent?.kind === 'tool_receipt' && receipt.status === 'committed') {
      for (const call of byOperation.get(intent.payload.originalOperationKey) ?? [])
        if (!intent.payload.callId || call.callId === intent.payload.callId)
        call.reconciledStatus = receipt.result.result?.status ?? null;
      continue;
    }
    for (const call of byOperation.get(receipt.operationKey) ?? []) {
      call.receiptStatus = receipt.status;
      call.resultStatus = receipt.status === 'committed' ? receipt.result.results?.[call.index]?.status ?? null : null;
    }
  }
  // Locate the latest attempt before folding completion events. A result from
  // an earlier attempt cannot erase a later claimed effect with no receipt.
  for (const event of events) if (event.kind === 'effect.prepared' && event.payload.kind === 'tool')
    for (const call of byOperation.get(event.payload.operationKey) ?? []) call.preparedSeq = event.seq;
  for (const event of events) {
    const call = calls.get(event.payload.callId);
    if (event.kind === 'tool.not_dispatched') {
      if (call) call.notDispatched = true;
      else calls.set(event.payload.callId, { callId: event.payload.callId, operationKey: null, index: null,
        claimed: null, preparedSeq: 0, receiptStatus: null, resultStatus: null, eventStatus: null,
        reconciledStatus: null, notDispatched: true });
    } else if (event.kind === 'tool.completed') {
      if (call && event.seq >= call.preparedSeq) call.eventStatus = event.payload.status;
      else if (!call) calls.set(event.payload.callId, { callId: event.payload.callId, operationKey: null, index: null,
        claimed: null, preparedSeq: 0, receiptStatus: null, resultStatus: null, eventStatus: event.payload.status,
        reconciledStatus: null, notDispatched: false });
    }
  }
  return { contract: NATIVE_TOOL_OBSERVATION, calls: [...calls.values()] };
}

export function nativeObservedToolStates(observation, snapshot, { driving = false } = {}) {
  return observation.calls.flatMap(call => {
    const result = call.reconciledStatus ?? call.eventStatus ?? call.resultStatus;
    const status = call.notDispatched || call.receiptStatus === 'not_dispatched' ? 'not_dispatched'
      : { ok: 'completed', error: 'failed', uncertain: 'uncertain' }[result]
      // A durable preflight refusal is not an effect. It can remain waiting
      // only while the Run is open. A later attempt replaces this evidence.
      ?? (result === 'approval_required' ? terminal(snapshot.phase) ? 'not_dispatched' : 'waiting'
        : call.receiptStatus === 'uncertain' ? 'uncertain'
          : terminal(snapshot.phase) && !call.receiptStatus && call.claimed !== null
            ? call.claimed ? 'uncertain' : 'not_dispatched'
            : driving && !call.receiptStatus && snapshot.pendingIntent === call.operationKey
              && snapshot.phase === 'executing_tools' ? 'running' : null);
    return status ? [{ callId: call.callId, status }] : [];
  });
}
