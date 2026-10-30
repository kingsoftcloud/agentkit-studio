import { createHash } from 'node:crypto';
import { canonical, invariant } from '@kingsoftcloud/agentkit-harness-core';
import { buildNativeModelRequest } from './model-request.mjs';

// Pinned reference: native_planning.py + workspace_read_budget.py at 355059d.
// These are conservative estimated tokens, never reported provider usage or a
// claim of exact provider tokenization. The wire projection is the HTTP one.
export const NATIVE_CONTEXT_COUNTER_ID = 'agentkit.studio-cjk-ascii-estimate-125-wire-image/v1';
const whitespace = /^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu;
export function estimateNativeText(text) {
  invariant(typeof text === 'string', 'context_counter_text_invalid');
  let cjk = 0, other = 0;
  for (const char of text.replace(whitespace, '')) {
    const code = char.codePointAt(0);
    if (code >= 0x3400 && code <= 0x4dbf || code >= 0x4e00 && code <= 0x9fff || code >= 0xf900 && code <= 0xfaff) cjk++;
    else other++;
  }
  return Math.max(1, Math.ceil((Math.floor(cjk * 1.5) + Math.ceil(other / 4)) * 1.25));
}

/** Estimate actual provider fields, charging image bytes separately from text. */
export function estimateNativeWireInput(body, protocol = Array.isArray(body.input) && !body.messages ? 'openai-responses' : 'openai-chat') {
  const wire = structuredClone(body);
  for (const key of ['model', 'stream', 'stream_options', 'max_tokens', 'max_completion_tokens', 'max_output_tokens']) delete wire[key];
  if (protocol === 'anthropic-messages') {
    expandToolReferences(wire.messages, wire.tools);
    // Deferred definitions are HTTP catalog data, not initial model context.
    if (wire.tools) wire.tools = wire.tools.filter(tool => tool.defer_loading !== true);
  }
  return priceWireSurface(wire, protocol === 'openai-responses' ? wire.input : wire.messages);
}
function expandToolReferences(messages = [], tools = []) {
  const catalog = new Map(tools.map(tool => [tool.name, tool]));
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const result of message.content) {
      if (result.type !== 'tool_result' || !Array.isArray(result.content)) continue;
      result.content = result.content.map(block => {
        if (block.type !== 'tool_reference') return block;
        const definition = catalog.get(block.tool_name);
        invariant(definition, 'context_counter_tool_reference_unknown');
        const { defer_loading: _deferred, cache_control: _cache, ...expanded } = definition;
        return { type: 'text', text: canonical(expanded) };
      });
    }
  }
}
function priceWireSurface(surface, messages = []) {
  let images = 0;
  const reserve = url => {
    invariant(typeof url === 'string' && url, 'context_counter_image_invalid');
    images += url.startsWith('data:image/') ? Math.max(2048, Math.ceil(url.slice(url.indexOf(',') + 1).length / 8)) : 8192;
  };
  const visit = value => {
    if (value === null || typeof value !== 'object') return;
    if (value.type === 'image_url' && value.image_url?.url) {
      reserve(value.image_url.url); value.image_url = { url: '[Host image budgeted separately]' }; return;
    }
    if (value.type === 'input_image' && typeof value.image_url === 'string') {
      reserve(value.image_url); value.image_url = '[Host image budgeted separately]'; return;
    }
    if (value.type === 'image' && value.source) {
      const source = value.source;
      if (source.type === 'base64') reserve(`data:${source.media_type};base64,${source.data}`);
      else if (source.type === 'url') reserve(source.url);
      else invariant(false, 'context_counter_image_invalid');
      value.source = { type: 'host-budgeted-image' }; return;
    }
    if (value.type === 'tool_result' && Array.isArray(value.content)) value.content.forEach(visit);
  };
  // Only provider message slots contain image blocks. Tool schemas and text
  // may describe image-shaped data; that data must be priced as ordinary JSON.
  for (const message of messages ?? []) {
    if (Array.isArray(message.content)) message.content.forEach(visit);
    if (message.type === 'function_call_output' && Array.isArray(message.output)) message.output.forEach(visit);
  }
  const count = estimateNativeText(canonical(surface)) + images;
  invariant(Number.isSafeInteger(count) && count >= 0, 'context_counter_overflow');
  return count;
}

/** Price actual provider fields for one logical message, including replay/media.
 * Synthetic protocol partners only make the normal wire builder callable; their
 * fields are excluded from the returned cost. No model or tool is executed. */
export function estimateNativeMessage(binding, request) {
  const message = structuredClone(request.message), messages = [message];
  if (message.role === 'assistant' && message.toolCalls?.length) {
    messages.push(...message.toolCalls.map(call => ({ role: 'tool', name: call.name, callId: call.callId, content: '' })));
  } else if (message.role === 'tool') {
    messages.unshift({ role: 'assistant', content: '', toolCalls: [{ callId: message.callId,
      name: request.profile.providerToolSearchPolicy === 'anthropic-deferred/v1' && message.discoveredToolNames !== undefined
        ? 'ToolSearch' : message.name || 'source', arguments: {} }] });
  }
  const tools = request.profile.providerToolSearchPolicy === 'anthropic-deferred/v1' ? request.tools ?? [] : [];
  const built = buildNativeModelRequest(binding, { ...request, messages, tools, finalizationOnly: false });
  const body = JSON.parse(built.body);
  let projected;
  if (binding.protocol === 'openai-responses') {
    if (message.role === 'system') return priceWireSurface({ instructions: body.instructions ?? '' });
    projected = body.input.filter(item => message.role === 'tool' ? item.type !== 'function_call'
      : message.role === 'assistant' ? item.type !== 'function_call_output' : true);
  } else if (binding.protocol === 'anthropic-messages' && message.role === 'system') {
    return priceWireSurface(body.system ?? '');
  } else {
    projected = body.messages.filter(item => message.role === 'tool' ? item.role !== 'assistant'
      : message.role === 'assistant' ? item.role === 'assistant' : true);
  }
  invariant(projected.length > 0, 'context_counter_message_invalid');
  if (binding.protocol === 'anthropic-messages') expandToolReferences(projected, body.tools);
  return priceWireSurface(projected.length === 1 ? projected[0] : projected, projected);
}

export function createNativeContextPort({ protocol, model, parameters = {} } = {}) {
  invariant(['openai-chat', 'openai-responses', 'anthropic-messages'].includes(protocol)
    && typeof model === 'string' && model.trim(), 'context_counter_binding_invalid');
  const binding = { protocol, model, parameters: structuredClone(parameters),
    baseUrl: 'https://native-counter.invalid/v1', apiKey: 'counting-only' };
  const tokenizerDigest = createHash('sha256').update(canonical({ policy: NATIVE_CONTEXT_COUNTER_ID,
    protocol, model, parameters: binding.parameters })).digest('hex');
  return { tokens: Object.freeze({ tokenizerId: NATIVE_CONTEXT_COUNTER_ID, tokenizerDigest,
    async countText(request) { request.signal.throwIfAborted(); return estimateNativeText(request.text); },
    async countMessage(request) {
      request.signal.throwIfAborted(); const count = estimateNativeMessage(binding, request);
      request.signal.throwIfAborted(); return count;
    },
    async countRequest(request) {
      request.signal.throwIfAborted();
      const built = buildNativeModelRequest(binding, { ...request, finalizationOnly: false });
      const count = estimateNativeWireInput(JSON.parse(built.body), binding.protocol);
      request.signal.throwIfAborted(); return count;
    },
  }) };
}
