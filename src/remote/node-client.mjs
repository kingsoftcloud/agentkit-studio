import { createProductClient } from './control-client.mjs';
import { createCompatibilityMethods } from './compatibility-methods.mjs';
import { createOperationClient } from '../contracts/wire.mjs';

/** Node callers inject an already authenticated DSH Connection. The default
 * REST facade remains in host-remote for callers without that Connection.
 */
export function createNativeHostRemote(options, ErrorType) {
  const connection = options.connection;
  if (typeof connection?.rpc?.call !== 'function') throw new ErrorType('DSH Connection is unavailable', { code: 'HOST_CONNECTION_MISSING' });
  const environment = {
    location: { origin: String(options.baseUrl || 'http://127.0.0.1:8789').replace(/\/$/, ''), hash: '' },
    fetch: options.fetchImpl || globalThis.fetch,
    __AGENTKIT_STUDIO__: { controlPlane: 'agentengine-server', hostUrl: options.baseUrl, sessionToken: options.sessionToken, csrfToken: options.csrfToken },
  };
  const product = createProductClient(connection, { window: environment }, createCompatibilityMethods);
  const result = {};
  const fail = error => {
    if (error?.name === 'AbortError' || error instanceof ErrorType) throw error;
    throw new ErrorType(error?.message || 'Studio operation failed', { code: error?.code, status: error?.status || 0, details: error?.details });
  };
  for (const key of Object.keys(product)) {
    const value = product[key];
    if (typeof value === 'function') result[key] = (...args) => {
      try { return Promise.resolve(value(...args)).catch(fail); } catch (error) { return fail(error); }
    };
    else Object.defineProperty(result, key, { enumerable: true, get: () => product[key] });
  }
  result.operations = createOperationClient(connection, (message, details) => new ErrorType(message, details));
  return result;
}
