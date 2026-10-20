// Shared, protocol-neutral normalization for the native model adapter.
//
// The host kernel owns retry/backoff policy and call budgets. This module only
// classifies one sealed attempt: it maps a provider finish reason, visible text
// and an assembled tool batch to the ModelResult.kind contract. It never invents
// a finish from partial transport, and never authorizes tool execution.
//
// Provider error bodies, credentials and exception text never cross this
// boundary: only the sanitized failureKind string leaves the adapter.

export const emptyUsage = () => ({
  inputTokens: 0, outputTokens: 0, modelCalls: 0, toolCalls: 0, cost: 0,
});

// Canonical finish-reason sets, mirroring ksadk.harness.native.model. A missing
// finish reason stays unknown; a stream that never observed protocol completion
// is retryable, never a silent final.
const USER_ABORTS = new Set(['user_abort', 'canceled', 'cancelled']);
const POLICY_ABORTS = new Set(['policy_abort', 'content_filter']);
const CONTEXT_LIMITS = new Set(['context_overflow', 'context_length_exceeded']);
const OUTPUT_LIMITS = new Set([
  'output_limit', 'length', 'max_tokens', 'max_output_tokens', 'incomplete',
]);
const TOOL_FINISHES = new Set(['tool_calls', 'tool_use']);
const COMPLETE_FINISHES = new Set([
  null, 'stop', 'end_turn', 'completed', 'final_candidate', ...TOOL_FINISHES,
]);

/**
 * Classify one sealed attempt into a ModelResult.kind with validated tool calls.
 *
 * `streamComplete` means the adapter observed protocol completion (a real
 * terminal: [DONE], message_stop, or a buffered 2xx body), not just socket EOF.
 * Partial tool payloads never reach toolCalls; the caller keeps raw evidence for
 * repair separately. Tool calls with undecodable argument bytes keep their
 * identity but carry arguments={} and a non-contract `wireArgumentsInvalid`
 * flag so the kernel can emit one bounded tool-error receipt without executing.
 */
export function normalizeResponse({
  text = '', toolCalls = [], finishReason = null, streamComplete = true,
} = {}) {
  const out = (kind, calls = []) => ({ kind, text, toolCalls: calls });

  if (USER_ABORTS.has(finishReason)) return out('user_abort');
  if (POLICY_ABORTS.has(finishReason)) return out('policy_abort');
  if (CONTEXT_LIMITS.has(finishReason)) return out('context_overflow');
  if (OUTPUT_LIMITS.has(finishReason)) return out('output_limit');
  if (finishReason === 'provider_terminal_error') return out('provider_terminal_error');
  if (!streamComplete || finishReason === 'provider_retryable_error') {
    return out('provider_retryable_error');
  }
  if (finishReason === 'malformed_tool_call') return out('malformed_tool_call');
  if (finishReason === 'empty_response') return out('empty_response');
  if (!COMPLETE_FINISHES.has(finishReason)) return out('provider_terminal_error');

  let calls;
  try {
    calls = toolCalls.map(validateToolCall);
  } catch {
    return out('malformed_tool_call');
  }
  if (calls.length) {
    const ids = calls.map((c) => c.callId);
    if (new Set(ids).size !== ids.length) return out('malformed_tool_call');
    return out('tool_calls', calls);
  }
  if (TOOL_FINISHES.has(finishReason)) return out('malformed_tool_call');
  return out(text.trim() ? 'final_candidate' : 'empty_response');
}

// Validate a single assembled tool call. Throws on a malformed identity or
// shape; a call with wireArgumentsInvalid keeps arguments={} and passes.
function validateToolCall(call) {
  if (!call || typeof call !== 'object') throw new Error('invalid tool call');
  const callId = String(call.callId ?? '');
  const name = String(call.name ?? '');
  if (!callId.trim() || !name.trim()) throw new Error('tool call identity blank');
  const arguments_ = call.wireArgumentsInvalid ? {} : call.arguments;
  if (arguments_ == null || typeof arguments_ !== 'object' || Array.isArray(arguments_)) {
    throw new Error('tool arguments must be an object');
  }
  return { callId, name, arguments: arguments_, ...(call.wireArgumentsInvalid ? { wireArgumentsInvalid: true } : {}) };
}

