import { join } from 'node:path';
import { canonical, invariant } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { memoryDigest, nativeMemoryScopeBindings, nativeUserMemoryCandidate, evaluateNativeMemoryCandidate,
  NATIVE_USER_EXTRACTION_POLICY, isExplicitMemoryInstruction } from '../../packages/agentkit-harness/src/native/memory-candidate.mjs';
import { SqliteNativeMemoryProvider } from '../../packages/agentkit-harness/src/native/memory-store.mjs';
import { studioNativeMemoryPolicy, studioOriginalUserMemorySources } from './native-memory.mjs';

/** Optional completed-Turn consumption by the selected DSH Memory owner.

 * The Native adapter's owned close task awaits this deterministic stage after
 * terminal commit. It is not an auxiliary model or a second Run state machine.
 * Only the owning Memory Provider's receipts prove writes; a failure here
 * cannot replace the main task's terminal, final answer, usage or verification
 * evidence. This binding only reads the Run ledger and writes the local Memory
 * store; the Host lifecycle (when to call consume) is the parent's responsibility.
 */
export const STUDIO_NATIVE_MEMORY_TURN = 'agentkit.studio-native-memory-turn/v1';

/** Explicit durable-Memory tasks already have an independent persistence owner and
 * repair loop. The reference acceptance contract (native_memory_acceptance.py)
 * pins these identities on the task contract. The set is extensible so a future
 * acceptance verifier can register its identity without editing this module. */
export const DEFAULT_EXPLICIT_MEMORY_VERIFIERS = Object.freeze([
  { verifierRef: 'studio.explicit-durable-memory', verifierVersion: '2' },
]);

/** Tool records that carry their own owner receipt. The default matches the
 * reference manage_memory tool; the set is extensible so the parent can register
 * the actual tool name(s) once the dedicated tool module is wired in. */
export const DEFAULT_MANAGE_MEMORY_TOOL_NAMES = Object.freeze(['manage_memory']);

const user = message => message?.role === 'user' && (message.kind === undefined || message.kind === 'user_input');
const bytes = value => Buffer.byteLength(value, 'utf8');

/** Original user observations do not require semantic proof of the answer.

 * Keep failed/blocked verification conservative. A host that cannot verify an
 * ordinary answer may still consume its independently pinned user input. The
 * Memory owner continues to decide candidate, shadow and write policy. */
export function completedTurnMemoryEligible(snapshot) {
  if (snapshot.outcome === 'verified') return true;
  if (snapshot.outcome !== 'unverified') return false;
  if (snapshot.reason === 'required_acceptance_empty' || snapshot.reason === 'verification_report_missing') return true;
  if (snapshot.reason !== 'required_verification_incomplete') return false;
  if (snapshot.verification == null) return false;
  const checks = snapshot.verification.checks;
  return !Array.isArray(checks) || !checks.some(check => check.status === 'failed' || check.status === 'blocked');
}

/** Conservative, extensible explicit durable-Memory task detection.

 * Primary signal: a task-contract acceptance item carrying a known explicit
 * durable-Memory verifier identity (the precise mark once the dedicated
 * acceptance verifier is wired into the build). Fallback: the goal text matches
 * the reference ``explicit_memory_target`` intent, so an unfulfilled explicit
 * task is not re-extracted through the candidate path while the verifier is not
 * yet installed. Both signals only ever exclude; they never authorize a write. */
export function explicitMemoryTaskOwned(snapshot, { explicitMemoryVerifiers = DEFAULT_EXPLICIT_MEMORY_VERIFIERS } = {}) {
  const acceptance = snapshot?.taskContract?.acceptance;
  if (Array.isArray(acceptance) && acceptance.some(item => explicitMemoryVerifiers.some(verifier =>
    item.verifierRef === verifier.verifierRef && item.verifierVersion === verifier.verifierVersion))) return true;
  return isExplicitMemoryInstruction(snapshot?.goal ?? '');
}

/** Confirm the canonical completed snapshot for the bound Build.

 * Every consume re-checks the current canonical snapshot, the bound Build
 * revision and the principal/session. The consumer never relies on a model
 * declaration of completion. A stale, re-entered or non-completed snapshot is
 * unbound; the caller treats that as an unknown outcome (no write). */
function currentSnapshot(store, scope, runId, snapshot, { sessionId, buildId, record }) {
  const loaded = store.load(scope, runId);
  invariant(loaded, 'native_memory_turn_run_unbound');
  invariant(Number.isSafeInteger(record.metadata?.revision) && record.metadata.revision > 0
    && record.metadata?.id === scope.agentId && record.metadata.local === true
    && record.spec?.runtime?.type === 'harness', 'native_memory_turn_build_unbound');
  invariant(canonical(loaded.snapshot.scope) === canonical(scope)
    && loaded.snapshot.sessionId === sessionId && loaded.snapshot.phase === 'completed'
    && (buildId === null || loaded.snapshot.buildId === buildId)
    && canonical(loaded.snapshot) === canonical(snapshot), 'native_memory_turn_snapshot_unbound');
  return loaded;
}

