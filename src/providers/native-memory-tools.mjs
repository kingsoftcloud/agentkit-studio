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

  // Strict original-user provenance, computed once per request and shared by
  // resolveAuthority and resolveMutationSource. studioOriginalUserMemorySources
  // validates that each message is a real admitted original human statement
  // (no history projection, matching admission config); schedules, attachments
  // and history projections are NOT treated as human authority. A corrupt or
  // mismatched projection fails closed here; non-human context is never wrapped
  // into a source.
  const provenanceCache = new WeakMap();
  const provenance = request => {
    if (provenanceCache.has(request)) return provenanceCache.get(request);
    const loaded = load(request);
    let result;
    if (!loaded?.snapshot) result = { ok: false, code: 'memory_source_event_unavailable' };
    else {
      const events = loaded.events ?? [], origin = events[events.length - 1];
      if (!origin) result = { ok: false, code: 'memory_source_event_unavailable' };
      else {
        const messages = loaded.snapshot.messages ?? [];
        const messageRefs = messages.map((message, index) =>
          'message:' + index + ':' + memoryDigest(canonical(message)).slice(7));
        try {
          const sources = studioOriginalUserMemorySources({ store, scope, runId: request.runId, messages, messageRefs });
          const [binding] = nativeMemoryScopeBindings(scope, ['user']);
          const horizon = sources.observations.map(observation => {
            const candidate = nativeUserMemoryCandidate({ text: observation.content,
              sourceEventId: observation.sourceEventId, ...binding });
            return candidate ? { candidate, sourceDigest: observation.sourceDigest } : null;
          }).filter(Boolean);
          result = { ok: true, snapshot: loaded.snapshot, origin, horizon };
        } catch (error) {
          // Corrupt/mismatched source projection: fail closed, never an empty horizon.
          result = { ok: false, code: 'memory_source_unavailable', reason: error?.code ?? 'provenance_failed' };
        }
      }
    }
    provenanceCache.set(request, result);
    return result;
  };

  // Only a recognized exact explicit user command narrowly skips the second
  // approval. Authority is resolved from the actual current Run's original-user
  // provenance, not from snapshot.goal text (which may carry schedules,
  // attachments or history projections). forget never qualifies; a tool name or
  // committed text is not authorization. No match -> consent (approved_call).
  const resolveAuthority = request => {
    if (request.call.arguments?.action === 'forget') return null;
    const p = provenance(request);
    if (!p.ok) return null;
    const args = request.call.arguments;
    for (const { candidate } of p.horizon) {
      if (!candidate.reason.startsWith('explicit_user')) continue;
      const operation = candidate.operation === 'add' ? 'remember' : 'correct';
      if (operation === args.action && candidate.content === args.content) return 'explicit_user';
    }
    return null;
  };

  // Resolve mutation provenance from the latest actual Run event, not an
  // invented user event. A missing run/event or a corrupt source projection
  // returns null / throws so execute fails closed with a stable error and never
  // asks for consent over a write that cannot be provenanced. For user scope the
  // original user sources are consumed as the write horizon so an explicit write
  // supersedes the auto profile candidate for that slot.
  const resolveMutationSource = request => {
    const p = provenance(request);
    if (!p.ok) {
      if (p.code === 'memory_source_unavailable')
        throw Object.assign(new Error(p.code), { code: p.code, reason: p.reason });
      return null;
    }
    const horizon = request.call.arguments?.scope === 'user' && policy.rollout !== 'shadow' ? p.horizon : [];
    return { sourceSessionId: p.snapshot.sessionId, sourceEventId: p.origin.eventId,
      sourceGoalRevision: String(p.snapshot.goalRevision),
      sourceGoalDigest: memoryDigest(p.snapshot.goal), horizon };
  };

  const tools = buildNativeMemoryTools({ policy, principal: scope, lockedDigest, provider,
    authorize, consent, planner, resolveAuthority, resolveMutationSource });
  return { ...tools, provider, lockedDigest, policy: copy(policy),
    close: () => provider.close() };
}
