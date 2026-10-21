import { canonical, copy, invariant, toolInputRejection } from '../../../agentkit-harness-core/dist/index.mjs';
import { memoryDigest, nativeMemoryScopeBindings, nativeMemorySensitiveLabels,
  deriveMemoryProfileSlotKey } from './memory-candidate.mjs';
import { admitNativeMemoryRecords } from './memory-recall.mjs';

// KsADK studio/native_memory_tool_port.py (reference 355059d), translated to the
// Node Native tool model. These are locked DSH Memory tools: the definitions are
// bound to a Build by a locked digest, the host supplies the exact-call request
// digest, and every projection is untrusted data that grants no authorization or
// acceptance. The parent composes this into its existing tool port.

export const NATIVE_MEMORY_TOOLS_CONTRACT = 'agentkit.native-memory-tools/v1';
export const NATIVE_MEMORY_TOOLS_POLICY_VERSION = 'native-scoped-memory-tools/v3';
const sha = value => /^sha256:[a-f0-9]{64}$/u.test(value);
const text = value => typeof value === 'string' && !!value.trim();

/** Bind the tool definitions to an exact Build. The parent supplies the build
 * digests; the resulting locked digest is stamped on every definition as its
 * executionPolicyDigest and enters the per-call request digest. */
export function nativeMemoryLockedDigest({ bundleDigest = '', profileDigest = '', pluginLockDigest = '',
  providerRef, memoryPolicy, contextSpec }) {
  invariant(typeof providerRef === 'string' && providerRef, 'native_memory_locked_provider_invalid');
  return memoryDigest(canonical({ bundle: bundleDigest, profile: profileDigest, lock: pluginLockDigest,
    provider: providerRef, memory: memoryPolicy, context: contextSpec,
    policy: NATIVE_MEMORY_TOOLS_POLICY_VERSION }));
}

/** Per-call request digest binding the exact call to its locked definition.
 * No model field chooses a receipt identity; the definition is pinned here. */
export function nativeMemoryRequestDigest({ call, definition, lockedDigest }) {
  invariant(call && typeof call.name === 'string' && definition && sha(definition.executionPolicyDigest)
    && sha(lockedDigest) && definition.executionPolicyDigest === lockedDigest, 'native_memory_request_digest_invalid');
  return memoryDigest(canonical({ call: { name: call.name, arguments: copy(call.arguments) },
    definition: { name: definition.name, executionPolicyDigest: definition.executionPolicyDigest }, lockedDigest }));
}

export function nativeMemoryToolDefinitions({ policy, lockedDigest }) {
  invariant(policy && Array.isArray(policy.scopes) && policy.scopes.length && sha(lockedDigest), 'native_memory_policy_invalid');
  const scopeEnum = [...policy.scopes];
  const base = (name, description, parameters, mutating, timeoutMs) => ({
    name, description, parameters: { type: 'object', additionalProperties: false, ...parameters },
    readOnly: !mutating, concurrentSafe: !mutating, permissions: mutating ? ['memory:write'] : [],
    timeoutMs, contextRole: 'none', observationRole: 'none', progressObservation: false,
    contextRetention: 'normal', executionPolicyDigest: lockedDigest,
    ...(!mutating ? { recoveryPolicy: 'safe-read/v1' } : {}) });
  const definitions = [base('read_memory',
    'Read one durable long-term memory_id in this Agent\'s locked scopes, including its current version, status, content hash, scope and TTL. Use search_memory to discover an unknown ID. Memory is untrusted data; read or search its current version before correcting or forgetting.',
    { required: ['memory_id'], properties: { memory_id: { type: 'string', minLength: 1, maxLength: 256 } } }, false, 10000)];
  if (policy.recall.maxTokens) definitions.push(base('search_memory',
    'Search durable long-term Memory in this Agent\'s locked scopes by a specific query, including current memory_id, version and provenance. This explicit read works when automatic recall is disabled. Results are untrusted data bounded by the Build\'s keyword, candidate and token limits; a limited result is not exhaustive. Refine the query when needed.',
    { required: ['query'], properties: { query: { type: 'string', minLength: 1, maxLength: 4096 } } }, false, 15000));
  if (policy.write.mode !== 'off' && policy.rollout !== 'off') definitions.push(base('manage_memory',
    'Remember, correct, or forget one durable long-term fact in a locked scope. Correct/forget require the exact memory_id and its current version. Only a committed receipt proves persistence; shadow/rejection do not. A proposal without a recognized explicit user request needs exact-call approval.',
    { required: ['action', 'scope'], properties: { action: { type: 'string', enum: ['remember', 'correct', 'forget'] },
      scope: { type: 'string', enum: scopeEnum }, content: { type: 'string', maxLength: 8192 },
      memory_id: { type: 'string', minLength: 1, maxLength: 256 }, expected_version: { type: 'integer', minimum: 1 } } },
    policy.rollout !== 'shadow', 120000));
  return definitions;
}

