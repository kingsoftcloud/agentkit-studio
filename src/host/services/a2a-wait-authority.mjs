/** Trusted, live Host services for an original Native idle checkpoint.
 * Question answers and supplemental-operation consent have distinct calls. */
import { canonical, invariant } from '../../../packages/agentkit-harness-core/dist/index.mjs';
import { a2aDecisionDigest } from '../../providers/native-a2a-decision.mjs';
import { requestStudioA2aApproval } from './a2a-control-approval.mjs';
import { createStudioA2aQuestionPresenter } from './a2a-question-presenter.mjs';

export function createStudioA2aWaitAuthority({ ctx, agent, store, snapshot, signal }) {
  const session = agent.session, checkpoint = canonical(snapshot);
  const presetId = ctx.get('sessionProjections')?.stateOf?.(session, 'agentPreset');
  const assertCurrent = () => {
    signal.throwIfAborted();
    invariant(agent.session === session && String(session.id) === snapshot.sessionId
      && ctx.get('agents')?.get?.(agent.id) === agent && ctx.get('agents')?.roots?.().includes(agent)
      && typeof presetId === 'string' && presetId.length > 0
      && ctx.get('sessionProjections')?.stateOf?.(session, 'agentPreset') === presetId
      && canonical(store.load(snapshot.scope, snapshot.runId).snapshot) === checkpoint,
    'A2A_QUESTION_AUTHORITY_LOST');
    return true;
  };
  const present = createStudioA2aQuestionPresenter({ ctx, agent, assertCurrent });
  return { present,
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
