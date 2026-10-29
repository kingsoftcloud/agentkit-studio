/** Preprod runtime TLS exception; never changes the process-wide trust policy. */
import { Agent, fetch as undiciFetch } from 'undici';

// Preprod personal-assistant gateway hosts on the frozen preprod chain:
// pa-desktop-pre 是主预发（agentengine），pa-desktop-dev 是 PA 团队 dev 环境。
const PA_GATEWAY_HOSTS = new Set([
  'pa-desktop-pre.agent-pre.kspmas.ksyun.com',
  'pa-desktop-dev.agent-pre.kspmas.ksyun.com',
]);

export function createCloudRuntimeFetch({ configuration, fetchImpl = fetch, runtimeFetchImpl = undiciFetch, createDispatcher = () => new Agent({ connect: { rejectUnauthorized: false } }) }) {
  let dispatcher, closed = false;
  const assertOpen = () => { if (closed) throw Object.assign(new Error('Runtime transport is closed'), { code: 'RUNTIME_TRANSPORT_CLOSED' }); };
  const request = async (input, init = {}) => {
    assertOpen();
    const url = new URL(input instanceof Request ? input.url : input);
    const preprodRuntime = url.protocol === 'https:' && !url.port && !url.username && !url.password
      // Preprod runtime and personal-assistant gateway hosts share the frozen
      // preprod chain. Keep the exception on this exact domain and single-label
      // shape only; public production origins keep the process TLS policy.
      && (/^ar-[A-Za-z0-9-]+\.agent-pre\.kspmas\.ksyun\.com$/.test(url.hostname)
        || PA_GATEWAY_HOSTS.has(url.hostname));
    if (preprodRuntime) {
      const { values } = await (await configuration).resolve();
      assertOpen();
      if (values.cloudRegion?.toLowerCase() === 'pre-online') {
        dispatcher ||= createDispatcher();
        // Never follow a redirect with this dispatcher: the exception belongs
        // only to the exact preprod runtime origin checked above.
        // Node's bundled fetch may use a different Undici dispatcher protocol.
        // Pair this dispatcher with the fetch exported by the same dependency.
        if (input instanceof Request) {
          const request = new Request(input, init);
          return runtimeFetchImpl(request.url, { method: request.method, headers: request.headers,
            body: request.body, signal: request.signal, duplex: 'half', dispatcher, redirect: 'error' });
        }
        return runtimeFetchImpl(input, { ...init, dispatcher, redirect: 'error' });
      }
    }
    return fetchImpl(input, init);
  };
  request.close = () => { closed = true; return dispatcher?.destroy(); };
  return request;
}
