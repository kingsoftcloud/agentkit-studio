import { canonical, invariant, projectSessionHistory } from '@kingsoftcloud/agentkit-harness-core';
import { memoryDigest } from '@kingsoftcloud/agentkit-harness-node/native/memory-candidate';
import { readNativeRecoveryBinding } from './native-recovery-binding.mjs';
import { perCallOperationKey } from './native-memory-turn.mjs';

export const STUDIO_NATIVE_MEMORY_EXTRACTION_SOURCE = 'agentkit.studio-native-memory-extraction-source/v1';
const user = message => message?.role === 'user' && (message.kind === undefined || message.kind === 'user_input');
const idFor = (runId, index) => `native-message://${runId}#message=${index}`;

// Only original human text admitted by the Host is a citation source. Tool,
// summary, schedule and assistant content never becomes write authority.
function originalHuman({ store, scope, message, index, runId, origins }) {
  const sourceRunId = message.history?.sourceRunId ?? runId;
  const sourceIndex = message.history?.sourceIndex ?? index;
  invariant(typeof sourceRunId === 'string' && sourceRunId && Number.isSafeInteger(sourceIndex)
    && sourceIndex >= 0, 'studio_native_memory_extraction_history_invalid');
  if (!origins.has(sourceRunId)) {
    try { origins.set(sourceRunId, store.load(scope, sourceRunId)); }
    catch (error) { if (error.code !== 'run_not_found') throw error; origins.set(sourceRunId, null); }
  }
  const origin = origins.get(sourceRunId);
  if (!origin) return null;
  const original = origin.snapshot.messages[sourceIndex];
  invariant(user(original) && !original.history && original.content === message.content
    && original.kind === message.kind, 'studio_native_memory_extraction_original_unbound');
  const capsule = readNativeRecoveryBinding(origin, { agentId: scope.agentId,
    sessionId: origin.snapshot.sessionId, runId: sourceRunId });
  const indexes = origin.snapshot.messages.flatMap((item, position) => item.role === 'user' && !item.history
    && ['user_input', 'dsh_context'].includes(item.kind) ? [position] : []).slice(0, capsule.messages.length);
  const inputIndex = indexes.indexOf(sourceIndex), configured = origin.configuration.inputMessages?.[inputIndex];
  invariant(inputIndex >= 0 && configured && configured.role === original.role
    && configured.kind === original.kind && configured.content === original.content,
  'studio_native_memory_extraction_admission_unbound');
  const admitted = capsule.messages[inputIndex];
  if (admitted.source?.kind !== 'user') return null;
  const content = admitted.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
  // Attachments and non-text input projections are not ordinary source prose.
  if (content !== original.content) return null;
  return { sourceEventId: idFor(sourceRunId, sourceIndex), sourceSessionId: origin.snapshot.sessionId,
    content, sourceDigest: memoryDigest(content) };
}

// A matching tool name or committed-looking JSON is insufficient: an actual
// ledger result AND the trusted Memory owner's original receipt must agree.
function confirmedDirectWrite(loaded, message, { manageMemoryToolNames, directWriteReceipt, scope, runId }) {
  if (message.role !== 'tool' || message.history || !manageMemoryToolNames.includes(message.name)) return false;
  const intent = loaded.intents.find(item => item.kind === 'tool'
    && Array.isArray(item.payload.calls) && item.payload.calls.some(call => call.callId === message.callId));
  const callIndex = intent?.payload.calls.findIndex(call => call.callId === message.callId);
  const call = intent?.payload.calls[callIndex], definition = loaded.configuration.tools.find(item => item.name === call?.name);
  const receipt = intent && loaded.receipts.find(item => item.operationKey === intent.operationKey);
  const result = receipt?.result.results?.[callIndex];
  invariant(call && definition && receipt?.status === 'committed' && result?.status === 'ok'
    && typeof directWriteReceipt === 'function', 'studio_native_memory_extraction_direct_write_unconfirmed');
  const ownerReceipt = directWriteReceipt({ scope, runId, operationKey: perCallOperationKey(intent, callIndex),
    call, definition, toolResultContent: result.content });
  if (ownerReceipt && typeof ownerReceipt.then === 'function') Promise.resolve(ownerReceipt).catch(() => {});
  invariant(ownerReceipt && typeof ownerReceipt.then !== 'function' && ownerReceipt.committed === true
    && canonical(ownerReceipt) === canonical(result.content), 'studio_native_memory_extraction_direct_write_unconfirmed');
  return true;
}

/** Trusted Host projection over the current completed Run. Sources have stable
 * original ledger identities across history projections; no regex intent gate
 * is applied. Cursor boundary is a message identity that survives continuation.
 * The synchronous owner receipt port is read-only and grants no tool execution. */
