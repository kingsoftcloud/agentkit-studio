import { createHash, randomUUID } from 'node:crypto';
import { NativeKernel, NativeError, CHILD_OWNER_CONTRACT, canonical, copy, configure,
  addUsage, admittedToolBudget, childLifecycleRequest, childReadyProbe, scopeKey, terminal,
  CHILD_TASK_POLICY, COORDINATOR_RESPONSE_POLICY, activePlanMode, isPlanChildCall, planModeWriteDenial,
  CHILD_PLAN_POLICY, CHILD_PLAN_MODE_POLICY, defaultPolicyBindings } from '@kingsoftcloud/agentkit-harness-core';
import { loadSessionChild, accountedChildDelivery, hasUnsafeChildReceipt } from './owned-child.mjs';

const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const check = (value, code) => { if (!value) throw new NativeError(code); };
const same = (left, right) => canonical(left) === canonical(right);
const identity = value => Object.fromEntries(['scope', 'runId', 'sessionId', 'turnId', 'buildId', 'parentRunId', 'taskChainId'].map(key => [key, copy(value[key])]));
const locator = request => `native-child-${hash({ scope: request.scope, parentRunId: request.runId, operationKey: request.operationKey })}`;

/** Detach only this observer. Execution is owned by the child Kernel and ledger. */
async function observeWhileLive(operation, signal) {
  signal.throwIfAborted();
  let onAbort;
  const canceled = new Promise((_, reject) => {
      onAbort = () => reject(signal.reason instanceof NativeError ? signal.reason : new NativeError('child_observation_paused'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { const result = await Promise.race([operation, canceled]); signal.throwIfAborted(); return result; }
  finally { signal.removeEventListener('abort', onAbort); }
}

/**
 * Durable owner for background children. resolveChild/restoreChild are trusted
 * Host bindings; they provide already admitted models/tools/workspaces, never
 * an environment/profile fallback. This service does not advertise model tools.
 */
export function createNativeChildOwner({ scope, childScopes = [scope], store, resolveChild, restoreChild, waitForIdle, canWaitForReceipt, onStream, now = Date.now,
  owner = `native-children-${randomUUID()}` }) {
  const parentScope = copy(scope), entries = new Map();
  scopeKey(parentScope);
  const scopes = copy(childScopes);
  check(Array.isArray(scopes) && scopes.length > 0 && scopes.every(item => {
    scopeKey(item); return ['tenantId', 'workspaceId', 'userId'].every(key => item[key] === parentScope[key]);
  }), 'invalid_child_owner_scopes');
  check(store && typeof resolveChild === 'function' && typeof owner === 'string' && owner.trim(), 'invalid_child_owner');
  check(waitForIdle === undefined && canWaitForReceipt === undefined
    || typeof waitForIdle === 'function' && typeof canWaitForReceipt === 'function', 'invalid_child_idle_owner');
  const effective = record => record.snapshot.taskContract ? { ...record.configuration, contract: record.snapshot.taskContract } : record.configuration;
  const parentRecord = request => {
    check(same(request.scope, parentScope), 'child_parent_scope_mismatch');
    const record = store.load(parentScope, request.runId);
    check(same(identity(request), identity(record.snapshot)), 'child_parent_identity_mismatch');
    return record;
  };
  const toolInvocation = request => {
    const record = parentRecord(request), intent = record.intents.find(item => item.operationKey === request.operationKey);
    const calls = intent?.payload.calls, config = effective(record);
    check(intent?.kind === 'tool' && intent.status === 'running' && record.snapshot.pendingIntent === request.operationKey
      && intent.claimedFence === request.executionFence && record.lease?.fence === request.executionFence && record.lease.expiresAt > now()
      && Array.isArray(calls) && calls.length === 1 && same(calls[0], request.call)
      && same(config.tools.find(tool => tool.name === request.call.name), request.definition)
      && same(intent.payload.interaction, request.interaction)
      && same(admittedToolBudget(record.snapshot, config, 1), request.budget), 'child_start_not_owned');
    return record;
  };
  const startupReceipt = (reservation, role) => ({ status: 'ok', content: { status: 'started', child_run_id: reservation.childRunId, role,
    instruction: 'The task is owned and its budget is reserved. Findings are not available in this startup receipt.' },
  childBudgetReservation: copy(reservation) });
  const makeReservation = (record, childScope) => {
    const binding = record.configuration.childOwnerBinding;
    return { childRunId: record.snapshot.runId, childScope: copy(childScope), parentOperationKey: binding.parentOperationKey,
      parentToolCallId: binding.parentToolCallId, childRequestDigest: binding.childRequestDigest,
      configurationDigest: record.snapshot.configDigest, maxModelCalls: binding.maxModelCalls,
      maxToolCalls: binding.maxToolCalls, settledUsageDigest: null,
      ...(binding.deliveryMode ? { deliveryMode: binding.deliveryMode } : {}) };
  };
  const attachKernel = (record, ports) => {
    check(ports && typeof ports.model?.generate === 'function' && typeof ports.tools?.execute === 'function', 'child_ports_unavailable');
    const binding = record.configuration.childOwnerBinding;
    const admitted = () => {
      const parent = store.load(binding.parent.scope, binding.parent.runId);
      if (terminal(parent.snapshot.phase) || parent.snapshot.phase === 'finalizing' || parent.snapshot.childTerminalPhase
        || parent.commands.some(row => !row.consumed && ['cancel', 'policy_revoked'].includes(row.command.kind))) return false;
      const reservation = (parent.snapshot.childBudgetReservations ?? []).find(item => item.childRunId === record.snapshot.runId);
      if (reservation) return reservation.configurationDigest === record.snapshot.configDigest
        && reservation.childRequestDigest === binding.childRequestDigest && reservation.settledUsageDigest === null;
      const start = parent.intents.find(item => item.operationKey === binding.parentOperationKey);
      return start?.status === 'running' && parent.snapshot.pendingIntent === binding.parentOperationKey
        && start.claimedFence === binding.parentExecutionFence && parent.lease?.fence === binding.parentExecutionFence && parent.lease.expiresAt > now();
    };
    const guarded = { ...ports, model: { ...ports.model, generate: (request, emit) => admitted()
      ? ports.model.generate(request, emit) : Promise.resolve({ kind: 'policy_abort', text: '', toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0, modelCalls: 0, toolCalls: 0, cost: 0 }, usageReported: true }) },
    tools: { ...ports.tools, execute: (request, lifecycle) => admitted() ? ports.tools.execute(request, lifecycle)
      : Promise.resolve({ status: 'error', content: { code: 'child_parent_authority_lost', executed: false } }) } };
    for (const [port, method] of [['hooks', 'invoke'], ['verification', 'verify'], ['artifacts', 'write'], ['input', 'prepare']]) {
      if (typeof ports[port]?.[method] !== 'function') continue;
      guarded[port] = { ...ports[port], [method]: (...args) => {
        check(admitted(), 'child_parent_authority_lost'); return ports[port][method](...args);
      } };
      if (port === 'artifacts') for (const reader of ['read', 'search']) {
        if (typeof ports.artifacts[reader] === 'function') guarded.artifacts[reader] = (...args) => ports.artifacts[reader](...args);
      }
    }
    const entry = { scope: copy(record.snapshot.scope), runId: record.snapshot.runId, configuration: copy(record.configuration),
      kernel: new NativeKernel({ store, ports: guarded, owner: `${owner}:${record.snapshot.runId}`, digest: hash, onStream }),
      ports, admitted, idle: null, promise: null, error: null };
    entries.set(record.snapshot.runId, entry); return entry;
  };
  const submit = (entry, command) => {
    const receipt = entry.kernel.submit(entry.scope, entry.runId, command);
    // A queued child control interrupts only this local observer. The Kernel
    // consumes the durable command, including cancellation, on the next pass.
    entry.idle?.abort(new NativeError('child_idle_woken'));
    return receipt;
  };
  const drive = entry => {
    if (entry.promise) return entry.promise;
    entry.error = null;
    entry.promise = (async () => {
      for (;;) {
        const snapshot = await entry.kernel.runUntilIdle(entry.scope, entry.runId);
        if (terminal(snapshot.phase)) { entry.ports.tools.settleQuestions?.(snapshot); return; }
        const record = store.load(entry.scope, entry.runId);
        if (!canWaitForReceipt?.(record) || !entry.admitted()) return;
        const idle = new AbortController(); entry.idle = idle;
        try {
          const command = await observeWhileLive(Promise.resolve().then(() => waitForIdle({
            snapshot: copy(snapshot), tools: entry.ports.tools, signal: idle.signal,
          })), idle.signal);
          idle.signal.throwIfAborted();
          check(entry.admitted() && same(store.load(entry.scope, entry.runId).snapshot, snapshot), 'child_idle_authority_lost');
          if (!command) return;
          check(submit(entry, command).status !== 'rejected', 'child_idle_command_rejected');
        } catch (error) {
          if (!idle.signal.aborted || idle.signal.reason?.code !== 'child_idle_woken') throw error;
        } finally { if (entry.idle === idle) entry.idle = null; idle.abort(); }
      }
    })().catch(error => { entry.error = error; })
      .finally(() => { entry.promise = null; });
    return entry.promise;
  };
  const ownedChild = (request, reservation) => {
    check(scopes.some(item => same(item, reservation.childScope)), 'child_scope_not_admitted');
    const record = store.load(reservation.childScope, reservation.childRunId), binding = record.configuration.childOwnerBinding;
    check(binding?.contract === CHILD_OWNER_CONTRACT && same(binding.parent, identity(request))
      && binding.parentOperationKey === reservation.parentOperationKey && binding.parentToolCallId === reservation.parentToolCallId
      && binding.childRequestDigest === reservation.childRequestDigest && binding.maxModelCalls === reservation.maxModelCalls
      && binding.deliveryMode === reservation.deliveryMode
      && binding.maxToolCalls === reservation.maxToolCalls && record.snapshot.configDigest === reservation.configurationDigest
      && hash(record.configuration) === reservation.configurationDigest, 'child_owner_binding_mismatch');
    return record;
  };
  const liveEntry = async (request, reservation, record) => {
    let entry = entries.get(reservation.childRunId);
    if (!entry && !terminal(record.snapshot.phase)) {
      check(typeof restoreChild === 'function', 'child_owner_unavailable');
      request.signal.throwIfAborted();
      const ports = await observeWhileLive(Promise.resolve().then(() => restoreChild({ identity: identity(record.snapshot),
        configuration: copy(record.configuration), binding: copy(record.configuration.childOwnerBinding) })), request.signal);
      request.signal.throwIfAborted();
      entry = attachKernel(record, ports);
    }
    return entry;
  };
  const unsafeReceipt = hasUnsafeChildReceipt;
  const continuationSource = request => {
    const args = request.call.arguments;
    if (args.continuation_of === undefined) return null;
    const resolved = loadSessionChild({ store, childScopes: scopes, parent: toolInvocation(request).snapshot,
      childRunId: args.continuation_of });
    check(resolved, 'child_followup_not_available');
    check(resolved.child.configuration.childOwnerBinding.role === args.role, 'child_followup_role_mismatch');
    check(accountedChildDelivery(resolved.parent, resolved.child), 'child_followup_requires_result_collection');
    return resolved;
  };
  const responses = (record, cursors) => record.configuration.coordinatorResponsePolicy === COORDINATOR_RESPONSE_POLICY
    ? record.events.filter(event => event.kind === 'coordinator.response_queued'
      && event.seq > (cursors?.[record.snapshot.runId] ?? 0)).map(event => ({ childRunId: record.snapshot.runId,
        sequence: event.seq, ...copy(event.payload) })) : [];
  const terminalReceipt = (record, reservation, includeResponses = true) => {
    check(terminal(record.snapshot.phase) && record.snapshot.phase !== 'interrupted' && !unsafeReceipt(record), 'child_receipt_unavailable');
    const parent = store.load(record.configuration.childOwnerBinding.parent.scope, record.configuration.childOwnerBinding.parent.runId);
    return { status: record.snapshot.phase === 'completed' ? 'ok' : 'error', content: {
      child_run_id: record.snapshot.runId, status: record.snapshot.phase, outcome: record.snapshot.outcome,
      reason: record.snapshot.reason, result: record.snapshot.finalText, parent_acceptance: 'not_evaluated' },
    resourceUsage: addUsage(record.snapshot.usage, record.snapshot.descendantUsage),
    ...(includeResponses && parent.configuration.childTaskPolicy === CHILD_TASK_POLICY
      ? { coordinatorResponses: responses(record, parent.snapshot.childResponseCursors) } : {}),
    childRunIds: [record.snapshot.runId, ...(record.snapshot.childRunIds ?? [])],
    childBudgetSettlement: { childRunId: record.snapshot.runId, parentOperationKey: reservation.parentOperationKey,
      childRequestDigest: reservation.childRequestDigest, terminalSnapshotDigest: hash(record.snapshot) },
    metadata: { usageReported: record.snapshot.diagnostics.providerUsageIncomplete !== true
      && record.snapshot.diagnostics.descendantUsageIncomplete !== true
      && !record.receipts.some(receipt => receipt.status === 'uncertain') } };
  };
  const childApproval = (record, reservation) => {
    const pending = record.snapshot.pendingInteraction;
    const call = record.snapshot.pendingTools.find(item => item.callId === pending?.callId);
    const definition = record.configuration.tools.find(item => item.name === call?.name);
    check(pending && call && definition, 'child_approval_unavailable');
    return { childRunId: record.snapshot.runId, childScope: copy(record.snapshot.scope), parentOperationKey: reservation.parentOperationKey,
      parentToolCallId: reservation.parentToolCallId, interactionId: pending.interactionId, hostInteractionId: pending.hostInteractionId,
      toolCall: copy(call), definitionDigest: hash(definition) };
  };
  const foregroundResult = async (request, reservation) => {
    let record = ownedChild(request, reservation);
    const entry = await liveEntry(request, reservation, record);
    const startup = () => startupReceipt(reservation, record.configuration.childOwnerBinding.role);
    const cancel = () => {
      if (entry && !terminal(store.load(entry.scope, entry.runId).snapshot.phase)) {
        submit(entry, { commandId: `foreground-cancel-${hash({ parent: request.runId,
          operationKey: request.operationKey })}`, kind: 'cancel', payload: {} });
        drive(entry);
      }
    };
    request.signal.addEventListener('abort', cancel, { once: true });
    try {
      if (request.signal.aborted) cancel();
      request.signal.throwIfAborted();
      toolInvocation(request);
      if (entry && !terminal(record.snapshot.phase)) drive(entry);
      while (!terminal(record.snapshot.phase) && record.snapshot.phase !== 'awaiting_interaction') {
        request.signal.throwIfAborted(); const parent = toolInvocation(request);
        if (parent.commands.some(row => !row.consumed && ['pause', 'promote_child', 'message_child', 'cancel_child'].includes(row.command.kind))
          || entry?.error && entry.error.code !== 'lease_busy') return startup();
        await observeWhileLive(new Promise(resolve => setTimeout(resolve, 25)), request.signal);
        record = ownedChild(request, reservation);
        if (entry?.error?.code === 'lease_busy') drive(entry);
      }
      request.signal.throwIfAborted(); toolInvocation(request);
      if (record.snapshot.phase === 'awaiting_interaction' || record.snapshot.phase === 'interrupted' || unsafeReceipt(record)) return startup();
      return { ...terminalReceipt(record, reservation), childBudgetReservation: copy(reservation) };
    } finally { request.signal.removeEventListener('abort', cancel); }
  };
  const projection = (record, reservation) => ({ runId: record.snapshot.runId, sessionId: record.snapshot.sessionId,
    operationKey: reservation.parentOperationKey, callId: reservation.parentToolCallId,
    state: unsafeReceipt(record) && !canWaitForReceipt?.(record) ? 'interrupted' : record.snapshot.phase === 'created' ? 'prepared' : record.snapshot.phase === 'awaiting_interaction' ? 'awaiting_interaction'
      : terminal(record.snapshot.phase) ? record.snapshot.phase : 'running',
    reservedModelCalls: reservation.maxModelCalls, reservedToolCalls: reservation.maxToolCalls,
    usage: addUsage(record.snapshot.usage, record.snapshot.descendantUsage), notified: false, metadata: {} });

  return Object.freeze({
    contract: CHILD_OWNER_CONTRACT,
    async admitPlan(request) {
      try {
        request.signal.throwIfAborted();
        const parent = toolInvocation(request);
        if (!activePlanMode(parent.snapshot, effective(parent)) || !isPlanChildCall(effective(parent), request.call, request.definition)) return false;
        if (request.definition.childBudgetPolicy === 'settle/v1') {
          const reservation = parent.snapshot.childBudgetReservations.find(item => item.childRunId === request.call.arguments.child_run_id);
          if (!reservation) return false;
          ownedChild(request, reservation);
        }
        return true;
      } catch { return false; }
    },
    tasks(request) {
      const parent = parentRecord(request), snapshot = parent.snapshot;
      const rows = [];
      for (const childScope of scopes) for (const child of store.list(childScope)) {
        const record = store.load(childScope, child.runId), binding = record.configuration.childOwnerBinding;
        if (!binding || !same(binding.parent, identity(request))) continue;
        let reservation = snapshot.childBudgetReservations.find(item => item.childRunId === child.runId);
        if (!reservation) {
          const intent = parent.intents.find(item => item.operationKey === binding.parentOperationKey);
          const call = intent?.payload.calls?.[0];
          if (intent?.kind !== 'tool' || intent.status !== 'running' || intent.payload.calls.length !== 1
            || snapshot.pendingIntent !== intent.operationKey || intent.claimedFence !== binding.parentExecutionFence
            || parent.lease?.fence !== binding.parentExecutionFence || parent.lease.expiresAt <= now()
            || call.callId !== binding.parentToolCallId
            || !['start/v1', 'delegate/v1'].includes(effective(parent).tools.find(tool => tool.name === call.name)?.childBudgetPolicy)
            || hash({ parent: identity(snapshot), operationKey: intent.operationKey, call, budget: admittedToolBudget(snapshot, effective(parent), 1) }) !== binding.childRequestDigest) continue;
          reservation = makeReservation(record, childScope);
        }
        ownedChild(request, reservation);
        const delivery = reservation.deliveryMode === 'foreground' && !(snapshot.promotedChildRunIds ?? []).includes(child.runId)
          ? 'foreground' : 'background';
        const live = !terminal(snapshot.phase) && snapshot.phase !== 'finalizing' && !snapshot.childTerminalPhase
          && !parent.commands.some(row => !row.consumed && ['cancel', 'policy_revoked'].includes(row.command.kind))
          && !terminal(child.phase) && (!unsafeReceipt(record) || canWaitForReceipt?.(record)) && reservation.settledUsageDigest === null;
        rows.push({ childRunId: child.runId, sessionId: child.sessionId, role: binding.role, phase: child.phase, goalRevision: child.goalRevision, delivery,
          canPromote: live && delivery === 'foreground' && effective(parent).childPromotionPolicy === 'owned-child-promotion/v1',
          canCancel: live, canSendInput: live });
      }
      return rows;
    },
    controlTarget(request, childRunId) {
      const row = this.tasks(request).find(task => task.childRunId === childRunId);
      if (!row) return null;
      for (const childScope of scopes) {
        let record;
        try { record = store.load(childScope, childRunId); }
        catch (error) { if (error.code === 'run_not_found') continue; throw error; }
        if (!same(record.configuration.childOwnerBinding?.parent, identity(request))) continue;
        const reservation = makeReservation(record, childScope);
        ownedChild(request, reservation);
        return { scope: copy(childScope), runId: childRunId, configurationDigest: record.snapshot.configDigest,
          parentOperationKey: reservation.parentOperationKey, parentToolCallId: reservation.parentToolCallId };
      }
      return null;
    },
    async wakeControl(request, delivery) {
      const parent = parentRecord(request), target = delivery.target;
      const reservation = parent.snapshot.childBudgetReservations.find(item => item.childRunId === target.runId);
      check(reservation && reservation.settledUsageDigest === null, 'child_control_not_owned');
      const record = ownedChild(request, reservation);
      check(same(record.snapshot.scope, target.scope) && record.snapshot.configDigest === target.configurationDigest
        && record.commands.some(row => same(row.command, delivery.command)), 'child_control_delivery_missing');
      if (terminal(record.snapshot.phase)) return;
      const entry = await liveEntry({ ...request, signal: new AbortController().signal }, reservation, record);
      check(entry, 'child_owner_unavailable');
      // Only an exact duplicate of the transactionally admitted command may
      // notify an active Kernel. Cancellation interrupts its existing effect.
      check(submit(entry, delivery.command).status === 'duplicate', 'child_control_delivery_missing');
      if (record.snapshot.phase !== 'awaiting_interaction' || delivery.command.kind === 'cancel') drive(entry);
    },
    async start(request) {
      try {
        request.signal.throwIfAborted();
        const parent = toolInvocation(request), inheritedPlan = effective(parent).childPlanPolicy === CHILD_PLAN_POLICY;
        if (activePlanMode(parent.snapshot, effective(parent)) && !isPlanChildCall(effective(parent), request.call, request.definition)) return planModeWriteDenial();
        check(['start/v1', 'delegate/v1'].includes(request.definition.childBudgetPolicy), 'child_start_not_admitted');
        const args = request.call.arguments;
        check(typeof args.role === 'string' && args.role.trim() && typeof args.task === 'string' && args.task.trim()
          && (args.background === undefined || typeof args.background === 'boolean')
          && (args.continuation_of === undefined || typeof args.continuation_of === 'string'
            && args.continuation_of.trim() && args.continuation_of.length <= 256), 'child_background_request_invalid');
        const foreground = args.background === false || request.call.name === 'native_delegate' && args.background !== true;
        check(request.budget.depth < request.budget.maxDepth, 'child_depth_exhausted');
        const modelLimit = args.model_call_limit ?? 4, toolLimit = args.tool_call_limit ?? 8;
        check(Number.isSafeInteger(modelLimit) && modelLimit >= 1 && Number.isSafeInteger(toolLimit) && toolLimit >= 0, 'child_budget_invalid');
        const availableTools = request.budget.maxToolCallsRemaining === null ? Infinity
          : request.budget.maxToolCallsRemaining - (request.definition.childBudgetPolicy === 'start/v1' ? 1 : 0);
        const maxModelCalls = Math.min(modelLimit, request.budget.maxModelCallsRemaining ?? Infinity);
        const maxToolCalls = Math.min(toolLimit, availableTools);
        check(maxModelCalls > 0 && maxToolCalls >= 0, 'child_budget_exhausted');
        const requestDigest = hash({ parent: identity(request), operationKey: request.operationKey, call: request.call, budget: request.budget });
        const binding = { contract: CHILD_OWNER_CONTRACT, parent: identity(request), parentOperationKey: request.operationKey,
          parentToolCallId: request.call.callId, parentExecutionFence: request.executionFence, childRequestDigest: requestDigest,
          ...(inheritedPlan ? { planMode: activePlanMode(parent.snapshot, effective(parent)) } : {}),
          role: args.role, maxModelCalls, maxToolCalls, ...(foreground ? { deliveryMode: 'foreground' } : {}) };
        const runId = locator(request);
        const existing = scopes.flatMap(childScope => store.list(childScope)).find(snapshot => snapshot.runId === runId);
        if (existing) {
          const record = store.load(existing.scope, runId), saved = record.configuration.childOwnerBinding;
          check(saved?.childRequestDigest === requestDigest && saved.parentToolCallId === request.call.callId
            && saved.maxModelCalls <= maxModelCalls && saved.maxToolCalls <= maxToolCalls, 'child_start_identity_conflict');
          const reservation = makeReservation(record, existing.scope);
          ownedChild(request, reservation);
          return foreground ? foregroundResult(request, reservation) : startupReceipt(reservation, saved.role);
        }
        const source = continuationSource(request);
        const childSessionId = source?.child.snapshot.sessionId ?? runId;
        if (source) {
          binding.continuationOf = source.child.snapshot.runId;
          binding.continuationParentRunId = source.parent.snapshot.runId;
        }
        const bound = await observeWhileLive(Promise.resolve().then(() => resolveChild({ parent: identity(request), call: copy(request.call), childRunId: runId,
          childSessionId,
          role: args.role, task: args.task, parentContract: copy(effective(toolInvocation(request)).contract),
          maxModelCalls, maxToolCalls, depth: request.budget.depth + 1, signal: request.signal })), request.signal);
        request.signal.throwIfAborted(); toolInvocation(request);
        check(bound?.scope && scopes.some(item => same(item, bound.scope))
          && bound.configuration?.contract.objective === args.task, 'child_admission_binding_invalid');
        if (source) {
          const current = continuationSource(request);
          check(same(bound.scope, source.child.snapshot.scope) && same(identity(current.child.snapshot), identity(source.child.snapshot))
            && current.parent.snapshot.runId === source.parent.snapshot.runId, 'child_followup_not_available');
        }
        binding.maxModelCalls = Math.min(maxModelCalls, bound.configuration.limits.maxModelCalls ?? maxModelCalls);
        binding.maxToolCalls = Math.min(maxToolCalls, bound.configuration.limits.maxToolCalls ?? maxToolCalls);
        check(binding.maxModelCalls >= 1 && binding.maxToolCalls >= 0, 'child_budget_exhausted');
        const childConfiguration = { ...copy(bound.configuration), delegationDepth: request.budget.depth + 1,
          ...(inheritedPlan ? { planModePolicy: CHILD_PLAN_MODE_POLICY, planModeInitialActive: binding.planMode } : {}),
          limits: { ...bound.configuration.limits, maxModelCalls: binding.maxModelCalls, maxToolCalls: binding.maxToolCalls }, childOwnerBinding: binding };
        // This is a newly admitted child, not an upgrade of a stored run.
        // Inherited Plan mode adds a required strategy to its own frozen set.
        const modules = childConfiguration.policyModules ?? defaultPolicyBindings(childConfiguration);
        childConfiguration.policyModules = [...modules, ...defaultPolicyBindings(childConfiguration)
          .filter(required => !modules.some(module => module.id === required.id))];
        const configuration = configure(childConfiguration);
        const childIdentity = { scope: copy(bound.scope), runId, sessionId: childSessionId,
          turnId: '1', buildId: request.buildId, parentRunId: null, taskChainId: source ? runId : request.taskChainId };
        const kernel = new NativeKernel({ store, ports: bound.ports, owner: `${owner}:${runId}`, digest: hash, onStream });
        try { kernel.start(childIdentity, configuration, { expectedParentRunId: source?.child.snapshot.runId ?? null }); }
        catch (error) {
          if (source && ['session_head_conflict', 'session_already_active'].includes(error.code))
            throw new NativeError('child_followup_source_not_current');
          throw error;
        }
        const record = store.load(childIdentity.scope, runId), reservation = makeReservation(record, childIdentity.scope);
        const entry = attachKernel(record, bound.ports);
        drive(entry);
        return foreground ? foregroundResult(request, reservation) : startupReceipt(reservation, binding.role);
      } catch (error) {
        // Admission refusals happen before a child is created. They are known
        // tool outcomes, not unknown external effects requiring reconciliation.
        if (['child_followup_not_available', 'child_followup_role_mismatch', 'child_followup_requires_result_collection',
          'child_followup_source_not_current', 'child_followup_model_image_unavailable'].includes(error.code))
          return { status: 'error', content: { error_code: error.code, executed: false } };
        throw error;
      }
    },
    async control(request) {
      request.signal.throwIfAborted();
      let parent = toolInvocation(request);
      if (activePlanMode(parent.snapshot, effective(parent)) && !isPlanChildCall(effective(parent), request.call, request.definition)) return planModeWriteDenial();
      check(request.definition.childBudgetPolicy === 'settle/v1', 'child_control_not_admitted');
      const args = request.call.arguments, waitSeconds = args.wait_seconds ?? 15;
      check(typeof args.child_run_id === 'string' && ['wait', 'send', 'stop'].includes(args.action)
        && typeof waitSeconds === 'number' && Number.isFinite(waitSeconds) && waitSeconds >= 0 && waitSeconds <= 30
        && (args.action === 'send' ? typeof args.message === 'string' && args.message.trim() && args.message.length <= 32000
          : args.message === undefined), 'child_control_arguments_invalid');
      const reservation = parent.snapshot.childBudgetReservations.find(item => item.childRunId === args.child_run_id);
      check(reservation && parent.snapshot.childRunIds.includes(args.child_run_id), 'child_control_not_owned');
      let record = ownedChild(request, reservation);
      if (terminal(record.snapshot.phase)) return terminalReceipt(record, reservation);
      check(reservation.settledUsageDigest === null, 'child_control_terminal_conflict');
      const entry = await liveEntry(request, reservation, record);
      parent = toolInvocation(request); request.signal.throwIfAborted();
      check(entry, 'child_owner_unavailable');
      if (args.action !== 'wait') {
        submit(entry, { commandId: `parent-control-${hash({ parent: request.runId,
          operationKey: request.operationKey, callId: request.call.callId })}`, kind: args.action === 'send' ? 'guide' : 'cancel',
        payload: args.action === 'send' ? { text: args.message } : {} });
      }
      if (record.snapshot.phase !== 'awaiting_interaction' || args.action === 'stop') drive(entry);
      const deadline = performance.now() + waitSeconds * 1000;
      while (waitSeconds > 0 && args.action !== 'send') {
        record = ownedChild(request, reservation);
        if (terminal(record.snapshot.phase) || record.snapshot.phase === 'awaiting_interaction' && args.action !== 'stop' || performance.now() >= deadline) break;
        await observeWhileLive(new Promise(resolve => setTimeout(resolve, 25)), request.signal);
        if (entry.error?.code === 'lease_busy' || !entry.promise && record.commands.some(row => !row.consumed)) drive(entry);
      }
      request.signal.throwIfAborted(); toolInvocation(request);
      record = ownedChild(request, reservation);
      if (terminal(record.snapshot.phase)) return terminalReceipt(record, reservation);
      return { status: 'ok', content: { child_run_id: record.snapshot.runId, status: record.snapshot.phase,
        action: args.action, parent_acceptance: 'not_evaluated', result_available: false } };
    },
    async collect(request) {
      request.signal.throwIfAborted();
      const parent = parentRecord(request), intent = parent.intents.find(item => item.operationKey === request.operationKey);
      check(intent?.status === 'running', 'child_collection_not_owned');
      check(intent.claimedFence === request.executionFence && parent.lease?.fence === request.executionFence
        && parent.lease.expiresAt > now(), 'child_collection_fence_lost');
      const { signal, ...plain } = childLifecycleRequest(parent.snapshot, intent, request.signal);
      const { signal: ignored, ...supplied } = request;
      check(same(plain, supplied), 'child_collection_not_owned');
      const records = request.reservations.map(reservation => ownedChild(request, reservation));
      const awaited = [];
      for (let index = 0; index < records.length; index++) {
        const reservation = request.reservations[index], record = records[index];
        const entry = await liveEntry(request, reservation, record);
        request.signal.throwIfAborted();
        if (!entry || terminal(record.snapshot.phase)) continue;
        if (request.action === 'cancel') submit(entry, {
          commandId: `parent-cancel-${hash({ parent: request.runId, operationKey: request.operationKey, child: entry.runId })}`, kind: 'cancel', payload: {} });
        else if (request.childApproval?.childRunId === entry.runId && request.interaction) {
          const expected = request.childApproval;
          check(request.interaction.interactionId === `native-child-${hash(expected)}`
            && request.interaction.callId === expected.toolCall.callId && ['allow', 'deny'].includes(request.interaction.decision), 'child_approval_identity_conflict');
          const commandId = `parent-approval-${hash({ parent: identity(request), approval: expected, decision: request.interaction.decision })}`;
          // A promotion may detach this observer after the decision was
          // durably delivered. Accept only that same saved decision; never
          // infer approval from a child's phase or ask for it a second time.
          const previousIds = parent.intents.filter(item => item.kind === 'child' && same(item.payload.childApproval, expected)
            && same(item.payload.interaction, request.interaction)).map(item =>
            `parent-approval-${hash({ parent: item.operationKey, approval: expected, decision: request.interaction.decision })}`);
          const delivered = record.commands.some(row => row.command.kind === 'submit_interaction'
            && [commandId, ...previousIds].includes(row.command.commandId)
            && same(row.command.payload, { interactionId: expected.interactionId, decision: request.interaction.decision }));
          if (!delivered) {
            check(same(childApproval(record, reservation), expected), 'child_approval_identity_conflict');
            submit(entry, { commandId, kind: 'submit_interaction',
              payload: { interactionId: expected.interactionId, decision: request.interaction.decision } });
          }
        }
        if (record.snapshot.phase !== 'awaiting_interaction' || request.action === 'cancel' || request.childApproval?.childRunId === entry.runId) {
          const promise = drive(entry);
          if (!request.waitForChildRunIds || request.waitForChildRunIds.includes(entry.runId)) awaited.push(promise);
        }
      }
      if (request.action !== 'poll') {
        await observeWhileLive(Promise.all(awaited), request.signal);
        while (request.reservations.some(reservation => {
          const record = ownedChild(request, reservation);
          return (!request.waitForChildRunIds || request.waitForChildRunIds.includes(reservation.childRunId))
            && !terminal(record.snapshot.phase) && record.commands.some(row => !row.consumed);
        })) {
          const continuations = request.reservations.flatMap(reservation => {
            if (request.waitForChildRunIds && !request.waitForChildRunIds.includes(reservation.childRunId)) return [];
            const record = ownedChild(request, reservation), entry = entries.get(record.snapshot.runId);
            return entry && !terminal(record.snapshot.phase) && record.commands.some(row => !row.consumed) ? [drive(entry)] : [];
          });
          if (!continuations.length) break;
          await observeWhileLive(Promise.all(continuations), request.signal);
        }
        // Another live owner may still hold the child's lease. Observe it;
        // after expiry the same Kernel classifies its existing claims.
        while (request.reservations.some(reservation => {
          if (request.waitForChildRunIds && !request.waitForChildRunIds.includes(reservation.childRunId)) return false;
          const record = ownedChild(request, reservation);
          return !terminal(record.snapshot.phase) && record.snapshot.phase !== 'awaiting_interaction'
            && entries.get(record.snapshot.runId)?.error?.code === 'lease_busy';
        })) {
          await observeWhileLive(new Promise(resolve => setTimeout(resolve, 25)), request.signal);
          const retries = request.reservations.flatMap(reservation => {
            if (request.waitForChildRunIds && !request.waitForChildRunIds.includes(reservation.childRunId)) return [];
            const record = ownedChild(request, reservation), entry = entries.get(record.snapshot.runId);
            return entry && !terminal(record.snapshot.phase) && entry.error?.code === 'lease_busy' ? [drive(entry)] : [];
          });
          await observeWhileLive(Promise.all(retries), request.signal);
        }
      }
      request.signal.throwIfAborted();
      const result = { operationKey: request.operationKey, results: [], pendingChildRunIds: [], approvals: [], errorCode: null, children: [] };
      if (request.responseCursors !== undefined) result.responses = [];
      for (const reservation of request.reservations) {
        const record = ownedChild(request, reservation);
        if (result.responses) result.responses.push(...responses(record, request.responseCursors));
        result.children.push(projection(record, reservation));
        if (terminal(record.snapshot.phase) && record.snapshot.phase !== 'interrupted' && !unsafeReceipt(record)) result.results.push(terminalReceipt(record, reservation, false));
        else {
          result.pendingChildRunIds.push(record.snapshot.runId);
          if (record.snapshot.phase === 'awaiting_interaction' && request.action !== 'cancel') result.approvals.push(childApproval(record, reservation));
          if (record.snapshot.phase === 'interrupted' || unsafeReceipt(record) && !canWaitForReceipt?.(record)
            || entries.get(record.snapshot.runId)?.error && entries.get(record.snapshot.runId).error.code !== 'lease_busy') result.errorCode = 'child_receipt_unavailable';
        }
      }
      return result;
    },
    async readyChildren(request) {
      request.signal.throwIfAborted();
      const parent = parentRecord(request), intent = parent.intents.find(item => item.operationKey === parent.snapshot.pendingIntent) ?? null;
      const { signal, ...plain } = request;
      check(same(childReadyProbe(parent.snapshot, effective(parent), intent), plain), 'child_readiness_not_owned');
      const ids = [];
      for (const reservation of request.reservations) {
        const record = ownedChild(request, reservation);
        if (terminal(record.snapshot.phase) || request.includeApprovals && record.snapshot.phase === 'awaiting_interaction'
          || request.responseCursors !== undefined && responses(record, request.responseCursors).length) ids.push(record.snapshot.runId);
      }
      return { childRunIds: ids };
    },
    async reconcile(request) {
      request.signal.throwIfAborted();
      const parent = parentRecord(request), intent = parent.intents.find(item => item.operationKey === request.operationKey);
      check(intent?.status === 'running', 'child_recovery_not_owned');
      const { signal, ...expected } = childLifecycleRequest(parent.snapshot, intent, request.signal);
      const { signal: ignored, ...plain } = request;
      check(same(expected, plain), 'child_recovery_not_owned');
      const records = request.reservations.map(reservation => ownedChild(request, reservation));
      // Reconcile observes ledgers only. A proven original receipt wait may
      // remain pending after the parent collector died; it is not a failed
      // collection and grants no authority to query/send/drive that child.
      // Rebinding and execution happen later in a fresh fenced collect.
      if (records.some(record => terminal(record.snapshot.phase)
        ? record.snapshot.phase === 'interrupted' || unsafeReceipt(record)
        : request.action === 'cancel' || !canWaitForReceipt?.(record))) return null;
      return { operationKey: request.operationKey,
        results: records.flatMap((record, index) => terminal(record.snapshot.phase) ? [terminalReceipt(record, request.reservations[index], false)] : []),
        ...(request.responseCursors === undefined ? {} : { responses: records.flatMap(record => responses(record, request.responseCursors)) }),
        pendingChildRunIds: records.filter(record => !terminal(record.snapshot.phase)).map(record => record.snapshot.runId),
        approvals: [], errorCode: null, children: records.map((record, index) => projection(record, request.reservations[index])) };
    },
    async interruptedReceipts(request) {
      check(same(request.scope, parentScope), 'child_parent_scope_mismatch');
      const parent = store.load(parentScope, request.runId), intent = parent.intents.find(item => item.operationKey === request.parentOperationKey);
      check(intent?.kind === 'tool' && intent.status === 'running' && parent.snapshot.pendingIntent === intent.operationKey, 'child_recovery_not_owned');
      const calls = intent.payload.calls;
      check(Array.isArray(calls) && calls.length === 1 && ['start/v1', 'delegate/v1'].includes(effective(parent).tools.find(tool => tool.name === calls[0].name)?.childBudgetPolicy), 'child_recovery_not_owned');
      const childId = locator({ scope: parentScope, runId: request.runId, operationKey: intent.operationKey });
      const records = scopes.flatMap(childScope => store.list(childScope)).filter(snapshot => snapshot.runId === childId);
      const entry = entries.get(childId);
      if (!records.length && !entry) return [];
      const childScope = entry?.scope ?? records[0].scope, record = store.load(childScope, childId);
      const reservation = makeReservation(record, childScope);
      ownedChild(identity(parent.snapshot), reservation);
      check(record.configuration.childOwnerBinding.parentToolCallId === calls[0].callId
        && record.configuration.childOwnerBinding.childRequestDigest === hash({ parent: identity(parent.snapshot),
          operationKey: intent.operationKey, call: calls[0], budget: admittedToolBudget(parent.snapshot, effective(parent), 1) }), 'child_recovery_identity_conflict');
      return [{ parentOperationKey: intent.operationKey, parentToolCallId: calls[0].callId,
        result: reservation.deliveryMode === 'foreground' && terminal(record.snapshot.phase)
          && record.snapshot.phase !== 'interrupted' && !unsafeReceipt(record)
          ? { ...terminalReceipt(record, reservation), childBudgetReservation: copy(reservation) }
          : startupReceipt(reservation, record.configuration.childOwnerBinding.role) }];
    },
    async releaseRun(request) {
      check(same(request.scope, parentScope), 'child_parent_scope_mismatch');
      const jobs = [];
      for (const entry of entries.values()) {
        if (entry.configuration.childOwnerBinding.parent.runId !== request.runId) continue;
        const record = store.load(entry.scope, entry.runId);
        if (!terminal(record.snapshot.phase)) {
          submit(entry, { commandId: `owner-release-${hash({ owner, runId: request.runId })}`, kind: 'cancel', payload: {} });
          jobs.push(drive(entry));
        }
      }
      await Promise.all(jobs);
      for (const [id, entry] of entries) if (entry.configuration.childOwnerBinding.parent.runId === request.runId) entries.delete(id);
    },
  });
}
