/**
 * Which reasoning-effort levels a model accepts.
 *
 * The profile picker offers `low/medium/high/xhigh/max` for every 星流-backed
 * profile, but "the gateway accepts the level" is a per-model fact, not a
 * per-provider one — `glm-5.3` refuses `minimal` outright while
 * `kimi-k3.1-pro` accepts it on Chat and refuses it on Responses. A static
 * table cannot answer that, so this module asks.
 *
 * The probe sends the smallest legal completion per level. A 4xx that names the
 * effort is a **rejection**; a 2xx is **accepted**; everything else — a
 * timeout, a rejected credential, a 5xx — stays `unknown`, because an
 * unreachable gateway must never be recorded as a fact about the model.
 *
 * The transport is injectable for the same reason as `probeModelWire`: the
 * browser half runs it through the Host and the tests run it against a local
 * server.
 */

const PROBE_PROMPT = 'OK';
const PROBE_MAX_OUTPUT_TOKENS = 8;
const PROBE_TIMEOUT_MS = 15_000;

/** Effort rejections name the field; a bare 400 for an unrelated reason does not. */
const EFFORT_REJECTION = /reasoning[\w.]*effort|effort\s+value|不支持.*思考|thinking/i;

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
 * @param {'openai-responses' | 'openai-chat'} [options.wire] - which wire to probe.
 * @param {string} [options.apiKey] - bearer credential.
 * @param {Record<string, string>} [options.headers] - configured request headers.
 * @param {typeof fetch} [options.fetchImpl] - transport.
 * @param {number} [options.timeoutMs] - per-probe deadline.
 * @returns {Promise<EffortOutcome>} the outcome, or `unknown` when the probe proved nothing.
 */
async function probeOnce({ baseUrl, modelName, level, wire = 'openai-chat', apiKey, headers = {}, fetchImpl = fetch, timeoutMs = PROBE_TIMEOUT_MS }) {
  const root = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!root || !String(modelName ?? '').trim() || !String(level ?? '').trim()) return 'unknown';
  const responses = wire === 'openai-responses';
  const path = responses ? '/responses' : '/chat/completions';
  let url;
  try { url = new URL(`${root}${path}`); } catch { return 'unknown'; }
  if (!['http:', 'https:'].includes(url.protocol)) return 'unknown';
  const body = responses
    ? {
      model: modelName,
      max_output_tokens: PROBE_MAX_OUTPUT_TOKENS,
      reasoning: { effort: level },
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: PROBE_PROMPT }] }],
    }
    : { model: modelName, max_tokens: PROBE_MAX_OUTPUT_TOKENS, reasoning_effort: level, messages: [{ role: 'user', content: PROBE_PROMPT }] };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        ...(String(apiKey ?? '').trim() ? { Authorization: `Bearer ${String(apiKey).trim()}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: 'error',
    });
    const text = await response.text().catch(() => '');
    if (response.ok) return 'accepted';
    // Only a 4xx that names the effort is a verdict about the level. A 404, a
    // 429 or a 5xx says nothing about it, and neither does a 400 about some
    // other field — those stay unknown so the caller never records a guess.
    if (response.status >= 400 && response.status < 500 && EFFORT_REJECTION.test(text)) return 'rejected';
    return 'unknown';
  } catch {
    return 'unknown';
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
    rows.push({ level, outcome: await probeOnce({ baseUrl, modelName, level, wire, apiKey, headers, fetchImpl, timeoutMs }) });
  }
  return rows;
}
