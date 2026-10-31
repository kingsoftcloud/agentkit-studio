/**
 * Native Node web tools for the AgentKit Harness.
 *
 * Exports createNativeWebTools({fetch, providerConfig, ssrfPolicy, authorize,
 * sessionId}) -> {definitions, execute}. `definitions` is the sealed
 * ToolDefinition[] for web_fetch and web_search, ported from
 * ksadk.toolsets.web @ 355059d. `execute` runs a ToolRequest and returns a
 * ToolResult whose `content` is the Python-faithful dict.
 *
 * Authorization: web tools are read-only but still require a trusted authorize
 * callback. `execute` snapshots the full locked request context (call,
 * definition, scope, runId, turnId, buildId, parentRunId, taskChainId,
 * operationKey, sessionId, signal identity) before the await, calls authorize
 * with an isolated JSON copy (the signal identity is passed for inspection but
 * cannot be serialized/mutated), and rejects if anything drifted after the
 * await — no fetch runs after drift. The injected `providerConfig` and
 * `ssrfPolicy` are deep-copied and frozen at factory creation; external
 * mutation of the original references cannot change bound behavior, and the
 * returned `definitions` are fresh copies so callers cannot mutate the formal
 * map. Reads are untrusted data annotation, not a new side-effect auto-allow.
 *
 * Faithful to the Python semantics that matter to the model and the safety
 * boundary: public-HTTP-only URL validation with SSRF blocking (the union of
 * Python ipaddress is_loopback/is_private/is_link_local/is_multicast/
 * is_reserved for IPv4 and IPv6, plus IPv4-mapped IPv6 and IPv6 hostnames with
 * brackets), manual redirect following up to 5 hops, one bounded signal that
 * spans DNS + every redirect + the body read, a hard byte ceiling on the
 * streamed response, Unicode code-point budget, HTML-to-text sanitization that
 * never throws on invalid entities, query validation, and the three real
 * search providers (fake / http / ksyun). Credentials are used only in provider
 * request Authorization headers and never returned in content, errors, the
 * binding digest, or the redacted provider config; cross-origin redirects do
 * not carry the Authorization header; un-sanitized error messages are not
 * echoed back to the model.
 *
 * Host-owned concerns (artifact persistence of oversized output, the Host
 * fetch dispatcher address-pinning, effect intent/receipt) are deliberately
 * not reimplemented here; the production adapter
 * (src/providers/native-dsh-web.mjs) wires the real fetch and env config and
 * states the integration point. The SSRF check resolves DNS itself so the
 * fetch dispatcher connects to an already-validated address; the Host
 * dispatcher's own pinning is an additional defense-in-depth, not relied on
 * alone.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIPv4, isIPv6 } from 'node:net';
import { canonical, copy, invariant, scopeKey, toolInputRejection, matchesToolExecutionContract } from '@kingsoftcloud/agentkit-harness-core';
import { parse as parseHtml, defaultTreeAdapter } from 'parse5';

export const NATIVE_WEB_TOOLS_CONTRACT = 'agentkit.native-web-tools/v1';
const DEFAULT_MAX_CHARS = 50_000;
const MAX_REDIRECTS = 5;
const SEARCH_TIMEOUT_MS = 30_000;
// A hard byte ceiling on a single response body so a hostile server cannot
// stream an unbounded payload. The Python path reads response.text fully; the
// Node port bounds the read and reports a truncation marker instead of a hang.
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

// SSRF block list: the union of Python ipaddress is_loopback/is_private/
// is_link_local/is_multicast/is_reserved for IPv4 and IPv6 (Python 3.9
// ipaddress.py _IPv4Constants._private_networks + _reserved_network +
// _linklocal/_loopback/_multicast, and _IPv6Constants). allowPrivate === true
// (strict boolean) bypasses the check. Node's net.BlockList misreports a v4
// address when v6 subnets are also registered in the same list, so v4 and v6
// are kept in separate lists and checked by explicit family.
const SSRF_BLOCK_V4 = new BlockList();
const SSRF_BLOCK_V6 = new BlockList();
const SSRF_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 29], ['192.0.0.170', 31], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4], ['255.255.255.255', 32],
  ['100.64.0.0', 10], // carrier-grade NAT: Python treats 100.64/10 as non-public
];
const SSRF_V6 = [
  ['::1', 128], ['::', 128], ['::ffff:0:0', 96], ['100::', 64], ['2001::', 23],
  ['2001:2::', 48], ['2001:db8::', 32], ['2001:10::', 28], ['fc00::', 7], ['fe80::', 10],
  ['ff00::', 8], ['fec0::', 10],
  // IPv6 is_reserved networks (Python _reserved_networks):
  ['::', 8], ['100::', 8], ['200::', 7], ['400::', 6], ['800::', 5], ['1000::', 4],
  ['4000::', 3], ['6000::', 3], ['8000::', 3], ['a000::', 3], ['c000::', 3], ['e000::', 4],
  ['f000::', 5], ['f800::', 6], ['fe00::', 9],
];
for (const [addr, prefix] of SSRF_V4) SSRF_BLOCK_V4.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of SSRF_V6) SSRF_BLOCK_V6.addSubnet(addr, prefix, 'ipv6');

// IPv4-mapped IPv6 (::ffff:a.b.c.d) must be checked as IPv4 too. Node's URL
// strips brackets from hostname; an IPv6 literal like [::1] arrives as '::1'.
export function isBlockedAddress(address) {
  if (isIPv4(address)) return SSRF_BLOCK_V4.check(address, 'ipv4');
  if (isIPv6(address)) {
    const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(address);
    if (mapped && isIPv4(mapped[1])) return SSRF_BLOCK_V4.check(mapped[1], 'ipv4') || SSRF_BLOCK_V6.check(address, 'ipv6');
    return SSRF_BLOCK_V6.check(address, 'ipv6');
  }
  return true; // unknown family -> blocked
}

function def(name, description, parameters, opts) {
  return {
    name, description, parameters: copy(parameters),
    readOnly: true, concurrentSafe: true, permissions: [],
    timeoutMs: opts.timeoutMs, contextRole: 'none', observationRole: 'none',
    progressObservation: false, contextRetention: 'normal',
  };
}

export function nativeWebToolDefinitions() {
  return [
    def('web_fetch', 'Read a public HTTP(S) page. Long pages are paginated: use next_offset_chars to continue, or find to locate a literal section after offset_chars. URL fragments do not select sections. Returned paths/URIs are not workspace read grants.', {
      type: 'object',
      properties: {
        url: { type: 'string' },
        max_chars: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] },
        timeout: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
        offset_chars: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        find: { type: 'string', minLength: 1, maxLength: 1024 },
      },
      required: ['url'], additionalProperties: false,
    }, { timeoutMs: 60_000 }),
    def('web_search', 'Search the web and return title/url/snippet results without fetching full pages.', {
      type: 'object',
      properties: {
        query: { type: 'string' },
        max_results: { type: 'integer', default: 5, minimum: 1 },
        recency_days: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
      },
      required: ['query'], additionalProperties: false,
    }, { timeoutMs: 60_000 }),
  ];
}

// HTML-to-text via parse5 (already a dependency): build a real DOM tree, skip
// script/style/noscript/template, and extract block/inline text with explicit
// whitespace handling. Block-level elements introduce a space boundary; text
// is unescaped via parse5's decoded child text nodes (never throws on invalid
// entities). Whitespace collapses to single spaces, matching the Python
// " ".join(soup.get_text(" ").split()) behavior.
const BLOCK_TAGS = new Set(['address','article','aside','blockquote','br','dd','div','dl','dt','fieldset','figcaption','figure','footer','form','h1','h2','h3','h4','h5','h6','header','hr','li','main','nav','ol','p','pre','section','table','tr','td','th','thead','tbody','tfoot','ul']);
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'title', 'head', 'meta', 'link']);
function htmlToText(value) {
  const source = String(value || '');
  if (!source.trim()) return '';
  let document;
  try { document = parseHtml(source, { treeAdapter: defaultTreeAdapter, sourceCodeLocationInfo: false }); }
  catch { return ''; } // malformed input -> empty, never throw
  const parts = [];
  const walk = node => {
    if (!node) return;
    const nodeName = String(node.nodeName || '').toLowerCase();
    if (SKIP_TAGS.has(nodeName)) return;
    if (nodeName === '#text') { const v = String(node.value ?? ''); if (v) parts.push(v); return; }
    if (nodeName === '#comment' || nodeName === '#documentType') return;
    if (BLOCK_TAGS.has(nodeName)) parts.push(' ');
    const children = defaultTreeAdapter.getChildNodes?.(node) || node.childNodes || [];
    for (const child of children) walk(child);
    if (BLOCK_TAGS.has(nodeName)) parts.push(' ');
  };
  walk(document);
  return parts.join('').split(/\s+/).filter(Boolean).join(' ');
}

// Count and slice by Unicode code points, not UTF-16 code units. Python's
// len()/[:limit] operate on code points; a JS string slice can split a
// surrogate pair. `truncated` compares code-point counts so 😀😀 at limit 1 is
// truncated (2 code points > 1), not false from a 2-char preview.length.
function toCodePoints(text) { return Array.from(String(text)); }
function budgetText(text, limit) {
  const points = toCodePoints(text);
  const originalChars = points.length;
  const preview = points.slice(0, limit).join('');
  return { text: preview, truncated: originalChars > toCodePoints(preview).length, original_chars: originalChars, preview_chars: toCodePoints(preview).length };
}

async function validatePublicHttpUrl(url, ssrfPolicy, deadline) {
  let parsed;
  try { parsed = new URL(String(url)); }
  catch { return { ok: false, error_type: 'invalid_url', error_message: 'URL host is required', url }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error_type: 'unsupported_scheme', error_message: 'only http and https URLs are supported', url };
  }
  if (!parsed.hostname) {
    return { ok: false, error_type: 'invalid_url', error_message: 'URL host is required', url };
  }
  // Node's URL.hostname keeps brackets around IPv6 literals ([::1]); Python's
  // urlparse.hostname strips them. Strip here so isIPv6/dnsLookup see a bare
  // address, and a literal IPv6 host is blocked directly without DNS.
  let hostname = parsed.hostname;
  const bracketed = /^\[(.+)\]$/.exec(hostname);
  if (bracketed) hostname = bracketed[1];
  // Strict boolean: the string "false" must not enable private access.
  if (ssrfPolicy.allowPrivate === true) return null;
  // A literal IP host is checked directly (no DNS), matching Python's
  // getaddrinfo which returns the parsed address for an IP literal.
  if (isIPv4(hostname) || isIPv6(hostname)) {
    if (isBlockedAddress(hostname)) {
      return { ok: false, error_type: 'blocked_by_ssrf_policy', error_message: `blocked non-public address: ${hostname}`, url };
    }
    return null;
  }
  deadline.throwIfAborted?.();
  // DNS resolution is raced against the same deadline that bounds the whole
  // fetch, so a hanging resolver cannot outlive the tool timeout. The pure
  // adapter's check here is the first gate; the production adapter's undici
  // Agent connect.lookup re-validates at connect time (defense-in-depth).
  let addresses, onAbort;
  try {
    addresses = await Promise.race([
      dnsLookup(hostname, { all: true }),
      new Promise((_, reject) => {
        onAbort = () => reject(new Error('dns timeout'));
        deadline.addEventListener('abort', onAbort, { once: true });
        if (deadline.aborted) onAbort();
      }),
    ]);
  } catch (error) {
    if (deadline.aborted) return { ok: false, error_type: 'timeout', error_message: 'web_fetch timed out', url };
    return { ok: false, error_type: 'dns_resolution_failed', error_message: 'DNS resolution failed', url };
  } finally { if (onAbort) deadline.removeEventListener('abort', onAbort); }
  deadline.throwIfAborted?.();
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      return { ok: false, error_type: 'blocked_by_ssrf_policy', error_message: `blocked non-public address: ${address}`, url };
    }
  }
  return null;
}

function isRedirect(status) { return status >= 300 && status < 400 && status !== 304; }

/** Read a bounded number of bytes from a fetch Response body stream. Returns
 *  {text, reachedByteCeiling, fullBytes}. Cancels the stream as soon as the
 *  ceiling or the signal is hit so a hostile/redirect body cannot leak an open
 *  connection or hang the read. `text` is the decoded body up to the ceiling;
 *  `fullBytes` is the number of bytes actually read (capped at the ceiling)
 *  so the caller can report whether the full body was captured. */
