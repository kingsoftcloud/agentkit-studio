import type { RunConfiguration } from './contracts.mjs';
import { canonical, invariant } from './values.mjs';
import { validateContextMessages } from './context-view.mjs';
import { todoItems } from './todos.mjs';
import { backgroundCommandRef } from './background-contract.mjs';

/** Validate data only. The Host authenticates the source before admitting these bytes. */
export function validateConversationSeed(config: RunConfiguration): void {
  const rewind = config.conversationRewind;
  if (rewind !== undefined) invariant(config.conversationSeed && rewind?.contract === 'native-conversation-rewind/v1'
    && Object.keys(rewind).filter(key => key !== 'retainedBackgroundCommands').sort().join(',') === 'commandId,contract,expectedHeadRunId,generation,markerDigest'
    && [rewind.commandId, rewind.expectedHeadRunId, rewind.markerDigest].every(value => typeof value === 'string' && value.trim())
    && Number.isSafeInteger(rewind.generation) && rewind.generation > 0, 'invalid_conversation_rewind');
  if (rewind?.retainedBackgroundCommands !== undefined) {
    const rows = rewind.retainedBackgroundCommands;
    invariant(Array.isArray(rows) && new Set(rows.map(row => canonical(row.ref))).size === rows.length
      && rows.every(row => Object.keys(row).sort().join(',') === 'notified,ref' && typeof row.notified === 'boolean'
        && canonical(backgroundCommandRef(row.ref)) === canonical(row.ref)), 'invalid_conversation_rewind_commands');
  }
  const seed = config.conversationSeed;
  if (seed === undefined) return;
  invariant(seed && seed.contract === 'native-conversation-fork/v1'
    && Object.keys(seed).every(key => ['contract', 'source', 'messages', 'todos', 'discoveredToolNames'].includes(key)), 'invalid_conversation_seed');
  const source = seed.source;
  invariant(source && Object.keys(source).sort().join(',') === 'boundarySeq,configDigest,parentSessionId,runId,sessionId,snapshotDigest,snapshotRevision,transcriptDigest,turnId'
    && [source.parentSessionId, source.sessionId, source.runId, source.turnId, source.configDigest, source.snapshotDigest, source.transcriptDigest]
      .every(value => typeof value === 'string' && value.trim())
    && [source.boundarySeq, source.snapshotRevision].every(value => Number.isSafeInteger(value) && value >= 0), 'invalid_conversation_seed_source');
  const messages = validateContextMessages(seed.messages);
  invariant(messages.every(message => message.role !== 'system' && message.history
    && typeof message.history.sourceRunId === 'string' && message.history.sourceRunId.trim()
    && Number.isSafeInteger(message.history.sourceIndex) && message.history.sourceIndex >= 0
    && message.operatorInputHistory === undefined && message.operatorGuidance === undefined
    && message.inputId === undefined && message.inputGoalRevision === undefined
    && message.providerReplay === undefined && message.replayToolIds === undefined
    && message.providerReplayProjection === undefined), 'invalid_conversation_seed_messages');
  invariant(seed.todos === undefined || config.todoPolicy === 'session-todos/v1'
    && canonical(todoItems(seed.todos)) === canonical(seed.todos), 'invalid_conversation_seed_todos');
  invariant(seed.discoveredToolNames === undefined || config.toolDiscoveryPolicy === 'local-tool-search/v1'
    && Array.isArray(seed.discoveredToolNames) && new Set(seed.discoveredToolNames).size === seed.discoveredToolNames.length
    && seed.discoveredToolNames.every(name => config.tools.some(tool => tool.name === name && tool.discovery)
      && (config.contract.allowedToolNames === null || config.contract.allowedToolNames.includes(name))), 'invalid_conversation_seed_discovery');
}
