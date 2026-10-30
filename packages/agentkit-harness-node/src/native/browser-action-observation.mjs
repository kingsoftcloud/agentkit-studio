/** Diagnostic facts only: never browser authority, a receipt or replay permission. */
const phases = new Set(['queued', 'preflight', 'replay', 'target', 'actionability', 'navigate', 'dispatch', 'settle',
  'capture_dom', 'capture_screenshot', 'capture_controls', 'publish', 'close']);
const outcomes = new Set(['ok', 'error', 'uncertain', 'timeout', 'canceled']);
const keys = ['contract', 'actionId', 'kind', 'phase', 'dispatchStarted', 'dispatchCompleted', 'elapsedMs', 'timeoutMs', 'outcome', 'errorCode'];
const safeCode = value => value === null || typeof value === 'string' && /^[a-z][a-z0-9_]{0,95}$/.test(value);

export function admitBrowserActionObservation(value, action) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== keys.length || !Object.keys(value).every(key => keys.includes(key))) return null;
    value = Object.fromEntries(keys.map(key => [key, value[key]]));
    if (value.contract !== 'browser-action-observation/v1' || value.actionId !== action.actionId || value.kind !== action.kind
      || !phases.has(value.phase) || !outcomes.has(value.outcome) || !safeCode(value.errorCode)
      || typeof value.dispatchStarted !== 'boolean' || typeof value.dispatchCompleted !== 'boolean'
      || value.dispatchCompleted && !value.dispatchStarted || value.timeoutMs !== action.timeoutMs
      || !Number.isSafeInteger(value.elapsedMs) || value.elapsedMs < 0) return null;
    return value;
  } catch { return null; }
}

export function createBrowserActionAttempt(action) {
  const startedAt = performance.now();
  return { started: false, phase: 'queued', dispatchStarted: false, dispatchCompleted: false,
    publish(observer, { signal, internal, observation, failureCode }) {
      if (typeof observer !== 'function') return;
      const errorCode = internal.aborted ? signal?.aborted ? 'action_canceled' : 'action_timed_out'
        : observation?.errorCode ?? failureCode ?? null;
      const value = admitBrowserActionObservation({ contract: 'browser-action-observation/v1',
        actionId: action.actionId, kind: action.kind, phase: this.phase,
        dispatchStarted: this.dispatchStarted, dispatchCompleted: this.dispatchCompleted,
        elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)), timeoutMs: action.timeoutMs,
        outcome: internal.aborted ? signal?.aborted ? 'canceled' : 'timeout' : observation?.status ?? 'error',
        errorCode: safeCode(errorCode) ? errorCode : 'browser_action_error',
      }, action);
      if (!value) return;
      try {
        const pending = observer(Object.freeze(value));
        if (pending && typeof pending.then === 'function') void Promise.resolve(pending).catch(() => {});
      } catch { /* Observer failure cannot change browser execution. */ }
    },
  };
}
