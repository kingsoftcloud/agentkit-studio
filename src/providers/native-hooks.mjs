import { createHash } from 'node:crypto';
import { canonical, copy, invariant, hookIdentity, validateHookDefinition } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { createNativeHookExecutor, nativeHookExecutionPolicyDigest } from '../../packages/agentkit-harness/src/native/hook-executor.mjs';

export const STUDIO_NATIVE_HOOK_CONTRACT = 'agentkit.studio-native-hooks/v1';
const digest = value => 'sha256:' + createHash('sha256').update(canonical(value)).digest('hex');
const text = value => typeof value === 'string' && value.trim() === value && value.length > 0;
const phase = event => event === 'Stop' ? 'verifying' : event === 'PreCompact' ? 'compacting' : 'executing_tools';

/** Trusted in-process Host registrations. Agent drafts and tool outputs never load code. */
export function createStudioNativeHookRegistry() {
  const sources = new Map(), ports = new Set();
  let closed = false;
  function register(input) {
    invariant(!closed, 'studio_native_hooks_closed');
    invariant(input && Object.keys(input).every(key => ['sourceRef', 'sourceDigest', 'agentIds', 'configuration',
      'callback', 'authorize', 'authorizationVersion', 'available'].includes(key)), 'studio_native_hook_registration_invalid');
    const { sourceRef, sourceDigest, callback, authorize = null, authorizationVersion = null, available = null } = input;
    invariant(text(sourceRef) && /^plugin:\/\/[^\s@]+@[^\s]+$/.test(sourceRef) && sourceRef.length <= 512
      && /^sha256:[a-f0-9]{64}$/.test(sourceDigest) && typeof callback === 'function'
      && (available === null || typeof available === 'function'), 'studio_native_hook_registration_invalid');
    invariant((authorize === null && authorizationVersion === null)
      || typeof authorize === 'function' && text(authorizationVersion), 'studio_native_hook_authorization_invalid');
    invariant(Array.isArray(input.agentIds) && input.agentIds.length > 0
      && input.agentIds.every(id => text(id) && id !== '*') && new Set(input.agentIds).size === input.agentIds.length,
    'studio_native_hook_agents_invalid');
    const config = copy(input.configuration);
    invariant(config && Object.keys(config).every(key => ['contract', 'hooks', 'cleanupTimeoutMs', 'stopContinuationLimit'].includes(key))
      && config.contract === STUDIO_NATIVE_HOOK_CONTRACT && Array.isArray(config.hooks)
      && config.hooks.length > 0 && config.hooks.length <= 16, 'studio_native_hook_configuration_invalid');
    const executionPolicyDigest = nativeHookExecutionPolicyDigest({ cleanupTimeoutMs: config.cleanupTimeoutMs });
    const hasStop = config.hooks.some(hook => hook?.events?.includes('Stop'));
    invariant(hasStop ? Number.isSafeInteger(config.stopContinuationLimit) && config.stopContinuationLimit >= 0
      : config.stopContinuationLimit === undefined, 'studio_native_hook_stop_policy_invalid');
    const ids = new Set();
    for (const declaration of config.hooks) {
      invariant(declaration && !['sourceRef', 'bindingDigest', 'executionPolicyDigest'].some(key => Object.hasOwn(declaration, key)),
        'studio_native_hook_authority_in_configuration');
      validateHookDefinition({ ...declaration, sourceRef, bindingDigest: sourceDigest, executionPolicyDigest });
      invariant(!ids.has(declaration.hookId), 'studio_native_hook_id_duplicate'); ids.add(declaration.hookId);
    }
    invariant(!sources.has(sourceRef), 'studio_native_hook_source_duplicate');
    const source = { sourceRef, sourceDigest, callback, authorize, authorizationVersion, available, config,
      agentIds: new Set(input.agentIds), executionPolicyDigest, active: true };
    sources.set(sourceRef, source);
    return () => { source.active = false; if (sources.get(sourceRef) === source) sources.delete(sourceRef); };
  }
  function bind({ scope, sessionId, record, buildId = null, store }) {
    invariant(!closed, 'studio_native_hooks_closed');
    const selected = [...sources.values()].filter(source => source.agentIds.has(scope.agentId));
    if (!selected.length) return null;
    invariant(record?.metadata?.id === scope.agentId && record.metadata.local === true
      && Number.isSafeInteger(record.metadata.revision) && record.metadata.revision > 0
      && record.spec?.runtime?.type === 'harness' && text(sessionId) && typeof store?.load === 'function',
    'studio_native_hook_activation_invalid');
    const boundScope = copy(scope), binding = { scope: boundScope, agentId: scope.agentId,
      revision: record.metadata.revision, buildId, spec: copy(record.spec) };
    const executors = new Map(), definitions = [], limits = new Set();
    let disposed = false, closing, requiredEffectTimeoutMs = 0;
    const current = request => {
      invariant(!closed && !disposed && request?.input && canonical(request.scope) === canonical(boundScope) && request.sessionId === sessionId,
        'studio_native_hook_request_unbound');
      const run = store.load(boundScope, request.runId), snapshot = run.snapshot;
      const intent = run.intents.find(item => item.operationKey === request.operationKey);
      const sealed = { ...request }; delete sealed.signal;
      invariant(canonical(hookIdentity(snapshot)) === canonical(hookIdentity(request))
        && snapshot.scope.agentId === binding.agentId && (buildId === null || snapshot.buildId === buildId)
        && snapshot.goal === request.input.goal && snapshot.goalRevision === request.goalRevision
        && snapshot.usage.toolCalls === request.input.toolCallCount && snapshot.phase === phase(request.event)
        && snapshot.pendingIntent === request.operationKey && intent?.kind === 'hook' && intent.status === 'running'
        && canonical(intent.payload.request) === canonical(sealed)
        && run.lease && run.lease.expiresAt > Date.now() && intent.claimedFence === run.lease.fence,
      'studio_native_hook_request_unbound');
      return run;
    };
    // Validate the entire selected graph before creating any live executor.
    const plans = selected.map(source => {
      if (source.config.stopContinuationLimit !== undefined) limits.add(source.config.stopContinuationLimit);
      const bindingDigest = digest({ contract: STUDIO_NATIVE_HOOK_CONTRACT, binding, sourceRef: source.sourceRef,
        sourceDigest: source.sourceDigest, authorizationVersion: source.authorizationVersion ?? 'deny-unconfigured/v1',
        configuration: source.config });
      const rows = source.config.hooks.map(declaration => validateHookDefinition({ ...declaration,
        sourceRef: source.sourceRef, bindingDigest, executionPolicyDigest: source.executionPolicyDigest }));
      for (const definition of rows) {
        invariant(!definitions.some(item => item.hookId === definition.hookId), 'studio_native_hook_id_duplicate');
        definitions.push(definition);
        requiredEffectTimeoutMs = Math.max(requiredEffectTimeoutMs, definition.timeoutMs + source.config.cleanupTimeoutMs);
      }
      return { source, rows };
    });
    invariant(limits.size <= 1, 'studio_native_hook_stop_policy_conflict');
    for (const { source, rows } of plans) {
      const { callback, authorize, available: checkAvailability } = source;
      const available = async () => !closed && !disposed && source.active
        && (!checkAvailability || await checkAvailability() === true) && !closed && !disposed && source.active;
      const ensure = async request => { current(request); invariant(await available(), 'studio_native_hook_source_retired'); request.signal?.throwIfAborted(); };
      const executor = createNativeHookExecutor({ scope: boundScope, cleanupTimeoutMs: source.config.cleanupTimeoutMs,
        bindings: rows.map(definition => ({ definition, available, callback: async request => {
          await ensure(request); const output = await callback(request); await ensure(request); return output;
        } })), authorize: authorize && (async (request, signal) => {
          const admitted = { ...request, signal };
          await ensure(admitted); const decision = await authorize(request, signal); await ensure(admitted); return decision;
        }) });
      for (const definition of rows) executors.set(definition.hookId, executor);
    }
    const port = { definitions: copy(definitions), stopContinuationLimit: [...limits][0] ?? 0, requiredEffectTimeoutMs,
      async invoke(request) {
        current(request);
        const executor = executors.get(request.definition.hookId);
        invariant(executor, 'studio_native_hook_definition_unbound');
        return executor.invoke(request);
      },
      close() {
        if (closing) return closing;
        disposed = true; ports.delete(port);
        return closing = Promise.all([...new Set(executors.values())].map(executor => executor.close())).then(() => {});
      } };
    ports.add(port); return port;
  }
  return { contract: STUDIO_NATIVE_HOOK_CONTRACT, register, bind,
    close() {
      closed = true; for (const source of sources.values()) source.active = false; sources.clear();
      return Promise.all([...ports].map(port => port.close())).then(() => {});
    } };
}
