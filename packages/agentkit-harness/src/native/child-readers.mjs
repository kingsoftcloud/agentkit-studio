// Scoped, paged read-only tools for already-accounted direct children.
//
// Ports the pure-read semantics of ksadk/harness/subagent_adapters/native_child_result.py
// (NativeChildResultPort + NativeChildTasksPort) at pinned commit 355059d.
//
// The read capability owns no Kernel, model, factory, lease or execution method.
// An accounted identity is a locator, never a semantic completion verdict.
// Results do not verify the parent task; they are untrusted data.
//
// Validation follows child-owner.mjs's toolInvocation pattern: the parent must
// have a running tool intent matching the request operationKey (including
// parallel :call:<index> delegation), the frozen definition must match, the
// executionFence must equal the current lease fence, the lease must be valid,
// and taskContract.allowedToolNames must permit the tool.

import { createHash } from 'node:crypto';
import { NativeError, CHILD_OWNER_CONTRACT, canonical, copy, terminal, scopeKey } from '../../../agentkit-harness-core/dist/index.mjs';

const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const textHash = value => createHash('sha256').update(value).digest('hex');
const same = (left, right) => canonical(left) === canonical(right);
const check = (value, code) => { if (!value) throw new NativeError(code); };
const identityFields = ['scope', 'runId', 'sessionId', 'turnId', 'buildId', 'parentRunId', 'taskChainId'];
const identity = value => Object.fromEntries(identityFields.map(key => [key, copy(value[key])]));

export function nativeChildReaderDefinitions() {
  const resultDefinition = {
    name: 'native_child_result',
    description: "Read a child's status and page its original settled delivery. Active or uncertain children return metadata with result_available=false. This query starts no work and does not verify the parent task.",
    parameters: {
      type: 'object', additionalProperties: false, required: ['child_run_id'],
      properties: {
        child_run_id: { type: 'string', minLength: 1, maxLength: 256 },
        offset_chars: { type: 'integer', minimum: 0, default: 0 },
        limit_chars: { type: 'integer', minimum: 1, maximum: 16000, default: 4000 },
      },
    },
    readOnly: true, concurrentSafe: true, permissions: [], timeoutMs: 1000, recoveryPolicy: 'safe-read/v1',
    contextRole: 'none', observationRole: 'none', progressObservation: false, contextRetention: 'normal',
  };

  const tasksDefinition = {
    name: 'native_child_tasks',
    description: "List saved direct child tasks, their current status and delivery locators. Use this when previous child results or IDs are no longer in context. For later pages, use the returned inventory_digest and next_offset. Starts no work. Read a delivery with native_child_result.",
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        offset: { type: 'integer', minimum: 0, default: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 16, default: 8 },
        inventory_digest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
      },
    },
    readOnly: true, concurrentSafe: true, permissions: [], timeoutMs: 1000, recoveryPolicy: 'safe-read/v1',
    contextRole: 'none', observationRole: 'none', progressObservation: false, contextRetention: 'normal',
  };

  return [resultDefinition, tasksDefinition];
}

