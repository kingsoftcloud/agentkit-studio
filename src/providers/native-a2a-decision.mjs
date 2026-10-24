/** Host decisions are committed with the original control intent. Remote
 * status, request correlation and caller JSON are never approval evidence. */
import { createHash } from 'node:crypto';
import { canonical, copy, invariant, compileToolInput } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { a2aIdentity, a2aEventJournal, enqueueA2AEvents } from './native-a2a-events.mjs';
import { validateA2aScopeCancellation } from './native-a2a-scope-cancellation.mjs';

export const A2A_HOST_DECISION = 'agentkit.a2a-host-decision/v1';
export const A2A_HOST_INPUT_DECISION = 'agentkit.a2a-host-input-decision/v1';
export const a2aDecisionDigest = value => createHash('sha256').update(canonical(value)).digest('hex');
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 4096;
function pendingInteraction(record, kind) {
  const state = record.managed?.events?.adapter, active = state?.activeInteraction;
  if (active?.kind !== kind || !['input_required', 'auth_required'].includes(record.projection.state)) return null;
  const requested = record.managed.events.log.find(event => event.event_type === 'interaction.requested'
    && event.interaction_id === active.id && event.interaction_kind === kind);
  invariant(requested, kind === 'approval' ? 'A2A_APPROVAL_REQUEST_MISSING' : 'A2A_INPUT_REQUEST_MISSING');
  return { contract: kind === 'approval' ? 'agentkit.a2a-remote-approval-control/v1' : 'agentkit.a2a-remote-input-control/v1',
    interactionId: active.id, continuationId: active.continuation, request: copy(requested.request),
    decision: state.hostDecisions?.[active.id]?.decision ?? null };
}
export const a2aPendingApproval = record => pendingInteraction(record, 'approval');
export const a2aPendingInput = record => pendingInteraction(record, 'structured_input');

/** Match runtime_input._structured_input_value. Normalize before hashing the
 * command so the audit, persisted answer and wire carry the exact same value.
 * A duplicate uses its original requested schema even after remote progress. */
export function normalizeA2aInputParts(record, parts, previous, unwrap = true) {
  const requested = previous?.hostDecision?.kind === 'structured_input'
    ? record.managed?.events?.log.find(event => event.event_type === 'interaction.requested'
      && event.interaction_kind === 'structured_input' && event.interaction_id === previous.hostDecision.interactionId)?.request
    : a2aPendingInput(record)?.request;
  if (!requested) return parts;
  invariant(Array.isArray(parts) && parts.length === 1 && parts[0] && Object.keys(parts[0]).length === 1
    && Object.hasOwn(parts[0], 'data'), 'A2A_STRUCTURED_INPUT_REQUIRED');
  let value = copy(parts[0].data);
  if (unwrap && value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1
    && Object.hasOwn(value, 'result') && requested.schema?.type !== 'object') value = value.result;
  let validate;
  try { validate = requested.schema && compileToolInput(requested.schema); }
  catch { invariant(false, 'A2A_INPUT_SCHEMA_INVALID'); }
  invariant(validate && validate(value), 'A2A_STRUCTURED_INPUT_INVALID');
  return [{ data: value }];
}
export function validateA2aHostReceipt(receipt, sessionId) {
  invariant(receipt?.contract === A2A_HOST_DECISION && receipt.sessionId === sessionId
    && ['sessionId', 'presetId', 'requestId', 'callId', 'toolName'].every(key => id(receipt[key]))
    && /^[a-f0-9]{64}$/u.test(receipt.requestDigest) && receipt.outcome === 'allowed-once'
    && Number.isSafeInteger(receipt.askedSeq) && receipt.askedSeq >= 0
    && Number.isSafeInteger(receipt.decidedSeq) && receipt.decidedSeq > receipt.askedSeq
    && Object.keys(receipt).every(key => ['contract', 'sessionId', 'presetId', 'requestId', 'callId', 'toolName',
      'requestDigest', 'outcome', 'askedSeq', 'decidedSeq'].includes(key)), 'A2A_HOST_DECISION_RECEIPT_INVALID');
  return receipt;
}
/** Called ONLY while admitting the original command under its publication
 * lock. The complete immutable event and effect intent share one fsync. */
