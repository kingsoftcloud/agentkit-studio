import { createHash } from 'node:crypto';
import { canonical, invariant } from '@kingsoftcloud/agentkit-harness-core';
import { toolContext } from '@kingsoftcloud/agentkit-harness-core/tool-context';

const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
export const nativeDeliveryId = (scope, runId, key) => `ak-native-${hash({ identity: hash({ scope, runId }), key })}`;

/** Terminal delivery can close a call whose result never entered the transcript.
 * Keep the same committed observation for delivery and later conversation cuts. */
export function nativeDeliveryClosure(record, callId) {
  const intent = record.intents.find(item => item.kind === 'tool' && item.payload.calls?.some(call => call.callId === callId));
  const receipt = intent && record.receipts.find(item => item.operationKey === intent.operationKey);
  const index = intent?.payload.calls.findIndex(call => call.callId === callId);
  const observed = receipt?.status === 'committed' && index >= 0 ? receipt.result.results?.[index] : null;
  if (observed) return { context: observed.context === undefined ? { content: canonical(observed.content) } : toolContext(observed.context),
    isError: observed.status !== 'ok' };
  const unknown = intent?.status === 'running' && (!receipt || receipt.status === 'uncertain');
  return { context: { content: canonical({ status: unknown ? 'uncertain' : 'not_dispatched',
    reason: unknown ? 'effect_outcome_unknown' : record.snapshot.reason ?? 'run_ended' }) }, isError: true };
}

/** Rebuild the original immutable message positions before replaying output
 * retirements. Both delivery and conversation cuts must use the same timeline. */
export function nativeDeliveryTimeline(record) {
  const messages = structuredClone(record.snapshot.messages), retirements = new Map();
  for (const event of record.events.filter(event => event.seq <= record.snapshot.eventSeq).toReversed()) {
    if (event.kind !== 'output.restarted') continue;
    const { retainedMessageCount: retained, retiredMessages: retired, notice } = event.payload;
    invariant(Number.isSafeInteger(retained) && retained >= 0 && retained < messages.length && Array.isArray(retired)
      && retired.every(message => message && ['user', 'assistant'].includes(message.role)
        && typeof message.content === 'string' && ['continuation_fragment', 'continuation_observation'].includes(message.kind)
        && Object.keys(message).every(key => ['role', 'kind', 'content'].includes(key)))
      && canonical({ role: messages[retained].role, kind: messages[retained].kind ?? null, content: messages[retained].content })
        === canonical(notice), 'native_delivery_output_restart_invalid');
    retirements.set(event.seq, { retained, retired, notice: structuredClone(messages[retained]) });
    messages.splice(retained, 1, ...structuredClone(retired));
  }
  return { messages, retirements };
}
