/** The bundled community plugin index DSH's official market reads.
 *
 * DSH 0.2.2-rc.1 owns the plugin market: a static `format: 1` index document,
 * the Host's `pluginMarket` service that fetches, validates, caches, searches
 * and pages it, and the official 已安装 / 发现 tabs. Studio renders no market of
 * its own; it only makes sure a profile has something to show, by serving the
 * community index bundled with the product and adding it as the default source
 * when the user has configured none.
 *
 * The route is public, read-only catalog metadata, so it sits outside the
 * authenticated control plane and caches for five minutes.
 */
import { readFile } from 'node:fs/promises';

/** Public path that serves the bundled community index to the official reader. */
export const PLUGIN_MARKET_INDEX_PATH = '/api/agentkit.plugin-market/index.json';

/** The bundled community index, resolved from the package root. */
const BUILTIN_INDEX_FILE = new URL('../assets/plugin-market/index.json', import.meta.url);

export class PluginMarketUnavailableError extends Error {
  constructor(message = '官方插件索引服务未启用：请在「插件」页启用「自定义插件索引」实验性插件后重试。') {
    super(message);
    this.name = 'PluginMarketUnavailableError';
    this.code = 'PLUGIN_MARKET_UNAVAILABLE';
  }
}

/** Resolve the Host services the index source needs. */
export function createPluginMarketIndexSource({ getService, readIndexFile = () => readFile(BUILTIN_INDEX_FILE, 'utf8') } = {}) {
  let builtin = null;

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

  /**
   * Add the bundled index as the profile's only source when it has none.
   *
   * Startup runs this before the official service may be mounted (enabling the
   * bundle can require a restart), so every outcome is reported rather than
   * thrown: nothing here may block the Host surface.
   */
  async function ensureIndexSource() {
    const market = getService?.('pluginMarket');
    if (!market || typeof market.listIndexes !== 'function' || typeof market.setIndexes !== 'function') {
      return { seeded: false, reason: 'plugin-market-unavailable' };
    }
    let configured;
    try {
      configured = market.listIndexes();
    } catch (error) {
      return { seeded: false, reason: 'indexes-unavailable', message: String(error?.message || error).slice(0, 200) };
    }
    if (Array.isArray(configured) && configured.length) return { seeded: false, reason: 'already-configured' };
    const url = builtinIndexUrl();
    if (!url) return { seeded: false, reason: 'index-url-unavailable' };
    try {
      await market.setIndexes([url]);
      return { seeded: true, url };
    } catch (error) {
      return { seeded: false, reason: 'settings-unavailable', message: String(error?.message || error).slice(0, 200) };
    }
  }

  return { ensureIndexSource, builtinIndexUrl, readBuiltinDocument };
}