async function readBoundedBody(response, { byteCeiling = MAX_RESPONSE_BYTES, signal } = {}) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    return { text, reachedByteCeiling: false, fullBytes: Buffer.byteLength(text) };
  }
  const decoder = new TextDecoder('utf8', { ignoreBOM: true });
  let bytes = 0, reachedByteCeiling = false;
  const chunks = [];
  try {
    for (;;) {
      signal?.throwIfAborted?.();
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > byteCeiling) {
        chunks.push(value.subarray(0, byteCeiling - (bytes - value.byteLength)));
        reachedByteCeiling = true;
        bytes = byteCeiling;
        break;
      }
      chunks.push(value);
    }
  } finally {
    try { if (reachedByteCeiling || signal?.aborted) await reader.cancel(); else reader.releaseLock?.(); } catch { /* already closed */ }
  }
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return { text: decoder.decode(out, { stream: false }), reachedByteCeiling, fullBytes: bytes };
}

// One bounded AbortSignal that spans DNS resolution, every redirect hop, and
// the body read. The caller's request.signal is composed in so cancellation
// propagates immediately at any stage.
function deadlineSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function webFetch({ fetch: fetchImpl, url, maxChars, offset = 0, find, inlineMaxChars, timeout, ssrfPolicy, signal, persistOutput, request, checkCurrent }) {
  const current = String(url || '').trim();
  if (!current) return { ok: false, error_type: 'url_required', error_message: 'url is required' };
  const requestedLimit = Number.isFinite(maxChars) && maxChars > 0 ? Math.trunc(maxChars) : DEFAULT_MAX_CHARS;
  const limit = inlineMaxChars ? Math.min(requestedLimit, inlineMaxChars) : requestedLimit;
  const timeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout * 1000 : 30_000;
  const deadline = deadlineSignal(signal, timeoutMs);
  try {
    return await fetchPage({ fetchImpl, url, current, limit, offset, find, ssrfPolicy, signal, persistOutput, request, deadline, checkCurrent });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (deadline.aborted) return { ok: false, error_type: 'timeout', error_message: 'web_fetch timed out', url };
    throw error;
  }
}

