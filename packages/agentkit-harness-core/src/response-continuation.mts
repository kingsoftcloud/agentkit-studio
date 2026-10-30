import type { Message, RunConfiguration, RunSnapshot } from './contracts.mjs';

/** Journaled Host controls may be staged between response fragments. Actual
 * user input, tool observations and new assistant messages end the chain. */
function hostControl(message: Message): boolean {
  return message.role === 'system' && message.kind === 'host_request_guidance'
    || message.role === 'user' && ['policy_context', 'response_continuation_feedback', 'host_request_boundary'].includes(message.kind ?? '');
}

export function responseContinuationPairs(messages: Message[], digest?: (value: unknown) => string): [number, number][] {
  const pairs: [number, number][] = [];
  let cursor = messages.length - 1;
  while (cursor >= 1) {
    while (cursor >= 0 && hostControl(messages[cursor]!)) cursor--;
    if (cursor < 1) break;
    const observation = messages[cursor]!, fragment = messages[cursor - 1]!;
    if (observation.role !== 'user' || observation.kind !== 'continuation_observation'
      || observation.continuationPolicy !== 'response-boundary/v2' || observation.continuationMode !== 'suffix'
      || fragment.role !== 'assistant' || fragment.kind !== 'continuation_fragment' || !fragment.content.trim()
      || !fragment.continuationResponseId || fragment.continuationResponseId !== observation.continuationResponseId
      || !observation.continuationFragmentDigest || digest && observation.continuationFragmentDigest !== digest(fragment.content)) break;
    pairs.unshift([cursor - 1, cursor]); cursor -= 2;
  }
  return pairs;
}

/** This only narrows admission. Digest validation is required for assembly. */
export function responseContinuationPending(snapshot: RunSnapshot, config: RunConfiguration): boolean {
  return config.outputRecoveryPolicy === 'response-boundary/v2' && responseContinuationPairs(snapshot.messages).length > 0;
}

/** The v2 wire contract permits replay of exactly the unfinished final line.
 * No complete line, fuzzy match, arbitrary suffix or raw receipt is removed. */
export function joinResponseContinuation(prefix: string, continuation: string): string {
  const line = prefix.slice(prefix.lastIndexOf('\n') + 1);
  const replay = line.length >= 8 && line.length <= 1024 && line.trim()
    && continuation.startsWith(line) ? line.length : 0;
  return prefix + continuation.slice(replay);
}
