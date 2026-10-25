import { invariant } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { createNativeContextPort } from '../../packages/agentkit-harness/src/native/context-counter.mjs';

/** Bind budget, counter and policy from the resolved Agent revision/Frozen Build. */
export function bindNativeContext({ description, context = {}, maxTokens, readWorkingSetDefaults = false, recentToolBatchDefaults = false } = {}) {
  invariant(context && typeof context === 'object' && !Array.isArray(context), 'studio_native_context_invalid');
  const raw = context.compaction ?? {};
  invariant(raw && typeof raw === 'object' && !Array.isArray(raw), 'studio_native_compaction_invalid');
  const supported = ['enabled', 'thresholdRatio', 'targetRatio', 'summaryMaxTokens', 'maxCompactions',
    'maxCompactionsWithoutProgress', 'minModelTurnsBetween', 'maxSummaryRetries',
    'readWorkingSetCount', 'readWorkingSetMaxTokens', 'readWorkingSetTotalMaxTokens',
    'recentToolBatchCount', 'recentToolBatchMaxTokens', 'recentToolBatchesTotalMaxTokens',
    'pruneToolResults', 'pruneKeepRecentBatches', 'pruneMinSavedTokens', 'pruneThresholdTokens'];
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
    enabled: raw.enabled ?? true, triggerRatio, targetRatio: raw.targetRatio ?? Math.min(.45, triggerRatio * .45 / .72),
    summaryMaxTokens: raw.summaryMaxTokens ?? Math.min(8192, output, Math.max(2048, Math.floor(contextWindow / 8))),
    maxCompactions: raw.maxCompactions ?? null, maxCompactionsWithoutProgress: raw.maxCompactionsWithoutProgress ?? 8,
    minModelTurnsBetween: raw.minModelTurnsBetween ?? 2, maxSummaryRetries: raw.maxSummaryRetries ?? 2,
    ...(['pruneToolResults', 'pruneKeepRecentBatches', 'pruneMinSavedTokens', 'pruneThresholdTokens'].some(key => Object.hasOwn(raw, key)) ? {
      pruneToolResults: raw.pruneToolResults ?? false, pruneKeepRecentBatches: raw.pruneKeepRecentBatches ?? 5,
      pruneMinSavedTokens: raw.pruneMinSavedTokens ?? 256,
      ...(Object.hasOwn(raw, 'pruneThresholdTokens') ? { pruneThresholdTokens: raw.pruneThresholdTokens } : {}),
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
