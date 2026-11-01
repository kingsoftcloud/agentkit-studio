/** Chat Completions reports a per-request snapshot, including cached input. */
export function chatCompletionUsage(raw) {
  const valid = value => Number.isSafeInteger(value) && value >= 0;
  if (!raw || !valid(raw.prompt_tokens) || !valid(raw.completion_tokens)) return null;
  const result = { inputTokens: raw.prompt_tokens, outputTokens: raw.completion_tokens };
  const cached = raw.prompt_tokens_details?.cached_tokens ?? raw.prompt_cache_hit_tokens;
  const reasoning = raw.completion_tokens_details?.reasoning_tokens ?? raw.reasoning_tokens;
  if (valid(cached)) result.cachedInputTokens = Math.min(cached, result.inputTokens);
  if (valid(reasoning)) result.reasoningTokens = Math.min(reasoning, result.outputTokens);
  return result;
}
