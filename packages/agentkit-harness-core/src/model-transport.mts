import { invariant } from './values.mjs';

/** Bounded transport facts, never response content, endpoint URLs or credentials. */
export interface ModelTransportObservation {
  contract: 'model-transport-observation/v1';
  phase: 'prepare' | 'headers' | 'stream' | 'buffered' | 'http-error';
  elapsedMs: number; headersMs: number | null;
  bodyChunks: number; bodyBytes: number;
  lastByteMs: number | null; lastFrameMs: number | null; lastOutputMs: number | null; lastToolDeltaMs: number | null;
}
export function validateModelTransport(value: ModelTransportObservation | undefined): void {
  if (value === undefined) return;
  const times = ['headersMs', 'lastByteMs', 'lastFrameMs', 'lastOutputMs', 'lastToolDeltaMs'] as const;
  invariant(value && value.contract === 'model-transport-observation/v1'
    && Object.keys(value).sort().join(',') === ['contract', 'phase', 'elapsedMs', 'bodyChunks', 'bodyBytes', ...times].sort().join(',')
    && ['prepare', 'headers', 'stream', 'buffered', 'http-error'].includes(value.phase)
    && [value.elapsedMs, value.bodyChunks, value.bodyBytes].every(n => Number.isSafeInteger(n) && n >= 0)
    && times.every(key => value[key] === null || Number.isSafeInteger(value[key]) && value[key]! >= 0 && value[key]! <= value.elapsedMs),
  'invalid_model_transport_observation');
}
