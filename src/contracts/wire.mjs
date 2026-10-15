// @ts-check
import { STUDIO_OPERATION_IDS } from './operations.mjs';
import { StudioProtocolError, callStudioOperation as callTransport } from './transport.mjs';
export { StudioProtocolError, validateOperationResponse } from './transport.mjs';

/** @typedef {import('./operations.mjs').StudioOperationId} StudioOperationId */
/** @typedef {import('./types.js').JsonValue} JsonValue */
/** @typedef {import('./types.js').StudioEnvelope} StudioEnvelope */
/** @typedef {import('./types.js').StudioConnection} StudioConnection */

/** @type {ReadonlySet<string>} */
const known = new Set(STUDIO_OPERATION_IDS);

/** Preserve legacy JSON coercion; domain validators still own semantic errors.
 * Functions omitted by JSON and optional undefined payloads remain compatible.
 * @param {StudioOperationId} operation @param {unknown} payload
 */
export function validateOperationRequest(operation, payload) {
  if (!known.has(operation)) throw new StudioProtocolError('agentkit/not-found', 'Unknown AgentKit control endpoint', operation, 404);
  try {
    if (payload !== undefined && JSON.stringify(payload) === undefined) throw new Error('JSON payload required');
  } catch {
    throw new StudioProtocolError('STUDIO_REQUEST_INVALID', 'Studio request must be JSON serializable', operation, 400);
  }
}

/** @param {StudioConnection} connection @param {StudioOperationId} operation
 * @param {unknown} payload @param {AbortSignal} [signal] */
export async function callStudioOperation(connection, operation, payload, signal) {
  validateOperationRequest(operation, payload);
  return callTransport(connection, operation, payload, signal);
}

/** The generic client is derived from the operation registry, not a second list.
 * @param {StudioConnection} connection
 * @param {(message: string, options: {code?: string, status?: number, details?: unknown}) => Error} [errorFactory]
 */
export function createOperationClient(connection, errorFactory = (message, options) => Object.assign(new Error(message), options)) {
  /** @param {StudioOperationId} operation @param {JsonValue} [payload] @param {AbortSignal} [signal] */
  const call = async (operation, payload, signal) => {
    const result = await callStudioOperation(connection, operation, payload, signal);
    const details = /** @type {{status?: number} | undefined} */ (result.ok === false ? result.error?.details : undefined);
    if (result.ok === false) throw errorFactory(result.error?.message || 'Studio operation failed', {
      code: result.error?.code || 'STUDIO_OPERATION_FAILED', status: result.error?.status ?? (typeof details?.status === 'number' ? details.status : undefined), details: result.error?.details,
    });
    return result.value;
  };
  /** @type {Readonly<Record<StudioOperationId, (payload?: JsonValue, signal?: AbortSignal) => Promise<unknown>>>} */
  const methods = Object.freeze(/** @type {Record<StudioOperationId, (payload?: JsonValue, signal?: AbortSignal) => Promise<unknown>>} */ (
    Object.fromEntries(STUDIO_OPERATION_IDS.map(id => [id, (/** @type {JsonValue} */ payload, /** @type {AbortSignal} */ signal) => call(id, payload, signal)]))
  ));
  return Object.freeze({ call, methods, raw: (/** @type {StudioOperationId} */ operation, /** @type {JsonValue} */ payload, /** @type {AbortSignal | undefined} */ signal) => callStudioOperation(connection, operation, payload, signal) });
}
