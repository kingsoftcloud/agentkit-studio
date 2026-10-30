/** Authenticated human controls for an original Native A2A call. No replacement
 * Run, model prompt, fabricated execution fence, URL or credentials accepted. */
import { canonical, copy, invariant, parseNativeJson } from '@kingsoftcloud/agentkit-harness-core';
import { assertNativeRecoveryPreset, readNativeRecoveryBinding } from '../../providers/native-recovery-binding.mjs';
import { awaitA2aControl } from '../../providers/native-a2a-controls.mjs';
import { createHash } from 'node:crypto';
import { requestStudioA2aApproval } from './a2a-control-approval.mjs';
import { a2aDecisionDigest } from '../../providers/native-a2a-decision.mjs';

const id = value => typeof value === 'string' && value.trim() && value.length <= 256;
export function validateNativeA2aControlRequest(request) {
  invariant(request && typeof request === 'object' && !Array.isArray(request)
    && Object.keys(request).every(key => ['agentId', 'sessionId', 'runId', 'childRunId', 'operationKey', 'callId', 'kind', 'commandId', 'parts', 'json', 'pauseDigest'].includes(key))
    && ['agentId', 'sessionId', 'runId', 'callId', 'commandId'].every(key => id(request[key]))
    && typeof request.operationKey === 'string' && request.operationKey.trim() && request.operationKey.length <= 4096
    && (request.childRunId === undefined || id(request.childRunId))
    && ['get', 'subscribe', 'continue', 'cancel', 'reject'].includes(request.kind)
    && (request.kind === 'continue' ? typeof request.pauseDigest === 'string'
      && (Array.isArray(request.parts) && request.json === undefined || request.parts === undefined
        && typeof request.json === 'string' && request.json.length <= 1024 * 1024)
      : request.parts === undefined && request.json === undefined && (request.kind === 'reject'
        ? typeof request.pauseDigest === 'string' && /^[a-f0-9]{64}$/u.test(request.pauseDigest) : request.pauseDigest === undefined)), 'STUDIO_NATIVE_A2A_CONTROL_INVALID');
}
export function createStudioNativeA2aControl({ ctx, store, workspaceId, lifetime, active, agentEvents, childRecord }) {
  return function control(request, callerSignal) {
    validateNativeA2aControlRequest(request);
    const original = copy(request), originalBytes = canonical(request);
    const inputParts = original.json === undefined ? original.parts : [{ data: parseNativeJson(original.json) }];
    const signal = AbortSignal.any([lifetime.signal, ...(callerSignal ? [callerSignal] : []), AbortSignal.timeout(90000)]);
    const task = (async () => {
      signal.throwIfAborted();
      const managedControl = ctx.get('studioManagedNativeSessionControl');
      const query = { agentId: original.agentId, sessionId: original.sessionId, runId: original.runId, workspaceId };
      const managed = managedControl?.agentId === original.agentId ? managedControl.inspect(query) : null;
      const scope = managed?.scope ?? { tenantId: 'local', workspaceId, userId: 'local-user', agentId: original.agentId };
      invariant(scope.agentId === original.agentId && scope.workspaceId === workspaceId, 'STUDIO_NATIVE_A2A_IDENTITY_CONFLICT');
      const readRecord = managed ? () => {
        invariant(ctx.get('studioManagedNativeSessionControl') === managedControl, 'STUDIO_NATIVE_A2A_IDENTITY_CONFLICT');
        const current = managedControl.inspect(query);
        invariant(current && canonical(current.scope) === canonical(scope), 'STUDIO_NATIVE_A2A_IDENTITY_CONFLICT');
        return current.record;
      } : () => store.load(scope, original.runId);
      const parent = readRecord();
      invariant(parent, 'STUDIO_NATIVE_A2A_CALL_NOT_FOUND');
      const capsule = readNativeRecoveryBinding(parent, original);
      if (original.childRunId !== undefined) invariant(managed ? typeof managedControl.childRecord === 'function' : typeof childRecord === 'function',
        'STUDIO_NATIVE_A2A_CONTROL_UNAVAILABLE');
      const readEffect = original.childRunId === undefined ? readRecord : () => managed
        ? managedControl.childRecord({ ...query, childRunId: original.childRunId }) : childRecord?.(original);
      const record = readEffect();
      invariant(record && (original.childRunId === undefined || record.snapshot.runId === original.childRunId), 'STUDIO_NATIVE_A2A_CALL_NOT_FOUND');
      const intent = record.intents.find(intent => intent.operationKey === original.operationKey && intent.kind === 'tool');
      invariant(intent?.payload?.calls?.some(call => call.callId === original.callId && call.name === 'call_a2a_agent'),
        'STUDIO_NATIVE_A2A_CALL_NOT_FOUND');
      const controller = ctx.get('sessionController');
      invariant(typeof controller?.resolveAgent === 'function' && typeof agentEvents === 'function', 'STUDIO_NATIVE_A2A_CONTROL_UNAVAILABLE');
      const found = await awaitA2aControl(() => controller.resolveAgent(original.sessionId), signal);
      if (found.error) throw found.error;
      const agent = found.agent, session = agent?.session;
      invariant(session?.id === original.sessionId, 'STUDIO_NATIVE_A2A_IDENTITY_CONFLICT');
      const presetId = ctx.get('sessionProjections')?.stateOf?.(session, 'agentPreset');
      invariant(id(presetId), 'STUDIO_NATIVE_A2A_PRESET_UNAVAILABLE');
      const binding = await awaitA2aControl(() => agentEvents(ctx, agent).serial('agentkit/native-recovery-binding', {}), signal);
      assertNativeRecoveryPreset(capsule, binding);
      invariant(typeof binding.nativeTools?.controlA2aTask === 'function', 'STUDIO_NATIVE_A2A_CONTROL_UNAVAILABLE');
      const locator = { scope: copy(record.snapshot.scope), sessionId: record.snapshot.sessionId, runId: record.snapshot.runId,
        operationKey: original.operationKey, callId: original.callId };
      const assertControl = () => {
        signal.throwIfAborted();
        invariant(agent.session === session && session.id === original.sessionId && canonical(request) === originalBytes,
          'STUDIO_NATIVE_A2A_IDENTITY_CONFLICT');
        invariant(ctx.get('sessionProjections')?.stateOf?.(session, 'agentPreset') === presetId, 'STUDIO_NATIVE_A2A_PRESET_CHANGED');
        // The original persisted owner/configuration remains authoritative;
        // a human control does not reclaim its expired execution lease.
        const currentParent = readRecord(), current = readEffect();
        invariant(currentParent?.snapshot.configDigest === parent.snapshot.configDigest
          && current && current.snapshot.configDigest === record.snapshot.configDigest
          && ['runId', 'sessionId', 'turnId', 'buildId', 'parentRunId', 'taskChainId'].every(key => current.snapshot[key] === record.snapshot[key])
          && canonical(current.snapshot.scope) === canonical(record.snapshot.scope), 'STUDIO_NATIVE_A2A_IDENTITY_CONFLICT');
        return true;
      };
      return binding.nativeTools.controlA2aTask({ scope: locator.scope, sessionId: locator.sessionId, operation_locator: locator,
        kind: original.kind, commandId: original.commandId,
        authority: { contract: 'agentkit.studio-a2a-human-control/v1', agentId: original.agentId,
          sessionId: original.sessionId, runId: original.runId, agentRevision: capsule.agentRevision, buildId: capsule.buildId },
        ...(inputParts !== undefined ? { parts: inputParts } : {}),
        ...(original.pauseDigest !== undefined ? { pauseDigest: original.pauseDigest } : {}), signal }, {
        assertControl, ...(original.childRunId === undefined ? {} : { parentScope: scope }),
        authorizeControl: async ({ task, spec, command, readOnly, signal: consentSignal }) => {
          assertControl();
          if (readOnly) return 'allow';
          const policy = ctx.get('sandboxPolicy'), approval = ctx.get('approval');
          invariant(typeof policy?.resolve === 'function' && typeof approval?.request === 'function', 'STUDIO_NATIVE_A2A_PERMISSION_UNAVAILABLE');
          const checkPolicy = () => invariant(['read-only', 'workspace-write', 'danger-full-access'].includes(
            ctx.get('sandboxPolicy')?.resolve?.({ session })?.mode), 'STUDIO_NATIVE_A2A_PERMISSION_UNAVAILABLE');
          checkPolicy();
          // Human remote-task controls always require exact-command consent,
          // including under workspace-write. They do not inherit the original
          // model tool's policy result or a standing filesystem write grant.
          const outcome = await requestStudioA2aApproval({ ctx, agent, presetId, assertCurrent: assertControl,
            requireReceipt: Boolean(task.approval && !task.approval.decision || task.input && !task.input.decision),
            request: { agent, toolName: `a2a_${original.kind}_task`,
            callId: `a2a-control:${createHash('sha256').update(canonical({ locator, commandId: original.commandId })).digest('hex')}`, signal: consentSignal,
            reason: canonical({ action: original.kind, target: spec.local_name, targetAgentId: spec.target_agent_id,
              taskId: task.task_id, remoteTaskId: task.remote_task_id, commandId: original.commandId,
              ...(task.approval ? { approval: task.approval } : {}),
              ...(task.input ? { input: task.input } : {}),
              parts: command.parts }) } });
          assertControl(); checkPolicy();
          invariant(typeof ctx.get('approval')?.request === 'function', 'STUDIO_NATIVE_A2A_PERMISSION_UNAVAILABLE');
          const currentBinding = await awaitA2aControl(() => agentEvents(ctx, agent).serial('agentkit/native-recovery-binding', {}), signal);
          assertNativeRecoveryPreset(capsule, currentBinding);
          invariant(currentBinding.nativeTools === binding.nativeTools, 'STUDIO_NATIVE_A2A_PRESET_CHANGED');
          assertControl();
          if (typeof outcome === 'object') return { decision: outcome.outcome === 'allowed-once' ? 'allow' : 'deny',
            commandDigest: a2aDecisionDigest(command), receipt: outcome.receipt };
          return outcome === 'allowed-once' ? 'allow' : 'deny';
        },
      });
    })();
    active.add(task); void task.finally(() => active.delete(task)).catch(() => {}); return task;
  };
}
