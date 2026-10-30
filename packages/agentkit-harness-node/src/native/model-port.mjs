// Native model protocol adapter: one host-resolved HTTP request per attempt.
//
// createNativeModelPort({ resolveProfile, fetchImpl, maxResponseBytes,
//   idleTimeoutMs }) -> ModelPort. generate(request, emit) resolves a host-owned
// binding, issues exactly ONE HTTP request, streams text/thinking/tool_delta
// display deltas, and returns one sealed ModelResult. The adapter never retries
// and never executes tools; kernel policy owns backoff, call budgets and tool
// execution.
//
// The binding's apiKey is placed only in the Authorization/x-api-key header and
// never persisted in request, messages or result. binding.parameters may add
// generation fields but never override messages/tools/model/stream or
// security-sensitive transport values. Caller signal, body size and idle
// silence are all bounded.

import {
  emptyUsage, parseRetryAfterMs, sanitizeFailureKind, ProtocolError,
} from './model-normalize.mjs';
import {
  readModelSse, SseFramingError, IdleTimeout,
} from './model-sse.mjs';
import {
  parseOpenAIBuffered, createOpenAIStreamTurn,
} from './model-openai-chat.mjs';
import {
  parseAnthropicBuffered, createAnthropicStreamState,
} from './model-anthropic.mjs';
import {
  parseResponsesBuffered, createResponsesStreamState,
} from './model-responses.mjs';
import { MediaError } from './model-media.mjs';
import { buildNativeModelRequest } from './model-request.mjs';
// parseModelJson is the kernel's strict finite JSON parser; used here for the
// 400 context-length error heuristic so a malformed error body is never parsed
// as a lenient ambiguity.
import { parseModelJson, MODEL_FAILURE_CODES } from '@kingsoftcloud/agentkit-harness-core';
import { observeModelTransportPort } from './model-transport-observation.mjs';

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_IDLE_MS = 180000;

/** Only the adapter's plain inference request is admitted for cold replay.
 * Profile extensions can enable provider behavior we cannot prove pure. Keep
 * those manual until their semantics have an explicit Host admission contract.
 * A replay remains a new billed attempt; the ledger retains uncertain usage. */
export function nativeModelRecoveryPolicy({ protocol, parameters = {} } = {}) {
  return ['openai-chat', 'openai-responses', 'anthropic-messages'].includes(protocol)
    && parameters !== null && typeof parameters === 'object' && !Array.isArray(parameters)
    && Object.keys(parameters).length === 0 ? 'pure-inference/v1' : 'manual';
}

// A response body exceeded maxResponseBytes: terminal, never a truncated final.
class OverflowError extends Error {
  constructor() { super('response body exceeded maxResponseBytes'); this.name = 'OverflowError'; }
}

