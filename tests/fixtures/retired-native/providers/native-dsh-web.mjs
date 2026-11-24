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
import { createSsrfPinnedFetch } from '../../../../src/providers/ssrf-pinned-fetch.mjs';
import { hostFetch } from '../../../../src/http-fetch.mjs';
import { canonical, copy } from '../../../../src/contracts/native-values.mjs';
import { createNativeWebTools, NATIVE_WEB_TOOLS_CONTRACT, isBlockedAddress } from '@kingsoftcloud/agentkit-harness-node/native/web-tools';
import { createNativeArtifactStore } from '@kingsoftcloud/agentkit-harness-node/native/artifact-store';

import { resolveWebSearchConfig, resolveWebSsrfPolicy } from '../../../../src/providers/native-web-configuration.mjs';
export { createSsrfPinnedFetch, resolveWebSearchConfig, resolveWebSsrfPolicy };

const hash = value => createHash('sha256').update(canonical(value)).digest('hex');

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
