/** Official DSH plugin-market adapter for the Studio plugin market.
 *
 * DSH 0.2.2-rc.1 ships the plugin index mechanism itself: a static
 * `format: 1` document, a Host service (`pluginMarket`) that fetches,
 * validates, caches and searches it, and the official Discover tab that
 * renders it. Studio no longer aggregates npm search and GitHub metadata at
 * request time; it reads the official service, so one market page costs one
 * request per configured index source instead of sixteen.
 *
 * The service only exists while the experimental custom-index bundle is
 * mounted. When it is not, every entry point rejects with
 * `PLUGIN_MARKET_UNAVAILABLE` so the UI can offer to enable it instead of
 * silently showing an empty shelf.
 *
 * Studio still owns two things the official format does not model: a bundled
 * community index (served from this Host, so the market works with no
 * configuration) and the readiness probes in `dsh-plugin-catalog.mjs`.
 */
import { readFile } from 'node:fs/promises';

/** Public path that serves the bundled community index to the official reader. */
export const PLUGIN_MARKET_INDEX_PATH = '/api/agentkit.plugin-market/index.json';

/** The bundled community index, resolved from the package root. */
const BUILTIN_INDEX_URL = new URL('../assets/plugin-market/index.json', import.meta.url);

/** Largest page the official service returns. */
const PAGE_LIMIT = 100;

export class PluginMarketUnavailableError extends Error {
  constructor(message = '官方插件索引服务未启用：请在「插件」页启用「自定义插件索引」实验性插件后重试。') {
    super(message);
    this.name = 'PluginMarketUnavailableError';
    this.code = 'PLUGIN_MARKET_UNAVAILABLE';
  }
}

function text(value, max) {
  return (typeof value === 'string' || typeof value === 'number' ? String(value) : '')
    .replace(/\s+/gu, ' ').trim().slice(0, max);
}

/** Index titles and descriptions are `LocalizedText`; the market is Chinese-first. */
function localized(value, max) {
  if (typeof value === 'string') return text(value, max);
  if (!value || typeof value !== 'object') return '';
  return text(value.zh || value['zh-CN'] || value.en || Object.values(value)[0], max);
}

/** The exact spec DSH's install check accepts for a listed version. */
function installTargetOf(entry) {
  const listed = entry?.versions?.find(version => version.version === entry.defaultVersion) || entry?.versions?.[0];
  return text(listed?.install?.target, 240) || '';
}

function sortKeyStats(entry) {
  const keys = entry?.metadata?.sortKeys;
  if (!keys || typeof keys !== 'object') return {};
  const downloads = Number(keys.downloads);
  return Number.isFinite(downloads) && downloads > 0 ? { monthlyDownloads: downloads } : {};
}

/** One official market entry as a Studio card. */
export function marketItemFromEntry(entry, { indexUrl = '', indexTitle = '' } = {}) {
  if (!entry || typeof entry !== 'object') return null;
  const name = text(entry.name, 214);
  if (!name) return null;
  const versions = Array.isArray(entry.versions) ? entry.versions : [];
  const installation = entry.installation && typeof entry.installation === 'object' ? entry.installation : {};
  const installed = installation.status !== undefined && installation.status !== 'not-installed';
  return {
    id: name,
    pluginId: name,
    packageName: name,
    displayName: localized(entry.title, 80) || name,
    description: localized(entry.description, 400),
    version: text(entry.defaultVersion, 40) || text(versions[0]?.version, 40),
    installSpec: installTargetOf(entry) || name,
    source: 'index',
    category: text(entry.metadata?.category, 24) || '其他',
    tags: Array.isArray(entry.metadata?.labels) ? entry.metadata.labels.map(label => text(label, 24)).filter(Boolean).slice(0, 8) : [],
    featured: false,
    curated: false,
    homepage: text(entry.homepage, 400),
    repository: text(entry.repository?.url, 400),
    npmUrl: `https://www.npmjs.com/package/${name}`,
    author: text(entry.author, 60),
    stats: sortKeyStats(entry),
    installed,
    installedVersion: text(installation.installedVersion, 40),
    enabled: installation.status === 'installed' || installation.status === 'update-available',
    readOnlyReason: '',
    updateAvailable: installation.status === 'update-available',
    compatibility: versions.find(version => version.version === entry.defaultVersion)?.compatibility,
    versions: versions.slice(0, 20).map(version => ({
      version: text(version.version, 40),
      install: text(version.install?.target, 240),
      ...(version.install?.registry ? { registry: text(version.install.registry, 400) } : {}),
      compatible: version.compatibility?.compatible === true,
    })),
    index: { url: indexUrl, title: indexTitle },
  };
}

