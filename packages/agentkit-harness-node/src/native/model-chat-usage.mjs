import { ProtocolError } from './model-normalize.mjs';

export const CUMULATIVE_CHAT_USAGE = 'cumulative-snapshots/v1';
export const admitChatUsagePolicy = protocol => protocol === 'openai-chat' ? CUMULATIVE_CHAT_USAGE : undefined;
const fields = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningTokens'];

/** Usage reports describe a single request, never additional token deltas.
 * Optional subdivisions may arrive late; absence never fabricates a zero or
 * erases a known count. Generation sealing is handled separately by the stream.
 * Legacy absence retains exact primary-counter comparison for frozen Runs. */
export function mergeChatUsage(previous, reported, policy, finalized = false) {
  if (policy !== undefined && policy !== CUMULATIVE_CHAT_USAGE)
    throw new ProtocolError('invalid chat usage policy', 'request_invalid');
  if (!previous) return { ...reported };
  if (policy === undefined) {
    if (previous.inputTokens !== reported.inputTokens || previous.outputTokens !== reported.outputTokens)
      throw new ProtocolError('conflicting usage reports in one attempt', 'usage_conflict');
    return { ...reported };
  }
  for (const field of fields) if (Object.hasOwn(previous, field) && Object.hasOwn(reported, field)
    && (reported[field] < previous[field] || finalized && reported[field] !== previous[field]))
    throw new ProtocolError('conflicting cumulative usage reports in one attempt', 'usage_conflict');
  return { ...previous, ...reported };
}
