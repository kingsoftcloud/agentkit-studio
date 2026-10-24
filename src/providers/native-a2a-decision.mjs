/** Host decisions are committed with the original control intent. Remote
 * status, request correlation and caller JSON are never approval evidence. */
import { createHash } from 'node:crypto';
import { canonical, copy, invariant } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { a2aIdentity, a2aEventJournal, enqueueA2AEvents } from './native-a2a-events.mjs';

export const A2A_HOST_DECISION = 'agentkit.a2a-host-decision/v1';
export const a2aDecisionDigest = value => createHash('sha256').update(canonical(value)).digest('hex');
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 4096;
export function a2aPendingApproval(record) {
  const state = record.managed?.events?.adapter, active = state?.activeInteraction;
  if (active?.kind !== 'approval' || !['input_required', 'auth_required'].includes(record.projection.state)) return null;
  const requested = record.managed.events.log.find(event => event.event_type === 'interaction.requested'
    && event.interaction_id === active.id && event.interaction_kind === 'approval');
  invariant(requested, 'A2A_APPROVAL_REQUEST_MISSING');
  return { contract: 'agentkit.a2a-remote-approval-control/v1', interactionId: active.id, continuationId: active.continuation, request: copy(requested.request),
    decision: state.hostDecisions?.[active.id]?.decision ?? null };
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
  const approval = a2aPendingApproval(record);
  if (!approval) {
    // A remote progress/repeated-ID sequence can retire the canonical wait.
    // Never downgrade a still-typed approval prompt to arbitrary input.
    invariant(entry.command.kind !== 'continue' || !record.projection.pause?.metadata?.ksadk_interaction,
      'A2A_APPROVAL_REQUEST_MISSING');
    return false;
  }
  // A second cancellation may inspect an already withdrawn approval. It does
  // not overwrite the first decision or turn it into an execution grant.
  if (approval.decision) {
    invariant(entry.command.kind === 'cancel', 'A2A_APPROVAL_ALREADY_DECIDED'); return false;
  }
  const value = entry.hostDecision;
  invariant(value?.commandDigest === entry.digest && value.interactionId === approval.interactionId,
    'A2A_HOST_DECISION_REQUIRED');
  validateA2aHostReceipt(value.receipt, record.sessionDestination ?? record.owner.sessionId);
  invariant(['continue', 'cancel', 'reject'].includes(entry.command.kind), 'A2A_HOST_DECISION_INVALID');
  if (entry.command.kind === 'continue') invariant(canonical(entry.command.parts) === canonical([{ data: 'approve' }]),
    'A2A_APPROVAL_RESPONSE_INVALID');
  const decision = entry.command.kind === 'continue' ? 'approved' : entry.command.kind === 'reject' ? 'rejected' : 'canceled';
  const state = a2aEventJournal(record), request = record.request, original = request.native ?? request.dsh;
  const parent = request.native ? original.runId : a2aIdentity('scope', 'dsh', original.agentId, original.sessionId);
  const seq = state.nextSeq, eventId = a2aIdentity('event', 'a2a', request.scopeId, approval.interactionId,
    'host-decision', entry.command.commandId, seq);
  const event = { schema_version: 2, event_id: eventId, seq, timestamp: Date.now() / 1000,
    run_id: parent, run_seq: null, scope_id: request.scopeId, parent_scope_id: parent,
    source: { framework: 'a2a', protocol: null, native_event_id: null, native_cursor: null,
      native_run_id: record.managed.remote?.id ?? null, native_item_id: null,
      metadata: { host_decision: copy(value.receipt), command_digest: entry.digest } },
    event_type: 'interaction.resolved', interaction_id: approval.interactionId, interaction_kind: 'approval',
    response: { response_type: 'approval', decision, data: null } };
  enqueueA2AEvents(record, [event]);
  state.adapter.hostDecisions ??= {};
  state.adapter.hostDecisions[approval.interactionId] = { decision, commandDigest: entry.digest, eventId };
  return true;
}
