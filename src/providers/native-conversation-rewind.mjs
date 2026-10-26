import { createHash } from 'node:crypto';
import { canonical, copy, invariant, backgroundCommandRef } from '../../packages/agentkit-harness-core/dist/index.mjs';

export const NATIVE_CONVERSATION_REWIND_SOURCE = 'agentkit-native-conversation-rewind';
export const conversationDigest = value => createHash('sha256').update(canonical(value)).digest('hex');
export function nativeConversationRewindMarkers(events) {
  const markers = events.filter(event => event.type === 'user/message' && event.data.source?.kind === NATIVE_CONVERSATION_REWIND_SOURCE);
  const generations = new Map();
  for (const event of markers) {
    const marker = event.data.source.nativeRewind;
    invariant(marker?.contract === 'native-conversation-rewind/v1' && Number.isSafeInteger(marker.generation)
      && typeof marker.sessionId === 'string' && marker.sessionId.trim()
      && marker.generation > (generations.get(marker.sessionId) ?? 0) && typeof marker.commandId === 'string' && marker.commandId.trim()
      && typeof marker.expectedHeadRunId === 'string' && marker.expectedHeadRunId.trim()
      && typeof marker.targetMessageId === 'string' && marker.targetMessageId.trim() && marker.seed,
    'native_conversation_rewind_marker_invalid');
    if (marker.commandCleanup !== undefined) {
      const cleanup = marker.commandCleanup;
      invariant(cleanup?.contract === 'agentkit.native-conversation-command-control/v1' && cleanup.requestDigest === marker.requestDigest
        && Array.isArray(cleanup.retained) && Array.isArray(cleanup.stopped)
        && cleanup.retained.every(row => typeof row.notified === 'boolean' && canonical(backgroundCommandRef(row.ref)) === canonical(row.ref))
        && cleanup.stopped.every(row => ['completed', 'failed', 'canceled', 'timed_out', 'output_limit'].includes(row.status)
          && canonical(backgroundCommandRef(row.ref)) === canonical(row.ref))
        && new Set([...cleanup.retained, ...cleanup.stopped].map(row => canonical(row.ref))).size === cleanup.retained.length + cleanup.stopped.length,
      'native_conversation_rewind_marker_invalid');
    }
    if (marker.workspaceCleanup !== undefined) {
      const cleanup = marker.workspaceCleanup;
      invariant(cleanup?.contract === 'agentkit.native-conversation-workspace-control/v1'
        && cleanup.requestDigest === marker.requestDigest && typeof cleanup.previewToken === 'string'
        && (cleanup.checkpointId === null || typeof cleanup.checkpointId === 'string')
        && Array.isArray(cleanup.rewoundCheckpointIds) && cleanup.rewoundCheckpointIds.every(id => typeof id === 'string')
        && Array.isArray(cleanup.changedPaths) && cleanup.changedPaths.every(path => typeof path === 'string'),
      'native_conversation_rewind_marker_invalid');
    }
    generations.set(marker.sessionId, marker.generation);
  }
  return markers;
}

/** A durable Session marker is admitted only by its next Run. Later turns carry
 * the branch generation and inherit their own rebased ledger history normally. */
export function nativeConversationRewindAdmission({ session, head, turn, sameTurnConfiguration }) {
  const event = nativeConversationRewindMarkers(session.snapshotEvents())
    .filter(event => event.data.source.nativeRewind.sessionId === String(session.id) && session.isOwnSeq(event.seq)).at(-1);
  if (!event) return {};
  const marker = event.data.source.nativeRewind, generation = head?.conversationBranch?.generation ?? 0;
  if (head?.turnId === String(turn) && sameTurnConfiguration?.conversationRewind) return {
    conversationSeed: copy(sameTurnConfiguration.conversationSeed), conversationRewind: copy(sameTurnConfiguration.conversationRewind) };
  if (generation >= marker.generation) {
    invariant(generation === marker.generation && head.conversationBranch.commandId === marker.commandId,
      'native_conversation_rewind_generation_conflict');
    return {};
  }
  invariant(head && head.runId === marker.expectedHeadRunId && head.turnId !== String(turn), 'native_conversation_rewind_head_conflict');
  return { conversationSeed: copy(marker.seed), conversationRewind: {
    contract: marker.contract, commandId: marker.commandId, expectedHeadRunId: marker.expectedHeadRunId,
    generation: marker.generation, markerDigest: conversationDigest(event),
    ...(marker.commandCleanup ? { retainedBackgroundCommands: copy(marker.commandCleanup.retained) } : {}) } };
}
