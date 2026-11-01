/** Human controls for existing DSH/Codex calls. Their original ledger supplies
 * ownership; a Native Run/fence is neither accepted nor synthesized. */
import { createHash } from 'node:crypto';
import { canonical, copy, invariant, parseNativeJson } from '@kingsoftcloud/agentkit-harness-core';
import { awaitA2aControl } from '../../providers/native-a2a-controls.mjs';
import { requestStudioA2aApproval } from './a2a-control-approval.mjs';
import { a2aDecisionDigest } from '../../providers/native-a2a-decision.mjs';
const id = value => typeof value === 'string' && value.trim() && value.length <= 256;
export function validateDshA2aRequest(request, control = false) {
  const allowed = control ? ['agentId', 'sessionId', 'agentRevision', 'buildId', 'operationKey', 'callId', 'kind', 'commandId', 'parts', 'json', 'pauseDigest']
    : ['agentId', 'sessionId', 'offset', 'limit', 'inventoryDigest'];
  invariant(request && typeof request === 'object' && !Array.isArray(request)
    && Object.keys(request).every(key => allowed.includes(key)) && id(request.agentId) && id(request.sessionId), 'STUDIO_DSH_A2A_REQUEST_INVALID');
  if (control) invariant(Number.isSafeInteger(request.agentRevision) && request.agentRevision > 0
    && (request.buildId === null || id(request.buildId)) && id(request.callId) && id(request.commandId)
    && request.operationKey === `dsh-a2a:${request.callId}` && ['get', 'subscribe', 'continue', 'cancel', 'reject'].includes(request.kind)
    && (request.kind === 'continue' ? typeof request.pauseDigest === 'string' && /^[a-f0-9]{64}$/u.test(request.pauseDigest)
      && (Array.isArray(request.parts) && request.json === undefined || request.parts === undefined
        && typeof request.json === 'string' && request.json.length <= 1024 * 1024)
      : request.parts === undefined && request.json === undefined && (request.kind === 'reject'
        ? typeof request.pauseDigest === 'string' && /^[a-f0-9]{64}$/u.test(request.pauseDigest) : request.pauseDigest === undefined)), 'STUDIO_DSH_A2A_REQUEST_INVALID');
  else invariant((request.offset === undefined || Number.isSafeInteger(request.offset) && request.offset >= 0)
    && (request.limit === undefined || Number.isSafeInteger(request.limit) && request.limit >= 1 && request.limit <= 64)
    && (request.inventoryDigest === undefined || typeof request.inventoryDigest === 'string' && /^[a-f0-9]{64}$/u.test(request.inventoryDigest)),
  'STUDIO_DSH_A2A_REQUEST_INVALID');
}
export function createStudioDshA2aControls({ ctx, agentEvents, signal: hostSignal }) {
  const lifetime = new AbortController(), active = new Set();
  function run(request, callerSignal, control) {
    validateDshA2aRequest(request, control);
    const original = copy(request), bytes = canonical(request);
    const signal = AbortSignal.any([lifetime.signal, ...(hostSignal ? [hostSignal] : []), ...(callerSignal ? [callerSignal] : []), AbortSignal.timeout(90000)]);
    const task = (async () => {
      signal.throwIfAborted();
      const controller = ctx.get('sessionController');
      invariant(typeof controller?.resolveAgent === 'function' && typeof agentEvents === 'function', 'STUDIO_DSH_A2A_UNAVAILABLE');
      const found = await awaitA2aControl(() => controller.resolveAgent(original.sessionId), signal);
      if (found.error) throw found.error;
      const agent = found.agent, session = agent?.session;
      invariant(session?.id === original.sessionId, 'STUDIO_DSH_A2A_IDENTITY_CONFLICT');
      const presetId = ctx.get('sessionProjections')?.stateOf?.(session, 'agentPreset');
      invariant(id(presetId), 'STUDIO_DSH_A2A_PRESET_UNAVAILABLE');
      const assertCurrent = () => {
        signal.throwIfAborted();
        invariant(canonical(request) === bytes && agent.session === session && session.id === original.sessionId
          && ctx.get('sessionProjections')?.stateOf?.(session, 'agentPreset') === presetId, 'STUDIO_DSH_A2A_IDENTITY_CONFLICT');
        return true;
      };
      const binding = await awaitA2aControl(() => agentEvents(ctx, agent).serial('agentkit/dsh-a2a-binding', {}), signal);
      assertCurrent();
      if (!binding && !control) return { contract: 'agentkit.studio-dsh-a2a-inventory/v1', applicable: false,
        agentId: original.agentId, sessionId: original.sessionId, items: [], complete: true, offset: 0, total: 0 };
      invariant(binding?.contract === 'agentkit.studio-dsh-a2a-binding/v1' && binding.local === true
        && ['dsh-native', 'harness', 'codex'].includes(binding.runtime) && binding.agentId === original.agentId
        && Number.isSafeInteger(binding.agentRevision) && binding.agentRevision > 0
        && (binding.buildId === null || id(binding.buildId)), 'STUDIO_DSH_A2A_BINDING_CHANGED');
      const tools = binding.tools;
      if (!control) {
        invariant(typeof tools?.a2aTaskHistory === 'function', 'STUDIO_DSH_A2A_UNAVAILABLE');
        return tools.a2aTaskHistory({ sessionId: original.sessionId, ...(original.offset !== undefined ? { offset: original.offset } : {}),
          ...(original.limit !== undefined ? { limit: original.limit } : {}),
          ...(original.inventoryDigest !== undefined ? { inventoryDigest: original.inventoryDigest } : {}) }, assertCurrent);
      }
      invariant(original.agentRevision === binding.agentRevision && original.buildId === binding.buildId
        && typeof tools?.controlA2aTask === 'function', 'STUDIO_DSH_A2A_BINDING_CHANGED');
      const parts = original.json === undefined ? original.parts : [{ data: parseNativeJson(original.json) }];
      return await awaitA2aControl(() => tools.controlA2aTask({ sessionId: original.sessionId, callId: original.callId,
        agentRevision: binding.agentRevision, buildId: binding.buildId, kind: original.kind, commandId: original.commandId,
        authority: { contract: 'agentkit.studio-dsh-a2a-human-control/v1', agentId: binding.agentId, sessionId: original.sessionId,
          agentRevision: binding.agentRevision, buildId: binding.buildId }, signal,
        ...(parts !== undefined ? { parts } : {}),
        ...(original.pauseDigest !== undefined ? { pauseDigest: original.pauseDigest } : {}) }, { assertCurrent,
        authorizeControl: async ({ task, spec, command, readOnly, signal: consentSignal }) => {
          assertCurrent(); if (readOnly) return 'allow';
          const approval = ctx.get('approval');
          const checkPolicy = () => invariant(['read-only', 'workspace-write', 'danger-full-access'].includes(
            ctx.get('sandboxPolicy')?.resolve?.({ session })?.mode), 'STUDIO_DSH_A2A_PERMISSION_UNAVAILABLE');
          invariant(typeof approval?.request === 'function', 'STUDIO_DSH_A2A_PERMISSION_UNAVAILABLE'); checkPolicy();
          const outcome = await requestStudioA2aApproval({ ctx, agent, presetId, assertCurrent,
            requireReceipt: Boolean(task.approval && !task.approval.decision || task.input && !task.input.decision), request: { agent, toolName: `a2a_${original.kind}_task`, signal: consentSignal,
            callId: `dsh-a2a-control:${createHash('sha256').update(canonical({ locator: command.operation_locator, commandId: command.commandId })).digest('hex')}`,
            reason: canonical({ action: original.kind, target: spec.local_name, targetAgentId: spec.target_agent_id,
              taskId: task.task_id, remoteTaskId: task.remote_task_id, commandId: command.commandId,
              ...(task.approval ? { approval: task.approval } : {}), ...(task.input ? { input: task.input } : {}), parts: command.parts }) } });
          assertCurrent(); checkPolicy();
          // Cordis returns context-bound service proxies; object equality is
          // not service identity. Recheck availability, policy and the exact
          // preset/tool binding after the durable approval instead.
          invariant(typeof ctx.get('approval')?.request === 'function', 'STUDIO_DSH_A2A_PERMISSION_UNAVAILABLE');
          const current = await awaitA2aControl(() => agentEvents(ctx, agent).serial('agentkit/dsh-a2a-binding', {}), signal);
          assertCurrent(); invariant(current?.tools === tools && current?.contract === binding.contract
            && current?.agentId === binding.agentId && current?.agentRevision === binding.agentRevision
            && current?.buildId === binding.buildId && current?.runtime === binding.runtime && current?.local === true,
          'STUDIO_DSH_A2A_BINDING_CHANGED');
          if (typeof outcome === 'object') return { decision: outcome.outcome === 'allowed-once' ? 'allow' : 'deny',
            commandDigest: a2aDecisionDigest(command), receipt: outcome.receipt };
          return outcome === 'allowed-once' ? 'allow' : 'deny';
        },
      }), signal);
    })();
    active.add(task); void task.finally(() => active.delete(task)).catch(() => {}); return task;
  }
  return { history: (request, signal) => run(request, signal, false), control: (request, signal) => run(request, signal, true),
    async close() { lifetime.abort(); await Promise.allSettled([...active]); } };
}
