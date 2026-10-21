/** Native task-manager adapter with one immutable cloud Session identity. */
export function createAssistantScheduleRemote({ execute, agentId, sessionId, signal, setTimer = setTimeout, clearTimer = clearTimeout, refreshMs = 5000 }) {
  if (!agentId || !sessionId) throw new Error('云端任务缺少会话归属');
  const lifetime = new AbortController(), listeners = new Set();
  const combined = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
  let timer, catalogReads = 0;
  const call = async (operation, input = {}) => {
    combined.throwIfAborted();
    const value = await execute(agentId, operation, { ...input, conversation: 'personal' }, combined);
    combined.throwIfAborted();
    return { ok: true, value };
  };
  const scoped = request => {
    if (!request || request.sessionId !== sessionId) throw new Error('任务不属于当前云端会话');
    const { sessionId: _sessionId, ...input } = request;
    return input;
  };
  const tick = () => {
    timer = undefined;
    if (combined.aborted || !listeners.size) return;
    // A periodic invalidation must not supersede a slower authoritative read.
    // Explicit mutation readbacks remain free to supersede through the native source.
    if (catalogReads === 0) for (const listener of listeners) listener();
    if (!combined.aborted && listeners.size) timer = setTimer(tick, refreshMs);
  };
  const stop = () => { if (timer !== undefined) clearTimer(timer); timer = undefined; };
  combined.addEventListener('abort', stop, { once: true });
  return {
    schedule: {
      async catalog() {
        catalogReads++;
        try {
          const result = await call('schedule-catalog');
          if (result.value?.sessionId !== sessionId || !Array.isArray(result.value.items) || result.value.items.some(item => item.sessionId !== sessionId)) throw new Error('云端任务归属无法确认');
          return { ok: true, value: result.value.items };
        } finally { catalogReads--; }
      },
      history: request => call('schedule-history', scoped(request)),
      update: request => call('schedule-update', scoped(request)),
      delete: request => call('schedule-delete', scoped(request)),
    },
    subscribe(event, listener) {
      if (event !== 'schedule/changed' || combined.aborted) return () => {};
      listeners.add(listener);
      if (timer === undefined) timer = setTimer(tick, refreshMs);
      return () => { listeners.delete(listener); if (!listeners.size) stop(); };
    },
    dispose() { lifetime.abort(); listeners.clear(); stop(); },
  };
}
