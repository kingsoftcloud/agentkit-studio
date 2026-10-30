/**
 * Production adapter for the Native web tools (web_fetch / web_search).
 *
 * Wires the real factory parameters to the Native web adapter:
 * the Host fetch dispatcher (src/http-fetch.mjs -> undici, pinned to the same
 * version as DSH's web/proxy/MCP transports so loading web_fetch cannot break
 * later signed resource or model requests) and the env-driven search provider
 * configuration transcribed from ksadk.toolsets.web @ 355059d.
 *
 * native-dsh-tools.mjs registers these definitions in the DSH ToolRegistry and
 * creates per-Session adapters with the scoped ArtifactStore. The Studio Host
 * includes this adapter's provider binding in its locked Run digests.
 *
 * Credentials are resolved from the environment and used only in provider
 * request Authorization headers; they never appear in tool content, errors,
 * or the binding digest. Web reads are read-only and pass through the existing
 * Native tool authorization (authorizeNativeBuiltin returns immediately for
 * readOnly definitions); no new side-effect auto-allow is introduced.
 */
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns';
import { isIP } from 'node:net';
import { Agent } from 'undici';
import { hostFetch } from '../http-fetch.mjs';
import { canonical, copy } from '@kingsoftcloud/agentkit-harness-core';
import { createNativeWebTools, NATIVE_WEB_TOOLS_CONTRACT, isBlockedAddress } from '@kingsoftcloud/agentkit-harness-node/native/web-tools';
import { createNativeArtifactStore } from '@kingsoftcloud/agentkit-harness-node/native/artifact-store';

const readEnv = (env_, name, fallback = '') => {
  const value = env_?.[name];
  return value == null ? fallback : String(value).trim();
};

/** Resolve the web search provider configuration from the environment.
 *  Mirrors ksadk.toolsets.web: _web_search_provider, _web_search_http,
 *  _web_search_ksyun, _ksyun_search_api_key, _ksyun_search_scope. */
export function resolveWebSearchConfig(env_ = process.env) {
  const provider = (readEnv(env_, 'KSADK_WEB_SEARCH_PROVIDER') || readEnv(env_, 'OPENCLAW_WEB_SEARCH_PROVIDER')).toLowerCase();
  if (!provider) return { provider: '' };
  const baseUrl = readEnv(env_, 'KSADK_WEB_SEARCH_BASE_URL') || readEnv(env_, 'OPENCLAW_WEB_SEARCH_BASE_URL');
  if (provider === 'ksyun') {
    const apiKey = ['KSADK_WEB_SEARCH_API_KEY', 'OPENCLAW_WEB_SEARCH_API_KEY', 'KSADK_MCP_KEY', 'KSC_AIPRO_API_KEY', 'KSC_AIPRO_APIKEY', 'AIPRO_API_KEY']
      .map(name => readEnv(env_, name)).find(Boolean) || '';
    return { provider, baseUrl, apiKey, scope: readEnv(env_, 'KSADK_WEB_SEARCH_SCOPE') || 'webpage' };
  }
  if (provider === 'http') {
    const apiKey = readEnv(env_, 'KSADK_WEB_SEARCH_API_KEY') || readEnv(env_, 'OPENCLAW_WEB_SEARCH_API_KEY');
    return { provider, baseUrl, apiKey };
  }
  return { provider }; // 'fake' or unsupported — no credential needed
}

