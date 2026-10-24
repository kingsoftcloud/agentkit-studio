const check = (value, message) => { if (!value) throw Error(message); };
const counters = ['inputTokens', 'outputTokens', 'modelCalls', 'toolCalls', 'cost'];
const optionalCounters = ['cachedInputTokens', 'reasoningTokens'];
const validUsage = usage => usage && typeof usage === 'object' && !Array.isArray(usage)
  && Object.keys(usage).every(key => [...counters, ...optionalCounters].includes(key))
  && [...counters, ...optionalCounters.filter(key => key in usage)].every(key => typeof usage[key] === 'number'
    && Number.isFinite(usage[key]) && usage[key] >= 0 && (key === 'cost' || Number.isSafeInteger(usage[key])));

/** Reads never resume work. A lost response retains the original Run identity. */
export function createNativeRecoveryState({ hostRemote, agentId, sessionId, newCommandId = () => globalThis.crypto.randomUUID() }) {
  const identity = { agentId, sessionId }, lifetime = new AbortController(), listeners = new Set();
  let disposed = false, state = { status: null, loading: false, sending: false, pending: null, error: '' };
  const set = change => { if (!disposed) { state = { ...state, ...change }; for (const listener of listeners) listener(state); } };
  const validate = (value, runId) => {
    check(value?.contract === 'agentkit.studio-native-recovery/v1' && value.agentId === agentId && value.sessionId === sessionId
      && ['available', 'recovering', 'reconciliation_required', 'failed', 'closed'].includes(value.state)
      && typeof value.canResume === 'boolean' && (!value.canResume || typeof value.runId === 'string' && value.runId.trim())
      && (!runId || value.runId === runId), '恢复记录与原会话或运行不一致，请刷新核对。');
    const receiptWait = value.receiptWait;
    if (receiptWait !== undefined) check(receiptWait?.contract === 'agentkit.native-a2a-receipt-wait/v1'
      && value.phase === 'awaiting_reconciliation'
      && ['operationKey', 'callId'].every(key => typeof receiptWait[key] === 'string' && receiptWait[key].trim()
        && receiptWait[key] === value.reconciliation?.[key]), '回执等待与原运行不一致，请刷新核对。');
    if (value.canReconcile !== undefined) check(typeof value.canReconcile === 'boolean'
      && (!value.canReconcile || (value.state === 'reconciliation_required' && (!value.canResume || receiptWait)
        || value.state === 'recovering' && !value.canResume)
        && value.phase === 'awaiting_reconciliation' && typeof value.runId === 'string' && value.runId.trim()
        && value.reconciliation?.contract === 'agentkit.tool-receipt-observation/v1'
        && ['operationKey', 'callId'].every(key => typeof value.reconciliation[key] === 'string'
          && value.reconciliation[key].trim() && value.reconciliation[key].length <= 256)),
    '核对记录与原运行不一致，请刷新核对。');
    if (value.a2aTasks !== undefined) check(Array.isArray(value.a2aTasks) && value.a2aTasks.length <= 10000
      && value.a2aTasks.every(task => task?.runId === value.runId && ['runId', 'operationKey', 'callId']
        .every(key => typeof task[key] === 'string' && task[key].trim() && task[key].length <= 256)),
    '远端任务清单与原运行不一致，请刷新核对。');
    const accounting = value.accounting;
    if (accounting != null) {
      check(accounting.contract === 'agentkit.studio-native-usage/v1' && accounting.runId === value.runId
        && Number.isSafeInteger(accounting.snapshotRevision) && accounting.snapshotRevision >= 0
        && ['final', 'incomplete', 'complete'].every(key => typeof accounting[key] === 'boolean')
        && accounting.complete === (accounting.final && !accounting.incomplete)
        && [accounting.own, accounting.descendant, accounting.total].every(validUsage)
        && [...counters, ...optionalCounters].every(key => (accounting.total[key] ?? 0)
          === (accounting.own[key] ?? 0) + (accounting.descendant[key] ?? 0)), '运行用量与原记录不一致，请刷新核对。');
    }
    return value;
  };
  async function refresh() {
    if (disposed || state.loading) return;
    set({ loading: true });
    try {
      const status = validate(await hostRemote.nativeRecoveryStatus(identity, lifetime.signal));
      set({ status, error: '' });
    } catch { set({ error: '恢复状态读取失败，请刷新。' }); }
    finally { set({ loading: false }); }
  }
  async function send() {
    if (disposed || state.sending || !state.pending) return;
    const pending = state.pending;
    set({ sending: true, error: '' });
    try {
      const operation = pending.operationKey ? hostRemote.reconcileNativeTool : hostRemote.resumeNativeRun;
      const status = validate(await operation(pending, lifetime.signal), pending.runId);
      set({ status, pending: null });
      await refresh();
    } catch { set({ error: '恢复请求尚未确认。可确认原运行的请求，请勿创建替代任务。' }); }
    finally { set({ sending: false }); }
  }
  return { getSnapshot: () => state, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    refresh, retry: send,
    resume() {
      if (disposed || state.pending || !state.status?.canResume) return;
      set({ pending: { ...identity, runId: state.status.runId } }); return send();
    },
    reconcile() {
      if (disposed || state.pending || !state.status?.canReconcile) return;
      set({ pending: { ...identity, runId: state.status.runId, operationKey: state.status.reconciliation.operationKey,
        commandId: newCommandId() } }); return send();
    },
    dispose() { disposed = true; lifetime.abort(); listeners.clear(); },
  };
}
