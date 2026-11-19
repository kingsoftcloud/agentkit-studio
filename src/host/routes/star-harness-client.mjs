export const STAR_HARNESS_CLIENT_PATH = '/api/agentkit.star-harness.client.mjs';

export function starHarnessClientResponse(request, asset) {
  if (!asset || new URL(request.url).searchParams.get('sha256') !== asset.sha256)
    return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  return new Response(request.method === 'HEAD' ? null : asset.bytes, { headers: {
    'content-type': 'text/javascript; charset=utf-8', 'x-content-type-options': 'nosniff',
    'cache-control': 'private, max-age=31536000, immutable',
  } });
}

export function registerStarHarnessClientRoute(ctx, manager) {
  if (!manager) return;
  ctx.connection.fetch.register({
    path: STAR_HARNESS_CLIENT_PATH, methods: ['GET', 'HEAD'], requestBody: 'buffered',
    fetch: request => starHarnessClientResponse(request, manager.clientAsset),
  });
}
