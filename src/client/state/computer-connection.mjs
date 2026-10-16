/** Connection truth expires on a failed probe; unmount cancels reads and polling. */
export function observeComputerConnection({ read, publish, events, interval = 15000, timeout = 5000, setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout }) {
  let closed = false, timer, controller, generation = 0;
  const deadlines = new Map();
  const refresh = async () => {
    const version = ++generation;
    clearTimeout(timer); controller?.abort(); clearTimeout(deadlines.get(controller)); deadlines.delete(controller); controller = new AbortController();
    const current = controller;
    publish({ status: 'checking' });
    let deadline;
    try {
      const result = await Promise.race([read(current.signal), new Promise((_, reject) => {
        deadline = setTimeout(() => { current.abort(); reject(new Error('Connection timed out')); }, timeout);
        deadlines.set(current, deadline);
      })]);
      if (!closed && version === generation) publish({ status: 'connected', computer: result, checkedAt: Date.now() });
    } catch {
      if (!closed && version === generation) publish({ status: 'disconnected' });
    } finally {
      clearTimeout(deadline); deadlines.delete(current);
      if (!closed && version === generation) timer = setTimeout(refresh, interval);
    }
  };
  events?.addEventListener('agentkit-studio:connection-reset', refresh);
  void refresh();
  return () => { closed = true; generation++; clearTimeout(timer); controller?.abort(); for (const id of deadlines.values()) clearTimeout(id); deadlines.clear(); events?.removeEventListener('agentkit-studio:connection-reset', refresh); };
}
