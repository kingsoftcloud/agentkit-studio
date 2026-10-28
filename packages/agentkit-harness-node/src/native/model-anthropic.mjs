// Anthropic Messages wire adapter.
//
// Ports ksadk.studio.model_client._stream_anthropic / model_buffered_wire /
// model_wire_tools / model_request_projection.anthropic_messages: one HTTP
// request per attempt over the Anthropic Messages SSE protocol, with sealed
// content-block termination, signed-thinking + tool_use assembly, usage
// accumulation and refusal normalization. The adapter never retries and never
// executes tools; it emits text/thinking/tool_delta display deltas and returns
// one sealed ModelResult with optional anthropic_content replay.
//
// The signed-thinking signature is private replay material: it is captured for
// the sealed providerReplay but never emitted in a public stream event's
// metadata, and never concatenated to visible text.

import {
  normalizeResponse, parseAnthropicUsageFragment, parseRetryAfterMs,
  ProtocolError, resolveUrl, boundOutputTokens,
} from './model-normalize.mjs';
import { sealAnthropicReplay, anthropicReplayContent, profileFingerprint } from './model-replay.mjs';
import { validateMediaBlock, projectMediaAnthropic, MediaError } from './model-media.mjs';
// parseModelJson is the kernel's strict finite JSON parser (rejects duplicate
// keys and non-finite numbers); using it keeps provider-envelope and tool-input
// decoding consistent with the kernel's own validation.
import { parseModelJson, stringifyModelJson, parseNativeJson, modelWireToolCall, FINAL_SUBMISSION_TOOL } from '@kingsoftcloud/agentkit-harness-core';
import { applyAnthropicThinking, projectProviderToolChoice, resolveProviderCompatibility } from './model-provider-compat.mjs';
import { projectAnthropicPromptCache } from './model-anthropic-cache.mjs';
import {
  anthropicToolEntry, isNativeToolSearch, mergeNativeToolSearchBeta, nativeToolReferenceContent,
} from './model-anthropic-tool-search.mjs';

function strictParseJson(text) {
  try { return parseModelJson(text); }
  catch (error) { throw new ProtocolError(error?.code || 'invalid_model_json'); }
}

const ANTHROPIC_VERSION = '2023-06-01';

const FORBIDDEN_BODY_KEYS = new Set([
  'model', 'messages', 'tools', 'stream', 'system', 'tool_choice', 'max_tokens',
  'provider_thinking_display', 'provider_tool_search',
]);

const CLIENT_ITEM_TYPES = new Set([
  'text', 'thinking', 'redacted_thinking', 'tool_use',
]);

// In-stream error.type → retryable/terminal classification. A 2xx stream that
// emits an error event is a provider rejection, not a final; unknown types
// stay terminal so a foreign payload cannot become a silent retry or final.
const RETRYABLE_ERROR_TYPES = new Set([
  'rate_limit_error', 'overloaded_error', 'api_error', 'service_unavailable_error',
]);
const TERMINAL_ERROR_TYPES = new Set([
  'invalid_request_error', 'authentication_error', 'permission_error', 'not_found_error',
  'request_too_large', 'billing_error',
]);

function securityHeaders() {
  return new Set(['authorization', 'x-api-key', 'anthropic-version', 'content-type', 'accept']);
}

export function validateAnthropicBinding(binding) {
  if (!binding || typeof binding !== 'object') throw new ProtocolError('anthropic binding missing');
  if (binding.protocol !== 'anthropic-messages') throw new ProtocolError('binding is not anthropic-messages');
  if (typeof binding.baseUrl !== 'string' || !binding.baseUrl) throw new ProtocolError('anthropic binding requires baseUrl');
  if (typeof binding.apiKey !== 'string' || !binding.apiKey) throw new ProtocolError('anthropic binding requires apiKey');
  if (typeof binding.model !== 'string' || !binding.model.trim()) throw new ProtocolError('anthropic binding requires model');
  try { new URL(binding.baseUrl); } catch { throw new ProtocolError('anthropic binding baseUrl is not a URL'); }
}

