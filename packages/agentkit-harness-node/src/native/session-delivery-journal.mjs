import { copy, canonical, terminal, RESULT_DELIVERY_POLICY, FINAL_SUBMISSION_TOOL } from '@kingsoftcloud/agentkit-harness-core';
import { nativeDeliveryClosure } from './delivery-timeline.mjs';

// Presentation evidence only. Neither this journal nor its cursor authorizes
// execution, recovery, retries, model history or tool-result reconciliation.
export const NATIVE_DELIVERY_JOURNAL = 'agentkit.native-delivery-journal/v1';
export const DELIVERY_SNAPSHOT_FIELDS = Object.freeze(['scope', 'runId', 'sessionId', 'turnId', 'buildId',
  'parentRunId', 'taskChainId', 'configDigest', 'revision', 'eventSeq', 'phase', 'reason', 'finalText', 'messages', 'backgroundNotification']);
const eventKinds = new Set(['model.completed', 'context.summary_completed', 'completion.delivery_review_completed',
  'model.stream_interrupted', 'output.restarted', 'tool.completed', 'tool.not_dispatched', 'context.planned',
  'plan.initialized', 'plan.mode_changed', 'todo.initialized', 'todo.updated', 'effect.prepared']);
const pick = (value, fields) => Object.fromEntries(fields.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));

export function deliveryJournalHead(snapshot) {
  return { contract: NATIVE_DELIVERY_JOURNAL, ...pick(snapshot,
    ['scope', 'runId', 'sessionId', 'configDigest', 'revision', 'eventSeq']) };
}
export function matchesDeliveryJournal(head, snapshot) {
  return head?.contract === NATIVE_DELIVERY_JOURNAL && head.revision === snapshot.revision
    && head.eventSeq === snapshot.eventSeq && head.configDigest === snapshot.configDigest
    && head.runId === snapshot.runId && head.sessionId === snapshot.sessionId
    && canonical(head.scope) === canonical(snapshot.scope);
}

function deliveryEvent(event) {
  if (!eventKinds.has(event.kind) || event.kind === 'effect.prepared' && event.payload.kind !== 'input') return null;
  const fields = event.kind === 'tool.completed' ? ['callId', 'status']
    : event.kind === 'tool.not_dispatched' ? ['callId']
      : event.kind === 'context.planned' ? ['action', 'compactions']
        : event.kind === 'effect.prepared' ? ['kind', 'operationKey'] : null;
  return fields ? { ...event, payload: pick(event.payload, fields) } : event;
}

/** Full reference projection and incremental SQL append share this boundary.
 * `intents` must contain the intents referenced by the supplied receipts. */
export function sessionDeliveryEntries({ events = [], intents = [], receipts = [] }) {
  const rows = [], byKey = new Map(intents.map(intent => [intent.operationKey, intent]));
  const add = (collection, key, data) => rows.push({ collection, key: String(key), data: copy(data) });
  for (const event of events) {
    const projected = deliveryEvent(event);
    if (projected) add('events', event.seq, projected);
    if (['tool.completed', 'tool.not_dispatched'].includes(event.kind))
      add('outcomes', event.payload.callId, event.kind === 'tool.not_dispatched' ? 'not_dispatched' : event.payload.status);
  }
  for (const intent of intents) {
    if (intent.kind === 'input' && Number.isSafeInteger(intent.payload.messageCursor))
      add('inputs', intent.operationKey, intent.payload.messageCursor);
    if (intent.kind === 'tool') for (const [index, call] of (intent.payload.calls ?? []).entries())
      add('tools', call.callId, { operationKey: intent.operationKey, index });
  }
  for (const receipt of receipts) {
    const intent = byKey.get(receipt.operationKey);
    if (!intent) continue;
    if (receipt.status === 'not_dispatched' && intent.kind === 'tool')
      for (const call of intent.payload.calls ?? []) add('outcomes', call.callId, 'not_dispatched');
    if (receipt.status !== 'committed') continue;
    const pairs = intent.kind === 'tool' ? (intent.payload.calls ?? []).map((call, index) => [call.callId, receipt.result.results?.[index]])
      : ['tool_receipt', 'workspace_repair'].includes(intent.kind) ? [[intent.payload.callId, receipt.result.result]] : [];
    for (const [callId, observation] of pairs) {
      const meta = observation?.metadata?.nativeTaskDisplay;
      if (observation?.status === 'ok' && meta?.contract === 'agentkit.workspace-display/v1' && meta.display?.kind === 'file_edit')
        add('displays', callId, meta);
    }
  }
  return rows;
}

/** Calls absent from the committed transcript still need an exact terminal
 * closure. Resolve only their original receipts, never every historical body. */
export function pendingDeliveryCalls(snapshot, configuration) {
  if (!terminal(snapshot.phase)) return [];
  const completed = new Set(snapshot.messages.filter(message => message.role === 'tool').map(message => message.callId));
  return [...new Set(snapshot.messages.flatMap(message => (message.toolCalls ?? [])
    .filter(call => configuration.deliveryScopePolicy !== RESULT_DELIVERY_POLICY || call.name !== FINAL_SUBMISSION_TOOL).map(call => call.callId)))]
    .filter(callId => !completed.has(callId));
}

export function deliveryStateFromEntries({ snapshot, configuration, projections }, entries, resolveClosure) {
  const groups = Object.fromEntries(['events', 'inputs', 'tools', 'outcomes', 'displays'].map(key => [key, new Map()]));
  for (const row of entries) {
    // A definitive nondispatch fact has the same precedence as the full
    // receipt scan, including after later reconciliation events.
    if (row.collection === 'outcomes' && groups.outcomes.get(row.key) === 'not_dispatched') continue;
    if (row.collection === 'tools' && groups.tools.has(row.key)) continue;
    groups[row.collection].set(row.key, row.data);
  }
  return copy({ contract: NATIVE_DELIVERY_JOURNAL,
    snapshot: pick(snapshot, DELIVERY_SNAPSHOT_FIELDS), configuration, projections,
    events: [...groups.events.values()].sort((a, b) => a.seq - b.seq),
    inputBoundaries: [...groups.inputs], toolOutcomes: [...groups.outcomes], displays: [...groups.displays],
    closures: pendingDeliveryCalls(snapshot, configuration).map(callId => [callId, resolveClosure(callId, groups.tools.get(callId))]) });
}

export function projectNativeSessionDelivery(record) {
  return deliveryStateFromEntries(record, sessionDeliveryEntries(record), callId => nativeDeliveryClosure(record, callId));
}
