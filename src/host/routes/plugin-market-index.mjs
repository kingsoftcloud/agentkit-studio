/** Public route serving the bundled community plugin index.
 *
 * DSH's official plugin market reads `format: 1` documents over http(s) and
 * refuses redirects, so the index Studio ships has to be reachable at a stable
 * URL. Serving it from this Host keeps the market usable with no configuration
 * and no third-party origin: the official reader fetches
 * `http://127.0.0.1:<port>/api/agentkit.plugin-market/index.json` like any
 * other source.
 *
 * The document is public, read-only catalog metadata, so the route sits outside
 * the authenticated control plane. It is read once per process and cached for
 * five minutes; refreshing the bundled index needs a new release.
 */
import { readFile } from 'node:fs/promises';
import { PLUGIN_MARKET_INDEX_PATH } from '../../plugin-market.mjs';

/** The bundled index, resolved from the package root. */
const INDEX_FILE = new URL('../../../assets/plugin-market/index.json', import.meta.url);

const CACHE_CONTROL = 'public, max-age=300';

export function registerPluginMarketIndexRoute(ctx) {
  ctx.inject(['webServer'], (webCtx) => {
    let document;
    const load = async () => {
      document ??= await readFile(INDEX_FILE, 'utf8');
      return document;
    };
    const handler = async (request, response) => {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { allow: 'GET, HEAD' });
        response.end();
        return;
      }
      let body;
      try {
        body = await load();
      } catch {
        response.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
        response.end('{"error":"plugin index unavailable"}');
        return;
      }
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(Buffer.byteLength(body)),
        'cache-control': CACHE_CONTROL,
        'x-content-type-options': 'nosniff',
      });
      response.end(request.method === 'HEAD' ? undefined : body);
    };
    const registration = webCtx.webServer.register({ kind: 'exact', path: PLUGIN_MARKET_INDEX_PATH, handler });
    webCtx.effect(() => registration, 'agentkit-studio: plugin market index route');
  });
}
