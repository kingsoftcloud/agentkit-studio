/** Serve engine-delivered task views. The bytes come from the engine and are
 * cached by hash; Studio adds headers that keep them inert outside a sandbox. */
export const NATIVE_ENGINE_VIEW_PATH = '/api/agentkit.native-engine.view';
export const ENGINE_VIEW_HEADERS = {
  'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, max-age=31536000, immutable',
  'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; sandbox allow-scripts",
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
};

export function nativeEngineViewResponse(request, runtime) {
  const sha256 = new URL(request.url).searchParams.get('sha256') || '';
  const html = /^[a-f0-9]{64}$/.test(sha256) ? runtime.view(sha256) : null;
  if (!html) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  return new Response(request.method === 'HEAD' ? null : html, { status: 200, headers: ENGINE_VIEW_HEADERS });
}

export function registerNativeEngineView(ctx, runtime) {
  ctx.connection.fetch.register({ path: NATIVE_ENGINE_VIEW_PATH, methods: ['GET', 'HEAD'], requestBody: 'buffered',
    fetch: async request => {
      const cached = nativeEngineViewResponse(request, runtime);
      if (cached.status !== 404 || typeof runtime.resolveView !== 'function') return cached;
      const sha256 = new URL(request.url).searchParams.get('sha256') || '';
      if (!/^[a-f0-9]{64}$/.test(sha256)) return cached;
      try {
        const html = await runtime.resolveView(sha256);
        return html === null ? cached : new Response(request.method === 'HEAD' ? null : html, { status: 200, headers: ENGINE_VIEW_HEADERS });
      } catch {
        return new Response('View unavailable', { status: 503, headers: { 'cache-control': 'no-store' } });
      }
    } });
}
