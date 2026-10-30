// OpenAI-compatible chat completions wire adapter.
//
// Ports ksadk.harness.model_adapters.native_openai: one HTTP request per attempt,
// sealed SSE turns with partial-chunk tool assembly, refusal/usage/error
// normalization, and private reasoning_content replay. The adapter never retries
// and never executes tools; it emits text/thinking/tool_delta display deltas and
// returns one sealed ModelResult. Kernel policy owns backoff and call budgets.
//
// Profiled inline reasoning is projected under the Run's frozen policy.

import {
  normalizeResponse, parseOpenAIUsage, sealUsage, ProtocolError, resolveUrl, boundOutputTokens,
} from './model-normalize.mjs';
import { sealModelReplay, openAIReplayFields } from './model-replay.mjs';
import { validateMediaBlock, projectMediaOpenAI, MediaError } from './model-media.mjs';
import { inlineReasoningMarker, projectInlineReasoning, createInlineReasoningProjector } from './model-inline-reasoning.mjs';
import { applyProviderChatCompatibility } from './model-provider-compat.mjs';
import { mergeChatUsage } from './model-chat-usage.mjs';
// parseModelJson is the kernel's strict finite JSON parser: it rejects
// duplicate object keys and non-finite numbers (e.g. 1e400). Using it here keeps
// provider-envelope and tool-argument decoding consistent with the kernel's
// own validation, so a malformed provider payload is a terminal protocol error
// rather than a silently-accepted ambiguity.
import { parseModelJson, stringifyModelJson, modelWireToolCall, FINAL_SUBMISSION_TOOL } from '@kingsoftcloud/agentkit-harness-core';

// Wrap parseModelJson so its NativeError codes become the adapter's ProtocolError.
function strictParseJson(text) {
  try { return parseModelJson(text); }
  catch (error) { throw new ProtocolError(error?.code || 'invalid_model_json', 'json_invalid'); }
}

// Body keys the host binding parameters may never override: messages, tools,
// model and stream are request/adapter owned; the rest are security-sensitive
// transport values that belong to the adapter, not the binding parameters.
const FORBIDDEN_BODY_KEYS = new Set([
  'model', 'messages', 'tools', 'stream', 'n', 'tool_choice', 'parallel_tool_calls', 'max_tokens', 'max_completion_tokens',
  'provider_thinking_display',
  'provider_tool_search',
]);

// Validate the host binding shape before any HTTP attempt.
export function validateOpenAIBinding(binding) {
  if (!binding || typeof binding !== 'object') throw new ProtocolError('openai binding missing');
  if (binding.protocol !== 'openai-chat') throw new ProtocolError('binding is not openai-chat');
  if (typeof binding.baseUrl !== 'string' || !binding.baseUrl) throw new ProtocolError('openai binding requires baseUrl');
  if (typeof binding.apiKey !== 'string' || !binding.apiKey) throw new ProtocolError('openai binding requires apiKey');
  if (typeof binding.model !== 'string' || !binding.model.trim()) throw new ProtocolError('openai binding requires model');
  try { new URL(binding.baseUrl); } catch { throw new ProtocolError('openai binding baseUrl is not a URL'); }
}

function securityHeaders() {
  return new Set(['authorization', 'x-api-key', 'anthropic-version', 'content-type', 'accept']);
}

