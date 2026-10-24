/** Versioned trusted Server transport. The Gateway's A2A assertion is never a
 * Kernel permit. Every mutation/read still verifies its own Server signature. */
import { canonical, invariant, parseNativeJson } from '../../packages/agentkit-harness-core/dist/index.mjs';

export const MANAGED_NATIVE_KERNEL_PATH = '/_agentkit/native-kernel/v1';
export function createManagedNativeKernelHttp(runtime) {
  invariant(typeof runtime?.receive === 'function' && typeof runtime.subscribe === 'function', 'NATIVE_KERNEL_HTTP_CONFIGURATION_INVALID');
  const lifetime = new AbortController(), responses = new Set();
  const json = (response, status, body) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(canonical(body)); };
  async function handle(request, response, { signal } = {}) {
    const disconnected = new AbortController();
    const scoped = AbortSignal.any([lifetime.signal, disconnected.signal, ...(signal ? [signal] : [])]);
    const stop = () => disconnected.abort(); response.once('close', stop); responses.add(response);
    const abort = () => response.destroy(); scoped.addEventListener('abort', abort, { once: true });
    let iterator;
    try {
      scoped.throwIfAborted();
      const path = request.url?.split('?')[0];
      invariant(request.method === 'POST' && [MANAGED_NATIVE_KERNEL_PATH + '/commands', MANAGED_NATIVE_KERNEL_PATH + '/status',
        MANAGED_NATIVE_KERNEL_PATH + '/events'].includes(path) && request.url === path, 'NATIVE_KERNEL_HTTP_UNSUPPORTED');
      const chunks = []; let size = 0;
      for await (const chunk of request) { scoped.throwIfAborted(); size += chunk.length;
        invariant(size <= 2 * 1024 ** 2, 'NATIVE_KERNEL_HTTP_BODY_LIMIT'); chunks.push(chunk); }
      const body = parseNativeJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      invariant(body && typeof body === 'object' && !Array.isArray(body), 'NATIVE_KERNEL_COMMAND_INVALID');
      scoped.throwIfAborted();
      if (path.endsWith('/commands')) {
        const receipt = await runtime.receive(body.command, body.permit); scoped.throwIfAborted();
        const status = { accepted: 202, duplicate: 200, rejected: 400, unsupported: 409, queue_full: 429, persistence_uncertain: 503 }[receipt.status];
        json(response, status ?? 503, receipt);
      } else if (path.endsWith('/status')) {
        const status = await runtime.getStatus(body.query, body.permit); scoped.throwIfAborted(); json(response, 200, status);
      } else {
        const source = await runtime.subscribe(body.subscription, body.permit, { signal: scoped });
        scoped.throwIfAborted(); iterator = source[Symbol.asyncIterator]();
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
        response.flushHeaders();
        for (;;) {
          const next = await iterator.next(); scoped.throwIfAborted(); if (next.done) break;
          const fact = next.value;
          if (!response.write(`id: ${fact.seq}\nevent: session-event\ndata: ${canonical(fact)}\n\n`)) {
            await new Promise((resolve, reject) => {
              const onAbort = () => { cleanup(); reject(scoped.reason); };
              const onDrain = () => { cleanup(); resolve(); };
              const cleanup = () => { scoped.removeEventListener('abort', onAbort); response.off('drain', onDrain); };
              scoped.addEventListener('abort', onAbort, { once: true }); response.once('drain', onDrain); if (scoped.aborted) onAbort();
            });
          }
        }
        response.end();
      }
    } catch (error) {
      if (response.headersSent || scoped.aborted) response.destroy();
      else {
        const forbidden = ['NATIVE_KERNEL_PERMIT_INVALID', 'NATIVE_KERNEL_NONCE_REUSED'].includes(error.code);
        const bad = ['NATIVE_KERNEL_COMMAND_INVALID', 'NATIVE_KERNEL_HTTP_BODY_LIMIT', 'NATIVE_KERNEL_CURSOR_INVALID',
          'NATIVE_MANAGED_STUDIO_INPUT_UNSUPPORTED', 'NATIVE_MANAGED_STUDIO_ATTACHMENT_EXPIRED', 'NATIVE_MANAGED_STUDIO_IMAGE_INVALID',
          'invalid_model_json', 'duplicate_model_json_key', 'model_json_nesting_exceeded', 'model_json_integer_digits_exceeded',
          'non_finite_model_json_number', 'non_json_value'].includes(error.code)
          || error instanceof SyntaxError || error instanceof TypeError;
        json(response, forbidden ? 403 : error.code === 'NATIVE_KERNEL_HTTP_UNSUPPORTED' ? 404 : bad ? 400 : 503,
          { error: { code: forbidden ? 'NATIVE_KERNEL_AUTHORIZATION_FAILED' : bad ? 'NATIVE_KERNEL_INVALID_REQUEST' : 'NATIVE_KERNEL_UNAVAILABLE' } });
      }
    } finally {
      scoped.removeEventListener('abort', abort); disconnected.abort(); response.off('close', stop); responses.delete(response);
      try { if (iterator?.return) void Promise.resolve(iterator.return()).catch(() => {}); } catch {}
    }
  }
  return Object.freeze({ handle, close() { lifetime.abort(); for (const response of responses) response.destroy(); } });
}
