/** Canonical child-scope lifecycle facts. This producer deliberately does not
 * claim to map remote content/interaction events; those use a separate adapter.
 * Mutate only inside the original call's atomic state publication. */
import { createHash } from 'node:crypto';
import { canonical, copy, invariant } from '../../packages/agentkit-harness-core/dist/index.mjs';

export const A2A_EVENT_JOURNAL = 'agentkit.a2a-event-journal/v1';
export const A2A_EVENT_PERMANENT_ERRORS = Object.freeze(['A2A_EVENT_BATCH_TOO_LARGE', 'A2A_KERNEL_FACT_INVALID',
  'A2A_EVENT_REF_CAPACITY', 'A2A_EVENT_REF_CONFLICT', 'A2A_EVENT_REF_INVALID', 'A2A_TASK_NOT_FOUND']);
const terminal = new Set(['completed', 'failed', 'cancelled']);
const hash = value => createHash('sha256').update(value).digest('hex');
export function a2aIdentity(kind, framework, ...components) {
  const normalized = [framework, ...components].map(value => {
    invariant(typeof value === 'string' || typeof value === 'boolean' || typeof value === 'bigint'
      || Number.isSafeInteger(value), 'A2A_EVENT_IDENTITY_INVALID');
    const text = String(value).normalize('NFC'); invariant(text.trim(), 'A2A_EVENT_IDENTITY_INVALID'); return text;
  });
  invariant(components.length > 0 && ['scope', 'item', 'part', 'event'].includes(kind), 'A2A_EVENT_IDENTITY_INVALID');
  return `${kind}_${hash(canonical({ components: normalized, kind })).slice(0, 24)}`;
}
export function a2aEventJournal(record) {
  record.managed.events ??= { contract: A2A_EVENT_JOURNAL, nextSeq: 1, log: [], pending: [], deadLetters: [], delivered: 0 };
  const state = record.managed.events;
  invariant(state.contract === A2A_EVENT_JOURNAL && Number.isSafeInteger(state.nextSeq) && state.nextSeq > 0
    && Array.isArray(state.log) && Array.isArray(state.pending) && Array.isArray(state.deadLetters), 'A2A_EVENT_JOURNAL_INVALID');
  return state;
}
/** Original immutable event bytes are retained after acknowledgement. Event IDs
 * and batches are never regenerated on delivery or after a restart. */
export function enqueueA2AEvents(record, events) {
  const state = a2aEventJournal(record);
  invariant(Array.isArray(events) && events.length > 0 && events.length <= 100, 'A2A_EVENT_BATCH_TOO_LARGE');
  const existing = new Map(state.log.map(event => [event.event_id, canonical(event)])), fresh = [];
  for (const event of events) {
    invariant(event?.schema_version === 2 && typeof event.event_id === 'string' && event.event_id
      && Number.isSafeInteger(event.seq) && event.seq > 0, 'A2A_EVENT_INVALID');
    const previous = existing.get(event.event_id), bytes = canonical(event);
    invariant(previous === undefined || previous === bytes, 'A2A_EVENT_ID_CONFLICT');
    if (previous === undefined) { existing.set(event.event_id, bytes); fresh.push(copy(event)); }
  }
  if (!fresh.length) return false;
  const lastSeq = state.log.at(-1)?.seq ?? 0;
  invariant(fresh.every((event, index) => event.seq === lastSeq + index + 1), 'A2A_EVENT_SEQUENCE_CONFLICT');
  invariant(state.log.length + fresh.length <= 8192 && Buffer.byteLength(canonical([...state.log, ...fresh])) <= 8 * 1024 ** 2,
    'A2A_EVENT_JOURNAL_LIMIT');
  const batchId = `a2a-event-batch-${hash(record.managed.taskId + ':' + canonical(fresh))}`;
  state.log.push(...fresh);
  state.nextSeq = Math.max(state.nextSeq, fresh.at(-1).seq + 1);
  state.pending.push({ batchId, sequence: fresh[0].seq, createdAt: Date.now(), events: fresh, attempts: 0 });
  return true;
}
/** Python invocation_service._descriptor_event semantics: a remote child
 * publishes item facts in its original parent's run, never run.* events. */
export function checkpointA2ADescriptor(record) {
  if (!record.managed?.taskId) return false;
  const state = a2aEventJournal(record), request = record.request, original = request.native ?? request.dsh;
  const parent = request.native ? original.runId : a2aIdentity('scope', 'dsh', original.agentId, original.sessionId);
  const scope = request.scopeId, item = a2aIdentity('item', 'a2a', scope, 'execution.scope');
  const remoteState = record.projection.state;
  let status = record.phase === 'unknown' ? 'failed' : remoteState === 'auth_required' ? 'input_required'
    : remoteState === 'rejected' ? 'failed' : remoteState === 'submitted' && record.phase === 'sending' ? 'working' : remoteState;
  // The first descriptor is always submitted. A local public terminal cannot
  // be reopened by a later private inspection of a previously unknown result.
  if (state.descriptor && terminal.has(state.descriptor.status)) return false;
  const statuses = state.descriptor ? [status] : status === 'submitted' ? ['submitted'] : ['submitted', status];
  let changed = false;
  for (status of statuses) {
    if (state.descriptor?.status === status) continue;
    invariant(['submitted', 'working', 'input_required', ...terminal].includes(status), 'A2A_EVENT_STATUS_INVALID');
    const endedAt = terminal.has(status) ? Math.max(Date.now(), record.createdAt) / 1000 : null;
    const descriptor = { schema: 'execution.scope/v1', scope_id: scope, parent_scope_id: parent,
      trigger_ref: { ...copy(request.trigger), scope_id: parent }, binding_id: request.spec.binding_id,
      agent: { id: request.spec.target_agent_id, name: request.spec.local_name, version_id: request.spec.expected_version_id, protocol: 'a2a/1.0' },
      status, started_at: record.createdAt / 1000, ended_at: endedAt,
      output_refs: [], cancel: { capability: status === 'cancelled' && !record.localCancel ? 'supported' : 'unknown',
        request_state: status === 'cancelled' ? record.localCancel ? 'local_confirmed' : 'confirmed' : 'none' } };
    const initial = !state.descriptor, type = initial ? 'item.started' : terminal.has(status) ? 'item.completed' : 'item.snapshot_replaced';
    const snapshot = { parts: [{ content_type: 'data', part_id: a2aIdentity('part', 'a2a', item, 'descriptor'), data: descriptor }] };
    const seq = state.nextSeq++;
    const event = { schema_version: 2, event_id: a2aIdentity('event', 'a2a', scope, item, type, 'descriptor', canonical(descriptor), seq),
      seq, timestamp: Date.now() / 1000, run_id: request.native ? original.runId : parent, run_seq: null,
      scope_id: scope, parent_scope_id: parent, source: { framework: 'a2a', protocol: null, native_event_id: null,
        native_cursor: null, native_run_id: null, native_item_id: null, metadata: { schema: 'execution.scope/v1' } },
      event_type: type, item_id: item, item_kind: 'status', ...(initial ? { phase: null, initial: snapshot } : { snapshot }) };
    enqueueA2AEvents(record, [event]); state.descriptor = descriptor; changed = true;
  }
  return changed;
}
