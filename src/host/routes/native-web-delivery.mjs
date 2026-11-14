import { realpath } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { createBrowserWorkspaceServer, resolveBrowserWorkspaceEntry } from '@kingsoftcloud/agentkit-harness-node/native/browser-workspace-server';
import * as engineViewAdapter from '@kingsoftcloud/agentkit-harness-ui/engine-view/adapter';
import { NATIVE_ENGINE_EVENT } from '../../providers/native-engine-runtime.mjs';

const { ENGINE_EVENT_SCHEMA, engineWebDeliveries, relativeDeliveryPath } = engineViewAdapter;
const previewLimit = 8;
const imageLimit = 8 * 1024 * 1024;
const imageTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const imageType = path => relativeDeliveryPath(path) ? imageTypes[extname(path).toLowerCase()] : undefined;

function isWorkspaceFile(root, absolutePath) {
  const path = relative(root, absolutePath);
  return Boolean(path) && !isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep);
}

async function deliveryEvidenceResponse(ctx, runtime, { target, sessionId, root, mode, path, request, headers, application }) {
  const { event, runId } = target.data;
  const saved = event.deliveryEvidence;
  const refreshed = saved?.basis === 'run-net-diff/v1' ? null
    : await runtime.readDeliveryEvidence({ sessionId, runId, cwd: root, signal: request.signal }).catch(() => null);
  const evidence = refreshed?.basis === 'run-net-diff/v1' ? refreshed : saved ?? refreshed;
  const workspaceRoot = await realpath(root), scope = { sessionId, workspaceRoot };
  const exists = async (file, maxBytes) => {
    try {
      const fact = await ctx.workspaceFiles.stat(scope, file, request.signal);
      return isWorkspaceFile(workspaceRoot, fact.absolutePath) && (maxBytes === undefined || fact.bytes <= maxBytes);
    } catch { return false; }
  };
  const images = (Array.isArray(evidence?.screenshots) ? evidence.screenshots : []).slice(0, 8).filter(imageType);
  if (mode === 'image') {
    if (!images.includes(path) || !await exists(path, imageLimit)) return new Response(null, { status: 404, headers });
    const file = await ctx.workspaceFiles.readBytes(scope, path, {}, request.signal);
    if (!isWorkspaceFile(workspaceRoot, file.absolutePath) || file.data.byteLength > imageLimit)
      return new Response(null, { status: 404, headers });
    return new Response(request.method === 'HEAD' ? null : file.data, { headers: { ...headers,
      'content-type': imageType(path), 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" } });
  }
  const files = (Array.isArray(evidence?.files) ? evidence.files : []).slice(0, 96).filter(file => relativeDeliveryPath(file?.path));
  const [checkedFiles, checkedImages] = await Promise.all([
    Promise.all(files.map(async file => file.deleted === true || await exists(file.path) ? file : null)),
    Promise.all(images.map(async file => await exists(file, imageLimit) ? file : null)),
  ]);
  return Response.json({ files: checkedFiles.filter(Boolean), screenshots: checkedImages.filter(Boolean),
    truncated: evidence?.truncated === true, ...(application ? { application: { path: application.path } } : {}) }, { headers });
}

function applicationBinding({ workspaceRoot, origin, entryPath }) {
  if (!isAbsolute(workspaceRoot ?? '') || !relativeDeliveryPath(entryPath) || !/\.html?$/i.test(entryPath)) return null;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return { root: resolve(workspaceRoot), url: url.href, path: entryPath };
  } catch { return null; }
}

/** An application target must be bound by the host and declared by the Run.
 * Static deliveries continue to use their own isolated file server. */
export function registerNativeWebDelivery(ctx, runtime, config = {}) {
  if (typeof engineWebDeliveries !== 'function' || typeof relativeDeliveryPath !== 'function') return;
  const defaultBinding = applicationBinding(config);
  const previews = new Map();
  const lifetime = new AbortController();
  ctx.effect(() => async () => {
    lifetime.abort();
    await Promise.allSettled([...previews.values()].map(preview => preview.then(value => value.close())));
    previews.clear();
  });
  const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };
  ctx.connection.fetch.register({
    path: '/api/agentkit.native-web-delivery', methods: ['GET', 'HEAD'], requestBody: 'buffered',
    fetch: async request => {
      const url = new URL(request.url);
      const { searchParams } = url;
      // Connection uses a synthetic URL origin; the browser host is preserved in the header.
      const previewHost = request.headers.get('host');
      if (!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(previewHost ?? ''))
        return new Response(null, { status: 404, headers });
      const sessionId = searchParams.get('sessionId'), rawSeq = searchParams.get('seq'), path = searchParams.get('path'), mode = searchParams.get('mode');
      const seq = Number(rawSeq);
      if (!sessionId || !/^\d+$/.test(rawSeq ?? '') || !Number.isSafeInteger(seq) || (mode !== 'summary' && !path))
        return new Response(null, { status: 400, headers });
      try {
        const { session, target } = await ctx.sessionQuery.readEvent({ sessionId, seq, before: 0, after: 0 }, request.signal);
        const root = session.cwd;
        const event = target.data?.event;
        if (target.type !== NATIVE_ENGINE_EVENT || target.ignorable !== true || typeof root !== 'string' || !isAbsolute(root)
          || event?.schema !== ENGINE_EVENT_SCHEMA || event.kind !== 'run.terminal' || event.title !== 'completed')
          return new Response(null, { status: 404, headers });
        const binding = applicationBinding(runtime.applicationPreview?.(root) ?? {}) ?? defaultBinding;
        const application = binding && await realpath(root) === await realpath(binding.root)
          && event.deliverables?.some(item => item.path === binding.path && ['file', 'web'].includes(item.kind))
          ? binding : null;
        if (mode === 'summary' || mode === 'image')
          return await deliveryEvidenceResponse(ctx, runtime, { target, sessionId, root, mode, path, request, headers, application });
        if (searchParams.get('application') === '1') {
          if (!application || application.path !== path) return new Response(null, { status: 404, headers });
          resolveBrowserWorkspaceEntry(root, path);
          if (request.method === 'HEAD') return new Response(null, { status: 204, headers });
          if (mode === 'sidebar') return Response.json({ url: application.url }, { headers });
          return new Response(null, { status: 302, headers: { ...headers, location: application.url } });
        }
        const delivery = engineWebDeliveries(event).find(item => item.path === path);
        if (!delivery) return new Response(null, { status: 404, headers });
        resolveBrowserWorkspaceEntry(root, path);
        if (request.method === 'HEAD') return new Response(null, { status: 204, headers });
        request.signal.throwIfAborted();
        const key = JSON.stringify([sessionId, seq, path, root, previewHost]);
        let preview = previews.get(key);
        if (preview) previews.delete(key);
        else {
          preview = createBrowserWorkspaceServer({ root, path, projectRoot: delivery.root,
            interactivePreview: true, previewHost, signal: lifetime.signal });
          void preview.catch(() => { if (previews.get(key) === preview) previews.delete(key); });
        }
        previews.set(key, preview);
        if (previews.size > previewLimit) {
          const [oldest, retired] = previews.entries().next().value;
          previews.delete(oldest);
          void retired.then(value => value.close()).catch(() => {});
        }
        const { url: location } = await preview;
        if (searchParams.get('mode') === 'sidebar') return Response.json({ url: location }, { headers });
        return new Response(null, { status: 302, headers: { ...headers, location } });
      } catch {
        return new Response(request.method === 'HEAD' ? null : '交付文件不可用，请返回会话。', { status: 404, headers });
      }
    },
  });
}