export function createNativeModelPort({
  resolveProfile,
  fetchImpl = fetch,
  maxResponseBytes = DEFAULT_MAX_BYTES,
  idleTimeoutMs = DEFAULT_IDLE_MS,
} = {}) {
  if (typeof resolveProfile !== 'function') {
    throw new TypeError('createNativeModelPort requires a resolveProfile function');
  }
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('createNativeModelPort requires a fetchImpl function');
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) throw new RangeError('maxResponseBytes must be a positive safe integer');
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) throw new RangeError('idleTimeoutMs must be positive and finite');
  const maxBytes = maxResponseBytes;
  const idleTimeout = idleTimeoutMs;

  return observeModelTransportPort(async (request, emitEvent, observation) => {
      if (!request || typeof request !== 'object' || !request.profile) {
        return withFailure(terminalResult('invalid_response'), null, 'request', 'request_invalid');
      }

      // 1. Resolve the host-owned binding. A host hook failure is terminal and
      // sanitized: exception text may carry credentials, so only the kind leaks.
      let binding;
      try {
        binding = await resolveProfile(request.profile, request);
      } catch {
        return withFailure(terminalResult('host_error'), null, 'binding', 'host_binding');
      }

      // 2. Build the wire request. Pre-flight validation of the binding, profile
      // or media is terminal; the adapter never calls HTTP with a bad binding.
      let built;
      try {
        built = buildNativeModelRequest(binding, request);
      } catch (error) {
        const failureKind = (error instanceof ProtocolError || error instanceof MediaError)
          ? 'invalid_response' : 'client_error';
        return withFailure(terminalResult(failureKind), binding, 'request', 'request_invalid');
      }

      // 3. One fetch with a combined signal: the caller's signal plus an internal
      // controller that bounds overall wall time. Redirects are disabled so a 3xx
      // is a terminal client error, never a silent second request.
      const internal = new AbortController();
      const signals = [internal.signal];
      if (request.signal) signals.push(request.signal);
      const combined = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
      let overallTimer = null;
      const overallMs = Number(request.profile?.requestTimeoutMs);
      if (Number.isFinite(overallMs) && overallMs > 0) {
        overallTimer = setTimeout(() => internal.abort(new IdleTimeout()), overallMs);
        overallTimer.unref?.();
      }

      let response;
      try {
        observation.phase('headers');
        response = await fetchImpl(built.url, {
          method: 'POST',
          headers: built.headers,
          body: built.body,
          signal: combined,
          redirect: 'manual',
        });
        observation.headers();
      } catch (error) {
        clearTimer(overallTimer);
        // Honor a caller-initiated abort by propagating it.
        if (request.signal?.aborted) throw error;
        if (internal.signal.aborted) return withFailure(retryableResult('request_timeout'), binding, 'headers', 'stream_timeout');
        return withFailure(retryableResult(sanitizeFailureKind(error, 'network_error')), binding, 'headers', 'transport_error');
      }

      // 4. Dispatch. The overall timer stays armed through body reads so a
      // server that sends headers then hangs the body is bounded; the finally
      // clears the timer and cancels any unconsumed body so no connection leaks
      // (e.g. a 429 whose body was never read).
      try {
        if (!response.ok) {
          observation.phase('http-error');
          const result = await classifyHttpError(response, { maxBytes });
          request.signal?.throwIfAborted();
          const code = response.status === 401 ? 'http_authentication' : response.status === 403 ? 'http_permission'
            : response.status === 429 ? 'http_rate_limit' : response.status === 408 ? 'http_timeout'
              : response.status >= 500 ? 'http_server' : 'http_client';
          return withFailure(result, binding, 'http-error', code, { httpStatus: response.status });
        }
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('text/event-stream')) {
          observation.phase('stream');
          const idlePolicy = request.profile.streaming !== false && request.profile.streamTimeoutPolicy === 'idle/v1';
          if (idlePolicy) { clearTimer(overallTimer); overallTimer = null; }
          return await streamResponse(response, request, binding, emitEvent, internal, maxBytes,
            idlePolicy && overallMs > 0 ? Math.min(idleTimeout, overallMs) : idleTimeout, observation);
        }
        observation.phase('buffered');
        return await bufferedResponse(response, request, binding, maxBytes, emitEvent, observation);
      } catch (error) {
        if (request.signal?.aborted) throw error;
        if (error instanceof IdleTimeout || internal.signal.aborted) {
          return withFailure(retryableResult('request_timeout'), binding, 'buffered', 'stream_timeout');
        }
        // Overflow, bad UTF-8, or a transport error mid-body: a partial body is
        // never sealed as a final; the attempt is terminal invalid_response.
        return withFailure(terminalResult('invalid_response'), binding, 'buffered', error instanceof OverflowError
          ? 'body_limit' : error instanceof TypeError && error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA'
            ? 'body_encoding' : protocolCode(error));
      } finally {
        clearTimer(overallTimer);
        cancelBody(response);
      }
  });
}

