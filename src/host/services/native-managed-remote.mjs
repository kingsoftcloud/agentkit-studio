import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { engineServiceEndpoint, engineServiceFetch } from '../../providers/engine-service-client.mjs';

const PATH = '/_agentkit/native-kernel/v1';
const routes = new Set(['commands', 'status', 'events'].map(name => PATH + '/' + name));
const requestLimit = 2 * 1024 ** 2;
const drainLimit = 4 * requestLimit;

/** Forward the existing Server envelope unchanged. The Harness service
 * validates the permit; the Studio service credential is never exposed to
 * the caller and grants no authority to mint or modify a permit. */
export function registerStudioManagedNativeRemote(ctx, { endpoint, token, caFile } = {}) {
  const origin = engineServiceEndpoint(endpoint, token);
  const fetchImpl = engineServiceFetch(endpoint, caFile);
  const lifetime = new AbortController();
  ctx.effect(() => () => lifetime.abort(), 'agentkit-studio: remote managed Native Kernel');
  ctx.inject(['webServer'], webCtx => {
    const release = webCtx.webServer.register({ kind: 'prefix', path: PATH, handler });
    webCtx.effect(() => release, 'agentkit-studio: remote managed Native Kernel transport');
  });

  async function handler(request, response) {
    const disconnect = new AbortController();
    const signal = AbortSignal.any([disconnect.signal, lifetime.signal]);
    const abort = () => response.destroy();
    const closed = () => disconnect.abort();
    const fail = (status, code, close = false) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
        ...(close ? { connection: 'close' } : {}) });
      response.end(JSON.stringify({ error: { code } }));
    };
    response.once('close', closed);
    lifetime.signal.addEventListener('abort', abort, { once: true });
    let upstream, timer;
    try {
      signal.throwIfAborted();
      const path = request.url;
      if (request.method !== 'POST' || !routes.has(path)) return fail(404, 'NATIVE_KERNEL_UNSUPPORTED');
      const chunks = [];
      let size = 0;
      if (Number(request.headers['content-length']) > drainLimit)
        return fail(400, 'NATIVE_KERNEL_INVALID_REQUEST', true);
      // Drain a bounded excess to return a readable protocol error while
      // the client is still sending. Only accepted bytes are buffered.
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        signal.throwIfAborted();
        size += chunk.length;
        if (size > drainLimit) return fail(400, 'NATIVE_KERNEL_INVALID_REQUEST', true);
        if (size <= requestLimit) chunks.push(chunk);
      }
      if (size > requestLimit) return fail(400, 'NATIVE_KERNEL_INVALID_REQUEST');
      timer = setTimeout(closed, 30000);
      upstream = await fetchImpl(origin + path, {
        method: 'POST', redirect: 'error', signal, body: Buffer.concat(chunks),
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      });
      clearTimeout(timer);
      const contentType = upstream.headers.get('content-type')?.split(';')[0].trim();
      const isEvents = path === PATH + '/events' && upstream.ok;
      if (!upstream.body || contentType !== (isEvents ? 'text/event-stream' : 'application/json'))
        return fail(503, 'NATIVE_KERNEL_UNAVAILABLE');
      response.writeHead(upstream.status, {
        'content-type': isEvents ? 'text/event-stream' : 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        ...(isEvents ? { 'x-accel-buffering': 'no' } : {}),
      });
      response.flushHeaders();
      await pipeline(Readable.fromWeb(upstream.body), response, { signal });
    } catch {
      if (!response.destroyed && !lifetime.signal.aborted && !response.headersSent)
        fail(503, 'NATIVE_KERNEL_UNAVAILABLE');
      else if (!response.destroyed) response.destroy();
    } finally {
      clearTimeout(timer);
      response.off('close', closed);
      lifetime.signal.removeEventListener('abort', abort);
      disconnect.abort();
      if (upstream?.body && !upstream.body.locked) await upstream.body.cancel().catch(() => {});
    }
  }
}
