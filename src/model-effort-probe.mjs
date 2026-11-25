import { harnessModelEndpoint } from './model-endpoint.mjs';

/**
 * Which reasoning-effort levels a model accepts.
 *
 * The profile picker offers `low/medium/high/xhigh/max` for every 星流-backed
 * profile, but "the gateway accepts the level" is a per-model fact, not a
 * per-provider one — `glm-5.3` refuses `minimal` outright while
 * `kimi-k3.1-pro` accepts it on Chat and refuses it on Responses. A static
 * table cannot answer that, so this module asks.
 *
 * The standalone diagnostic records HTTP acceptance per level. Settings use
 * an invalid effort as a control and report each attempted level separately.
 *
 * The transport is injectable for the same reason as `probeModelWire`: the
 * browser half runs it through the Host and the tests run it against a local
 * server.
 */

const PROBE_PROMPT = 'OK';
const PROBE_MAX_OUTPUT_TOKENS = 32;
const PROBE_TIMEOUT_MS = 15_000;
const INVALID_EFFORT = 'invalid-studio-effort';

/** Effort rejections name the field; a bare 400 for an unrelated reason does not. */
const EFFORT_REJECTION = /reasoning[_. -]*effort|output_config\.effort|effort\s+value|不支持.*思考/i;
const NO_RESULT = { outcome: 'unknown', blocked: true };

/**
 * @typedef {'accepted' | 'rejected' | 'unknown'} EffortOutcome
 */

/**
 * Probe one reasoning level on one wire.
 *
 * @param {object} options - probe inputs.
 * @param {string} options.baseUrl - gateway base URL.
 * @param {string} options.modelName - model id.
 * @param {string} options.level - the DSH level id to probe.
 * @param {'openai-responses' | 'openai-chat' | 'anthropic-messages'} [options.wire] - which wire to probe.
 * @param {string} [options.apiKey] - bearer credential.
 * @param {Record<string, string>} [options.headers] - configured request headers.
 * @param {typeof fetch} [options.fetchImpl] - transport.
 * @param {number} [options.timeoutMs] - per-probe deadline.
 * @param {AbortSignal} [options.signal] - lifetime of the enclosing probe.
 * @param {boolean} [options.modernChatLimit] - use max_completion_tokens on Chat.
 * @returns {Promise<object>} HTTP verdict and any evidence returned by the endpoint.
 */
