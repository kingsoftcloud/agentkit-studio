/** Keep observations outside the model transcript and outside execution policy. */
export function modelTransportObservation(now = () => performance.now()) {
  const start = now(), ms = () => Math.max(0, Math.round(now() - start));
  const facts = { contract: 'model-transport-observation/v1', phase: 'prepare', headersMs: null,
    bodyChunks: 0, bodyBytes: 0, lastByteMs: null, lastFrameMs: null, lastOutputMs: null, lastToolDeltaMs: null };
  return {
    phase: value => { facts.phase = value; },
    headers: () => { facts.headersMs = ms(); },
    bytes: size => { if (size > 0) { facts.bodyChunks++;facts.bodyBytes += size;facts.lastByteMs = ms(); } },
    frame: () => { facts.lastFrameMs = ms(); },
    output: event => {
      if (!event?.text) return;
      facts.lastOutputMs = ms();if (event.kind === 'tool_delta') facts.lastToolDeltaMs = facts.lastOutputMs;
    },
    finish: () => ({ ...facts, elapsedMs: ms() }),
  };
}

export function observeModelTransportPort(generate) {
  return { async generate(request, emit) {
    const observation = modelTransportObservation();
    const result = await generate(request, event => {
      observation.output(event);if (typeof emit === 'function') emit(event);
    }, observation);
    return { ...result, transportObservation: observation.finish() };
  } };
}
