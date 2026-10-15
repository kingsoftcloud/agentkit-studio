// @ts-check
import { STUDIO_CONTROL_CHANNEL } from './operations.mjs';

/** @typedef {import('./operations.mjs').StudioOperationId} StudioOperationId */
/** @typedef {import('./types.js').JsonValue} JsonValue */
/** @typedef {import('./types.js').StudioEnvelope} StudioEnvelope */
/** @typedef {import('./types.js').StudioConnection} StudioConnection */

export class StudioProtocolError extends Error {
  /** @param {string} code @param {string} message @param {string} operation @param {number} status */
  constructor(code, message, operation, status) {
    super(message);
    this.name = 'StudioProtocolError'; this.code = code; this.status = status;
    this.details = { operation };
  }
}

/** Invalid transport envelopes must never look like successful empty catalogs.
 * Optional error fields retain each caller's existing fallback error policy.
 * @param {StudioOperationId} operation @param {unknown} value
 * @returns {asserts value is StudioEnvelope}
 */
export function validateOperationResponse(operation, value) {
  const object = /** @type {Record<string, unknown> | null} */ (value);
  const error = /** @type {Record<string, unknown> | undefined} */ (object?.error);
  if (!object || typeof object !== 'object' || Array.isArray(object) || typeof object.ok !== 'boolean'
    || (object.ok === false && error !== undefined && (!error || typeof error !== 'object' || Array.isArray(error)
      || (error.code !== undefined && typeof error.code !== 'string')
      || (error.message !== undefined && typeof error.message !== 'string')
      || (error.status !== undefined && typeof error.status !== 'number')))) {
    throw new StudioProtocolError('STUDIO_RESPONSE_INVALID', 'Invalid Studio response envelope', operation, 502);
  }
}

/** DSH owns authentication and transport cancellation. Its public fourth
 * argument is AbortSignal; no extra transport or browser credential is added.
 * @param {StudioConnection} connection @param {StudioOperationId} operation
 * @param {unknown} payload @param {AbortSignal} [signal] @returns {Promise<StudioEnvelope>}
 */
export async function callStudioOperation(connection, operation, payload, signal) {
  signal?.throwIfAborted();
  const result = signal
    ? await connection.rpc.call(STUDIO_CONTROL_CHANNEL, operation, payload, signal)
    : await connection.rpc.call(STUDIO_CONTROL_CHANNEL, operation, payload);
  validateOperationResponse(operation, result);
  return result;
}
