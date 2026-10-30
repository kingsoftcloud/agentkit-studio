import { createNativeModelPort, nativeModelRecoveryPolicy } from '@kingsoftcloud/agentkit-harness-node/native/model-port';
import { admitInlineReasoningPolicy } from '@kingsoftcloud/agentkit-harness-node/native/model-inline-reasoning';
import { admitAnthropicPolicies, admitProviderCompatibilityPolicy, resolveProviderCompatibility } from '@kingsoftcloud/agentkit-harness-node/native/model-provider-compat';
import { admitProviderToolSearchPolicy } from '@kingsoftcloud/agentkit-harness-node/native/model-tool-search-policy';
import { admitChatUsagePolicy } from '@kingsoftcloud/agentkit-harness-node/native/model-chat-usage';
import { invariant } from '@kingsoftcloud/agentkit-harness-core';
import { bindNativeContext } from '../../providers/native-context.mjs';
import { hash } from './native-harness-bindings.mjs';

/** One owner for model admission, compatibility fingerprints and frozen recovery. */
export function createStudioNativeModelBinding({ descriptions, models, fetchImpl, original, capabilityCapsule,
  capabilityConfiguration, modelCompatibilityRule, surfaceEpoch, recoveryPolicies, contextSpec, contextDefaults }) {
  return (profile, id, boundContext, primary = false) => {
    const desc = descriptions.get(profile), digest = hash(desc);
    const inlineReasoningPolicy = capabilityCapsule ? capabilityConfiguration?.profile.inlineReasoningPolicy
      : admitInlineReasoningPolicy(modelCompatibilityRule);
    const providerCompatibilityPolicy = original ? original.configuration.profile.providerCompatibilityPolicy
      : admitProviderCompatibilityPolicy(modelCompatibilityRule);
    const modelOptions = providerCompatibilityPolicy ? Object.fromEntries([
      ['streaming', desc.parameters.stream], ['reasoningEffort', desc.protocol === 'openai-chat' ? desc.parameters.reasoning_effort : undefined],
      ['thinkingMode', desc.protocol === 'openai-chat' ? desc.parameters.thinking?.type : undefined], ['parallelToolCalls', desc.parameters.parallel_tool_calls],
      ['temperature', desc.parameters.temperature], ['topP', desc.parameters.top_p],
    ].filter(([, value]) => value !== undefined)) : {};
    // Presence versions the new display/idle defaults. Restore old Runs
    // without activating them, and let each child use its own parameters.
    const runtimePolicy = !original || Object.hasOwn(original.configuration.profile, 'providerThinkingDisplay');
    const usageEpoch = !capabilityCapsule || capabilityConfiguration?.profile.chatUsagePolicy !== undefined;
    const chatUsagePolicy = capabilityCapsule && primary ? capabilityConfiguration?.profile.chatUsagePolicy
      : usageEpoch ? admitChatUsagePolicy(desc.protocol) : undefined;
    const providerThinkingDisplayPolicy = original ? original.configuration.profile.providerThinkingDisplayPolicy : 'provider-visible/v1';
    const controllerReasoningPolicy = original ? original.configuration.profile.controllerReasoningPolicy : 'disclosed-delegate/v1';
    const toolSearchEpoch = !original || Object.hasOwn(original.configuration.profile, 'providerToolSearchPolicy');
    const providerToolSearchPolicy = toolSearchEpoch ? original && primary
      ? original.configuration.profile.providerToolSearchPolicy
      : admitProviderToolSearchPolicy({ protocol: desc.protocol, model: desc.modelName,
        requested: desc.parameters.provider_tool_search, discovery: !!recoveryPolicies.toolDiscoveryPolicy }) : undefined;
    const anthropicKeys = ['anthropicPolicy', 'promptCachePolicy', 'operatorGuidancePolicy', 'toolCatalogPolicy', 'providerReplayProjectionPolicy'];
    const anthropicPolicies = original && primary
      ? Object.fromEntries(anthropicKeys.filter(key => original.configuration.profile[key] !== undefined)
        .map(key => [key, original.configuration.profile[key]]))
      : !original || original.configuration.profile.anthropicPolicy ? admitAnthropicPolicies(desc.protocol, desc.modelName) : {};
    const modelRuntimeOptions = runtimePolicy ? {
      ...(surfaceEpoch ? { supportsImages: desc.input.includes('image'), discoveredToolExposure: 'direct-after-search/v1' } : {}),
      providerThinkingDisplay: desc.parameters.provider_thinking_display ?? (providerThinkingDisplayPolicy === 'provider-visible/v1'),
      ...(providerThinkingDisplayPolicy ? { providerThinkingDisplayPolicy } : {}),
      ...(modelOptions.streaming !== false ? { streamTimeoutPolicy: 'idle/v1' } : {}),
      ...(chatUsagePolicy ? { chatUsagePolicy } : {}),
      ...(controllerReasoningPolicy ? { controllerReasoningPolicy } : {}),
      ...(providerToolSearchPolicy ? { providerToolSearchPolicy } : {}),
      ...anthropicPolicies,
    } : {};
    const compat = providerCompatibilityPolicy && resolveProviderCompatibility(providerCompatibilityPolicy,
      { model: desc.modelName, baseUrl: desc.baseUrl });
    invariant(!compat || modelOptions.reasoningEffort === undefined || compat.supportsEffort,
      'native_model_profile_reasoning_effort_unsupported');
    invariant(!compat || modelOptions.thinkingMode === undefined || compat.supportsThinking,
      'native_model_profile_thinking_mode_unsupported');
    const planned = boundContext ?? bindNativeContext({ description: desc, context: contextSpec,
      ...contextDefaults });
    return { supportsImages: desc.input.includes('image'), modelRecoveryPolicy: nativeModelRecoveryPolicy(desc),
    profile: { profileId: profile.id || id || 'default', profileVersion: digest, providerFamily: desc.protocol,
      compatibilityDigest: providerCompatibilityPolicy ? hash({ description: desc, ...(inlineReasoningPolicy ? { inlineReasoningPolicy } : {}), providerCompatibilityPolicy,
        ...(runtimePolicy ? { modelRuntimeOptions } : {}) })
        : inlineReasoningPolicy ? hash({ description: desc, inlineReasoningPolicy }) : digest,
      ...(inlineReasoningPolicy ? { inlineReasoningPolicy } : {}),
      ...(providerCompatibilityPolicy ? { providerCompatibilityPolicy, ...modelOptions } : {}),
      ...modelRuntimeOptions,
      ...planned.profile, requestTimeoutMs: desc.requestTimeoutMs,
      providerReplayMode: desc.protocol === 'anthropic-messages' ? 'anthropic_content' : 'reasoning_content' },
    context: planned.port, contextPolicy: planned.policy, model: createNativeModelPort({ fetchImpl,
      resolveProfile: async () => {
        const current = { ...await models.profile(id), modelName: profile.modelName };
        invariant(hash(descriptions.get(current)) === digest, 'studio_native_model_binding_changed');
        return { protocol: desc.protocol, baseUrl: current.baseUrl, apiKey: current.apiKey,
          model: profile.modelName, parameters: desc.parameters };
      } }) };
  };
}
