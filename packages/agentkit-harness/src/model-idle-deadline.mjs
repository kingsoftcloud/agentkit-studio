/** Bound upstream silence without cutting off a model that is still streaming. */
export function createModelIdleDeadline({ signal, timeoutMs = 180000 } = {}) {
  const timeout = new AbortController();
  const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  let timer;
  const clear = () => clearTimeout(timer);
  const touch = () => {
    clear();
    if (combined.aborted) return;
    timer = setTimeout(() => timeout.abort(new DOMException('Model stream idle', 'TimeoutError')), timeoutMs);
    timer.unref?.();
  };
  combined.addEventListener('abort', clear, { once: true });
  touch();
  return {
    signal: combined,
    get timedOut() { return timeout.signal.aborted; },
    touch,
    dispose() { clear(); combined.removeEventListener('abort', clear); },
  };
}
