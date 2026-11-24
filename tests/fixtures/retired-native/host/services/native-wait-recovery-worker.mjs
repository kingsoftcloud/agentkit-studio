/** Bounded discovery coordinator for managed A2A wait recovery.
 *
 * Worker finds trusted-parent-filtered recovery candidates and delegates each
 * restore to a Host-supplied function. The worker itself owns NO recovery
 * admission authority, NO database/model/HTTP access, and NO ability to
 * terminate a Native Run or submit a cancel command — actual driving belongs
 * to the Host lifetime. Per-candidate failures are bounded and never block
 * other candidates; late listCandidates/restore results after close are
 * discarded.
 *
 * Stable error codes: A2A_WAIT_RECOVERY_INVALID, A2A_WAIT_RECOVERY_CLOSED,
 * A2A_WAIT_RECOVERY_CANDIDATE_INVALID, A2A_WAIT_RECOVERY_RESTORE_FAILED.
 * onError receives only {code} (no candidate input/message leak).
 */
const OK_CODES = new Set([
  'A2A_WAIT_RECOVERY_INVALID', 'A2A_WAIT_RECOVERY_CLOSED',
  'A2A_WAIT_RECOVERY_CANDIDATE_INVALID', 'A2A_WAIT_RECOVERY_RESTORE_FAILED',
]);
const MAX_ERRORS = 256;

function fail(code) { const e = new Error(code); e.code = code; return e; }

function validateCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
  return typeof candidate.scope === 'object' && candidate.scope !== null && !Array.isArray(candidate.scope)
    && ['tenantId', 'workspaceId', 'userId', 'agentId'].every(key => typeof candidate.scope[key] === 'string'
      && candidate.scope[key].trim() && candidate.scope[key].length <= 256)
    && typeof candidate.sessionId === 'string' && candidate.sessionId.trim() !== '' && candidate.sessionId.length <= 256
    && typeof candidate.runId === 'string' && candidate.runId.trim() !== '' && candidate.runId.length <= 256;
}

/**
 * createNativeWaitRecoveryWorker({ listCandidates, restore, signal, intervalMs, onError })
 * listCandidates(signal) -> array of {scope, sessionId, runId} (trusted-parent-filtered).
 * restore(candidate, signal) -> Promise<void> (Host drives the actual recovery).
 * Returns { start, tick, status, close }.
 */
