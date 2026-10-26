import { join } from 'node:path';
import { canonical, copy, invariant } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { memoryDigest, nativeMemoryScopeBindings, nativeUserMemoryCandidate, evaluateNativeMemoryCandidate,
  NATIVE_USER_EXTRACTION_POLICY } from '../../packages/agentkit-harness/src/native/memory-candidate.mjs';
import { SqliteNativeMemoryProvider, NATIVE_MEMORY_STORE } from '../../packages/agentkit-harness/src/native/memory-store.mjs';
import { createStudioNativeHookRegistry, STUDIO_NATIVE_HOOK_CONTRACT } from './native-hooks.mjs';
import { readNativeRecoveryBinding } from './native-recovery-binding.mjs';

export const STUDIO_NATIVE_MEMORY = 'agentkit.studio-native-memory/v1';
const hash = value => memoryDigest(canonical(value));
const user = message => message?.role === 'user' && (message.kind === undefined || message.kind === 'user_input');

export function studioNativeMemoryExtractionPolicy(spec) {
  const raw = spec.memory?.extraction;
  invariant(raw === undefined || raw && typeof raw === 'object' && !Array.isArray(raw)
    && Object.keys(raw).every(key => ['enabled', 'minUserCharacters'].includes(key)),
  'studio_native_memory_extraction_policy_invalid');
  const policy = { enabled: raw?.enabled ?? false, minUserCharacters: raw?.minUserCharacters ?? 64 };
  invariant(typeof policy.enabled === 'boolean' && Number.isSafeInteger(policy.minUserCharacters)
    && policy.minUserCharacters >= 1 && policy.minUserCharacters <= 100000,
  'studio_native_memory_extraction_policy_invalid');
  return policy;
}

export function studioNativeModelMemoryEnabled(spec) {
  const policy = studioNativeMemoryPolicy(spec);
  return studioNativeMemoryExtractionPolicy(spec).enabled && policy.enabled
    && policy.providerRef === 'local-default' && policy.scopes.length > 0
    && policy.write.mode === 'candidate' && policy.write.flushAfterTurn && policy.rollout !== 'off';
}

export function studioNativeMemoryPolicy(spec) {
  const memory = spec.memory ?? {};
  const policy = { enabled: memory.enabled ?? false, providerRef: memory.providerRef ?? 'local-default',
    scopes: memory.scopes ?? ['workspace', 'agent', 'user'],
    recall: { enabled: memory.recall?.enabled ?? true, maxTokens: memory.recall?.maxTokens ?? 1600,
      topK: memory.recall?.topK ?? 8, minScore: memory.recall?.minScore ?? .45 },
    write: { mode: memory.write?.mode ?? 'candidate', flushBeforeCompaction: memory.write?.flushBeforeCompaction ?? true,
      flushAfterTurn: memory.write?.flushAfterTurn ?? true },
    rollout: spec.context?.rollout?.memoryWrite ?? 'shadow' };
  invariant(typeof policy.enabled === 'boolean' && typeof policy.providerRef === 'string'
    && Array.isArray(policy.scopes) && policy.scopes.every(scope => ['tenant', 'workspace', 'agent', 'user'].includes(scope))
    && typeof policy.recall.enabled === 'boolean' && Number.isSafeInteger(policy.recall.maxTokens) && policy.recall.maxTokens >= 0
    && Number.isSafeInteger(policy.recall.topK) && policy.recall.topK >= 1 && policy.recall.topK <= 64
    && Number.isFinite(policy.recall.minScore) && policy.recall.minScore >= 0 && policy.recall.minScore <= 1
    && ['off', 'explicit_only', 'candidate'].includes(policy.write.mode)
    && typeof policy.write.flushBeforeCompaction === 'boolean' && typeof policy.write.flushAfterTurn === 'boolean'
    && ['off', 'shadow', 'enabled'].includes(policy.rollout), 'studio_native_memory_policy_invalid');
  // Preserve the exact legacy policy identity when this opt-in field is absent.
  if (memory.extraction !== undefined) policy.extraction = studioNativeMemoryExtractionPolicy(spec);
  return copy(policy);
}

/** Confirm projected originals against both their ledger and Host admission.
 * The capsule keeps schedules/context distinct even though both may use a user
 * model role. Attachment bytes, tool bodies and summaries are never extracted.
 */
