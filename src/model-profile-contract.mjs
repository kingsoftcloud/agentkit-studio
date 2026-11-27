/** Shared model-profile fields across authoring and runtime projections. */
// `connectionId` travels with the bundle because the DSH route is keyed by
// connection: `portable-model-bridge` groups profiles onto one route by
// comparing this identity, and a projection that dropped it made two models of
// one gateway look like two different gateways (PORTABLE_MODEL_ROUTE_COLLISION).
export const MODEL_RUNTIME_OPTION_KEYS = Object.freeze(['connectionId', 'protocol', 'contextWindow', 'maxOutputTokens', 'requestTimeoutMs', 'parameters', 'headers']);

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

/** Headers shared by all models exposed through one DSH provider route. */
export function dshConnectionHeaders(profiles) {
  const normalized = profile => requestHeaders(profile?.headers);
  const signature = headers => JSON.stringify(Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), value]).sort());
  const headers = normalized(profiles[0]);
  const first = signature(headers);
  if (profiles.some(profile => signature(normalized(profile)) !== first)) {
    throw new Error('同一模型连接的请求头必须一致，请统一请求头或拆分连接。');
  }
  return Object.keys(headers).length ? { headers } : {};
}

/** Headers that can carry the model credential without the API-key field. */
export function hasConfiguredAuthentication(headers) {
  return Object.keys(requestHeaders(headers)).some(name => /^(?:authorization|x-api-key|api-key|x-api-key-token)$/i.test(name));
}

/** Header values that must not be written into a portable resource manifest. */
export function isSensitiveRequestHeader(name) {
  return /^(?:authorization|proxy-authorization|x-api-key|api-key|x-api-key-token)$/i.test(String(name || '').trim());
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
 * side hardcoded `openai-completions`, so a profile that declares Responses
 * still reached the gateway through the Chat conversion, losing reasoning items
 * and the tool-call semantics for nothing.
 *
 * **`codexApi` deliberately does not feed this.** It is the「Codex 模型接口」
 * selector — a statement about Codex, not about the gateway — and it defaults to
 * Responses for every profile. Reading it here would flip every existing DSH
 * route onto the Responses wire, which 42 of 星流's 59 models do not implement
 * (they answer 404). Only `protocol` opts a profile into Responses, and a
 * profile that declares nothing keeps the historical Chat wire, so an existing
 * configuration does not change behaviour by being read.
 *
 * Use `probeModelWire()` (`src/model-wire-probe.mjs`) to find out which wire a
 * model actually speaks before setting `protocol`.
 *
 * @param {object} profile - the resolved model profile.
 * @returns {'openai-completions' | 'openai-responses' | 'anthropic-messages'}
 */
export function providerWireApi(profile) {
  const protocol = String(profile?.protocol ?? '').trim();
  if (protocol === 'openai-responses') return 'openai-responses';
  if (protocol === 'anthropic-messages') return 'anthropic-messages';
  return 'openai-completions';
}
