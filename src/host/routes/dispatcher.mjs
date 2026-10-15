import { STUDIO_OPERATION_IDS } from '../../contracts/operations.mjs';

/** Preserve the existing unknown-operation, cancellation and error envelopes. */
export function createControlPlaneDispatcher({ bridge, serverClientPromise, routes }) {
  const allowed = new Set(STUDIO_OPERATION_IDS);
  const independent = new Set(['deployments', 'models', 'settings']);
  for (const endpoint of allowed) {
    if (typeof routes[endpoint.split('/')[0]] !== 'function') {
      throw Object.assign(new Error(`Missing Studio domain route: ${endpoint}`), { code: 'STUDIO_ROUTE_MISSING' });
    }
  }
  return async (endpoint, payload, signal) => {
    signal = AbortSignal.any([bridge.signal, signal].filter(Boolean));
    if (!allowed.has(endpoint)) {
      return { ok: false, error: { code: 'agentkit/not-found', message: 'Unknown AgentKit control endpoint', details: { endpoint } } };
    }
    try {
      signal.throwIfAborted();
      const domain = endpoint.split('/')[0];
      if (!independent.has(domain)) await serverClientPromise;
      signal.throwIfAborted();
      return await routes[domain](endpoint, payload, signal);
    } catch (error) {
      if (signal?.aborted) return { ok: false, error: { code: 'gateway/cancelled', message: 'AgentKit request cancelled', details: {} } };
      return { ok: false, error: { code: error?.code || 'agentkit/server-unavailable', message: error instanceof Error ? error.message : String(error), details: { status: error?.status || 0 } } };
    }
  };
}