async function fetchPage({ fetchImpl, url, current, limit, offset, find, ssrfPolicy, signal, persistOutput, request, deadline, checkCurrent }) {
  let currentUrl = current;
  for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
    checkCurrent?.();
    const blocked = await validatePublicHttpUrl(currentUrl, ssrfPolicy, deadline);
    if (blocked) return blocked;
    checkCurrent?.();
    let response;
    try { response = await fetchImpl(currentUrl, { method: 'GET', redirect: 'manual', signal: deadline }); }
    catch (error) {
      if (signal?.aborted) throw error;
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError' || deadline.aborted) return { ok: false, error_type: 'timeout', error_message: 'web_fetch timed out', url: currentUrl };
      return { ok: false, error_type: 'FetchError', error_message: 'web_fetch request failed', url: currentUrl };
    }
    if (isRedirect(response.status)) {
      const location = response.headers.get('location');
      try { await response.body?.cancel?.(); } catch { /* already closed */ }
      if (location) { currentUrl = String(new URL(location, currentUrl)); continue; }
    }
    deadline.throwIfAborted?.();
    const contentType = response.headers.get('content-type') || '';
    const { text: fullText, reachedByteCeiling, fullBytes } = await readBoundedBody(response, { signal: deadline, returnFull: true });
    deadline.throwIfAborted?.();
    checkCurrent?.();
    const text = /html/i.test(contentType) ? htmlToText(fullText) : fullText;
    const points = toCodePoints(text);
    let start = offset;
    if (find) {
      const index = points.slice(offset).join('').indexOf(find);
      if (index < 0) return { ok: true, url, final_url: currentUrl, status_code: response.status,
        content_type: contentType, text: '', match_found: false, original_chars: points.length,
        offset_chars: offset, next_offset_chars: null, truncated: false, preview_chars: 0 };
      start += toCodePoints(points.slice(offset).join('').slice(0, index)).length;
    }
    const budget = budgetText(points.slice(start).join(''), limit);
    const next = start + budget.preview_chars;
    const result = { ok: true, url, final_url: currentUrl, status_code: response.status, content_type: contentType, ...budget,
      original_chars: points.length, offset_chars: start, next_offset_chars: next < points.length ? next : null,
      ...(find ? { match_found: true } : {}),
      ...(next < points.length ? { instruction: 'Continue with web_fetch using next_offset_chars, or find a literal section. Do not read temporary paths with workspace tools.' } : {}),
      ...(reachedByteCeiling ? { body_truncated_by_byte_ceiling: true, full_bytes: fullBytes } : {}) };
    // Persist the full output only when it exceeded the in-memory budget, using
    // the trusted persistOutput callback with the original request identity and
    // signal. A failure is reported honestly; we never claim persistence
    // succeeded when it did not.
    if (budget.truncated && typeof persistOutput === 'function') {
      try {
        checkCurrent?.();
        const ref = await persistOutput(request, text, { toolName: 'web_fetch', mediaType: contentType || 'text/plain', fullBytes, reachedByteCeiling });
        const path = ref?.uri ?? ref?.path;
        if (typeof path !== 'string' || !path.trim() || path.includes('\0')) throw new Error('persist_output_reference_invalid');
        result.persisted = { path, mime_type: contentType || 'text/plain' };
      } catch (error) {
        if (signal?.aborted) throw error;
        result.persisted = { failed: true, error: 'persist_output_failed' };
      }
    }
    checkCurrent?.();
    return result;
  }
  return { ok: false, error_type: 'too_many_redirects', error_message: 'web_fetch exceeded redirect limit', url };
}