export function buildAnthropicRequest(binding, request) {
  validateAnthropicBinding(binding);
  const profile = request.profile;
  const native = isNativeToolSearch(profile) && !['compaction', 'delivery_review'].includes(request.purpose);
  const url = resolveUrl(binding.baseUrl, 'messages');

  const headers = { Accept: profile.streaming === false ? 'application/json' : 'text/event-stream' };
  const skip = securityHeaders();
  for (const [name, value] of Object.entries(binding.headers || {})) {
    if (skip.has(name.toLowerCase())) continue;
    if (typeof value !== 'string') continue;
    headers[name] = value;
  }
  headers['Content-Type'] = 'application/json';
  headers['x-api-key'] = binding.apiKey;
  headers['anthropic-version'] = ANTHROPIC_VERSION;
  // Preserve a host-selected thinking block-binding beta header if provided.
  const beta = (binding.headers && binding.headers['anthropic-beta']) || binding.headers?.['Anthropic-Beta'];
  if (beta && !('anthropic-beta' in headers)) headers['anthropic-beta'] = beta;

  const { systemParts, items } = projectAnthropicMessages(request, request.maxInlineImageBytes);
  const system = systemParts.join('\n\n');
  const payload = {
    model: binding.model,
    messages: items,
    stream: profile.streaming ?? true,
    max_tokens: boundOutputTokens(binding.parameters?.max_tokens, profile.maxOutputTokens),
  };
  if (system) payload.system = system;

  const parameters = binding.parameters || {};
  for (const [key, value] of Object.entries(parameters)) {
    if (FORBIDDEN_BODY_KEYS.has(key)) continue;
    payload[key] = value;
  }

  // Advertise tools: during a finalization-only turn the kernel has already
  // stripped normal workspace tools, but the adapter filters defensively and
  // keeps the internal submit_final_output tool so the model can submit its
  // final answer. Normal tools are never sent during finalization.
  const tools = request.tools || [];
  const advertised = request.finalizationOnly && profile.toolCatalogPolicy !== 'stable-task/v1' && !native
    ? tools.filter((tool) => tool.name === FINAL_SUBMISSION_TOOL)
    : tools;
  if (advertised.length) {
    payload.tools = advertised.map((tool) => (native ? anthropicToolEntry(tool) : {
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters || { type: 'object', properties: {} },
    }));
    const choice = projectProviderToolChoice(request.toolChoice ?? (profile.providerCompatibilityPolicy && request.finalizationOnly
      && advertised.some(tool => tool.name === FINAL_SUBMISSION_TOOL)
      ? { type: 'function', function: { name: FINAL_SUBMISSION_TOOL } } : 'auto'),
    resolveProviderCompatibility(profile.providerCompatibilityPolicy, binding));
    payload.tool_choice = typeof choice === 'string' ? { type: choice === 'required' ? 'any' : choice }
      : { type: 'tool', name: choice.function.name };
  }
  if (profile.temperature !== undefined) payload.temperature = profile.temperature;
  if (profile.topP !== undefined) payload.top_p = profile.topP;
  if (profile.parallelToolCalls !== undefined && payload.tool_choice) payload.tool_choice.disable_parallel_tool_use = !profile.parallelToolCalls;

  const projected = applyAnthropicThinking(payload, profile, binding);
  if (projected.thinking?.block_binding) {
    const keys = Object.keys(headers).filter(key => key.toLowerCase() === 'anthropic-beta');
    const betas = new Set(keys.flatMap(key => headers[key].split(',').map(value => value.trim()).filter(Boolean)));
    keys.forEach(key => delete headers[key]);
    betas.add('thinking-binding-controls-2026-08-01');
    headers['anthropic-beta'] = [...betas].join(',');
  }
  // Native deferred-tool-search advertises defer_loading; add its beta once,
  // case-insensitive-deduped against any Host-selected betas above.
  if (native) mergeNativeToolSearchBeta(headers);
  return { url, headers, body: stringifyModelJson(projectAnthropicPromptCache(projected, systemParts, request)) };
}

// Project host messages onto the Anthropic Messages wire. System messages are
// lifted to the top-level `system` field; user/assistant alternate (consecutive
// same-role content is concatenated); tool receipts become user tool_result
// blocks. Assistant anthropic_content replay replaces the projected blocks so
// the model sees its signed thinking and tool_use exactly.
export function projectMessagesAnthropic(request, maxInlineImageBytes) {
  const { systemParts, items } = projectAnthropicMessages(request, maxInlineImageBytes);
  return { system: systemParts.join('\n\n'), items };
}

