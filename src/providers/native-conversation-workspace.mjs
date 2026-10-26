import { canonical, invariant, parseNativeJson } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { nativeDeliveryTimeline } from '../../packages/agentkit-harness/src/native/delivery-timeline.mjs';
import { readNativeDshOwnership } from '../../packages/agentkit-harness/src/native/dsh-turn-ownership.mjs';
import { NATIVE_DSH_TURN_CONTRACT } from '../../packages/agentkit-harness/src/native/dsh-turn-contract.mjs';
import { committedWorkspaceCheckpoint } from '../../packages/agentkit-harness/src/native/workspace-checkpoints.mjs';

/** Same-Session workspace rewind selection is execution authority. Prove
 * committed Native receipts and the actual published turn boundaries; select the
 * earliest completed source mutation whose original launch call is NOT kept by
 * the before-input prefix. Never infer ownership from output text. */
export function nativeConversationWorkspaceCheckpoint({ store, scope, record, seed, prefix, sourceEvents, checkpoints }) {
  invariant(Array.isArray(checkpoints), 'native_conversation_checkpoints_invalid');
  const rows = checkpoints;
  const native = rows.filter(row => !row.controlBinding).sort((a, b) => Number(a.seq) - Number(b.seq));
  invariant(!native.some(row => ['prepared', 'compensating'].includes(row.status)), 'native_conversation_checkpoint_outcome_unknown');
  const sources = new Map();
  const sourceFor = runId => {
    if (sources.has(runId)) return sources.get(runId);
    const source = store.load(scope, runId);
    const owner = sourceEvents.find(event => event.type === 'turn/owner' && event.data.engine === NATIVE_DSH_TURN_CONTRACT
      && parseNativeJson(event.data.binding).identity?.runId === runId);
    invariant(owner, 'native_conversation_checkpoint_source_unavailable');
    const admission = readNativeDshOwnership(owner.data, { sessionId: record.snapshot.sessionId, turn: Number(source.snapshot.turnId) });
    invariant(canonical(admission.identity.scope) === canonical(scope) && admission.configDigest === source.snapshot.configDigest,
      'native_conversation_checkpoint_source_unavailable');
    const value = { source, owner, messages: nativeDeliveryTimeline(source).messages }; sources.set(runId, value); return value;
  };
  const keptCall = ({ source, owner, messages }, callId) => {
    if (!prefix.some(event => event.seq === owner.seq && canonical(event) === canonical(owner))) return false;
    if (prefix.some(event => event.seq > owner.seq && event.type === 'turn/end' && String(event.data.turn) === source.snapshot.turnId)) return true;
    return seed.messages.some(message => {
      if (message.history?.sourceRunId !== source.snapshot.runId) return false;
      const original = messages[message.history.sourceIndex];
      return original?.role === 'tool' && original.callId === callId
        || original?.role === 'assistant' && original.toolCalls?.some(call => call.callId === callId);
    });
  };
  // A missing journal cannot silently turn a successful legacy file write into
  // a files-preserved "combined" rewind. No-op tools need no checkpoint.
  const writers = new Set(['write_workspace_file', 'write_workspace_files', 'edit_workspace_file',
    'multi_edit_workspace_file', 'delete_workspace_file', 'apply_workspace_patch', 'rewind_workspace_files']);
  for (const row of native) {
    if (['failed', 'undone'].includes(row.status)) continue;
    invariant(committedWorkspaceCheckpoint(row, { store, scope, sessionId: record.snapshot.sessionId }),
      'native_conversation_checkpoint_uncommitted');
    sourceFor(row.binding.runId);
  }
  for (const event of sourceEvents) {
    if (event.type !== 'turn/owner' || event.data.engine !== NATIVE_DSH_TURN_CONTRACT) continue;
    const identity = parseNativeJson(event.data.binding).identity;
    if (identity?.sessionId !== record.snapshot.sessionId || canonical(identity.scope) !== canonical(scope)) continue;
    const info = sourceFor(identity.runId);
    for (const intent of info.source.intents.filter(item => item.kind === 'tool')) {
      const receipt = info.source.receipts.find(item => item.operationKey === intent.operationKey && item.status === 'committed');
      for (const [index, call] of intent.payload.calls.entries()) {
        const observed = index === 0 && intent.payload.calls.length === 1 ? info.source.receipts.find(item => {
          const query = info.source.intents.find(candidate => candidate.operationKey === item.operationKey && candidate.kind === 'tool_receipt');
          return item.status === 'committed' && query?.payload.originalOperationKey === intent.operationKey
            && query.payload.originalClaimedFence === intent.claimedFence && query.payload.callId === call.callId
            && item.result.contract === 'agentkit.tool-receipt-observation/v1'
            && item.result.originalOperationKey === intent.operationKey && item.result.callId === call.callId;
        })?.result.result : undefined;
        const result = receipt?.result.results?.[index] ?? observed;
        if (!writers.has(call.name) || result?.status !== 'ok' || keptCall(info, call.callId)
          || !result.workspaceChangedPaths?.length && !result.content?.path && !result.content?.checkpoint_id) continue;
        const row = native.find(item => item.id === result.content?.checkpoint_id && item.binding?.operationKey === intent.operationKey
          && item.binding.callId === call.callId && ['completed', 'undone'].includes(item.status));
        invariant(row && committedWorkspaceCheckpoint(row, { store, scope, sessionId: record.snapshot.sessionId }),
          'native_conversation_checkpoint_missing');
      }
    }
  }
  // Host administrative rows carry their own controlBinding; the journal owns
  // their integrity, so only Native tool rows are surveyed. An unsettled Native
  // operation anywhere leaves the workspace outcome unknown.
  for (const row of native) {
    if (['failed', 'undone'].includes(row.status)) continue;
    // A turn is kept only when its owner event is in the prefix AND it is either
    // closed (turn/end in prefix) or partial with seed history pointing at the
    // original accepted call. An owner in prefix without its input is not kept.
    if (!keptCall(sourceFor(row.binding.runId), row.binding.callId)) return row.id;
  }
  return null;
}
