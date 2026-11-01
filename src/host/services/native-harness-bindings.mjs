import { createHash } from 'node:crypto';
import { canonical, copy, invariant } from '@kingsoftcloud/agentkit-harness-core';
import { freezeNativeDshConfiguration } from '@kingsoftcloud/agentkit-harness-node/native/dsh-turn-runtime';
import { createNativeModelPort } from '@kingsoftcloud/agentkit-harness-node/native/model-port';
import { frozenNativeModelDescription } from '../../providers/native-model-capabilities.mjs';
export { profileDescription } from '../../providers/native-model-capabilities.mjs';
import { bindNativeContext } from '../../providers/native-context.mjs';
import { readNativeRecoveryBinding } from '../../providers/native-recovery-binding.mjs';
import { createStudioNativeMemoryExtraction } from './native-memory-extraction.mjs';
export const hash = value => createHash('sha256').update(canonical(value)).digest('hex');

/** Reconstruct the same module contract; absence is a historical v1 binding. */
export function restoredPolicyConfiguration(original) {
  return original ? { engine: original.configuration.engine,
    ...(original.configuration.sessionInjectionPolicy ? { sessionInjectionPolicy: original.configuration.sessionInjectionPolicy } : {}),
    ...(Object.hasOwn(original.configuration, 'policyModules') ? { policyModules: copy(original.configuration.policyModules) } : {}) } : {};
}

export const profileIds = record => {
  const bindings = record.spec?.bindings ?? {};
  return [...new Set([bindings.modelProfileId, ...(bindings.modelProfileIds ?? []).map(value => typeof value === 'string' ? value : value?.resourceId)].filter(Boolean))];
};
// SessionController selections are applied by the public prompt assembly;
// Agent.options retains the creation default and can be stale at this boundary.
export const admittedModelSelection = (agent, assembly) => {
  const selection = { ...agent.options };
  for (const key of ['provider', 'model']) {
    const value = assembly?.variables?.[key];
    invariant(value === undefined || typeof value === 'string' && value.trim(), 'studio_native_model_selection_invalid');
    if (value !== undefined) selection[key] = value;
  }
  return selection;
};
// A cold Session without a DSH request/header inherits the current picker
// default. Native already owns a durable route; interpolate that route while
// retaining every current prompt/tool contribution and checking later changes.
export const recoveredPromptAssembly = (assembly, source) => ({ ...assembly,
  variables: { ...assembly.variables, provider: source.provider, model: source.model } });
// Plan is an admitted dynamic control under the Native policy. Every other
// prompt section remains frozen, including across recovery and mode changes.
export const nativePlanAssembly = (assembly, policy) => policy
  ? { ...assembly, sections: assembly.sections.filter(section => section.name !== 'plan:policy') } : assembly;


export function createStudioNativeBackgroundBinding({ store, resolveRestoredBinding }) {
  return async (payload, { admission, record, source }) => {
    // A notice has no new user input. Reconstruct ports from the original
    // admitted Host capsule, including across earlier notice ancestors.
    const capsule = readNativeRecoveryBinding(record, { agentId: admission.identity.scope.agentId,
      sessionId: admission.identity.sessionId, runId: admission.identity.runId });
    const visited = new Set();
    let original = source;
    for (;;) {
      const snapshot = original.snapshot;
      invariant(!visited.has(snapshot.runId) && snapshot.phase === 'completed'
        && canonical(snapshot.scope) === canonical(admission.identity.scope)
        && snapshot.sessionId === admission.identity.sessionId && snapshot.buildId === admission.identity.buildId
        && snapshot.taskChainId === admission.identity.taskChainId
        && original.configuration.hostBindingDigest === record.configuration.hostBindingDigest
        && canonical(original.configuration.hostRecoveryBinding) === canonical(capsule),
      'studio_native_background_source_binding_changed');
      visited.add(snapshot.runId);
      if (Array.isArray(original.configuration.inputMessages) && original.configuration.inputMessages.length) break;
      invariant(typeof snapshot.parentRunId === 'string' && snapshot.parentRunId, 'studio_native_background_original_input_missing');
      original = store.load(admission.identity.scope, snapshot.parentRunId);
    }
    const identity = Object.fromEntries(['scope', 'runId', 'sessionId', 'turnId', 'buildId', 'parentRunId', 'taskChainId']
      .map(key => [key, original.snapshot[key]]));
    const input = { kind: 'enter', messages: copy(capsule.messages) };
    const restored = await resolveRestoredBinding({ ...payload, input }, { identity, configuration: original.configuration,
      configDigest: original.snapshot.configDigest, messages: capsule.messages, source: capsule.source });
    try {
      payload.signal.throwIfAborted();
      // Recheck the full original configuration with today's actual preset and
      // ports before applying the already persisted, reduced notice budget.
      const configuration = freezeNativeDshConfiguration(restored, input, original.configuration.contract, original.configuration);
      invariant(hash(configuration) === original.snapshot.configDigest
        && canonical(configuration) === canonical(original.configuration), 'native_dsh_recovery_configuration_changed');
      return { ...restored, taskChainId: admission.identity.taskChainId, configuration: copy(admission.configuration) };
    } catch (error) {
      try { await restored.releaseResources?.({ scope: copy(admission.identity.scope),
        sessionId: admission.identity.sessionId, runId: admission.identity.runId }); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'Studio background binding cleanup failed'); }
      throw error;
    }
  };
}

export function createStudioNativeMemoryExtractionBinding({ store, storeDir, workspaceId, lifetime, builds, agents, models, fetchImpl }) {
  return createStudioNativeMemoryExtraction({ store, storeDir, signal: lifetime.signal,
    principal: { tenantId: 'local', workspaceId, userId: 'local-user' },
    resolveRecord: parent => parent.buildId ? builds.resolve(parent.scope.agentId, parent.buildId)
      : agents.getRevision(parent.scope.agentId, parent.revision),
    resolveModel: async ({ parent, prepared, signal }) => {
      const original = store.load(parent.scope, parent.runId);
      const capsule = readNativeRecoveryBinding(original, { agentId: parent.scope.agentId,
        sessionId: parent.sessionId, runId: parent.runId });
      const bound = original.configuration.profile;
      const id = bound.profileId === 'default' ? '' : bound.profileId;
      const resolveProfile = async () => {
        signal.throwIfAborted();
        const current = { ...await models.profile(id), modelName: capsule.source.model };
        signal.throwIfAborted();
        const description = frozenNativeModelDescription(current, capsule.modelBindings);
        invariant(hash(description) === bound.profileVersion,
          'studio_native_memory_model_binding_changed');
        return { protocol: description.protocol, model: current.modelName,
          baseUrl: current.baseUrl, apiKey: current.apiKey, parameters: description.parameters };
      };
      const current = await resolveProfile();
      const context = bindNativeContext({ description: { protocol: current.protocol, modelName: current.model,
        parameters: current.parameters, contextWindow: prepared.configuration.profile.contextWindow,
        maxOutputTokens: prepared.configuration.profile.maxOutputTokens } });
      return { model: createNativeModelPort({ fetchImpl, resolveProfile }),
        countRequest: request => context.port.tokens.countRequest(request),
        planner: { countMessage: message => context.port.tokens.countMessage({ profile: prepared.configuration.profile,
          message, signal }) } };
    },
    onError: error => console.warn('[agentkit-studio] Native Memory extraction:', error.code ?? 'failed') });
}