async function probeOnce({ baseUrl, modelName, level, wire = 'openai-chat', apiKey, headers = {}, fetchImpl = fetch,
  timeoutMs = PROBE_TIMEOUT_MS, signal, modernChatLimit = false }) {
  const root = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!root || !String(modelName ?? '').trim() || !String(level ?? '').trim() || signal?.aborted) return NO_RESULT;
  const responses = wire === 'openai-responses';
  const anthropic = wire === 'anthropic-messages';
  const path = responses ? '/responses' : anthropic ? '/messages' : '/chat/completions';
  let url;
  try { url = new URL(`${anthropic ? harnessModelEndpoint(root, 'anthropic-messages') : root}${path}`); } catch { return NO_RESULT; }
  if (!['http:', 'https:'].includes(url.protocol)) return NO_RESULT;
  const messages = [{ role: 'user', content: PROBE_PROMPT }];
  const chatLimit = modernChatLimit ? 'max_completion_tokens' : 'max_tokens';
  const body = responses
    ? {
      model: modelName,
      max_output_tokens: PROBE_MAX_OUTPUT_TOKENS,
      reasoning: { effort: level },
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: PROBE_PROMPT }] }],
    }
    : anthropic
      ? { model: modelName, max_tokens: PROBE_MAX_OUTPUT_TOKENS, output_config: { effort: level }, messages }
      : { model: modelName, [chatLimit]: PROBE_MAX_OUTPUT_TOKENS, reasoning_effort: level, messages };
  const requestHeaders = new Headers({ 'content-type': 'application/json' });
  if (anthropic) requestHeaders.set('anthropic-version', '2023-06-01');
  if (apiKey) requestHeaders.set(anthropic ? 'x-api-key' : 'authorization', anthropic ? apiKey : `Bearer ${apiKey}`);
  for (const [name, value] of Object.entries(headers)) requestHeaders.set(name, value);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
      redirect: 'error',
    });
    const text = await response.text();
    if (response.ok) {
      let reply;
      try { reply = JSON.parse(text); } catch { /* Some gateways return a non-inference page with HTTP 200. */ }
      const usable = !reply?.error && !['failed', 'cancelled'].includes(reply?.status)
        && (responses ? Array.isArray(reply?.output) : anthropic ? reply?.type === 'message' && Array.isArray(reply.content)
          : Array.isArray(reply?.choices) && reply.choices.length > 0);
      const effort = reply?.reasoning?.effort ?? reply?.reasoning_effort ?? reply?.output_config?.effort;
      return { outcome: 'accepted', usable, effort: typeof effort === 'string' ? effort : undefined };
    }
    const requestError = response.status === 400 || response.status === 422;
    const alternateChatLimit = !responses && !anthropic && requestError && text.includes(chatLimit);
    return {
      outcome: requestError && EFFORT_REJECTION.test(text) ? 'rejected' : 'unknown',
      status: response.status,
      blocked: [401, 402, 403, 404, 429].includes(response.status),
      alternateChatLimit,
    };
  } catch {
    if (controller.signal.aborted || signal?.aborted) return { outcome: 'timeout' };
    return NO_RESULT;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe every level of one model, preserving input order.
 *
 * Probes run serially: the point is a verdict per level, and a burst against
 * one model is exactly what turns a "rejected" into a "rate limited".
 *
 * @param {object} options - batch inputs.
 * @param {string} options.baseUrl - gateway base URL.
 * @param {string} options.modelName - model id.
 * @param {readonly string[]} options.levels - DSH level ids to probe.
 * @param {'openai-responses' | 'openai-chat'} [options.wire] - which wire to probe.
 * @param {string} [options.apiKey] - bearer credential.
 * @param {Record<string, string>} [options.headers] - configured request headers.
 * @param {typeof fetch} [options.fetchImpl] - transport.
 * @param {number} [options.timeoutMs] - per-probe deadline.
 * @returns {Promise<Array<{ level: string, outcome: EffortOutcome }>>} one row per level.
 */
export async function probeModelEfforts({ baseUrl, modelName, levels, wire, apiKey, headers = {}, fetchImpl = fetch, timeoutMs }) {
  const rows = [];
  for (const level of [...new Set((levels || []).map(item => String(item ?? '').trim()).filter(Boolean))]) {
    const { outcome } = await probeOnce({ baseUrl, modelName, level, wire, apiKey, headers, fetchImpl, timeoutMs });
    rows.push({ level, outcome: outcome === 'timeout' ? 'unknown' : outcome });
  }
  return rows;
}

export const untestedEfforts = levels => levels.map(level => ({ level, outcome: 'untested' }));

/** Report diagnostic evidence using one invalid effort as a control. */
export async function diagnoseModelEfforts({ levels, signal, modernChatLimit = false, timeoutMs = 15_000, budgetMs = 90_000, ...options }) {
  signal?.throwIfAborted();
  const deadline = AbortSignal.timeout(budgetMs);
  const lifetime = signal ? AbortSignal.any([deadline, signal]) : deadline;
  const attempt = level => probeOnce({ ...options, level, modernChatLimit, signal: lifetime, timeoutMs });
  let control = await attempt(INVALID_EFFORT);
  if (control.alternateChatLimit && !lifetime.aborted) {
    modernChatLimit = !modernChatLimit;
    control = await attempt(INVALID_EFFORT);
  }
  signal?.throwIfAborted();
  const outcomes = untestedEfforts(levels);
  let controlOutcome = control.outcome;
  if (controlOutcome !== 'timeout' && (control.effort === INVALID_EFFORT
    || controlOutcome !== 'rejected' && !control.usable)) controlOutcome = 'inconclusive';
  // Credential/permission/rate-limit failures (blocked) still abort the run. Any
  // other inconclusive control — e.g. a gateway that answers an invalid effort
  // with a bare 400 that names no effort field — no longer aborts it: fall
  // through and measure each level instead of reporting everything untested.
  if ((controlOutcome === 'inconclusive' || controlOutcome === 'timeout') && control.blocked) {
    return { control: controlOutcome, outcomes };
  }
  // A gateway that 200s even the invalid effort (and does not echo it) ignores
  // the effort parameter, so a 200 alone cannot prove a level is supported.
  const ignoresEffort = controlOutcome === 'accepted' && control.effort === undefined;
  let anyAccepted = false;
  for (const row of outcomes) {
    if (lifetime.aborted) break;
    const result = await attempt(row.level);
    if (result.outcome === 'accepted') {
      const acknowledged = result.effort === row.level && control.effort !== row.level;
      // A 200 only counts when the reply does not echo a different effort, and
      // the gateway is not one that ignores the parameter outright. Compared to
      // requiring a rejected control, this also accepts levels after an
      // inconclusive (but not blocked) control.
      const accepted = result.effort === undefined && !ignoresEffort;
      row.outcome = result.usable && acknowledged ? 'confirmed' : result.usable && accepted ? 'accepted' : 'unknown';
      if (row.outcome === 'accepted' || row.outcome === 'confirmed') anyAccepted = true;
    } else if ((result.status === 400 || result.status === 422) && anyAccepted) {
      // A lower level already ran, so this 4xx is the level being unsupported —
      // no requirement that the error text name the effort field.
      row.outcome = 'rejected';
    } else {
      row.outcome = result.outcome;
    }
    if (result.blocked) break;
  }
  signal?.throwIfAborted();
  return { control: controlOutcome, outcomes };
}
