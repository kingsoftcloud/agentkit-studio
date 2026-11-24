/** Studio web transport for explicitly bound DSH tools. */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { parse as parseHtml, defaultTreeAdapter } from 'parse5';
import { copy } from '../contracts/native-values.mjs';
import { isBlockedAddress } from './ssrf-pinned-fetch.mjs';

const DEFAULT_MAX_CHARS = 50_000;
const MAX_REDIRECTS = 5;
const SEARCH_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

function def(name, description, parameters, opts) {
  return {
    name, description, parameters: copy(parameters),
    readOnly: true, concurrentSafe: true, permissions: [],
    timeoutMs: opts.timeoutMs, contextRole: 'none', observationRole: 'none',
    progressObservation: false, contextRetention: 'normal',
  };
}

export function studioWebToolDefinitions() {
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
  const preview = points.slice(0, limit);
  return { text: preview.join(''), truncated: originalChars > preview.length, original_chars: originalChars, preview_chars: preview.length };
}

async function validatePublicHttpUrl(url, ssrfPolicy, deadline) {
  let parsed;
  try { parsed = new URL(String(url)); }
  catch { return { ok: false, error_type: 'invalid_url', error_message: 'URL host is required', url }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error_type: 'unsupported_scheme', error_message: 'only http and https URLs are supported', url };
  }
  if (!parsed.hostname || parsed.username || parsed.password) {
    return { ok: false, error_type: 'invalid_url', error_message: 'URL must have a host and no embedded credentials', url };
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
  if (isIP(hostname)) {
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

/** Keep cancellation effective even if a transport exposes a stalled body. */
async function readBoundedBody(response, signal) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    return { text, reachedByteCeiling: false, fullBytes: Buffer.byteLength(text) };
  }
  const stop = () => cancelBody(reader);
  signal.addEventListener('abort', stop, { once: true });
  const chunks = [];
  let bytes = 0, reachedByteCeiling = false;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = MAX_RESPONSE_BYTES - bytes;
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining));
        bytes = MAX_RESPONSE_BYTES;
        reachedByteCeiling = true;
        break;
      }
      chunks.push(value);
      bytes += value.byteLength;
    }
    signal.throwIfAborted();
    return { text: new TextDecoder('utf8', { ignoreBOM: true }).decode(Buffer.concat(chunks, bytes)),
      reachedByteCeiling, fullBytes: bytes };
  } finally {
    signal.removeEventListener('abort', stop);
    if (reachedByteCeiling) stop();
    reader.releaseLock?.();
  }
}

function cancelBody(body) {
  try { Promise.resolve(body?.cancel?.()).catch(() => {}); } catch { /* already closed */ }
}

// One bounded AbortSignal that spans DNS resolution, every redirect hop, and
// the body read. The caller's request.signal is composed in so cancellation
// propagates immediately at any stage.
function deadlineSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function webFetch({ fetch: fetchImpl, url, maxChars, offset = 0, find, timeout, ssrfPolicy, signal, persistOutput, request, checkCurrent }) {
  const current = String(url || '').trim();
  if (!current) return { ok: false, error_type: 'url_required', error_message: 'url is required' };
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.trunc(maxChars) : DEFAULT_MAX_CHARS;
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
      cancelBody(response.body);
      if (location) { currentUrl = String(new URL(location, currentUrl)); continue; }
    }
    deadline.throwIfAborted?.();
    const contentType = response.headers.get('content-type') || '';
    const { text: fullText, reachedByteCeiling, fullBytes } = await readBoundedBody(response, deadline);
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

async function searchProvider({ fetch, providerConfig, query, maxResults, recencyDays, signal, provider }) {
  const ksyun = provider === 'ksyun';
  const endpoint = String(providerConfig.baseUrl || (ksyun ? 'https://search.aipro.ksyun.com/v1/aisearch/search' : '')).trim();
  const apiKey = String(providerConfig.apiKey || '').trim();
  if (!endpoint || ksyun && !apiKey) return { ok: false, error_type: 'provider_not_configured',
    error_message: ksyun ? 'ksyun web search api key is not configured (KSADK_WEB_SEARCH_API_KEY / KSADK_MCP_KEY / KSC_AIPRO_API_KEY)'
      : 'web search base URL is not configured' };
  const requested = Math.max(1, maxResults || 5);
  const size = ksyun ? Math.min(requested, 200) : requested;
  const deadline = deadlineSignal(signal, SEARCH_TIMEOUT_MS);
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  let payload;
  try {
    const url = new URL(endpoint);
    let body;
    if (ksyun) {
      const scope = String(providerConfig.scope || 'webpage').trim().toLowerCase() || 'webpage';
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({ q: query, scope, size });
    } else {
      url.searchParams.set('q', query);
      url.searchParams.set('max_results', String(size));
      if (recencyDays != null) url.searchParams.set('recency_days', String(recencyDays));
    }
    const response = await fetch(url.href, { method: ksyun ? 'POST' : 'GET', headers,
      ...(ksyun ? { body } : {}), redirect: 'manual', signal: deadline });
    if (!response.ok) {
      cancelBody(response.body);
      if (isRedirect(response.status)) return { ok: false, error_type: 'provider_not_configured',
        error_message: 'web search provider redirected unexpectedly' };
      return { ok: false, error_type: 'FetchError', error_message: 'web search request failed' };
    }
    const { text } = await readBoundedBody(response, deadline);
    payload = JSON.parse(text);
  } catch (error) {
    if (signal.aborted) throw error;
    if (deadline.aborted || ['TimeoutError', 'AbortError'].includes(error?.name))
      return { ok: false, error_type: 'timeout', error_message: 'web_search timed out' };
    if (error instanceof SyntaxError) return { ok: false, error_type: 'SyntaxError', error_message: 'web search returned invalid JSON' };
    return { ok: false, error_type: 'FetchError', error_message: 'web search request failed' };
  }
  const rows = (ksyun ? [payload?.webpages, payload?.results, payload?.data] : [payload?.results, payload?.data]).find(Array.isArray) ?? [];
  const results = [];
  for (const [index, item] of rows.entries()) {
    if (!item || typeof item !== 'object') continue;
    results.push({ title: String(item.title || ''), url: String(item.url || item.link || ''),
      snippet: String(item.snippet || item.summary || ''), ...(ksyun ? { date: String(item.date || item.published_at || '') } : {}),
      rank: index + 1, provider });
    if (results.length >= size) break;
  }
  return { ok: true, query, provider, results };
}

export async function webSearch({ fetch: fetchImpl, providerConfig, query, maxResults, recencyDays, signal }) {
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
  if (provider === 'http' || provider === 'ksyun')
    return searchProvider({ fetch: fetchImpl, providerConfig, query: text, maxResults, recencyDays, signal, provider });
  return { ok: false, error_type: 'provider_not_configured', error_message: `unsupported web search provider: ${provider}` };
}