export function checkpointA2aHostDecision(record, entry) {
  const approval = a2aPendingApproval(record) ?? a2aPendingInput(record);
  if (entry.scopeCancellation) {
    const receipt = validateA2aScopeCancellation(record, entry.command, entry.scopeCancellation);
    if (!approval || approval.decision) return false;
    const state = a2aEventJournal(record), original = record.request.native, seq = state.nextSeq;
    const eventId = a2aIdentity('event', 'a2a', record.request.scopeId, approval.interactionId, 'scope-cancel', entry.command.commandId, seq);
    enqueueA2AEvents(record, [{ schema_version: 2, event_id: eventId, seq, timestamp: Date.now() / 1000,
      run_id: original.runId, run_seq: null, scope_id: record.request.scopeId, parent_scope_id: original.runId,
      source: { framework: 'a2a', protocol: null, native_event_id: null, native_cursor: null,
        native_run_id: record.projection.taskId, native_item_id: null, metadata: { scope_cancellation: receipt } },
      // RuntimeEvent v2 represents withdrawal as a resolved/canceled response;
      // interaction.cancelled belongs to the separate managed v1 envelope.
      event_type: 'interaction.resolved', interaction_id: approval.interactionId, interaction_kind: approval.request.request_type,
      response: approval.request.request_type === 'approval' ? { response_type: 'approval', decision: 'canceled', data: null }
        : { response_type: 'structured_input', data: null } }]);
    state.adapter.hostDecisions ??= {};
    state.adapter.hostDecisions[approval.interactionId] = { decision: 'canceled', commandDigest: entry.digest, eventId };
    return true;
  }
  if (!approval) {
    // A remote progress/repeated-ID sequence can retire the canonical wait.
    // Never downgrade a retired managed wait to arbitrary supplemental input.
    invariant(entry.command.kind !== 'continue', record.projection.pause?.metadata?.ksadk_interaction
      ? 'A2A_APPROVAL_REQUEST_MISSING' : 'A2A_INPUT_REQUEST_MISSING');
    return false;
  }
  // A second cancellation may inspect an already withdrawn approval. It does
  // not overwrite the first decision or turn it into an execution grant.
  if (approval.decision) {
    invariant(entry.command.kind === 'cancel', approval.request.request_type === 'approval'
      ? 'A2A_APPROVAL_ALREADY_DECIDED' : 'A2A_INPUT_ALREADY_DECIDED'); return false;
  }
  const value = entry.hostDecision;
  invariant(value?.commandDigest === entry.digest && value.interactionId === approval.interactionId,
    'A2A_HOST_DECISION_REQUIRED');
  validateA2aHostReceipt(value.receipt, record.sessionDestination ?? record.owner.sessionId);
  invariant(['continue', 'cancel', 'reject'].includes(entry.command.kind), 'A2A_HOST_DECISION_INVALID');
  const kind = approval.request.request_type;
  if (entry.command.kind === 'continue') {
    if (kind === 'approval') invariant(canonical(entry.command.parts) === canonical([{ data: 'approve' }]), 'A2A_APPROVAL_RESPONSE_INVALID');
    else normalizeA2aInputParts(record, entry.command.parts, undefined, false);
  }
  invariant(kind === 'approval' || entry.command.kind !== 'reject', 'A2A_HOST_DECISION_INVALID');
  const decision = entry.command.kind === 'continue' ? kind === 'approval' ? 'approved' : 'submitted'
    : entry.command.kind === 'reject' ? 'rejected' : 'canceled';
  const state = a2aEventJournal(record), request = record.request, original = request.native ?? request.dsh;
  const parent = request.native ? original.runId : a2aIdentity('scope', 'dsh', original.agentId, original.sessionId);
  const seq = state.nextSeq, eventId = a2aIdentity('event', 'a2a', request.scopeId, approval.interactionId,
    'host-decision', entry.command.commandId, seq);
  const event = { schema_version: 2, event_id: eventId, seq, timestamp: Date.now() / 1000,
    run_id: parent, run_seq: null, scope_id: request.scopeId, parent_scope_id: parent,
    source: { framework: 'a2a', protocol: null, native_event_id: null, native_cursor: null,
      native_run_id: record.managed.remote?.id ?? null, native_item_id: null,
      metadata: { host_decision: copy(value.receipt), command_digest: entry.digest, host_outcome: decision } },
    event_type: 'interaction.resolved', interaction_id: approval.interactionId, interaction_kind: kind,
    response: kind === 'approval' ? { response_type: kind, decision, data: null }
      : { response_type: kind, data: decision === 'submitted' ? copy(entry.command.parts[0].data) : null } };
  enqueueA2AEvents(record, [event]);
  state.adapter.hostDecisions ??= {};
  state.adapter.hostDecisions[approval.interactionId] = { decision, commandDigest: entry.digest, eventId };
  return true;
}
