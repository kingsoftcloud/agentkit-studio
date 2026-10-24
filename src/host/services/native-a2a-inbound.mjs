import { join } from 'node:path';
import { invariant } from '../../../packages/agentkit-harness-core/dist/index.mjs';
import { createA2aInboundServer } from '../../providers/native-a2a-inbound-server.mjs';

/** Explicit trusted Host composition. No workspace/preset metadata, ordinary
 * DSH auth headers or environment flags can supply an ingress verifier or
 * turn an outgoing A2A binding into an inbound Server authority. */
export function registerStudioNativeA2aInbound(ctx, { storeDir, configuration } = {}) {
  invariant(typeof storeDir === 'string' && configuration && typeof configuration.assertCurrent === 'function',
    'A2A_INBOUND_CONFIGURATION_INVALID');
  const lifetime = new AbortController(), assertCurrent = configuration.assertCurrent;
  let server;
  ctx.effect(() => () => { lifetime.abort(); return server?.close(); }, 'agentkit-studio: trusted A2A inbound lifetime');
  const guard = () => {
    lifetime.signal.throwIfAborted();
    invariant(configuration.assertCurrent === assertCurrent && ctx.fiber.uid !== null, 'A2A_INBOUND_AUTHORITY_LOST');
    const verdict = assertCurrent();
    if (verdict && typeof verdict.then === 'function') void Promise.resolve(verdict).catch(() => {});
    invariant(verdict === true, 'A2A_INBOUND_AUTHORITY_LOST'); return true;
  };
  guard();
  server = createA2aInboundServer({ ...configuration,
    admissionDirectory: join(storeDir, 'native-harness', 'a2a-inbound', 'admission'),
    taskDirectory: join(storeDir, 'native-harness', 'a2a-inbound', 'tasks'), assertCurrent: guard });
  ctx.inject(['webServer'], webCtx => {
    for (const path of ['/.well-known/agent-card.json', '/a2a/jsonrpc', '/a2a/v1']) {
      const release = webCtx.webServer.register({ kind: path === '/a2a/v1' ? 'prefix' : 'exact', path,
        handler: (request, response) => server.handle(request, response, { signal: lifetime.signal }) });
      webCtx.effect(() => release, `agentkit-studio: trusted A2A inbound ${path}`);
    }
  });
  return Object.freeze({ contract: server.contract, card: server.card });
}
