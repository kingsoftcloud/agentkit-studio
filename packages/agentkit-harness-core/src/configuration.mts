import { emptyUsage, NATIVE_ENGINE, NATIVE_SCHEMA } from './contracts.mjs';
import type { Message, ModelProfile, RunConfiguration, RunIdentity, RunLimits, RunSnapshot, TaskContract, ToolDefinition } from './contracts.mjs';
import { canonical, copy, invariant, scopeKey } from './values.mjs';
import { validateSubmissionContract } from './final-submission.mjs';
import { compileToolInput } from './tool-input.mjs';
import { validateHookDefinition } from './hook-contract.mjs';
import { validateContextSource } from './context-contributions.mjs';

export interface ConfigurationInput {
  profile: Pick<ModelProfile, 'profileId' | 'profileVersion' | 'providerFamily' | 'compatibilityDigest'> & Partial<ModelProfile>;
  contract: Pick<TaskContract, 'objective'> & Partial<TaskContract>;
  tools?: ToolDefinition[]; limits?: Partial<RunLimits>; instructions?: string;
  hostBindingDigest: string; contextSources?: RunConfiguration['contextSources']; hooks?: RunConfiguration['hooks'];
  stopHookContinuationLimit?: number; delegationDepth?: number;
  modelRecoveryPolicy?: RunConfiguration['modelRecoveryPolicy'];
  guidancePolicy?: RunConfiguration['guidancePolicy'];
  hostRecoveryBinding?: RunConfiguration['hostRecoveryBinding'];
  contextPolicy?: RunConfiguration['contextPolicy'];
  workspaceObservationPolicy?: RunConfiguration['workspaceObservationPolicy'];
  inputMessages?: Message[] | null;
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
    tools: input.tools ?? [], instructions: input.instructions ?? '', hostBindingDigest: input.hostBindingDigest,
    inputMessages: input.inputMessages ?? null,
    ...(input.guidancePolicy === undefined ? {} : { guidancePolicy: input.guidancePolicy }),
    ...(input.hostRecoveryBinding === undefined ? {} : { hostRecoveryBinding: input.hostRecoveryBinding }),
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
  canonical(config);
  invariant(config.hostRecoveryBinding === undefined || config.hostRecoveryBinding !== null
    && typeof config.hostRecoveryBinding === 'object' && !Array.isArray(config.hostRecoveryBinding), 'invalid_host_recovery_binding');
  invariant(config.guidancePolicy == null || config.guidancePolicy === 'boundary-guide/v1', 'invalid_guidance_policy');
  invariant(config.childLifecyclePolicy == null || config.childLifecyclePolicy === 'owned-background/v2', 'invalid_child_lifecycle_policy');
  invariant(config.childApprovalPolicy == null || config.childApprovalPolicy === 'owned-child-approval/v1'
    && config.childLifecyclePolicy === 'owned-background/v2', 'invalid_child_approval_policy');
  invariant(config.childPromotionPolicy == null || config.childPromotionPolicy === 'owned-child-promotion/v1'
    && config.childLifecyclePolicy === 'owned-background/v2', 'invalid_child_promotion_policy');
  invariant(config.childInputPolicy == null || config.childInputPolicy === 'owned-child-input/v1'
    && config.childLifecyclePolicy === 'owned-background/v2', 'invalid_child_input_policy');
  if (config.childOwnerBinding) {
    const binding = config.childOwnerBinding;
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
  for (const [key, value] of Object.entries(limits)) {
    invariant(value === null || Number.isSafeInteger(value) && value >= 0, `invalid_limit:${key}`);
  }
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
  const names = new Set<string>();
  for (const tool of config.tools) {
    invariant(tool.name.trim() && !names.has(tool.name), 'duplicate_or_invalid_tool');
    names.add(tool.name);
    compileToolInput(tool.parameters);
    invariant(Number.isFinite(tool.timeoutMs) && tool.timeoutMs > 0 && tool.timeoutMs < limits.effectTimeoutMs, 'invalid_tool_timeout');
    invariant(!tool.concurrentSafe || tool.readOnly && tool.observationRole === 'none', 'invalid_tool_concurrency');
    invariant(!tool.delegatedReadOnly || tool.concurrentSafe, 'invalid_delegated_reader');
    invariant(tool.childBudgetPolicy === undefined || ['start/v1', 'settle/v1', 'delegate/v1'].includes(tool.childBudgetPolicy), 'invalid_child_budget_policy');
    invariant(!tool.childBudgetPolicy || !tool.concurrentSafe, 'invalid_child_budget_concurrency');
    invariant(!tool.backgroundCommandPolicy || !tool.readOnly && !tool.concurrentSafe, 'invalid_background_launcher');
    invariant(tool.backgroundCommandPolicy === undefined || tool.backgroundCommandPolicy === 'owned-command-launch/v1', 'invalid_background_launcher_policy');
    invariant(tool.recoveryPolicy === undefined || ['manual', 'safe-read/v1'].includes(tool.recoveryPolicy), 'invalid_tool_recovery_policy');
    invariant(tool.recoveryPolicy !== 'safe-read/v1' || tool.readOnly && tool.observationRole === 'none'
      && !tool.delegatedReadOnly && !tool.childBudgetPolicy && !tool.backgroundCommandPolicy, 'invalid_safe_read_recovery');
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
    invariant(typeof policy.tokenizerId === 'string' && policy.tokenizerId.trim() && typeof policy.tokenizerDigest === 'string' && policy.tokenizerDigest.trim()
      && typeof policy.enabled === 'boolean' && Number.isFinite(policy.triggerRatio) && Number.isFinite(policy.targetRatio)
      && policy.targetRatio > 0 && policy.targetRatio < policy.triggerRatio && policy.triggerRatio <= 1
      && Number.isSafeInteger(policy.summaryMaxTokens) && policy.summaryMaxTokens > 0
      && ['strict', 'context_bounded_estimate'].includes(policy.summaryBudgetMode ?? 'strict')
      && (policy.maxCompactions === null || Number.isSafeInteger(policy.maxCompactions) && policy.maxCompactions >= 0)
      && [policy.maxCompactionsWithoutProgress, policy.minModelTurnsBetween, policy.maxSummaryRetries].every(value => Number.isSafeInteger(value) && value >= 0),
    'invalid_context_policy');
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
      ...(configuration.inputMessages ?? [{ role: 'user' as const, content: configuration.contract.objective }]),
    ], preparedContext: null, queuedGuidance: [],
    ...(configuration.guidancePolicy === 'boundary-guide/v1' ? { pendingGuidanceIds: [] } : {}),
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
