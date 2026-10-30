import { canonical, copy, invariant } from '@kingsoftcloud/agentkit-harness-core';
import { createNativeChildHistory, mergeNativeChildHistory } from '@kingsoftcloud/agentkit-harness-node/native/child-history';

/** Authenticated child observations and exact durable command confirmation. */
export function createStudioNativeChildViews({ ctx, controls, controlKey, controlFor, store, localStore,
  workspaceId, lifetime, childObservations, isClosed, getRecovery }) {
  const childCommand = (request, command, invoke) => {
    const current = controls.get(controlKey(request.agentId, request.sessionId));
    if (current?.runId === request.runId) return invoke(controlFor(request));
    // A lost reply may be confirmed after the original turn releases its live
    // ports. Only an exact already-persisted command is a read-only duplicate;
    // history cannot authorize a new child operation or install another driver.
    invariant(!isClosed() && typeof request.runId === 'string' && request.runId.trim(), 'studio_native_child_control_run_unavailable');
    const managed = ctx.get('studioManagedNativeSessionControl');
    let record = managed?.agentId === request.agentId ? managed.inspect({ agentId: request.agentId,
      sessionId: request.sessionId, runId: request.runId, workspaceId })?.record : null;
    if (!record) {
      try { record = localStore.load({ tenantId: 'local', workspaceId, userId: 'local-user', agentId: request.agentId }, request.runId); }
      catch (error) { if (error.code !== 'run_not_found') throw error; }
    }
    invariant(record?.snapshot.sessionId === request.sessionId, 'studio_native_child_control_run_unavailable');
    const existing = record.commands.find(row => row.command.commandId === command.commandId);
    invariant(existing, 'studio_native_child_control_run_unavailable');
    invariant(canonical(existing.command) === canonical(command), 'command_replay_conflict');
    return { commandId: command.commandId, status: 'duplicate', reason: null };
  };
  const liveChildTasks = (request, scope, selectedStore) => runId => {
    const control = controls.get(controlKey(request.agentId, request.sessionId));
    if (!control || control.runId !== runId || canonical(control.scope) !== canonical(scope)
      || (control.store ?? localStore) !== selectedStore) return [];
    control.assertCurrent?.();
    return (selectedStore.authority?.(scope, runId) ?? selectedStore.load(scope, runId)).configuration.childLifecyclePolicy === 'owned-background/v2'
      ? control.kernel.childTasks(scope, runId) : [];
  };
  const childHistory = request => {
    invariant(!isClosed() && typeof request?.agentId === 'string' && request.agentId.trim()
      && request.agentId.length <= 256, 'studio_native_child_history_invalid');
    const scope = { tenantId: 'local', workspaceId, userId: 'local-user', agentId: request.agentId };
    return createNativeChildHistory({ scope, store, liveTasks: liveChildTasks(request, scope, store), liveObservation: childObservations.read });
  };
  const readChildren = (request, signal, result = false) => {
    signal?.throwIfAborted(); lifetime.signal.throwIfAborted();
    const service = ctx.get('studioManagedNativeSessionControl');
    const managedView = service?.agentId === request.agentId ? service.inspect({ agentId: request.agentId,
      sessionId: request.sessionId, workspaceId, ...(request.runId === undefined ? {} : { runId: request.runId }) }) : null;
    if (!managedView)
      return childHistory(request)[result ? 'result' : 'list'](request);
    if (request.runId !== undefined) {
      // A historical read is not recovery of the current SDK turn. The bound
      // service checks this exact original admission/principal and ancestry,
      // even while a different ordinary/managed turn owns the Session.
      const control = controls.get(controlKey(request.agentId, request.sessionId));
      return service.childHistory({ ...request, workspaceId }, { result,
        liveTasks: control?.store ? liveChildTasks(request, managedView.scope, control.store) : undefined });
    }
    const original = copy(request), bytes = canonical(request);
    return getRecovery().inspect({ agentId: original.agentId, sessionId: original.sessionId,
      ...(original.runId === undefined ? {} : { runId: original.runId }) }, signal).then(inspected => {
      signal?.throwIfAborted(); lifetime.signal.throwIfAborted();
      invariant(canonical(request) === bytes, 'studio_native_child_history_invalid');
      const control = controls.get(controlKey(original.agentId, original.sessionId));
      const managed = inspected.managedControl ?? service;
      invariant(ctx.get('studioManagedNativeSessionControl') === managed, 'NATIVE_MANAGED_STATUS_IDENTITY_MISMATCH');
      const managedOptions = { liveTasks: control?.store ? liveChildTasks(original, managedView.scope, control.store) : undefined };
      // Each history authenticates its own tenant/principal, frozen roles and
      // ancestry. Merge only read models; commands still target the original
      // parent and its existing owner. Explicit runId reads remain owner-local.
      const local = childHistory(original), identity = { sessionId: original.sessionId };
      const localInventory = local.inventory(identity);
      const managedInventory = managed.childHistory({ agentId: original.agentId, sessionId: original.sessionId, workspaceId },
        { ...managedOptions, inventory: true });
      const inventories = inspected.managed ? [managedInventory, localInventory] : [localInventory, managedInventory];
      const page = mergeNativeChildHistory(result ? identity : original, inventories);
      if (!result) return page;
      const matches = inventories.filter(value => value.tasks.some(task => task.childRunId === original.childRunId));
      invariant(matches.length === 1, 'child_history_result_unavailable');
      const task = matches[0].tasks.find(task => task.childRunId === original.childRunId);
      const selected = { ...original, runId: task.parentRunId };
      const detail = matches[0] === localInventory ? local.result(selected)
        : managed.childHistory({ ...selected, workspaceId }, { ...managedOptions, result: true });
      return { ...detail, runId: page.runId };
    });
  };
  return { childCommand, childHistory, readChildren };
}
