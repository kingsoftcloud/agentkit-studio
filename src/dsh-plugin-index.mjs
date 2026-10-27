/** Remote catalog refresh for the Studio DSH plugin market.
 *
 * The built-in curated list always works offline. When
 * `AGENTKIT_STUDIO_DSH_PLUGIN_INDEX` (or `DSH_PLUGIN_INDEX_URL`) points at an
 * HTTPS JSON document (localhost HTTP is allowed for development), the market
 * merges that document on top of the built-in rows. A failed refresh never
 * empties the market: the last successful document is reused as stale and the
 * error is reported to the client as a hint.
 */
import { hostFetch } from './http-fetch.mjs';
import {
  dshCuratedEntries,
  mergeCatalogEntries,
  normalizeCatalogDocument,
  DSH_PLUGIN_INDEX_ENV,
  DSH_PLUGIN_INDEX_ENV_ALIASES,
} from './dsh-plugin-catalog.mjs';

export class DshPluginIndexError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DshPluginIndexError';
    this.code = code;
    this.details = details;
  }
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function localHost(hostname) {
  return LOCAL_HOSTS.has(String(hostname || '').replace(/^\[|\]$/g, ''));
}

/** Read the operator-provided index location; empty means built-in only. */
export function pluginIndexUrl(env = process.env) {
  for (const name of DSH_PLUGIN_INDEX_ENV_ALIASES) {
    const value = typeof env?.[name] === 'string' ? env[name].trim() : '';
    if (value) return value;
  }
  return '';
}

/** Reject plaintext or non-HTTP locations; localhost HTTP is the dev escape hatch. */
export function acceptPluginIndexUrl(value) {
  const candidate = String(value || '').trim();
  if (!candidate) return null;
  let url;
  try { url = new URL(candidate); } catch { return null; }
  if (url.username || url.password) return null;
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && localHost(url.hostname)) return url;
  return null;
}

function failure(error) {
  if (error instanceof DshPluginIndexError) return { code: error.code, message: error.message };
  if (error?.name === 'AbortError') return { code: 'DSH_PLUGIN_INDEX_TIMEOUT', message: '远程插件索引请求超时' };
  return { code: 'DSH_PLUGIN_INDEX_UNAVAILABLE', message: String(error?.message || '远程插件索引不可用').slice(0, 300) };
}

export function createDshPluginIndex({
  env = process.env,
  fetchImpl = hostFetch,
  now = () => Date.now(),
  cacheTtlMs = 10 * 60 * 1000,
  timeoutMs = 8000,
  maxBytes = 512 * 1024,
} = {}) {
  const requested = pluginIndexUrl(env);
  const target = acceptPluginIndexUrl(requested);
  const rejected = Boolean(requested) && !target;
  let cache = null;

  async function fetchDocument() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(target.href, {
        signal: controller.signal,
        headers: { accept: 'application/json', 'user-agent': 'agentkit-studio-plugin-market' },
      });
      if (!response || typeof response.ok !== 'boolean') throw new DshPluginIndexError('DSH_PLUGIN_INDEX_FETCH_FAILED', '远程插件索引请求失败');
      if (!response.ok) throw new DshPluginIndexError('DSH_PLUGIN_INDEX_HTTP_ERROR', `远程插件索引返回 HTTP ${response.status}`);
      const body = await response.text();
      if (typeof body !== 'string' || body.length > maxBytes) throw new DshPluginIndexError('DSH_PLUGIN_INDEX_TOO_LARGE', '远程插件索引体积超出限制');
      let document;
      try { document = JSON.parse(body); } catch { throw new DshPluginIndexError('DSH_PLUGIN_INDEX_INVALID_JSON', '远程插件索引不是有效 JSON'); }
      try {
        return normalizeCatalogDocument(document);
      } catch (error) {
        throw new DshPluginIndexError(error?.code || 'DSH_PLUGIN_INDEX_INVALID', error?.message || '远程插件索引格式无效');
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async function load({ force = false } = {}) {
    const builtin = dshCuratedEntries();
    if (!target) {
      return {
        entries: builtin,
        info: {
          source: 'builtin',
          indexUrl: '',
          updatedAt: '',
          ...(rejected ? { error: { code: 'DSH_PLUGIN_INDEX_URL_REJECTED', message: '插件索引地址必须是 HTTPS（开发环境允许 localhost HTTP）' } } : {}),
        },
      };
    }
    const fresh = cache && now() - cache.at < cacheTtlMs;
    if (fresh && !force) {
      return {
        entries: mergeCatalogEntries(builtin, cache.entries),
        info: { source: 'builtin+remote', indexUrl: target.href, updatedAt: cache.updatedAt },
      };
    }
    try {
      const document = await fetchDocument();
      cache = { entries: document.entries, updatedAt: document.updatedAt, at: now() };
      return {
        entries: mergeCatalogEntries(builtin, cache.entries),
        info: {
          source: 'builtin+remote',
          indexUrl: target.href,
          updatedAt: cache.updatedAt,
          ...(document.skipped ? { skipped: document.skipped } : {}),
        },
      };
    } catch (error) {
      return {
        entries: cache ? mergeCatalogEntries(builtin, cache.entries) : builtin,
        info: {
          source: cache ? 'builtin+remote' : 'builtin',
          indexUrl: target.href,
          updatedAt: cache?.updatedAt || '',
          error: failure(error),
          ...(cache ? { stale: true } : {}),
        },
      };
    }
  }

  return {
    load,
    refresh: () => load({ force: true }),
    get indexUrl() { return target?.href || ''; },
    get rejected() { return rejected; },
  };
}

export { DSH_PLUGIN_INDEX_ENV };
