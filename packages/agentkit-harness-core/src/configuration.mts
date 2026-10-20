import { emptyUsage, NATIVE_ENGINE, NATIVE_SCHEMA } from './contracts.mjs';
import type { ModelProfile, RunConfiguration, RunIdentity, RunLimits, RunSnapshot, TaskContract, ToolDefinition } from './contracts.mjs';
import { canonical, copy, invariant, scopeKey } from './values.mjs';
import { validateSubmissionContract } from './final-submission.mjs';

export interface ConfigurationInput {
  profile: Pick<ModelProfile, 'profileId' | 'profileVersion' | 'providerFamily' | 'compatibilityDigest'> & Partial<ModelProfile>;
  contract: Pick<TaskContract, 'objective'> & Partial<TaskContract>;
  tools?: ToolDefinition[]; limits?: Partial<RunLimits>; instructions?: string;
  hostBindingDigest: string; contextSources?: RunConfiguration['contextSources']; hooks?: RunConfiguration['hooks'];
  stopHookContinuationLimit?: number; delegationDepth?: number;
  modelRecoveryPolicy?: RunConfiguration['modelRecoveryPolicy'];
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
    effectTimeoutMs: 120_000, leaseMs: 30_000, maxSubagentDepth: 3,
    maxToolResultBytes: 65536, maxInlineImageBytes: 40 * 1024 * 1024, maxRecoveryRetries: 3, ...input.limits,
  };
  const config: RunConfiguration = {
    engine: NATIVE_ENGINE, profile, limits,
    tools: input.tools ?? [], instructions: input.instructions ?? '', hostBindingDigest: input.hostBindingDigest,
    contextSources: input.contextSources ?? [], hooks: input.hooks ?? [],
    stopHookContinuationLimit: input.stopHookContinuationLimit ?? 0, delegationDepth: input.delegationDepth ?? 0,
    modelRecoveryPolicy: input.modelRecoveryPolicy ?? 'manual',
    contract: { revision: '1', constraints: [], acceptance: [], allowedToolNames: null,
      finalSubmissionSchema: null, finalSubmissionPayloadKey: null, finalOutputFormat: 'text', ...input.contract },
  };
  canonical(config);
  invariant(config.contract.objective.trim() && config.hostBindingDigest.trim()
    && profile.profileId.trim() && profile.profileVersion.trim() && profile.providerFamily.trim()
    && profile.compatibilityDigest.trim(), 'configuration_identity_missing');
  for (const [key, value] of Object.entries(limits)) {
    invariant(value === null || Number.isSafeInteger(value) && value >= 0, `invalid_limit:${key}`);
  }
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
    invariant(Number.isFinite(tool.timeoutMs) && tool.timeoutMs > 0 && tool.timeoutMs < limits.effectTimeoutMs, 'invalid_tool_timeout');
    invariant(!tool.concurrentSafe || tool.readOnly && tool.observationRole === 'none', 'invalid_tool_concurrency');
    invariant(!tool.delegatedReadOnly || tool.concurrentSafe, 'invalid_delegated_reader');
    invariant(!tool.backgroundCommandPolicy || !tool.readOnly && !tool.concurrentSafe, 'invalid_background_launcher');
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
  invariant(config.hooks.every(hook => hook.timeoutMs > 0 && hook.timeoutMs < limits.effectTimeoutMs), 'invalid_hook_timeout');
  invariant(!config.hooks.some(hook => hook.events.includes('Stop')) || config.stopHookContinuationLimit > 0, 'stop_hook_requires_limit');
  invariant(['text', 'json_object', 'json_value'].includes(config.contract.finalOutputFormat), 'invalid_final_output_format');
  invariant(['manual', 'pure-inference/v1'].includes(config.modelRecoveryPolicy), 'invalid_model_recovery_policy');
  validateSubmissionContract(config);
  return copy(config);
}
export function initialSnapshot(identity: RunIdentity, configuration: RunConfiguration, configDigest: string): RunSnapshot {
  scopeKey(identity.scope);
  for (const value of [identity.runId, identity.sessionId, identity.turnId, identity.buildId, identity.taskChainId, configDigest]) {
    invariant(typeof value === 'string' && value.trim(), 'invalid_run_identity');
  }
  return copy({ ...identity, schemaVersion: NATIVE_SCHEMA, configDigest, revision: 0, eventSeq: 0,
    phase: 'created', resumePhase: null, goal: configuration.contract.objective, goalRevision: 0,
    messages: [
      ...(configuration.instructions ? [{ role: 'system' as const, content: configuration.instructions, persistent: true }] : []),
      { role: 'user' as const, content: configuration.contract.objective },
    ], pendingTools: [], pendingIntent: null, pendingInteraction: null, interaction: null,
    usage: emptyUsage(), descendantUsage: emptyUsage(), modelErrors: 0, providerErrors: 0,
    continuations: 0, outputRestarts: 0, repairs: 0, activeElapsedMs: 0, retryNotBefore: 0,
    candidate: null, verification: null, finalText: '', outcome: null, reason: null,
    workspaceRevision: null, workspaceModifiedPaths: [], artifactRefs: [], children: [], backgroundCommands: [],
    context: {}, diagnostics: {}, stopHookContinuations: 0, recoveryRetriesUsed: 0,
  });
}
