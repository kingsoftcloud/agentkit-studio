/** Host-owned remote sandbox creation/cleanup, with durable unknown outcomes.
 * The Native tool intent surrounds these operations. A second process cannot
 * turn an unfinished creation into permission to create a second sandbox.
 */
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { canonical, copy, invariant, scopeKey } from '@kingsoftcloud/agentkit-harness-core';
import { atomicPrivate, lockUntil, privateDirectory, readAll } from './local-command-state.mjs';

export const NATIVE_E2B_SANDBOX_OWNER = 'agentkit.native-e2b-sandbox-owner/v1';
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const phases = new Set(['creating', 'ready', 'unknown', 'closing', 'closed']);
const outcomeUnknown = () => Object.assign(new Error('Sandbox outcome requires reconciliation'), {
  code: 'e2b_sandbox_outcome_unknown', uncertain: true,
});

export function createNativeE2BSandboxOwner(options = {}) {
  const scopeIdentity = scopeKey(options.scope), fixedScope = copy(options.scope), sessionId = options.sessionId;
  return createSandboxOwner({ ...options, owner: { contract: NATIVE_E2B_SANDBOX_OWNER, fields: { scope: fixedScope },
    metadata: { owner: 'nativeOwner', operation: 'nativeCreateOperation' },
    snapshot(request) {
      invariant(request && scopeKey(request.scope) === scopeIdentity && request.sessionId === sessionId, 'e2b_owner_scope_mismatch');
      invariant([request.runId, request.turnId, request.buildId, request.taskChainId, request.operationKey, request.call?.callId]
        .every(value => typeof value === 'string' && value.trim()), 'e2b_owner_identity_required');
      invariant(request.parentRunId === null || typeof request.parentRunId === 'string' && request.parentRunId.trim(), 'e2b_owner_parent_required');
      invariant(Number.isSafeInteger(request.executionFence) && request.executionFence > 0
        && request.signal instanceof AbortSignal && request.definition?.name === request.call.name, 'e2b_owner_authority_required');
      return { requestDigest: hash({ scope: request.scope, sessionId: request.sessionId,
        runId: request.runId, turnId: request.turnId, buildId: request.buildId, parentRunId: request.parentRunId,
        taskChainId: request.taskChainId, operationKey: request.operationKey, executionFence: request.executionFence,
        call: request.call, definition: request.definition }), signal: request.signal,
      identity: { runId: request.runId, operationKey: request.operationKey, callId: request.call.callId,
        executionFence: request.executionFence } };
    } } });
}

export const DSH_E2B_SANDBOX_OWNER = 'agentkit.dsh-e2b-sandbox-owner/v1';
/** Same durable lifecycle, owned by the real DSH Agent/Session/call. Native
 * Runs and execution fences are neither required nor fabricated. */
export function createDshE2BSandboxOwner(options = {}) {
  const { agentId, sessionId } = options;
  invariant(typeof agentId === 'string' && agentId.trim(), 'e2b_owner_agent_required');
  return createSandboxOwner({ ...options, owner: { contract: DSH_E2B_SANDBOX_OWNER, fields: { agentId },
    metadata: { owner: 'dshOwner', operation: 'dshCreateOperation' },
    snapshot(request) {
      invariant(request?.agentId === agentId && request.sessionId === sessionId, 'e2b_owner_scope_mismatch');
      invariant([request.operationKey, request.call?.callId, request.call?.name].every(value => typeof value === 'string' && value.trim())
        && (request.callId === undefined || request.callId === request.call.callId)
        && ['scope', 'runId', 'turnId', 'buildId', 'executionFence', 'parentRunId', 'taskChainId'].every(key => request[key] === undefined),
      'e2b_owner_identity_required');
      invariant(request.signal instanceof AbortSignal && request.definition?.name === request.call.name, 'e2b_owner_authority_required');
      const { signal, ...json } = request;
      return { requestDigest: hash(json), signal, identity: { agentId, sessionId, operationKey: request.operationKey, callId: request.call.callId } };
    } } });
}