// Build the chat completions request. The adapter controls model, messages,
// stream and tools; binding.parameters may only add generation fields, never
// override the forbidden keys or security-sensitive headers.
export function buildOpenAIRequest(binding, request) {
  validateOpenAIBinding(binding);
  const profile = request.profile;
  const url = resolveUrl(binding.baseUrl, 'chat/completions');

  const headers = { Accept: profile.streaming === false ? 'application/json' : 'text/event-stream' };
  const skip = securityHeaders();
  for (const [name, value] of Object.entries(binding.headers || {})) {
    if (skip.has(name.toLowerCase())) continue;
    if (typeof value !== 'string') continue;
    headers[name] = value;
  }
  headers['Content-Type'] = 'application/json';
  headers.Authorization = `Bearer ${binding.apiKey}`;

  const payload = {
    model: binding.model,
    messages: projectMessagesOpenAI(request, request.maxInlineImageBytes),
    stream: profile.streaming ?? true,
    n: 1,
  };
  payload.max_tokens = boundOutputTokens(undefined, profile.maxOutputTokens);

  const parameters = binding.parameters || {};
  for (const [key, value] of Object.entries(parameters)) {
    if (FORBIDDEN_BODY_KEYS.has(key)) continue;
    payload[key] = value;
  }
  // max_completion_tokens replaces max_tokens; a binding that selects the newer
  // chat parameter must not send both.
  if (profile.outputTokenParameter === 'max_completion_tokens'
    || profile.outputTokenParameter === undefined && 'max_completion_tokens' in parameters) {
    payload.max_completion_tokens = boundOutputTokens(parameters.max_completion_tokens, profile.maxOutputTokens);
    delete payload.max_tokens;
  } else if ('max_tokens' in parameters) {
    payload.max_tokens = boundOutputTokens(parameters.max_tokens, profile.maxOutputTokens);
  }

  // Advertise tools: during a finalization-only turn the kernel has already
  // stripped normal workspace tools, but the adapter filters defensively and
  // keeps the internal submit_final_output tool so the model can submit its
  // final answer. Normal tools are never sent during finalization.
  const tools = request.tools || [];
  const advertised = request.finalizationOnly
    ? tools.filter((tool) => tool.name === FINAL_SUBMISSION_TOOL)
    : tools;
  if (advertised.length) {
    payload.tools = advertised.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters || { type: 'object', properties: {} } },
    }));
    payload.tool_choice = request.toolChoice ?? (profile.providerCompatibilityPolicy && request.finalizationOnly
      ? { type: 'function', function: { name: FINAL_SUBMISSION_TOOL } } : 'auto');
  }
  if (profile.parallelToolCalls !== undefined) payload.parallel_tool_calls = profile.parallelToolCalls;
  if (profile.temperature !== undefined) payload.temperature = profile.temperature;
  if (profile.topP !== undefined) payload.top_p = profile.topP;
  if (profile.reasoningEffort !== undefined) payload.reasoning_effort = profile.reasoningEffort;
  if (profile.thinkingMode !== undefined) payload.thinking = { type: profile.thinkingMode };
  return { url, headers, body: stringifyModelJson(applyProviderChatCompatibility(payload, request, binding)) };
}

// Project host messages onto the chat wire, admitting media only on user/tool
// content and collecting tool-receipt images into a following user message.
// Assistant tool batches require stable, unique IDs and matching receipts.
// maxInlineImageBytes bounds encoded inline URLs; a cross-profile replay is
// dropped before it reaches the wire.
export function projectMessagesOpenAI(request, maxInlineImageBytes) {
  const profile = request.profile;
  const projected = [];
  const pending = new Set();
  let images = [];
  for (const message of request.messages || []) {
    const role = message.role;
    if (role !== 'tool' && pending.size) {
      throw new ProtocolError('incomplete assistant tool batch before next message');
    }
    if (role === 'assistant' && message.toolCalls && message.toolCalls.length) {
      validateAssistantToolIds(message.toolCalls);
      for (const call of message.toolCalls) pending.add(call.callId);
    }
    if (role === 'tool') {
      if (!pending.has(message.callId)) {
        throw new ProtocolError('tool receipt does not match the pending assistant batch');
      }
      pending.delete(message.callId);
    }
    const media = message.media ? message.media.map((b) => validateMediaBlock(b, maxInlineImageBytes)) : null;
    const hasMedia = media && media.length;
    if (hasMedia && role !== 'user' && role !== 'tool') {
      throw new MediaError('image observations require user or tool content');
    }
    if (hasMedia && role === 'tool') {
      const text = message.content || 'Image observation follows the tool batch.';
      projected.push({ role: 'tool', tool_call_id: message.callId, content: text });
      images.push(
        { type: 'text', text: `Image observation for tool call ${message.callId}:` },
        ...projectMediaOpenAI(media),
      );
    } else if (hasMedia && role === 'user') {
      projected.push({
        role: 'user',
        content: [{ type: 'text', text: message.content || '' }, ...projectMediaOpenAI(media)],
      });
    } else if (role === 'assistant') {
      const msg = { role: 'assistant', content: message.content || '' };
      if (message.toolCalls && message.toolCalls.length) {
        msg.tool_calls = message.toolCalls.map(modelWireToolCall).map((call) => ({
          id: call.callId, type: 'function',
          function: { name: call.name, arguments: safeStringifyArguments(call.arguments) },
        }));
      }
      Object.assign(msg, openAIReplayFields(message, profile));
      projected.push(msg);
    } else if (role === 'tool') {
      projected.push({ role: 'tool', tool_call_id: message.callId, content: message.content || '' });
    } else {
      projected.push({ role, content: message.content || '' });
    }
    if (role === 'tool' && pending.size === 0 && images.length) {
      projected.push({ role: 'user', content: images });
      images = [];
    }
  }
  if (pending.size) throw new ProtocolError('assistant tool batch is missing receipts');
  return projected;
}