// Merge params into base_url preserving any existing query (httpx semantics).
function mergeQuery(baseUrl, params) {
  const u = new URL(baseUrl);
  for (const [key, value] of Object.entries(params)) u.searchParams.set(key, String(value));
  return u.toString();
}

async function webSearchHttp({ fetch: fetchImpl, providerConfig, query, maxResults, recencyDays, signal }) {
  const baseUrl = String(providerConfig.baseUrl || '').trim();
  if (!baseUrl) return { ok: false, error_type: 'provider_not_configured', error_message: 'web search base URL is not configured' };
  const apiKey = String(providerConfig.apiKey || '').trim();
  const params = { q: query, max_results: String(Math.max(1, maxResults || 5)) };
  if (recencyDays != null) params.recency_days = String(recencyDays);
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  const deadline = deadlineSignal(signal, SEARCH_TIMEOUT_MS);
  let response, payload;
  try {
    response = await fetchImpl(mergeQuery(baseUrl, params), { method: 'GET', headers, redirect: 'manual', signal: deadline });
    if (isRedirect(response.status)) { try { await response.body?.cancel?.(); } catch {} return { ok: false, error_type: 'provider_not_configured', error_message: 'web search provider redirected unexpectedly' }; }
    if (!response.ok) {
      try { await response.body?.cancel?.(); } catch { /* already closed */ }
      throw Object.assign(new Error(`HTTP ${response.status}`), { name: 'HTTPStatusError' });
    }
    const { text } = await readBoundedBody(response, { signal: deadline });
    payload = JSON.parse(text);
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError' || deadline.aborted) return { ok: false, error_type: 'timeout', error_message: 'web_search timed out' };
    if (error instanceof SyntaxError) return { ok: false, error_type: 'SyntaxError', error_message: 'web search returned invalid JSON' };
    return { ok: false, error_type: 'FetchError', error_message: 'web search request failed' };
  }
  const raw = Array.isArray(payload?.results) ? payload.results
    : Array.isArray(payload?.data) ? payload.data : [];
  const results = [];
  for (const [index, item] of raw.entries()) {
    if (!item || typeof item !== 'object') continue;
    results.push({
      title: String(item.title || ''), url: String(item.url || item.link || ''),
      snippet: String(item.snippet || item.summary || ''), rank: index + 1, provider: 'http',
    });
    if (results.length >= Math.max(1, maxResults || 5)) break;
  }
  return { ok: true, query, provider: 'http', results };
}

