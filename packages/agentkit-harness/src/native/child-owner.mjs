import { createHash, randomUUID } from 'node:crypto';
import { NativeKernel, NativeError, CHILD_OWNER_CONTRACT, canonical, copy, configure,
  addUsage, admittedToolBudget, childLifecycleRequest, childReadyProbe, scopeKey, terminal } from '../../../agentkit-harness-core/dist/index.mjs';

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
    onAbort = () => reject(new NativeError('child_observation_paused'));
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
export function createNativeChildOwner({ scope, childScopes = [scope], store, resolveChild, restoreChild, now = Date.now,
  owner = `native-children-${randomUUID()}` }) {
  const parentScope = copy(scope), entries = new Map();
  scopeKey(parentScope);
  const scopes = copy(childScopes);
  check(Array.isArray(scopes) && scopes.length > 0 && scopes.every(item => {
    scopeKey(item); return ['tenantId', 'workspaceId', 'userId'].every(key => item[key] === parentScope[key]);
  }), 'invalid_child_owner_scopes');
  check(store && typeof resolveChild === 'function' && typeof owner === 'string' && owner.trim(), 'invalid_child_owner');
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
      maxToolCalls: binding.maxToolCalls, settledUsageDigest: null };
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
    tools: { ...ports.tools, execute: request => admitted() ? ports.tools.execute(request)
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
      kernel: new NativeKernel({ store, ports: guarded, owner: `${owner}:${record.snapshot.runId}`, digest: hash }), promise: null, error: null };
    entries.set(record.snapshot.runId, entry); return entry;
  };
  const drive = entry => {
    if (entry.promise) return entry.promise;
    entry.error = null;
    entry.promise = entry.kernel.runUntilIdle(entry.scope, entry.runId).catch(error => { entry.error = error; })
      .finally(() => { entry.promise = null; });
    return entry.promise;
  };
  const ownedChild = (request, reservation) => {
    check(scopes.some(item => same(item, reservation.childScope)), 'child_scope_not_admitted');
    const record = store.load(reservation.childScope, reservation.childRunId), binding = record.configuration.childOwnerBinding;
    check(binding?.contract === CHILD_OWNER_CONTRACT && same(binding.parent, identity(request))
      && binding.parentOperationKey === reservation.parentOperationKey && binding.parentToolCallId === reservation.parentToolCallId
      && binding.childRequestDigest === reservation.childRequestDigest && binding.maxModelCalls === reservation.maxModelCalls
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
  const unsafeReceipt = record => record.receipts.some(receipt => receipt.status === 'uncertain'
    && !(receipt.result.retryScheduled === true && ['safe-read/v1', 'workspace-observation/v1'].includes(receipt.result.recoveryPolicy))
    && record.intents.find(intent => intent.operationKey === receipt.operationKey)?.kind !== 'model');
  const terminalReceipt = (record, reservation) => {
    check(terminal(record.snapshot.phase) && record.snapshot.phase !== 'interrupted' && !unsafeReceipt(record), 'child_receipt_unavailable');
    return { status: record.snapshot.phase === 'completed' ? 'ok' : 'error', content: {
      child_run_id: record.snapshot.runId, status: record.snapshot.phase, outcome: record.snapshot.outcome,
      reason: record.snapshot.reason, result: record.snapshot.finalText, parent_acceptance: 'not_evaluated' },
    resourceUsage: addUsage(record.snapshot.usage, record.snapshot.descendantUsage),
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
  const projection = (record, reservation) => ({ runId: record.snapshot.runId, sessionId: record.snapshot.sessionId,
    operationKey: reservation.parentOperationKey, callId: reservation.parentToolCallId,
    state: unsafeReceipt(record) ? 'interrupted' : record.snapshot.phase === 'created' ? 'prepared' : record.snapshot.phase === 'awaiting_interaction' ? 'awaiting_interaction'
      : terminal(record.snapshot.phase) ? record.snapshot.phase : 'running',
    reservedModelCalls: reservation.maxModelCalls, reservedToolCalls: reservation.maxToolCalls,
    usage: addUsage(record.snapshot.usage, record.snapshot.descendantUsage), notified: false, metadata: {} });

  return Object.freeze({
    contract: CHILD_OWNER_CONTRACT,
    async start(request) {
      request.signal.throwIfAborted(); toolInvocation(request);
      check(['start/v1', 'delegate/v1'].includes(request.definition.childBudgetPolicy), 'child_start_not_admitted');
      const args = request.call.arguments;
      check(typeof args.role === 'string' && args.role.trim() && typeof args.task === 'string' && args.task.trim()
        && args.background !== false && args.continuation_of === undefined, 'child_background_request_invalid');
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
        role: args.role, maxModelCalls, maxToolCalls };
      const runId = locator(request);
      const existing = scopes.flatMap(childScope => store.list(childScope)).find(snapshot => snapshot.runId === runId);
      if (existing) {
        const record = store.load(existing.scope, runId), saved = record.configuration.childOwnerBinding;
        check(saved?.childRequestDigest === requestDigest && saved.parentToolCallId === request.call.callId
          && saved.maxModelCalls <= maxModelCalls && saved.maxToolCalls <= maxToolCalls, 'child_start_identity_conflict');
        const reservation = makeReservation(record, existing.scope);
        ownedChild(request, reservation);
        return startupReceipt(reservation, saved.role);
      }
      const bound = await observeWhileLive(Promise.resolve().then(() => resolveChild({ parent: identity(request), call: copy(request.call),
        role: args.role, task: args.task, maxModelCalls, maxToolCalls, depth: request.budget.depth + 1, signal: request.signal })), request.signal);
      request.signal.throwIfAborted(); toolInvocation(request);
      check(bound?.scope && scopes.some(item => same(item, bound.scope))
        && bound.configuration?.contract.objective === args.task, 'child_admission_binding_invalid');
      binding.maxModelCalls = Math.min(maxModelCalls, bound.configuration.limits.maxModelCalls ?? maxModelCalls);
      binding.maxToolCalls = Math.min(maxToolCalls, bound.configuration.limits.maxToolCalls ?? maxToolCalls);
      check(binding.maxModelCalls >= 1 && binding.maxToolCalls >= 0, 'child_budget_exhausted');
      const configuration = configure({ ...copy(bound.configuration), delegationDepth: request.budget.depth + 1,
        limits: { ...bound.configuration.limits, maxModelCalls: binding.maxModelCalls, maxToolCalls: binding.maxToolCalls }, childOwnerBinding: binding });
      const childIdentity = { scope: copy(bound.scope), runId, sessionId: runId,
        turnId: '1', buildId: request.buildId, parentRunId: null, taskChainId: request.taskChainId };
      const kernel = new NativeKernel({ store, ports: bound.ports, owner: `${owner}:${runId}`, digest: hash });
      kernel.start(childIdentity, configuration);
      const record = store.load(childIdentity.scope, runId), reservation = makeReservation(record, childIdentity.scope);
      const entry = attachKernel(record, bound.ports);
      drive(entry);
      return startupReceipt(reservation, binding.role);
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
      const running = [];
      for (let index = 0; index < records.length; index++) {
        const reservation = request.reservations[index], record = records[index];
        const entry = await liveEntry(request, reservation, record);
        request.signal.throwIfAborted();
        if (!entry || terminal(record.snapshot.phase)) continue;
        if (request.action === 'cancel') entry.kernel.submit(entry.scope, entry.runId, {
          commandId: `parent-cancel-${hash({ parent: request.runId, operationKey: request.operationKey, child: entry.runId })}`, kind: 'cancel', payload: {} });
        else if (request.childApproval?.childRunId === entry.runId && request.interaction) {
          const expected = childApproval(record, reservation);
          check(same(expected, request.childApproval) && request.interaction.interactionId === `native-child-${hash(expected)}`
            && request.interaction.callId === expected.toolCall.callId && ['allow', 'deny'].includes(request.interaction.decision), 'child_approval_identity_conflict');
          entry.kernel.submit(entry.scope, entry.runId, { commandId: `parent-approval-${hash({ parent: request.operationKey, approval: expected, decision: request.interaction.decision })}`,
            kind: 'submit_interaction', payload: { interactionId: expected.interactionId, decision: request.interaction.decision } });
        }
        if (record.snapshot.phase !== 'awaiting_interaction' || request.action === 'cancel' || request.childApproval?.childRunId === entry.runId) running.push(drive(entry));
      }
      if (request.action !== 'poll') {
        await observeWhileLive(Promise.all(running), request.signal);
        while (request.reservations.some(reservation => {
          const record = ownedChild(request, reservation);
          return !terminal(record.snapshot.phase) && record.commands.some(row => !row.consumed);
        })) {
          const continuations = request.reservations.flatMap(reservation => {
            const record = ownedChild(request, reservation), entry = entries.get(record.snapshot.runId);
            return entry && !terminal(record.snapshot.phase) && record.commands.some(row => !row.consumed) ? [drive(entry)] : [];
          });
          if (!continuations.length) break;
          await observeWhileLive(Promise.all(continuations), request.signal);
        }
        // Another live owner may still hold the child's lease. Observe it;
        // after expiry the same Kernel classifies its existing claims.
        while (request.reservations.some(reservation => {
          const record = ownedChild(request, reservation);
          return !terminal(record.snapshot.phase) && record.snapshot.phase !== 'awaiting_interaction'
            && entries.get(record.snapshot.runId)?.error?.code === 'lease_busy';
        })) {
          await observeWhileLive(new Promise(resolve => setTimeout(resolve, 25)), request.signal);
          const retries = request.reservations.flatMap(reservation => {
            const record = ownedChild(request, reservation), entry = entries.get(record.snapshot.runId);
            return entry && !terminal(record.snapshot.phase) && entry.error?.code === 'lease_busy' ? [drive(entry)] : [];
          });
          await observeWhileLive(Promise.all(retries), request.signal);
        }
      }
      request.signal.throwIfAborted();
      const result = { operationKey: request.operationKey, results: [], pendingChildRunIds: [], approvals: [], errorCode: null, children: [] };
      for (const reservation of request.reservations) {
        const record = ownedChild(request, reservation);
        result.children.push(projection(record, reservation));
        if (terminal(record.snapshot.phase) && record.snapshot.phase !== 'interrupted' && !unsafeReceipt(record)) result.results.push(terminalReceipt(record, reservation));
        else {
          result.pendingChildRunIds.push(record.snapshot.runId);
          if (record.snapshot.phase === 'awaiting_interaction' && request.action !== 'cancel') result.approvals.push(childApproval(record, reservation));
          if (record.snapshot.phase === 'interrupted' || unsafeReceipt(record)
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
        if (terminal(record.snapshot.phase) || request.includeApprovals && record.snapshot.phase === 'awaiting_interaction') ids.push(record.snapshot.runId);
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
      if (records.some(record => !terminal(record.snapshot.phase) || record.snapshot.phase === 'interrupted' || unsafeReceipt(record))) return null;
      return { operationKey: request.operationKey, results: records.map((record, index) => terminalReceipt(record, request.reservations[index])),
        pendingChildRunIds: [], approvals: [], errorCode: null, children: records.map((record, index) => projection(record, request.reservations[index])) };
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
        result: startupReceipt(reservation, record.configuration.childOwnerBinding.role) }];
    },
    async releaseRun(request) {
      check(same(request.scope, parentScope), 'child_parent_scope_mismatch');
      const jobs = [];
      for (const entry of entries.values()) {
        if (entry.configuration.childOwnerBinding.parent.runId !== request.runId) continue;
        const record = store.load(entry.scope, entry.runId);
        if (!terminal(record.snapshot.phase)) {
          entry.kernel.submit(entry.scope, entry.runId, { commandId: `owner-release-${hash({ owner, runId: request.runId })}`, kind: 'cancel', payload: {} });
          jobs.push(drive(entry));
        }
      }
      await Promise.all(jobs);
      for (const [id, entry] of entries) if (entry.configuration.childOwnerBinding.parent.runId === request.runId) entries.delete(id);
    },
  });
}