function safeStringifyArguments(arguments_) {
  if (arguments_ == null || typeof arguments_ !== 'object') return '{}';
  try { return stringifyModelJson(arguments_); } catch { return '{}'; }
}

function validateAssistantToolIds(calls) {
  const ids = [];
  for (const call of calls) {
    const id = String(call?.callId ?? '');
    if (!id.trim()) throw new ProtocolError('assistant tool calls require stable IDs');
    ids.push(id);
  }
  if (new Set(ids).size !== ids.length) {
    throw new ProtocolError('duplicate assistant tool IDs');
  }
}

// Parse a buffered 2xx chat completions body into a sealed result. Used when a
// 2xx response is not SSE (rare for stream:true); also the basis for envelope
// validation. Throws ProtocolError on a malformed envelope.
export function parseOpenAIBuffered(bodyText, request, { captureReplay = false, binding, onThinking } = {}) {
  let payload;
  try { payload = strictParseJson(bodyText); } catch { throw new ProtocolError('invalid response json', 'json_invalid'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ProtocolError('invalid response envelope', 'envelope_invalid');
  }
  if ('error' in payload) throw new ProtocolError('invalid response envelope', 'provider_error');
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length > 1) {
    throw new ProtocolError('expected one completion choice', 'choice_invalid');
  }
  // parseOpenAIUsage returns null when no usage was reported; an invalid report
  // throws a protocol error (terminal), never a fabricated zero-cost claim.
  const reportedUsage = parseOpenAIUsage(payload.usage);
  if (!choices.length) {
    return finalizeResult({ kind: 'empty_response', text: '', toolCalls: [], reportedUsage, request, reasoning: '', captureReplay });
  }
  const choice = choices[0];
  if (!choice || typeof choice !== 'object') throw new ProtocolError('invalid completion choice', 'choice_invalid');
  let finish = choice.finish_reason;
  if (finish != null && typeof finish !== 'string') throw new ProtocolError('invalid finish reason', 'termination_conflict');
  const message = choice.message;
  if (!message || typeof message !== 'object' || message.role !== 'assistant') {
    throw new ProtocolError('invalid assistant message');
  }
  if (chatRefusal(message.refusal)) finish = 'content_filter';
  let text = message.content;
  if (text == null) text = '';
  if (typeof text !== 'string') throw new ProtocolError('unsupported assistant content');
  text = projectInlineReasoning(text, inlineReasoningMarker(request.profile.inlineReasoningPolicy, binding), request.profile.inlineReasoningPolicy);
  let calls;
  // tool_calls truthiness mirrors Python: an empty array carries no calls.
  const rawCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  try {
    calls = parseToolCalls(message.tool_calls);
    // A legacy function_call envelope is an unsupported, half-built batch: the
    // normalizer owns precedence, so it becomes malformed_tool_call, not terminal.
    if ('function_call' in message) throw new ProtocolError('legacy function_call protocol is not supported');
  } catch {
    // length/content_filter still wins over a half-built tool batch below.
    calls = [{}];
  }
  if (finish == null && (text.trim() || rawCalls || calls.length)) {
    return finalizeResult({
      kind: 'provider_retryable_error', text, toolCalls: [], reportedUsage, request,
      failureKind: 'incomplete_response', reasoning: '', captureReplay,
    });
  }
  const reasoning = captureReplay || onThinking ? chatReasoning(message) : '';
  const result = finalizeResult({
    kind: null, text, toolCalls: calls, reportedUsage, request, finishReason: finish,
    streamComplete: true, reasoning, captureReplay,
  });
  onThinking?.(reasoning);
  return result;
}