// Parse the OpenAI chat usage envelope. Both primary counters must be present;
// an incomplete report is a protocol error, not fabricated zero usage. Returns
// null when no usage was reported. Details are optional.
export function parseOpenAIUsage(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolError('invalid usage report');
  }
  if (Object.keys(value).length === 0) return null;
  if (value.prompt_tokens == null || value.completion_tokens == null) {
    throw new ProtocolError('incomplete usage report');
  }
  const inputTokens = toNonNegInt(value.prompt_tokens, 'prompt_tokens');
  const outputTokens = toNonNegInt(value.completion_tokens, 'completion_tokens');
  const details = value.prompt_tokens_details;
  const completionDetails = value.completion_tokens_details;
  if (details != null && (typeof details !== 'object' || Array.isArray(details))) {
    throw new ProtocolError('invalid usage details');
  }
  if (completionDetails != null && (typeof completionDetails !== 'object' || Array.isArray(completionDetails))) {
    throw new ProtocolError('invalid usage details');
  }
  return { ...emptyUsage(), inputTokens, outputTokens };
}

// Parse an Anthropic usage fragment (message_start or message_delta). Both
// counters are accumulated across the stream; the accumulator reports null when
// no usage event was observed. See model-anthropic.mjs for the accumulator.
export function parseAnthropicUsageFragment(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolError('invalid anthropic usage');
  }
  const fragment = {};
  if (value.input_tokens != null) {
    fragment.inputTokens = toNonNegInt(value.input_tokens, 'input_tokens');
  }
  if (value.output_tokens != null) {
    fragment.outputTokens = toNonNegInt(value.output_tokens, 'output_tokens');
  }
  return fragment;
}

function toNonNegInt(value, field) {
  // Reject NaN/-0/booleans/strings; the provider must report genuine integers.
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ProtocolError(`invalid ${field} counter`);
  }
  return value;
}

// Parse a Retry-After header into milliseconds. Accepts delta-seconds or an
// HTTP-date. Non-finite, negative or malformed values yield null (the kernel
// applies its own cooldown; a bad header is not a scheduler instruction).
export function parseRetryAfterMs(headerValue) {
  if (headerValue == null || headerValue === '') return null;
  const trimmed = String(headerValue).trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
    return null;
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return null;
  const delta = parsed - Date.now();
  return Number.isFinite(delta) && delta >= 0 ? Math.round(delta) : null;
}

// Typed protocol error: a fixed, credential-free classification. The adapter
// translates these to provider_terminal_error with failureKind 'invalid_response'
// (or retryable for transport/idle). Provider bytes never enter the message.
export class ProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProtocolError';
  }
}

// Resolve a request URL from the host binding's baseUrl and a wire path suffix.
// If baseUrl already ends with the suffix path, it is used as-is; otherwise the
// suffix is appended. Trailing slashes on baseUrl are stripped first. This lets
// the host pass either an API root (e.g. https://host/v1) or a full endpoint.
export function resolveUrl(baseUrl, suffix) {
  const base = String(baseUrl).replace(/\/+$/, '');
  if (!base) throw new ProtocolError('binding baseUrl is empty');
  if (base.endsWith('/' + suffix) || base === suffix) return base;
  return base + '/' + suffix;
}

// Sanitize an arbitrary thrown value into a safe, non-leaking kind string plus
// message. Exception text from host hooks or transports may include credentials,
// so only a stable failureKind leaves the adapter; the original text is dropped.
export function sanitizeFailureKind(error, fallback = 'host_error') {
  if (error == null) return fallback;
  if (error instanceof DOMException) {
    if (error.name === 'TimeoutError') return 'request_timeout';
    if (error.name === 'AbortError') return 'request_timeout';
  }
  if (error instanceof TypeError) return 'network_error';
  return fallback;
}