function projectAnthropicMessages(request, maxInlineImageBytes) {
  const profile = request.profile;
  // Summary/review models receive source prose, not task tool capabilities.
  const native = isNativeToolSearch(profile) && !['compaction', 'delivery_review'].includes(request.purpose);
  const systemParts = [];
  const items = [];
  const pending = new Set();
  // Pending call name per receipt callId, so native tool_reference metadata
  // pairs only with a ToolSearch call. The wire id still keys the receipt.
  const pendingNames = new Map();
  const wireIds = new Map();
  const midSystem = profile.anthropicPolicy?.midSystem === true;
  for (const message of request.messages || []) {
    const role = message.role;
    if (native && message.discoveredToolNames !== undefined && role !== 'tool')
      throw new ProtocolError('tool_reference metadata requires a paired tool receipt');
    if (role !== 'tool' && pending.size) throw new ProtocolError('incomplete assistant tool batch before next message');
    if (role === 'assistant' && message.toolCalls?.length) {
      validateAssistantToolIds(message.toolCalls);
      for (const call of message.toolCalls) {
        pending.add(call.callId);
        pendingNames.set(call.callId, modelWireToolCall(call).name);
      }
    }
    let pairedName;
    if (role === 'tool') {
      if (!pending.delete(message.callId)) throw new ProtocolError('tool receipt does not match the pending assistant batch');
      pairedName = pendingNames.get(message.callId);
      pendingNames.delete(message.callId);
    }
    if (role === 'system' || role === 'developer') {
      if (midSystem && items.length) items.push({ role: 'system', content: message.content || '' });
      else systemParts.push(message.content || '');
      continue;
    }
    let item;
    if (role === 'tool') {
      // Native deferred-tool-search: project tool_reference blocks only from
      // kernel-owned discoveredToolNames on a ToolSearch receipt. Undefined
      // (no metadata) or empty names keep the ordinary text/media projection;
      // malformed or unpaired metadata fails preflight rather than widening
      // authority. Non-native policy ignores the metadata entirely.
      const references = native ? nativeToolReferenceContent(message, pairedName, request.tools) : undefined;
      const media = message.media ? message.media.map((b) => validateMediaBlock(b, maxInlineImageBytes)) : null;
      let content;
      if (references) content = [...references, ...(media?.length ? projectMediaAnthropic(media) : [])];
      else if (media && media.length) content = [{ type: 'text', text: message.content || '' }, ...projectMediaAnthropic(media)];
      else content = (message.content || '');
      item = {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: wireIds.get(message.callId) ?? String(message.callId ?? ''),
          content,
        }],
      };
    } else {
      // anthropicReplayContent applies message.replayToolIds to the original
      // tool_use ids and validates the blocks pair exactly with the sealed
      // toolCalls/text; a cross-profile or inconsistent replay is dropped.
      const replayContent = anthropicReplayContent(message, profile);
      let blocks;
      if (replayContent) {
        // Bound replay keeps original provider ids, including signed tool_use blocks.
        if (profile.providerReplayProjectionPolicy === 'anthropic-client-compaction/v1') {
          const originals = message.providerReplay.anthropicContent.filter(block => block?.type === 'tool_use');
          for (const [index, block] of originals.entries()) wireIds.set(message.toolCalls[index].callId, block.id);
          const inverse = new Map([...wireIds].map(([canonical, original]) => [canonical, original]));
          blocks = replayContent.map(block => block?.type === 'tool_use' ? { ...block, id: inverse.get(block.id) ?? block.id } : block);
        } else blocks = replayContent;
      } else {
        blocks = [];
        const media = message.media ? message.media.map((b) => validateMediaBlock(b, maxInlineImageBytes)) : null;
        if ((message.content || '').length) blocks.push({ type: 'text', text: message.content });
        if (media && media.length) {
          if (role !== 'user') throw new MediaError('image observations require user or tool content');
          blocks.push(...projectMediaAnthropic(media));
        }
        if (role === 'assistant' && message.toolCalls && message.toolCalls.length) {
          validateAssistantToolIds(message.toolCalls);
          for (const call of message.toolCalls.map(modelWireToolCall)) {
            blocks.push({ type: 'tool_use', id: call.callId, name: call.name, input: call.arguments || {} });
          }
        }
        if (!blocks.length) blocks.push({ type: 'text', text: '' });
      }
      item = { role, content: blocks };
    }
    const previous = items[items.length - 1];
    if (previous && previous.role === item.role) {
      previous.content = mergeAnthropicContent(previous.content, item.content);
    } else {
      items.push(item);
    }
  }
  if (pending.size) throw new ProtocolError('assistant tool batch is missing receipts');
  if (midSystem) for (let index = 0; index < items.length; index++) {
    if (items[index].role !== 'system') continue;
    if (items[index - 1]?.role !== 'user') throw new ProtocolError('mid-conversation system section must follow user or tool results');
    while (items[index + 1]?.role === 'system') index++;
    if (items[index + 1] && items[index + 1].role !== 'assistant') throw new ProtocolError('mid-conversation system section must precede assistant or end of input');
  }
  return { systemParts, items };
}

