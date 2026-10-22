/** Host-owned remote sandbox creation/cleanup, with durable unknown outcomes.
 * The Native tool intent surrounds these operations. A second process cannot
 * turn an unfinished creation into permission to create a second sandbox.
 */
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { canonical, copy, invariant, scopeKey } from '../../../agentkit-harness-core/dist/index.mjs';
import { atomicPrivate, lockUntil, privateDirectory, readAll } from './local-command-state.mjs';

export const NATIVE_E2B_SANDBOX_OWNER = 'agentkit.native-e2b-sandbox-owner/v1';
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const phases = new Set(['creating', 'ready', 'unknown', 'closing', 'closed']);
const outcomeUnknown = () => Object.assign(new Error('Sandbox outcome requires reconciliation'), {
  code: 'e2b_sandbox_outcome_unknown', uncertain: true,
});

export function createNativeE2BSandboxOwner({ stateRoot, workspaceRoot, scope, sessionId, bindingDigest,
  assertAuthority, createSandbox, killSandbox, lockTimeoutMs = 5000 } = {}) {
  const scopeIdentity = scopeKey(scope), fixedScope = copy(scope);
  invariant(typeof sessionId === 'string' && sessionId.trim(), 'e2b_owner_session_required');
  invariant(typeof bindingDigest === 'string' && /^[a-f0-9]{64}$/.test(bindingDigest), 'e2b_owner_binding_required');
  invariant(typeof assertAuthority === 'function' && typeof createSandbox === 'function' && typeof killSandbox === 'function', 'e2b_owner_capabilities_required');
  invariant(Number.isSafeInteger(lockTimeoutMs) && lockTimeoutMs > 0 && lockTimeoutMs <= 120000, 'e2b_owner_lock_timeout_invalid');
  const workspace = realpathSync(workspaceRoot), lexical = resolve(stateRoot);
  invariant(lexical !== workspace && !lexical.startsWith(workspace + sep), 'e2b_owner_state_inside_workspace');
  privateDirectory(dirname(lexical), false); privateDirectory(lexical, true);
  const root = realpathSync(lexical);
  invariant(root !== workspace && !root.startsWith(workspace + sep), 'e2b_owner_state_inside_workspace');
  const ownerKey = hash({ scope: fixedScope, sessionId, workspace });
  const directory = join(root, ownerKey); privateDirectory(directory, true);
  const filename = join(directory, 'owner.json');
  const write = record => atomicPrivate(filename, canonical(record) + '\n');
  function read() {
    if (!existsSync(filename)) return null;
    const record = JSON.parse(readAll(filename));
    invariant(record.schemaVersion === NATIVE_E2B_SANDBOX_OWNER && record.ownerKey === ownerKey
      && canonical(record.scope) === canonical(fixedScope) && record.sessionId === sessionId
      && phases.has(record.phase) && (record.sandboxId === null || validId(record.sandboxId)), 'e2b_owner_record_invalid');
    invariant(record.bindingDigest === bindingDigest, 'e2b_owner_binding_changed');
    invariant(record.phase !== 'ready' || validId(record.sandboxId), 'e2b_owner_record_invalid');
    return record;
  }
  function snapshot(request) {
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
  }
  function guard(request, before) {
    invariant(realpathSync(workspaceRoot) === workspace && realpathSync(lexical) === root, 'e2b_owner_root_changed');
    const current = snapshot(request);
    invariant(current.requestDigest === before.requestDigest && current.signal === before.signal, 'e2b_owner_context_drift');
    before.signal.throwIfAborted();
    invariant(assertAuthority(request) === true, 'e2b_owner_authority_unproven');
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
      record = { schemaVersion: NATIVE_E2B_SANDBOX_OWNER, ownerKey, scope: fixedScope, sessionId,
        bindingDigest, phase: 'creating', sandboxId: null, createIdentity: before.identity,
        requestDigest: before.requestDigest, createdAt: Date.now(), updatedAt: Date.now() };
      // Creation intent is durable before the external API is entered.
      write(record); guard(request, before);
      let created;
      try {
        created = await createSandbox({ signal: before.signal, metadata: { nativeOwner: ownerKey,
          nativeCreateOperation: hash(before.identity) } });
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
  return Object.freeze({ contract: NATIVE_E2B_SANDBOX_OWNER, ownerKey, ensure, close,
    inspect: () => { const record = read(); return record ? copy(record) : null; } });
}