async function webSearchKsyun({ fetch: fetchImpl, providerConfig, query, maxResults, signal }) {
  const apiKey = String(providerConfig.apiKey || '').trim();
  if (!apiKey) return {
    ok: false, error_type: 'provider_not_configured',
    error_message: 'ksyun web search api key is not configured (KSADK_WEB_SEARCH_API_KEY / KSADK_MCP_KEY / KSC_AIPRO_API_KEY)',
  };
  const endpoint = String(providerConfig.baseUrl || 'https://search.aipro.ksyun.com/v1/aisearch/search').trim();
  const scope = String(providerConfig.scope || 'webpage').trim().toLowerCase() || 'webpage';
  const size = Math.max(1, Math.min(maxResults || 5, 200));
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
  const body = JSON.stringify({ q: query, scope, size });
  const deadline = deadlineSignal(signal, SEARCH_TIMEOUT_MS);
  let response, payload;
  try {
    response = await fetchImpl(endpoint, { method: 'POST', headers, body, redirect: 'manual', signal: deadline });
    if (isRedirect(response.status)) { try { await response.body?.cancel?.(); } catch {} return { ok: false, error_type: 'provider_not_configured', error_message: 'web search provider redirected unexpectedly' }; }
    if (!response.ok) {
      try { await response.body?.cancel?.(); } catch { /* already closed */ }
      throw Object.assign(new Error(`HTTP ${response.status}`), { name: 'HTTPStatusError' });
    }
    const { text } = await readBoundedBody(response, { signal: deadline });
    payload = JSON.parse(text);
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError' || deadline.aborted) return { ok: false, error_type: 'timeout', error_message: 'web_search timed out' };
    if (error instanceof SyntaxError) return { ok: false, error_type: 'SyntaxError', error_message: 'web search returned invalid JSON' };
    return { ok: false, error_type: 'FetchError', error_message: 'web search request failed' };
  }
  const raw = Array.isArray(payload?.webpages) ? payload.webpages
    : Array.isArray(payload?.results) ? payload.results
    : Array.isArray(payload?.data) ? payload.data : [];
  const results = [];
  for (const [index, item] of raw.entries()) {
    if (!item || typeof item !== 'object') continue;
    results.push({
      title: String(item.title || ''), url: String(item.url || item.link || ''),
      snippet: String(item.snippet || item.summary || ''), date: String(item.date || item.published_at || ''),
      rank: index + 1, provider: 'ksyun',
    });
    if (results.length >= size) break;
  }
  return { ok: true, query, provider: 'ksyun', results };
}