/** Detect and verify a direct manage_memory write in this Run.

 * A tool body or a JSON ``committed`` claim is not proof. The exact scoped
 * call, its ledger receipt and the actual owner receipt must agree. A denied
 * or failed manual operation is never permission to save the same original
 * input through automatic candidate extraction. ``directWriteReceipt`` is the
 * parent-injected trusted owner verification port; when it is missing the
 * consumer cannot confirm a manual write and skips auto-consumption. */
async function directWriteOutcome(snapshot, record, { manageMemoryToolNames, directWriteReceipt, scope, runId, signal }) {
  if (!Array.isArray(manageMemoryToolNames) || !manageMemoryToolNames.length) return null;
  const names = new Set(manageMemoryToolNames);
  for (const message of snapshot.messages) {
    if (message.role !== 'tool' || message.history || !names.has(message.name)) continue;
    const intent = record.intents.find(item => item.kind === 'tool' && Array.isArray(item.payload?.calls)
      && item.payload.calls.some(call => call.callId === message.callId));
    if (!intent) continue;
    const callIndex = intent.payload.calls.findIndex(call => call.callId === message.callId);
    const call = intent.payload.calls[callIndex];
    const receipt = record.receipts.find(item => item.operationKey === intent.operationKey);
    const toolResult = Array.isArray(receipt?.result?.results) ? receipt.result.results[callIndex] : null;
    // A denied/failed manual operation is not permission to save the same input.
    if (!receipt || receipt.status !== 'committed' || !toolResult || toolResult.status !== 'ok')
      return 'memory_mutation_not_confirmed';
    // A tool name or a JSON "committed" claim is insufficient. Confirm the exact
    // scoped call and locked definition with its actual owner.
    if (typeof directWriteReceipt !== 'function') return 'direct_write_verification_missing';
    signal.throwIfAborted();
    const ownerReceipt = await directWriteReceipt({ scope, runId, operationKey: intent.operationKey, call, signal });
    if (ownerReceipt && ownerReceipt.committed === true) return 'direct_write_already_committed';
    return 'memory_mutation_not_confirmed';
  }
  return null;
}

/** Original current-Run human inputs only.

 * Reuses the production Host-admission source check so the consumed text is the
 * bytes the Host actually admitted, not a projected copy. Historical projections
 * (history present), tool bodies, summaries, schedules and attachments are not
 * another observation: projections and non-user roles are filtered before the
 * admission check, and the admission capsule only contributes text blocks. */
function completedTurnSources({ store, scope, runId, snapshot }) {
  const indexed = snapshot.messages.flatMap((message, index) => user(message) && !message.history ? [{ message, index }] : []);
  const messages = indexed.map(item => item.message);
  const messageRefs = indexed.map(item => `message:${item.index}:${memoryDigest(canonical(item.message)).slice(7)}`);
  return studioOriginalUserMemorySources({ store, scope, runId, messages, messageRefs });
}