function createSandboxOwner({ stateRoot, workspaceRoot, owner, sessionId, bindingDigest,
  assertAuthority, createSandbox, killSandbox, inspectSandbox = null, assertReconciliationAuthority = null,
  lockTimeoutMs = 5000 } = {}) {
  invariant(typeof sessionId === 'string' && sessionId.trim(), 'e2b_owner_session_required');
  invariant(typeof bindingDigest === 'string' && /^[a-f0-9]{64}$/.test(bindingDigest), 'e2b_owner_binding_required');
  invariant(typeof assertAuthority === 'function' && typeof createSandbox === 'function' && typeof killSandbox === 'function', 'e2b_owner_capabilities_required');
  invariant((inspectSandbox === null || typeof inspectSandbox === 'function')
    && (assertReconciliationAuthority === null || typeof assertReconciliationAuthority === 'function'), 'e2b_owner_reconciliation_capabilities_invalid');
  invariant(Number.isSafeInteger(lockTimeoutMs) && lockTimeoutMs > 0 && lockTimeoutMs <= 120000, 'e2b_owner_lock_timeout_invalid');
  const workspace = realpathSync(workspaceRoot), lexical = resolve(stateRoot);
  invariant(lexical !== workspace && !lexical.startsWith(workspace + sep), 'e2b_owner_state_inside_workspace');
  privateDirectory(dirname(lexical), false); privateDirectory(lexical, true);
  const root = realpathSync(lexical);
  invariant(root !== workspace && !root.startsWith(workspace + sep), 'e2b_owner_state_inside_workspace');
  const ownerKey = hash({ ...owner.fields, sessionId, workspace });
  const directory = join(root, ownerKey); privateDirectory(directory, true);
  const filename = join(directory, 'owner.json');
  const write = record => atomicPrivate(filename, canonical(record) + '\n');
  function read() {
    if (!existsSync(filename)) return null;
    const record = JSON.parse(readAll(filename));
    invariant(record.schemaVersion === owner.contract && record.ownerKey === ownerKey
      && Object.entries(owner.fields).every(([key, value]) => canonical(record[key]) === canonical(value)) && record.sessionId === sessionId
      && phases.has(record.phase) && (record.sandboxId === null || validId(record.sandboxId)), 'e2b_owner_record_invalid');
    invariant(record.bindingDigest === bindingDigest, 'e2b_owner_binding_changed');
    invariant(record.phase !== 'ready' || validId(record.sandboxId), 'e2b_owner_record_invalid');
    return record;
  }
  const snapshot = owner.snapshot;
  function guard(request, before, authority = assertAuthority) {
    invariant(realpathSync(workspaceRoot) === workspace && realpathSync(lexical) === root, 'e2b_owner_root_changed');
    const current = snapshot(request);
    invariant(current.requestDigest === before.requestDigest && current.signal === before.signal, 'e2b_owner_context_drift');
    before.signal.throwIfAborted();
    const verdict = authority?.(request);
    if (verdict && typeof verdict.then === 'function') Promise.resolve(verdict).catch(() => {});
    invariant(verdict === true, 'e2b_owner_authority_unproven');
    const after = snapshot(request);
    invariant(after.requestDigest === before.requestDigest && after.signal === before.signal, 'e2b_owner_context_drift');
    before.signal.throwIfAborted();
  }
  const unknown = (record, reason, sandboxId = record.sandboxId) => ({ ...record, phase: 'unknown', sandboxId,
    outcomeReason: reason, updatedAt: Date.now() });

  async function ensure(request) {
    const before = snapshot(request); guard(request, before);
    const release = await lockUntil(join(directory, 'lifecycle.sqlite'), performance.now() + lockTimeoutMs);
    try {
      guard(request, before);
      let record = read();
      if (record) {
        if (record.phase === 'ready') return { sandboxId: record.sandboxId, created: false };
        if (record.phase === 'creating' || record.phase === 'closing') {
          record = unknown(record, `${record.phase}_owner_lost`); write(record);
        }
        if (record.phase === 'unknown') throw outcomeUnknown();
        invariant(record.phase !== 'closed', 'e2b_sandbox_owner_closed');
        invariant(false, 'e2b_owner_record_invalid');
      }
      record = { schemaVersion: owner.contract, ownerKey, ...owner.fields, sessionId,
        bindingDigest, phase: 'creating', sandboxId: null, createIdentity: before.identity,
        requestDigest: before.requestDigest, createdAt: Date.now(), updatedAt: Date.now() };
      // Creation intent is durable before the external API is entered.
      write(record); guard(request, before);
      let created;
      try {
        created = await createSandbox({ signal: before.signal, metadata: { [owner.metadata.owner]: ownerKey,
          [owner.metadata.operation]: hash(before.identity) } });
        invariant(validId(created?.sandboxId), 'e2b_created_identity_invalid');
      } catch (error) {
        write(unknown(record, 'sandbox_create_outcome_unknown', validId(error?.sandboxId) ? error.sandboxId : null));
        throw Object.assign(new Error('Sandbox creation requires reconciliation'), { code: 'e2b_sandbox_outcome_unknown', uncertain: true });
      }
      try { guard(request, before); }
      catch {
        write(unknown(record, 'sandbox_create_authority_lost', created.sandboxId));
        throw Object.assign(new Error('Sandbox was created after its authority was lost'), { code: 'e2b_sandbox_outcome_unknown', uncertain: true });
      }
      write({ ...record, phase: 'ready', sandboxId: created.sandboxId, updatedAt: Date.now() });
      return { sandboxId: created.sandboxId, created: true };
    } finally { release(); }
  }
  async function close(request) {
    const before = snapshot(request); guard(request, before);
    const release = await lockUntil(join(directory, 'lifecycle.sqlite'), performance.now() + lockTimeoutMs);
    try {
      guard(request, before);
      let record = read();
      if (!record || record.phase === 'closed') return { confirmed: true, sandboxId: record?.sandboxId ?? null };
      if (!validId(record.sandboxId)) {
        write(unknown(record, 'sandbox_cleanup_identity_unknown'));
        throw Object.assign(new Error('Sandbox identity requires reconciliation'), { code: 'e2b_sandbox_outcome_unknown', uncertain: true });
      }
      record = { ...record, phase: 'closing', closeIdentity: before.identity, updatedAt: Date.now() }; write(record);
      let confirmed;
      try { confirmed = await killSandbox(record.sandboxId, { signal: before.signal }); }
      catch {
        write(unknown(record, 'sandbox_kill_outcome_unknown'));
        return { confirmed: false, sandboxId: record.sandboxId, uncertain: true };
      }
      try { guard(request, before); }
      catch {
        write(unknown(record, 'sandbox_kill_authority_lost'));
        return { confirmed: false, sandboxId: record.sandboxId, uncertain: true };
      }
      if (confirmed !== true) {
        write(unknown(record, 'sandbox_kill_unconfirmed'));
        return { confirmed: false, sandboxId: record.sandboxId, uncertain: true };
      }
      write({ ...record, phase: 'closed', updatedAt: Date.now() });
      return { confirmed: true, sandboxId: record.sandboxId };
    } finally { release(); }
  }

  /** Explicit Host recovery action, never a model tool or an automatic retry.
   * A separate exact-action authorization and an expected durable record hash
   * are required. A caller-supplied sandbox ID is only a lookup candidate:
   * the original bound backend must prove the metadata of THIS creation.
   * Adoption does not reconcile or replay any command that might have run.
   */
  async function reconcileAdoption(request, decision) {
    invariant(typeof inspectSandbox === 'function' && typeof assertReconciliationAuthority === 'function',
      'e2b_owner_reconciliation_unavailable');
    invariant(decision && validId(decision.sandboxId) && /^[a-f0-9]{64}$/.test(decision.expectedRecordDigest),
      'e2b_owner_reconciliation_decision_invalid');
    const fixedDecision = copy(decision), decisionDigest = hash(decision);
    const before = snapshot(request);
    const check = () => {
      invariant(hash(decision) === decisionDigest, 'e2b_owner_reconciliation_decision_drift');
      guard(request, before, current => assertReconciliationAuthority(current, copy(fixedDecision)));
    };
    check();
    const release = await lockUntil(join(directory, 'lifecycle.sqlite'), performance.now() + lockTimeoutMs);
    try {
      check();
      const record = read();
      invariant(record && hash(record) === fixedDecision.expectedRecordDigest, 'e2b_owner_reconciliation_record_changed');
      // An unfinished creator can only be classified after its OS lock was
      // acquired here. Its original creation metadata is retained unchanged.
      invariant(['creating', 'unknown'].includes(record.phase) && !record.closeIdentity,
        'e2b_owner_reconciliation_phase_invalid');
      invariant(record.sandboxId === null || record.sandboxId === fixedDecision.sandboxId,
        'e2b_owner_reconciliation_sandbox_mismatch');
      let observed;
      try { observed = await inspectSandbox(fixedDecision.sandboxId, { signal: before.signal }); }
      catch {
        throw Object.assign(new Error('Sandbox observation requires reconciliation'), {
          code: 'e2b_owner_reconciliation_observation_unknown', uncertain: true,
        });
      }
      check();
      invariant(observed?.sandboxId === fixedDecision.sandboxId && observed.state === 'running'
        && observed.metadata?.[owner.metadata.owner] === ownerKey
        && observed.metadata?.[owner.metadata.operation] === hash(record.createIdentity), 'e2b_owner_reconciliation_proof_invalid');
      // Keep the old unknown outcome and the reviewed record hash in the audit
      // record. No "not created" conclusion or permission to create anew.
      const reconciliation = { identity: before.identity, previousRecordDigest: fixedDecision.expectedRecordDigest,
        previousPhase: record.phase, previousOutcomeReason: record.outcomeReason ?? null,
        observationDigest: hash(observed), reconciledAt: Date.now() };
      write({ ...record, phase: 'ready', sandboxId: fixedDecision.sandboxId, outcomeReason: 'sandbox_adopted_after_verification',
        reconciliation, updatedAt: Date.now() });
      return { sandboxId: fixedDecision.sandboxId, adopted: true, commandsReconciled: false };
    } finally { release(); }
  }
  return Object.freeze({ contract: owner.contract, ownerKey, ensure, close,
    reconcileAdoption,
    inspectReconciliation: () => { const record = read(); return record ? { record: copy(record), recordDigest: hash(record) } : null; },
    inspect: () => { const record = read(); return record ? copy(record) : null; } });
}
