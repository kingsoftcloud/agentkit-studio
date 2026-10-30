// OpenAI Responses wire adapter.
//
// Ports ksadk.studio.model_client._stream_responses / _responses_payload /
// model_request_projection.responses_messages / model_responses_content /
// model_wire_tools.ResponsesToolCalls+ResponsesItems / model_buffered_wire
// (responses branch) / model_wire_snapshot.reconcile_responses_snapshot: one
// HTTP request per attempt over the Responses SSE protocol, with ordered
// output items, partial tool-argument assembly, refusal/usage/error
// normalization, response.completed/incomplete/failed classification, and
// reasoning_content replay sealing. The adapter never retries and never
// executes tools; it emits text/thinking/tool_delta display deltas and
// returns one sealed ModelResult. Kernel policy owns backoff and budgets.
//
// The Responses wire has no separate replay enum: the host profile's
// providerReplayMode is 'none' | 'reasoning_content' | 'anthropic_content'.
// reasoning_content replay (model-replay/v1) is sealed from the wire's
// reasoning items, matching the chat adapter. anthropic_content replay is
// the Anthropic Messages wire's contract: the Responses wire produces no
// anthropic content blocks, so that mode is rejected at build time (an
// explicit, non-silent configuration mismatch) rather than downgraded.
// Reasoning_content replay is sealed but, like the Python source, not
// re-projected onto a subsequent Responses input: responses_messages emits
// no reasoning items in its input array. See delivery evidence for the
// audited gap.

import {
  normalizeResponse, sealUsage, ProtocolError, resolveUrl, boundOutputTokens,
  emptyUsage,
} from './model-normalize.mjs';
import { sealModelReplay } from './model-replay.mjs';
import { validateMediaBlock, MediaError } from './model-media.mjs';
// parseModelJson is the kernel's strict finite JSON parser (rejects duplicate
// object keys and non-finite numbers); using it keeps provider-envelope and
// tool-argument decoding consistent with the kernel's own validation, so a
// malformed provider payload is a terminal protocol error rather than a
// silently-accepted ambiguity.
import { parseModelJson, stringifyModelJson, modelWireToolCall, FINAL_SUBMISSION_TOOL } from '@kingsoftcloud/agentkit-harness-core';

function strictParseJson(text) {
  try { return parseModelJson(text); }
  catch (error) { throw new ProtocolError(error?.code || 'invalid_model_json', 'json_invalid'); }
}

// Body keys the host binding parameters may never override: model, input,
// tools, stream and the security-sensitive transport values belong to the
// adapter, not the binding parameters. instructions is request-owned.
const FORBIDDEN_BODY_KEYS = new Set([
  'model', 'input', 'tools', 'stream', 'tool_choice', 'parallel_tool_calls',
  'max_output_tokens', 'instructions', 'n',
  'previous_response_id', 'conversation', 'background', 'truncation',
  'provider_thinking_display',
  'provider_tool_search',
]);

// Hosted provider effects that must not be silently dropped as client prose.
const HOSTED_ITEM_TYPES = new Set([
  'web_search_call', 'web_search_preview_call', 'file_search_call',
  'code_interpreter_call', 'computer_use_call', 'image_generation_call',
  'mcp_call', 'local_shell_call',
]);

// In-stream error code/type → retryable/terminal classification. A 2xx stream
// that emits an error/response.failed event is a provider rejection, never a
// final; unknown codes stay terminal so a foreign payload cannot become a
// silent retry or final. Mirrors the Anthropic stream classifier and the
// Python provider_error code map.
const RETRYABLE_ERROR_CODES = new Set([
  'rate_limit_error', 'rate_limit_exceeded', 'overloaded_error', 'server_error',
  'api_error', 'service_unavailable_error', 'server_is_overloaded', 'timeout_error',
  'MODEL_PROVIDER_RATE_LIMIT', 'MODEL_PROVIDER_UNAVAILABLE',
]);
const TERMINAL_ERROR_CODES = new Set([
  'invalid_request_error', 'invalid_api_key', 'authentication_error',
  'permission_error', 'not_found_error', 'request_too_large', 'billing_error',
  'insufficient_quota', 'MODEL_PROVIDER_AUTHENTICATION', 'MODEL_PROVIDER_PERMISSION',
  'MODEL_PROVIDER_INVALID_REQUEST', 'MODEL_PROVIDER_NOT_FOUND',
  'MODEL_PROVIDER_QUOTA_EXHAUSTED',
]);

function securityHeaders() {
  return new Set(['authorization', 'x-api-key', 'anthropic-version', 'content-type', 'accept']);
}

// --- wire-shape helpers (ports model_wire_tools._object/_text/_identity/_index) ---

function objectOf(value) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new ProtocolError('invalid model frame', 'envelope_invalid');
  return value;
}

function textOf(value) {
  if (value != null && typeof value !== 'string') throw new ProtocolError('invalid model frame', 'envelope_invalid');
  return value;
}

function identityOf(value) {
  const result = textOf(value);
  if (result == null || !result.trim()) throw new ProtocolError('invalid model frame', 'envelope_invalid');
  return result;
}

function optionalText(value) {
  if (value == null) return '';
  if (typeof value !== 'string') throw new ProtocolError('invalid model frame', 'envelope_invalid');
  return value;
}

function indexOf(event, name, { required = false } = {}) {
  if (!(name in event)) {
    if (required) throw new ProtocolError('invalid model frame', 'envelope_invalid');
    return null;
  }
  const value = event[name];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ProtocolError('invalid model frame', 'envelope_invalid');
  }
  return value;
}

function validateItemKind(kind) {
  if (HOSTED_ITEM_TYPES.has(kind)) throw new ProtocolError('unsupported hosted tool item');
}

// --- binding validation + request build (ports _responses_payload) ---

export function validateResponsesBinding(binding) {
  if (!binding || typeof binding !== 'object') throw new ProtocolError('responses binding missing');
  if (binding.protocol !== 'openai-responses') throw new ProtocolError('binding is not openai-responses');
  if (typeof binding.baseUrl !== 'string' || !binding.baseUrl) throw new ProtocolError('responses binding requires baseUrl');
  if (typeof binding.apiKey !== 'string' || !binding.apiKey) throw new ProtocolError('responses binding requires apiKey');
  if (typeof binding.model !== 'string' || !binding.model.trim()) throw new ProtocolError('responses binding requires model');
  try { new URL(binding.baseUrl); } catch { throw new ProtocolError('responses binding baseUrl is not a URL'); }
}