async function streamResponse(response, request, binding, emit, internal, maxBytes, idleTimeoutMs, observation) {
  const profile = request.profile;
  const idlePolicy = profile.streaming !== false && profile.streamTimeoutPolicy === 'idle/v1';
  const state = binding.protocol === 'anthropic-messages'
    ? createAnthropicStreamState(profile)
    : binding.protocol === 'openai-responses'
      ? createResponsesStreamState(profile)
      : createOpenAIStreamTurn(profile, binding);
  // Idle silence aborts the fetch via the internal controller so the pending
  // body read rejects cleanly instead of leaving an orphaned read to cancel.
  const abort = (reason) => internal.abort(reason);
  let frameIndex = -1;
  const failed = (result, code) => withFailure(result, binding, 'stream', code,
    { ...(frameIndex < 0 ? {} : { frameIndex }),
      ...(code === 'usage_conflict' && state.usageConflict ? { usageConflict: state.usageConflict } : {}) });
  try {
    for await (const frame of readModelSse(response.body, { maxBytes, idleTimeoutMs, abort, observeBytes: observation.bytes })) {
      if (idlePolicy && !frame.data.trim()) continue;
      frameIndex++;
      observation.frame();
      state.consume(frame, emit);
      if (idlePolicy) emit({ kind: 'activity', text: '' });
      if (state.done) break;
    }
  } catch (error) {
    if (request.signal?.aborted) throw error; // caller cancel propagates
    if (error instanceof IdleTimeout) {
      return failed(state.finalize({ errorKind: 'provider_retryable_error', failureKind: 'request_timeout' }), 'stream_timeout');
    }
    if (error instanceof SseFramingError) {
      return failed(state.finalize({ errorKind: 'provider_terminal_error', failureKind: 'invalid_response' }), protocolCode(error));
    }
    if (error instanceof ProtocolError) {
      // An Anthropic in-stream `error` event carries its own classification.
      if (error.streamError) {
        return failed(state.finalize({ errorKind: error.streamError.kind, failureKind: error.streamError.failureKind }), 'provider_error');
      }
      return failed(state.finalize({ errorKind: 'provider_terminal_error', failureKind: 'invalid_response' }), protocolCode(error));
    }
    if (internal.signal.aborted) {
      // An overall-timeout abort (and any idle abort that surfaced as a
      // transport error) is a retryable request timeout, never a final.
      return failed(state.finalize({ errorKind: 'provider_retryable_error', failureKind: 'request_timeout' }), 'stream_timeout');
    }
    return failed(state.finalize({ errorKind: 'provider_retryable_error', failureKind: sanitizeFailureKind(error, 'network_error') }), 'transport_error');
  }
  const result = state.finalize();
  return failed(result, state.streamError ? 'provider_error' : result.kind === 'malformed_tool_call' ? 'tool_payload_invalid'
    : result.failureKind === 'incomplete_response' ? 'stream_incomplete' : 'protocol_invalid');
}

async function bufferedResponse(response, request, binding, maxBytes, emit, observation) {
  const bodyText = await readBoundedText(response, maxBytes, observation.bytes);
  const captureReplay = request.profile?.providerReplayMode !== 'none';
  // Keep legacy buffered admissions unchanged. New visibility admissions also
  // retain explicitly provided display reasoning when a server returns JSON.
  const onThinking = request.profile.providerThinkingDisplayPolicy === 'provider-visible/v1'
    && request.profile.providerThinkingDisplay === true ? text => { if (text) emit({ kind: 'thinking', text }); } : undefined;
  try {
    if (binding.protocol === 'anthropic-messages') {
      return withFailure(parseAnthropicBuffered(bodyText, request, { captureReplay, onThinking }), binding, 'buffered', 'protocol_invalid');
    }
    if (binding.protocol === 'openai-responses') {
      return withFailure(parseResponsesBuffered(bodyText, request, { captureReplay, onThinking }), binding, 'buffered', 'protocol_invalid');
    }
    return withFailure(parseOpenAIBuffered(bodyText, request, { captureReplay, binding, onThinking }), binding, 'buffered', 'protocol_invalid');
  } catch (error) {
    return withFailure(terminalResult('invalid_response'), binding, 'buffered', protocolCode(error));
  }
}

// Classify a non-2xx HTTP response into a sealed ModelResult. The body is read
// only for a 400 to detect a context_length_exceeded code; otherwise the
// status and Retry-After header are the only facts that leave the adapter. A
// body that cannot be read (timeout/overflow/bad utf-8) cannot erase the HTTP
// failure fact — the status-based classification still stands.
async function classifyHttpError(response, { maxBytes }) {
  const status = response.status;
  const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
  if (status === 408) return retryableResult('request_timeout', retryAfterMs);
  if (status === 429) return retryableResult('rate_limit', retryAfterMs);
  if (status >= 500 && status <= 599) return retryableResult('server_error', retryAfterMs);
  if (status === 403) return { kind: 'policy_abort', text: '', toolCalls: [], usage: emptyUsage(), usageReported: false };
  if (status === 400) {
    try {
      const bodyText = await readBoundedText(response, maxBytes);
      if (hasContextLengthExceeded(bodyText)) {
        return { kind: 'context_overflow', text: '', toolCalls: [], usage: emptyUsage(), usageReported: false };
      }
    } catch { /* an unreadable 400 body cannot erase the 400 failure fact */ }
    return terminalResult('client_error');
  }
  return terminalResult('client_error');
}

