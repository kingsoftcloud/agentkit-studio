/** Trusted, live Host services for an original Native idle checkpoint.
 * Question answers and supplemental-operation consent have distinct calls. */
import { canonical, invariant, CHILD_OWNER_CONTRACT, admittedToolBudget, terminal } from '../../../packages/agentkit-harness-core/dist/index.mjs';
import { loadOwnedDirectChild } from '../../../packages/agentkit-harness/src/native/owned-child.mjs';
import { readNativeDshOwnership } from '../../../packages/agentkit-harness/src/native/dsh-turn-ownership.mjs';
import { readNativeDshBackgroundOwnership, NATIVE_DSH_BACKGROUND_TURN_CONTRACT } from '../../../packages/agentkit-harness/src/native/dsh-background-ownership.mjs';
import { a2aDecisionDigest } from '../../providers/native-a2a-decision.mjs';
import { requestStudioA2aApproval } from './a2a-control-approval.mjs';
import { createStudioA2aQuestionPresenter } from './a2a-question-presenter.mjs';

export function createStudioA2aWaitAuthority({ ctx, agent, store, snapshot, signal }) {
  const session = agent.session, checkpoint = canonical(snapshot);
  const child = store.load(snapshot.scope, snapshot.runId).configuration.childOwnerBinding;
  const assertParent = () => {
    if (!child) return String(session.id) === snapshot.sessionId;
    invariant(child.contract === CHILD_OWNER_CONTRACT && child.parent.sessionId === String(session.id), 'A2A_QUESTION_AUTHORITY_LOST');
    const parent = store.load(child.parent.scope, child.parent.runId), current = parent.snapshot;
    const identity = Object.fromEntries(['scope', 'runId', 'sessionId', 'turnId', 'buildId', 'parentRunId', 'taskChainId'].map(key => [key, current[key]]));
    const pending = agent.externalTurns?.pending?.();
    const admission = pending?.engine === NATIVE_DSH_BACKGROUND_TURN_CONTRACT
      ? readNativeDshBackgroundOwnership(pending, { sessionId: session.id, turn: pending.turn })
      : readNativeDshOwnership(pending, { sessionId: session.id, turn: pending?.turn });
    invariant(canonical(identity) === canonical(child.parent) && canonical(admission.identity) === canonical(identity)
      && admission.configDigest === current.configDigest && a2aDecisionDigest(parent.configuration) === current.configDigest
      && !terminal(current.phase) && current.phase !== 'finalizing'
      && !current.childTerminalPhase && !parent.commands.some(row => !row.consumed && (['cancel', 'policy_revoked'].includes(row.command.kind)
        || row.command.kind === 'cancel_child' && row.command.payload.childRunId === snapshot.runId)), 'A2A_QUESTION_AUTHORITY_LOST');
    const reservation = current.childBudgetReservations.find(row => row.childRunId === snapshot.runId);
    if (reservation) return reservation.settledUsageDigest === null && !!loadOwnedDirectChild({ store,
      childScopes: [snapshot.scope], parent: current, childRunId: snapshot.runId });
    // Foreground children may ask before the parent's startup receipt exists.
    // That temporary authority is exactly its still-live original start intent.
    const start = parent.intents.find(row => row.operationKey === child.parentOperationKey), call = start?.payload.calls?.[0];
    const definition = parent.configuration.tools.find(row => row.name === call?.name);
    return start?.kind === 'tool' && start.status === 'running' && current.pendingIntent === start.operationKey
      && start.payload.calls.length === 1 && call.callId === child.parentToolCallId && call.arguments.role === child.role
      && ['start/v1', 'delegate/v1'].includes(definition?.childBudgetPolicy)
      && start.claimedFence === child.parentExecutionFence && parent.lease?.fence === child.parentExecutionFence
      && parent.lease.expiresAt > Date.now() && child.childRequestDigest === a2aDecisionDigest({ parent: identity,
        operationKey: start.operationKey, call, budget: admittedToolBudget(current, parent.configuration, 1) });
  };
  const presetId = ctx.get('sessionProjections')?.stateOf?.(session, 'agentPreset');
  const assertCurrent = () => {
    signal.throwIfAborted();
    const current = store.load(snapshot.scope, snapshot.runId);
    invariant(agent.session === session && assertParent()
      && ctx.get('agents')?.get?.(agent.id) === agent && ctx.get('agents')?.roots?.().includes(agent)
      && typeof presetId === 'string' && presetId.length > 0
      && ctx.get('sessionProjections')?.stateOf?.(session, 'agentPreset') === presetId
      && !ctx.get('workspaceRegistry')?.archivedSessionIds?.includes(session.id)
      && canonical(current.snapshot) === checkpoint && a2aDecisionDigest(current.configuration) === snapshot.configDigest,
    'A2A_QUESTION_AUTHORITY_LOST');
    return true;
  };
  const present = createStudioA2aQuestionPresenter({ ctx, agent, assertCurrent });
  // A child observer needs continuous parent authority even for local peeks.
  // A root's non-question local receipt wait uses its existing turn owner;
  // optional question services are checked only when actually presenting or
  // authorizing a question, preserving the public non-question wait path.
  return { present, ...(child ? { assertCurrent } : {}),
    async authorizeControl({ command, task, spec, readOnly, signal: consentSignal }) {
      assertCurrent(); if (readOnly) return 'allow';
      const policy = () => {
        assertCurrent(); invariant(['read-only', 'workspace-write', 'danger-full-access'].includes(
          ctx.get('sandboxPolicy')?.resolve?.({ session })?.mode), 'STUDIO_NATIVE_A2A_PERMISSION_UNAVAILABLE');
      };
      policy();
      const result = await requestStudioA2aApproval({ ctx, agent, presetId, assertCurrent, requireReceipt: true,
        request: { agent, toolName: `a2a_${command.kind}_task`,
          callId: `a2a-question-operation:${a2aDecisionDigest({ locator: command.operation_locator, commandId: command.commandId })}`,
          signal: consentSignal,
          reason: canonical({ action: command.kind, target: spec.local_name, targetAgentId: spec.target_agent_id,
            taskId: task.task_id, remoteTaskId: task.remote_task_id, commandId: command.commandId,
            parts: command.parts, question: task.question ?? null }) } });
      policy();
      return { decision: result.outcome === 'allowed-once' ? 'allow' : 'deny',
        commandDigest: a2aDecisionDigest(command), receipt: result.receipt };
    },
  };
}