export function studioOriginalUserMemorySources({ store, scope, runId, messages, messageRefs }) {
  invariant(Array.isArray(messages) && Array.isArray(messageRefs) && messages.length === messageRefs.length,
    'studio_native_memory_projection_invalid');
  const current = store.load(scope, runId), [business] = nativeMemoryScopeBindings(scope);
  const origins = new Map(), seen = new Set(), observations = [];
  let unavailable = 0;
  for (const [position, message] of messages.entries()) {
    if (!user(message)) continue;
    const ref = messageRefs[position], match = typeof ref === 'string' && /^message:(\d+):([a-f0-9]{64})$/u.exec(ref);
    invariant(match && Number.isSafeInteger(Number(match[1])), 'studio_native_memory_projection_unbound');
    const index = Number(match[1]);
    invariant(current.snapshot.messages[index] && canonical(current.snapshot.messages[index]) === canonical(message)
      && memoryDigest(canonical(message)).slice(7) === match[2], 'studio_native_memory_projection_unbound');
    const sourceRunId = message.history?.sourceRunId ?? runId, sourceIndex = message.history?.sourceIndex ?? index;
    const sourceEventId = `native-message://${sourceRunId}#message=${sourceIndex}`;
    if (seen.has(sourceEventId)) continue;
    if (!origins.has(sourceRunId)) {
      try { origins.set(sourceRunId, store.load(scope, sourceRunId)); }
      catch (error) { if (error.code !== 'run_not_found') throw error; origins.set(sourceRunId, null); }
    }
    const origin = origins.get(sourceRunId);
    if (!origin) {
      if (nativeUserMemoryCandidate({ text: message.content, sourceEventId, ...business })) unavailable++;
      continue;
    }
    const original = origin.snapshot.messages[sourceIndex];
    invariant(Number.isSafeInteger(sourceIndex) && sourceIndex >= 0 && user(original) && !original.history
      && original.content === message.content && original.kind === message.kind, 'studio_native_memory_original_source_unbound');
    const capsule = readNativeRecoveryBinding(origin, { agentId: scope.agentId, sessionId: origin.snapshot.sessionId, runId: sourceRunId });
    const admittedIndexes = origin.snapshot.messages.flatMap((item, index) => item.role === 'user' && !item.history
      && ['user_input', 'dsh_context'].includes(item.kind) ? [index] : []).slice(0, capsule.messages.length);
    const inputIndex = admittedIndexes.indexOf(sourceIndex), configured = origin.configuration.inputMessages?.[inputIndex];
    invariant(inputIndex >= 0 && configured && configured.role === original.role && configured.kind === original.kind
      && configured.content === original.content, 'studio_native_memory_original_source_unbound');
    const admitted = capsule.messages[inputIndex];
    if (admitted.source && admitted.source.kind !== 'user') continue;
    const content = admitted.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
    if (!nativeUserMemoryCandidate({ text: content, sourceEventId, ...business })) continue;
    seen.add(sourceEventId);
    observations.push({ sourceEventId, sourceSessionId: origin.snapshot.sessionId, content, sourceDigest: memoryDigest(content) });
  }
  return { observations, unavailable };
}

/** PreCompact only. Recall, explicit tools, verification and the post-turn
 * consumer have separate semantics and must be installed separately.
 */
