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
  // A completed generation can fill input + output capacity without its input
  // having been rejected. Use bounded output continuation;
  // real input-overflow errors still take the separate context-overflow path.
  'model_context_window_exceeded',
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
 * identity but carry arguments={} and the contract's `wireArgumentsInvalid`
 * flag so the kernel can emit one bounded tool-error receipt without executing.
 */
export function normalizeResponse({
  text = '', toolCalls = [], finishReason = null, streamComplete = true,
} = {}) {
  const out = (kind, calls = []) => ({ kind, text, toolCalls: calls });

  if (USER_ABORTS.has(finishReason)) return out('user_abort');
  if (POLICY_ABORTS.has(finishReason)) return out('policy_abort');
  if (CONTEXT_LIMITS.has(finishReason)) return out('context_overflow');
  if (finishReason === 'provider_terminal_error') return out('provider_terminal_error');
  if (!streamComplete || finishReason === 'provider_retryable_error') {
    return out('provider_retryable_error');
  }
  if (OUTPUT_LIMITS.has(finishReason)) return { ...out('output_limit'), textCommitVersion: 'provider-finished-text/v1' };
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
// an incomplete report stays unknown, never fabricated zero usage. All supplied
// fields are validated even in a partial report. Optional subdivisions are
// retained by source meaning: prompt_tokens_details.cached_tokens ->
// cachedInputTokens, completion_tokens_details.reasoning_tokens -> reasoningTokens.
export function parseOpenAIUsage(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolError('invalid usage report');
  }
  for (const field of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
    if (Object.hasOwn(value, field)) toNonNegInt(value[field], field);
  }
  const details = value.prompt_tokens_details;
  const completionDetails = value.completion_tokens_details;
  if (details != null && (typeof details !== 'object' || Array.isArray(details))) {
    throw new ProtocolError('invalid usage details');
  }
  if (completionDetails != null && (typeof completionDetails !== 'object' || Array.isArray(completionDetails))) {
    throw new ProtocolError('invalid usage details');
  }
  const cached = details && Object.hasOwn(details, 'cached_tokens')
    ? toNonNegInt(details.cached_tokens, 'cached_tokens') : undefined;
  const reasoning = completionDetails && Object.hasOwn(completionDetails, 'reasoning_tokens')
    ? toNonNegInt(completionDetails.reasoning_tokens, 'reasoning_tokens') : undefined;
  if (!Object.hasOwn(value, 'prompt_tokens') || !Object.hasOwn(value, 'completion_tokens')) return null;
  const usage = { ...emptyUsage(), inputTokens: value.prompt_tokens, outputTokens: value.completion_tokens };
  if (cached != null) usage.cachedInputTokens = cached;
  if (reasoning != null) usage.reasoningTokens = reasoning;
  return usage;
}

// Parse an Anthropic usage fragment (message_start or message_delta). Counters
// are accumulated across the stream. Cache fields are retained by source
// meaning: cache_read_input_tokens -> cachedInputTokens (tokens served from the
// cache). reasoning_tokens, when a provider reports it, -> reasoningTokens.
export function parseAnthropicUsageFragment(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolError('invalid anthropic usage');
  }
  const fragment = {};
  if (Object.hasOwn(value, 'input_tokens')) {
    fragment.inputTokens = toNonNegInt(value.input_tokens, 'input_tokens');
  }
  if (Object.hasOwn(value, 'output_tokens')) {
    fragment.outputTokens = toNonNegInt(value.output_tokens, 'output_tokens');
  }
  if (value.cache_read_input_tokens != null) {
    fragment.cachedInputTokens = toNonNegInt(value.cache_read_input_tokens, 'cache_read_input_tokens');
  }
  if (value.cache_creation_input_tokens != null) {
    fragment.cacheCreationInputTokens = toNonNegInt(value.cache_creation_input_tokens, 'cache_creation_input_tokens');
  }
  if (value.reasoning_tokens != null) {
    fragment.reasoningTokens = toNonNegInt(value.reasoning_tokens, 'reasoning_tokens');
  }
  return fragment;
}

// Build a sealed Usage plus usageReported flag. When the provider reported
// usage, usageReported is true and the counters are the provider's (including
// cached/reasoning). When it did not, usage is emptyUsage() and usageReported
// is false — the kernel records providerUsageIncomplete so a zero counter is
// never mistaken for known free usage.
export function sealUsage(reportedUsage) {
  if (reportedUsage == null) return { usage: emptyUsage(), usageReported: false };
  return { usage: reportedUsage, usageReported: true };
}

function toNonNegInt(value, field) {
  // The kernel's addUsage validates Number.isSafeInteger for token counters;
  // reject NaN/booleans/strings/unsafe integers so a bad report is a protocol
  // error here, not an invalid_usage crash in the kernel.
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ProtocolError(`invalid ${field} counter`);
  }
  return value;
}

// Host generation options may select a smaller output budget, but cannot
// increase the limit pinned in the run configuration.
export function boundOutputTokens(value, profileLimit) {
  if (!Number.isSafeInteger(profileLimit) || profileLimit <= 0) throw new ProtocolError('invalid pinned output limit');
  if (value === undefined) return profileLimit;
  if (!Number.isSafeInteger(value) || value <= 0) throw new ProtocolError('invalid output limit');
  return Math.min(value, profileLimit);
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