function finalizeResult({
  kind, text, toolCalls, reportedUsage, request, finishReason = null, streamComplete = true,
  failureKind = null, retryAfterMs = null, reasoning = '', captureReplay = false,
}) {
  const { usage, usageReported } = sealUsage(reportedUsage);
  if (kind) {
    return {
      kind, text, toolCalls, usage, usageReported,
      ...(failureKind ? { failureKind } : {}),
      ...(retryAfterMs != null ? { retryAfterMs } : {}),
    };
  }
  const normalized = normalizeResponse({ text, toolCalls, finishReason, streamComplete });
  const result = {
    ...normalized, usage, usageReported,
    ...(normalized.kind === 'provider_retryable_error' && failureKind ? { failureKind } : {}),
    ...(retryAfterMs != null ? { retryAfterMs } : {}),
  };
  return captureReplay ? sealModelReplay(result, request.profile, reasoning) : result;
}

// Assemble a tool batch from accumulated stream fragments. Invalid argument
// JSON becomes a non-executable call (arguments={}, wireArgumentsInvalid);
// a bad envelope throws and the caller marks the whole batch malformed.
function parseToolCalls(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new ProtocolError('tool_calls must be an array');
  const calls = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || entry.type !== 'function') {
      throw new ProtocolError('unsupported tool call envelope');
    }
    const fn = entry.function;
    if (!fn || typeof fn !== 'object' || typeof fn.arguments !== 'string') {
      throw new ProtocolError('function arguments must be encoded JSON');
    }
    let arguments_;
    let invalid = false;
    try {
      arguments_ = strictParseJson(fn.arguments);
      if (arguments_ == null || typeof arguments_ !== 'object' || Array.isArray(arguments_)) throw new Error();
    } catch {
      // Invalid or non-finite argument bytes become a non-executable tool call:
      // arguments={} with wireArgumentsInvalid=true. The kernel rejects
      // execution and emits one bounded tool-error receipt; the flag is never
      // silently cleared here.
      arguments_ = {}; invalid = true;
    }
    calls.push({
      callId: entry.id != null ? String(entry.id) : '',
      name: fn.name != null ? String(fn.name) : '',
      arguments: arguments_,
      ...(invalid ? { wireArgumentsInvalid: true } : {}),
    });
  }
  return calls;
}

function chatRefusal(value) {
  if (value == null) return false;
  if (typeof value !== 'string') throw new ProtocolError('invalid model refusal field', 'delta_invalid');
  return value.length > 0;
}

function chatReasoning(message) {
  const native = message.reasoning_content;
  const alias = message.reasoning;
  for (const value of [native, alias]) {
    if (value != null && typeof value !== 'string') throw new ProtocolError('invalid private reasoning field', 'delta_invalid');
  }
  if (native && alias && native !== alias) throw new ProtocolError('conflicting private reasoning fields', 'delta_invalid');
  return native || alias || '';
}

