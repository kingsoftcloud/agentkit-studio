/** Trusted Server interrupt routing. Resolve only original Native intents and
 * frozen owned children; a public scope ID cannot supply a locator or consent. */
import { canonical, copy, invariant, terminal } from '@kingsoftcloud/agentkit-harness-core';
import { assertNativeRecoveryPreset, readNativeRecoveryBinding } from '../../providers/native-recovery-binding.mjs';
import { awaitA2aControl } from '../../providers/native-a2a-controls.mjs';
import { a2aDecisionDigest as hash } from '../../providers/native-a2a-decision.mjs';
import { A2A_SCOPE_CANCELLATION } from '../../providers/native-a2a-scope-cancellation.mjs';
import { MANAGED_NATIVE_SCOPED_CONTROL } from '../../providers/native-managed-scoped-control.mjs';

const identity = snapshot => Object.fromEntries(['scope', 'sessionId', 'runId', 'turnId', 'buildId', 'parentRunId', 'taskChainId', 'configDigest']
  .map(key => [key, snapshot[key]]));
const calls = record => record.intents.filter(intent => intent.kind === 'tool').flatMap(intent => (intent.payload.calls ?? [])
  .filter(call => call.name === 'call_a2a_agent').map(call => ({ intent, call, locator: {
    scope: copy(record.snapshot.scope), sessionId: record.snapshot.sessionId, runId: record.snapshot.runId,
    operationKey: intent.operationKey, callId: call.callId } })));
const matches = (record, scopeId) => calls(record).filter(value => `a2a-${hash(value.locator)}` === scopeId);

