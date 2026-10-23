import { createNativeA2aTaskState } from '../state/native-a2a.mjs';
const terminal = new Set(['completed', 'failed', 'cancelled', 'rejected']);
const states = { submitted: '已提交', working: '处理中', completed: '已完成', failed: '失败', cancelled: '已取消',
  rejected: '已拒绝', input_required: '等待补充输入', auth_required: '等待认证或授权输入' };
const outcomes = { submitted: '补充输入已提交。', remote_cancelled: '已核实远端取消。', already_terminal: '远端任务已结束。',
  unknown: '操作结果未知，请核对原任务。', cancel_requested_but_remote_unknown: '取消尚未得到远端确认。',
  cancel_requested_but_remote_unsupported: '远端不支持取消该任务。' };

export function createNativeA2aPanel({ React: { createElement: h, useEffect, useState }, hostRemote, buttonStyle }) {
  return function A2aTask({ task }) {
    const [controller, setController] = useState(null), [state, setState] = useState({ task: null });
    const [text, setText] = useState(''), [json, setJson] = useState(false), [inputError, setInputError] = useState('');
    useEffect(() => {
      const next = createNativeA2aTaskState({ hostRemote, task }); setController(next); setState(next.getSnapshot());
      const stop = next.subscribe(setState); return () => { stop(); next.dispose(); };
    }, [task.agentId, task.sessionId, task.runId, task.operationKey, task.callId]);
    const send = () => {
      try {
        if (json) JSON.parse(text); // Syntax only; the original bytes go to the Host's exact JSON parser.
        setInputError('');
        if (json) void controller.continueJson(text);
        else void controller.continue([{ text }]);
      } catch { setInputError('请输入有效的 JSON 值。'); }
    };
    const value = state.task, busy = state.sending || state.loading;
    const waiting = value && ['input_required', 'auth_required'].includes(value.state);
    return h('article', { 'aria-label': 'A2A 远端任务', style: { borderTop: '1px solid var(--border, #ddd)', padding: '14px 0' } },
      h('strong', null, 'A2A 远端任务'), h('p', null, value ? states[value.state] : '尚未核对远端状态'),
      h('button', { type: 'button', style: buttonStyle(), disabled: !controller || busy, onClick: () => void controller.refresh() }, '核对远端任务'),
      value && !terminal.has(value.state) ? h('button', { type: 'button', style: buttonStyle(), disabled: busy || Boolean(state.pending),
        onClick: () => void controller.cancel() }, '请求远端取消') : null,
      outcomes[state.outcome] ? h('p', { role: 'status' }, outcomes[state.outcome]) : null,
      state.pending ? h('button', { type: 'button', style: buttonStyle(), disabled: busy, onClick: () => void controller.retry() }, '确认原操作回执') : null,
      state.error ? h('p', { role: 'alert' }, state.error) : null,
      waiting ? h('section', { 'aria-label': '远端补充输入' },
        ...(value.pause?.parts ?? []).filter(part => typeof part.text === 'string').map((part, index) => h('p', { key: index, style: { whiteSpace: 'pre-wrap' } }, part.text)),
        value.pause ? h('details', null, h('summary', null, '远端输入要求'), h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, JSON.stringify(value.pause, null, 2))) : null,
        h('label', null, h('input', { type: 'checkbox', checked: json, onChange: event => setJson(event.target.checked) }), '按远端要求提供 JSON 值'),
        h('textarea', { 'aria-label': '补充输入内容', value: text, onChange: event => setText(event.target.value), disabled: busy || Boolean(state.pending) }),
        h('button', { type: 'button', style: buttonStyle(), disabled: busy || Boolean(state.pending) || !text.trim(), onClick: send }, '提交补充输入'),
        inputError ? h('p', { role: 'alert' }, inputError) : null) : null,
      h('p', { style: { fontSize: '12px' } }, '此处操作原远端任务。任务结束后，可在原运行恢复区点击“核对结果并继续原运行”。'),
      value?.output_refs?.length ? h('details', null, h('summary', null, '远端任务输出'),
        ...value.output_refs.map(ref => h('pre', { key: `${ref.scope_id}:${ref.item_id}`, style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } },
          Object.values(value.snapshots?.[`${ref.scope_id}:${ref.item_id}`] ?? {}).join('\n')))) : null,
      h('details', null, h('summary', null, '原调用标识'), h('p', null, task.runId), h('p', null, task.callId)));
  };
}
