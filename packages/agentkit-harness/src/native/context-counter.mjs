import { createHash } from 'node:crypto';
import { canonical, invariant } from '../../../agentkit-harness-core/dist/index.mjs';
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
  for (const message of (protocol === 'openai-responses' ? wire.input : wire.messages) ?? []) {
    if (Array.isArray(message.content)) message.content.forEach(visit);
    if (message.type === 'function_call_output' && Array.isArray(message.output)) message.output.forEach(visit);
  }
  const count = estimateNativeText(canonical(wire)) + images;
  invariant(Number.isSafeInteger(count) && count >= 0, 'context_counter_overflow');
  return count;
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
    async countRequest(request) {
      request.signal.throwIfAborted();
      const built = buildNativeModelRequest(binding, { ...request, finalizationOnly: false });
      const count = estimateNativeWireInput(JSON.parse(built.body), binding.protocol);
      request.signal.throwIfAborted(); return count;
    },
  }) };
}
