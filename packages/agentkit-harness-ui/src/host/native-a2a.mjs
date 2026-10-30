import { createNativeA2aTaskState } from './state/native-a2a.mjs';
const terminal = new Set(['completed', 'failed', 'cancelled', 'rejected']);
const states = { submitted: '已提交', working: '处理中', completed: '已完成', failed: '失败', cancelled: '已取消',
  rejected: '已拒绝', input_required: '等待补充输入', auth_required: '等待认证或授权输入' };
const outcomes = { submitted: '补充输入已提交。', remote_cancelled: '已核实远端取消。', already_terminal: '远端任务已结束。',
  local_cancelled_before_send: '已在发送前取消，请求未发送到远端。',
  remote_task_not_bound: '原调用尚未确认远端任务 ID。可请求取消，待原任务绑定后投递。',
  unknown: '操作结果未知，请核对原任务。', cancel_requested_but_remote_unknown: '取消尚未得到远端确认。',
  cancel_requested_but_remote_unsupported: '远端不支持取消该任务。' };

export function createNativeA2aPanel({ React: { createElement: h, useEffect, useState }, hostRemote, buttonStyle }) {
  return function A2aTask({ task }) {
    const [controller, setController] = useState(null), [state, setState] = useState({ task: null });
    const [text, setText] = useState(''), [json, setJson] = useState(false), [inputError, setInputError] = useState('');
    useEffect(() => {
      const next = createNativeA2aTaskState({ hostRemote, task }); setController(next); setState(next.getSnapshot());
      const stop = next.subscribe(setState); return () => { stop(); next.dispose(); };
    }, [task.agentId, task.sessionId, task.runId, task.childRunId, task.childAgentId, task.childSessionId,
      task.operationKey, task.callId, task.ownerKind, task.agentRevision, task.buildId]);
    const send = () => {
      try {
        const structured = state.task?.input?.contract === 'agentkit.a2a-remote-input-control/v1';
        const asJson = json || structured && state.task.input.request?.schema?.type !== 'string';
        if (asJson) JSON.parse(text); // Syntax only; the original bytes go to the Host's exact JSON parser.
        setInputError('');
        if (asJson) void controller.continueJson(text);
        else if (structured) void controller.continueJson(JSON.stringify(text));
        else void controller.continue([{ text }]);
      } catch { setInputError('请输入有效的 JSON 值。'); }
    };
    const value = state.task, busy = state.sending || state.loading;
    const forcedJson = Boolean(value?.input && value.input.request?.schema?.type !== 'string');
    const outcomeText = outcomes[value?.outcome === 'remote_task_not_bound' ? value.outcome : state.outcome];
    const waiting = value && ['input_required', 'auth_required'].includes(value.state);
    const recorded = value?.question?.contract === 'agentkit.a2a-question-ledger/v1' && value.question.status !== 'pending';
    const decided = recorded || value?.input?.decision || value?.approval?.decision;
    return h('article', { 'aria-label': 'A2A 远端任务', style: { borderTop: '1px solid var(--border, #ddd)', padding: '14px 0' } },
      h('strong', null, 'A2A 远端任务'), h('p', null, value ? states[value.state] : '尚未核对远端状态'),
      h('button', { type: 'button', style: buttonStyle(), disabled: !controller || busy, onClick: () => void controller.refresh() }, '核对远端任务'),
      value?.subscriptionContract === 'agentkit.studio-a2a-task-subscription/v1' && !terminal.has(value.state)
        ? h('button', { type: 'button', style: buttonStyle(), disabled: busy && !state.watching,
          onClick: () => state.watching ? controller.stopWatching() : void controller.watch() }, state.watching ? '停止观察' : '观察远端进展') : null,
      value?.subscription ? h('p', { role: 'status' }, terminal.has(value.state) ? '已核对远端终态。' : '本次观察已结束，远端任务仍可核对。') : null,
      value && !terminal.has(value.state) ? h('button', { type: 'button', style: buttonStyle(), disabled: busy || Boolean(state.pending),
        onClick: () => void controller.cancel() }, '请求远端取消') : null,
      outcomeText ? h('p', { role: 'status' }, outcomeText) : null,
      state.pending ? h('button', { type: 'button', style: buttonStyle(), disabled: busy, onClick: () => void controller.retry() }, '确认原操作回执') : null,
      state.error ? h('p', { role: 'alert' }, state.error) : null,
      value?.eventDelivery ? h('section', { 'aria-label': '任务事件同步' },
        h('p', { role: value.eventDelivery.state === 'failed' ? 'alert' : 'status' }, ({
          delivered: '任务事件已获平台确认。', pending: '任务事件等待投递到平台。',
          retrying: '任务事件暂未送达，宿主将重试原事件。', failed: '部分任务事件投递失败，原记录已保留。',
        })[value.eventDelivery.state]),
        h('p', null, `待投递 ${value.eventDelivery.pendingBatches} 批 · 已确认 ${value.eventDelivery.acknowledgedBatches} 批 · 失败 ${value.eventDelivery.failedBatches} 批`),
        value.eventDelivery.errorCode ? h('p', null, `诊断：${value.eventDelivery.errorCode}`) : null,
        value.eventDelivery.state !== 'delivered' ? h('p', null, '事件投递状态不改变远端任务结果。请携带原调用标识核对平台记录，不要重新执行任务。') : null) : null,
      recorded ? h('p', { role: 'status' }, ({ awaiting_permission: '回答已保存，正在等待本次远端操作的权限确认。',
        operation_denied: '回答已保存，本次远端操作未获授权；原工具调用已在本地结束，远端状态保持可核对。',
        expired: '等待已超时；原工具调用已在本地结束，远端状态保持可核对。',
        rejected: '已拒绝补充输入；原工具调用已在本地结束，未请求远端取消。',
        operation_admitted: '回答已保存，操作已登记；可核对原远端任务的结果。',
      })[value.question.stage] || '回答已保存。') : null,
      waiting && value.approval ? h('section', { 'aria-label': '远端审批' },
        h('p', null, value.approval.request?.detail?.name || '远端任务请求审批'),
        h('p', null, decided ? '此审批已有决定，可核对原任务或请求取消。' : '批准后将请求本地主机确认，再继续原远端任务。'),
        !decided ? h('button', { type: 'button', style: buttonStyle(), disabled: busy || Boolean(state.pending),
          onClick: () => void controller.continueJson('"approve"') }, '批准并继续原任务') : null,
        !decided ? h('button', { type: 'button', style: buttonStyle(), disabled: busy || Boolean(state.pending),
          onClick: () => void controller.reject() }, '拒绝并请求远端取消') : null) : null,
      waiting && !value.approval ? h('section', { 'aria-label': '远端补充输入' },
        ...(value.pause?.parts ?? []).filter(part => typeof part.text === 'string').map((part, index) => h('p', { key: index, style: { whiteSpace: 'pre-wrap' } }, part.text)),
        value.pause ? h('details', null, h('summary', null, '远端输入要求'), h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, JSON.stringify(value.pause, null, 2))) : null,
        decided ? h('p', { role: 'status' }, '此输入已有决定，可核对原任务或请求取消。') : null,
        !decided ? h('label', null, h('input', { type: 'checkbox', checked: json || forcedJson, disabled: forcedJson,
          onChange: event => setJson(event.target.checked) }), '按远端要求提供 JSON 值') : null,
        !decided ? h('textarea', { 'aria-label': '补充输入内容', value: text, onChange: event => setText(event.target.value), disabled: busy || Boolean(state.pending) }) : null,
        !decided ? h('button', { type: 'button', style: buttonStyle(), disabled: busy || Boolean(state.pending)
          || (!text.trim() && !(value.input?.request?.schema?.type === 'string' && !json)), onClick: send }, '提交补充输入') : null,
        inputError ? h('p', { role: 'alert' }, inputError) : null) : null,
      h('p', { style: { fontSize: '12px' } }, task.ownerKind === 'dsh'
        ? '此处操作原远端任务，不会重新发送模型提示，也不会改写已封存的工具回执。'
        : '此处操作原远端任务。当前会话等待期间，任务结束后会继续原运行；重启后可在原运行恢复区核对结果并继续。'),
      value?.output_refs?.length ? h('details', null, h('summary', null, '远端任务输出'),
        ...value.output_refs.map(ref => h('pre', { key: `${ref.scope_id}:${ref.item_id}`, style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } },
          Object.values(value.snapshots?.[`${ref.scope_id}:${ref.item_id}`] ?? {}).join('\n')))) : null,
      h('details', null, h('summary', null, '原调用标识'),
        task.ownerKind === 'dsh' ? h('p', null, `Agent 版本：${task.agentRevision}${task.buildId ? ` · Build：${task.buildId}` : ''}`) : h('p', null, task.runId),
        h('p', null, task.callId)));
  };
}
