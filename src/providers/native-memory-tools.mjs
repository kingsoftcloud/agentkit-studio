import { join } from 'node:path';
import { canonical, copy, invariant } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { memoryDigest, nativeMemoryScopeBindings, nativeUserMemoryCandidate,
  isExplicitMemoryInstruction } from '../../packages/agentkit-harness/src/native/memory-candidate.mjs';
import { SqliteNativeMemoryProvider } from '../../packages/agentkit-harness/src/native/memory-store.mjs';
import { buildNativeMemoryTools, nativeMemoryLockedDigest,
  NATIVE_MEMORY_TOOLS_CONTRACT } from '../../packages/agentkit-harness/src/native/memory-tools.mjs';
import { studioNativeMemoryPolicy, studioOriginalUserMemorySources } from './native-memory.mjs';

export { NATIVE_MEMORY_TOOLS_CONTRACT, nativeMemoryLockedDigest };

// KsADK memory/extraction.py explicit_memory_target (reference 355059d): decode one
// whole explicit goal without truncating its requested fact. Pure intent only;
// persisted provenance and write authorization remain the host's actual identities.
export function explicitMemoryTarget(goal) {
  const text = String(goal ?? '').trim();
  if (!text || !isExplicitMemoryInstruction(text)) return null;
  const candidate = nativeUserMemoryCandidate({ text, sourceEventId: 'explicit-target',
    scope: 'user', scopeId: 'explicit-target' });
  if (!candidate || !candidate.reason.startsWith('explicit_user')) return null;
  return [candidate.operation, candidate.content];
}

/** Compose the locked Memory tool port from a Studio agent record and the Host
 * run store. The parent supplies the trusted base authorizer, the manage_memory
 * consent authorizer, the token planner, and the Build digests. This wires the
 * run-store-backed authority and provenance resolvers the pure tool factory needs.
 * The caller owns the returned provider lifetime and composes the definitions. */
export function composeStudioNativeMemoryTools({ record, scope, store, storeDir,
  bundleDigest = '', profileDigest = '', pluginLockDigest = '', authorize, consent, planner,
  providerFactory = (filename, options) => new SqliteNativeMemoryProvider(filename, options) }) {
  const policy = studioNativeMemoryPolicy(record.spec);
  if (!policy.enabled || policy.providerRef !== 'local-default' || !policy.scopes.length) return null;
  invariant(record.metadata?.id === scope.agentId, 'studio_native_memory_tools_binding_invalid');
  invariant(typeof authorize === 'function' && typeof consent === 'function'
    && (policy.recall.maxTokens ? planner && typeof planner.countMessage === 'function' : true),
    'studio_native_memory_tools_capabilities_missing');
  const contextSpec = record.spec.context ?? {};
  const lockedDigest = nativeMemoryLockedDigest({ bundleDigest, profileDigest, pluginLockDigest,
    providerRef: policy.providerRef, memoryPolicy: policy, contextSpec });
  const filename = join(storeDir, 'native-harness', 'memory-v1', memoryDigest(scope.tenantId).slice(7), 'memory.sqlite');
  const provider = providerFactory(filename, { principal: scope, scopes: policy.scopes });
  const load = request => { try { return store.load(scope, request.runId); } catch { return null; } };

  // Only a recognized exact explicit user command narrowly skips the second
  // approval. forget never qualifies via model interpretation; a tool name or
  // committed text is not authorization. Authority is resolved from the actual
  // admitted goal, not from the model's tool arguments.
  const resolveAuthority = request => {
    const loaded = load(request);
    if (!loaded?.snapshot) return null;
    if (request.call.arguments?.action === 'forget') return null;
    const target = explicitMemoryTarget(loaded.snapshot.goal);
    return target && target[1] === request.call.arguments?.content ? 'explicit_user' : null;
  };

  // Resolve mutation provenance from the latest actual Run event at admission,
  // not an invented user event. For user scope, consume the original user sources
  // so an explicit write supersedes the auto profile candidate for that slot.
  const resolveMutationSource = request => {
    const loaded = load(request);
    if (!loaded?.snapshot) return null;
    const events = loaded.events ?? [], origin = events[events.length - 1];
    if (!origin) return null;
    let horizon = [];
    if (request.call.arguments?.scope === 'user' && policy.rollout !== 'shadow') {
      try {
        const messages = loaded.snapshot.messages ?? [];
        const messageRefs = messages.map((message, index) =>
          'message:' + index + ':' + memoryDigest(canonical(message)).slice(7));
        const sources = studioOriginalUserMemorySources({ store, scope, runId: request.runId, messages, messageRefs });
        const [binding] = nativeMemoryScopeBindings(scope, ['user']);
        horizon = sources.observations.map(observation => {
          const candidate = nativeUserMemoryCandidate({ text: observation.content,
            sourceEventId: observation.sourceEventId, ...binding });
          return candidate ? { candidate, sourceDigest: observation.sourceDigest } : null;
        }).filter(Boolean);
      } catch { horizon = []; }
    }
    return { sourceSessionId: loaded.snapshot.sessionId, sourceEventId: origin.eventId,
      sourceGoalRevision: String(loaded.snapshot.goalRevision),
      sourceGoalDigest: memoryDigest(loaded.snapshot.goal), horizon };
  };

  const tools = buildNativeMemoryTools({ policy, principal: scope, lockedDigest, provider,
    authorize, consent, planner, resolveAuthority, resolveMutationSource });
  return { ...tools, provider, lockedDigest, policy: copy(policy),
    close: () => provider.close() };
}
