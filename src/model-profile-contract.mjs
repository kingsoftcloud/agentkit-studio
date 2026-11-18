/** Shared model-profile fields across authoring and runtime projections. */
export const MODEL_RUNTIME_OPTION_KEYS = Object.freeze(['protocol', 'contextWindow', 'maxOutputTokens', 'requestTimeoutMs', 'parameters', 'headers']);

/*
 * Custom request headers are user data that reaches the wire (the gateway
 * catalog read today, the model proxy next), so the settings form and the
 * configuration layer share one validation here instead of re-deriving it.
 * An RFC 7230 `token` is the only legal header name, and the value may not
 * carry a control character that could smuggle a second request through
 * CR/LF. Values may hold secrets: a rejected entry reports its name only.
 */
export const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
export const HEADER_VALUE = /^[\t\u0020-\u007e\u0080-\u00ff]*$/;
export const HEADER_LIMITS = Object.freeze({ count: 64, nameLength: 256, valueLength: 8192 });

/** '' when the entry may reach the wire, otherwise why it may not. */
export function headerEntryProblem(name, value) {
  if (typeof name !== 'string' || !name) return '请求头名称不能为空';
  if (name.length > HEADER_LIMITS.nameLength || !HEADER_NAME.test(name))
    return '请求头名称只能是 RFC 7230 token（字母、数字与 !#$%&\'*+-.^_`|~）';
  if (typeof value !== 'string') return '请求头值必须是文本';
  if (value.length > HEADER_LIMITS.valueLength) return `请求头值不能超过 ${HEADER_LIMITS.valueLength} 个字符`;
  return HEADER_VALUE.test(value) ? '' : '请求头值只能是 ASCII 文本，不能包含换行等控制字符';
}

/**
 * Configured headers as the plain string record that reaches the wire: entries
 * that are not representable as a request header and empty rows are dropped,
 * so a half-typed row never reaches a gateway and an emptied form removes the
 * field instead of freezing `{}` into the configuration file.
 */
export function requestHeaders(headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return {};
  return Object.fromEntries(Object.entries(headers)
    .filter(([name, value]) => !headerEntryProblem(name, value) && value.trim())
    .map(([name, value]) => [name, value.trim()]));
}

export function modelRuntimeOptions(profile) {
  return Object.fromEntries(MODEL_RUNTIME_OPTION_KEYS.filter(key => profile[key] !== undefined)
    .map(key => [key, structuredClone(profile[key])]));
}

/**
 * The wire a profile speaks to its model gateway.
 *
 * A profile has two routes to the same gateway — the Codex loopback proxy and
 * the DSH provider — and both have to agree on the wire. The Codex side already
 * honours `codexApi` (`src/providers/codex-configured-models.mjs`); the DSH
 * side hardcoded `openai-completions`, so a profile configured for Responses
 * still reached the gateway through the Chat conversion, losing reasoning items
 * and the tool-call semantics for nothing.
 *
 * `protocol` is the configuration-level spelling of the same fact and wins
 * because it is the more precise declaration. A profile that declares neither
 * keeps the historical Chat wire, so an existing configuration does not change
 * behaviour by being read.
 *
 * @param {object} profile - the resolved model profile.
 * @returns {'openai-completions' | 'openai-responses' | 'anthropic-messages'}
 */
export function providerWireApi(profile) {
  const protocol = String(profile?.protocol ?? '').trim();
  if (protocol === 'openai-responses') return 'openai-responses';
  if (protocol === 'anthropic-messages') return 'anthropic-messages';
  if (protocol === 'openai-chat') return 'openai-completions';
  return profile?.codexApi === 'responses' ? 'openai-responses' : 'openai-completions';
}