export function captureStudioNativeMemoryExtraction({ store, scope, sessionId, runId, record, buildId = null,
  manageMemoryToolNames = ['manage_memory'], directWriteReceipt } = {}) {
  invariant(record?.metadata?.id === scope?.agentId && record.metadata.local === true
    && Number.isSafeInteger(record.metadata.revision) && record.metadata.revision > 0
    && record.spec?.runtime?.type === 'harness', 'studio_native_memory_extraction_record_unbound');
  const loaded = store.load(scope, runId), snapshot = loaded.snapshot;
  invariant(canonical(snapshot.scope) === canonical(scope) && snapshot.sessionId === sessionId
    && snapshot.phase === 'completed' && (buildId === null || snapshot.buildId === buildId),
  'studio_native_memory_extraction_snapshot_unbound');
  const capsule = readNativeRecoveryBinding(loaded, { agentId: scope.agentId, sessionId, runId });
  invariant(capsule.agentRevision === record.metadata.revision && capsule.buildId === buildId,
    'studio_native_memory_extraction_capsule_unbound');
  const head = store.sessionHead(scope, sessionId);
  invariant(head?.runId === runId && canonical(head) === canonical(snapshot),
    'studio_native_memory_extraction_not_current_head');
  const origins = new Map([[runId, loaded]]), seen = new Set(), sources = [];
  // Use the kernel's real history projection. Its final answer may have a
  // virtual source index instead of the last raw snapshot message index.
  const transcript = projectSessionHistory(loaded, { ...loaded.configuration,
    profile: { ...loaded.configuration.profile, providerReplayMode: 'none' } }, value => memoryDigest(canonical(value)).slice(7));
  const messages = transcript.map((message, index) => {
    const sourceRunId = message.history?.sourceRunId ?? runId, sourceIndex = message.history?.sourceIndex ?? index;
    invariant(typeof sourceRunId === 'string' && sourceRunId && Number.isSafeInteger(sourceIndex)
      && sourceIndex >= 0, 'studio_native_memory_extraction_history_invalid');
    const id = idFor(sourceRunId, sourceIndex);
    const admitted = user(message) ? originalHuman({ store, scope, message, index, runId, origins }) : null;
    if (admitted && !seen.has(admitted.sourceEventId)) { seen.add(admitted.sourceEventId); sources.push(admitted); }
    let direct = false;
    if (message.role === 'tool' && manageMemoryToolNames.includes(message.name)) {
      const origin = origins.get(sourceRunId) ?? store.load(scope, sourceRunId);
      origins.set(sourceRunId, origin);
      const original = origin.snapshot.messages[sourceIndex];
      if (original && !original.history) direct = confirmedDirectWrite(origin, original,
        { manageMemoryToolNames, directWriteReceipt, scope, runId: sourceRunId });
    }
    // Ordinary assistant prose is useful untrusted context. Do not project tool
    // bodies, system instructions, summaries, media or provider replay blocks.
    const text = admitted ? admitted.content : message.role === 'assistant' && !message.kind
      && typeof message.content === 'string' ? message.content : '';
    return { id, role: message.role, text, ...(!admitted ? { modelOnly: true } : {}),
      ...(!admitted && message.role !== 'assistant' ? { synthetic: true } : {}),
      ...(direct ? { directMemoryWrite: true } : {}) };
  });
  invariant(messages.length > 0, 'studio_native_memory_extraction_empty');
  const parent = { scope: structuredClone(scope), sessionId, runId, buildId,
    configDigest: snapshot.configDigest, revision: record.metadata.revision, runRevision: snapshot.revision,
    goalRevision: snapshot.goalRevision, goalDigest: memoryDigest(snapshot.goal) };
  const boundaryId = messages.at(-1).id;
  const sourceDigest = memoryDigest(canonical({ contract: STUDIO_NATIVE_MEMORY_EXTRACTION_SOURCE,
    parent, boundaryId, messages, sources }));
  return { contract: STUDIO_NATIVE_MEMORY_EXTRACTION_SOURCE, boundaryId, parent, sourceDigest, messages, sources };
}

export function assertStudioNativeMemoryExtractionCurrent(snapshot, options) {
  invariant(snapshot?.contract === STUDIO_NATIVE_MEMORY_EXTRACTION_SOURCE,
    'studio_native_memory_extraction_assert_contract');
  const fresh = captureStudioNativeMemoryExtraction({ ...options, scope: snapshot.parent.scope,
    sessionId: snapshot.parent.sessionId, runId: snapshot.parent.runId });
  invariant(canonical(fresh) === canonical(snapshot), 'studio_native_memory_extraction_stale_or_tampered');
}
