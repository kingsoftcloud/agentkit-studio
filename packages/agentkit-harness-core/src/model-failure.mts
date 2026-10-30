import { invariant } from './values.mjs';

/** Observational only: these facts never authorize retries or tool execution. */
export const MODEL_FAILURE_CODES = [
  'host_binding', 'request_invalid', 'http_authentication', 'http_permission', 'http_client',
  'http_server', 'http_rate_limit', 'http_timeout', 'protocol_invalid', 'json_invalid',
  'envelope_invalid', 'provider_error', 'identity_conflict', 'usage_invalid', 'usage_conflict',
  'choice_invalid', 'delta_invalid', 'termination_conflict', 'framing_invalid', 'body_limit',
  'body_encoding', 'transport_error', 'stream_timeout', 'stream_incomplete', 'tool_payload_invalid',
] as const;
export interface ModelFailureDiagnostic {
  contract: 'model-failure-diagnostic/v1' | 'model-failure-diagnostic/v2';
  protocol: 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'unknown';
  phase: 'binding' | 'request' | 'headers' | 'http-error' | 'stream' | 'buffered';
  code: typeof MODEL_FAILURE_CODES[number];
  frameIndex?: number;
  httpStatus?: number;
  /** Observed counters only, never a replacement for the sealed billable usage. */
  usageConflict?: {
    previousFrameIndex: number;
    previous: ModelUsageCounters;
    reported: ModelUsageCounters;
  };
}
export interface ModelUsageCounters {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}
const usageCounterKeys = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningTokens'];
function validUsageCounters(value: ModelUsageCounters): boolean {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.hasOwn(value, 'inputTokens') && Object.hasOwn(value, 'outputTokens')
    && Object.keys(value).every(key => usageCounterKeys.includes(key))
    && Object.values(value).every(count => Number.isSafeInteger(count) && count >= 0));
}
export function validateModelFailure(value: ModelFailureDiagnostic | undefined): void {
  if (value === undefined) return;
  invariant(value && ['model-failure-diagnostic/v1', 'model-failure-diagnostic/v2'].includes(value.contract)
    && Object.keys(value).every(key => ['contract', 'protocol', 'phase', 'code', 'frameIndex', 'httpStatus',
      ...(value.contract === 'model-failure-diagnostic/v2' ? ['usageConflict'] : [])].includes(key))
    && ['openai-chat', 'openai-responses', 'anthropic-messages', 'unknown'].includes(value.protocol)
    && ['binding', 'request', 'headers', 'http-error', 'stream', 'buffered'].includes(value.phase)
    && MODEL_FAILURE_CODES.includes(value.code)
    && (value.frameIndex === undefined || value.phase === 'stream' && Number.isSafeInteger(value.frameIndex) && value.frameIndex >= 0)
    && (value.httpStatus === undefined || value.phase === 'http-error' && Number.isSafeInteger(value.httpStatus)
      && value.httpStatus >= 100 && value.httpStatus <= 599), 'invalid_model_failure_diagnostic');
  if (value.contract === 'model-failure-diagnostic/v2') {
    const conflict = value.usageConflict;
    invariant(value.code === 'usage_conflict' && value.protocol === 'openai-chat' && value.phase === 'stream'
      && value.frameIndex !== undefined && conflict
      && Object.keys(conflict).sort().join(',') === 'previous,previousFrameIndex,reported'
      && Number.isSafeInteger(conflict.previousFrameIndex) && conflict.previousFrameIndex >= 0
      && conflict.previousFrameIndex < value.frameIndex
      && validUsageCounters(conflict.previous) && validUsageCounters(conflict.reported)
      && (conflict.previous.inputTokens !== conflict.reported.inputTokens
        || conflict.previous.outputTokens !== conflict.reported.outputTokens), 'invalid_model_failure_diagnostic');
  }
  invariant(!value.code.startsWith('http_') || value.phase === 'http-error' && value.httpStatus !== undefined
    && (value.code === 'http_authentication' ? value.httpStatus === 401
      : value.code === 'http_permission' ? value.httpStatus === 403
        : value.code === 'http_rate_limit' ? value.httpStatus === 429
          : value.code === 'http_timeout' ? value.httpStatus === 408
            : value.code === 'http_server' ? value.httpStatus >= 500
              : value.httpStatus >= 300 && value.httpStatus < 500
                && ![401, 403, 408, 429].includes(value.httpStatus)), 'invalid_model_failure_diagnostic');
}
