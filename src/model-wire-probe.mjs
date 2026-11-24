import { harnessModelEndpoint } from './model-endpoint.mjs';

/**
 * Which wire a model gateway speaks for one model.
 *
 * The model catalog cannot answer this. 星流 serves 59 models and only 17 of
 * them implement `/v1/responses`, while the `/v1/models` body declares nothing
 * about it — no `native_endpoints`, no capability flag. A profile therefore has
 * to discover the wire, and the only honest way to discover it is to ask.
 *
 * The probe sends the smallest legal Responses request, then checks the
 * Anthropic Messages route when Responses is absent. A gateway that answers
 * 404 on both routes is the only signal read as Chat Completions. Everything
 * else stays `unknown`, so an unreachable gateway is never written as a fact.
 *
 * This module is transport agnostic: the caller owns credentials and network
 * policy, so the browser half can run it through the Host and the tests can run
 * it against a local server.
 */

const PROBE_PROMPT = 'OK';
const PROBE_MAX_OUTPUT_TOKENS = 32;
const PROBE_TIMEOUT_MS = 10_000;

/**
 * @typedef {'openai-responses' | 'openai-completions' | 'anthropic-messages' | 'unknown'} ModelWire
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
 * @param {AbortSignal} [options.signal] - lifetime of the enclosing request.
 * @returns {Promise<ModelWire>} the wire, or `unknown` when the probe proved nothing.
 */
export async function probeModelWire({ baseUrl, modelName, apiKey, headers = {}, fetchImpl = fetch, timeoutMs = PROBE_TIMEOUT_MS, signal }) {
  const model = String(modelName ?? '').trim();
  const root = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!model || !root || signal?.aborted) return 'unknown';
  const request = async (path, body, auth = 'bearer') => {
    let url;
    try { url = new URL(`${path === '/messages' ? harnessModelEndpoint(root, 'anthropic-messages') : root}${path}`); } catch { return { status: 0, body: null }; }
    if (!['http:', 'https:'].includes(url.protocol)) return { status: 0, body: null };
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    const requestHeaders = new Headers({ 'content-type': 'application/json' });
    if (apiKey) requestHeaders.set(auth === 'anthropic' ? 'x-api-key' : 'authorization', auth === 'anthropic' ? apiKey : `Bearer ${apiKey}`);
    for (const [name, value] of Object.entries(headers)) requestHeaders.set(name, value);
    if (auth === 'anthropic' && !requestHeaders.has('anthropic-version')) requestHeaders.set('anthropic-version', '2023-06-01');
    try {
      const response = await fetchImpl(url, { method: 'POST', headers: requestHeaders, body: JSON.stringify(body), signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal, redirect: 'error' });
      const text = await response.text().catch(() => '');
      let value; try { value = JSON.parse(text); } catch { value = null; }
      return { status: response.status, body: value };
    } catch { return { status: 0, body: null }; }
    finally { clearTimeout(timer); }
  };
  try {
    const responses = await request('/responses', {
        model,
        max_output_tokens: PROBE_MAX_OUTPUT_TOKENS,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: PROBE_PROMPT }] }],
    });
    if (responses.status !== 404) return responses.status >= 200 && responses.status < 300 && Array.isArray(responses.body?.output) && !responses.body.error ? 'openai-responses' : 'unknown';
    const anthropic = await request('/messages', { model, max_tokens: PROBE_MAX_OUTPUT_TOKENS, messages: [{ role: 'user', content: PROBE_PROMPT }] }, 'anthropic');
    if (anthropic.status !== 404) return anthropic.status >= 200 && anthropic.status < 300 && anthropic.body?.type === 'message' && Array.isArray(anthropic.body.content) ? 'anthropic-messages' : 'unknown';
    return 'openai-completions';
  } catch {
    return 'unknown';
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
 * @param {AbortSignal} [options.signal] - lifetime of the enclosing batch.
 * @returns {Promise<Array<{ modelName: string, wire: ModelWire }>>}
 */
export async function probeModelWires({ baseUrl, apiKey, headers = {}, models, fetchImpl = fetch, concurrency = PROBE_CONCURRENCY, signal }) {
  const queue = [...new Set((models || []).map(model => String(model ?? '').trim()).filter(Boolean))];
  const results = new Array(queue.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const index = next++;
      if (index >= queue.length) return;
      results[index] = { modelName: queue[index], wire: await probeModelWire({ baseUrl, apiKey, headers, modelName: queue[index], fetchImpl, signal }) };
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker));
  return results;
}
