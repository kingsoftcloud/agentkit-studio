import { invariant } from '@kingsoftcloud/agentkit-harness-core';

// Exact supported model IDs from the provider's tool-search compatibility table.
// Custom Anthropic endpoints can explicitly declare support in their profile.
const supported = new Set(['claude-fable-5-1', 'claude-mythos-5-1', 'claude-fable-5', 'claude-mythos-5',
  'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-haiku-5-5',
  'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6',
  'claude-opus-4-5-20251101', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001']);

export function admitProviderToolSearchPolicy({ protocol, model, requested, discovery }) {
  invariant(requested === undefined || typeof requested === 'boolean', 'native_provider_tool_search_invalid');
  invariant(requested !== true || protocol === 'anthropic-messages', 'native_provider_tool_search_protocol_unsupported');
  return protocol === 'anthropic-messages' && discovery && requested !== false
    && (requested === true || supported.has(String(model).trim().toLowerCase()))
    ? 'anthropic-deferred/v1' : 'local-only/v1';
}
