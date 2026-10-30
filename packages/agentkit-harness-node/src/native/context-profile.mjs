import { invariant } from '@kingsoftcloud/agentkit-harness-core';
import { createNativeContextPort } from '@kingsoftcloud/agentkit-harness-node/native/context-counter';

/** Restore the admitted context strategies rather than activating new defaults on an old Run. */
export function nativeContextDefaults(configuration) {
  const policy = configuration?.contextPolicy;
  return {
    structuredContinuityDefaults: !configuration || policy?.summaryFormatPolicy === 'task-continuity/v1',
    readWorkingSetDefaults: !configuration || Object.hasOwn(policy ?? {}, 'readWorkingSetCount'),
    recentToolBatchDefaults: !configuration || Object.hasOwn(policy ?? {}, 'recentToolBatchCount'),
    pruningThresholdDefaults: !configuration || policy?.pruneThresholdPolicy === 'zcode-local/v1',
    pruningSummaryDefaults: !configuration || policy?.pruneSummaryPolicy === 'zcode-local/v1',
    pruningIdleDefaults: !configuration || policy?.pruneIdleThresholdMinutes !== undefined,
    preModelBudgetDefaults: !configuration || policy?.budgetTiming === 'before-model/v1',
    orderedContextDefaults: !configuration || policy?.continuityPlacement === 'after-history/v1',
    sourceReuseDefaults: !configuration || policy?.sourceReusePolicy === 'captured-source/v1',
  };
}

/** Bind budget, counter and policy from the resolved Agent revision/Frozen Build. */
export function bindNativeContext({ description, context = {}, maxTokens, structuredContinuityDefaults = false, preModelBudgetDefaults = false, orderedContextDefaults = false, sourceReuseDefaults = false, readWorkingSetDefaults = false, recentToolBatchDefaults = false, pruningThresholdDefaults = false, pruningSummaryDefaults = false, pruningIdleDefaults = false } = {}) {
  invariant(context && typeof context === 'object' && !Array.isArray(context), 'studio_native_context_invalid');
  const raw = context.compaction ?? {};
  invariant(raw && typeof raw === 'object' && !Array.isArray(raw), 'studio_native_compaction_invalid');
  const supported = ['enabled', 'thresholdRatio', 'targetRatio', 'summaryMaxTokens', 'maxCompactions',
    'maxCompactionsWithoutProgress', 'minModelTurnsBetween', 'maxSummaryRetries',
    'readWorkingSetCount', 'readWorkingSetMaxTokens', 'readWorkingSetTotalMaxTokens',
    'recentToolBatchCount', 'recentToolBatchMaxTokens', 'recentToolBatchesTotalMaxTokens',
    'pruneToolResults', 'pruneKeepRecentBatches', 'pruneMinSavedTokens', 'pruneThresholdTokens', 'pruneIdleThresholdMinutes'];
  invariant(Object.keys(raw).every(key => supported.includes(key)), 'studio_native_compaction_option_unsupported');
  const requestedWindow = context.maxInputTokens ?? description.contextWindow;
  const output = maxTokens ?? context.reserveOutputTokens ?? description.maxOutputTokens;
  invariant(Number.isSafeInteger(requestedWindow) && requestedWindow > 0
    && Number.isSafeInteger(output) && output > 0 && output <= description.maxOutputTokens, 'studio_native_context_budget_invalid');
  const contextWindow = Math.min(requestedWindow, description.contextWindow);
  invariant(output < contextWindow, 'studio_native_context_budget_conflict');
  const port = createNativeContextPort({ protocol: description.protocol, model: description.modelName, parameters: description.parameters });
  const triggerRatio = raw.thresholdRatio ?? .72;
  return { port, profile: { contextWindow, maxOutputTokens: output }, policy: {
    tokenizerId: port.tokens.tokenizerId, tokenizerDigest: port.tokens.tokenizerDigest,
    summaryBudgetMode: 'context_bounded_estimate',
    ...(structuredContinuityDefaults ? { summaryFormatPolicy: 'task-continuity/v1' } : {}),
    ...(preModelBudgetDefaults ? { budgetTiming: 'before-model/v1' } : {}),
    ...(orderedContextDefaults && description.protocol === 'openai-chat' ? { continuityPlacement: 'after-history/v1' } : {}),
    ...(sourceReuseDefaults && description.protocol === 'openai-chat' ? { sourceReusePolicy: 'captured-source/v1' } : {}),
    enabled: raw.enabled ?? true, triggerRatio, targetRatio: raw.targetRatio ?? Math.min(.45, triggerRatio * .45 / .72),
    summaryMaxTokens: raw.summaryMaxTokens ?? Math.min(8192, output, Math.max(2048, Math.floor(contextWindow / 8))),
    maxCompactions: raw.maxCompactions ?? null, maxCompactionsWithoutProgress: raw.maxCompactionsWithoutProgress ?? 8,
    minModelTurnsBetween: raw.minModelTurnsBetween ?? 2, maxSummaryRetries: raw.maxSummaryRetries ?? 2,
    ...(['pruneToolResults', 'pruneKeepRecentBatches', 'pruneMinSavedTokens', 'pruneThresholdTokens', 'pruneIdleThresholdMinutes'].some(key => Object.hasOwn(raw, key)) ? {
      pruneToolResults: raw.pruneToolResults ?? false, pruneKeepRecentBatches: raw.pruneKeepRecentBatches ?? 5,
      pruneMinSavedTokens: raw.pruneMinSavedTokens ?? 256,
      ...(Object.hasOwn(raw, 'pruneThresholdTokens') ? { pruneThresholdTokens: raw.pruneThresholdTokens } : {}),
      ...(pruningThresholdDefaults && raw.pruneToolResults === true && !Object.hasOwn(raw, 'pruneThresholdTokens')
        ? { pruneThresholdPolicy: 'zcode-local/v1' } : {}),
      ...(pruningSummaryDefaults && raw.pruneToolResults === true ? { pruneSummaryPolicy: 'zcode-local/v1' } : {}),
      ...(Object.hasOwn(raw, 'pruneIdleThresholdMinutes') ? { pruneIdleThresholdMinutes: raw.pruneIdleThresholdMinutes }
        : pruningIdleDefaults && raw.pruneToolResults === true ? { pruneIdleThresholdMinutes: 60 } : {}),
    } : {}),
    ...(readWorkingSetDefaults || ['readWorkingSetCount', 'readWorkingSetMaxTokens', 'readWorkingSetTotalMaxTokens']
      .some(key => Object.hasOwn(raw, key)) ? {
        readWorkingSetCount: raw.readWorkingSetCount ?? 8, readWorkingSetMaxTokens: raw.readWorkingSetMaxTokens ?? 6000,
        readWorkingSetTotalMaxTokens: raw.readWorkingSetTotalMaxTokens ?? 16000,
      } : {}),
    ...(recentToolBatchDefaults || ['recentToolBatchCount', 'recentToolBatchMaxTokens', 'recentToolBatchesTotalMaxTokens']
      .some(key => Object.hasOwn(raw, key)) ? {
        recentToolBatchCount: raw.recentToolBatchCount ?? 4,
        recentToolBatchMaxTokens: raw.recentToolBatchMaxTokens ?? Math.min(12000, Math.floor(contextWindow / 6)),
        recentToolBatchesTotalMaxTokens: raw.recentToolBatchesTotalMaxTokens ?? Math.min(24000, Math.floor(contextWindow / 4)),
      } : {}),
  } };
}
