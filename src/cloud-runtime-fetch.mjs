/** Preprod transport uses the Node trust store, including any CA supplied to the Host at startup. */
import { Agent, fetch as undiciFetch } from 'undici';

export function createCloudRuntimeFetch({ configuration, fetchImpl = fetch, runtimeFetchImpl = undiciFetch, createDispatcher = () => new Agent({ connect: { rejectUnauthorized: true } }) }) {
  let dispatcher, closed = false;
  const assertOpen = () => { if (closed) throw Object.assign(new Error('Runtime transport is closed'), { code: 'RUNTIME_TRANSPORT_CLOSED' }); };
  const request = async (input, init = {}) => {
    assertOpen();
    const url = new URL(input instanceof Request ? input.url : input);
    const preprodRuntime = url.protocol === 'https:' && !url.port && !url.username && !url.password
      // Match only the expected preprod runtime origins.
      && /^ar-[A-Za-z0-9-]+\.agent-pre\.kspmas\.ksyun\.com$/.test(url.hostname);
    if (preprodRuntime) {
      const { values } = await (await configuration).resolve();
      assertOpen();
      if (values.cloudRegion?.toLowerCase() === 'pre-online') {
        dispatcher ||= createDispatcher();
        // Keep authenticated requests on the expected runtime origin.
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
