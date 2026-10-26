// Modified Apache-2.0 code; attribution and license: THIRD_PARTY_NOTICES.md.
// Wire-only stable-prefix and conversation-tail caching.
// No extra model requests, persisted message edits or provider replay edits.
const ephemeral = () => ({ type: 'ephemeral' });
const cacheable = block => ['text', 'image', 'tool_use', 'tool_result'].includes(block?.type)
  && (block.type !== 'text' || typeof block.text === 'string' && block.text.trim().length > 0);
const withoutMarker = block => {
  const { cache_control: _marker, ...content } = block;
  return content;
};

/** Host profile admission versions this projection; absent policy is unchanged.
 * Only top-level provider content slots are inspected: tool arguments/schema
 * properties named cache_control are ordinary application data, not markers. */
export function projectAnthropicPromptCache(payload, systemParts, request) {
  if (request.profile.promptCachePolicy === undefined) return payload;
  if (request.profile.promptCachePolicy !== 'anthropic-prefix/v1') throw new Error('invalid_prompt_cache_policy');
  const projected = { ...payload, messages: payload.messages.map(message => ({ ...message,
    content: Array.isArray(message.content) ? message.content.map(withoutMarker) : message.content })) };
  const sections = systemParts.filter(text => text.trim()).map(text => ({ type: 'text', text }));
  if (sections.length) {
    // The first admitted section is the reusable instruction prefix. Later
    // sections may carry changing execution continuity; keep a separate point
    // so changes there cannot invalidate the earlier cache entry.
    sections[0].cache_control = ephemeral();
    if (sections.length > 1) sections.at(-1).cache_control = ephemeral();
    projected.system = sections;
  }
  // Temporary summary prompts are not a growing conversation tail. Avoid a
  // cache write on their unique source chunk; stable instructions remain marked.
  // An explicit Host automatic-cache option already owns the moving tail.
  if (request.purpose === 'compaction' || payload.cache_control !== undefined) return projected;
  for (let index = projected.messages.length - 1; index >= 0; index--) {
    const message = projected.messages[index];
    if (!['user', 'assistant'].includes(message.role)) continue;
    if (typeof message.content === 'string') {
      if (!message.content.trim()) continue;
      message.content = [{ type: 'text', text: message.content, cache_control: ephemeral() }];
      break;
    }
    const position = message.content.findLastIndex(cacheable);
    if (position < 0) continue;
    message.content[position] = { ...message.content[position], cache_control: ephemeral() };
    break;
  }
  // At most three explicit breakpoints: stable prefix, system suffix, tail.
  // Thinking/redacted-thinking signatures never receive a cache marker.
  return projected;
}
