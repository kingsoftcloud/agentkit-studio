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

/**
 * Delays between retries while the Studio bridge finishes registering its routes.
 * A cold start answers `/agentkit/*` with 404/405 until the Host webserver mounts
 * the control channel; the first screen must wait that out instead of failing.
 */
export const BRIDGE_STARTUP_RETRY_DELAYS_MS = Object.freeze([300, 1000, 3000, 3000, 3000]);

/** Message the connection layer reports when the bridge fell back to HTTP. */
const TRANSPORT_FAILURE = /^transport failure for [^]*HTTP (\d{3})$/;
const STARTING_MESSAGE = '正在启动本地服务…';

/** @typedef {{ operation: string, attempts: number, waitedMs: number, outcome: 'ready' | 'exhausted' | 'failed' }} BridgeStartupSample */

/** @type {BridgeStartupSample[]} */
const startupSamples = [];

/** Recent bridge-startup samples for diagnostics and tests. */
export function bridgeStartupTelemetry() {
  return startupSamples.map(sample => ({ ...sample }));
}

/** Test seam: clear recorded startup samples. */
export function resetBridgeStartupTelemetry() {
  startupSamples.length = 0;
}

/**
 * Whether an error only means the Host has not registered the route yet.
 * 404 and 405 are never business answers on the control channel: the dispatcher
 * replies 200 with `{ok:false,error}` for real failures.
 * @param {unknown} error
 */
export function bridgeNotReady(error) {
  const candidate = /** @type {{ status?: unknown, message?: unknown }} */ (error);
  if (Number(candidate?.status) === 404 || Number(candidate?.status) === 405) return true;
  const matched = TRANSPORT_FAILURE.exec(String(candidate?.message ?? ''));
  return matched !== null && (matched[1] === '404' || matched[1] === '405');
}

/** @param {number} ms @param {AbortSignal} [signal] */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(undefined); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** @param {string} name @param {Record<string, unknown>} detail */
function emit(name, detail) {
  const scope = /** @type {{ dispatchEvent?: (event: unknown) => boolean, CustomEvent?: unknown } | undefined} */ (
    /** @type {unknown} */ (globalThis.window));
  if (scope?.dispatchEvent === undefined || scope.CustomEvent === undefined) return;
  const Event = /** @type {new (type: string, init: { detail: unknown }) => unknown} */ (scope.CustomEvent);
  scope.dispatchEvent(new Event(name, { detail }));
}

/** The user-facing message for a bridge that never became ready. */
export function bridgeStartupMessage() {
  return '正在启动本地服务，请稍候再试（本地服务仍在启动）';
}

/** DSH owns authentication and transport cancellation. Its public fourth
 * argument is AbortSignal; no extra transport or browser credential is added.
 *
 * A cold first screen races the Host: `/agentkit/*` answers 404/405 until the
 * control channel is registered. Those two statuses mean "not ready yet", so the
 * call is retried with backoff and reported through `agentkit-studio:bridge-*`
 * events; business errors still surface immediately.
 * @param {StudioConnection} connection @param {StudioOperationId} operation
 * @param {unknown} payload @param {AbortSignal} [signal] @returns {Promise<StudioEnvelope>}
 */
export async function callStudioOperation(connection, operation, payload, signal) {
  signal?.throwIfAborted();
  const startedAt = Date.now();
  let attempts = 0;
  for (;;) {
    try {
      const result = signal
        ? await connection.rpc.call(STUDIO_CONTROL_CHANNEL, operation, payload, signal)
        : await connection.rpc.call(STUDIO_CONTROL_CHANNEL, operation, payload);
      if (attempts > 0) {
        const waitedMs = Date.now() - startedAt;
        startupSamples.push({ operation, attempts, waitedMs, outcome: 'ready' });
        emit('agentkit-studio:bridge-ready', { operation, attempts, waitedMs });
        console.info('studio bridge became ready', { operation, attempts, waitedMs });
      }
      validateOperationResponse(operation, result);
      return result;
    } catch (error) {
      if (!bridgeNotReady(error)) {
        if (attempts > 0) startupSamples.push({ operation, attempts, waitedMs: Date.now() - startedAt, outcome: 'failed' });
        throw error;
      }
      if (attempts >= BRIDGE_STARTUP_RETRY_DELAYS_MS.length) {
        const waitedMs = Date.now() - startedAt;
        startupSamples.push({ operation, attempts, waitedMs, outcome: 'exhausted' });
        emit('agentkit-studio:bridge-exhausted', { operation, attempts, waitedMs });
        console.warn('studio bridge did not become ready', { operation, attempts, waitedMs });
        throw new StudioProtocolError('STUDIO_BRIDGE_STARTING', bridgeStartupMessage(), operation, 503);
      }
      const waitMs = BRIDGE_STARTUP_RETRY_DELAYS_MS[attempts] ?? 3000;
      attempts += 1;
      emit('agentkit-studio:bridge-starting', { operation, attempt: attempts, waitMs, message: STARTING_MESSAGE });
      await delay(waitMs, signal);
    }
  }
}
