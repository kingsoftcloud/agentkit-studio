/** Bounded provider facts; upstream bodies and credentials never enter traces. */
export function modelFailureDetails({ status, headers, error } = {}) {
  const details = {};
  if (Number.isInteger(status) && status >= 400 && status <= 599) details.status = status;
  for (const [field, value] of [['upstreamCode', error?.code], ['upstreamType', error?.type]]) {
    if (typeof value === 'string' && /^[\w.-]{1,80}$/.test(value)) details[field] = value;
  }
  const retry = headers?.get('retry-after');
  const delay = retry && (/^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now());
  if (Number.isFinite(delay) && delay > 0) details.providerRetryAfterMs = delay;
  return details;
}

/** Translate only known model failures to the public DSH LlmFailure contract. */
export function dshModelFailure(error) {
  const details = error?.details || {};
  const status = details.status;
  const codes = [details.upstreamCode, details.upstreamType].map(value => String(value || '').toLowerCase());
  const has = (...values) => values.some(value => codes.includes(value));
  let code;
  if (error?.code === 'MODEL_STREAM_FAILED') {
    if (status === 401 || status === 403 || has('authentication_error', 'invalid_api_key')) code = 'AUTH';
    else if (status === 402 || has('insufficient_quota', 'quota_exceeded', 'insufficient_balance', 'billing_hard_limit_reached')) code = 'QUOTA';
    else if (has('context_length_exceeded', 'context_window_exceeded')) code = 'CONTEXT_WINDOW_EXCEEDED';
    else if (status === 429 || has('rate_limit_error', 'rate_limit_exceeded', 'rate_limit')) code = 'RATE_LIMIT';
    else if (status >= 500 || has('server_error', 'overloaded_error', 'capacity', 'model_overloaded')) code = 'SERVER';
    else if (status === 408 || has('timeout', 'request_timeout')) code = 'TIMEOUT';
    else code = 'INVALID_RESPONSE';
  } else code = ({ MODEL_TRANSPORT_FAILED: 'TRANSPORT', MODEL_TIMEOUT: 'TIMEOUT', MODEL_EMPTY_RESPONSE: 'EMPTY_RESPONSE' })[error?.code];
  if (!code) return undefined;
  return {
    code,
    message: String(error.message || '模型请求失败'),
    ...(status ? { status } : {}),
    ...(details.providerRetryAfterMs ? { providerRetryAfterMs: details.providerRetryAfterMs } : {}),
  };
}