function abortPromise(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

/** Bind the completed-Turn Memory consumer for one Build.

 * Returns ``null`` when consumption is disabled: Memory off, a non-local
 * provider, no user scope, write mode off, the after-turn flush off, or the
 * rollout off. Otherwise returns ``{ bindingDigest, consume, close }``. The
 * parent calls ``consume`` once after the main Run's terminal commit; it never
 * alters the main terminal state, answer, usage or verification evidence.
 *
 * ``consume(snapshot, { signal, directWriteReceipt } = {})`` resolves to a
 * result object for a known outcome or ``undefined`` for an unknown outcome
 * (exception, deadline, abort, closed, or a stale/non-completed snapshot). An
 * unknown outcome is never retried blindly and never asserts that nothing wrote.
 *
 * ``directWriteReceipt`` is the optional parent-injected trusted owner receipt
 * port: ``async ({ scope, runId, operationKey, call, signal }) -> { committed:
 * boolean, ... } | null``. It is consulted only when this Run carries a
 * manage_memory tool record; missing or non-confirming verification skips
 * auto-consumption. ``manageMemoryToolNames`` (default ``['manage_memory']``)
 * and ``explicitMemoryVerifiers`` (default the reference identity) are the
 * extensible identification surfaces. */
export function bindStudioNativeMemoryTurn({ record, buildId = null, scope, sessionId, store, storeDir, contextWindow,
  effectTimeoutMs = 30000, providerFactory = (filename, options) => new SqliteNativeMemoryProvider(filename, options),
  manageMemoryToolNames = DEFAULT_MANAGE_MEMORY_TOOL_NAMES,
  explicitMemoryVerifiers = DEFAULT_EXPLICIT_MEMORY_VERIFIERS } = {}) {
  const policy = studioNativeMemoryPolicy(record.spec);
  // Default shadow-only evaluation. Disabled entirely when writes are off, the
  // after-turn flush is off, the provider is not local, the user scope is absent,
  // or the rollout is off.
  if (!policy.enabled || policy.providerRef !== 'local-default' || !policy.scopes.includes('user')
    || policy.write.mode === 'off' || !policy.write.flushAfterTurn || policy.rollout === 'off') return null;
  invariant(Number.isSafeInteger(contextWindow) && contextWindow > 0 && Number.isSafeInteger(contextWindow * 8)
    && Number.isSafeInteger(effectTimeoutMs) && effectTimeoutMs >= 4, 'studio_native_memory_turn_budget_invalid');
  const deadlineMs = Math.floor(effectTimeoutMs / 2), maxInputBytes = contextWindow * 8;
  const bindingDigest = memoryDigest(canonical({ contract: STUDIO_NATIVE_MEMORY_TURN, scope, sessionId, buildId,
    revision: record.metadata.revision, spec: record.spec, policy, extraction: NATIVE_USER_EXTRACTION_POLICY,
    deadlineMs, maxInputBytes, explicitMemoryVerifiers, manageMemoryToolNames }));
  const filename = join(storeDir, 'native-harness', 'memory-v1', memoryDigest(scope.tenantId).slice(7), 'memory.sqlite');
  let closed = false;

  async function runConsume(snapshot, { signal, directWriteReceipt }) {
    signal.throwIfAborted();
    const loaded = currentSnapshot(store, scope, snapshot.runId, snapshot, { sessionId, buildId, record });
    if (explicitMemoryTaskOwned(snapshot, { explicitMemoryVerifiers })) return { status: 'explicit_memory_task_owned' };
    if (!completedTurnMemoryEligible(snapshot)) return { status: 'main_task_not_qualified' };
    const sources = completedTurnSources({ store, scope, runId: snapshot.runId, snapshot });
    if (!sources.observations.length) return { status: 'empty', sourceUnavailable: sources.unavailable };
    if (sources.observations.reduce((sum, observation) => sum + bytes(observation.content), 0) > maxInputBytes)
      return { status: 'input_over_budget' };
    // A direct manage_memory write in this Run is checked before candidate
    // filtering: a manual operation (confirmed or not) always skips automatic
    // extraction of the same original input, even when the write mode would
    // otherwise drop the candidate.
    const directWrite = await directWriteOutcome(snapshot, loaded, { manageMemoryToolNames, directWriteReceipt, scope, runId: snapshot.runId, signal });
    if (directWrite) return { status: directWrite };
    const [business] = nativeMemoryScopeBindings(scope);
    const candidates = sources.observations.flatMap(observation => {
      const candidate = nativeUserMemoryCandidate({ text: observation.content, sourceEventId: observation.sourceEventId, ...business });
      return candidate && (policy.write.mode !== 'explicit_only' || candidate.reason.startsWith('explicit_user')) ? [{ observation, candidate }] : [];
    });
    if (!candidates.length) return { status: 'empty', sourceUnavailable: sources.unavailable };
    if (policy.rollout === 'shadow') {
      signal.throwIfAborted();
      const decisions = {};
      for (const { candidate } of candidates) {
        const decision = evaluateNativeMemoryCandidate(candidate).decision;
        decisions[decision] = (decisions[decision] ?? 0) + 1;
      }
      return { status: 'shadow', proposed: candidates.length, decisions, sourceUnavailable: sources.unavailable };
    }
    signal.throwIfAborted();
    const provider = providerFactory(filename, { principal: scope, scopes: policy.scopes });
    let decisions = {}, proposed = candidates.length;
    try {
      for (const { observation, candidate } of candidates) {
        signal.throwIfAborted();
        // Reuse the original source identity and the storage idempotent receipt:
        // the operation key is derived from the source identity, not the trigger,
        // so a PreCompact flush and this turn consumer cannot manufacture a second
        // observation of the same original input.
        const operationKey = 'native-memory-candidate:' + memoryDigest(canonical({ scope, policy,
          extraction: NATIVE_USER_EXTRACTION_POLICY, sourceEventId: observation.sourceEventId })).slice(7);
        const result = provider.applyCandidate({ candidate, operationKey,
          sourceSessionId: observation.sourceSessionId, sourceDigest: observation.sourceDigest });
        decisions[result.decision] = (decisions[result.decision] ?? 0) + 1;
      }
    }
    finally { provider.close(); }
    // Re-verify the canonical terminal snapshot is unchanged after the flush.
    currentSnapshot(store, scope, snapshot.runId, snapshot, { sessionId, buildId, record });
    return { status: 'evaluated', proposed, decisions, sourceUnavailable: sources.unavailable };
  }

  async function consume(snapshot, { signal, directWriteReceipt } = {}) {
    if (closed) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('native_memory_turn_deadline')), deadlineMs);
    if (signal?.aborted) controller.abort(signal.reason);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      return await Promise.race([runConsume(snapshot, { signal: combined, directWriteReceipt }), abortPromise(combined)]);
    }
    catch {
      // The Provider retains shielded database work and durable source receipts.
      // No blind retry or false assertion that nothing wrote.
      return undefined;
    }
    finally {
      clearTimeout(timer);
    }
  }

  return { bindingDigest, consume, close: () => { closed = true; } };
}