function mergeAnthropicContent(first, second) {
  const a = Array.isArray(first) ? first : [{ type: 'text', text: first }];
  const b = Array.isArray(second) ? second : [{ type: 'text', text: second }];
  return [...a, ...b];
}

function validateAssistantToolIds(calls) {
  const ids = [];
  for (const call of calls) {
    const id = String(call?.callId ?? '');
    if (!id.trim()) throw new ProtocolError('assistant tool calls require stable IDs');
    ids.push(id);
  }
  if (new Set(ids).size !== ids.length) throw new ProtocolError('duplicate assistant tool IDs');
}

// Parse a buffered 2xx Anthropic Messages body into a sealed result.
export function parseAnthropicBuffered(bodyText, request, { captureReplay = false, onThinking } = {}) {
  let payload;
  try { payload = strictParseJson(bodyText); } catch { throw new ProtocolError('invalid response json'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ProtocolError('invalid response envelope');
  }
  if ('type' in payload && payload.type !== 'message') throw new ProtocolError('invalid response envelope');
  if ('error' in payload) throw new ProtocolError('invalid response envelope');
  if (typeof payload.stop_sequence !== 'undefined' && payload.stop_sequence !== null && typeof payload.stop_sequence !== 'string') {
    throw new ProtocolError('invalid stop_sequence');
  }
  const blocks = payload.content;
  if (!Array.isArray(blocks)) throw new ProtocolError('anthropic content must be an array');
  let text = '';
  const reasoningBlocks = [];
  const replayBlocks = [];
  const calls = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') throw new ProtocolError('anthropic content requires typed blocks');
    const kind = String(block.type);
    if (!CLIENT_ITEM_TYPES.has(kind)) throw new ProtocolError('unsupported anthropic block type');
    if (kind === 'text') {
      if (typeof block.text !== 'string') throw new ProtocolError('invalid text block');
      text += block.text;
      replayBlocks.push({ ...block });
    } else if (kind === 'thinking') {
      if (typeof block.thinking !== 'string') throw new ProtocolError('invalid thinking block');
      if ('signature' in block && typeof block.signature !== 'string') throw new ProtocolError('invalid thinking signature');
      reasoningBlocks.push(block);
      replayBlocks.push({ ...block });
    } else if (kind === 'redacted_thinking') {
      if (typeof block.data !== 'string') throw new ProtocolError('invalid redacted thinking block');
      replayBlocks.push({ ...block });
    } else if (kind === 'tool_use') {
      if (typeof block.id !== 'string' || !block.id.trim()) throw new ProtocolError('invalid tool block id');
      if (typeof block.name !== 'string' || !block.name.trim()) throw new ProtocolError('invalid tool block name');
      if (block.input == null || typeof block.input !== 'object' || Array.isArray(block.input)) {
        throw new ProtocolError('invalid tool block input');
      }
      calls.push({ callId: block.id, name: block.name, arguments: block.input });
      replayBlocks.push({ ...block });
    }
  }
  let stopReason = payload.stop_reason;
  if (stopReason != null && typeof stopReason !== 'string') throw new ProtocolError('invalid stop_reason');
  if (anthropicRefusal(payload.stop_details)) {
    stopReason = 'refusal';
    calls.length = 0;
  }
  const finish = mapStopReason(stopReason);
  const counters = payload.usage == null ? {} : parseAnthropicUsageFragment(payload.usage);
  const normalized = normalizeResponse({ text, toolCalls: calls, finishReason: finish, streamComplete: true });
  const result = { ...normalized, usage: buildAnthropicUsage(counters), usageReported: hasCompleteUsage(counters) };
  const sealed = captureReplay ? sealAnthropicReplay(result, request.profile, replayBlocks) : result;
  onThinking?.(reasoningBlocks.map(block => block.thinking).join(''));
  return sealed;
}

