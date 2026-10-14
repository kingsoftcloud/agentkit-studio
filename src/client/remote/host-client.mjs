import { createProductClient } from './product-client.mjs';
import { createCompatibilityMethods } from './compatibility-methods.mjs';

/** Preserve the complete compatibility interface over one scoped transport. */
export function createHostRemote(connection, options) {
  return createProductClient(connection, options, createCompatibilityMethods);
}
