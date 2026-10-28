/**
 * Trusted Host-registered Native Context data source registry.
 *
 * Only explicitly registered in-process sources are admitted — no auto-
 * discovery, no code loading from Agent drafts or tool output. Each source
 * provides a read-only data callback invoked inside a durable Kernel context
 * effect; the Kernel wraps results as untrusted user messages.
 *
 * API: createStudioNativeContextSourceRegistry() → {contract, register, bind, close}
 * register(input) → unregister function
 * bind({scope, sessionId, record, buildId, store, expectedRuntimeBuildId}) → null | {sources, readSource, close}
 */
import { createHash } from 'node:crypto';
import { canonical, copy, invariant, configure, effectiveRunConfiguration, CONTEXT_SOURCE_CONTRACT } from '@kingsoftcloud/agentkit-harness-core';

export const STUDIO_NATIVE_CONTEXT_SOURCES_CONTRACT = 'agentkit.studio-native-context-sources/v1';

const MAX_SOURCES = 32;
const MAX_ITEMS = 64;
const MAX_RESULT_BYTES = 4 * 1024 * 1024;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const PLUGIN_URI = /^plugin:\/\/[^\s@]+@[^\s]+$/u;
const digest = value => 'sha256:' + createHash('sha256').update(canonical(value)).digest('hex');
const rawDigest = value => createHash('sha256').update(canonical(value)).digest('hex');
const text = value => typeof value === 'string' && value.trim() === value && value.length > 0;