/** Resolve the SSRF policy from the environment JSON, matching _ssrf_policy. */
export function resolveWebSsrfPolicy(env_ = process.env) {
  const raw = readEnv(env_, 'KSADK_WEB_SSRF_POLICY_JSON') || readEnv(env_, 'OPENCLAW_BROWSER_SSRF_POLICY_JSON');
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

const hash = value => createHash('sha256').update(canonical(value)).digest('hex');

/** Build an undici Agent whose connect.lookup validates every resolved
 *  address against the SSRF block, so the actual TCP connection only ever
 *  reaches a pre-validated public address. This is defense-in-depth on top of
 *  the pure adapter's own DNS check: even a DNS-rebinding race (the record
 *  changing between the pre-check and the fetch) is caught here because undici
 *  resolves the hostname again through this lookup hook immediately before
 *  connecting. No new dependency is introduced — undici is already the Host
 *  fetch dispatcher. The returned { fetch, close } uses the Agent as its
 *  dispatcher; close() releases the Agent so the process can exit cleanly. */
export function createSsrfPinnedFetch({ fetchImpl = hostFetch, ssrfBlockCheck, lookupAddress = lookup }) {
  if (typeof ssrfBlockCheck !== 'function') return { fetch: fetchImpl, close: () => {} };
  // A failure to construct the protecting Agent is fatal: never fall back to
  // an unpinned fetch that could connect to a private address.
  const agent = new Agent({ connect: { lookup: (host, options, callback) => {
    // undici re-resolves the hostname here right before connecting; reject
    // any non-public address. A literal IP host bypasses DNS but is still
    // checked against the block list. This is the actual connection pin.
    const bare = /^\[(.+)\]$/.exec(host) ? host.slice(1, -1) : host;
    if (isIP(bare) && ssrfBlockCheck(bare)) { const err = new Error(`blocked non-public address: ${bare}`); err.code = 'blocked_by_ssrf_policy'; return callback(err); }
    lookupAddress(bare, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      if (!addresses?.length) return callback(Object.assign(new Error('DNS returned no addresses'), { code: 'ENOTFOUND' }));
      for (const { address, family } of addresses) if (ssrfBlockCheck(address)) { const e = new Error(`blocked non-public address: ${address}`); e.code = 'blocked_by_ssrf_policy'; return callback(e); }
      // undici's connect.lookup may request either an array (options.all) or a
      // single (address, family) tuple. Return the shape the caller asked for.
      if (options.all) callback(null, addresses);
      else { const first = addresses[0]; callback(null, first.address, first.family); }
    });
  } } });
  const pinnedFetch = (url, init) => fetchImpl(url, { ...init, dispatcher: agent });
  // close() returns the Agent's close Promise so the caller can await full
  // release of the underlying sockets; never swallow the Promise.
  const close = () => agent.close();
  return { fetch: pinnedFetch, close };
}

/** Create a persistOutput callback bound to a real ArtifactStore. The Host
 *  integrator passes { store, scope } (the same createNativeArtifactStore used
 *  by command tools); the callback writes the full text with the original
 *  request identity (runId/operationKey/signal) and returns the artifact ref.
 *  A write failure is thrown to the pure adapter, which reports it honestly. */
function createArtifactPersistOutput({ store, scope } = {}) {
  if (!store || typeof store.write !== 'function') return undefined;
  return async (request, fullText, metadata) => {
    const ref = await store.write({
      scope, runId: request.runId, operationKey: `${request.operationKey}:web-fetch-output`,
      content: fullText, mediaType: metadata?.mediaType || 'text/plain',
      metadata: { toolName: metadata?.toolName || 'web_fetch', sessionId: request.sessionId,
        fullBytes: metadata?.fullBytes, reachedByteCeiling: metadata?.reachedByteCeiling },
      signal: request.signal,
    });
    return { uri: ref.uri, path: ref.uri };
  };
}

/** Public baseUrl returned to the model: origin + pathname only, so user/pass
 *  and any query-string secrets never reach the model surface. */
function publicBaseUrl(baseUrl) {
  try { const u = new URL(baseUrl); return `${u.origin}${u.pathname}`; } catch { return ''; }
}

/** The full sanitized URL (user/pass stripped, query kept) used only for the
 *  binding digest hash, so a provider route change (e.g. a different ?scope= or
 *  ?endpoint=) is detectable without leaking credentials in plaintext. */
function digestBaseUrl(baseUrl) {
  try { const u = new URL(baseUrl); u.username = ''; u.password = ''; return u.toString(); } catch { return ''; }
}

