import { emptyUsage, NATIVE_ENGINE, NATIVE_SCHEMA } from './contracts.mjs';
import type { DeliveryReviewPolicy, Message, ModelProfile, RunConfiguration, RunIdentity, RunLimits, RunSnapshot, TaskContract, ToolDefinition } from './contracts.mjs';
import { canonical, copy, invariant, scopeKey } from './values.mjs';
import { validateSubmissionContract } from './final-submission.mjs';
import { compileToolInput } from './tool-input.mjs';
import { validateHookDefinition } from './hook-contract.mjs';
import { validateContextSource } from './context-contributions.mjs';
import { normalizeDeliveryReviewPolicy, REVIEW_SUBMISSION_TOOL } from './delivery-review.mjs';
import { validateArtifactConfiguration } from './artifact-runtime.mjs';
import { validateToolDiscovery } from './tool-discovery.mjs';
import { validateTodoConfiguration } from './todos.mjs';
import { validateCoordinatorConfiguration } from './coordinator-response.mjs';
import { validatePlanModeConfiguration } from './plan-mode.mjs';
import { defaultPolicyBindings, validatePolicyBindings } from './policy-registry.mjs';
import { validateConversationSeed } from './conversation-seed.mjs';
import { modelSurfaceMessages, validateModelSurface } from './model-surface.mjs';
import { validateDeliveryConfiguration } from './deliverables.mjs';

