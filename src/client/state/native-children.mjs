const contract = 'agentkit.studio-native-child-history/v1';
const check = (value, message) => { if (!value) throw new Error(message); };

/** Own only product reads and explicit controls; execution stays in the Host. */
export function createNativeChildrenState({ hostRemote, agentId, sessionId, commandId = () => globalThis.crypto.randomUUID() }) {
  const identity = { agentId, sessionId }, lifetime = new AbortController(), listeners = new Set();
  let state = { page: null, detail: null, loading: false, reading: false, pending: null, sending: false, error: '' };
  let disposed = false, reading = 0;
  const set = changes => { if (!disposed) { state = { ...state, ...changes }; for (const listener of listeners) listener(state); } };
  const valid = value => check(value?.contract === contract && value.sessionId === sessionId, '子任务记录与当前会话不一致，请刷新。');
  const validTask = task => task && ['childRunId', 'sessionId', 'parentRunId', 'role', 'phase', 'goalPreview']
    .every(key => typeof task[key] === 'string') && typeof task.resultAvailable === 'boolean'
    && task.usage && Number.isSafeInteger(task.usage.modelCalls) && Number.isSafeInteger(task.usage.toolCalls);
  async function load(next = false) {
    if (disposed || state.loading || next && (!state.page || state.page.complete)) return;
    const previous = state.page;
    set({ loading: true, error: '' });
    try {
      const page = await hostRemote.nativeChildHistory({ ...identity,
        ...(next ? { offset: previous.nextOffset, inventoryDigest: previous.inventoryDigest } : {}) }, lifetime.signal);
      if (disposed) return;
      valid(page);
      check(Array.isArray(page.tasks) && page.tasks.every(task => validTask(task) && (!task.canPromote || task.parentRunId === page.runId))
        && new Set(page.tasks.map(task => task.childRunId)).size === page.tasks.length
        && Number.isSafeInteger(page.offset) && page.offset >= 0 && page.nextOffset === page.offset + page.tasks.length
        && Number.isSafeInteger(page.totalTasks) && page.totalTasks >= page.nextOffset
        && typeof page.complete === 'boolean' && page.complete === (page.nextOffset === page.totalTasks), '子任务目录不完整，请刷新。');
      if (next && (page.inventoryDigest !== previous.inventoryDigest || page.runId !== previous.runId || page.offset !== previous.nextOffset))
        throw Object.assign(new Error('子任务目录已变化，请刷新。'), { code: 'child_history_inventory_changed' });
      if (next) check(!page.tasks.some(task => previous.tasks.some(old => old.childRunId === task.childRunId)), '子任务目录重复。');
      set({ page: next ? { ...page, tasks: [...previous.tasks, ...page.tasks] } : page });
    } catch (error) { set({ error: error.code === 'child_history_inventory_changed' ? '子任务目录已变化，请刷新。' : '子任务读取失败，请刷新重试。' }); }
    finally { set({ loading: false }); }
  }
  async function read(task, more = false) {
    if (disposed) return;
    const token = ++reading, previous = state.detail;
    set({ reading: true, error: '' });
    try {
      const detail = await hostRemote.nativeChildResult({ ...identity, runId: state.page.runId, childRunId: task.childRunId,
        ...(more ? { offset: previous.nextOffset } : {}) }, lifetime.signal);
      if (disposed || token !== reading) return;
      valid(detail);
      check(validTask(detail.task) && detail.task.childRunId === task.childRunId && detail.runId === state.page.runId
        && typeof detail.text === 'string' && (detail.task.resultAvailable || detail.text === '')
        && detail.offset === (more ? previous.nextOffset : 0) && detail.nextOffset === detail.offset + [...detail.text].length
        && Number.isSafeInteger(detail.totalChars) && detail.totalChars >= detail.nextOffset
        && detail.complete === (detail.nextOffset === detail.totalChars), '子任务结果与请求不一致。');
      if (more) check(previous.task.childRunId === task.childRunId && previous.resultDigest === detail.resultDigest
        && detail.offset === previous.nextOffset, '子任务结果已变化，请重新读取。');
      set({ detail: more ? { ...detail, text: previous.text + detail.text } : detail });
    } catch { if (token === reading) set({ error: '子任务结果读取失败，请重新读取。' }); }
    finally { if (token === reading) set({ reading: false }); }
  }
  async function sendPromotion() {
    if (disposed || !state.pending || state.sending) return;
    const pending = state.pending;
    set({ sending: true, error: '' });
    try {
      const receipt = await hostRemote.promoteNativeChild(pending, lifetime.signal);
      check(receipt?.commandId === pending.commandId && ['accepted', 'duplicate'].includes(receipt.status), '子任务操作回执未确认。');
      if (disposed) return;
      set({ pending: null }); await load();
    } catch { set({ error: '转后台的接收结果尚未确认。请重试原请求；不会重新启动子任务。' }); }
    finally { set({ sending: false }); }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    refresh: () => load(), next: () => load(true), read,
    promote(task) {
      if (disposed || state.pending || !task.canPromote || task.parentRunId !== state.page?.runId) return;
      set({ pending: { ...identity, runId: task.parentRunId, childRunId: task.childRunId, commandId: commandId() } });
      return sendPromotion();
    },
    retryPromotion: sendPromotion,
    dispose() { if (disposed) return; disposed = true; lifetime.abort(); reading++; listeners.clear(); },
  };
}
