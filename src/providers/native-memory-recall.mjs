import { join } from 'node:path';
import { canonical, copy, invariant, CONTEXT_SOURCE_CONTRACT } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { memoryDigest } from '../../packages/agentkit-harness/src/native/memory-candidate.mjs';
import { NATIVE_MEMORY_RECALL, admitNativeMemoryRecords } from '../../packages/agentkit-harness/src/native/memory-recall.mjs';
import { SqliteNativeMemoryProvider } from '../../packages/agentkit-harness/src/native/memory-store.mjs';
import { studioNativeMemoryPolicy } from './native-memory.mjs';

/** Mutable Memory is a read-only, uncached Context source, not initial system
 * instructions and not an original user observation or acceptance result.
 */
export function bindStudioNativeMemoryRecall({ record, buildId = null, scope, sessionId, store, storeDir,
  providerFactory = (filename, options) => new SqliteNativeMemoryProvider(filename, options) }) {
  const policy = studioNativeMemoryPolicy(record.spec);
  if (!policy.enabled || policy.providerRef !== 'local-default' || !policy.recall.enabled || !policy.recall.maxTokens
    || !policy.scopes.length || record.spec.context?.contributors?.memoryRecall === false) return null;
  invariant(record.metadata?.id === scope.agentId && record.metadata.local === true
    && record.spec.runtime?.type === 'harness' && Number.isSafeInteger(record.metadata.revision) && record.metadata.revision > 0,
  'studio_native_memory_recall_binding_invalid');
  const boundScope = copy(scope), source = { contract: CONTEXT_SOURCE_CONTRACT, sourceId: 'studio.memory-recall', priority: 0,
    timeoutMs: 3000, required: false, maxTokens: policy.recall.maxTokens, maxBytes: 131072,
    bindingDigest: memoryDigest(canonical({ contract: NATIVE_MEMORY_RECALL, scope: boundScope, sessionId, buildId,
      revision: record.metadata.revision, spec: record.spec, provider: 'plugin://agentkit.local-memory@1', policy })) };
  const current = request => {
    request.signal.throwIfAborted();
    invariant(canonical(request.scope) === canonical(boundScope) && request.sessionId === sessionId
      && canonical(request.source) === canonical(source), 'studio_native_memory_recall_request_unbound');
    const run = store.load(boundScope, request.runId), snapshot = run.snapshot;
    const intent = run.intents.find(item => item.operationKey === request.operationKey);
    invariant(['runId', 'sessionId', 'turnId', 'buildId', 'parentRunId', 'taskChainId'].every(key => snapshot[key] === request[key])
      && (buildId === null || snapshot.buildId === buildId) && ['preparing_context', 'compacting'].includes(snapshot.phase)
      && canonical(snapshot) === canonical(request.snapshot)
      && canonical(run.configuration.contextSources.find(item => item.sourceId === source.sourceId)) === canonical(source)
      && snapshot.pendingIntent === request.operationKey && intent?.kind === 'context' && intent.status === 'running'
      && run.lease && run.lease.expiresAt > Date.now() && intent.claimedFence === run.lease.fence
      && request.executionFence === intent.claimedFence, 'studio_native_memory_recall_request_unbound');
  };
  return { source: copy(source), async readSource(request) {
    current(request);
    const provider = providerFactory(join(storeDir, 'native-harness', 'memory-v1', memoryDigest(scope.tenantId).slice(7), 'memory.sqlite'),
      { principal: boundScope, scopes: policy.scopes });
    let result;
    try { result = await provider.search({ query: request.snapshot.goal, topK: policy.recall.topK, minScore: policy.recall.minScore }); }
    finally { provider.close(); }
    current(request);
    invariant(result?.status === 'ok' && Array.isArray(result.records), 'studio_native_memory_recall_failed');
    const records = admitNativeMemoryRecords(result.records.slice(0, policy.recall.topK), { principal: boundScope, scopes: policy.scopes });
    return { items: records.map(fact => ({ contract: NATIVE_MEMORY_RECALL, kind: 'recalled_memory', classification: 'internal',
      currentFactVerification: false, content: fact.content, memoryId: fact.memoryId, contentHash: fact.contentHash, version: fact.version,
      providerRef: 'plugin://agentkit.local-memory@1', sourceRefs: ['memory://agentkit.local-memory/' + encodeURIComponent(fact.memoryId)],
      tenantId: fact.tenantId, workspaceId: fact.workspaceId, scope: fact.scope, scopeId: fact.scopeId,
      createdAt: fact.createdAt, updatedAt: fact.updatedAt, expiresAt: fact.expiresAt, validTo: fact.validTo,
      sourceSessionId: fact.sourceSessionId, sourceEventIds: fact.sourceEventIds, retrievalStrategy: result.retrievalStrategy })) };
  } };
}
