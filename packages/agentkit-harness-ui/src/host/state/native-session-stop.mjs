/** Session cancellation is a Host control, independent of tool interaction UI.
 * An acknowledgement means requested, never that an effect has stopped. */
export function createNativeSessionStop({ sessionId, requestStop }) {
  let live = true, observation, running = false, generation = 0, pending = false;
  let phase = 'idle', error = null;
  const listeners = new Set();
  const owned = () => Boolean(observation?.sessionId === sessionId && observation.runId
    && !observation.managed && observation.state === 'recovering' && running);
  const eligible = () => owned() && observation.phase === 'awaiting_interaction';
  const getSnapshot = () => ({ phase, error, visible: eligible() || owned() && phase !== 'idle',
    canStop: typeof requestStop === 'function' && eligible() && !pending && phase !== 'requested' });
  const emit = () => { const value = getSnapshot(); for (const listener of listeners) listener(value); };
  return {
    getSnapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    observe(status, transportRunning) {
      if (!live) return;
      if (observation?.runId !== status?.runId || !transportRunning || status?.state !== 'recovering') {
        generation++; pending = false; phase = 'idle'; error = null;
      }
      observation = status; running = transportRunning === true; emit();
    },
    async request() {
      if (!live || !getSnapshot().canStop || typeof requestStop !== 'function') return false;
      const current = generation; pending = true; phase = 'requesting'; error = null; emit();
      try {
        // The adapter invokes the existing Session owner, not a tool decision,
        // ledger mutation, resume operation, or a guessed Native Run command.
        const result = await requestStop(sessionId);
        if (!live || current !== generation) return false;
        if (result?.ok !== true || result.value?.accepted !== true) throw Error('stop_unconfirmed');
        phase = 'requested'; return true;
      } catch {
        if (live && current === generation) { phase = 'error'; error = '停止请求未确认，请重试。'; }
        return false;
      } finally { if (live && current === generation) { pending = false; emit(); } }
    },
    dispose() { live = false; generation++; listeners.clear(); },
  };
}
