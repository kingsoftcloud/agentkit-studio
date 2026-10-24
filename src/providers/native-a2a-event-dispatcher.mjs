/** At-least-once delivery of already committed, immutable canonical facts.
 * Append's event_id idempotency permits a retry after a lost acknowledgement.
 * Send/Prepare/Bind are never part of this worker. Store callbacks own the
 * short publication lock; deliveryLock is a separate cross-process lock. */
import { invariant } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { A2A_EVENT_PERMANENT_ERRORS } from './native-a2a-events.mjs';
const permanent = new Set(A2A_EVENT_PERMANENT_ERRORS);
const safeError = error => permanent.has(error?.code) ? error.code : 'A2A_EVENT_DELIVERY_UNAVAILABLE';
export function createA2AEventDispatcher({ pending, update, append, deliveryLock, assertCurrent, permanentError = () => null,
  retryMs = 1000, timeoutMs = 5000 } = {}) {
  invariant([pending, update, append, deliveryLock, assertCurrent].every(fn => typeof fn === 'function')
    && Number.isSafeInteger(retryMs) && retryMs > 0 && Number.isSafeInteger(timeoutMs) && timeoutMs > 0,
    'A2A_EVENT_DISPATCHER_INVALID');
  let timer, running, stopped = false, lastError = null;
  const lifetime = new AbortController();
  const guard = () => {
    lifetime.signal.throwIfAborted(); const verdict = assertCurrent();
    if (verdict && typeof verdict.then === 'function') void Promise.resolve(verdict).catch(() => {});
    invariant(verdict === true, 'A2A_EVENT_DELIVERY_AUTHORITY_LOST'); lifetime.signal.throwIfAborted(); return true;
  };
  function schedule() {
    if (stopped || timer) return;
    timer = setTimeout(() => { timer = undefined; void drain().catch(() => schedule()); }, retryMs); timer.unref();
  }
  async function work() {
    guard(); const release = deliveryLock(); if (!release) { schedule(); return 0; }
    let delivered = 0;
    try {
      for (;;) {
        guard(); const batch = pending();
        if (!batch) return delivered;
        const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(timeoutMs)]);
        let abort;
        try {
          const cancelled = new Promise((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); });
          const attempt = Promise.resolve().then(() => { guard(); signal.throwIfAborted(); return append({ ...batch, signal, assertCurrent: guard }); });
          // Noncooperative late responses cannot acknowledge the batch.
          void attempt.catch(() => {}); await Promise.race([attempt, cancelled]); signal.throwIfAborted(); guard();
          update(batch, 'acknowledge'); delivered++; lastError = null;
        } catch (error) {
          if (lifetime.signal.aborted) throw error;
          guard(); const code = safeError(error); update(batch, permanent.has(code) ? 'deadLetter' : 'failure', code); lastError = code;
          if (!permanent.has(code)) { schedule(); return delivered; }
        } finally { if (abort) signal.removeEventListener('abort', abort); }
      }
    } finally { release(); }
  }
  function drain() {
    if (running) return running;
    if (stopped) return Promise.resolve(0);
    return running = work().finally(() => { running = undefined; });
  }
  return Object.freeze({
    wake() { if (!stopped) { if (timer) clearTimeout(timer); timer = undefined; void drain().catch(() => schedule()); } },
    async flush({ raiseOnError = true } = {}) {
      await drain();
      const next = pending(), error = permanentError() ?? lastError;
      if (raiseOnError) invariant(!error, error ?? 'A2A_EVENT_DELIVERY_UNAVAILABLE');
      return { pending: Boolean(next), error: error ?? null };
    },
    async stop({ flushTimeoutMs = 5000 } = {}) {
      if (stopped) return;
      invariant(Number.isSafeInteger(flushTimeoutMs) && flushTimeoutMs >= 0 && flushTimeoutMs <= 5000, 'A2A_EVENT_STOP_TIMEOUT_INVALID');
      if (timer) clearTimeout(timer); timer = undefined;
      if (flushTimeoutMs) {
        let timeout;
        try { await Promise.race([drain(), new Promise(resolve => { timeout = setTimeout(resolve, flushTimeoutMs); })]); }
        catch {} finally { clearTimeout(timeout); }
      }
      stopped = true; lifetime.abort(); if (timer) clearTimeout(timer); timer = undefined;
      await running?.catch(() => {});
    },
  });
}