async function webSearch({ fetch: fetchImpl, providerConfig, query, maxResults, recencyDays, signal }) {
  const text = String(query || '').trim();
  if (!text) return { ok: false, error_type: 'query_required', error_message: 'query is required' };
  const provider = String(providerConfig?.provider || '').trim().toLowerCase();
  if (!provider) return { ok: false, error_type: 'provider_not_configured', error_message: 'web search provider is not configured' };
  if (provider === 'fake') {
    const limit = Math.max(1, maxResults || 5);
    return {
      ok: true, query: text, provider: 'fake',
      results: [{
        title: `Fake result for ${text}`,
        url: `https://example.com/search?q=${encodeURIComponent(text)}`,
        snippet: 'Fake search result generated by ksadk test provider.', rank: 1, provider: 'fake',
      }].slice(0, limit),
    };
  }
  if (provider === 'http') return webSearchHttp({ fetch: fetchImpl, providerConfig, query: text, maxResults, recencyDays, signal });
  if (provider === 'ksyun') return webSearchKsyun({ fetch: fetchImpl, providerConfig, query: text, maxResults, signal });
  return { ok: false, error_type: 'provider_not_configured', error_message: `unsupported web search provider: ${provider}` };
}

/** Snapshot the full locked request context before an authorization await.
 *  copy/canonical require JSON values, so absent optional fields are normalized
 *  to null. The original AbortSignal identity and the locked definition are
 *  captured for drift detection; the authorize callback receives an isolated
 *  JSON copy that includes the signal identity (read-only, not the live signal)
 *  and executionFence so it can inspect the full trusted context without
 *  mutating the live request. */
function snapshotContext(request, definition) {
  return {
    sessionId: request.sessionId,
    scope: request.scope == null ? null : copy(request.scope),
    runId: request.runId ?? null,
    turnId: request.turnId ?? null,
    buildId: request.buildId ?? null,
    parentRunId: request.parentRunId ?? null,
    taskChainId: request.taskChainId ?? null,
    operationKey: request.operationKey ?? null,
    executionFence: request.executionFence ?? null,
    call: copy(request.call),
    definition: copy(definition),
    requestDefinition: request.definition == null ? null : copy(request.definition),
    signalIdentity: request.signal ?? null,
  };
}
function contextDrifted(request, snapshot) {
  return request.sessionId !== snapshot.sessionId
    || canonical(request.scope == null ? null : request.scope) !== canonical(snapshot.scope)
    || (request.runId ?? null) !== snapshot.runId
    || (request.turnId ?? null) !== snapshot.turnId
    || (request.buildId ?? null) !== snapshot.buildId
    || (request.parentRunId ?? null) !== snapshot.parentRunId
    || (request.taskChainId ?? null) !== snapshot.taskChainId
    || (request.operationKey ?? null) !== snapshot.operationKey
    || (request.executionFence ?? null) !== snapshot.executionFence
    || canonical(request.call) !== canonical(snapshot.call)
    // The request's own definition (if present) must not change during the
    // authorize await; a swap to a different definition is drift.
    || canonical(request.definition == null ? null : request.definition) !== canonical(snapshot.requestDefinition)
    || (request.signal ?? null) !== snapshot.signalIdentity;
}

