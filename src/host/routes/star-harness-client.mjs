import { readFile } from 'node:fs/promises';
import { ROUTEMIND_INTRODUCTION_PATH, STAR_HARNESS_INTRODUCTION_PATH } from '../../star-harness-detail.mjs';

function registerIntroductionImage(ctx, path, file) {
  const introductionFile = new URL('../../../assets/' + file, import.meta.url);
  let image;
  ctx.connection.fetch.register({
    path, methods: ['GET', 'HEAD'], requestBody: 'buffered',
    async fetch(request) {
      image ??= await readFile(introductionFile);
      return new Response(request.method === 'HEAD' ? null : image, { headers: {
        'content-type': 'image/jpeg', 'content-length': String(image.length),
        'cache-control': 'private, max-age=300', 'x-content-type-options': 'nosniff',
      } });
    },
  });
}

export function registerStarHarnessIntroductionRoute(ctx) {
  registerIntroductionImage(ctx, STAR_HARNESS_INTRODUCTION_PATH, 'star-harness-introduction.jpg');
}

export function registerRouteMindIntroductionRoute(ctx) {
  registerIntroductionImage(ctx, ROUTEMIND_INTRODUCTION_PATH, 'routemind-introduction.jpg');
}

export const STAR_HARNESS_CLIENT_PATH = '/api/agentkit.star-harness.client.mjs';

export function starHarnessClientResponse(request, asset) {
  const query = new URL(request.url).searchParams;
  if (query.get('descriptor') === '1' && !query.has('sha256')) {
    return new Response(request.method === 'HEAD' ? null : JSON.stringify(asset ? { version: asset.version, sha256: asset.sha256 } : null),
      { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
  }
  if (!asset || query.get('sha256') !== asset.sha256)
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