export function createStudioNativeContextSourceRegistry() {
  const sources = new Map();
  let closed = false;
  // Internal entry per bound port — not on the port object itself.
  const portEntries = new Map(); // port → { disposed, usedRefs }

  function register(input) {
    invariant(!closed, 'studio_native_context_sources_closed');
    invariant(input && typeof input === 'object' && !Array.isArray(input), 'studio_native_context_registration_invalid');
    const allowed = ['sourceRef', 'sourceDigest', 'agentIds', 'authorizationVersion', 'configuration', 'authorize', 'callback'];
    invariant(Object.keys(input).every(key => allowed.includes(key)), 'studio_native_context_registration_invalid');
    const { sourceRef, sourceDigest, agentIds, authorizationVersion, configuration, authorize, callback } = input;
    invariant(text(sourceRef) && PLUGIN_URI.test(sourceRef) && sourceRef.length <= 512, 'studio_native_context_source_ref_invalid');
    invariant(typeof sourceDigest === 'string' && SHA256.test(sourceDigest), 'studio_native_context_source_digest_invalid');
    invariant(Array.isArray(agentIds) && agentIds.length > 0
      && agentIds.every(id => text(id) && id !== '*')
      && new Set(agentIds).size === agentIds.length, 'studio_native_context_agents_invalid');
    invariant(text(authorizationVersion), 'studio_native_context_authorization_version_invalid');
    invariant(typeof authorize === 'function' && typeof callback === 'function', 'studio_native_context_functions_invalid');
    invariant(configuration && typeof configuration === 'object' && !Array.isArray(configuration), 'studio_native_context_configuration_invalid');
    invariant(Object.keys(configuration).every(key => ['contract', 'sources'].includes(key)), 'studio_native_context_configuration_invalid');
    invariant(configuration.contract === STUDIO_NATIVE_CONTEXT_SOURCES_CONTRACT, 'studio_native_context_configuration_invalid');
    invariant(Array.isArray(configuration.sources) && configuration.sources.length > 0, 'studio_native_context_configuration_invalid');
    let totalDefs = 0;
    for (const s of sources.values()) totalDefs += s.configuration.sources.length;
    invariant(totalDefs + configuration.sources.length <= MAX_SOURCES, 'studio_native_context_too_many_sources');
    const sourceIds = new Set();
    for (const def of configuration.sources) {
      invariant(def && typeof def === 'object' && !Array.isArray(def), 'studio_native_context_source_def_invalid');
      invariant(Object.keys(def).every(key => ['sourceId', 'priority', 'timeoutMs', 'required', 'maxTokens', 'maxBytes'].includes(key)), 'studio_native_context_source_def_invalid');
      invariant(text(def.sourceId) && def.sourceId.length <= 256, 'studio_native_context_source_id_invalid');
      invariant(!sourceIds.has(def.sourceId), 'studio_native_context_source_id_duplicate');
      sourceIds.add(def.sourceId);
      invariant(Number.isSafeInteger(def.priority), 'studio_native_context_priority_invalid');
      invariant(Number.isSafeInteger(def.timeoutMs) && def.timeoutMs > 0 && def.timeoutMs <= 60000, 'studio_native_context_timeout_invalid');
      invariant(typeof def.required === 'boolean', 'studio_native_context_required_invalid');
      invariant(Number.isSafeInteger(def.maxTokens) && def.maxTokens > 0, 'studio_native_context_max_tokens_invalid');
      invariant(Number.isSafeInteger(def.maxBytes) && def.maxBytes > 0 && def.maxBytes <= 131072, 'studio_native_context_max_bytes_invalid');
    }
    invariant(!sources.has(sourceRef), 'studio_native_context_source_ref_duplicate');
    const source = { sourceRef, sourceDigest, agentIds: new Set(agentIds), authorizationVersion,
      configuration: copy(configuration), authorize, callback, active: true };
    sources.set(sourceRef, source);
    return () => {
      source.active = false;
      if (sources.get(sourceRef) === source) sources.delete(sourceRef);
      for (const [, entry] of portEntries) {
        if (entry.usedRefs.has(sourceRef)) entry.disposed = true;
      }
    };
  }

  function bind({ scope, sessionId, record, buildId = null, store, expectedRuntimeBuildId }) {
    invariant(!closed, 'studio_native_context_sources_closed');
    invariant(record?.metadata?.id === scope.agentId && record.metadata.local === true
      && Number.isSafeInteger(record.metadata.revision) && record.metadata.revision > 0
      && record.spec?.runtime?.type === 'harness', 'studio_native_context_binding_invalid');
    invariant(typeof sessionId === 'string' && sessionId.trim(), 'studio_native_context_session_invalid');
    invariant(typeof store?.load === 'function', 'studio_native_context_store_invalid');

    const selected = [...sources.values()].filter(s => s.active && s.agentIds.has(scope.agentId));
    if (!selected.length) return null;

    const boundScope = copy(scope);
    // Derive the expected runtime Build ID: explicit string from Host, or
    // revision-<hash> from record (matching native-harness.mjs).
    const runtimeBuildId = typeof expectedRuntimeBuildId === 'string' && expectedRuntimeBuildId
      ? expectedRuntimeBuildId
      : (buildId && typeof buildId === 'string' && buildId
        ? buildId
        : `revision-${rawDigest({ agentId: scope.agentId, revision: record.metadata.revision, spec: record.spec })}`);

    const binding = { scope: boundScope, agentId: scope.agentId, sessionId,
      revision: record.metadata.revision, buildId: runtimeBuildId, spec: copy(record.spec) };

    const definitions = [];
    const sourceMap = new Map();
    for (const source of selected) {
      for (const def of source.configuration.sources) {
        invariant(!sourceMap.has(def.sourceId), 'studio_native_context_source_id_collision');
        const bindingDigest = digest({
          contract: CONTEXT_SOURCE_CONTRACT, sourceId: def.sourceId,
          binding, sourceRef: source.sourceRef, sourceDigest: source.sourceDigest,
          authorizationVersion: source.authorizationVersion, sourceDef: def,
        });
        const coreDef = { contract: CONTEXT_SOURCE_CONTRACT, sourceId: def.sourceId,
          bindingDigest, priority: def.priority, timeoutMs: def.timeoutMs,
          required: def.required, maxTokens: def.maxTokens, maxBytes: def.maxBytes };
        definitions.push(coreDef);
        sourceMap.set(def.sourceId, { source, def: coreDef });
      }
    }
    definitions.sort((a, b) => b.priority - a.priority || (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0));

    const entry = { disposed: false, usedRefs: new Set(selected.map(s => s.sourceRef)) };

    function verifyContext(request, loaded, intent) {
      const snapshot = loaded.snapshot;
      // Full scope equality — not just agentId.
      invariant(canonical(snapshot.scope) === canonical(boundScope), 'studio_native_context_scope_unbound');
      invariant(canonical(request.scope) === canonical(boundScope), 'studio_native_context_scope_unbound');
      invariant(snapshot.sessionId === sessionId, 'studio_native_context_session_unbound');
      invariant(request.sessionId === sessionId, 'studio_native_context_session_unbound');
      // Build: runtimeBuildId (explicit or revision-hash), not null.
      invariant(snapshot.buildId === runtimeBuildId, 'studio_native_context_build_unbound');
      invariant(request.buildId === runtimeBuildId, 'studio_native_context_build_unbound');
      const identityKeys = ['runId', 'turnId', 'parentRunId', 'taskChainId'];
      invariant(identityKeys.every(key => snapshot[key] === request[key]), 'studio_native_context_identity_unbound');
      invariant(['preparing_context', 'compacting'].includes(snapshot.phase), 'studio_native_context_phase_unbound');
      // Verify the EFFECTIVE configuration (steered task contract) matches the request.
      // The Kernel passes effectiveRunConfiguration(snapshot, loaded.configuration, digest) to readSource.
      // We recompute it from the ledger and compare to the request.
      const effective = effectiveRunConfiguration(snapshot, loaded.configuration, rawDigest);
      invariant(canonical(effective) === canonical(request.configuration), 'studio_native_context_config_unbound');
      // Verify config digest (base frozen config hasn't been swapped).
      invariant(rawDigest(loaded.configuration) === snapshot.configDigest, 'studio_native_context_base_config_unbound');
      // Verify task contract digest if present.
      if (snapshot.taskContractDigest !== null && snapshot.taskContractDigest !== undefined)
        invariant(snapshot.taskContractDigest === rawDigest(snapshot.taskContract), 'studio_native_context_task_contract_unbound');
      // Verify the source is the exact bound definition AND in the effective config.
      const sourceEntry = sourceMap.get(request.source.sourceId);
      invariant(sourceEntry && canonical(sourceEntry.def) === canonical(request.source), 'studio_native_context_source_unbound');
      const inConfig = effective.contextSources.find(s => s.sourceId === request.source.sourceId);
      invariant(inConfig && canonical(inConfig) === canonical(request.source), 'studio_native_context_source_unbound');
      // Intent must be context, running, pending.
      invariant(intent?.kind === 'context' && intent.status === 'running', 'studio_native_context_intent_unbound');
      invariant(snapshot.pendingIntent === request.operationKey, 'studio_native_context_intent_superseded');
      // Original intent claimedFence must match live lease.fence and request.executionFence.
      invariant(loaded.lease && loaded.lease.expiresAt > Date.now(), 'studio_native_context_lease_expired');
      invariant(intent.claimedFence === loaded.lease.fence, 'studio_native_context_fence_unbound');
      invariant(request.executionFence === intent.claimedFence, 'studio_native_context_fence_unbound');
      // Signal.
      invariant(request.signal instanceof AbortSignal, 'studio_native_context_signal_unbound');
      request.signal.throwIfAborted();
      // remainingTokens must equal Math.min(source.maxTokens, contextWindow - maxOutputTokens).
      const expectedTokens = Math.min(request.source.maxTokens,
        request.configuration.profile.contextWindow - request.configuration.profile.maxOutputTokens);
      invariant(Number.isSafeInteger(request.remainingTokens) && request.remainingTokens === expectedTokens,
        'studio_native_context_remaining_tokens_unbound');
      // Snapshot.
      invariant(canonical(snapshot) === canonical(request.snapshot), 'studio_native_context_snapshot_unbound');
    }

    // Seal the entire request body (everything except signal) using canonical.
    function sealRequest(request) {
      const body = {};
      for (const key of Object.keys(request)) {
        if (key === 'signal') continue;
        body[key] = request[key];
      }
      return canonical(body);
    }

    function makeCopy(request, signal) {
      const body = {};
      for (const key of Object.keys(request)) {
        if (key === 'signal') continue;
        body[key] = copy(request[key]);
      }
      return { ...body, signal };
    }

    const port = {
      sources: copy(definitions),
      async readSource(request) {
        invariant(!closed && !entry.disposed, 'studio_native_context_source_unbound');
        const loaded = store.load(boundScope, request.runId);
        const intent = loaded.intents.find(item => item.operationKey === request.operationKey);
        verifyContext(request, loaded, intent);
        const sealedSignal = request.signal;
        const sealed = sealRequest(request);

        // Authorize.
        const sourceEntry = sourceMap.get(request.source.sourceId);
        invariant(sourceEntry.source.active, 'studio_native_context_source_retired');
        const authCopy = makeCopy(request, sealedSignal);
        const decision = await sourceEntry.source.authorize(authCopy);
        sealedSignal.throwIfAborted();
        invariant(!closed && !entry.disposed, 'studio_native_context_source_retired');
        invariant(sourceEntry.source.active, 'studio_native_context_source_retired');
        const reloaded = store.load(boundScope, request.runId);
        const reintent = reloaded.intents.find(item => item.operationKey === request.operationKey);
        verifyContext(request, reloaded, reintent);
        invariant(sealRequest(request) === sealed, 'studio_native_context_request_drifted');
        invariant(request.signal === sealedSignal, 'studio_native_context_signal_drifted');
        invariant(decision === 'allow' || decision === 'deny', 'studio_native_context_authorize_invalid');
        if (decision === 'deny') throw new Error('studio_native_context_authorize_denied');

        // Callback.
        invariant(sourceEntry.source.active, 'studio_native_context_source_retired');
        const dataCopy = makeCopy(request, sealedSignal);
        const result = await sourceEntry.source.callback(dataCopy);
        sealedSignal.throwIfAborted();
        invariant(!closed && !entry.disposed, 'studio_native_context_source_retired');
        invariant(sourceEntry.source.active, 'studio_native_context_source_retired');
        const reloaded2 = store.load(boundScope, request.runId);
        const reintent2 = reloaded2.intents.find(item => item.operationKey === request.operationKey);
        verifyContext(request, reloaded2, reintent2);
        invariant(sealRequest(request) === sealed, 'studio_native_context_request_drifted');
        invariant(request.signal === sealedSignal, 'studio_native_context_signal_drifted');

        // Validate result: first validate types/depth/cycles, then serialize for bytes.
        invariant(result && typeof result === 'object' && !Array.isArray(result), 'studio_native_context_result_invalid');
        invariant(Object.keys(result).every(key => key === 'items'), 'studio_native_context_result_invalid');
        invariant(Array.isArray(result.items) && result.items.length <= MAX_ITEMS, 'studio_native_context_result_invalid');
        for (const item of result.items) {
          invariant(item && typeof item === 'object' && !Array.isArray(item), 'studio_native_context_item_invalid');
          validateItem(item); // validates types, depth, cycles before serialization
        }
        // Now serialize for byte budget, then copy.
        const resultCopy = copy(result);
        const encoded = new TextEncoder().encode(canonical(resultCopy));
        invariant(encoded.length <= MAX_RESULT_BYTES, 'studio_native_context_result_too_large');
        return { items: resultCopy.items };
      },
      close() {
        entry.disposed = true;
        portEntries.delete(port);
      },
    };
    portEntries.set(port, entry);
    return port;
  }

  return {
    contract: STUDIO_NATIVE_CONTEXT_SOURCES_CONTRACT,
    register,
    bind,
    close() {
      if (closed) return;
      closed = true;
      for (const source of sources.values()) source.active = false;
      sources.clear();
      for (const [, entry] of portEntries) entry.disposed = true;
      portEntries.clear();
    },
  };
}

/** Validate item: reject functions, symbols, bigint, undefined, non-finite
 *  numbers, circular structures. Allow shared non-cyclic sub-objects.
 *  Uses ancestor-stack (path-scoped) cycle detection, not a global seen set. */
function validateItem(value, ancestors = [], depth = 0) {
  if (depth > 32) throw new Error('studio_native_context_item_too_deep');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { invariant(Number.isFinite(value), 'studio_native_context_item_invalid'); return; }
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint' || typeof value === 'undefined')
    throw new Error('studio_native_context_item_invalid');
  if (typeof value === 'object') {
    if (ancestors.includes(value)) throw new Error('studio_native_context_item_circular');
    ancestors.push(value);
    for (const key of Object.keys(value)) validateItem(value[key], ancestors, depth + 1);
    ancestors.pop();
    return;
  }
  throw new Error('studio_native_context_item_invalid');
}
