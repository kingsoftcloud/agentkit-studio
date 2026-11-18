/**
 * Which wire a model gateway speaks for one model.
 *
 * The model catalog cannot answer this. 星流 serves 59 models and only 17 of
 * them implement `/v1/responses`, while the `/v1/models` body declares nothing
 * about it — no `native_endpoints`, no capability flag. A profile therefore has
 * to discover the wire, and the only honest way to discover it is to ask.
 *
 * The probe sends the smallest legal Responses request. A gateway that does not
 * implement the route answers 404, and that is the **only** signal read as
 * "Chat only". Everything else — a timeout, a rejected credential, a 5xx, a
 * model that is listed but not deployed — stays `unknown`, so an unreachable
 * gateway is never written into a profile as a Chat-only fact.
 *
 * This module is transport agnostic: the caller owns credentials and network
 * policy, so the browser half can run it through the Host and the tests can run
 * it against a local server.
 */

/** The whole probe: one short prompt, eight output tokens. */
const PROBE_PROMPT = 'OK';
const PROBE_MAX_OUTPUT_TOKENS = 8;
const PROBE_TIMEOUT_MS = 10_000;

/**
 * @typedef {'openai-responses' | 'openai-completions' | 'unknown'} ModelWire
 */

/**
 * Probe the wire one model speaks.
 *
 * @param {object} options - probe inputs.
 * @param {string} options.baseUrl - the gateway base URL (with `/v1` as configured).
 * @param {string} options.modelName - the model id to probe.
 * @param {string} [options.apiKey] - bearer credential, when the gateway needs one.
 * @param {Record<string, string>} [options.headers] - configured request headers.
 * @param {typeof fetch} [options.fetchImpl] - transport; defaults to the global fetch.
 * @param {number} [options.timeoutMs] - per-probe deadline.
 * @returns {Promise<ModelWire>} the wire, or `unknown` when the probe proved nothing.
 */
export async function probeModelWire({ baseUrl, modelName, apiKey, headers = {}, fetchImpl = fetch, timeoutMs = PROBE_TIMEOUT_MS }) {
  const model = String(modelName ?? '').trim();
  const root = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!model || !root) return 'unknown';
  let url;
  try { url = new URL(`${root}/responses`); } catch { return 'unknown'; }
  if (!['http:', 'https:'].includes(url.protocol)) return 'unknown';
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
      body: JSON.stringify({
        model,
        max_output_tokens: PROBE_MAX_OUTPUT_TOKENS,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: PROBE_PROMPT }] }],
      }),
      signal: controller.signal,
      redirect: 'error',
    });
    // The body is never inspected, but draining it releases the socket: a probe
    // that leaves a stream open keeps the caller's pool busy for the whole batch.
    await response.text().catch(() => '');
    // 404 is the only signal that the route itself is missing. A gateway that
    // rejects the request for any other reason still implements the route, but
    // "still implements it" is not the same as "this model works on it", so
    // everything else stays unknown rather than being promoted to a fact.
    if (response.status === 404) return 'openai-completions';
    return response.ok ? 'openai-responses' : 'unknown';
  } catch {
    // Abort, DNS, TLS, connection reset: the probe proved nothing.
    return 'unknown';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * How many probes may be in flight at once.
 *
 * Serial per gateway (a batch of probes must not look like a burst to one
 * provider) and bounded across gateways, which is what this constant caps.
 */
export const PROBE_CONCURRENCY = 5;

/**
 * Probe many models of one gateway, preserving input order.
 *
 * Each entry is `{ modelName, wire }`; a failing probe never rejects the batch,
 * it reports `unknown` for that model.
 *
 * @param {object} options - batch inputs.
 * @param {string} options.baseUrl - the gateway base URL.
 * @param {string} [options.apiKey] - bearer credential.
 * @param {Record<string, string>} [options.headers] - configured request headers.
 * @param {readonly string[]} options.models - model ids to probe.
 * @param {typeof fetch} [options.fetchImpl] - transport.
 * @param {number} [options.concurrency] - parallel probes.
 * @returns {Promise<Array<{ modelName: string, wire: ModelWire }>>}
 */
export async function probeModelWires({ baseUrl, apiKey, headers = {}, models, fetchImpl = fetch, concurrency = PROBE_CONCURRENCY }) {
  const queue = [...new Set((models || []).map(model => String(model ?? '').trim()).filter(Boolean))];
  const results = new Array(queue.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const index = next++;
      if (index >= queue.length) return;
      results[index] = { modelName: queue[index], wire: await probeModelWire({ baseUrl, apiKey, headers, modelName: queue[index], fetchImpl }) };
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker));
  return results;
}
