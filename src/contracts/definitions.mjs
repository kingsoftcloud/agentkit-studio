// @ts-check
import { STUDIO_OPERATION_IDS, STUDIO_CONTROL_CHANNEL } from './operations.mjs';
import { validateOperationRequest, validateOperationResponse } from './wire.mjs';

/** @typedef {import('./operations.mjs').StudioOperationId} StudioOperationId */
/** @typedef {{id: StudioOperationId, domain: string, channel: string,
 * input: typeof validateOperationRequest, output: typeof validateOperationResponse,
 * errors: typeof STUDIO_WIRE_ERRORS, cancellation: typeof STUDIO_CANCELLATION}} OperationDefinition */

// These describe the wire boundary. Agent/Build/resource semantic validation
// stays in its owning domain so legacy coercions and domain error codes survive.
export const STUDIO_WIRE_ERRORS = Object.freeze({
  'agentkit/not-found': { status: 404, meaning: 'Unknown operation' },
  STUDIO_REQUEST_INVALID: { status: 400, meaning: 'Non-serializable JSON request' },
  STUDIO_RESPONSE_INVALID: { status: 502, meaning: 'Malformed response envelope' },
  'gateway/cancelled': { status: 0, meaning: 'Caller or owning Host cancelled' },
  'agentkit/server-unavailable': { status: 0, meaning: 'Unclassified domain failure' },
});
export const STUDIO_CANCELLATION = Object.freeze({
  transport: 'DSH Connection fourth argument: AbortSignal',
  owners: ['caller', 'Host scope'],
  completion: 'one terminal envelope; no retry of unknown effects',
});
/** @type {Readonly<Record<StudioOperationId, OperationDefinition>>} */
export const STUDIO_OPERATIONS = Object.freeze(/** @type {Record<StudioOperationId, OperationDefinition>} */ (
  Object.fromEntries(STUDIO_OPERATION_IDS.map(id => [id, Object.freeze({
    id, domain: id.split('/')[0], channel: STUDIO_CONTROL_CHANNEL,
    input: validateOperationRequest, output: validateOperationResponse,
    errors: STUDIO_WIRE_ERRORS, cancellation: STUDIO_CANCELLATION,
  })]))
));
