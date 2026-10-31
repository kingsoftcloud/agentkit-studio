// Host-only local-background cleanup controller. This is a private Host
// capability for conversation rewind: it cancels removed-branch local background
// commands while preserving retained rows exactly. It is not an advertised
// model tool, never falls back to an environment backend, never launches
// processes, fakes tools, mutates Native Run ledgers or marks notified. Retry
// is idempotent via the existing durable cancel file and terminal record.
import { canonical, copy, NativeError, backgroundCommandRef, scopeKey } from '@kingsoftcloud/agentkit-harness-core';
import { ownedCommandReceipt } from './owned-command.mjs';
import { LocalCommandStore } from './local-background.mjs';
import { TERMINAL } from './local-command-state.mjs';
import { lstatSync, realpathSync } from 'node:fs';

export const CONVERSATION_COMMAND_CONTROL_CONTRACT = 'agentkit.native-conversation-command-control/v1';
const STOP_WAIT_MS = 5000;
const ACCEPTED_BACKEND = 'local_process';
// wait() already rejects 'unknown'; this set is the explicit fail-closed guard.
const KNOWN_TERMINAL = new Set([...TERMINAL].filter(status => status !== 'unknown'));

const check = (condition, code) => { if (!condition) throw new NativeError(code); };
const same = (a, b) => canonical(a) === canonical(b);

export function createNativeConversationCommandControl({ workspaceRoot, stateRoot, scope, store, sessionId, isClosed = () => false }) {
  check(typeof workspaceRoot === 'string' && !!workspaceRoot, 'conversation_command_workspace_root_invalid');
  check(typeof stateRoot === 'string' && !!stateRoot, 'conversation_command_state_root_invalid');
  check(typeof sessionId === 'string' && !!sessionId.trim(), 'conversation_command_session_id_invalid');
  check(typeof isClosed === 'function', 'conversation_command_is_closed_invalid');
  check(store && typeof store.load === 'function' && typeof store.sessionHead === 'function', 'conversation_command_store_invalid');
  scopeKey(scope);
  const pinnedScope = copy(scope);
  // The owner binding is digest([realpath(workspace), 'local_process', sessionId]);
  // commandId(operationKey) is digest([owner, operationKey]). Verifying the ref's
  // taskId against this binding is what ties a head row to this local store.
  // Match the launch transport's physical paths (macOS /var is an alias).
  // The existing state directory itself must not be a substituted symlink.
  check(!lstatSync(stateRoot).isSymbolicLink(), 'background_state_symlink');
  const pinnedWorkspace = realpathSync(workspaceRoot), pinnedState = realpathSync(stateRoot);
  const localStore = new LocalCommandStore({ stateRoot: pinnedState, workspaceRoot: pinnedWorkspace, sessionId });

  async function settle({ record, retainedRefs, requestDigest, signal, assertCurrent }) {
    check(record && typeof record === 'object' && record.snapshot && typeof record.snapshot === 'object',
      'conversation_command_record_invalid');
    check(signal instanceof AbortSignal, 'conversation_command_signal_required');
    check(typeof assertCurrent === 'function', 'conversation_command_assert_current_required');
    check(typeof requestDigest === 'string' && !!requestDigest, 'conversation_command_request_digest_invalid');
    check(Array.isArray(retainedRefs), 'conversation_command_retained_refs_invalid');
    signal.throwIfAborted();
    const originalRecord = canonical(record), originalRefs = canonical(retainedRefs);
    const pinnedRecord = copy(record);
    check(same(pinnedRecord.snapshot.scope, pinnedScope), 'conversation_command_scope_mismatch');
    check(pinnedRecord.snapshot.sessionId === sessionId, 'conversation_command_session_mismatch');
    // assertCurrent is synchronous and must return exactly true, never a thenable.
    const guard = () => {
      signal.throwIfAborted();
      check(!isClosed(), 'conversation_command_control_closed');
      check(realpathSync(workspaceRoot) === pinnedWorkspace && realpathSync(stateRoot) === pinnedState,
        'conversation_command_workspace_changed');
      check(canonical(record) === originalRecord && canonical(retainedRefs) === originalRefs,
        'conversation_command_input_changed');
      const head = store.sessionHead(pinnedScope, sessionId);
      check(head && head.runId === pinnedRecord.snapshot.runId, 'conversation_command_head_mismatch');
      check(canonical(store.load(pinnedScope, head.runId)) === originalRecord, 'conversation_command_record_mismatch');
      const result = assertCurrent();
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).catch(() => {});
        throw new NativeError('conversation_command_authority_thenable');
      }
      check(result === true, 'conversation_command_authority_lost');
      signal.throwIfAborted();
      check(canonical(record) === originalRecord && canonical(retainedRefs) === originalRefs
        && store.sessionHead(pinnedScope, sessionId)?.runId === pinnedRecord.snapshot.runId
        && canonical(store.load(pinnedScope, pinnedRecord.snapshot.runId)) === originalRecord,
      'conversation_command_input_changed');
    };
    // Validate retained refs (shape + no duplicate taskIds).
    const retained = retainedRefs.map(item => backgroundCommandRef(item));
    check(new Set(retained.map(ref => ref.taskId)).size === retained.length, 'conversation_command_duplicate_ref');
    guard();
    signal.throwIfAborted();

    // Verify ALL head rows' launch provenance before any external stop. This
    // covers retained rows too: a retained row with a broken receipt fails the
    // whole settlement rather than leaving a partial stop behind.
    const headRows = pinnedRecord.snapshot.backgroundCommands;
    check(Array.isArray(headRows), 'conversation_command_record_invalid');
    check(new Set(headRows.map(row => row.ref.taskId)).size === headRows.length, 'conversation_command_duplicate_ref');
    const verified = [];
    for (const row of headRows) {
      const ref = backgroundCommandRef(row.ref);
      const receipt = ownedCommandReceipt({ scope: pinnedScope, store, current: pinnedRecord, ref });
      check(receipt.backend === ACCEPTED_BACKEND, 'conversation_command_unsupported_backend');
      check(localStore.commandId(ref.operationKey) === ref.taskId, 'conversation_command_task_id_mismatch');
      verified.push({ row, ref });
    }
    // Foreign retained refs: every retainedRef must match a verified head row.
    for (const ref of retained) {
      check(verified.some(item => same(item.ref, ref)), 'conversation_command_foreign_ref');
    }
    // Partition head rows in original snapshot order.
    const retainedRows = [], removedRows = [];
    for (const item of verified) {
      if (retained.some(ref => same(ref, item.ref))) retainedRows.push(item);
      else removedRows.push(item);
    }
    // Stop removed rows with a bounded wait; preserve retained rows (never stop).
    const stopped = [];
    for (const item of removedRows) {
      signal.throwIfAborted();
      const handle = localStore.connect(item.ref.taskId);
      guard(); // before the external mutation (durable cancel file)
      handle.requestCancel();
      let output;
      try {
        output = await handle.wait({ timeoutMs: STOP_WAIT_MS, signal });
      } catch (error) {
        signal.throwIfAborted();
        guard(); // after the await, even on the error path
        throw error;
      }
      guard(); // after the await
      check(KNOWN_TERMINAL.has(output.status), 'conversation_command_stop_status_unknown');
      stopped.push({ ref: copy(item.ref), status: output.status });
    }
    guard();
    return Object.freeze({
      contract: CONVERSATION_COMMAND_CONTROL_CONTRACT,
      requestDigest,
      retained: retainedRows.map(item => copy(item.row)),
      stopped,
    });
  }

  return Object.freeze({ contract: CONVERSATION_COMMAND_CONTROL_CONTRACT, settle });
}
