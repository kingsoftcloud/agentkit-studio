const check = (condition, message) => { if (!condition) throw Error(message); };
const ended = new Set(['completed', 'failed', 'cancelled', 'rejected']);
const paused = value => ['input_required', 'auth_required'].includes(value);
async function observation(work, signal) {
  let stop;
  try {
    signal.throwIfAborted();
    const stopped = new Promise((resolve, reject) => {
        stop = () => reject(signal.reason); signal.addEventListener('abort', stop, { once: true });
        if (signal.aborted) stop();
      });
    const pending = new Promise(resolve => { signal.throwIfAborted(); resolve(work()); });
    const result = await Promise.race([pending, stopped]);
    signal.throwIfAborted(); return result;
  } finally { signal.removeEventListener('abort', stop); }
}
const outcomes = new Set(['observed', 'submitted', 'already_terminal', 'remote_cancelled', 'local_cancelled_before_send', 'unknown', 'remote_task_not_bound',
  'cancel_requested_but_remote_unknown', 'cancel_requested_but_remote_unsupported']);
const rejectedBeforeEffect = new Set(['A2A_CONTINUATION_DEADLINE_EXCEEDED', 'A2A_CONTINUATION_NOT_ALLOWED',
  'A2A_CONTROL_TASK_ALREADY_TERMINAL', 'A2A_CANCEL_ALREADY_REQUESTED',
  'A2A_CONTROL_PERMISSION_DENIED', 'A2A_CONTROL_INPUT_INVALID', 'STUDIO_NATIVE_A2A_PERMISSION_UNAVAILABLE',
  'A2A_HOST_DECISION_REQUIRED', 'A2A_HOST_DECISION_RECEIPT_INVALID', 'A2A_APPROVAL_RESPONSE_INVALID', 'A2A_APPROVAL_ALREADY_DECIDED',
  'A2A_APPROVAL_REJECTION_NOT_ALLOWED', 'A2A_APPROVAL_REQUEST_MISSING', 'A2A_INPUT_REQUEST_MISSING',
  'A2A_INPUT_ALREADY_DECIDED', 'A2A_STRUCTURED_INPUT_REQUIRED', 'A2A_STRUCTURED_INPUT_INVALID', 'A2A_INPUT_SCHEMA_INVALID',
  'A2A_QUESTION_ANSWER_CONFLICT', 'A2A_QUESTION_EFFECT_ALREADY_ADMITTED']);

/** An uncertain response retains the exact command. Refresh is read-only;
 * sending a fresh prompt is never a recovery operation. */