// Build the Responses request. The adapter controls model, input, stream,
// tools and instructions; binding.parameters may only add generation fields,
// never override the forbidden keys or security-sensitive headers.
export function buildResponsesRequest(binding, request) {
  validateResponsesBinding(binding);
  const profile = request.profile;
  // The Responses wire carries no Anthropic content blocks; an
  // anthropic_content replay profile is an explicit mismatch, rejected here
  // rather than silently downgraded to no replay.
  if (profile && profile.providerReplayMode === 'anthropic_content') {
    throw new ProtocolError('anthropic_content replay requires its declared wire adapter');
  }
  const url = resolveUrl(binding.baseUrl, 'responses');

  const headers = { Accept: profile.streaming === false ? 'application/json' : 'text/event-stream' };
  const skip = securityHeaders();
  for (const [name, value] of Object.entries(binding.headers || {})) {
    if (skip.has(name.toLowerCase())) continue;
    if (typeof value !== 'string') continue;
    headers[name] = value;
  }
  headers['Content-Type'] = 'application/json';
  headers.Authorization = `Bearer ${binding.apiKey}`;

  const { instructions, items } = projectMessagesResponses(request, request.maxInlineImageBytes);
  const payload = {
    model: binding.model,
    input: items,
    stream: profile.streaming ?? true,
    truncation: 'disabled',
  };
  if (instructions) payload.instructions = instructions;
  payload.max_output_tokens = boundOutputTokens(binding.parameters?.max_output_tokens, profile.maxOutputTokens);

  const parameters = binding.parameters || {};
  for (const [key, value] of Object.entries(parameters)) {
    if (FORBIDDEN_BODY_KEYS.has(key)) continue;
    payload[key] = value;
  }
  // A binding that selects the output-limit field must not also carry the
  // adapter-owned default.
  if ('max_output_tokens' in parameters) {
    payload.max_output_tokens = boundOutputTokens(parameters.max_output_tokens, profile.maxOutputTokens);
  }

  // Advertise tools: during a finalization-only turn the kernel has already
  // stripped normal workspace tools, but the adapter filters defensively and
  // keeps the internal submit_final_output tool so the model can submit its
  // final answer. Normal tools are never sent during finalization. Responses
  // tools are flat objects (no nested function envelope); accept both shapes.
  const tools = request.tools || [];
  const advertised = request.finalizationOnly
    ? tools.filter((tool) => tool.name === FINAL_SUBMISSION_TOOL)
    : tools;
  if (advertised.length) {
    payload.tools = advertised.map((tool) => {
      const flat = { type: 'function', name: tool.name, description: tool.description,
                     parameters: tool.parameters || { type: 'object', properties: {} } };
      return flat;
    });
    const choice = request.toolChoice ?? (profile.providerCompatibilityPolicy && request.finalizationOnly
      ? { type: 'function', function: { name: FINAL_SUBMISSION_TOOL } } : 'auto');
    payload.tool_choice = typeof choice === 'string' ? choice : { type: 'function', name: choice.function.name };
    payload.parallel_tool_calls = profile.parallelToolCalls ?? true;
  }
  if (profile.temperature !== undefined) payload.temperature = profile.temperature;
  if (profile.topP !== undefined) payload.top_p = profile.topP;
  if (profile.reasoningEffort !== undefined) payload.reasoning = { ...(payload.reasoning ?? {}), effort: profile.reasoningEffort };

  return { url, headers, body: stringifyModelJson(payload) };
}

// Project host messages onto the Responses input wire. system/developer
// messages are lifted to the top-level `instructions` field; tool receipts
// become function_call_output items; user/assistant content becomes role
// items (input_text/output_text/input_image) and assistant tool calls become
// function_call items. Canonical call-id pairing is enforced: an assistant
// tool batch must be followed by matching function_call_output receipts.
// anthropic_content replay is rejected (the Responses wire carries none).
export function projectMessagesResponses(request, maxInlineImageBytes) {
  const profile = request.profile;
  const instructions = [];
  const items = [];
  const pending = new Set();
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
    // The Responses wire carries no Anthropic content; a cross-wire replay is
    // a configuration error, not a silent drop.
    if (message.providerReplay && message.providerReplay.version === 'model-replay/v2') {
      throw new ProtocolError('anthropic_content replay cannot cross the responses wire');
    }
    if (role === 'system' || role === 'developer') {
      instructions.push(message.content || '');
      continue;
    }
    if (role === 'tool') {
      const media = message.media ? message.media.map((b) => validateMediaBlock(b, maxInlineImageBytes)) : null;
      const output = media && media.length
        ? [{ type: 'input_text', text: message.content || '' }, ...projectMediaResponses(media)]
        : (message.content || '');
      items.push({ type: 'function_call_output', call_id: message.callId, output });
      continue;
    }
    // user / assistant
    const media = message.media ? message.media.map((b) => validateMediaBlock(b, maxInlineImageBytes)) : null;
    if (media && media.length && role !== 'user') {
      throw new MediaError('image observations require user or tool content');
    }
    const parts = [];
    if ((message.content || '').length) {
      parts.push({ type: role === 'assistant' ? 'output_text' : 'input_text', text: message.content });
    }
    if (media && media.length) parts.push(...projectMediaResponses(media));
    // Emit the role/content item only when there is content or no calls, so an
    // assistant tool-only turn does not carry an empty content item.
    if (parts.length || !(message.toolCalls && message.toolCalls.length)) {
      items.push({ role, content: parts });
    }
    if (message.toolCalls && message.toolCalls.length) {
      validateAssistantToolIds(message.toolCalls);
      for (const call of message.toolCalls.map(modelWireToolCall)) {
        items.push({ type: 'function_call', call_id: call.callId, name: call.name,
                     arguments: safeStringifyArguments(call.arguments) });
      }
    }
  }
  if (pending.size) throw new ProtocolError('assistant tool batch is missing receipts');
  return { instructions: instructions.join('\n\n'), items };
}

function safeStringifyArguments(arguments_) {
  if (arguments_ == null || typeof arguments_ !== 'object' || Array.isArray(arguments_)) {
    throw new ProtocolError('invalid historical tool arguments');
  }
  const visit = (value, seen = new Set()) => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'bigint') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (typeof value !== 'object' || seen.has(value)
      || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
      throw new ProtocolError('invalid historical tool arguments');
    }
    seen.add(value);
    for (const entry of Object.values(value)) visit(entry, seen);
    seen.delete(value);
  };
  visit(arguments_);
  try { return stringifyModelJson(arguments_); }
  catch { throw new ProtocolError('invalid historical tool arguments'); }
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

