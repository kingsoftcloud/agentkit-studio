import type { RunConfiguration } from './contracts.mjs';
import { canonical, invariant } from './values.mjs';
import { validateContextMessages } from './context-view.mjs';
import { todoItems } from './todos.mjs';

/** Validate data only. The Host authenticates the source before admitting these bytes. */
export function validateConversationSeed(config: RunConfiguration): void {
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
