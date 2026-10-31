// Anthropic-native tool search wire projection.
//
// Pairs with request.profile.providerToolSearchPolicy 'anthropic-deferred/v1':
// advertises deferred tools with full schemas and defer_loading:true, and
// rewrites successful ToolSearch receipts as Anthropic tool_reference content
// blocks derived only from the kernel-owned discoveredToolNames metadata.
// Local/absent policy preserves existing wire byte behavior exactly.

import { ProtocolError } from './model-normalize.mjs';
import { TOOL_SEARCH } from '@kingsoftcloud/agentkit-harness-core';

export const NATIVE_TOOL_SEARCH_BETA = 'advanced-tool-use-2025-11-20';
const POLICY_NATIVE = 'anthropic-deferred/v1';
const MAX_TOOL_REFERENCES = 20;

/** True only for the native Anthropic deferred-tool-search policy. */
export function isNativeToolSearch(profile) {
  return profile?.providerToolSearchPolicy === POLICY_NATIVE;
}

/**
 * Merge the advanced-tool-use beta into the existing anthropic-beta header.
 * Case-insensitive dedup preserves an existing thinking beta and any other
 * Host-selected betas; only native mode adds the tool-search beta.
 * @param headers - mutable header map (anthropic-beta may be absent or set).
 */
export function mergeNativeToolSearchBeta(headers) {
  const keys = Object.keys(headers).filter(key => key.toLowerCase() === 'anthropic-beta');
  const betas = new Set(keys.flatMap(key => (headers[key] || '').split(',').map(value => value.trim()).filter(Boolean)));
  let has = false;
  for (const beta of betas) if (beta.toLowerCase() === NATIVE_TOOL_SEARCH_BETA.toLowerCase()) has = true;
  if (!has) betas.add(NATIVE_TOOL_SEARCH_BETA);
  keys.forEach(key => delete headers[key]);
  headers['anthropic-beta'] = [...betas].join(',');
}

/**
 * Advertise one admitted tool with its full schema. Native mode marks
 * deferred tools with defer_loading:true; the schema is always sent per the
 * Anthropic advanced-tool-use contract. Non-native callers do not use this.
 */
export function anthropicToolEntry(tool) {
  const entry = {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters || { type: 'object', properties: {} },
  };
  if (tool.discovery?.deferred === true) entry.defer_loading = true;
  return entry;
}

/**
 * Validate kernel-owned discoveredToolNames metadata for a native-mode tool
 * receipt and return Anthropic tool_reference blocks, or undefined to keep the
 * ordinary text/media projection.
 *
 * Authority: names come only from discoveredToolNames, never from result text.
 * The paired pending assistant call must be exactly ToolSearch. Names must be
 * unique, at most 20, all strings, and all present in the current request
 * tools. Malformed or unpaired metadata fails preflight rather than widening
 * authority; empty valid names keep normal result text.
 *
 * @param message - the tool receipt message.
 * @param pairedCallName - name of the pending assistant call this receipt pairs.
 * @param tools - current request tools for name-membership validation.
 */
export function nativeToolReferenceContent(message, pairedCallName, tools) {
  const names = message.discoveredToolNames;
  if (names === undefined) return undefined;
  if (pairedCallName !== TOOL_SEARCH) throw new ProtocolError('tool_reference metadata paired with a non-ToolSearch call');
  if (!Array.isArray(names)) throw new ProtocolError('discoveredToolNames must be an array');
  if (names.length === 0) return undefined;
  if (names.length > MAX_TOOL_REFERENCES) throw new ProtocolError('too many tool references');
  const seen = new Set();
  const known = new Set((tools || []).map(tool => tool.name));
  const references = [];
  for (const name of names) {
    if (typeof name !== 'string' || !name.trim()) throw new ProtocolError('tool reference name must be a non-empty string');
    if (seen.has(name)) throw new ProtocolError('duplicate tool reference name');
    if (!known.has(name)) throw new ProtocolError('tool reference name is not an admitted tool');
    seen.add(name);
    references.push({ type: 'tool_reference', tool_name: name });
  }
  return references;
}