// Project validated media blocks onto the Responses input wire: input_image
// with the bare image_url string and optional detail (no nested object).
function projectMediaResponses(blocks) {
  return blocks.map((b) => {
    const item = { type: 'input_image', image_url: b.image_url.url };
    if (b.image_url.detail != null) item.detail = b.image_url.detail;
    return item;
  });
}

// --- usage (ports model_usage.provider_usage, wire_api="responses") ---

// Parse the Responses usage envelope. Both primary counters (input_tokens,
// output_tokens) must be present for a complete report; an incomplete report
// stays unknown (null), never a fabricated zero-cost claim. All supplied
// fields are validated even in a partial report. input_tokens_details.
// cached_tokens -> cachedInputTokens; output_tokens_details.reasoning_tokens
// -> reasoningTokens.
function parseResponsesUsage(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new ProtocolError('invalid usage report', 'usage_invalid');
  for (const field of ['input_tokens', 'output_tokens', 'total_tokens']) {
    if (Object.hasOwn(value, field)) toNonNegInt(value[field], field);
  }
  const inputDetails = value.input_tokens_details;
  const outputDetails = value.output_tokens_details;
  if (inputDetails != null && (typeof inputDetails !== 'object' || Array.isArray(inputDetails))) {
    throw new ProtocolError('invalid usage details', 'usage_invalid');
  }
  if (outputDetails != null && (typeof outputDetails !== 'object' || Array.isArray(outputDetails))) {
    throw new ProtocolError('invalid usage details', 'usage_invalid');
  }
  const cached = inputDetails && Object.hasOwn(inputDetails, 'cached_tokens')
    ? toNonNegInt(inputDetails.cached_tokens, 'cached_tokens') : undefined;
  const reasoning = outputDetails && Object.hasOwn(outputDetails, 'reasoning_tokens')
    ? toNonNegInt(outputDetails.reasoning_tokens, 'reasoning_tokens') : undefined;
  if (!Object.hasOwn(value, 'input_tokens') || !Object.hasOwn(value, 'output_tokens')) return null;
  const usage = { ...emptyUsage(), inputTokens: value.input_tokens, outputTokens: value.output_tokens };
  if (cached != null) usage.cachedInputTokens = cached;
  if (reasoning != null) usage.reasoningTokens = reasoning;
  return usage;
}

function toNonNegInt(value, field) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ProtocolError(`invalid ${field} counter`, 'usage_invalid');
  }
  return value;
}

// --- buffered output projection (ports model_buffered_wire, responses branch) ---

// Project a complete Responses output array into { finish, content, reasoning,
// calls, refused } for both the buffered 2xx parse and the stream snapshot
// reconcile. The output array carries message/reasoning/function_call items.
function projectResponsesOutput(payload, { status }) {
  if (payload.status != null && payload.status !== status) throw new ProtocolError('invalid model frame', 'envelope_invalid');
  if ('output' in payload && !Array.isArray(payload.output)) throw new ProtocolError('invalid model frame', 'envelope_invalid');
  const output = Array.isArray(payload.output) ? payload.output : [];
  const messages = [];
  const reasoning = [];
  const calls = [];
  let refused = false;
  for (const raw of output) {
    const item = objectOf(raw);
    const kind = identityOf(item.type);
    validateItemKind(kind);
    if ('status' in item) optionalText(item.status);
    if (status === 'completed' && (kind === 'message' || kind === 'function_call')
        && item.status != null && item.status !== 'completed') {
      throw new ProtocolError('invalid model frame', 'envelope_invalid');
    }
    if (kind === 'function_call') {
      calls.push({
        callId: identityOf(item.call_id), name: identityOf(item.name),
        arguments: optionalText(item.arguments), raw: item,
      });
    } else if (kind === 'message') {
      if (item.role != null && item.role !== 'assistant') throw new ProtocolError('invalid model frame', 'envelope_invalid');
      const [text, itemRefused] = responseMessageContent(item.content);
      messages.push(text);
      refused = refused || itemRefused;
    } else if (kind === 'reasoning') {
      reasoning.push(partsText(item.summary, new Set(['summary_text', 'text'])));
      reasoning.push(partsText(item.content, new Set(['reasoning_text', 'text'])));
    }
  }
  const canonical = messages.join('');
  const convenience = optionalText(payload.output_text);
  if ('output' in payload && payload.output_text != null && canonical !== convenience) {
    throw new ProtocolError('invalid model frame', 'envelope_invalid');
  }
  let finish;
  if (status === 'completed') {
    finish = calls.length ? 'tool_calls' : 'stop';
  } else {
    finish = status;
  }
  if (status === 'incomplete') {
    const details = payload.incomplete_details;
    const reason = details != null ? optionalText(objectOf(details).reason) : '';
    if (reason === 'content_filter') finish = 'content_filter';
    else if (reason === 'max_output_tokens' && !calls.length) finish = 'length';
    else finish = 'incomplete';
  }
  if (refused) { finish = 'content_filter'; calls.length = 0; }
  return { finish, content: canonical || convenience, reasoning: reasoning.join(''), calls, refused };
}

// Concatenate output_text/text parts of a message; a refusal part marks the
// message refused (ports model_buffered_wire.response_message_content).
function responseMessageContent(value) {
  if (!Array.isArray(value)) throw new ProtocolError('invalid model frame', 'envelope_invalid');
  const texts = [];
  let refused = false;
  for (const raw of Array.isArray(value) ? value : []) {
    const part = objectOf(raw);
    const kind = identityOf(part.type);
    if (kind === 'output_text' || kind === 'text') {
      texts.push(optionalText(part.text));
    } else if (kind === 'refusal') {
      optionalText(part.refusal);
      refused = true;
    } else {
      throw new ProtocolError('invalid model frame', 'envelope_invalid');
    }
  }
  return [texts.join(''), refused];
}

function partsText(value, types) {
  if (value != null && !Array.isArray(value)) throw new ProtocolError('invalid model frame', 'envelope_invalid');
  const result = [];
  for (const raw of Array.isArray(value) ? value : []) {
    const part = objectOf(raw);
    const kind = identityOf(part.type);
    if (types.has(kind)) result.push(optionalText(part.text));
  }
  return result.join('');
}