/** Shared HTTP/search implementation, after the owning Host has authorized
 * the call. This transport does not grant Native authority or own a Run.
 * DSH callers supply their actual Session/call identity; Native callers keep
 * the full intent/lease checks in createNativeWebTools below. */
export function createWebToolTransport({ fetch: fetchImpl, searchFetch = fetchImpl, providerConfig = {},
  ssrfPolicy = {}, persistOutput, inlineMaxChars } = {}) {
  invariant(typeof fetchImpl === 'function', 'native_web_fetch_missing');
  invariant(typeof searchFetch === 'function', 'native_web_search_fetch_missing');
  invariant(inlineMaxChars === undefined || Number.isSafeInteger(inlineMaxChars) && inlineMaxChars > 0, 'native_web_inline_budget_invalid');
  const sealedProvider = Object.freeze(copy(providerConfig));
  const sealedSsrf = Object.freeze({ allowPrivate: ssrfPolicy?.allowPrivate === true });
  const definitions = nativeWebToolDefinitions(), formal = new Map(definitions.map(item => [item.name, item]));
  return {
    contract: 'agentkit.web-tool-transport/v1', definitions: definitions.map(item => copy(item)),
    async execute(request) {
      const call = request?.call, definition = formal.get(call?.name);
      if (!definition) return { status: 'error', content: { code: 'unknown_tool' } };
      if (!(request.signal instanceof AbortSignal)) return { status: 'error', content: { code: 'invalid_request' } };
      if (!matchesToolExecutionContract(request.definition, definition)) {
        return { status: 'error', content: { code: 'web_definition_mismatch', executed: false } };
      }
      const rejection = toolInputRejection(definition, call);
      if (rejection) return { status: 'error', content: rejection };
      const signal = request.signal;
      const checkCurrent = () => {
        signal.throwIfAborted();
        if (typeof request.assertCurrent === 'function' && request.assertCurrent() !== true)
          throw Object.assign(new Error('Native Web authority expired'), { code: 'web_authority_stale' });
      };
      // All transport context except the signal is JSON data, captured before
      // the first await. In particular persistOutput cannot borrow a changed
      // Session or operation identity from the caller's mutable request.
      const bound = { ...copy(Object.fromEntries(Object.entries(request).filter(([key]) => key !== 'signal' && key !== 'assertCurrent'))), signal };
      const args = bound.call.arguments;
      signal.throwIfAborted();
      try {
        const content = call.name === 'web_fetch'
          ? await webFetch({ fetch: fetchImpl, url: args.url, maxChars: args.max_chars, offset: args.offset_chars, find: args.find, inlineMaxChars, timeout: args.timeout,
            ssrfPolicy: sealedSsrf, signal, persistOutput, request: bound, checkCurrent })
          : await webSearch({ fetch: searchFetch, providerConfig: sealedProvider, query: args.query,
            maxResults: args.max_results, recencyDays: args.recency_days, signal });
        checkCurrent();
        return { status: content.ok ? 'ok' : 'error', content };
      } catch (error) {
        if (signal.aborted) throw error;
        if (error?.code === 'web_authority_stale') return { status: 'error', content: { code: 'web_authority_stale', executed: false } };
        return { status: 'error', content: { ok: false, error_type: 'WebToolError', error_message: 'web tool failed' } };
      }
    },
  };
}

