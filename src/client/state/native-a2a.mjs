const check = (condition, message) => { if (!condition) throw Error(message); };
const ended = new Set(['completed', 'failed', 'cancelled', 'rejected']);
const paused = value => ['input_required', 'auth_required'].includes(value);
const outcomes = new Set(['observed', 'submitted', 'already_terminal', 'remote_cancelled', 'unknown', 'remote_task_not_bound',
  'cancel_requested_but_remote_unknown', 'cancel_requested_but_remote_unsupported']);
const rejectedBeforeEffect = new Set(['A2A_CONTINUATION_DEADLINE_EXCEEDED', 'A2A_CONTINUATION_NOT_ALLOWED',
  'A2A_CONTROL_TASK_ALREADY_TERMINAL', 'A2A_CANCEL_ALREADY_REQUESTED',
  'A2A_CONTROL_PERMISSION_DENIED', 'A2A_CONTROL_INPUT_INVALID', 'STUDIO_NATIVE_A2A_PERMISSION_UNAVAILABLE']);

/** An uncertain response retains the exact command. Refresh is read-only;
 * sending a fresh prompt is never a recovery operation. */
export function createNativeA2aTaskState({ hostRemote, task, commandId = () => globalThis.crypto.randomUUID() }) {
  const identity = Object.fromEntries(['agentId', 'sessionId', 'runId', 'operationKey', 'callId'].map(key => [key, task[key]]));
  const lifetime = new AbortController(), listeners = new Set(); let disposed = false;
  let state = { task: null, loading: false, sending: false, pending: null, outcome: '', error: '' };
  const set = update => { if (!disposed) { state = { ...state, ...update }; for (const listener of listeners) listener(state); } };
  const validate = value => {
    const locator = value?.operation_locator;
    check(value?.contract === 'agentkit.studio-a2a-task-control/v1' && locator?.scope?.agentId === identity.agentId
      && ['sessionId', 'runId', 'operationKey', 'callId'].every(key => locator[key] === identity[key])
      && typeof value.bindingDigest === 'string' && /^[a-f0-9]{64}$/u.test(value.bindingDigest)
      && (!state.task || state.task.bindingDigest === value.bindingDigest)
      && typeof value.task_id === 'string' && value.task_id.length > 0
      && (value.remote_task_id === null || typeof value.remote_task_id === 'string')
      && (value.remote_context_id === null || typeof value.remote_context_id === 'string')
      && ['submitted', 'working', 'input_required', 'auth_required', ...ended].includes(value.state)
      && outcomes.has(value.outcome) && (value.pauseDigest === null || /^[a-f0-9]{64}$/u.test(value.pauseDigest)),
    '远端任务回执与原调用不一致。');
    return value;
  };
  const send = async () => {
    if (disposed || state.sending || state.loading || !state.pending) return;
    const pending = structuredClone(state.pending); set({ sending: true, error: '' });
    try {
      const result = validate(await hostRemote.controlNativeA2aTask(pending, lifetime.signal));
      check(result.commandId === pending.commandId, '远端任务命令回执不一致。');
      const unknown = ['unknown', 'cancel_requested_but_remote_unknown'].includes(result.outcome);
      set({ task: result, pending: unknown ? pending : null, outcome: result.outcome });
    } catch (error) {
      if (error?.code === 'A2A_CONTROL_PERMISSION_DENIED' && pending.kind === 'cancel')
        set({ error: '本次取消未获得批准。原取消命令已保留，重新确认将再次请求批准。' });
      else if (rejectedBeforeEffect.has(error?.code)) set({ pending: null, error: '本次操作未执行，请核对输入、权限或原任务的截止时间。' });
      else set({ error: '操作回执尚未确认，请核对远端任务或确认原请求。' });
    }
    finally { set({ sending: false }); }
  };
  const refresh = async () => {
    if (disposed || state.loading || state.sending) return;
    set({ loading: true, error: '' });
    try {
      const request = { ...identity, kind: 'get', commandId: commandId() };
      const result = validate(await hostRemote.controlNativeA2aTask(request, lifetime.signal));
      check(result.commandId === request.commandId, '远端任务查询回执不一致。');
      const pending = state.pending;
      set({ task: result, pending: pending && !ended.has(result.state)
        && !(pending.kind === 'continue' && paused(result.state) && pending.pauseDigest !== result.pauseDigest) ? pending : null });
    } catch { set({ error: '远端任务核对失败，原调用不会自动重跑。' }); }
    finally { set({ loading: false }); }
  };
  const prepare = (kind, parts, json) => {
    if (disposed || state.pending || state.loading || state.sending || !state.task || ended.has(state.task.state)) return;
    if (kind === 'continue' && !paused(state.task.state)) return;
    set({ pending: { ...identity, kind, commandId: commandId(), ...(kind === 'continue'
      ? { ...(json === undefined ? { parts: structuredClone(parts) } : { json }), pauseDigest: state.task.pauseDigest } : {}) } });
    return send();
  };
  return { getSnapshot: () => state, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    refresh, retry: send, continue: parts => prepare('continue', parts), continueJson: json => prepare('continue', undefined, json), cancel: () => prepare('cancel'),
    dispose() { disposed = true; lifetime.abort(); listeners.clear(); } };
}