// Streaming turn state: accumulates visible text, private reasoning, an
// assembled tool batch and reported usage across SSE frames. Mirrors
// ksadk._StreamTurn. Frame errors throw ProtocolError; finalize preserves the
// accumulated text/usage and classifies the attempt.
export function createOpenAIStreamTurn(profile, binding) {
  const captureReplay = profile.providerReplayMode !== 'none';
  const emitThinking = profile.providerThinkingDisplay ?? profile.providerReplayMode !== 'none';
  const marker = inlineReasoningMarker(profile.inlineReasoningPolicy, binding);
  const projector = createInlineReasoningProjector(marker, profile.inlineReasoningPolicy);
  let emitContent;
  return {
    text: '',
    reasoning: '',
    finish: null,
    usage: null,
    usageFrameIndex: null,
    usageFinalized: false,
    usageAtFinish: false,
    frameIndex: -1,
    completionId: null,
    tools: new Map(),
    malformedTools: false,
    refused: false,
    done: false,

    consume(frame, emit) {
      this.frameIndex++;
      emitContent = emit;
      const data = frame.data;
      if (data.trim() === '[DONE]') { this.done = true; return; }
      let payload;
      try { payload = strictParseJson(data); } catch { throw new ProtocolError('invalid stream json', 'json_invalid'); }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new ProtocolError('invalid stream envelope', 'envelope_invalid');
      }
      if ('error' in payload) throw new ProtocolError('invalid stream envelope', 'provider_error');
      if (payload.id != null) {
        if (typeof payload.id !== 'string' || !payload.id) throw new ProtocolError('invalid completion ID', 'identity_conflict');
        if (this.completionId != null && payload.id !== this.completionId) {
          throw new ProtocolError('stream mixed completion identities', 'identity_conflict');
        }
        this.completionId = payload.id;
      }
      const reported = parseOpenAIUsage(payload.usage);
      if (reported != null) {
        let next;
        try { next = mergeChatUsage(this.usage, reported, profile.chatUsagePolicy, this.usageFinalized); }
        catch (error) {
          if (error.code !== 'usage_conflict') throw error;
          this.usageConflict = { previousFrameIndex: this.usageFrameIndex,
            previous: usageCounters(this.usage), reported: usageCounters(reported) };
          throw error;
        }
        this.usage = next;
        this.usageFrameIndex = this.frameIndex;
      }
      const choices = payload.choices;
      if (!Array.isArray(choices) || choices.length > 1) throw new ProtocolError('stream requires one choice', 'choice_invalid');
      if (!choices.length) {
        if (reported && this.finish != null) { this.usageFinalized = true; this.usageAtFinish = true; }
        return;
      }
      const choice = choices[0];
      if (!choice || typeof choice !== 'object' || typeof choice.index !== 'number' || choice.index !== 0 || 'message' in choice) {
        throw new ProtocolError('snapshot or alternate choice cannot be merged into a delta stream', 'choice_invalid');
      }
      let delta = choice.delta;
      if (delta == null) delta = {};
      if (typeof delta !== 'object' || Array.isArray(delta)) throw new ProtocolError('invalid stream delta', 'delta_invalid');
      if (delta.role != null && delta.role !== 'assistant') {
        throw new ProtocolError('invalid stream delta', 'delta_invalid');
      }
      const refusal = chatRefusal(delta.refusal);
      if (this.finish != null && refusal) throw new ProtocolError('refusal continued after finish', 'termination_conflict');
      this.refused = refusal || this.refused;
      let content = delta.content;
      if (content == null) content = '';
      if (typeof content !== 'string') throw new ProtocolError('invalid visible content delta', 'delta_invalid');
      const reasoning = chatReasoning(delta);
      if (this.finish != null && reasoning) throw new ProtocolError('private reasoning continued after finish', 'termination_conflict');
      if (captureReplay) this.reasoning += reasoning;
      if (this.finish != null && (content || delta.tool_calls)) {
        throw new ProtocolError('content continued after finish', 'termination_conflict');
      }
      const finish = choice.finish_reason;
      if (finish != null) {
        if (typeof finish !== 'string' || (this.finish != null && finish !== this.finish)) {
          throw new ProtocolError('conflicting finish reasons', 'termination_conflict');
        }
        this.finish = finish;
        if (reported) this.usageAtFinish = true;
      }
      this.text += content;
      const publicContent = projector.push(content);
      if (publicContent) emit({ kind: 'text', text: publicContent });
      if (reasoning && emitThinking) emit({ kind: 'thinking', text: reasoning });
      try {
        if ('function_call' in delta) throw new ProtocolError('legacy function calls are unsupported');
        this.addToolFragments(delta.tool_calls, emit);
      } catch {
        this.malformedTools = true;
      }
    },

    addToolFragments(fragments, emit) {
      if (fragments == null) return;
      if (!Array.isArray(fragments)) throw new ProtocolError('tool deltas require a list');
      for (const fragment of fragments) {
        if (!fragment || typeof fragment !== 'object' || typeof fragment.index !== 'number' || fragment.index < 0) {
          throw new ProtocolError('invalid tool fragment index');
        }
        const call = this.tools.get(fragment.index) || { id: null, type: null, function: { name: '', arguments: '' } };
        for (const field of ['id', 'type']) {
          if (field in fragment) {
            const value = fragment[field];
            // Some OpenAI-compatible SSE providers emit null for unchanged
            // identity fields in later fragments. Only non-null deltas can
            // establish or conflict with the original tool identity.
            if (value == null) continue;
            if (typeof value !== 'string' || !value || (call[field] != null && call[field] !== value)) {
              throw new ProtocolError('conflicting tool identity', 'identity_conflict');
            }
            call[field] = value;
          }
        }
        const fn = fragment.function;
        if (fn != null) {
          if (typeof fn !== 'object' || Array.isArray(fn)) throw new ProtocolError('invalid function delta');
          for (const field of ['name', 'arguments']) {
            if (field in fn) {
              if (fn[field] == null) continue;
              if (typeof fn[field] !== 'string') throw new ProtocolError('function fragment must be text');
              call.function[field] += fn[field];
            }
          }
        }
        if (!this.tools.has(fragment.index)) this.tools.set(fragment.index, call);
        // Emit a display-only tool_delta for the argument fragment. The sealed
        // batch in ModelResult is authoritative; this never executes a tool.
        if (fn && 'arguments' in fn && typeof fn.arguments === 'string' && fn.arguments) {
          emit({ kind: 'tool_delta', text: fn.arguments, metadata: { index: fragment.index,
            ...(call.id ? { callId: call.id } : {}), ...(call.function.name ? { name: call.function.name } : {}) } });
        }
      }
    },

    finalize({ errorKind = null, failureKind = null } = {}) {
      const result = this.rawResult({ errorKind, failureKind });
      if (!['provider_retryable_error', 'provider_terminal_error'].includes(result.kind)) {
        const tail = projector.seal();
        if (tail) emitContent?.({ kind: 'text', text: tail });
      }
      const text = projectInlineReasoning(result.text, marker, profile.inlineReasoningPolicy);
      return text === result.text ? result : { ...result, text,
        ...(result.outputBoundary === 'assistant-text/v1' && !text.trim() ? { outputBoundary: 'no-visible-output/v1' } : {}),
        kind: result.kind === 'final_candidate' && !text.trim() ? 'empty_response' : result.kind };
    },

    rawResult({ errorKind = null, failureKind = null } = {}) {
      const finish = this.refused ? 'content_filter' : this.finish;
      const { usage, usageReported: observedUsage } = sealUsage(this.usage);
      const usageReported = observedUsage && (profile.chatUsagePolicy === undefined
        || this.usageAtFinish && !this.usageConflict);
      if (errorKind && errorKind !== 'provider_retryable_error') {
        return {
          kind: errorKind, text: this.text, toolCalls: [], usage, usageReported,
          ...(failureKind ? { failureKind } : {}),
        };
      }
      if (errorKind === 'provider_retryable_error' || !this.done) {
        const normalized = normalizeResponse({ text: this.text, toolCalls: [], finishReason: finish, streamComplete: false });
        if (normalized.kind === 'provider_retryable_error') {
          return { ...normalized, usage, usageReported, failureKind: failureKind || 'incomplete_response' };
        }
        return sealModelReplay({ ...normalized, usage, usageReported }, profile, this.reasoning);
      }
      // done with no error
      if (!this.refused && this.finish == null && (this.text.trim() || this.tools.size || this.malformedTools)) {
        return {
          kind: 'provider_retryable_error', text: this.text, toolCalls: [],
          usage, usageReported, failureKind: 'incomplete_response',
        };
      }
      let calls;
      try {
        if (this.malformedTools) throw new ProtocolError('malformed tool fragments');
        calls = this.buildCalls();
      } catch {
        calls = [{}];
      }
      const normalized = normalizeResponse({ text: this.text, toolCalls: calls, finishReason: finish, streamComplete: true });
      return sealModelReplay({ ...normalized, usage, usageReported }, profile, this.reasoning);
    },

    buildCalls() {
      const calls = [];
      const indexes = [...this.tools.keys()].sort((a, b) => a - b);
      for (const index of indexes) {
        const tool = this.tools.get(index);
        if (tool.type !== 'function') throw new ProtocolError('tool type must be function');
        let arguments_;
        let invalid = false;
        try {
          arguments_ = strictParseJson(tool.function.arguments);
          if (arguments_ == null || typeof arguments_ !== 'object' || Array.isArray(arguments_)) throw new Error();
        } catch {
          arguments_ = {}; invalid = true;
        }
        calls.push({
          callId: tool.id != null ? String(tool.id) : '',
          name: tool.function.name || '',
          arguments: arguments_,
          ...(invalid ? { wireArgumentsInvalid: true } : {}),
        });
      }
      return calls;
    },
  };
}

// Copy only validated numeric facts, never the provider envelope or its text.
function usageCounters(usage) {
  return Object.fromEntries(['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningTokens']
    .filter(key => Object.hasOwn(usage, key)).map(key => [key, usage[key]]));
}
