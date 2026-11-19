import { dshModelFailure } from '../model-failure.mjs';
import { knownRunError, replayAgeMs, validEventProps } from './contract.mjs';

export function runErrorCode(error) {
  return knownRunError(dshModelFailure(error)?.code ?? error?.code);
}

function usageFields(usage) {
  const input = usage?.inputTokens ?? usage?.input_tokens;
  const output = usage?.outputTokens ?? usage?.output_tokens;
  if (![input, output, input + output].every(value => Number.isSafeInteger(value) && value >= 0)) return {};
  return { input_tokens: input, output_tokens: output, total_tokens: input + output };
}

/** The packaged Desktop parent admits the start and rechecks the collection state at completion. */
export function startDesktopRun(engine, id) {
  if (process.env.AGENTKIT_STUDIO_DESKTOP_SESSION !== '1' || !process.connected || typeof process.send !== 'function') return undefined;
  const send = (kind, props) => {
    try { process.send({ type: 'studio-telemetry-run', kind, id, engine, ...(props ? { props } : {}) }, () => {}); }
    catch { /* The optional IPC channel may already be closed. */ }
  };
  const started = performance.now();
  send('start');
  return (status, { usage, error } = {}) => {
    try {
      const props = {
        engine, status, duration_ms: Math.min(replayAgeMs, Math.max(0, Math.round(performance.now() - started))),
        ...usageFields(usage),
        ...error && ['failed', 'interrupted'].includes(status) ? { error_code: runErrorCode(error) } : {},
      };
      if (validEventProps('run_summary', props)) send('finish', props);
    } catch { /* Optional statistics never alter a run outcome. */ }
  };
}
