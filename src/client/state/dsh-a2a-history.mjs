const check = (value, message) => { if (!value) throw Error(message); };
const id = value => typeof value === 'string' && value.trim() && value.length <= 256;
/** Inventory is entirely local. Remote GetTask requires a separate explicit
 * task action, never a poll or a replacement model turn. */
export function createDshA2aHistoryState({ hostRemote, agentId, sessionId }) {
  const lifetime = new AbortController(), listeners = new Set(); let disposed = false;
  let state = { page: null, loading: false, error: '' };
  const set = update => { if (!disposed) { state = { ...state, ...update }; for (const listener of listeners) listener(state); } };
  const load = async append => {
    if (disposed || state.loading || append && (!state.page || state.page.complete)) return;
    const previous = state.page, offset = append ? previous.items.length : 0; set({ loading: true, error: '' });
    try {
      const page = await hostRemote.dshA2aTaskHistory({ agentId, sessionId, offset, limit: 64,
        ...(append ? { inventoryDigest: previous.inventoryDigest } : {}) }, lifetime.signal);
      check(page?.contract === 'agentkit.studio-dsh-a2a-inventory/v1' && typeof page.applicable === 'boolean'
        && page.agentId === agentId && page.sessionId === sessionId && page.offset === offset
        && Number.isSafeInteger(page.total) && page.total >= 0 && typeof page.complete === 'boolean'
        && Array.isArray(page.items) && page.items.length <= 64 && page.items.every(task => task?.agentId === agentId
          && task.sessionId === sessionId && id(task.callId) && task.operationKey === `dsh-a2a:${task.callId}`
          && Number.isSafeInteger(task.agentRevision) && task.agentRevision > 0 && (task.buildId === null || id(task.buildId))
          && !['runId', 'scope', 'authority'].some(key => Object.hasOwn(task, key)))
        && (!page.applicable ? !page.items.length && page.complete : /^[a-f0-9]{64}$/u.test(page.inventoryDigest))
        && page.complete === (offset + page.items.length >= page.total)
        && (page.complete || page.items.length > 0), 'DSH A2A 任务清单与原会话不一致。');
      if (append) check(page.inventoryDigest === previous.inventoryDigest, 'DSH A2A 任务清单已变化，请刷新。');
      const items = append ? [...previous.items, ...page.items] : page.items;
      check(new Set(items.map(task => task.callId)).size === items.length, 'DSH A2A 任务清单含重复调用。');
      set({ page: { ...page, offset: 0, items } });
    } catch { set({ error: '原会话的 A2A 任务清单读取失败，请刷新核对。' }); }
    finally { set({ loading: false }); }
  };
  return { getSnapshot: () => state, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    refresh: () => load(false), next: () => load(true), dispose() { disposed = true; lifetime.abort(); listeners.clear(); } };
}
