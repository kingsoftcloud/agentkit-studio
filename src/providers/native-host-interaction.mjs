import { createHash } from 'node:crypto';
import { canonical, CHILD_OWNER_CONTRACT, invariant, isPlanModeCall, EXIT_PLAN_MODE } from '@kingsoftcloud/agentkit-harness-core';
import { createStudioA2aWaitAuthority } from '../host/services/a2a-wait-authority.mjs';

const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const same = (left, right) => canonical(left) === canonical(right);
export const STUDIO_NATIVE_INTERACTION_CONTRACT = 'agentkit.native-host-interaction/v1';

/** Ask through the live Host service only for a ledger-owned pending decision.
 * The Kernel remains responsible for accepting and applying the command. */
export function createNativeHostInteraction({ ctx, store }) {
  return async ({ agent, signal, assertCurrent }, snapshot, { waitForToolReceipt } = {}) => {
    signal.throwIfAborted(); assertCurrent?.();
    if (snapshot.phase !== 'awaiting_reconciliation' && snapshot.phase !== 'awaiting_interaction') return null;
    const record = store.load(snapshot.scope, snapshot.runId);
    const childWait = snapshot.phase === 'awaiting_reconciliation' && record.configuration.childOwnerBinding;
    invariant(String(agent?.session?.id) === snapshot.sessionId || childWait, 'studio_native_approval_session_mismatch');
    invariant(same(record.snapshot, snapshot), 'studio_native_approval_checkpoint_stale');
    if (snapshot.phase === 'awaiting_reconciliation' && snapshot.toolReconciliation) {
      if (typeof waitForToolReceipt === 'function') {
        const questionHost = createStudioA2aWaitAuthority({ ctx, agent, store, snapshot, signal, assertCurrent });
        if (childWait) questionHost.assertCurrent();
        const command = await waitForToolReceipt({ snapshot: structuredClone(snapshot), signal,
          questionHost });
        signal.throwIfAborted();
        invariant(same(store.load(snapshot.scope, snapshot.runId).snapshot, snapshot), 'studio_native_approval_checkpoint_stale');
        if (command) return command;
      }
      // Other uncertain tools still require explicit product reconciliation.
      return new Promise((_, reject) => {
        const abort = () => reject(signal.reason);
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
      });
    }
    if (snapshot.phase !== 'awaiting_interaction' || !snapshot.pendingInteraction) return null;
    const pending = snapshot.pendingInteraction;
    let call, definition, childRunId;
    if (snapshot.childApproval) {
      const approval = snapshot.childApproval;
      const reservation = snapshot.childBudgetReservations.find(item => item.childRunId === approval.childRunId);
      invariant(reservation && reservation.settledUsageDigest === null && same(reservation.childScope, approval.childScope)
        && reservation.parentOperationKey === approval.parentOperationKey && reservation.parentToolCallId === approval.parentToolCallId
        && pending.hostInteractionId === `native-child-${hash(approval)}`, 'studio_native_child_approval_not_owned');
      const child = store.load(approval.childScope, approval.childRunId);
      const binding = child.configuration.childOwnerBinding;
      const parentIdentity = Object.fromEntries(['scope', 'runId', 'sessionId', 'turnId', 'buildId', 'parentRunId', 'taskChainId']
        .map(key => [key, snapshot[key]]));
      invariant(binding?.contract === CHILD_OWNER_CONTRACT && same(binding.parent, parentIdentity)
        && binding.parentOperationKey === reservation.parentOperationKey && binding.parentToolCallId === reservation.parentToolCallId
        && binding.childRequestDigest === reservation.childRequestDigest && child.snapshot.configDigest === reservation.configurationDigest
        && hash(child.configuration) === reservation.configurationDigest && pending.callId === approval.toolCall.callId
        && child.snapshot.phase === 'awaiting_interaction'
        && child.snapshot.pendingInteraction?.interactionId === approval.interactionId
        && child.snapshot.pendingInteraction?.hostInteractionId === approval.hostInteractionId,
      'studio_native_child_approval_not_owned');
      call = child.snapshot.pendingTools.find(item => item.callId === approval.toolCall.callId);
      definition = child.configuration.tools.find(item => item.name === call?.name);
      invariant(call && definition && same(call, approval.toolCall) && hash(definition) === approval.definitionDigest,
        'studio_native_child_approval_not_owned');
      childRunId = approval.childRunId;
    } else {
      call = snapshot.pendingTools.find(item => item.callId === pending.callId);
      definition = record.configuration.tools.find(item => item.name === call?.name);
      const intent = record.intents.find(item => item.operationKey === pending.operationKey);
      const receipt = record.receipts.find(item => item.operationKey === pending.operationKey);
      const index = intent?.payload.calls?.findIndex(item => same(item, call));
      const result = receipt?.result.results?.[index];
      invariant(call && definition && intent?.kind === 'tool' && intent.status === 'running'
        && index >= 0 && receipt?.status === 'committed' && result?.status === 'approval_required'
        && result.interactionId === pending.hostInteractionId, 'studio_native_approval_not_owned');
    }
    const approval = ctx.get?.('approval') ?? ctx.approval;
    // Ordinary calls share the ID already displayed by session-delivery. A
    // child's call lives in its own run; use the parent bridge's opaque ID.
    const callId = childRunId ? pending.hostInteractionId : `ak-native-${hash({
      identity: hash({ scope: snapshot.scope, runId: snapshot.runId }), key: `call:${call.callId}`,
    })}`;
    if (!childRunId && isPlanModeCall(record.configuration, call) && call.name === EXIT_PLAN_MODE) {
      const questions = ctx.get?.('userQuestions');
      if (typeof questions?.ask !== 'function') return null;
      let answer;
      try {
        answer = await questions.ask({ agent, signal, questions: [{ id: 'plan-review', header: 'Plan review',
          question: 'Approve this plan and leave plan mode?', detail: call.arguments.plan,
          options: [{ label: 'Approve', description: 'Leave plan mode and begin implementation subject to normal permissions.' },
            { label: 'Keep planning', description: 'Keep plan mode active and return feedback to the model.' }],
          intent: { kind: 'plan-review', approve: 'Approve', callId } }] });
      } catch (error) {
        signal.throwIfAborted();
        if (error?.code !== 'ASK_CANCELLED') throw error;
        invariant(same(store.load(snapshot.scope, snapshot.runId).snapshot, snapshot), 'studio_native_approval_checkpoint_stale');
        return { commandId: `native-plan-dismiss-${hash({ scope: snapshot.scope, runId: snapshot.runId, pending })}`,
          kind: 'cancel', payload: { reason: 'plan_review_dismissed', dshCancelReason: { kind: 'user' } } };
      }
      signal.throwIfAborted(); assertCurrent?.();
      invariant(same(store.load(snapshot.scope, snapshot.runId).snapshot, snapshot), 'studio_native_approval_checkpoint_stale');
      const reviews = answer?.answers?.filter(item => item.id === 'plan-review') ?? [];
      const review = reviews.length === 1 ? reviews[0] : undefined;
      const decision = review?.selected?.length === 1 && review.selected[0] === 'Approve' && review.custom === undefined ? 'allow' : 'deny';
      const feedback = typeof review?.custom === 'string' ? review.custom : '';
      return { commandId: `native-plan-review-${hash({ scope: snapshot.scope, runId: snapshot.runId, pending, decision, feedback })}`,
        kind: 'submit_interaction', payload: { interactionId: pending.interactionId, decision, feedback } };
    }
    if (typeof approval?.request !== 'function') return null;
    const outcome = await approval.request({ agent, signal, callId, toolName: call.name,
      reason: childRunId ? `Native child ${childRunId} requests approval for ${call.name}.`
        : `Native tool ${call.name} requires approval.` });
    signal.throwIfAborted();
    invariant(same(store.load(snapshot.scope, snapshot.runId).snapshot, snapshot), 'studio_native_approval_checkpoint_stale');
    // Only the Host's one-call grant authorizes execution. Unavailable, rejected
    // and unrecognized responses become a durable deny, never implicit allow.
    const decision = outcome === 'allowed-once' ? 'allow' : 'deny';
    return { commandId: `native-host-approval-${hash({ scope: snapshot.scope, runId: snapshot.runId, pending, decision })}`,
      kind: 'submit_interaction', payload: { interactionId: pending.interactionId, decision } };
  };
}