function mapStopReason(stopReason) {
  return ({
    end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length',
    tool_use: 'tool_calls', refusal: 'content_filter',
  })[stopReason] || stopReason || null;
}

function anthropicRefusal(details) {
  if (details == null) return false;
  if (typeof details !== 'object' || Array.isArray(details) || details.type !== 'refusal') {
    throw new ProtocolError('unsupported model stop details');
  }
  for (const field of ['category', 'explanation']) {
    if (details[field] != null && typeof details[field] !== 'string') {
      throw new ProtocolError('invalid model stop details field');
    }
  }
  return true;
}

// Accumulate Anthropic usage across message_start (input_tokens) and
// message_delta (output_tokens). The state tracks the two counters and a
// pair of primary counters so genuine zeroes stay distinct from a partial report.
function buildAnthropicUsage(state) {
  const inputTokens = (state.inputTokens ?? 0) + (state.cachedInputTokens ?? 0) + (state.cacheCreationInputTokens ?? 0);
  if (!Number.isSafeInteger(inputTokens)) throw new ProtocolError('unsafe inclusive input token counter');
  const usage = {
    inputTokens,
    outputTokens: state.outputTokens ?? 0,
    modelCalls: 0, toolCalls: 0, cost: 0,
  };
  if (state.cachedInputTokens != null) usage.cachedInputTokens = state.cachedInputTokens;
  if (state.cacheCreationInputTokens != null) usage.cacheWriteInputTokens = state.cacheCreationInputTokens;
  if (state.reasoningTokens != null) usage.reasoningTokens = state.reasoningTokens;
  return usage;
}

function hasCompleteUsage(state) {
  return state.inputTokens != null && state.outputTokens != null;
}

function mergeUsage(state, value) {
  const fragment = parseAnthropicUsageFragment(value);
  buildAnthropicUsage({ ...state, ...fragment });
  Object.assign(state, fragment);
}

// Classify an in-stream `error` event into a retryable/terminal result.
export function classifyAnthropicStreamError(errorObj) {
  const type = errorObj && typeof errorObj === 'object' ? String(errorObj.type || '') : '';
  if (RETRYABLE_ERROR_TYPES.has(type)) {
    return { kind: 'provider_retryable_error', failureKind: type === 'rate_limit_error' ? 'rate_limit' : 'server_error' };
  }
  if (TERMINAL_ERROR_TYPES.has(type)) {
    return { kind: 'provider_terminal_error', failureKind: 'client_error' };
  }
  return { kind: 'provider_terminal_error', failureKind: 'invalid_response' };
}