export function createNativeWebTools({
  fetch: fetchImpl, searchFetch = fetchImpl, providerConfig = {}, authorize, ssrfPolicy = {}, sessionId, persistOutput, inlineMaxChars,
} = {}) {
  invariant(typeof fetchImpl === 'function', 'native_web_fetch_missing');
  invariant(typeof searchFetch === 'function', 'native_web_search_fetch_missing');
  invariant(typeof authorize === 'function', 'native_web_authorize_required');
  invariant(typeof sessionId === 'string' && sessionId, 'native_web_session_required');
  const transport = createWebToolTransport({ fetch: fetchImpl, searchFetch, providerConfig, ssrfPolicy, persistOutput, inlineMaxChars });
  const definitions = transport.definitions;
  const formal = new Map(definitions.map(item => [item.name, item]));

  async function execute(request) {
    if (!request || typeof request !== 'object') return { status: 'error', content: { code: 'invalid_request', message: 'request object required' } };
    if (request.sessionId !== sessionId) return { status: 'error', content: { code: 'web_session_mismatch' } };
    const call = request.call;
    if (!call?.name) return { status: 'error', content: { code: 'invalid_request', message: 'request.call.name required' } };
    // A real AbortSignal is mandatory: cancellation must propagate through the
    // whole fetch. A missing or non-AbortSignal signal is rejected up front.
    if (!(request.signal instanceof AbortSignal)) {
      return { status: 'error', content: { code: 'invalid_request', message: 'request.signal (AbortSignal) is required' } };
    }
    const definition = formal.get(call.name);
    if (!definition) return { status: 'error', content: { code: 'unknown_tool', message: `unknown tool: ${call.name}` } };
    // The Host ledger pins the formal definition for this call; if the request
    // carries a definition that does not match the locked formal one, it is
    // forged and must not execute.
    if (!matchesToolExecutionContract(request.definition, definition)) {
      return { status: 'error', content: { code: 'web_definition_mismatch', executed: false } };
    }
    try {
      scopeKey(request.scope);
      invariant([request.runId, request.turnId, request.buildId, request.taskChainId, request.operationKey, call.callId]
        .every(value => typeof value === 'string' && value.trim()), 'web_identity_missing');
      invariant(request.parentRunId === null || typeof request.parentRunId === 'string' && request.parentRunId.trim(), 'web_parent_missing');
      invariant(Number.isSafeInteger(request.executionFence) && request.executionFence > 0, 'web_fence_missing');
    } catch {
      return { status: 'error', content: { code: 'invalid_request', executed: false } };
    }
    const rejection = toolInputRejection(definition, call);
    if (rejection) return { status: 'error', content: rejection };
    request.signal.throwIfAborted();
    const snapshot = snapshotContext(request, request.definition);
    let decision;
    try {
      // The authorize callback receives the full trusted context. The real
      // AbortSignal is passed by identity (AbortSignal is not JSON-cloneable;
      // only an AbortController can abort it, so the callback can await or race
      // on it but cannot abort the fetch itself). This lets authorize cancel
      // its own wait on the signal without losing the live cancellation path.
      const authorizePayload = copy({
        sessionId: snapshot.sessionId, scope: snapshot.scope, runId: snapshot.runId,
        turnId: snapshot.turnId, buildId: snapshot.buildId, parentRunId: snapshot.parentRunId,
        taskChainId: snapshot.taskChainId, operationKey: snapshot.operationKey,
        executionFence: snapshot.executionFence, call: snapshot.call, definition: snapshot.definition,
      });
      authorizePayload.signal = snapshot.signalIdentity;
      decision = await authorize(authorizePayload);
    }
    catch (error) {
      if (request.signal.aborted) throw error;
      return { status: 'error', content: { code: 'authorize_failed', message: 'authorization failed' } };
    }
    // Reject drift after the await: if anything in the trusted context (scope,
    // run, turn, build, parent, taskChain, operationKey, executionFence, call,
    // definition, or the original signal identity) changed, do NOT fetch.
    if (contextDrifted(request, snapshot)) {
      return { status: 'error', content: { code: 'web_context_drift', executed: false } };
    }
    request.signal.throwIfAborted();
    if (decision !== 'allow') {
      if (decision?.status === 'approval_required' && typeof decision.interactionId === 'string') return decision;
      return { status: 'error', content: { code: 'policy_denied', executed: false } };
    }
    if (typeof request.assertCurrent === 'function' && request.assertCurrent() !== true)
      return { status: 'error', content: { code: 'web_authority_stale', executed: false } };
    return transport.execute(request);
  }

  // Return fresh deep copies of the definitions so callers cannot mutate the
  // formal map through the returned array (the formal map stays the trusted
  // source of truth for every execute).
  return { definitions: definitions.map(item => copy(item)), execute, contract: NATIVE_WEB_TOOLS_CONTRACT };
}