/** A binding digest that captures the actual provider route without leaking
 *  credentials. The full sanitized URL (origin + pathname + query, no user/pass)
 *  is hashed so a route change is detectable; the API key contributes only an
 *  opaque fingerprint (a hash of the key) so the digest proves which credential
 *  was bound without exposing it. The digest never contains plaintext. */
function webBindingDigest({ provider = '', baseUrl = '', scope = '', ssrfAllowPrivate = false, apiKey, inlineMaxChars }) {
  return hash({ contract: NATIVE_WEB_TOOLS_CONTRACT, provider, baseUrl: digestBaseUrl(baseUrl), scope, ssrfAllowPrivate,
    ...(inlineMaxChars === undefined ? {} : { inlineMaxChars }), keyFingerprint: apiKey ? createHash('sha256').update(String(apiKey)).digest('hex').slice(0, 16) : '' });
}

export function createNativeDshWebTools({ config = {}, fetch = hostFetch } = {}) {
  // Env config is resolved exactly once here; the Host writes the resulting
  // bindingDigest into its capsule. The frozen providerConfig/ssrfPolicy cannot
  // be mutated after binding.
  const resolvedProvider = config.providerConfig || resolveWebSearchConfig(config.env || process.env);
  const resolvedSsrf = config.ssrfPolicy || resolveWebSsrfPolicy(config.env || process.env);
  const providerConfig = Object.freeze(copy(resolvedProvider));
  const ssrfPolicy = Object.freeze({ allowPrivate: resolvedSsrf.allowPrivate === true || resolvedSsrf.allow_private === true });
  const sessionId = String(config.sessionId || '');
  const authorize = config.authorize;
  if (typeof authorize !== 'function') {
    throw Object.assign(new Error('native-dsh-web requires a trusted authorize callback'), { code: 'NATIVE_WEB_AUTHORIZE_REQUIRED' });
  }
  // SSRF-pinned fetch: the pure adapter pre-checks DNS, and the undici Agent
  // re-validates the resolved address at connect time so DNS rebinding cannot
  // bypass. isBlockedAddress is the same shared block list from the pure
  // adapter (no duplicated check). A failure to construct the protecting Agent
  // is fatal (createSsrfPinnedFetch throws); we never fall back to unpinned.
  const { fetch: pinnedFetch, close: closeAgent } = createSsrfPinnedFetch({ fetchImpl: fetch, ssrfBlockCheck: ssrfPolicy.allowPrivate === true ? null : isBlockedAddress });
  // persistOutput: an explicit config.persistOutput wins; otherwise bind a
  // real ArtifactStore if config.artifact { store, scope } was provided.
  const persistOutput = config.persistOutput ?? createArtifactPersistOutput(config.artifact);
  // Search endpoints come from the trusted Host configuration, including private
  // service deployments. The model chooses only the query. Public URL fetches
  // retain the separate DNS/address policy and the protecting dispatcher.
  const tools = createNativeWebTools({ fetch: pinnedFetch, searchFetch: fetch, providerConfig, authorize, ssrfPolicy, sessionId, persistOutput, inlineMaxChars: config.inlineMaxChars });
  const bindingDigest = webBindingDigest({ provider: providerConfig.provider, baseUrl: providerConfig.baseUrl || '', scope: providerConfig.scope || '', ssrfAllowPrivate: ssrfPolicy.allowPrivate, apiKey: providerConfig.apiKey, inlineMaxChars: config.inlineMaxChars });
  return { ...tools, bindingDigest, close: closeAgent, providerConfig: { provider: providerConfig.provider, baseUrl: publicBaseUrl(providerConfig.baseUrl || ''), scope: providerConfig.scope || '', apiKey: providerConfig.apiKey ? '<redacted>' : '' } };
}

export { createNativeArtifactStore };
export { NATIVE_WEB_TOOLS_CONTRACT };