export function bindStudioNativeMemoryFlush({ record, buildId = null, scope, sessionId, store, storeDir, contextWindow,
  effectTimeoutMs = 120000, providerFactory = (filename, options) => new SqliteNativeMemoryProvider(filename, options) }) {
  const policy = studioNativeMemoryPolicy(record.spec);
  // Model extraction owns automatic candidates; the original user-requested
  // path stays available without a second automatic extraction strategy.
  if (studioNativeModelMemoryEnabled(record.spec)) policy.write.mode = 'explicit_only';
  if (!policy.enabled || policy.providerRef !== 'local-default' || !policy.scopes.includes('user')
    || policy.write.mode === 'off' || !policy.write.flushBeforeCompaction || policy.rollout === 'off') return null;
  invariant(Number.isSafeInteger(contextWindow) && contextWindow > 0 && Number.isSafeInteger(contextWindow * 8)
    && Number.isSafeInteger(effectTimeoutMs) && effectTimeoutMs >= 4, 'studio_native_memory_budget_invalid');
  const registry = createStudioNativeHookRegistry(), cleanupTimeoutMs = Math.floor(effectTimeoutMs / 4);
  registry.register({ sourceRef: 'plugin://agentkit.local-memory@1',
    sourceDigest: hash([STUDIO_NATIVE_MEMORY, NATIVE_MEMORY_STORE, NATIVE_USER_EXTRACTION_POLICY]),
    agentIds: [scope.agentId], authorizationVersion: STUDIO_NATIVE_MEMORY,
    authorize: async () => 'allow',
    configuration: { contract: STUDIO_NATIVE_HOOK_CONTRACT, cleanupTimeoutMs,
      hooks: [{ hookId: 'agentkit.memory.precompact', events: ['PreCompact'], compactionSourceProjection: 'canonical_user',
        readOnly: policy.rollout === 'shadow', timeoutMs: Math.floor(effectTimeoutMs / 2),
        maxInputBytes: contextWindow * 8, maxOutputBytes: 16384, failureMode: 'warn' }] },
    callback: async request => {
      const sources = studioOriginalUserMemorySources({ store, scope, runId: request.runId,
        messages: request.input.compaction.messages, messageRefs: request.input.compaction.messageRefs });
      const [business] = nativeMemoryScopeBindings(scope);
      const candidates = sources.observations.flatMap(observation => {
        const candidate = nativeUserMemoryCandidate({ text: observation.content, sourceEventId: observation.sourceEventId, ...business });
        return candidate && (policy.write.mode !== 'explicit_only' || candidate.reason.startsWith('explicit_user')) ? [{ observation, candidate }] : [];
      });
      let status = 'empty', results = [];
      if (candidates.length && policy.rollout === 'shadow') {
        status = 'shadow'; results = candidates.map(({ candidate }) => ({ decision: evaluateNativeMemoryCandidate(candidate).decision }));
      } else if (candidates.length) {
        status = 'evaluated';
        request.signal.throwIfAborted();
        const filename = join(storeDir, 'native-harness', 'memory-v1', memoryDigest(scope.tenantId).slice(7), 'memory.sqlite');
        const provider = providerFactory(filename, { principal: scope, scopes: policy.scopes });
        try {
          for (const { observation, candidate } of candidates) {
            request.signal.throwIfAborted();
            const operationKey = 'native-memory-candidate:' + hash({ scope, policy, extraction: NATIVE_USER_EXTRACTION_POLICY,
              sourceEventId: observation.sourceEventId }).slice(7);
            results.push(provider.applyCandidate({ candidate, operationKey, sourceSessionId: observation.sourceSessionId, sourceDigest: observation.sourceDigest }));
          }
        } finally { provider.close(); }
      }
      const decisions = {};
      for (const result of results) decisions[result.decision] = (decisions[result.decision] ?? 0) + 1;
      return { additionalContext: [canonical({ memoryCandidateFlush: status, proposed: candidates.length,
        decisions, sourceUnavailable: sources.unavailable, currentFactVerification: false, trustLevel: 'untrusted' })] };
    } });
  const port = registry.bind({ scope, sessionId, record, buildId, store });
  return { ...port, close: () => registry.close() };
}

/** Validate before returning any composed port. The caller owns each lifetime. */
export function composeStudioNativeHooks(...inputs) {
  const ports = inputs.filter(Boolean); if (!ports.length) return null;
  const routes = new Map(), definitions = [], limits = new Set();
  for (const port of ports) {
    for (const definition of port.definitions) {
      invariant(!routes.has(definition.hookId), 'studio_native_hook_id_duplicate');
      routes.set(definition.hookId, port); definitions.push(definition);
    }
    if (port.definitions.some(definition => definition.events.includes('Stop'))) limits.add(port.stopContinuationLimit);
  }
  invariant(limits.size <= 1, 'studio_native_hook_stop_policy_conflict');
  return { definitions: copy(definitions), stopContinuationLimit: [...limits][0] ?? 0,
    requiredEffectTimeoutMs: Math.max(...ports.map(port => port.requiredEffectTimeoutMs)),
    invoke: request => { const port = routes.get(request.definition.hookId); invariant(port, 'studio_native_hook_definition_unbound'); return port.invoke(request); },
    close: () => Promise.all(ports.map(port => port.close())).then(() => {}) };
}