// Streaming state for the Anthropic Messages SSE protocol. Accumulates text,
// thinking (with signatures), an assembled tool batch and usage across
// content_block_* and message_* events. Frame errors throw ProtocolError.
export function createAnthropicStreamState(profile) {
  const captureReplay = profile.providerReplayMode !== 'none';
  const emitThinking = profile.providerThinkingDisplay ?? profile.providerReplayMode !== 'none';
  return {
    text: '',
    reasoning: '',
    blockTypes: new Map(),   // index -> type
    closed: new Set(),       // closed block indexes
    values: new Map(),       // index -> accumulated text/thinking string
    signatures: new Map(),   // index -> accumulated signature (thinking)
    originals: new Map(),     // index -> original content block (for replay)
    tools: new Map(),        // index -> { callId, name, arguments, closed, argumentsDone, initialInput }
    initialInputs: new Set(),
    implicitIndexes: new Set(),
    stopReason: null,
    refused: false,
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    cacheCreationInputTokens: null,
    reasoningTokens: null,
    done: false,
    contentFinished: false,
    model: null,
    responseId: null,

    consume(frame, emit) {
      const data = frame.data;
      if (!data.trim()) return;
      if (data.trim() === '[DONE]') return;
      let event;
      try { event = strictParseJson(data); } catch { throw new ProtocolError('invalid stream json'); }
      if (!event || typeof event !== 'object' || Array.isArray(event)) {
        throw new ProtocolError('invalid stream envelope');
      }
      const type = String(event.type || '');
      if (this.contentFinished && (type === 'content_block_start' || type === 'content_block_delta')) {
        throw new ProtocolError('content after finish reason');
      }
      if (type === 'error') {
        throw Object.assign(new ProtocolError('anthropic stream error'), {
          streamError: classifyAnthropicStreamError(event.error),
        });
      }
      if (type === 'ping') return;
      if (type === 'message_start') this.handleMessageStart(event);
      else if (type === 'content_block_start') this.handleBlockStart(event, emit);
      else if (type === 'content_block_delta') this.handleBlockDelta(event, emit);
      else if (type === 'content_block_stop') this.handleBlockStop(event, emit);
      else if (type === 'message_delta') this.handleMessageDelta(event);
      else if (type === 'message_stop') {
        this.validateFinishedBlocks();
        this.drainContent(emit);
        this.done = true;
        this.contentFinished = true;
      }
      // Unknown event types are ignored: the adapter validates the blocks it
      // assembles rather than rejecting foreign extensions terminally.
    },

    handleMessageStart(event) {
      const message = event.message;
      if (!message || typeof message !== 'object') throw new ProtocolError('invalid message_start');
      const role = message.role;
      if (role != null && role !== 'assistant') throw new ProtocolError('invalid message role');
      this.pinIdentity(message.id, message.model);
      if (message.usage != null) {
        mergeUsage(this, message.usage);
      }
    },

    handleMessageDelta(event) {
      const delta = event.delta;
      if (!delta || typeof delta !== 'object') throw new ProtocolError('invalid message_delta');
      if (delta.stop_reason != null) {
        if (typeof delta.stop_reason !== 'string') throw new ProtocolError('invalid stop_reason');
        if (this.stopReason != null && delta.stop_reason !== this.stopReason) {
          throw new ProtocolError('conflicting stop reasons');
        }
        this.stopReason = delta.stop_reason;
        this.contentFinished = true;
      }
      if (delta.stop_sequence != null && typeof delta.stop_sequence !== 'string') {
        throw new ProtocolError('invalid stop_sequence');
      }
      if (delta.stop_details != null) {
        if (anthropicRefusal(delta.stop_details)) this.refused = true;
      }
      if (event.usage != null) {
        mergeUsage(this, event.usage);
      }
    },

    handleBlockStart(event, emit) {
      const block = event.content_block;
      if (!block || typeof block !== 'object') throw new ProtocolError('invalid content_block');
      const blockType = String(block.type);
      if (!CLIENT_ITEM_TYPES.has(block.type)) {
        if (blockType === 'server_tool_use' || blockType.endsWith('_tool_result')) {
          throw new ProtocolError('unsupported hosted tool block');
        }
        throw new ProtocolError('unsupported content block type');
      }
      const index = event.index;
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
        throw new ProtocolError('invalid block index');
      }
      if (this.blockTypes.has(index) || this.closed.has(index)) {
        throw new ProtocolError('duplicate content block index');
      }
      this.blockTypes.set(index, blockType);
      this.originals.set(index, deepCopy(block));
      for (const field of ['text', 'thinking', 'signature']) {
        if (field in block && typeof block[field] !== 'string') throw new ProtocolError('invalid block field');
      }
      if (blockType === 'text' || blockType === 'thinking') {
        if (block[blockType] != null && typeof block[blockType] !== 'string') {
          throw new ProtocolError(`invalid ${blockType} block`);
        }
        this.values.set(index, String(block[blockType] || ''));
      } else if (blockType === 'redacted_thinking') {
        if (typeof block.data !== 'string') throw new ProtocolError('invalid redacted thinking block');
      } else if (blockType === 'tool_use') {
        const tool = { callId: '', name: '', arguments: '', closed: false, argumentsDone: false, initialInput: false };
        if (block.id != null) {
          if (typeof block.id !== 'string' || !block.id.trim()) throw new ProtocolError('invalid tool block id');
          tool.callId = block.id;
        }
        if (block.name != null) {
          if (typeof block.name !== 'string' || !block.name.trim()) throw new ProtocolError('invalid tool block name');
          tool.name = block.name;
        }
        if ('input' in block) {
          if (block.input == null || typeof block.input !== 'object' || Array.isArray(block.input)) {
            throw new ProtocolError('invalid tool block input');
          }
          // Only a non-empty initial input pins the block; an empty `input: {}`
          // is the usual placeholder and still allows input_json_delta fragments.
          if (Object.keys(block.input).length > 0) {
            tool.arguments = stringifyModelJson(block.input);
            tool.initialInput = true;
            this.initialInputs.add(index);
          }
        }
        this.tools.set(index, tool);
      }
      this.drainContent(emit);
    },

    handleBlockDelta(event, emit) {
      const delta = event.delta;
      if (!delta || typeof delta !== 'object') throw new ProtocolError('invalid content_block_delta');
      const deltaType = String(delta.type);
      let index = event.index;
      if (index == null && deltaType !== 'input_json_delta') index = 0;
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
        throw new ProtocolError('invalid block index');
      }
      if (this.closed.has(index)) throw new ProtocolError('delta after closed block');
      const expected = ({
        text_delta: 'text', thinking_delta: 'thinking', signature_delta: 'thinking',
        citations_delta: 'text', input_json_delta: 'tool_use',
      })[deltaType];
      const previous = this.blockTypes.get(index);
      if (expected != null && previous != null && previous !== expected) {
        throw new ProtocolError('delta type does not match block type');
      }
      if (expected != null && previous == null && (expected === 'text' || expected === 'thinking')) {
        // Legacy proxy omitting block_start: pin the slot from the first delta.
        this.blockTypes.set(index, expected);
        this.implicitIndexes.add(index);
        this.originals.set(index, { type: expected });
        this.values.set(index, '');
      }
      if (deltaType === 'text_delta') {
        if (typeof delta.text !== 'string') throw new ProtocolError('invalid text delta');
        this.values.set(index, (this.values.get(index) || '') + delta.text);
      } else if (deltaType === 'thinking_delta') {
        if (typeof delta.thinking !== 'string') throw new ProtocolError('invalid thinking delta');
        this.values.set(index, (this.values.get(index) || '') + delta.thinking);
      } else if (deltaType === 'signature_delta') {
        if (typeof delta.signature !== 'string') throw new ProtocolError('invalid signature delta');
        const original = this.originals.get(index) || { type: 'thinking' };
        original.signature = (original.signature || '') + delta.signature;
        this.originals.set(index, original);
      } else if (deltaType === 'input_json_delta') {
        if (typeof delta.partial_json !== 'string') throw new ProtocolError('invalid input_json delta');
        const tool = this.tools.get(index);
        if (!tool || this.initialInputs.has(index)) throw new ProtocolError('tool delta without an open block');
        tool.arguments += delta.partial_json;
        if (delta.partial_json) {
          emit({ kind: 'tool_delta', text: delta.partial_json, metadata: { index,
            ...(tool.callId ? { callId: tool.callId } : {}), ...(tool.name ? { name: tool.name } : {}) } });
        }
      } else if (deltaType === 'citations_delta') {
        // Citations attach to text; their content is not visible model text.
      } else {
        throw new ProtocolError('unsupported delta type');
      }
      this.drainContent(emit);
    },

    handleBlockStop(event, emit) {
      const index = event.index;
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
        throw new ProtocolError('invalid block index');
      }
      if (this.closed.has(index) || !this.blockTypes.has(index)) {
        throw new ProtocolError('invalid content_block_stop');
      }
      const tool = this.tools.get(index);
      if (tool) {
        if (!tool.callId.trim() || !tool.name.trim()) throw new ProtocolError('tool block missing identity');
        tool.closed = true;
      }
      this.closed.add(index);
      this.drainContent(emit);
    },

    drainContent(emit) {
      const prefix = (kind) => {
        const pieces = [];
        let expected = 0;
        for (const [index, type] of [...this.blockTypes.entries()].sort((a, b) => a[0] - b[0])) {
          if (index !== expected++) break;
          if (type !== kind) continue;
          pieces.push(this.values.get(index) || '');
          if (!this.closed.has(index)) break;
        }
        return pieces.join('');
      };
      const text = prefix('text');
      const reasoning = prefix('thinking');
      if (!text.startsWith(this.text) || !reasoning.startsWith(this.reasoning)) throw new ProtocolError('non-monotonic content');
      const textDelta = text.slice(this.text.length);
      const thinkingDelta = reasoning.slice(this.reasoning.length);
      this.text = text;
      this.reasoning = reasoning;
      if (textDelta) emit({ kind: 'text', text: textDelta });
      if (thinkingDelta && emitThinking) emit({ kind: 'thinking', text: thinkingDelta });
    },

    validateFinishedBlocks() {
      let expected = 0;
      for (const index of [...this.blockTypes.keys()].sort((a, b) => a - b)) {
        if (index !== expected++) throw new ProtocolError('non-contiguous content block indexes');
        if (!this.closed.has(index) && !this.implicitIndexes.has(index)) throw new ProtocolError('unclosed content block');
      }
      for (const index of this.implicitIndexes) this.closed.add(index);
    },

    finalize({ errorKind = null, failureKind = null } = {}) {
      const usage = buildAnthropicUsage(this);
      const usageReported = hasCompleteUsage(this);
      let finish = this.refused ? 'content_filter' : mapStopReason(this.stopReason);
      if (errorKind && errorKind !== 'provider_retryable_error') {
        return { kind: errorKind, text: this.text, toolCalls: [], usage, usageReported, ...(failureKind ? { failureKind } : {}) };
      }
      if (errorKind === 'provider_retryable_error' || !this.done) {
        const normalized = normalizeResponse({ text: this.text, toolCalls: [], finishReason: finish, streamComplete: false });
        if (normalized.kind === 'provider_retryable_error') {
          return { ...normalized, usage, usageReported, failureKind: failureKind || 'incomplete_response' };
        }
        return this.seal({ ...normalized, usage, usageReported });
      }
      // done, no error: assemble the full response.
      let calls = [];
      let malformed = false;
      try {
        calls = this.buildCalls();
      } catch {
        malformed = true;
        calls = [{}];
      }
      if (this.refused) { finish = 'content_filter'; calls = []; }
      if (!this.text.trim() && !calls.length && finish !== 'content_filter' && !malformed) {
        return { kind: 'empty_response', text: '', toolCalls: [], usage, usageReported };
      }
      const normalized = normalizeResponse({ text: this.text, toolCalls: malformed ? [{}] : calls, finishReason: finish, streamComplete: true });
      return this.seal({ ...normalized, usage, usageReported });
    },

    buildCalls() {
      const calls = [];
      const indexes = [...this.tools.keys()].sort((a, b) => a - b);
      for (const index of indexes) {
        const tool = this.tools.get(index);
        if (!tool.closed) throw new ProtocolError('tool block not closed');
        let arguments_;
        let invalid = false;
        try {
          arguments_ = strictParseJson(tool.arguments || '{}');
          if (arguments_ == null || typeof arguments_ !== 'object' || Array.isArray(arguments_)) throw new Error();
        } catch {
          arguments_ = {}; invalid = true;
        }
        calls.push({
          callId: tool.callId, name: tool.name, arguments: arguments_,
          ...(invalid ? { wireArgumentsInvalid: true } : {}),
        });
      }
      return calls;
    },

    seal(result) {
      if (!captureReplay) return result;
      const replayBlocks = this.replayContent();
      return sealAnthropicReplay(result, profile, replayBlocks);
    },

    // Rebuild the original content blocks (text, signed thinking, tool_use with
    // parsed input) for anthropic_content replay. The order follows block index.
    replayContent() {
      const blocks = [];
      const indexes = [...this.blockTypes.keys()].sort((a, b) => a - b);
      for (const index of indexes) {
        const kind = this.blockTypes.get(index);
        const original = deepCopy(this.originals.get(index) || { type: kind });
        if (kind === 'text') {
          original.text = this.values.get(index) || '';
        } else if (kind === 'thinking') {
          original.thinking = this.values.get(index) || '';
        } else if (kind === 'tool_use') {
          const tool = this.tools.get(index);
          try {
            original.input = strictParseJson(tool.arguments || '{}');
            if (original.input == null || typeof original.input !== 'object' || Array.isArray(original.input)) throw new Error();
          } catch {
            // Invalid JSON has no complete content to replay; retain the block
            // without fabricating original input (mirrors AnthropicContent).
            return null;
          }
        }
        blocks.push(original);
      }
      return blocks;
    },

    pinIdentity(id, model) {
      if (id != null) {
        if (typeof id !== 'string' || !id.trim()) throw new ProtocolError('invalid message id');
        if (this.responseId != null && id !== this.responseId) throw new ProtocolError('mixed message identities');
        this.responseId = id;
      }
      if (model != null) {
        if (typeof model !== 'string' || !model.trim()) throw new ProtocolError('invalid model');
        if (this.model != null && model !== this.model) throw new ProtocolError('mixed model identities');
        this.model = model;
      }
    },
  };
}

function deepCopy(value) {
  if (value == null || typeof value !== 'object') return value;
  return parseNativeJson(stringifyModelJson(value));
}

export { ANTHROPIC_VERSION, parseRetryAfterMs };
