import { canonical, copy, invariant, toolInputRejection, assertNativeAuxiliaryToolExecution, assertNativeAuxiliaryReceiptObservation }
  from '@kingsoftcloud/agentkit-harness-core';
import { memoryDigest, nativeMemoryScopeBindings, nativeMemorySensitiveLabels } from './memory-candidate.mjs';
import { buildNativeMemoryTools, nativeMemoryToolDefinitions, nativeMemoryRequestDigest } from './memory-tools.mjs';

export const NATIVE_MODEL_MEMORY_POLICY = 'native-model-memory/v1';

/** Distinct locked definition and source policy; these are not the user's
 * interactive manage_memory permission or the regex candidate operation keys. */
export function nativeMemoryExtractionToolDefinitions({ policy, policyDigest }) {
  invariant(policy.enabled && policy.providerRef === 'local-default' && policy.write.mode === 'candidate'
    && ['shadow', 'enabled'].includes(policy.rollout), 'native_memory_extraction_policy_disabled');
  const lockedDigest = memoryDigest(canonical({ contract: NATIVE_MODEL_MEMORY_POLICY, policy, policyDigest }));
  return nativeMemoryToolDefinitions({ policy, lockedDigest }).map(definition => definition.name !== 'manage_memory'
    ? definition : { ...definition, readOnly: false, concurrentSafe: false, permissions: ['memory:write'],
      timeoutMs: 15_000, recoveryPolicy: 'receipt-observation/v1',
      description: 'Maintain durable memories under the admitted automatic extraction policy. Cite original human source_event_ids from this input window. Read current versions before correcting or forgetting; manually confirmed or locked memories cannot be changed automatically. A committed owner receipt proves persistence.',
      parameters: { ...definition.parameters,
        required: [...definition.parameters.required, 'source_event_ids'],
        properties: { ...definition.parameters.properties,
          memory_type: { type: 'string', enum: ['profile', 'fact', 'episode'] },
          source_event_ids: { type: 'array', minItems: 1, maxItems: 16, uniqueItems: true,
            items: { type: 'string', minLength: 1, maxLength: 1024 } } } } });
}

/** The Host passes the actual source checker and provider owner. It must keep
 * them alive independently of the already-completed parent turn's tool ports. */