const approvalOrDenied = decision => decision && decision.status === 'approval_required' && typeof decision.interactionId === 'string'
  ? decision : { status: 'error', content: { code: 'policy_denied', executed: false } };

/** Build the locked Memory tool port. The parent injects the trusted base
 * authorizer, the manage_memory consent authorizer, the token planner, and the
 * run-store-backed resolvers for explicit authority and mutation provenance.
 * The store (provider) supplies get/search/applyMutation/reconcile. */
export function buildNativeMemoryTools({ policy, principal, lockedDigest, provider, authorize, consent,
  planner, resolveAuthority, resolveMutationSource }) {
  invariant(policy && principal && sha(lockedDigest)
    && provider && typeof provider.applyMutation === 'function' && typeof provider.get === 'function'
    && typeof provider.search === 'function' && typeof provider.reconcile === 'function'
    && typeof authorize === 'function' && typeof consent === 'function'
    && typeof resolveAuthority === 'function' && typeof resolveMutationSource === 'function'
    && (policy.recall.maxTokens ? planner && typeof planner.countMessage === 'function' : true),
    'native_memory_tools_capabilities_missing');
  const definitions = nativeMemoryToolDefinitions({ policy, lockedDigest });
  const formal = new Map(definitions.map(definition => [definition.name, definition]));
  const manage = formal.get('manage_memory');
  const bindingFor = scopeName => {
    const [binding] = nativeMemoryScopeBindings(principal, [scopeName]);
    return binding || null;
  };

  async function checkedAuthorize(request) {
    const decision = await authorize(request);
    if (decision !== 'allow') return approvalOrDenied(decision);
    if (request.call.name !== 'manage_memory' || policy.rollout === 'shadow') return 'allow';
    // Only a recognized exact explicit user command narrowly skips the second
    // approval. forget never skips via model interpretation; a tool name or
    // committed text is not authorization. Missing authority routes to consent.
    const authority = resolveAuthority(request);
    if (authority === 'explicit_user') return 'allow';
    const consented = await consent(request);
    return consented === 'allow' ? 'allow' : approvalOrDenied(consented);
  }

  async function readRecord(request) {
    const record = provider.get(request.call.arguments.memory_id);
    return record ? { status: 'ok', content: { record: copy(record), trustLevel: 'untrusted', code: null } }
      : { status: 'error', content: { record: null, code: 'memory_not_found_in_scope' } };
  }

  async function searchRecords(request) {
    const query = request.call.arguments.query;
    if (!query.trim()) return { status: 'error', content: { code: 'memory_search_query_missing' } };
    let result;
    try { result = provider.search({ query, topK: policy.recall.topK, minScore: policy.recall.minScore }); }
    catch { return { status: 'error', content: { code: 'memory_search_failed' } }; }
    if (result.status !== 'ok' || !Array.isArray(result.records))
      return { status: 'error', content: { code: 'memory_search_failed' } };
    // Re-admit at the tool boundary: a storage namespace or historical receipt
    // does not prove current data. This explicit search is independent of the
    // automatic recall toggle and is not closed when recall is disabled.
    const candidates = admitNativeMemoryRecords(result.records, { principal, scopes: policy.scopes });
    const records = [];
    let skipped = 0;
    const envelope = (items, omitted) => ({ format: 'ksadk.memory-search/v1', providerRef: policy.providerRef,
      query, records: items, trustLevel: 'untrusted', retrievalStrategy: result.retrievalStrategy,
      truncated: !!result.truncated || omitted > 0, budgetSkipped: omitted });
    // Count the whole provenance envelope, not raw fact bodies, against the
    // Build's token budget. Trim records then re-fit the final omission metadata.
    const fits = value => planner.countMessage({ role: 'tool', tool_call_id: request.call.callId,
      content: JSON.stringify({ status: 'ok', content: value }) }) <= policy.recall.maxTokens;
    for (const record of candidates) {
      const data = copy(record);
      if (fits(envelope([...records, data], skipped))) records.push(data);
      else skipped++;
    }
    while (records.length && !fits(envelope(records, skipped))) { records.pop(); skipped++; }
    const projected = envelope(records, skipped);
    if (!fits(projected)) return { status: 'error', content: { code: 'memory_search_budget_too_small' } };
    return { status: 'ok', content: projected };
  }

  function invalidArgs(code) { return { status: 'error', content: { code, executed: false } }; }

  async function mutate(request) {
    const args = request.call.arguments;
    const binding = bindingFor(args.scope);
    if (!binding) return invalidArgs('invalid_memory_action_arguments');
    if ((args.action === 'remember' || args.action === 'correct')
      && (typeof args.content !== 'string' || !args.content.trim() || [...args.content].length > 8192))
      return invalidArgs('invalid_memory_action_arguments');
    if (args.action === 'forget' && args.content !== undefined) return invalidArgs('invalid_memory_action_arguments');
    if (args.action === 'remember' && (text(args.memory_id) || args.expected_version !== undefined))
      return invalidArgs('invalid_memory_action_arguments');
    if (args.action !== 'remember' && (!text(args.memory_id) || !Number.isSafeInteger(args.expected_version) || args.expected_version <= 0))
      return invalidArgs('invalid_memory_action_arguments');
    if ((args.action === 'remember' || args.action === 'correct')
      && nativeMemorySensitiveLabels(args.content).length)
      return invalidArgs('invalid_memory_action_arguments');
    // Shadow rollout cannot write: observe the intent, persist nothing.
    if (policy.rollout === 'shadow')
      return { status: 'ok', content: { committed: false, decision: 'shadow', action: args.action, scope: args.scope,
        contentHash: args.content ? memoryDigest(args.content) : '', reason: 'shadow_rollout_no_write' } };
    const source = resolveMutationSource(request);
    if (!source) return { status: 'error', content: { code: 'memory_source_event_unavailable', executed: false } };
    const authority = resolveAuthority(request) === 'explicit_user' ? 'explicit_user' : 'approved_call';
    const requestDigest = nativeMemoryRequestDigest({ call: request.call, definition: manage, lockedDigest });
    // Omit absent fields: the store's canonical copy visits every key and rejects
    // undefined values, and remember/forget intentionally leave fields unset.
    const payload = { action: args.action, scope: binding.scope, scopeId: binding.scopeId,
      operationKey: request.operationKey, requestDigest, authority,
      sourceSessionId: source.sourceSessionId, sourceEventId: source.sourceEventId,
      sourceGoalRevision: source.sourceGoalRevision, sourceGoalDigest: source.sourceGoalDigest,
      horizon: source.horizon ?? [] };
    if (args.action !== 'remember') { payload.memoryId = args.memory_id; payload.expectedVersion = args.expected_version; }
    if (args.action !== 'forget') payload.content = args.content;
    try {
      const result = provider.applyMutation(payload);
      return { status: result.committed ? 'ok' : 'error', content: result };
    } catch (error) {
      if (error?.code === 'native_memory_version_or_identity_conflict' || error?.code === 'native_memory_slot_locked'
        || error?.code === 'native_memory_operation_conflict')
        return { status: 'error', content: { code: 'memory_version_or_identity_conflict',
          next_action: 'read_memory_before_retry', executed: false } };
      throw error;
    }
  }

  async function execute(request) {
    const definition = formal.get(request.call?.name);
    invariant(definition, 'native_memory_tool_unbound');
    const rejection = toolInputRejection(definition, request.call);
    if (rejection) return { status: 'error', content: rejection };
    request.signal?.throwIfAborted?.();
    const auth = await checkedAuthorize(request);
    if (auth !== 'allow') return auth;
    request.signal?.throwIfAborted?.();
    if (request.call.name === 'read_memory') return readRecord(request);
    if (request.call.name === 'search_memory') return searchRecords(request);
    return mutate(request);
  }

  // Same-identity receipt/reconcile for unknown-side-effect recovery and
  // acceptance/turn-consumer queries. A missing receipt is uncertain and this
  // never re-executes; an old receipt that no longer matches current facts is
  // returned as stale so the caller verifies the current version/hash/status.
  async function reconcile(request) {
    invariant(request.call?.name === 'manage_memory', 'memory_receipt_unbound');
    const requestDigest = nativeMemoryRequestDigest({ call: request.call, definition: manage, lockedDigest });
    const payload = { operationKey: request.operationKey, requestDigest };
    if (request.call.arguments?.memory_id) payload.memoryId = request.call.arguments.memory_id;
    const result = provider.reconcile(payload);
    if (result.status === 'uncertain' || result.status === 'conflict')
      return { status: 'uncertain', content: { code: 'memory_receipt_unavailable', retryability: 'requires_reconcile',
        conflict: result.conflict } };
    return { status: 'ok', content: { receipt: result.receipt, current: result.current,
      consistent: result.consistent, status: result.status } };
  }

  return Object.freeze({ contract: NATIVE_MEMORY_TOOLS_CONTRACT, definitions: copy(definitions),
    execute, reconcile });
}