export function createStudioNativeManagedScopeControl({ ctx, workspaceId, lifetime, active, agentEvents, readChildren }) {
  function original(command, run, signal) {
    signal.throwIfAborted(); lifetime.signal.throwIfAborted();
    const service = ctx.get('studioManagedNativeSessionControl');
    invariant(service?.agentId === command.agent_instance_id && command.command_type === 'interrupt'
      && run.scope?.tenantId === command.tenant_id && run.scope.workspaceId === workspaceId
      && run.sessionId === command.session_id && run.record, 'NATIVE_MANAGED_SCOPE_NOT_FOUND');
    const query = { agentId: command.agent_instance_id, sessionId: command.session_id, runId: run.runId, workspaceId };
    const read = () => {
      signal.throwIfAborted(); lifetime.signal.throwIfAborted();
      invariant(ctx.get('studioManagedNativeSessionControl') === service, 'NATIVE_MANAGED_SCOPE_TARGET_CHANGED');
      const value = service.inspect(query);
      invariant(value?.record && !terminal(value.record.snapshot.phase)
        && canonical(identity(value.record.snapshot)) === canonical(identity(run.record.snapshot)), 'NATIVE_MANAGED_SCOPE_UNAVAILABLE');
      return value.record;
    };
    read(); return { service, query, read };
  }
  async function bindingFor(command, record, signal) {
    const capsule = readNativeRecoveryBinding(record, { agentId: command.agent_instance_id, sessionId: command.session_id, runId: record.snapshot.runId });
    const controller = ctx.get('sessionController');
    invariant(typeof controller?.resolveAgent === 'function' && typeof agentEvents === 'function', 'NATIVE_MANAGED_SCOPE_UNAVAILABLE');
    // The original turn can still own the Session. Waiting for whenIdle here
    // would deadlock cancellation behind the remote task it needs to cancel.
    const found = await awaitA2aControl(() => controller.resolveAgent(command.session_id), signal);
    if (found.error) throw found.error;
    const agent = found.agent, session = agent?.session;
    invariant(session?.id === command.session_id, 'NATIVE_MANAGED_SCOPE_TARGET_CHANGED');
    const presetId = ctx.get('sessionProjections')?.stateOf?.(session, 'agentPreset');
    invariant(typeof presetId === 'string' && presetId, 'NATIVE_MANAGED_SCOPE_UNAVAILABLE');
    const binding = await awaitA2aControl(() => agentEvents(ctx, agent).serial('agentkit/native-recovery-binding', {}), signal);
    assertNativeRecoveryPreset(capsule, binding);
    invariant(typeof binding.nativeTools?.inspectA2aTask === 'function'
      && typeof binding.nativeTools.controlA2aTask === 'function', 'NATIVE_MANAGED_SCOPE_UNAVAILABLE');
    return { capsule, agent, session, presetId, binding };
  }
  async function prepare({ command, run, signal }) {
    const owned = original(command, run, signal), root = owned.read(), scopeId = command.payload.scope_id;
    let selected = matches(root, scopeId).map(value => ({ ...value, record: root, childRunId: null }));
    if (!selected.length) {
      let offset = 0, digest;
      for (;;) {
        const page = await readChildren({ ...owned.query, offset, limit: 64, ...(digest ? { inventoryDigest: digest } : {}) }, signal);
        owned.read(); digest = page.inventoryDigest;
        for (const task of page.tasks.filter(task => task.parentRunId === run.runId && task.a2aTasks?.length)) {
          const record = owned.service.childRecord({ ...owned.query, childRunId: task.childRunId });
          selected.push(...matches(record, scopeId).map(value => ({ ...value, record, childRunId: task.childRunId })));
        }
        if (page.complete) break;
        invariant(page.nextOffset > offset, 'NATIVE_MANAGED_SCOPE_TARGET_CHANGED'); offset = page.nextOffset;
      }
    }
    invariant(selected.length === 1, 'NATIVE_MANAGED_SCOPE_NOT_FOUND');
    const selectedCall = selected[0], bound = await bindingFor(command, root, signal); owned.read();
    const target = { scopeId, root: identity(root.snapshot), source: identity(selectedCall.record.snapshot),
      childRunId: selectedCall.childRunId, locator: selectedCall.locator };
    const inspected = bound.binding.nativeTools.inspectA2aTask({ scope: target.locator.scope, sessionId: target.locator.sessionId,
      operation_locator: target.locator, signal, authority: { contract: MANAGED_NATIVE_SCOPED_CONTROL } }, {
      assertControl: () => { owned.read(); return true; }, ...(target.childRunId ? { parentScope: run.scope } : {}) });
    validateInvocation(inspected, target, selectedCall.record);
    return { ...target, requestDigest: inspected.requestDigest, nativeDigest: hash(inspected.native), spec: inspected.spec };
  }
  function validateInvocation(inspected, target, record) {
    const selected = matches(record, target.scopeId).find(value => canonical(value.locator) === canonical(target.locator));
    invariant(inspected?.scopeId === target.scopeId && selected && inspected.native
      && Object.entries(identity(record.snapshot)).filter(([key]) => key !== 'configDigest')
        .every(([key, value]) => canonical(inspected.native[key]) === canonical(value))
      && inspected.native.operationKey === selected.intent.operationKey
      && inspected.native.executionFence === selected.intent.claimedFence
      && canonical(inspected.native.call) === canonical(selected.call)
      && canonical(inspected.native.definition) === canonical(record.configuration.tools.find(tool => tool.name === 'call_a2a_agent')),
    'NATIVE_MANAGED_SCOPE_TARGET_CHANGED');
    if (target.requestDigest) invariant(inspected.requestDigest === target.requestDigest
      && hash(inspected.native) === target.nativeDigest && canonical(inspected.spec) === canonical(target.spec), 'NATIVE_MANAGED_SCOPE_TARGET_CHANGED');
  }
  function originalPermission(bound, target) {
    const mode = ctx.get('sandboxPolicy')?.resolve?.({ session: bound.session })?.mode;
    invariant(['read-only', 'workspace-write', 'danger-full-access'].includes(mode), 'STUDIO_NATIVE_A2A_PERMISSION_UNAVAILABLE');
    if (mode !== 'read-only' && target.spec.policy_ref !== 'policy://a2a/strict') return;
    // Node dispatch hashes the exact original Native locator into its SDK call
    // ID. Reuse only that call's real approval audit, never a Server signature
    // or a different call's standing permission.
    const callId = `ak-native-${hash({ scope: target.locator.scope, runId: target.locator.runId,
      operationKey: target.locator.operationKey, callId: target.locator.callId })}`;
    const events = bound.session.snapshotEvents?.() ?? [];
    const asked = events.filter(event => event.type === 'approval/asked' && event.data?.callId === callId
      && event.data.toolName === 'call_a2a_agent').at(-1);
    const decided = asked && events.filter(event => event.type === 'approval/decided' && event.data?.id === asked.data.id && event.seq > asked.seq).at(-1);
    invariant(decided?.data.outcome === 'allowed-once', 'STUDIO_NATIVE_A2A_PERMISSION_UNAVAILABLE');
  }
  async function execute(input) {
    const { command, run, target, actor, assertCurrent } = input;
    const signal = AbortSignal.any([input.signal, lifetime.signal]);
    const owned = original(command, run, signal), root = owned.read(), bound = await bindingFor(command, root, signal);
    const readSource = () => target.childRunId ? owned.service.childRecord({ ...owned.query, childRunId: target.childRunId }) : owned.read();
    const guard = () => {
      assertCurrent(); const root = owned.read(), source = readSource();
      invariant(canonical(identity(root.snapshot)) === canonical(target.root)
        && canonical(identity(source.snapshot)) === canonical(target.source)
        && bound.agent.session === bound.session
        && ctx.get('sessionProjections')?.stateOf?.(bound.session, 'agentPreset') === bound.presetId, 'NATIVE_MANAGED_SCOPE_TARGET_CHANGED');
      return true;
    };
    const authority = { contract: MANAGED_NATIVE_SCOPED_CONTROL, commandId: command.command_id, actor, rootRunId: run.runId };
    const options = { assertControl: guard, ...(target.childRunId ? { parentScope: run.scope } : {}) };
    guard();
    validateInvocation(bound.binding.nativeTools.inspectA2aTask({ scope: target.locator.scope, sessionId: target.locator.sessionId,
      operation_locator: target.locator, authority, signal }, options), target, readSource());
    return bound.binding.nativeTools.controlA2aTask({ scope: target.locator.scope, sessionId: target.locator.sessionId,
      operation_locator: target.locator, kind: 'cancel', commandId: command.command_id, authority, signal }, {
      ...options, authorizeControl: async ({ command: cancel, readOnly }) => {
        guard();
        if (readOnly) return 'allow'; // Original uncertain command is observed, never sent again.
        originalPermission(bound, target);
        const current = await awaitA2aControl(() => agentEvents(ctx, bound.agent).serial('agentkit/native-recovery-binding', {}), signal);
        assertNativeRecoveryPreset(bound.capsule, current);
        invariant(current.nativeTools === bound.binding.nativeTools, 'NATIVE_MANAGED_SCOPE_TARGET_CHANGED');
        guard(); originalPermission(bound, target);
        return { decision: 'allow', scopeCancellation: { contract: A2A_SCOPE_CANCELLATION, commandId: command.command_id,
          scopeId: target.scopeId, requestDigest: target.requestDigest, commandDigest: hash(cancel),
          nativeDigest: target.nativeDigest, locator: target.locator, actor, rootRunId: run.runId } };
      } });
  }
  return Object.freeze({ prepare, execute(input) {
    const task = execute(input); active.add(task); void task.finally(() => active.delete(task)).catch(() => {}); return task;
  } });
}