export function createNativeMemoryExtractionTools({ run, store, provider, policy, source,
  assertSourceCurrent, planner }) {
  const boundPolicy = copy(policy), boundSource = copy(source), definitions = copy(run.configuration.tools);
  const formal = new Map(definitions.map(definition => [definition.name, definition]));
  const lockedDigest = definitions[0]?.executionPolicyDigest;
  invariant(typeof lockedDigest === 'string' && typeof assertSourceCurrent === 'function'
    && Array.isArray(boundSource.sources) && boundSource.sources.length > 0,
  'native_memory_extraction_owner_unbound');
  invariant(Number.isSafeInteger(boundSource.parent?.goalRevision) && boundSource.parent.goalRevision >= 0
    && /^sha256:[a-f0-9]{64}$/.test(boundSource.parent.goalDigest), 'native_memory_extraction_goal_unbound');
  const sources = new Map(boundSource.sources.map(item => [item.sourceEventId, item]));
  const reject = code => ({ status: 'error', content: { code, executed: false } });
  // This assertion must be synchronous so it can run immediately before the
  // SQLite owner commits. An async source check cannot authorize a later write.
  function checkSource() {
    const result = assertSourceCurrent();
    if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {});
    invariant(result === undefined, 'native_memory_extraction_source_check_not_sync');
  }
  function check(request) {
    request.signal.throwIfAborted();
    checkSource();
    assertNativeAuxiliaryToolExecution({ store, run, request });
    invariant(canonical(formal.get(request.call.name)) === canonical(request.definition),
      'native_memory_extraction_definition_unbound');
  }
  const reads = buildNativeMemoryTools({ policy: { ...boundPolicy, write: { ...boundPolicy.write, mode: 'off' } },
    principal: run.identity.scope, lockedDigest, provider, planner,
    authorize: async () => 'allow', consent: async () => 'deny',
    resolveAuthority: () => null, resolveMutationSource: () => null });
  async function execute(request) {
    check(request);
    const rejection = toolInputRejection(request.definition, request.call);
    if (rejection) return { status: 'error', content: rejection };
    if (request.call.name !== 'manage_memory') {
      const result = await reads.execute(request);
      check(request);
      return result;
    }
    const args = request.call.arguments;
    const cited = args.source_event_ids.map(id => sources.get(id));
    if (cited.some(item => !item)) return reject('memory_extraction_source_not_in_window');
    const binding = nativeMemoryScopeBindings(run.identity.scope, [args.scope])[0];
    if (!binding || !boundPolicy.scopes.includes(args.scope)) return reject('memory_extraction_scope_not_allowed');
    if (args.action === 'remember' && (args.memory_id !== undefined || args.expected_version !== undefined)
      || args.action !== 'remember' && (!args.memory_id || !Number.isSafeInteger(args.expected_version))
      || args.action === 'forget' && args.content !== undefined
      || args.action !== 'forget' && (typeof args.content !== 'string' || !args.content.trim()
        || nativeMemorySensitiveLabels(args.content).length)) return reject('invalid_memory_action_arguments');
    const current = args.action === 'remember' ? null : provider.get(args.memory_id);
    const memoryType = args.memory_type ?? current?.memoryType ?? 'fact';
    if (current && (current.writePolicy !== 'auto' || args.memory_type !== undefined
      && args.memory_type !== current.memoryType)) return reject('memory_extraction_target_requires_consent');
    if (boundPolicy.rollout === 'shadow') return { status: 'ok', content: { committed: false,
      decision: 'shadow', action: args.action, scope: args.scope } };
    check(request);
    const requestDigest = nativeMemoryRequestDigest({ call: request.call, definition: request.definition, lockedDigest });
    const input = { action: args.action, scope: binding.scope, scopeId: binding.scopeId,
      operationKey: request.operationKey, requestDigest, authority: 'candidate',
      sourceSessionId: boundSource.parent.sessionId, sourceEventId: cited[0].sourceEventId,
      sourceGoalRevision: String(boundSource.parent.goalRevision), sourceGoalDigest: boundSource.parent.goalDigest,
      extraction: { policy: NATIVE_MODEL_MEMORY_POLICY, memoryType,
        sourceWindowDigest: boundSource.sourceDigest, sourceEventIds: args.source_event_ids } };
    if (args.action !== 'remember') { input.memoryId = args.memory_id; input.expectedVersion = args.expected_version; }
    if (args.action !== 'forget') input.content = args.content;
    try {
      check(request);
      return { status: 'ok', content: provider.applyMutation(input) };
    } catch (error) {
      if (['native_memory_version_or_identity_conflict', 'native_memory_slot_locked',
        'native_memory_operation_conflict', 'native_memory_content_rejected'].includes(error.code)) return reject(error.code);
      throw error;
    }
  }
  async function observeReceipt(request) {
    request.signal.throwIfAborted();
    checkSource();
    assertNativeAuxiliaryReceiptObservation({ store, run, request });
    invariant(canonical(request.scope) === canonical(run.identity.scope) && request.runId === run.identity.runId
      && canonical(formal.get(request.call.name)) === canonical(request.definition),
    'native_memory_extraction_receipt_unbound');
    const requestDigest = nativeMemoryRequestDigest({ call: request.call, definition: request.definition, lockedDigest });
    const result = provider.reconcile({ operationKey: request.originalOperationKey, requestDigest });
    return { contract: 'agentkit.tool-receipt-observation/v1', originalOperationKey: request.originalOperationKey,
      callId: request.call.callId, result: result.receipt && !result.conflict
        ? { status: 'ok', content: result.receipt } : null };
  }
  return { definitions, execute, observeReceipt };
}