export function createNativeA2aTaskState({ hostRemote, task, commandId = () => globalThis.crypto.randomUUID() }) {
  const dsh = task.ownerKind === 'dsh';
  const keys = dsh ? ['agentId', 'sessionId', 'agentRevision', 'buildId', 'operationKey', 'callId']
    : ['agentId', 'sessionId', 'runId', ...(task.childRunId === undefined ? [] : ['childRunId']), 'operationKey', 'callId'];
  const identity = Object.fromEntries(keys.map(key => [key, task[key]]));
  const child = task.childRunId === undefined ? null : { agentId: task.childAgentId, sessionId: task.childSessionId };
  const control = dsh ? hostRemote.controlDshA2aTask : hostRemote.controlNativeA2aTask;
  const lifetime = new AbortController(), listeners = new Set(); let disposed = false, watch;
  let state = { task: null, loading: false, watching: false, sending: false, pending: null, outcome: '', error: '' };
  const set = update => { if (!disposed) { state = { ...state, ...update }; for (const listener of listeners) listener(state); } };
  const validate = value => {
    const locator = value?.operation_locator;
    check(value?.contract === 'agentkit.studio-a2a-task-control/v1' && (dsh
      ? keys.every(key => locator?.[key] === identity[key]) && !['scope', 'runId', 'executionFence'].some(key => Object.hasOwn(locator, key))
      : !child
        ? locator?.scope?.agentId === identity.agentId && ['sessionId', 'runId', 'operationKey', 'callId'].every(key => locator[key] === identity[key])
        : locator?.scope?.agentId === child.agentId && locator?.sessionId === child.sessionId && locator?.runId === identity.childRunId
          && ['operationKey', 'callId'].every(key => locator[key] === identity[key]))
      && typeof value.bindingDigest === 'string' && /^[a-f0-9]{64}$/u.test(value.bindingDigest)
      && (!state.task || state.task.bindingDigest === value.bindingDigest)
      && typeof value.task_id === 'string' && value.task_id.length > 0
      && (value.remote_task_id === null || typeof value.remote_task_id === 'string')
      && (value.remote_context_id === null || typeof value.remote_context_id === 'string')
      && ['submitted', 'working', 'input_required', 'auth_required', ...ended].includes(value.state)
      && outcomes.has(value.outcome) && (value.pauseDigest === null || /^[a-f0-9]{64}$/u.test(value.pauseDigest))
      && (value.subscriptionContract === undefined || value.subscriptionContract === 'agentkit.studio-a2a-task-subscription/v1')
      && (value.subscription === undefined || value.subscription?.contract === 'agentkit.studio-a2a-task-subscription/v1'
        && Number.isSafeInteger(value.subscription.events) && value.subscription.events >= 0 && ['eof', 'boundary'].includes(value.subscription.ended)),
    '远端任务回执与原调用不一致。');
    const delivery = value.eventDelivery;
    if (delivery !== undefined) {
      const permanent = ['A2A_EVENT_BATCH_TOO_LARGE', 'A2A_KERNEL_FACT_INVALID', 'A2A_EVENT_REF_CAPACITY',
        'A2A_EVENT_REF_CONFLICT', 'A2A_EVENT_REF_INVALID', 'A2A_TASK_NOT_FOUND'];
      const fields = ['contract', 'state', 'pendingBatches', 'acknowledgedBatches', 'failedBatches', 'errorCode'];
      check(delivery && delivery.contract === 'agentkit.a2a-event-delivery-status/v1'
        && Object.keys(delivery).length === fields.length && Object.keys(delivery).every(key => fields.includes(key))
        && ['pendingBatches', 'acknowledgedBatches', 'failedBatches'].every(key => Number.isSafeInteger(delivery[key]) && delivery[key] >= 0)
        && delivery.pendingBatches + delivery.acknowledgedBatches + delivery.failedBatches <= 8192
        && (delivery.errorCode === null || [...permanent, 'A2A_EVENT_DELIVERY_UNAVAILABLE'].includes(delivery.errorCode))
        && delivery.state === (delivery.failedBatches ? 'failed' : delivery.errorCode ? 'retrying' : delivery.pendingBatches ? 'pending' : 'delivered')
        && (delivery.state !== 'retrying' || delivery.pendingBatches > 0), '任务事件投递记录无效，请重新核对。');
    }
    return value;
  };
  const send = async () => {
    if (disposed || state.sending || state.loading || !state.pending) return;
    const pending = structuredClone(state.pending); set({ sending: true, error: '' });
    try {
      const result = validate(await control(pending, lifetime.signal));
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
  const refresh = async (kind = 'get') => {
    if (disposed || state.loading || state.sending) return;
    const active = kind === 'subscribe' ? new AbortController() : null;
    watch = active; set({ loading: true, watching: Boolean(active), error: '' });
    try {
      const request = { ...identity, kind, commandId: commandId() };
      const signal = active ? AbortSignal.any([lifetime.signal, active.signal]) : lifetime.signal;
      const result = validate(await observation(() => control(request, signal), signal));
      check(result.commandId === request.commandId, '远端任务查询回执不一致。');
      const pending = state.pending;
      set({ task: result, pending: pending && !ended.has(result.state)
        && !(['continue', 'reject'].includes(pending.kind) && paused(result.state) && pending.pauseDigest !== result.pauseDigest) ? pending : null });
    } catch (error) { if (!active?.signal.aborted) set({ error: error?.code === 'A2A_SUBSCRIPTION_UNSUPPORTED'
      ? '远端任务未提供流式订阅，可继续核对原任务。' : '远端任务核对失败，原调用不会自动重跑。' }); }
    finally { watch = null; set({ loading: false, watching: false }); }
  };
  const prepare = (kind, parts, json) => {
    if (disposed || state.pending || state.loading || state.sending || !state.task || ended.has(state.task.state)) return;
    if (['continue', 'reject'].includes(kind) && state.task.question?.contract === 'agentkit.a2a-question-ledger/v1'
      && state.task.question.status !== 'pending') return;
    if (kind === 'continue' && !paused(state.task.state)) return;
    if (kind === 'reject' && (!paused(state.task.state) || state.task.approval?.contract !== 'agentkit.a2a-remote-approval-control/v1'
      || state.task.approval.decision)) return;
    set({ pending: { ...identity, kind, commandId: commandId(), ...(kind === 'continue'
      ? { ...(json === undefined ? { parts: structuredClone(parts) } : { json }), pauseDigest: state.task.pauseDigest }
      : kind === 'reject' ? { pauseDigest: state.task.pauseDigest } : {}) } });
    return send();
  };
  return { getSnapshot: () => state, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    refresh: () => refresh(), watch: () => refresh('subscribe'), stopWatching: () => watch?.abort(),
    retry: send, continue: parts => prepare('continue', parts), continueJson: json => prepare('continue', undefined, json),
    reject: () => prepare('reject'), cancel: () => prepare('cancel'),
    dispose() { disposed = true; lifetime.abort(); listeners.clear(); } };
}