export interface ConfigurationInput {
  workspaceCapturePolicy?: RunConfiguration['workspaceCapturePolicy'];
  deliveryScopePolicy?: RunConfiguration['deliveryScopePolicy'];
  childCapabilityPolicy?: RunConfiguration['childCapabilityPolicy'];
  childAllocationPolicy?: RunConfiguration['childAllocationPolicy'];
  modelSurface?: RunConfiguration['modelSurface'];
  sessionInjectionPolicy?: RunConfiguration['sessionInjectionPolicy'];
  policyModules?: RunConfiguration['policyModules'];
  profile: Pick<ModelProfile, 'profileId' | 'profileVersion' | 'providerFamily' | 'compatibilityDigest'> & Partial<ModelProfile>;
  contract: Pick<TaskContract, 'objective'> & Partial<TaskContract>;
  tools?: ToolDefinition[]; limits?: Partial<RunLimits>; instructions?: string;
  hostBindingDigest: string; contextSources?: RunConfiguration['contextSources']; hooks?: RunConfiguration['hooks'];
  stopHookContinuationLimit?: number; delegationDepth?: number;
  modelRecoveryPolicy?: RunConfiguration['modelRecoveryPolicy'];
  guidancePolicy?: RunConfiguration['guidancePolicy'];
  wallDeliveryPolicy?: RunConfiguration['wallDeliveryPolicy'];
  artifactPolicy?: RunConfiguration['artifactPolicy'];
  inputPolicy?: RunConfiguration['inputPolicy'];
  sourceReadPolicy?: RunConfiguration['sourceReadPolicy'];
  outputRecoveryPolicy?: RunConfiguration['outputRecoveryPolicy'];
  toolErrorRecoveryPolicy?: RunConfiguration['toolErrorRecoveryPolicy'];
  toolDiscoveryPolicy?: RunConfiguration['toolDiscoveryPolicy'];
  todoPolicy?: RunConfiguration['todoPolicy'];
  toolExecutionPolicy?: RunConfiguration['toolExecutionPolicy'];
  childTaskPolicy?: RunConfiguration['childTaskPolicy'];
  coordinatorResponsePolicy?: RunConfiguration['coordinatorResponsePolicy'];
  planModePolicy?: RunConfiguration['planModePolicy'];
  planModeInitialActive?: boolean;
  childPlanPolicy?: RunConfiguration['childPlanPolicy'];
  toolErrorRecoveryModelCalls?: RunConfiguration['toolErrorRecoveryModelCalls'];
  deliveryReviewPolicy?: (Partial<DeliveryReviewPolicy> & Pick<DeliveryReviewPolicy, 'pathSuffixes'>) | null;
  hostRecoveryBinding?: RunConfiguration['hostRecoveryBinding'];
  contextPolicy?: RunConfiguration['contextPolicy'];
  workspaceObservationPolicy?: RunConfiguration['workspaceObservationPolicy'];
  inputMessages?: Message[] | null;
  conversationSeed?: RunConfiguration['conversationSeed'];
  conversationRewind?: RunConfiguration['conversationRewind'];
  backgroundSessionBindingDigest?: RunConfiguration['backgroundSessionBindingDigest'];
  backgroundNotificationPolicy?: RunConfiguration['backgroundNotificationPolicy'];
  childLifecyclePolicy?: RunConfiguration['childLifecyclePolicy'];
  childApprovalPolicy?: RunConfiguration['childApprovalPolicy'];
  childPromotionPolicy?: RunConfiguration['childPromotionPolicy'];
  childInputPolicy?: RunConfiguration['childInputPolicy'];
  childOwnerBinding?: RunConfiguration['childOwnerBinding'];
}
export function configure(input: ConfigurationInput): RunConfiguration {
  const profile: ModelProfile = {
    maxOutputTokens: 8192, contextWindow: 128000, maxRetries: 2, maxProviderRetries: 3,
    maxContinuations: 3, requestTimeoutMs: 110_000, retryInitialDelayMs: 500,
    retryMaxDelayMs: 8000, retryBackoffMultiplier: 2, rateLimitCooldownMs: 60_000,
    providerReplayMode: 'none', ...input.profile,
  };
  const limits: RunLimits = {
    maxWallMs: null, maxModelCalls: null, maxToolCalls: null, maxParallelTools: 4, maxRepairs: 3,
    maxOutputRestarts: 0, finalizationReserveModelCalls: 1, finalizationReserveWallMs: 0,
    verificationReserveModelCalls: 0, browserObservationIntervalToolCalls: 0,
    verificationIdleToolCalls: 0,
    effectTimeoutMs: 120_000, leaseMs: 30_000, maxSubagentDepth: 3,
    maxToolResultBytes: 65536, maxInlineImageBytes: 40 * 1024 * 1024, maxModelStreamBytes: 1024 * 1024,
    maxRecoveryRetries: 3, ...input.limits,
  };
  const config: RunConfiguration = {
    engine: NATIVE_ENGINE, profile, limits,
    ...(input.workspaceCapturePolicy === undefined ? {} : { workspaceCapturePolicy: input.workspaceCapturePolicy }),
    ...(input.deliveryScopePolicy === undefined ? {} : { deliveryScopePolicy: input.deliveryScopePolicy }),
    ...(input.modelSurface === undefined ? {} : { modelSurface: input.modelSurface }),
    ...(input.childAllocationPolicy === undefined ? {} : { childAllocationPolicy: input.childAllocationPolicy }),
    ...(input.childCapabilityPolicy === undefined ? {} : { childCapabilityPolicy: input.childCapabilityPolicy }),
    ...(input.sessionInjectionPolicy === undefined ? {} : { sessionInjectionPolicy: input.sessionInjectionPolicy }),
    tools: input.tools ?? [], instructions: input.instructions ?? '', hostBindingDigest: input.hostBindingDigest,
    inputMessages: input.inputMessages ?? null,
    ...(input.conversationSeed === undefined ? {} : { conversationSeed: input.conversationSeed }),
    ...(input.conversationRewind === undefined ? {} : { conversationRewind: input.conversationRewind }),
    ...(input.guidancePolicy === undefined ? {} : { guidancePolicy: input.guidancePolicy }),
    ...(input.wallDeliveryPolicy === undefined ? {} : { wallDeliveryPolicy: input.wallDeliveryPolicy }),
    ...(input.artifactPolicy === undefined ? {} : { artifactPolicy: input.artifactPolicy }),
    ...(input.inputPolicy === undefined ? {} : { inputPolicy: input.inputPolicy }),
    ...(input.sourceReadPolicy === undefined ? {} : { sourceReadPolicy: input.sourceReadPolicy }),
    ...(input.outputRecoveryPolicy === undefined ? {} : { outputRecoveryPolicy: input.outputRecoveryPolicy }),
    ...(input.toolErrorRecoveryPolicy === undefined ? {} : { toolErrorRecoveryPolicy: input.toolErrorRecoveryPolicy }),
    ...(input.toolDiscoveryPolicy === undefined ? {} : { toolDiscoveryPolicy: input.toolDiscoveryPolicy }),
    ...(input.todoPolicy === undefined ? {} : { todoPolicy: input.todoPolicy }),
    ...(input.toolExecutionPolicy === undefined ? {} : { toolExecutionPolicy: input.toolExecutionPolicy }),
    ...(input.childTaskPolicy === undefined ? {} : { childTaskPolicy: input.childTaskPolicy }),
    ...(input.coordinatorResponsePolicy === undefined ? {} : { coordinatorResponsePolicy: input.coordinatorResponsePolicy }),
    ...(input.planModePolicy === undefined ? {} : { planModePolicy: input.planModePolicy }),
    ...(input.planModeInitialActive === undefined ? {} : { planModeInitialActive: input.planModeInitialActive }),
    ...(input.childPlanPolicy === undefined ? {} : { childPlanPolicy: input.childPlanPolicy }),
    ...(input.toolErrorRecoveryModelCalls === undefined ? {} : { toolErrorRecoveryModelCalls: input.toolErrorRecoveryModelCalls }),
    ...(input.deliveryReviewPolicy === undefined ? {} : { deliveryReviewPolicy: input.deliveryReviewPolicy === null ? null : normalizeDeliveryReviewPolicy(input.deliveryReviewPolicy) }),
    ...(input.hostRecoveryBinding === undefined ? {} : { hostRecoveryBinding: input.hostRecoveryBinding }),
    ...(input.backgroundSessionBindingDigest === undefined ? {} : { backgroundSessionBindingDigest: input.backgroundSessionBindingDigest }),
    ...(input.backgroundNotificationPolicy === undefined ? {} : { backgroundNotificationPolicy: input.backgroundNotificationPolicy }),
    ...(input.childLifecyclePolicy === undefined ? {} : { childLifecyclePolicy: input.childLifecyclePolicy }),
    ...(input.childApprovalPolicy === undefined ? {} : { childApprovalPolicy: input.childApprovalPolicy }),
    ...(input.childPromotionPolicy === undefined ? {} : { childPromotionPolicy: input.childPromotionPolicy }),
    ...(input.childInputPolicy === undefined ? {} : { childInputPolicy: input.childInputPolicy }),
    ...(input.childOwnerBinding === undefined ? {} : { childOwnerBinding: input.childOwnerBinding }),
    contextSources: input.contextSources ?? [], hooks: input.hooks ?? [],
    contextPolicy: input.contextPolicy ?? null,
    workspaceObservationPolicy: input.workspaceObservationPolicy ?? null,
    stopHookContinuationLimit: input.stopHookContinuationLimit ?? 0, delegationDepth: input.delegationDepth ?? 0,
    modelRecoveryPolicy: input.modelRecoveryPolicy ?? 'manual',
    contract: { revision: '1', constraints: [], acceptance: [], allowedToolNames: null,
      finalSubmissionSchema: null, finalSubmissionPayloadKey: null, finalOutputFormat: 'text', ...input.contract },
  };
  invariant(config.backgroundSessionBindingDigest === undefined || config.backgroundNotificationPolicy === 'completed-before-model/v1'
    && /^[0-9a-f]{64}$/.test(config.backgroundSessionBindingDigest), 'invalid_background_session_binding');
  invariant(config.sessionInjectionPolicy === undefined || config.sessionInjectionPolicy === 'next-turn-inbox/v1', 'invalid_session_injection_policy');
  invariant(config.workspaceCapturePolicy === undefined || config.workspaceCapturePolicy === 'declared-subjects/v1'
    && !!config.deliveryScopePolicy, 'invalid_workspace_capture_policy');
  // Re-validating an already normalized historical configuration must be idempotent.
  if (Object.hasOwn(input, 'policyModules') || (input as Partial<RunConfiguration>).engine !== NATIVE_ENGINE) {
    config.policyModules = copy(input.policyModules ?? defaultPolicyBindings(config));
    validatePolicyBindings(config.policyModules);
  }
  canonical(config);
  validateModelSurface(config.modelSurface);
  invariant(config.childAllocationPolicy === undefined || config.childAllocationPolicy === 'parent-shared/v1', 'invalid_child_allocation_policy');
  invariant(config.childCapabilityPolicy === undefined || config.childCapabilityPolicy === 'required-tools/v1', 'invalid_child_capability_policy');
  invariant(profile.supportsImages === undefined || typeof profile.supportsImages === 'boolean', 'invalid_model_image_capability');
  invariant(!config.modelSurface || profile.supportsImages === undefined
    || config.modelSurface.environment.supportsImages === profile.supportsImages, 'model_surface_image_capability_mismatch');
  invariant(profile.discoveredToolExposure === undefined || profile.discoveredToolExposure === 'direct-after-search/v1',
    'invalid_discovered_tool_exposure');
  validateConversationSeed(config);
  validateArtifactConfiguration(config);
  invariant(config.sourceReadPolicy == null || config.sourceReadPolicy === 'studio-source-read/v1'
    && config.artifactPolicy === 'runtime-artifacts/v1' && config.contextPolicy !== null, 'invalid_source_read_policy');
  invariant(config.hostRecoveryBinding === undefined || config.hostRecoveryBinding !== null
    && typeof config.hostRecoveryBinding === 'object' && !Array.isArray(config.hostRecoveryBinding), 'invalid_host_recovery_binding');
  invariant(config.guidancePolicy == null || config.guidancePolicy === 'boundary-guide/v1', 'invalid_guidance_policy');
  invariant(config.inputPolicy === undefined || config.inputPolicy === 'before-first-model/v1', 'invalid_input_policy');
  invariant(config.outputRecoveryPolicy == null || ['task-or-delivery/v1', 'response-boundary/v2'].includes(config.outputRecoveryPolicy), 'invalid_output_recovery_policy');
  invariant(config.toolExecutionPolicy === undefined || config.toolExecutionPolicy === 'owner-execution/v1', 'invalid_tool_execution_policy');
  invariant(config.toolErrorRecoveryPolicy == null || config.toolErrorRecoveryPolicy === 'diagnose-before-repeat/v1', 'invalid_tool_error_recovery_policy');
  invariant(config.toolErrorRecoveryModelCalls == null || Number.isSafeInteger(config.toolErrorRecoveryModelCalls)
    && config.toolErrorRecoveryModelCalls >= 1 && config.toolErrorRecoveryModelCalls <= 10, 'invalid_tool_error_recovery_model_calls');
  invariant(config.deliveryReviewPolicy == null || !config.tools.some(tool => tool.name === REVIEW_SUBMISSION_TOOL), 'reserved_delivery_review_tool');
  invariant(config.childLifecyclePolicy == null || config.childLifecyclePolicy === 'owned-background/v2', 'invalid_child_lifecycle_policy');
  invariant(config.childApprovalPolicy == null || config.childApprovalPolicy === 'owned-child-approval/v1'
    && config.childLifecyclePolicy === 'owned-background/v2', 'invalid_child_approval_policy');
  invariant(config.childPromotionPolicy == null || config.childPromotionPolicy === 'owned-child-promotion/v1'
    && config.childLifecyclePolicy === 'owned-background/v2', 'invalid_child_promotion_policy');
  invariant(config.childInputPolicy == null || config.childInputPolicy === 'owned-child-input/v1'
    && config.childLifecyclePolicy === 'owned-background/v2', 'invalid_child_input_policy');
  if (config.childOwnerBinding) {
    const binding = config.childOwnerBinding;
    invariant(binding.childAllocationPolicy === undefined || binding.childAllocationPolicy === 'parent-shared/v1',
      'invalid_child_allocation_policy');
    scopeKey(binding.parent.scope);
    invariant(binding.contract === 'agentkit.native-child-owner/v1'
      && [binding.parent.runId, binding.parent.sessionId, binding.parent.turnId, binding.parent.buildId, binding.parent.taskChainId,
        binding.parentOperationKey, binding.parentToolCallId, binding.role].every(value => typeof value === 'string' && value.trim())
      && /^[0-9a-f]{64}$/.test(binding.childRequestDigest)
      && Number.isSafeInteger(binding.parentExecutionFence) && binding.parentExecutionFence > 0
      && Number.isSafeInteger(binding.maxModelCalls) && binding.maxModelCalls >= 1
      && Number.isSafeInteger(binding.maxToolCalls) && binding.maxToolCalls >= 0
      && limits.maxModelCalls === binding.maxModelCalls && limits.maxToolCalls === binding.maxToolCalls,
    'invalid_child_owner_binding');
    invariant(binding.deliveryMode === undefined || ['foreground', 'background'].includes(binding.deliveryMode), 'invalid_child_delivery_mode');
    invariant(binding.continuationOf === undefined && binding.continuationParentRunId === undefined
      || [binding.continuationOf, binding.continuationParentRunId]
        .every(value => typeof value === 'string' && value.trim() && value.length <= 256), 'invalid_child_continuation_binding');
  }
  invariant(config.contract.objective.trim() && config.hostBindingDigest.trim()
    && profile.profileId.trim() && profile.profileVersion.trim() && profile.providerFamily.trim()
    && profile.compatibilityDigest.trim(), 'configuration_identity_missing');
  if (config.inputMessages !== null) {
    invariant(Array.isArray(config.inputMessages) && config.inputMessages.length > 0
      && config.inputMessages.every(message => message && message.role === 'user'
        && Object.keys(message).every(key => ['role', 'content', 'media', 'kind', 'persistent'].includes(key))
        && typeof message.content === 'string'
        && (message.media === undefined || Array.isArray(message.media))
        && (message.kind === undefined || typeof message.kind === 'string' && message.kind.trim().length > 0)
        && (message.persistent === undefined || typeof message.persistent === 'boolean'))
      && config.inputMessages.some(message => message.content.trim() || message.media?.length), 'invalid_task_input_messages');
  }
  invariant(config.tools.every(tool => tool.exactContentPolicy === undefined
    || ['current-goal-utf8/v1', 'complete-write-only/v1'].includes(tool.exactContentPolicy)), 'invalid_exact_content_policy');
  invariant(config.tools.every(tool => tool.modelGuidance === undefined || Array.isArray(tool.modelGuidance)
    && tool.modelGuidance.length <= 8 && tool.modelGuidance.every(item => typeof item === 'string' && item.length <= 2048)),
  'invalid_tool_model_guidance');
  invariant(config.wallDeliveryPolicy == null || typeof config.wallDeliveryPolicy === 'string'
    && /^deadline-delivery\/v[1-7]$/.test(config.wallDeliveryPolicy), 'invalid_wall_delivery_policy');
  for (const [key, value] of Object.entries(limits)) {
    if (key === 'deliveryContextRecoveryPolicy') continue;
    invariant(value === null || Number.isSafeInteger(value) && value >= 0, `invalid_limit:${key}`);
  }
  invariant(limits.deliveryContextRecoveryPolicy == null || ['committed-write-summary/v1', 'delivery-window-summary/v2']
    .includes(limits.deliveryContextRecoveryPolicy), 'invalid_delivery_context_policy');
  invariant(Number.isSafeInteger(limits.maxModelStreamBytes) && limits.maxModelStreamBytes >= 0, 'invalid_limit:maxModelStreamBytes');
  invariant(Number.isSafeInteger(limits.verificationIdleToolCalls) && limits.verificationIdleToolCalls >= 0, 'invalid_limit:verificationIdleToolCalls');
  invariant(limits.maxModelCalls === null || limits.maxModelCalls > 0, 'invalid_model_budget');
  invariant(limits.maxWallMs === null || limits.maxWallMs > 0, 'invalid_wall_budget');
  invariant(limits.effectTimeoutMs > 0 && limits.leaseMs >= 30 && limits.maxParallelTools >= 1
    && limits.maxParallelTools <= 16 && limits.maxSubagentDepth <= 16, 'invalid_execution_limits');
  for (const key of ['maxOutputTokens', 'contextWindow', 'maxRetries', 'maxProviderRetries', 'maxContinuations',
    'requestTimeoutMs', 'retryInitialDelayMs', 'retryMaxDelayMs', 'rateLimitCooldownMs'] as const) {
    invariant(Number.isSafeInteger(profile[key]) && profile[key] >= 0, `invalid_profile:${key}`);
  }
  invariant(profile.maxOutputTokens > 0 && profile.maxOutputTokens < profile.contextWindow
    && profile.requestTimeoutMs > 0 && profile.requestTimeoutMs < limits.effectTimeoutMs
    && profile.maxProviderRetries <= 9 && profile.retryInitialDelayMs <= profile.retryMaxDelayMs
    && Number.isFinite(profile.retryBackoffMultiplier) && profile.retryBackoffMultiplier >= 1, 'invalid_model_profile');
  if (profile.inlineReasoningPolicy !== undefined) {
    const policy = profile.inlineReasoningPolicy;
    invariant(policy !== null && typeof policy === 'object' && !Array.isArray(policy)
      && Object.keys(policy).every(key => ['contract', 'rule'].includes(key))
      && ['profiled-content/v1', 'profiled-content/v2'].includes(policy.contract)
      && ['auto', 'permissive', 'openai', 'strict-openai', 'cerebras', 'groq', 'deepseek',
        'zai', 'kspmas-gateway', 'moonshot', 'mimo'].includes(policy.rule), 'invalid_inline_reasoning_policy');
  }
  if (profile.providerCompatibilityPolicy !== undefined) {
    const policy = profile.providerCompatibilityPolicy;
    invariant(policy !== null && typeof policy === 'object' && !Array.isArray(policy)
      && Object.keys(policy).every(key => ['contract', 'rule'].includes(key))
      && ['provider-compat/v1', 'provider-compat/v2'].includes(policy.contract)
      && ['auto', 'permissive', 'openai', 'strict-openai', 'cerebras', 'groq', 'deepseek',
        'zai', 'kspmas-gateway', 'moonshot', 'mimo'].includes(policy.rule), 'invalid_provider_compatibility_policy');
  }
  for (const key of ['streaming', 'parallelToolCalls', 'providerThinkingDisplay'] as const)
    invariant(profile[key] === undefined || typeof profile[key] === 'boolean', `invalid_profile:${key}`);
  invariant(profile.providerThinkingDisplayPolicy === undefined || profile.providerThinkingDisplayPolicy === 'provider-visible/v1'
    && typeof profile.providerThinkingDisplay === 'boolean', 'invalid_provider_thinking_display_policy');
  invariant(profile.streamTimeoutPolicy === undefined || profile.streamTimeoutPolicy === 'idle/v1' && profile.streaming !== false,
    'invalid_stream_timeout_policy');
  invariant(profile.chatUsagePolicy === undefined || profile.chatUsagePolicy === 'cumulative-snapshots/v1',
    'invalid_chat_usage_policy');
  invariant(profile.controllerReasoningPolicy === undefined || profile.controllerReasoningPolicy === 'disclosed-delegate/v1',
    'invalid_controller_reasoning_policy');
  invariant(profile.promptCachePolicy === undefined || profile.promptCachePolicy === 'anthropic-prefix/v1'
    && profile.providerFamily === 'anthropic-messages', 'invalid_prompt_cache_policy');
  if (profile.anthropicPolicy !== undefined) {
    const policy = profile.anthropicPolicy;
    invariant(policy && profile.providerFamily === 'anthropic-messages'
      && Object.keys(policy).every(key => ['contract', 'midSystem', 'blockBinding'].includes(key))
      && policy.contract === 'anthropic-wire/v1' && typeof policy.midSystem === 'boolean'
      && ['drop_block', 'disabled'].includes(policy.blockBinding), 'invalid_anthropic_policy');
  }
  invariant(profile.operatorGuidancePolicy === undefined || profile.operatorGuidancePolicy === 'journaled-system/v1'
    && profile.anthropicPolicy?.midSystem === true, 'invalid_operator_guidance_policy');
  invariant(profile.toolCatalogPolicy === undefined || profile.toolCatalogPolicy === 'stable-task/v1'
    && profile.operatorGuidancePolicy === 'journaled-system/v1', 'invalid_tool_catalog_policy');
  invariant(profile.providerReplayProjectionPolicy === undefined || profile.providerReplayProjectionPolicy === 'anthropic-client-compaction/v1'
    && profile.anthropicPolicy?.blockBinding === 'drop_block', 'invalid_replay_projection_policy');
  invariant(profile.outputTokenParameter === undefined || ['max_tokens', 'max_completion_tokens'].includes(profile.outputTokenParameter), 'invalid_output_token_parameter');
  invariant(profile.reasoningEffort === undefined || ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(profile.reasoningEffort), 'invalid_reasoning_effort');
  invariant(profile.thinkingMode === undefined || ['enabled', 'disabled'].includes(profile.thinkingMode), 'invalid_thinking_mode');
  invariant(profile.temperature === undefined || Number.isFinite(profile.temperature) && profile.temperature >= 0 && profile.temperature <= 2, 'invalid_temperature');
  invariant(profile.topP === undefined || Number.isFinite(profile.topP) && profile.topP > 0 && profile.topP <= 1, 'invalid_top_p');
  validateToolDiscovery(config);
  validateTodoConfiguration(config);
  validateDeliveryConfiguration(config);
  validateCoordinatorConfiguration(config);
  validatePlanModeConfiguration(config);
  const names = new Set<string>();
  for (const tool of config.tools) {
    invariant(tool.name.trim() && !names.has(tool.name), 'duplicate_or_invalid_tool');
    names.add(tool.name);
    compileToolInput(tool.parameters);
    invariant(Number.isFinite(tool.timeoutMs) && tool.timeoutMs > 0 && tool.timeoutMs < limits.effectTimeoutMs, 'invalid_tool_timeout');
    invariant(tool.executionTimeoutPolicy === undefined || ['dispatch/v1', 'dispatch/v2'].includes(tool.executionTimeoutPolicy), 'invalid_tool_execution_timeout_policy');
    invariant(tool.approvalPolicy === undefined || tool.approvalPolicy === 'durable-preflight/v1', 'invalid_tool_approval_policy');
    invariant(!tool.concurrentSafe || tool.readOnly && tool.observationRole === 'none', 'invalid_tool_concurrency');
    invariant(tool.workspaceEditPolicy === undefined || ['zcode-match/v1', 'zcode-match/v2'].includes(tool.workspaceEditPolicy)
      && ['edit_workspace_file', 'multi_edit_workspace_file'].includes(tool.name)
      && !tool.readOnly && !tool.concurrentSafe && tool.recoveryPolicy !== 'safe-read/v1', 'invalid_workspace_edit_policy');
    invariant(tool.workspacePatchPolicy === undefined || tool.workspacePatchPolicy === 'zcode-patch/v1'
      && tool.name === 'apply_workspace_patch' && !tool.readOnly && !tool.concurrentSafe
      && tool.recoveryPolicy !== 'safe-read/v1', 'invalid_workspace_patch_policy');
    invariant(tool.workspaceCheckpointPolicy === undefined || tool.workspaceCheckpointPolicy === 'file-preimages/v1'
      && ['write_workspace_file', 'write_workspace_files', 'edit_workspace_file', 'multi_edit_workspace_file',
        'delete_workspace_file', 'apply_workspace_patch', 'rewind_workspace_files'].includes(tool.name)
      && !tool.readOnly && !tool.concurrentSafe && tool.recoveryPolicy !== 'safe-read/v1', 'invalid_workspace_checkpoint_policy');
    invariant(tool.workspaceRepairPolicy === undefined || tool.workspaceRepairPolicy === 'preimage-compensation/v1'
      && tool.workspaceCheckpointPolicy === 'file-preimages/v1' && tool.recoveryPolicy === 'receipt-observation/v1', 'invalid_workspace_repair_policy');
    invariant(tool.planModeCommandPolicy === undefined || tool.planModeCommandPolicy === 'zcode-posix-readonly/v1'
      && tool.name === 'run_command' && tool.backgroundCommandPolicy === 'owned-command-launch/v1'
      && !tool.readOnly && !tool.concurrentSafe && tool.recoveryPolicy !== 'safe-read/v1'
      && !tool.planModeAccess, 'invalid_plan_command_policy');
    invariant(tool.planModeAccess === undefined || tool.planModeAccess
      && Object.keys(tool.planModeAccess).every(key => ['contract', 'destructive'].includes(key))
      && tool.planModeAccess.contract === 'zcode-mcp-plan/v1' && typeof tool.planModeAccess.destructive === 'boolean'
      && !tool.readOnly && !tool.concurrentSafe && tool.recoveryPolicy !== 'safe-read/v1', 'invalid_plan_mode_access');
    invariant(!tool.delegatedReadOnly || tool.concurrentSafe, 'invalid_delegated_reader');
    invariant(tool.deliveryWrite === undefined || typeof tool.deliveryWrite === 'boolean', 'invalid_delivery_writer');
    invariant(tool.deliveryArtifactRole === undefined || ['none', 'read', 'write'].includes(tool.deliveryArtifactRole), 'invalid_delivery_artifact_role');
    invariant(tool.resultArchivePolicy === undefined || ['archived-model-view/v4', 'archived-model-view/v5'].includes(tool.resultArchivePolicy), 'invalid_result_archive_policy');
    invariant(tool.sourceObservationPolicy === undefined || tool.sourceObservationPolicy === 'workspace-source-model/v1'
      && config.sourceReadPolicy === 'studio-source-read/v1' && tool.readOnly && tool.contextRole === 'workspace_read'
      && tool.resultArchivePolicy === 'archived-model-view/v5', 'invalid_source_observation_policy');
    invariant(tool.resultArchivePolicy !== 'archived-model-view/v5' || tool.sourceObservationPolicy === 'workspace-source-model/v1',
      'invalid_source_archive_policy');
    invariant(tool.directoryObservationPolicy === undefined || /^studio-directory-observation\/v[1-3]$/.test(tool.directoryObservationPolicy)
      && config.artifactPolicy === 'runtime-artifacts/v1' && tool.resultArchivePolicy === 'archived-model-view/v4'
      && tool.readOnly && tool.contextRole === 'workspace_list', 'invalid_directory_observation_policy');
    invariant(tool.childBudgetPolicy === undefined || ['start/v1', 'settle/v1', 'delegate/v1'].includes(tool.childBudgetPolicy), 'invalid_child_budget_policy');
    invariant(!tool.childBudgetPolicy || !tool.concurrentSafe, 'invalid_child_budget_concurrency');
    invariant(!tool.backgroundCommandPolicy || !tool.readOnly && !tool.concurrentSafe, 'invalid_background_launcher');
    invariant(tool.backgroundCommandPolicy === undefined || tool.backgroundCommandPolicy === 'owned-command-launch/v1', 'invalid_background_launcher_policy');
    invariant(tool.workspaceChangePolicy === undefined || tool.workspaceChangePolicy === 'observed-command/v1'
      && tool.name === 'run_command' && !tool.readOnly && !tool.concurrentSafe, 'invalid_workspace_change_policy');
    invariant(tool.recoveryPolicy === undefined || ['manual', 'safe-read/v1', 'receipt-observation/v1', 'ephemeral-browser/v1'].includes(tool.recoveryPolicy), 'invalid_tool_recovery_policy');
    invariant(tool.recoveryPolicy !== 'ephemeral-browser/v1' || tool.observationRole === 'browser'
      && tool.contextRole === 'none' && !tool.readOnly && !tool.concurrentSafe && !tool.childBudgetPolicy && !tool.backgroundCommandPolicy
      && !tool.workspaceEditPolicy && !tool.workspacePatchPolicy && !tool.workspaceChangePolicy
      && !tool.workspaceCheckpointPolicy && !tool.workspaceRepairPolicy && !tool.delegatedReadOnly
      && !tool.deliveryWrite && tool.deliveryArtifactRole !== 'write', 'invalid_ephemeral_browser_recovery');
    invariant(tool.recoveryPolicy !== 'safe-read/v1' || tool.readOnly && tool.observationRole === 'none'
      && !tool.delegatedReadOnly && !tool.childBudgetPolicy && !tool.backgroundCommandPolicy, 'invalid_safe_read_recovery');
    invariant(tool.recoveryPolicy !== 'receipt-observation/v1' || !tool.concurrentSafe
      && !tool.childBudgetPolicy && !tool.backgroundCommandPolicy && tool.observationRole === 'none'
      && !tool.delegatedReadOnly, 'invalid_tool_receipt_recovery');
    invariant(!['workspace_read', 'workspace_search', 'artifact_read'].includes(tool.contextRole) || tool.readOnly, 'invalid_context_reader');
  }
  invariant(config.contract.allowedToolNames === null || config.contract.allowedToolNames.every(name => names.has(name)), 'unbound_allowed_tool');
  invariant(config.contract.revision.trim() && new Set(config.contract.acceptance.map(item => item.id)).size === config.contract.acceptance.length,
    'invalid_acceptance_contract');
  invariant(config.contract.acceptance.every(item => item.id.trim() && item.verifierRef.trim() && item.verifierVersion.trim()
    && item.description.trim() && typeof item.required === 'boolean'
    && ['deterministic', 'human', 'model_assisted'].includes(item.verificationMethod)), 'invalid_acceptance_item');
  invariant(Number.isSafeInteger(config.delegationDepth) && config.delegationDepth >= 0
    && config.delegationDepth <= limits.maxSubagentDepth, 'subagent_depth_exhausted');
  invariant(new Set(config.hooks.map(hook => hook.hookId)).size === config.hooks.length, 'duplicate_hook');
  invariant(new Set(config.contextSources.map(source => source.sourceId)).size === config.contextSources.length, 'duplicate_context_source');
  for (const source of config.contextSources) validateContextSource(source, limits.effectTimeoutMs);
  invariant(!config.contextSources.length || config.contextPolicy, 'context_source_counter_required');
  invariant(config.hooks.every(hook => hook.timeoutMs > 0 && hook.timeoutMs < limits.effectTimeoutMs), 'invalid_hook_timeout');
  for (const hook of config.hooks) validateHookDefinition(hook);
  invariant(Number.isSafeInteger(config.stopHookContinuationLimit) && config.stopHookContinuationLimit >= 0, 'invalid_stop_hook_limit');
  invariant(!config.hooks.some(hook => hook.events.includes('Stop')) || input.stopHookContinuationLimit !== undefined, 'stop_hook_requires_limit');
  invariant(['text', 'json_object', 'json_value'].includes(config.contract.finalOutputFormat), 'invalid_final_output_format');
  invariant(['manual', 'pure-inference/v1'].includes(config.modelRecoveryPolicy), 'invalid_model_recovery_policy');
  invariant(config.backgroundNotificationPolicy === undefined || config.backgroundNotificationPolicy === null
    || config.backgroundNotificationPolicy === 'completed-before-model/v1', 'invalid_background_notification_policy');
  if (config.contextPolicy) {
    const policy = config.contextPolicy;
    invariant(policy.summaryFormatPolicy === undefined || policy.summaryFormatPolicy === 'task-continuity/v1',
      'invalid_summary_format_policy');
    invariant(typeof policy.tokenizerId === 'string' && policy.tokenizerId.trim() && typeof policy.tokenizerDigest === 'string' && policy.tokenizerDigest.trim()
      && typeof policy.enabled === 'boolean' && Number.isFinite(policy.triggerRatio) && Number.isFinite(policy.targetRatio)
      && policy.targetRatio > 0 && policy.targetRatio < policy.triggerRatio && policy.triggerRatio <= 1
      && Number.isSafeInteger(policy.summaryMaxTokens) && policy.summaryMaxTokens > 0
      && ['strict', 'context_bounded_estimate'].includes(policy.summaryBudgetMode ?? 'strict')
      && (policy.budgetTiming === undefined || policy.budgetTiming === 'before-model/v1')
      && (policy.continuityPlacement === undefined || policy.continuityPlacement === 'after-history/v1'
        && profile.operatorGuidancePolicy === undefined)
      && (policy.sourceReusePolicy === undefined || policy.sourceReusePolicy === 'captured-source/v1'
        && profile.providerFamily === 'openai-chat' && config.artifactPolicy === 'runtime-artifacts/v1')
      && (policy.maxCompactions === null || Number.isSafeInteger(policy.maxCompactions) && policy.maxCompactions >= 0)
      && [policy.maxCompactionsWithoutProgress, policy.minModelTurnsBetween, policy.maxSummaryRetries].every(value => Number.isSafeInteger(value) && value >= 0),
    'invalid_context_policy');
    const workingSet = [policy.readWorkingSetCount, policy.readWorkingSetMaxTokens, policy.readWorkingSetTotalMaxTokens];
    invariant(workingSet.every(value => value === undefined)
      || workingSet.every(value => Number.isSafeInteger(value) && value! >= 0), 'invalid_context_working_set_policy');
    const recent = [policy.recentToolBatchCount, policy.recentToolBatchMaxTokens, policy.recentToolBatchesTotalMaxTokens];
    invariant(recent.every(value => value === undefined)
      || recent.every(value => Number.isSafeInteger(value) && value! >= 0), 'invalid_context_recent_tool_policy');
    invariant(policy.pruneToolResults === undefined || typeof policy.pruneToolResults === 'boolean', 'invalid_context_pruning_policy');
    invariant(policy.pruneThresholdPolicy === undefined || policy.pruneThresholdPolicy === 'zcode-local/v1', 'invalid_context_pruning_policy');
    invariant(policy.pruneSummaryPolicy === undefined || policy.pruneSummaryPolicy === 'zcode-local/v1', 'invalid_context_pruning_policy');
    invariant(policy.pruneIdleThresholdMinutes === undefined || Number.isSafeInteger(policy.pruneIdleThresholdMinutes)
      && policy.pruneIdleThresholdMinutes >= 0, 'invalid_context_pruning_policy');
    invariant([policy.pruneKeepRecentBatches, policy.pruneMinSavedTokens, policy.pruneThresholdTokens].every(value => value === undefined
      || Number.isSafeInteger(value) && value! >= 1), 'invalid_context_pruning_policy');
  }
  validateSubmissionContract(config);
  if (config.workspaceObservationPolicy) {
    const policy = config.workspaceObservationPolicy;
    invariant(policy.role === 'browser' && Array.isArray(policy.pathSuffixes)
      && policy.pathSuffixes.length >= 1 && policy.pathSuffixes.length <= 64
      && Array.from(policy.pathSuffixes).every(suffix => typeof suffix === 'string'
        && suffix.startsWith('.') && suffix === suffix.toLowerCase() && !suffix.includes('/')),
    'invalid_workspace_observation_policy');
  }
  return copy(config);
}
export function initialSnapshot(identity: RunIdentity, configuration: RunConfiguration, configDigest: string): RunSnapshot {
  scopeKey(identity.scope);
  for (const value of [identity.runId, identity.sessionId, identity.turnId, identity.buildId, identity.taskChainId, configDigest]) {
    invariant(typeof value === 'string' && value.trim(), 'invalid_run_identity');
  }
  return copy({ ...identity, schemaVersion: NATIVE_SCHEMA, configDigest, revision: 0, eventSeq: 0,
    phase: 'created', resumePhase: null, goal: configuration.contract.objective, goalRevision: 0,
    taskContract: null, taskContractDigest: null,
    messages: [
      ...(configuration.instructions ? [{ role: 'system' as const, content: configuration.instructions, persistent: true }] : []),
      ...modelSurfaceMessages(configuration),
      ...(configuration.conversationSeed?.messages ?? []),
      ...(configuration.inputMessages ?? [{ role: 'user' as const, content: configuration.contract.objective }]),
    ], preparedContext: null, queuedGuidance: [],
    ...(configuration.toolDiscoveryPolicy ? { toolDiscovery: { discovered: configuration.conversationSeed?.discoveredToolNames ?? [],
      promoted: configuration.conversationSeed?.discoveredToolNames ?? [] } } : {}),
    ...(configuration.todoPolicy ? { todos: { items: configuration.conversationSeed?.todos ?? [], revision: configuration.conversationSeed?.todos === undefined ? 0 : 1,
      assistantTurns: 0, lastWriteAssistantTurn: 0, lastReminderAssistantTurn: 0 } } : {}),
    ...(configuration.planModePolicy ? { planMode: { active: configuration.planModeInitialActive!, revision: 0 } } : {}),
    ...(configuration.guidancePolicy === 'boundary-guide/v1' ? { pendingGuidanceIds: [] } : {}),
    ...(configuration.toolErrorRecoveryPolicy != null || configuration.toolErrorRecoveryModelCalls != null
      ? { toolErrorRecovery: null, observedProgressRevision: 0, observedProgressFingerprints: [] } : {}),
    ...(configuration.deliveryReviewPolicy ? { deliveryReview: null, workspaceObservationStatus: 'unavailable' as const } : {}),
    pendingTools: [], pendingIntent: null, pendingInteraction: null, interaction: null,
    usage: emptyUsage(), descendantUsage: emptyUsage(), modelErrors: 0, providerErrors: 0,
    continuations: 0, outputRestarts: 0, repairs: 0, activeElapsedMs: 0, retryNotBefore: 0,
    candidate: null, verification: null, finalText: '', outcome: null, reason: null,
    workspaceRevision: null, workspaceModifiedPaths: [], artifactRefs: [], children: [], backgroundCommands: [],
    childBudgetReservations: [], childRunIds: [], promotedChildRunIds: [],
    childLifecycleCursor: null, childLifecycleFailure: null, childApproval: null, childTerminalPhase: null,
    workspaceDirtySinceCheckpoint: false, lastWorkspaceMutationToolCall: null,
    checkpointWorkspaceRevision: null, checkpointWebMutationToolCall: null, verificationToolCalls: null,
    failureFingerprint: null, failureEvidenceDigest: null,
    context: {}, diagnostics: {}, stopHookContinuations: 0, hookState: null, contextState: null, recoveryRetriesUsed: 0, toolErrorStreak: null,
    browserSessionRefs: [], browserReobservationRefs: [], lastBrowserObservation: null, lastBrowserAttemptToolCall: null,
    lastWebMutationToolCall: null, unresolvedInteractionObservation: null,
  });
}