export function createNativeWaitRecoveryWorker({ listCandidates, restore, signal, intervalMs = 1000, onError } = {}) {
  if (typeof listCandidates !== 'function' || typeof restore !== 'function'
    || !(signal instanceof AbortSignal) || !Number.isSafeInteger(intervalMs)
    || intervalMs < 100 || intervalMs > 300000) throw fail('A2A_WAIT_RECOVERY_INVALID');
  if (onError !== undefined && typeof onError !== 'function') throw fail('A2A_WAIT_RECOVERY_INVALID');

  const lifetime = new AbortController();
  let timer = null, ticking = false, started = false, closed = false;
  let lastError = null, inflight = null, tickCount = 0, restoredCount = 0, closing;
  const errors = [];

  const stopTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };

  // External signal aborts the worker's own lifetime (stops timer, removes listener).
  const onExternalAbort = () => { void close(); };
  if (signal.aborted) lifetime.abort(signal.reason);
  else signal.addEventListener('abort', onExternalAbort, { once: true });

  const guardedOnError = code => {
    if (closed) return;
    if (!OK_CODES.has(code)) code = 'A2A_WAIT_RECOVERY_RESTORE_FAILED';
    if (errors.length < MAX_ERRORS) errors.push(code);
    lastError = code;
    if (onError) { try { onError({ code }); } catch {} }
  };

  async function live(operation) {
    lifetime.signal.throwIfAborted();
    let abort;
    const stopped = new Promise((_, reject) => {
      abort = () => reject(lifetime.signal.reason);
      lifetime.signal.addEventListener('abort', abort, { once: true });
    });
    try { const result = await Promise.race([Promise.resolve().then(() => {
      lifetime.signal.throwIfAborted(); return operation();
    }), stopped]); lifetime.signal.throwIfAborted(); return result; }
    finally { lifetime.signal.removeEventListener('abort', abort); }
  }

  function tick() {
    if (closed || lifetime.signal.aborted) return Promise.resolve();
    if (ticking) return inflight; // shared inflight: concurrent tick calls coalesce
    ticking = true;
    inflight = (async () => {
      const failures = [];
      const report = code => {
        guardedOnError(code);
        if (failures.length < MAX_ERRORS) failures.push(fail(OK_CODES.has(code) ? code : 'A2A_WAIT_RECOVERY_RESTORE_FAILED'));
      };
      let candidates = null;
      try {
        candidates = await live(() => listCandidates(lifetime.signal));
      } catch (error) {
        if (!closed && !lifetime.signal.aborted) {
          report(error?.code);
          throw new AggregateError(failures, 'A2A_WAIT_RECOVERY_RESTORE_FAILED');
        }
        return;
      }
      // Late listCandidates result after close: discard.
      if (closed || lifetime.signal.aborted) return;
      if (!Array.isArray(candidates)) {
        report('A2A_WAIT_RECOVERY_INVALID');
        throw new AggregateError(failures, 'A2A_WAIT_RECOVERY_INVALID');
      }
      for (const candidate of candidates) {
        // Late close mid-iteration: stop restoring.
        if (closed || lifetime.signal.aborted) return;
        if (!validateCandidate(candidate)) {
          report('A2A_WAIT_RECOVERY_CANDIDATE_INVALID');
          continue;
        }
        try {
          const outcome = await live(() => restore(candidate, lifetime.signal));
          if (!closed && !lifetime.signal.aborted && !['deferred', 'settled'].includes(outcome?.status)) restoredCount++;
        } catch (error) {
          if (closed || lifetime.signal.aborted) return; // late restore after close: discard
          report(error?.code);
          // per-candidate failure: continue to next candidate
        }
      }
      if (failures.length) throw new AggregateError(failures, 'A2A_WAIT_RECOVERY_RESTORE_FAILED');
    })().finally(() => { if (!closed) { ticking = false; tickCount++; } inflight = null; });
    return inflight;
  }

  function scheduleNext() {
    if (closed || lifetime.signal.aborted) return;
    stopTimer();
    timer = setTimeout(() => { timer = null; void tick().catch(() => {}); scheduleNext(); }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function close() {
    if (closing) return closing;
    closed = true; ticking = false;
    lifetime.abort(fail('A2A_WAIT_RECOVERY_CLOSED'));
    stopTimer();
    signal.removeEventListener('abort', onExternalAbort);
    return closing = Promise.resolve(inflight).catch(() => {});
  }

  return {
    /** Start the worker: run one immediate tick, then schedule periodic ticks.
     *  Resolves when the first tick has started (not when the long Run finishes). */
    async start() {
      if (started) return; started = true;
      if (closed || lifetime.signal.aborted) return;
      // Run the first tick; do not await its full completion for long restores —
      // start resolves once the tick is underway. We kick it off and schedule
      // the next without blocking on restore completion.
      void tick().catch(() => {});
      scheduleNext();
    },
    /** Trigger an immediate tick (in addition to the timer). Coalesces with any
     *  in-flight tick. Returns the inflight promise when a tick is running. */
    tick() { return tick(); },
    /** Read-only status snapshot. */
    status() {
      return { running: Boolean(timer) && !closed, started, closed, ticking, tickCount, restoredCount, lastError: lastError ?? null,
        errors: [...errors] };
    },
    /** Close: abort own lifetime, stop timer, race-wait in-flight tick (bounded)
     *  so uncooperative late callbacks cannot hang close. Late results discarded. */
    close,
  };
}