// Parse a buffered 2xx Responses body into a sealed result. Used when a 2xx
// response is not SSE (rare for stream:true); also the basis for envelope
// validation. Throws ProtocolError on a malformed envelope or a failed/error
// status (a 2xx body that claims failure is a protocol conflict, terminal).
export function parseResponsesBuffered(bodyText, request, { captureReplay = false, onThinking } = {}) {
  let payload;
  try { payload = strictParseJson(bodyText); } catch { throw new ProtocolError('invalid response json', 'json_invalid'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ProtocolError('invalid response envelope', 'envelope_invalid');
  }
  const status = identityOf(payload.status);
  // A 2xx body that carries an error alongside a purported successful answer,
  // or an explicit failed status, is a protocol conflict, never a final.
  if (payload.error != null) throw new ProtocolError('invalid response envelope', 'envelope_invalid');
  if (status === 'failed') throw new ProtocolError('invalid response envelope', 'envelope_invalid');
  validateBufferedIdentity(payload);
  const reportedUsage = parseResponsesUsage(payload.usage);
  const projection = projectResponsesOutput(payload, { status });
  const calls = projection.calls.map((call) => buildCall(call));
  const normalized = normalizeResponse({
    text: projection.content, toolCalls: calls, finishReason: projection.finish, streamComplete: true,
  });
  const result = sealResult({ normalized, reportedUsage, request, reasoning: projection.reasoning, captureReplay });
  onThinking?.(projection.reasoning);
  return result;
}

function buildCall(buffered) {
  let arguments_;
  let invalid = false;
  try {
    arguments_ = strictParseJson(buffered.arguments || '{}');
    if (arguments_ == null || typeof arguments_ !== 'object' || Array.isArray(arguments_)) throw new Error();
  } catch {
    arguments_ = {}; invalid = true;
  }
  return {
    callId: buffered.callId, name: buffered.name, arguments: arguments_,
    ...(invalid ? { wireArgumentsInvalid: true } : {}),
  };
}

function sealResult({ normalized, reportedUsage, request, reasoning, captureReplay }) {
  const { usage, usageReported } = sealUsage(reportedUsage);
  const result = { ...normalized, usage, usageReported };
  return captureReplay ? sealModelReplay(result, request.profile, reasoning) : result;
}

// Validate the buffered identity: the response id/model cannot change within
// one attempt (ports model_buffered_wire.validate_buffered_identity, responses).
function validateBufferedIdentity(payload) {
  const identity = createWireIdentity();
  identity.accept({ type: 'response.created', response: payload });
}

// --- streaming: shared item slot namespace (ports ResponsesItems) ---

function createResponsesItems() {
  // One shared slot namespace for message, reasoning and function_call items.
  return {
    indexes: new Map(),    // output_index -> item_id
    itemIndexes: new Map(), // item_id -> output_index
    kinds: new Map(),       // item_id -> kind

    pin(event, item, kind = '') {
      const itemId = item != null ? identityOf(item.id) : identityOf(event.item_id);
      if ('item_id' in event && identityOf(event.item_id) !== itemId) throw new ProtocolError('invalid model frame', 'envelope_invalid');
      const index = indexOf(event, 'output_index');
      if (index != null) {
        if (this.indexes.get(index) != null && this.indexes.get(index) !== itemId) throw new ProtocolError('invalid model frame', 'envelope_invalid');
        if (this.itemIndexes.get(itemId) != null && this.itemIndexes.get(itemId) !== index) throw new ProtocolError('invalid model frame', 'envelope_invalid');
        this.indexes.set(index, itemId);
        this.itemIndexes.set(itemId, index);
      }
      if (item != null) kind = identityOf(item.type);
      if (kind) {
        if (this.kinds.has(itemId) && this.kinds.get(itemId) !== kind) throw new ProtocolError('invalid model frame', 'envelope_invalid');
        this.kinds.set(itemId, kind);
      }
      return itemId;
    },
  };
}

// --- streaming: content items (ports model_responses_content.ResponsesContent) ---

const TEXT_KINDS = new Set(['output_text', 'text']);
const DELTA_KINDS = {
  'response.output_text': ['content', 'output_text', 'content_index'],
  'response.refusal': ['content', 'refusal', 'content_index'],
  'response.reasoning_summary_text': ['summary', 'summary_text', 'summary_index'],
  'response.reasoning_text': ['content', 'reasoning_text', 'content_index'],
};

function createContentPart(kind) {
  return { kind, text: '', closed: false };
}

// A content item (message or reasoning) holds indexed parts grouped by
// (group, index). Parts snapshot or accumulate text; closure is validated.
function createResponsesContent(items) {
  const state = {
    items,                                  // shared ResponsesItems
    itemState: new Map(),                   // key -> { kind, parts, closed }
    emittedText: '',
    emittedReasoning: '',
    legacyText: '',
    legacyReasoning: '',
    legacyClosed: new Set(),
    refused: false,

    getItem(event, kind, item) {
      const key = items.pin(event, item, kind);
      if (!this.itemState.has(key)) this.itemState.set(key, { kind, parts: new Map(), closed: false });
      return this.itemState.get(key);
    },

    getPart(item, group, index, kind) {
      const partKey = `${group}\0${index}`;
      const previous = item.parts.get(partKey);
      if (previous != null) {
        if (previous.kind !== kind) throw new ProtocolError('invalid model frame', 'envelope_invalid');
        return previous;
      }
      if (item.closed) throw new ProtocolError('invalid model frame', 'envelope_invalid');
      const part = createContentPart(kind);
      item.parts.set(partKey, part);
      return part;
    },

    partEvent(event, group, kind, indexField, text, { closed, delta = false }) {
      const index = indexOf(event, indexField, { required: true });
      indexOf(event, 'output_index', { required: true });
      const item = this.getItem(event, kind === 'summary_text' || kind === 'reasoning_text'
        ? 'reasoning' : 'message');
      if (delta && item.closed) throw new ProtocolError('invalid model frame', 'envelope_invalid');
      const part = this.getPart(item, group, index, kind);
      if (delta) {
        if (part.closed) throw new ProtocolError('invalid model frame', 'envelope_invalid');
        part.text += text;
      } else {
        this.snapshotPart(part, text, closed);
      }
      this.refused = this.refused || kind === 'refusal';
    },

    snapshotPart(part, text, closed) {
      if ((part.closed && text !== part.text) || !text.startsWith(part.text)) {
        throw new ProtocolError('invalid model frame', 'envelope_invalid');
      }
      part.text = text;
      part.closed = part.closed || closed;
    },

    itemSnapshot(event, { closed }) {
      const raw = objectOf(event.item);
      const kind = identityOf(raw.type);
      if (kind === 'message' && raw.role != null && raw.role !== 'assistant') throw new ProtocolError('invalid model frame', 'envelope_invalid');
      const item = this.getItem(event, kind, raw);
      if (!closed && item.closed) throw new ProtocolError('invalid model frame', 'envelope_invalid');
      const groups = kind === 'message' ? ['content']
        : kind === 'reasoning' ? ['summary', 'content'] : [];
      const seen = new Set();
      for (const group of groups) {
        const values = Object.hasOwn(raw, group) ? raw[group] : [];
        if (!Array.isArray(values)) throw new ProtocolError('invalid model frame', 'envelope_invalid');
        for (let index = 0; index < values.length; index++) {
          const value = objectOf(values[index]);
          let partKind = identityOf(value.type);
          if (kind === 'message' && !TEXT_KINDS.has(partKind) && partKind !== 'refusal') {
            throw new ProtocolError('invalid model frame', 'envelope_invalid');
          }
          if (kind === 'reasoning') {
            const allowed = group === 'summary' ? ['summary_text', 'text'] : ['reasoning_text', 'text'];
            if (!allowed.includes(partKind)) throw new ProtocolError('invalid model frame', 'envelope_invalid');
          }
          // Legacy alias 'text' shares the canonical part type.
          if (partKind === 'text') {
            partKind = kind === 'message' ? 'output_text'
              : group === 'summary' ? 'summary_text' : 'reasoning_text';
          }
          const text = optionalText(value[partKind === 'refusal' ? 'refusal' : 'text']);
          this.getPart(item, group, index, partKind);
          this.snapshotPart(item.parts.get(`${group}\0${index}`), text, closed);
          this.refused = this.refused || partKind === 'refusal';
          seen.add(`${group}\0${index}`);
        }
      }
      if (closed) {
        for (const key of item.parts.keys()) if (!seen.has(key)) throw new ProtocolError('invalid model frame', 'envelope_invalid');
        item.closed = true;
      }
    },

    prefix({ reasoning }) {
      const pieces = [];
      let expected = 0;
      for (const [index, key] of [...this.items.indexes.entries()].sort((a, b) => a[0] - b[0])) {
        if (index !== expected) break;
        expected += 1;
        const kind = this.items.kinds.get(key);
        const wanted = reasoning ? 'reasoning' : 'message';
        if (kind !== wanted) continue;
        const item = this.itemState.get(key);
        if (item == null) break;
        if (reasoning && !item.closed) break;
        const groups = reasoning ? ['summary', 'content'] : ['content'];
        for (const group of groups) {
          let partIndex = 0;
          const parts = [...item.parts.entries()]
            .filter(([pk]) => pk.startsWith(`${group}\0`))
            .sort((a, b) => Number(a[0].split('\0')[1]) - Number(b[0].split('\0')[1]));
          for (const [pk, part] of parts) {
            const i = Number(pk.split('\0')[1]);
            if (i !== partIndex) return pieces.join('');
            partIndex += 1;
            if (part.kind !== 'refusal') pieces.push(part.text);
            if (!part.closed) return pieces.join('');
          }
        }
        if (!item.closed) break;
      }
      return pieces.join('');
    },

    drain() {
      const text = this.prefix({ reasoning: false });
      const reasoning = this.prefix({ reasoning: true });
      if ((text && this.legacyText) || (reasoning && this.legacyReasoning)) {
        throw new ProtocolError('invalid model frame', 'envelope_invalid');
      }
      if (!text.startsWith(this.emittedText) || !reasoning.startsWith(this.emittedReasoning)) {
        throw new ProtocolError('invalid model frame', 'envelope_invalid');
      }
      const tails = [text.slice(this.emittedText.length), reasoning.slice(this.emittedReasoning.length)];
      this.emittedText = text;
      this.emittedReasoning = reasoning;
      return tails;
    },

    accept(event) {
      const type = event.type;
      if (type === 'response.output_item.added' || type === 'response.output_item.done') {
        this.itemSnapshot(event, { closed: type.endsWith('.done') });
      } else if (type === 'response.content_part.added' || type === 'response.content_part.done'
                 || type === 'response.reasoning_summary_part.added'
                 || type === 'response.reasoning_summary_part.done') {
        const part = objectOf(event.part);
        const kind = identityOf(part.type);
        const summary = type.includes('reasoning_summary_part');
        const allowed = summary ? ['summary_text'] : ['output_text', 'refusal', 'reasoning_text'];
        if (!allowed.includes(kind)) throw new ProtocolError('invalid model frame', 'envelope_invalid');
        this.partEvent(event, summary ? 'summary' : 'content', kind,
          summary ? 'summary_index' : 'content_index',
          optionalText(part[kind === 'refusal' ? 'refusal' : 'text']),
          { closed: type.endsWith('.done') });
      } else {
        const stem = type.lastIndexOf('.');
        const head = stem === -1 ? type : type.slice(0, stem);
        const suffix = stem === -1 ? '' : type.slice(stem + 1);
        const spec = DELTA_KINDS[head];
        if (!spec || (suffix !== 'delta' && suffix !== 'done')) return this.drain();
        const [group, kind, indexField] = spec;
        const text = optionalText(event[suffix === 'delta' ? 'delta'
          : kind === 'refusal' ? 'refusal' : 'text']);
        if (!('item_id' in event) && !('output_index' in event) && !(indexField in event)) {
          // Deliberate compatibility for old proxies that omit part identity:
          // unindexed text/reasoning cannot be assigned to an indexed part.
          this.refused = this.refused || kind === 'refusal';
          if (kind === 'refusal') return ['', ''];
          const attr = kind === 'output_text' ? 'legacyText' : 'legacyReasoning';
          const previous = this[attr];
          let tail;
          if (suffix === 'done') {
            if (!text.startsWith(previous) || (this.legacyClosed.has(attr) && text !== previous)) {
              throw new ProtocolError('invalid model frame', 'envelope_invalid');
            }
            tail = text.slice(previous.length);
            this[attr] = text;
            this.legacyClosed.add(attr);
          } else {
            if (this.legacyClosed.has(attr)) throw new ProtocolError('invalid model frame', 'envelope_invalid');
            tail = text;
            this[attr] = previous + text;
          }
          const indexed = attr === 'legacyText' ? this.emittedText : this.emittedReasoning;
          if (indexed) throw new ProtocolError('invalid model frame', 'envelope_invalid');
          return attr === 'legacyText' ? [tail, ''] : ['', tail];
        }
        this.partEvent(event, group, kind, indexField, text,
          { closed: suffix === 'done', delta: suffix === 'delta' });
      }
      return this.drain();
    },

    // Reconcile a terminal `output` array with the observed stream: complete
    // snapshots may fill gaps, never remove or rewrite closed parts.
    reconcileOutput(output) {
      const seen = new Set();
      for (let index = 0; index < output.length; index++) {
        const item = output[index];
        if (!('id' in item) && !this.items.indexes.has(index)) continue;
        const key = identityOf(item.id);
        if (seen.has(key)) throw new ProtocolError('invalid model frame', 'envelope_invalid');
        seen.add(key);
        const kind = item.type;
        if (!this.itemState.has(key) && (
          (kind === 'message' && this.legacyText)
          || (kind === 'reasoning' && this.legacyReasoning))) {
          this.items.pin({ output_index: index }, item);
          continue;
        }
        this.itemSnapshot({ output_index: index, item }, { closed: true });
      }
      for (const key of this.itemState.keys()) if (!seen.has(key)) throw new ProtocolError('invalid model frame', 'envelope_invalid');
      return this.drain();
    },

    finish({ requireClosed = true } = {}) {
      if (requireClosed) {
        for (const item of this.itemState.values()) {
          if ((item.kind === 'message' || item.kind === 'reasoning') && !item.closed) {
            throw new ProtocolError('invalid model frame', 'envelope_invalid');
          }
        }
      }
      const text = this.prefix({ reasoning: false });
      const reasoning = this.prefix({ reasoning: true });
      if (text !== this.emittedText || reasoning !== this.emittedReasoning) {
        throw new ProtocolError('invalid model frame', 'envelope_invalid');
      }
      for (const [key, item] of this.itemState) {
        if ((item.kind === 'message' || item.kind === 'reasoning')
            && !this.items.itemIndexes.has(key)) {
          throw new ProtocolError('invalid model frame', 'envelope_invalid');
        }
      }
      const indexes = [...this.items.indexes.keys()].sort((a, b) => a - b);
      if (indexes.some((index, expected) => index !== expected)) throw new ProtocolError('invalid model frame', 'envelope_invalid');
      for (const [kind, expected] of [['message', this.emittedText], ['reasoning', this.emittedReasoning]]) {
        const pieces = [];
        for (const [, key] of [...this.items.indexes.entries()].sort((a, b) => a[0] - b[0])) {
          const item = this.itemState.get(key);
          if (item == null || item.kind !== kind) continue;
          for (const group of (kind === 'message' ? ['content'] : ['summary', 'content'])) {
            const parts = [...item.parts.entries()]
              .filter(([pk]) => pk.startsWith(`${group}\0`))
              .sort((a, b) => Number(a[0].split('\0')[1]) - Number(b[0].split('\0')[1]));
            for (const [, part] of parts) if (part.kind !== 'refusal') pieces.push(part.text);
          }
        }
        if (pieces.join('') !== expected) throw new ProtocolError('invalid model frame', 'envelope_invalid');
      }
    },
  };
  return state;
}

// --- streaming: tool calls (ports model_wire_tools.ResponsesToolCalls) ---

function createWireTool() {
  return { callId: '', name: '', arguments: '', closed: false, argumentsDone: false };
}

function pinToolIdentity(tool, item, idName) {
  for (const [source, target] of [[idName, 'callId'], ['name', 'name']]) {
    if (!(source in item)) continue;
    const value = identityOf(item[source]);
    if (tool[target] && tool[target] !== value) throw new ProtocolError('invalid model frame', 'envelope_invalid');
    tool[target] = value;
  }
}

function sealTool(tool) {
  identityOf(tool.callId);
  identityOf(tool.name);
  tool.closed = true;
}

function createResponsesToolCalls() {
  const items = createResponsesItems();
  return {
    items,
    calls: new Map(),    // item_id -> WireTool

    key(event, item) {
      return items.pin(event, item, 'function_call');
    },

    accept(event) {
      const type = event.type;
      if (type === 'response.output_item.added' || type === 'response.output_item.done') {
        const item = objectOf(event.item);
        const itemType = identityOf(item.type);
        validateItemKind(itemType);
        items.pin(event, item);
        if (itemType !== 'function_call') return null;
        const key = this.key(event, item);
        let current = this.calls.get(key);
        if (type === 'response.output_item.added') {
          if (current != null) throw new ProtocolError('invalid model frame', 'envelope_invalid');
          current = createWireTool();
          pinToolIdentity(current, item, 'call_id');
          if ('arguments' in item) current.arguments = optionalText(item.arguments);
          this.calls.set(key, current);
          return null;
        }
        // output_item.done: a complete snapshot. Deltas still require a
        // previously declared item, never a fabricated slot.
        if (current == null) {
          current = createWireTool();
          this.calls.set(key, current);
        }
        pinToolIdentity(current, item, 'call_id');
        if ('arguments' in item) {
          const arguments_ = optionalText(item.arguments);
          if (!arguments_.startsWith(current.arguments)
            || (current.closed || current.argumentsDone) && arguments_ !== current.arguments) {
            throw new ProtocolError('invalid model frame', 'envelope_invalid');
          }
          current.arguments = arguments_;
        }
        if (current.closed) return null;
        sealTool(current);
        return current;
      }
      if (type === 'response.function_call_arguments.delta' || type === 'response.function_call_arguments.done') {
        const key = this.key(event);
        const current = this.calls.get(key);
        if (current == null || current.closed || current.argumentsDone) throw new ProtocolError('invalid model frame', 'envelope_invalid');
        if (type.endsWith('.delta')) {
          current.arguments += optionalText(event.delta);
        } else {
          const arguments_ = optionalText(event.arguments);
          if (!arguments_.startsWith(current.arguments)) throw new ProtocolError('invalid model frame', 'envelope_invalid');
          current.arguments = arguments_;
          current.argumentsDone = true;
        }
      }
      return null;
    },

    finish() {
      for (const tool of this.calls.values()) if (!tool.closed) throw new ProtocolError('invalid model frame', 'envelope_invalid');
    },

    // Complete snapshots may fill gaps, never remove or rewrite closed calls.
    reconcileOutput(output) {
      const seen = new Set();
      const completed = [];
      for (let index = 0; index < output.length; index++) {
        const item = output[index];
        if (item.type !== 'function_call') continue;
        const key = identityOf(item.id);
        if (seen.has(key)) throw new ProtocolError('invalid model frame', 'envelope_invalid');
        seen.add(key);
        const current = this.calls.get(key);
        if (current != null && !current.closed && current.arguments) {
          if (!item.arguments.startsWith(current.arguments)) throw new ProtocolError('invalid model frame', 'envelope_invalid');
        }
        const tool = this.accept({ type: 'response.output_item.done', item, output_index: index });
        if (tool != null) completed.push(tool);
      }
      const callsKeys = new Set(this.calls.keys());
      if (callsKeys.size !== seen.size || [...callsKeys].some((k) => !seen.has(k))) {
        throw new ProtocolError('invalid model frame', 'envelope_invalid');
      }
      this.finish();
      return completed;
    },
  };
}

// --- streaming: wire identity (ports model_wire_identity.ModelWireIdentity) ---

function createWireIdentity() {
  return {
    responseId: null,
    model: null,
    pin(field, value) {
      if (value == null) return;
      if (typeof value !== 'string' || !value.trim()) throw new ProtocolError('invalid model frame', 'envelope_invalid');
      if (this[field] != null && this[field] !== value) throw new ProtocolError('invalid model frame', 'envelope_invalid');
      this[field] = value;
    },
    accept(event) {
      if (typeof event !== 'object' || Array.isArray(event)) throw new ProtocolError('invalid model frame', 'envelope_invalid');
      const type = event.type;
      if (typeof type !== 'string' || !type.trim()) throw new ProtocolError('invalid model frame', 'envelope_invalid');
      const response = objectOf(event.response);
      this.pin('responseId', response.id);
      this.pin('responseId', event.response_id);
      this.pin('model', response.model);
      if (type === 'response.output_text.delta' || type === 'response.reasoning_summary_text.delta'
          || type === 'response.reasoning_text.delta' || type === 'response.function_call_arguments.delta'
          || type === 'response.refusal.delta') {
        textOf(event.delta);
      }
    },
  };
}

// --- streaming state (ports _stream_responses) ---

// Assemble a sealed ModelResult from the Responses SSE stream. Frame errors
// throw ProtocolError; finalize preserves the accumulated text/usage and
// classifies the attempt. One terminal event (response.completed/incomplete/
// failed/error/cancelled) seals the attempt.
export function createResponsesStreamState(profile) {
  const captureReplay = profile.providerReplayMode !== 'none';
  const emitThinking = profile.providerThinkingDisplay ?? profile.providerReplayMode !== 'none';
  const toolItems = createResponsesToolCalls();
  const contentItems = createResponsesContent(toolItems.items);
  const identity = createWireIdentity();
  return {
    text: '',
    reasoning: '',
    finish: null,
    usage: null,
    refused: false,
    done: false,
    completed: false,
    streamError: null,      // { kind, failureKind } from an in-stream error
    status: null,           // 'completed' | 'incomplete'

    consume(frame, emit) {
      const data = frame.data;
      if (!data.trim()) return;
      if (data.trim() === '[DONE]') return;  // [DONE] is a transport marker; the
      let event;                             // terminal is response.completed/incomplete.
      try { event = strictParseJson(data); } catch { throw new ProtocolError('invalid stream json', 'json_invalid'); }
      if (!event || typeof event !== 'object' || Array.isArray(event)) {
        throw new ProtocolError('invalid stream envelope', 'envelope_invalid');
      }
      identity.accept(event);
      const type = String(event.type || '');

      if (type === 'error' || type === 'response.failed') {
        this.handleStreamError(event);
        this.done = true;
        return;
      }
      if (type === 'response.cancelled' || type === 'response.canceled') {
        // A provider that cancels mid-stream is a terminal protocol fact, not a
        // user abort and not a retryable incomplete stream.
        this.streamError = { kind: 'provider_terminal_error', failureKind: 'invalid_response' };
        this.done = true;
        return;
      }

      toolItems.accept(event);
      const [text, reasoning] = contentItems.accept(event);
      this.refused = this.refused || contentItems.refused;

      if (type === 'response.completed' || type === 'response.incomplete') {
        this.handleTerminal(event, { text, reasoning }, emit);
        this.done = true;
        return;
      }

      if (text) { this.text += text; emit({ kind: 'text', text }); }
      if (reasoning) {
        this.reasoning += reasoning;
        if (emitThinking) emit({ kind: 'thinking', text: reasoning });
      }
      // Emit display-only tool argument fragments. The sealed batch in the
      // ModelResult is authoritative; this never executes a tool.
      if (type === 'response.function_call_arguments.delta' && event.delta) {
        const index = event.output_index ?? toolItems.items.itemIndexes.get(event.item_id);
        const name = toolItems.calls.get(event.item_id)?.name;
        emit({ kind: 'tool_delta', text: event.delta,
               metadata: { ...(index != null ? { index } : {}), ...(name ? { name } : {}),
                           ...(event.item_id ? { callId: event.item_id } : {}) } });
      }
    },

    handleStreamError(event) {
      // Build the failed body and classify. response.failed carries its own
      // status; a generic error wraps the error/usage.
      let failedBody;
      if (event.type === 'response.failed') {
        failedBody = objectOf(event.response);
        if (failedBody.status != null && failedBody.status !== 'failed') throw new ProtocolError('invalid model frame', 'envelope_invalid');
        failedBody = { ...failedBody, status: 'failed' };
      } else {
        failedBody = { error: event.error != null ? event.error : event, usage: event.usage };
      }
      const usage = parseResponsesUsage(failedBody.usage);
      if (usage != null) this.usage = usage;
      const errorObj = failedBody.error != null && typeof failedBody.error === 'object' ? failedBody.error : {};
      const code = String(errorObj.code || errorObj.type || '');
      let kind; let failureKind;
      if (RETRYABLE_ERROR_CODES.has(code)) {
        kind = 'provider_retryable_error';
        failureKind = code === 'rate_limit_error' || code === 'rate_limit_exceeded' ? 'rate_limit' : 'server_error';
      } else if (TERMINAL_ERROR_CODES.has(code)) {
        kind = 'provider_terminal_error';
        failureKind = 'client_error';
      } else {
        kind = 'provider_terminal_error';
        failureKind = 'invalid_response';
      }
      this.streamError = { kind, failureKind };
    },

    handleTerminal(event, { text: drainText, reasoning: drainReasoning }, emit) {
      const responsePayload = objectOf(event.response);
      this.status = event.type === 'response.completed' ? 'completed' : 'incomplete';
      // A terminal `status` field that disagrees with the event type is a
      // protocol conflict, checked before any metadata-only short-circuit.
      if (responsePayload.status != null && responsePayload.status !== this.status) {
        throw new ProtocolError('invalid model frame', 'envelope_invalid');
      }
      const usageValue = parseResponsesUsage(responsePayload.usage);
      if (usageValue != null) this.usage = usageValue;
      // A successful terminal cannot simultaneously carry an error. In
      // particular, no function_call from that conflicting body may dispatch.
      if (responsePayload.error != null) throw new ProtocolError('invalid model frame', 'envelope_invalid');

      // Reconcile the terminal body with the observed stream. A metadata-only
      // terminal (no output) keeps the streamed text/tools as observed.
      let textTail = '';
      let reasoningTail = '';
      let completedCalls = [];
      const hasOutput = 'output' in responsePayload;
      const hasOutputText = 'output_text' in responsePayload;
      if (hasOutput || hasOutputText) {
        let projection;
        try {
          projection = projectResponsesOutput(responsePayload, { status: this.status });
        } catch { throw new ProtocolError('invalid model frame', 'envelope_invalid'); }
        if (projection.refused) this.refused = true;
        if (!this.refused) {
          if (hasOutput && contentItems) {
            try {
              const [ct, cr] = contentItems.reconcileOutput(responsePayload.output || []);
              textTail = ct; reasoningTail = cr;
            } catch { throw new ProtocolError('invalid model frame', 'envelope_invalid'); }
          }
          // The projection's content must extend the observed text+tail.
          const observedText = this.text + drainText + textTail;
          if (!projection.content.startsWith(observedText)) throw new ProtocolError('invalid model frame', 'envelope_invalid');
          textTail += projection.content.slice(observedText.length);
          if (hasOutput) {
            const observedReasoning = this.reasoning + drainReasoning + reasoningTail;
            if (!projection.reasoning.startsWith(observedReasoning)) throw new ProtocolError('invalid model frame', 'envelope_invalid');
            reasoningTail += projection.reasoning.slice(observedReasoning.length);
          }
          if (hasOutput && this.status === 'completed') {
            try { completedCalls = toolItems.reconcileOutput(responsePayload.output || []); }
            catch { throw new ProtocolError('invalid model frame', 'envelope_invalid'); }
          }
        }
      }

      // Emit the reconciled tails.
      if (textTail) { this.text += drainText + textTail; emit({ kind: 'text', text: drainText + textTail }); }
      else if (drainText) { this.text += drainText; emit({ kind: 'text', text: drainText }); }
      const privateTail = drainReasoning + reasoningTail;
      if (privateTail) {
        this.reasoning += privateTail;
        if (emitThinking) emit({ kind: 'thinking', text: privateTail });
      }

      // Determine the finish reason.
      let finish;
      if (this.refused) {
        finish = 'content_filter';
      } else if (this.status === 'completed') {
        try { toolItems.finish(); contentItems.finish(); } catch { throw new ProtocolError('invalid model frame', 'envelope_invalid'); }
        finish = toolItems.calls.size ? 'tool_calls' : 'stop';
      } else {
        const details = responsePayload.incomplete_details;
        const reason = details != null ? optionalText(objectOf(details).reason) : '';
        if (reason === 'max_output_tokens') {
          try { contentItems.finish({ requireClosed: false }); } catch { throw new ProtocolError('invalid model frame', 'envelope_invalid'); }
        }
        // An unclosed tool input must not grant bounded-text commit authority
        // even when output exhaustion is confirmed.
        const openInput = [...toolItems.calls.values()].some((tool) => !tool.closed);
        if (reason === 'content_filter') finish = 'content_filter';
        else if (reason === 'max_output_tokens' && !openInput) finish = 'length';
        else finish = 'incomplete';
        if (hasOutput && completedCalls.length) finish = 'tool_calls';
      }
      this.finish = finish;
      this.completed = true;
    },

    finalize({ errorKind = null, failureKind = null } = {}) {
      const { usage, usageReported } = sealUsage(this.usage);
      const reasoning = this.reasoning;
      // An in-stream error or a transport error during the attempt seals the
      // observed text with no tools; usage is preserved when reported.
      if (this.streamError) {
        return {
          kind: this.streamError.kind, text: this.text, toolCalls: [], usage, usageReported,
          ...(this.streamError.failureKind ? { failureKind: this.streamError.failureKind } : {}),
        };
      }
      if (errorKind && errorKind !== 'provider_retryable_error') {
        return { kind: errorKind, text: this.text, toolCalls: [], usage, usageReported,
                 ...(failureKind ? { failureKind } : {}) };
      }
      if (errorKind === 'provider_retryable_error' || (!this.done && !this.completed)) {
        const normalized = normalizeResponse({ text: this.text, toolCalls: [], finishReason: this.finish, streamComplete: false });
        if (normalized.kind === 'provider_retryable_error') {
          return { ...normalized, usage, usageReported, failureKind: failureKind || 'incomplete_response' };
        }
        return sealModelReplay({ ...normalized, usage, usageReported }, profile, reasoning);
      }
      // done with a terminal event: assemble the full response.
      const finish = this.refused ? 'content_filter' : this.finish;
      let calls;
      let malformed = false;
      try {
        calls = this.buildCalls();
      } catch {
        malformed = true;
        calls = [{}];
      }
      if (this.refused) { calls = []; }
      const normalized = normalizeResponse({
        text: this.text, toolCalls: malformed ? [{}] : calls,
        finishReason: finish, streamComplete: true,
      });
      return sealModelReplay({ ...normalized, usage, usageReported }, profile, reasoning);
    },

    buildCalls() {
      const calls = [];
      const indexes = [...toolItems.items.indexes.entries()].sort((a, b) => a[0] - b[0]);
      for (const [, key] of indexes) {
        const tool = toolItems.calls.get(key);
        if (!tool) continue;
        if (!tool.closed) throw new ProtocolError('invalid model frame', 'envelope_invalid');
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
      // Reject duplicate call ids in the sealed batch.
      const ids = calls.map((c) => c.callId);
      if (new Set(ids).size !== ids.length) throw new ProtocolError('duplicate tool call ids');
      return calls;
    },
  };
}