/** Create the adapter over the Host's official `pluginMarket` service. */
export function createPluginMarket({ getService, readIndexFile = () => readFile(BUILTIN_INDEX_URL, 'utf8') } = {}) {
  let builtin = null;

  function service() {
    const instance = getService?.('pluginMarket');
    if (!instance) throw new PluginMarketUnavailableError();
    return instance;
  }

  /** Origin of this Host's web server, where the bundled index is served. */
  function builtinIndexUrl() {
    try {
      const origin = getService?.('webServer')?.origin;
      return origin ? `${origin}${PLUGIN_MARKET_INDEX_PATH}` : '';
    } catch {
      return '';
    }
  }

  /** The bundled community index document, read once per process. */
  async function readBuiltinDocument() {
    if (builtin === null) {
      try {
        builtin = JSON.parse(await readIndexFile());
      } catch {
        builtin = undefined;
      }
    }
    if (builtin === undefined) throw new PluginMarketUnavailableError('内置插件索引缺失，请重新安装 Studio。');
    return builtin;
  }

  async function ensureIndexSource() {
    const market = service();
    const configured = market.listIndexes();
    if (configured.length) return configured;
    const url = builtinIndexUrl();
    if (!url) throw new PluginMarketUnavailableError('内置插件索引地址不可用：Host 的 Web 服务尚未就绪。');
    await market.setIndexes([url]);
    // The settings write lands through the Loader's volatile update; fall back
    // to the URL just written so the first market page does not race it.
    const committed = market.listIndexes();
    return committed.length ? committed : [{ url }];
  }

  /**
   * Read one page of every usable index source.
   *
   * A source that refuses the request keeps its error and the other sources
   * still render, mirroring the official Discover tab's per-source state.
   */
  async function discover({ force = false } = {}) {
    const market = service();
    const warnings = [];
    let sources = market.listIndexes();
    if (!sources.some(source => !source.error)) {
      try {
        sources = await ensureIndexSource();
      } catch (error) {
        throw error instanceof PluginMarketUnavailableError ? error : new PluginMarketUnavailableError(`内置插件索引源添加失败：${error?.message || '未知错误'}`);
      }
    }
    const usable = sources.filter(source => !source.error);
    if (!usable.length) {
      const reason = sources.map(source => source.error).filter(Boolean)[0];
      throw new PluginMarketUnavailableError(`插件索引源不可用：${reason || '未配置索引源'}`);
    }
    const pages = await Promise.all(usable.map(async (source) => {
      try {
        return { source, page: await market.search(source.url, { sort: { kind: 'index' }, offset: 0, limit: PAGE_LIMIT, ...(force ? { refresh: true } : {}) }) };
      } catch (error) {
        warnings.push({ code: 'index', message: String(error?.message || '索引读取失败').slice(0, 300), url: source.url });
        return null;
      }
    }));
    const items = [];
    const seen = new Set();
    for (const result of pages) {
      if (!result) continue;
      for (const entry of result.page?.entries || []) {
        const item = marketItemFromEntry(entry, { indexUrl: result.source.url, indexTitle: localized(result.page?.title, 80) });
        if (!item || seen.has(item.id)) continue;
        seen.add(item.id);
        items.push(item);
      }
    }
    return {
      items,
      info: {
        schemaVersion: 1,
        source: 'plugin-market',
        updatedAt: new Date().toISOString(),
        indexes: sources.map(source => ({ url: source.url, title: localized(source.title, 80), error: source.error || '' })),
        total: pages.reduce((sum, result) => sum + (Number(result?.page?.total) || 0), 0),
        warnings,
      },
    };
  }

  async function status() {
    try {
      const market = service();
      return { available: true, indexes: market.listIndexes(), builtinIndexUrl: builtinIndexUrl() };
    } catch (error) {
      return { available: false, indexes: [], builtinIndexUrl: builtinIndexUrl(), reason: error?.message || '' };
    }
  }

  return { discover, ensureIndexSource, status, readBuiltinDocument, builtinIndexUrl };
}