function hasContextLengthExceeded(bodyText) {
  try {
    const payload = parseModelJson(bodyText);
    const error = payload && typeof payload === 'object' ? payload.error : null;
    if (error && typeof error === 'object') {
      const code = String(error.code || '');
      const type = String(error.type || '');
      if (code === 'context_length_exceeded' || type === 'context_length_exceeded') return true;
    }
  } catch { /* an unreadable error body cannot erase the HTTP failure fact */ }
  return false;
}

function terminalResult(failureKind) {
  return { kind: 'provider_terminal_error', text: '', toolCalls: [], usage: emptyUsage(), usageReported: false, failureKind };
}

// A closed enum, rather than exception messages, crosses the model boundary.
// This is diagnostic evidence only; original classification/retry policy stays intact.
function protocolCode(error) {
  return (error instanceof ProtocolError || error instanceof SseFramingError) && MODEL_FAILURE_CODES.includes(error.code)
    ? error.code : 'protocol_invalid';
}
function withFailure(result, binding, phase, code, fields = {}) {
  if (!['provider_terminal_error', 'provider_retryable_error', 'policy_abort', 'malformed_tool_call'].includes(result.kind)) return result;
  const protocol = ['openai-chat', 'openai-responses', 'anthropic-messages'].includes(binding?.protocol) ? binding.protocol : 'unknown';
  return { ...result, failureDiagnostic: { contract: fields.usageConflict
    ? 'model-failure-diagnostic/v2' : 'model-failure-diagnostic/v1', protocol, phase, code, ...fields } };
}

function retryableResult(failureKind, retryAfterMs = null) {
  const result = { kind: 'provider_retryable_error', text: '', toolCalls: [], usage: emptyUsage(), usageReported: false, failureKind };
  if (Number.isFinite(retryAfterMs) && retryAfterMs != null && retryAfterMs >= 0) {
    result.retryAfterMs = retryAfterMs;
  }
  return result;
}

function clearTimer(timer) {
  if (timer) clearTimeout(timer);
}

// Cancel an unconsumed response body so the underlying connection is released
// (e.g. a 429 whose body was never read). Safe to call on a consumed/locked/
// errored body: a cancel that cannot proceed, or rejects because the stream
// was aborted, is swallowed so it never surfaces as an unhandled rejection.
function cancelBody(response) {
  try {
    const result = response?.body?.cancel?.();
    if (result && typeof result.then === 'function') result.catch(() => {});
  } catch { /* already locked/consumed */ }
}

// Read a response body as strict UTF-8 text, failing on overflow rather than
// truncating a prefix (a JSON prefix + overflow suffix must not masquerade as a
// complete response). Reads to EOF before sealing. Throws OverflowError on
// overflow; propagates abort and bad-UTF-8 errors for the caller to classify.
async function readBoundedText(response, maxBytes, observeBytes) {
  const body = response.body;
  if (body == null) return '';
  const reader = body.getReader ? body.getReader() : null;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let total = 0;
  const chunks = [];
  if (reader) {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        if (!(value instanceof Uint8Array) && !(value instanceof ArrayBuffer)) throw new ProtocolError('body requires bytes');
        total += value.byteLength;
        observeBytes?.(value.byteLength);
        if (total > maxBytes) throw new OverflowError();
        chunks.push(decoder.decode(value, { stream: true }));
      }
      chunks.push(decoder.decode());
      return chunks.join('');
    } finally {
      reader.releaseLock?.();
    }
  }
  // Async-iterable fallback.
  for await (const value of body) {
    if (!value) continue;
    if (!(value instanceof Uint8Array) && !(value instanceof ArrayBuffer)) throw new ProtocolError('body requires bytes');
    total += value.byteLength;
    observeBytes?.(value.byteLength);
    if (total > maxBytes) throw new OverflowError();
    chunks.push(decoder.decode(value, { stream: true }));
  }
  chunks.push(decoder.decode());
  return chunks.join('');
}
