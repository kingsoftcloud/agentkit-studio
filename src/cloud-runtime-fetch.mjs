/** Preprod runtime TLS exception; never changes the process-wide trust policy. */
import { Agent } from 'undici';

export function createCloudRuntimeFetch({ configuration, fetchImpl = fetch, createDispatcher = () => new Agent({ connect: { rejectUnauthorized: false } }) }) {
  let dispatcher, closed = false;
  const assertOpen = () => { if (closed) throw Object.assign(new Error('Runtime transport is closed'), { code: 'RUNTIME_TRANSPORT_CLOSED' }); };
  const request = async (input, init = {}) => {
    assertOpen();
    const url = new URL(input instanceof Request ? input.url : input);
    const preprodRuntime = url.protocol === 'https:' && !url.port && !url.username && !url.password
      && /^ar-[A-Za-z0-9-]+\.agent-pre\.kspmas\.ksyun\.com$/.test(url.hostname);
    if (preprodRuntime) {
      const { values } = await (await configuration).resolve();
      assertOpen();
      if (values.cloudRegion?.toLowerCase() === 'pre-online') {
        dispatcher ||= createDispatcher();
        // Never follow a redirect with this dispatcher: the exception belongs
        // only to the exact preprod runtime origin checked above.
        return fetchImpl(input, { ...init, dispatcher, redirect: 'error' });
      }
    }
    return fetchImpl(input, init);
  };
  request.close = () => { closed = true; return dispatcher?.destroy(); };
  return request;
}
