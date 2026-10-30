import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalResourceAdapters } from '../src/local-resource-adapters.mjs';
import { createMcpLoopbackService } from './fixtures/mcp-loopback-service.mjs';

function wait(promise, signal) {
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() => signal.removeEventListener('abort', onAbort));
}

for (const transport of ['http', 'sse']) test(`${transport} cancellation reaches the real MCP handler without closing its reusable connection`, { timeout: 30000 }, async t => {
  const started = Promise.withResolvers(), cancelled = Promise.withResolvers();
  const notification = Promise.withResolvers(), releaseNotification = Promise.withResolvers();
  const abort = new AbortController();
  let notificationSignal, completed = 0;
  t.after(() => { releaseNotification.resolve(); abort.abort(); });
  const service = await createMcpLoopbackService({ transport, getCredential: () => 'synthetic-cancel-token',
    onCall: async (request, extra) => {
      if (!request.params.arguments?.wait) return;
      let onAbort;
      try {
        await new Promise((_, reject) => {
          onAbort = () => { cancelled.resolve(); reject(extra.signal.reason); };
          extra.signal.addEventListener('abort', onAbort, { once: true });
          if (extra.signal.aborted) onAbort();
          started.resolve();
        });
        completed++;
      } finally { extra.signal.removeEventListener('abort', onAbort); }
    },
  });
  t.after(() => service.close());
  const adapters = createLocalResourceAdapters({ credentials: { resolve: async () => ({ value: 'synthetic-cancel-token' }) },
    fetchImpl: async (url, init = {}) => {
      if (typeof init.body === 'string' && JSON.parse(init.body).method === 'notifications/cancelled') {
        notificationSignal = init.signal;
        notification.resolve();
        await releaseNotification.promise;
      }
      return fetch(url, init);
    },
  });
  t.after(() => adapters.close());
  const binding = { resourceId: 'cancel-fixture', endpointUrl: service.endpoint, transport, envRefs: { Authorization: 'MCP_CANCEL_TOKEN' } };
  const result = adapters.callMcpTool(binding, service.toolName, { wait: true }, { signal: abort.signal }).catch(error => error);
  t.after(() => result);
  await wait(started.promise, t.signal);
  abort.abort();
  await wait(notification.promise, t.signal);
  const failure = await wait(result, t.signal);
  assert.equal(notificationSignal.aborted, false, 'closing the transport must not cut off its pending cancellation notification');
  releaseNotification.resolve();
  await wait(cancelled.promise, t.signal);
  assert.equal(failure, abort.signal.reason);
  assert.equal(completed, 0);
  assert.equal((await adapters.callMcpTool(binding, service.toolName))[0].text, service.receipt);
  assert.equal(service.counts.initialized, 1, 'a cancelled request must not discard the shared client');
});
