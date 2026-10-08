/** Codex reports cumulative thread totals; Studio turns own ephemeral threads. */
export function createCodexUsageCounter() {
  let previous = {};
  return total => {
    if (!total || !['inputTokens', 'outputTokens'].every(key => Number.isSafeInteger(total[key]) && total[key] >= 0)) return null;
    const next = { inputTokens: total.inputTokens, outputTokens: total.outputTokens };
    for (const [target, source] of [['cachedInputTokens', 'cachedInputTokens'], ['cacheWriteInputTokens', 'cacheWriteInputTokens'], ['reasoningTokens', 'reasoningOutputTokens']]) {
      if (Number.isSafeInteger(total[source]) && total[source] >= 0) next[target] = total[source];
    }
    if (next.inputTokens < (previous.inputTokens || 0) || next.outputTokens < (previous.outputTokens || 0)) return null;
    const delta = Object.fromEntries(Object.entries(next).map(([key, value]) => [key, Math.max(0, value - (previous[key] || 0))]));
    previous = next;
    return delta.inputTokens || delta.outputTokens ? delta : null;
  };
}

/** DSH input buckets are disjoint; reasoning is already included in output. */
export function nativeCodexUsage(total) {
  const cacheReadTokens = Math.min(total.inputTokens, total.cachedInputTokens || 0);
  const cacheWriteTokens = Math.min(total.inputTokens - cacheReadTokens, total.cacheWriteInputTokens || 0);
  return { inputTokens: total.inputTokens - cacheReadTokens - cacheWriteTokens, outputTokens: total.outputTokens,
    totalTokens: total.inputTokens + total.outputTokens, cacheReadTokens, cacheWriteTokens,
    ...(total.reasoningTokens === undefined ? {} : { reasoningTokens: total.reasoningTokens }) };
}
