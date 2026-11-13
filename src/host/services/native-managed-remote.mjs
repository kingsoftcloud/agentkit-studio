import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseNativeJson } from '@kingsoftcloud/agentkit-harness-core';
import { createNativeKernelPermitVerifier } from '@kingsoftcloud/agentkit-harness-node/native/kernel-permit';
import { MANAGED_NATIVE_KERNEL_PATH as PATH } from '@kingsoftcloud/agentkit-harness-node/native/managed-kernel-http';
import { engineServiceEndpoint, engineServiceFetch } from '../../providers/engine-service-client.mjs';

const routes = new Map([
  [PATH + '/commands', { field: 'command' }],
  [PATH + '/status', { field: 'query', operation: 'get_status' }],
  [PATH + '/events', { field: 'subscription', operation: 'subscribe_events' }],
]);
const requestLimit = 2 * 1024 ** 2;
const drainLimit = 4 * requestLimit;

/** Admit the Server permit at the Studio boundary. Harness still verifies
 * it and owns durable nonce consumption and command admission. */
export function registerStudioManagedNativeRemote(ctx, { endpoint, token, caFile, target, verificationKeys,
  platformApprovals = false } = {}) {
  const verifier = createNativeKernelPermitVerifier({ target, verificationKeys, requireBoundApproval: platformApprovals });
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
      const route = routes.get(path);
      if (request.method !== 'POST' || !route) return fail(404, 'NATIVE_KERNEL_UNSUPPORTED');
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
      const bytes = Buffer.concat(chunks);
      let envelope;
      try {
        envelope = parseNativeJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope))
          return fail(400, 'NATIVE_KERNEL_INVALID_REQUEST');
      } catch { return fail(400, 'NATIVE_KERNEL_INVALID_REQUEST'); }
      const payload = envelope[route.field];
      try { await verifier.verify(envelope.permit, payload, route.operation ?? payload?.command_type); }
      catch { return fail(403, 'NATIVE_KERNEL_AUTHORIZATION_FAILED'); }
      signal.throwIfAborted();
      timer = setTimeout(closed, 30000);
      upstream = await fetchImpl(origin + path, {
        method: 'POST', redirect: 'error', signal, body: bytes,
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