export function createNativeChildResultTools({ scope, childScopes = [scope], store, roles, now = Date.now }) {
  const parentScope = copy(scope);
  scopeKey(parentScope);
  const scopes = copy(childScopes);
  check(Array.isArray(scopes) && scopes.length > 0 && scopes.every(item => {
    scopeKey(item);
    return ['tenantId', 'workspaceId', 'userId'].every(key => item[key] === parentScope[key]);
  }), 'invalid_child_reader_scopes');
  check(store, 'invalid_child_reader_store');
  const roleIds = copy(roles);
  check(Array.isArray(roleIds) && roleIds.length > 0 && roleIds.every(role => typeof role === 'string' && role.trim())
    && new Set(roleIds).size === roleIds.length, 'invalid_child_reader_roles');

  const definitions = nativeChildReaderDefinitions();
  const definitionsByName = new Map(definitions.map(d => [d.name, d]));

  // --- Internal: validate parent running tool intent -----------------------
  // Mirrors child-owner.mjs toolInvocation: the request must be bound to a
  // live parent tool effect — running intent, matching call, frozen definition,
  // signal, executionFence, valid lease, and taskContract tool scope.

  function resolveIntent(parentRecord, operationKey) {
    const intent = parentRecord.intents.find(item => item.operationKey === operationKey);
    if (intent && Array.isArray(intent.payload.calls) && intent.payload.calls.length === 1)
      return { intent, calls: intent.payload.calls, index: 0, base: operationKey };
    // Parallel delegation: operationKey = "<base>:call:<1-based-index>"
    // kernel.mts only adds :call:<index> when calls.length > 1; there is no
    // parallel_delegation flag on the intent payload. The base intent holds
    // the calls array; pendingIntent stays at the base operationKey.
    const match = operationKey.match(/^(.+):call:([1-9][0-9]*)$/);
    if (match) {
      const base = match[1], index = parseInt(match[2], 10) - 1;
      const baseIntent = parentRecord.intents.find(item => item.operationKey === base);
      if (baseIntent?.kind === 'tool' && Array.isArray(baseIntent.payload.calls) && baseIntent.payload.calls.length > 1
        && Number.isSafeInteger(index) && index < baseIntent.payload.calls.length) {
        return { intent: baseIntent, calls: baseIntent.payload.calls, index, base };
      }
    }
    return null;
  }

  function validateRequest(request) {
    check(same(request.scope, parentScope), 'child_reader_scope_mismatch');
    const def = definitionsByName.get(request.call.name);
    check(def, 'child_reader_definition_mismatch');
    check(same(request.definition, def), 'child_reader_definition_mismatch');

    let parentRecord;
    try { parentRecord = store.load(parentScope, request.runId); }
    catch (error) { if (error.code === 'run_not_found') throw new NativeError('child_reader_parent_unavailable'); throw error; }

    // Validate full RunIdentity against the parent snapshot (not self-comparison)
    check(same(identity(request), identity(parentRecord.snapshot)), 'child_reader_identity_mismatch');

    const resolved = resolveIntent(parentRecord, request.operationKey);
    check(resolved, 'child_reader_intent_not_owned');
    const { intent, calls, index, base } = resolved;

    // Intent must be a running tool; pendingIntent stays at the base key
    check(intent.kind === 'tool' && intent.status === 'running'
      && parentRecord.snapshot.pendingIntent === base,
      'child_reader_intent_not_owned');

    // Validate the call matches the intent's call at the resolved index
    const expectedCall = calls?.[index];
    check(expectedCall && same(expectedCall, request.call), 'child_reader_call_not_owned');

    // Validate the frozen definition matches (from effective config tools)
    const effectiveConfig = parentRecord.snapshot.taskContract
      ? { ...parentRecord.configuration, contract: parentRecord.snapshot.taskContract }
      : parentRecord.configuration;
    const frozenDef = effectiveConfig.tools.find(tool => tool.name === request.call.name);
    check(frozenDef && same(frozenDef, request.definition), 'child_reader_definition_not_frozen');

    // Validate executionFence and lease
    check(intent.claimedFence === request.executionFence
      && parentRecord.lease?.fence === request.executionFence
      && parentRecord.lease.expiresAt > now(), 'child_reader_fence_lost');

    // Validate taskContract.allowedToolNames if present on the effective config
    const allowedToolNames = effectiveConfig.contract.allowedToolNames;
    if (allowedToolNames !== undefined && allowedToolNames !== null) {
      check(Array.isArray(allowedToolNames) && allowedToolNames.includes(request.call.name), 'child_reader_tool_not_allowed');
    }

    // Signal must not be aborted
    request.signal.throwIfAborted();

    return parentRecord;
  }

  // --- Internal: check terminal-safe delivery ------------------------------

  function isTerminalSafe(record) {
    const snapshot = record.snapshot;
    if (!terminal(snapshot.phase)) return false;
    if (snapshot.phase === 'interrupted') return false;
    // Check for uncertain receipts that make the delivery unsafe
    for (const receipt of record.receipts) {
      if (receipt.status === 'uncertain') {
        const intent = record.intents.find(item => item.operationKey === receipt.operationKey);
        if (intent?.kind !== 'model' && !(receipt.result.retryScheduled === true
          && ['safe-read/v1', 'workspace-observation/v1'].includes(receipt.result.recoveryPolicy))) return false;
      }
    }
    return true;
  }

  // --- Internal: load a direct child by run ID -----------------------------

  function loadDirectChild(parent, childRunId) {
    if (!(parent.childRunIds ?? []).includes(childRunId)) return null;
    for (const childScope of scopes) {
      let record;
      try { record = store.load(childScope, childRunId); }
      catch (error) { if (error.code === 'run_not_found') continue; throw error; }
      const child = record.snapshot;
      const binding = record.configuration.childOwnerBinding;
      if (!binding || binding.contract !== CHILD_OWNER_CONTRACT) continue;
      if (!same(child.scope, childScope)) continue;
      // Full parent identity match
      if (!same(binding.parent, identity(parent))) continue;
      if (!roleIds.includes(binding.role)) continue;
      // Must be bound to a parent reservation
      const reservation = (parent.childBudgetReservations ?? []).find(item => item.childRunId === childRunId);
      if (!reservation) continue;
      if (reservation.parentOperationKey !== binding.parentOperationKey) continue;
      if (reservation.parentToolCallId !== binding.parentToolCallId) continue;
      if (reservation.childRequestDigest !== binding.childRequestDigest) continue;
      if (reservation.configurationDigest !== record.snapshot.configDigest) continue;
      // Config hash must match
      if (hash(record.configuration) !== reservation.configurationDigest) continue;
      if (reservation.maxModelCalls !== binding.maxModelCalls) continue;
      if (reservation.maxToolCalls !== binding.maxToolCalls) continue;
      if (reservation.childScope.tenantId !== childScope.tenantId
        || reservation.childScope.workspaceId !== childScope.workspaceId
        || reservation.childScope.userId !== childScope.userId
        || reservation.childScope.agentId !== childScope.agentId) continue;
      const parentRecord = store.load(parentScope, parent.runId), start = resolveIntent(parentRecord, binding.parentOperationKey);
      const startCall = start?.calls[start.index], receipt = parentRecord.receipts.find(item => item.operationKey === start?.base && item.status === 'committed');
      const original = receipt?.result.results?.[start?.index]?.childBudgetReservation;
      if (!startCall || !['native_start_child', 'native_delegate'].includes(startCall.name)
        || startCall.callId !== binding.parentToolCallId || startCall.arguments.role !== binding.role
        || startCall.arguments.task !== record.configuration.contract.objective
        || !original || !same(original, { ...reservation, settledUsageDigest: null })) continue;
      return record;
    }
    return null;
  }

  // --- native_child_result execute -----------------------------------------

  async function executeResult(request) {
    const parentRecord = validateRequest(request);
    const parent = parentRecord.snapshot;
    const args = request.call.arguments ?? {};
    const childRunId = args.child_run_id;
    check(typeof childRunId === 'string' && childRunId.trim() && childRunId.length <= 256, 'child_result_query_invalid');
    const offsetChars = args.offset_chars ?? 0;
    const limitChars = args.limit_chars ?? 4000;
    check(Number.isSafeInteger(offsetChars) && offsetChars >= 0, 'child_result_query_invalid');
    check(Number.isSafeInteger(limitChars) && limitChars >= 1 && limitChars <= 16000, 'child_result_query_invalid');

    const childRecord = loadDirectChild(parent, childRunId);
    if (!childRecord) return { status: 'error', content: { error_code: 'child_result_not_available' } };

    const child = childRecord.snapshot;
    const binding = childRecord.configuration.childOwnerBinding;

    // Only read terminal-safe deliveries
    const reservation = parent.childBudgetReservations.find(item => item.childRunId === childRunId);
    const settled = parentRecord.receipts.filter(receipt => receipt.status === 'committed').flatMap(receipt => receipt.result.results ?? [])
      .find(result => result.childBudgetSettlement?.childRunId === childRunId
        && result.childBudgetSettlement.terminalSnapshotDigest === hash(child)
        && hash({ settlement: result.childBudgetSettlement, usage: result.resourceUsage, childRunIds: result.childRunIds }) === reservation.settledUsageDigest);
    const available = Boolean(reservation.settledUsageDigest && settled && isTerminalSafe(childRecord));
    const finalText = available ? child.finalText : '';
    const charCount = [...finalText].length;
    if (offsetChars > charCount)
      return { status: 'error', content: { error_code: 'child_result_offset_invalid' } };

    const chars = [...finalText];
    const sliced = chars.slice(offsetChars, offsetChars + limitChars).join('');
    const stop = offsetChars + [...sliced].length;

    return {
      status: 'ok',
      content: {
        schema_version: 'native.child-result/v1',
        child_run_id: child.runId,
        child_session_id: child.sessionId,
        parent_run_id: parent.runId,
        parent_tool_call_id: binding.parentToolCallId,
        parent_operation_key: binding.parentOperationKey,
        role: binding.role,
        snapshot_revision: child.revision,
        event_seq: child.eventSeq,
        goal_digest: textHash(child.goal ?? ''),
        contract_digest: hash(child.taskContract ?? childRecord.configuration.contract),
        phase: child.phase,
        terminal: terminal(child.phase),
        result_available: available,
        outcome: child.outcome,
        final_text: sliced,
        final_text_digest: textHash(finalText),
        offset_chars: offsetChars,
        next_offset_chars: stop,
        complete: stop === charCount,
        total_chars: charCount,
        parent_acceptance: 'not_evaluated',
        execution_started: false,
        resource_usage_accounted_again: false,
      },
    };
  }

  // --- native_child_tasks execute ------------------------------------------

  async function executeTasks(request) {
    const parentRecord = validateRequest(request);
    const parent = parentRecord.snapshot;
    const args = request.call.arguments ?? {};
    const offset = args.offset ?? 0;
    const limit = args.limit ?? 8;
    const inventoryDigest = args.inventory_digest ?? null;
    check(Number.isSafeInteger(offset) && offset >= 0, 'child_tasks_query_invalid');
    check(Number.isSafeInteger(limit) && limit >= 1 && limit <= 16, 'child_tasks_query_invalid');
    if (inventoryDigest !== null)
      check(typeof inventoryDigest === 'string' && /^[0-9a-f]{64}$/.test(inventoryDigest), 'child_tasks_query_invalid');

    // Build direct child inventory — only children loadable via loadDirectChild
    const children = [];
    const descendants = new Set();
    for (const childId of parent.childRunIds ?? []) {
      const childRecord = loadDirectChild(parent, childId);
      if (childRecord) {
        children.push(childRecord);
        for (const descId of childRecord.snapshot.childRunIds ?? []) descendants.add(descId);
      }
    }
    const directIds = new Set(children.map(r => r.snapshot.runId));
    // If any child ID is neither a direct child nor a descendant of a direct child, inventory is unavailable
    for (const childId of parent.childRunIds ?? []) {
      if (!directIds.has(childId) && !descendants.has(childId))
        return { status: 'error', content: { error_code: 'child_tasks_not_available' } };
    }

    const digestInput = canonical({
      inventory_policy: 'direct-child-inventory/v2',
      scope: parentScope,
      parent_run_id: parent.runId,
      child_run_ids: children.map(r => r.snapshot.runId),
    });
    const computedDigest = textHash(digestInput);

    if ((offset && inventoryDigest === null) || (inventoryDigest !== null && inventoryDigest !== computedDigest))
      return { status: 'error', content: { error_code: 'child_tasks_inventory_changed' } };
    if (offset > children.length)
      return { status: 'error', content: { error_code: 'child_tasks_offset_invalid' } };

    const tasks = children.slice(offset, offset + limit).map(record => {
      const child = record.snapshot;
      const binding = record.configuration.childOwnerBinding;
      const goal = child.goal ?? '';
      const finalText = child.finalText ?? '';
      return {
        child_run_id: child.runId,
        child_session_id: child.sessionId,
        role: binding.role,
        parent_tool_call_id: binding.parentToolCallId,
        snapshot_revision: child.revision,
        phase: child.phase,
        terminal: terminal(child.phase),
        outcome: child.outcome,
        goal_preview: [...goal].slice(0, 256).join(''),
        goal_preview_trust: 'untrusted',
        goal_preview_complete: [...goal].length <= 256,
        goal_digest: textHash(goal),
        final_text_chars: [...finalText].length,
        final_text_digest: textHash(finalText),
        result_tool: 'native_child_result',
        parent_acceptance: 'not_evaluated',
      };
    });

    const stop = offset + tasks.length;
    return {
      status: 'ok',
      content: {
        schema_version: 'native.child-tasks/v2',
        parent_run_id: parent.runId,
        parent_snapshot_revision: parent.revision,
        inventory_digest: computedDigest,
        tasks,
        total_tasks: children.length,
        offset,
        next_offset: stop,
        complete: stop === children.length,
        parent_acceptance: 'not_evaluated',
        execution_started: false,
        resource_usage_accounted_again: false,
      },
    };
  }

  // --- Execute dispatcher --------------------------------------------------

  async function execute(request) {
    try {
      if (request.call.name === 'native_child_result') return await executeResult(request);
      if (request.call.name === 'native_child_tasks') return await executeTasks(request);
      return { status: 'error', content: { error_code: 'child_reader_unknown_tool' } };
    } catch (error) {
      request.signal?.throwIfAborted();
      if (error.name === 'AbortError') throw error;
      if (error instanceof NativeError && /^(child_|invalid_child_)/.test(error.code))
        return { status: 'error', content: { error_code: error.code } };
      return { status: 'uncertain', content: { error_code: 'child_reader_store_unavailable' } };
    }
  }

  return Object.freeze({ definitions, execute });
}
