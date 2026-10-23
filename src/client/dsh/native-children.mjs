import { agentFromSessionPreset } from '../state/conversation-agent.mjs';
import { createNativeChildrenState } from '../state/native-children.mjs';
import { createNativeRecoveryState } from '../state/native-recovery.mjs';
import { createNativeA2aPanel } from './native-a2a.mjs';
import { createDshA2aPanel } from './dsh-a2a.mjs';

const phases = { created: '已准备', preparing: '准备中', requesting_model: '推理中', requesting_context: '整理上下文',
  requesting_input: '读取输入', executing_tools: '执行工具', awaiting_interaction: '等待审批', paused: '已暂停',
  awaiting_reconciliation: '等待核对结果', reconciling_tool: '正在核对结果',
  completed: '已完成', failed: '已失败', interrupted: '需要恢复核对', canceled: '已取消', finalizing: '收尾中' };

export function createNativeChildPanel({ ui: { React: { createElement: h, useEffect, useState, Fragment }, ResourceDialog, buttonStyle },
  hostRemote, setInterval = globalThis.setInterval, clearInterval = globalThis.clearInterval }) {
  const A2aTask = createNativeA2aPanel({ React: { createElement: h, useEffect, useState }, hostRemote, buttonStyle });
  const DshA2aPanel = createDshA2aPanel({ ui: { React: { createElement: h, useEffect, useState, Fragment }, ResourceDialog, buttonStyle }, hostRemote });
  function TaskPanel({ agentId, sessionId }) {
    const [controller, setController] = useState(null), [state, setState] = useState({ page: null, detail: null }), [open, setOpen] = useState(false);
    const [drafts, setDrafts] = useState({});
    const [recovery, setRecovery] = useState(null), [recoveryState, setRecoveryState] = useState({ status: null });
    useEffect(() => {
      const next = createNativeRecoveryState({ hostRemote, agentId, sessionId });
      setRecovery(next); setRecoveryState(next.getSnapshot()); const stop = next.subscribe(setRecoveryState);
      return () => { stop(); next.dispose(); };
    }, [agentId, sessionId]);
    useEffect(() => {
      const next = createNativeChildrenState({ hostRemote, agentId, sessionId });
      setController(next); setState(next.getSnapshot()); const stop = next.subscribe(setState);
      return () => { stop(); next.dispose(); };
    }, [agentId, sessionId]);
    useEffect(() => {
      if (!open || !controller) return;
      void controller.refresh();
      void recovery?.refresh();
      const timer = setInterval(() => { if ((controller.getSnapshot().page?.offset ?? 0) === 0) void controller.refresh(); void recovery?.refresh(); }, 2500);
      return () => clearInterval(timer);
    }, [open, controller, recovery]);
    const page = state.page, detail = state.detail;
    const accounting = recoveryState.status?.accounting;
    return h(Fragment, null,
      h('button', { type: 'button', style: buttonStyle(), onClick: () => setOpen(true) }, '运行与子任务'),
      open ? h(ResourceDialog, { title: '本会话的运行与子任务', detail: '查看运行用量、恢复状态及各轮子任务。子任务结果仍需父任务验收。', wide: true, onClose: () => setOpen(false) },
        h('button', { type: 'button', style: buttonStyle(), disabled: !controller || state.loading, onClick: () => { void controller?.refresh(); void recovery?.refresh(); } }, state.loading ? '读取中…' : '刷新'),
        recoveryState.error ? h('p', { role: 'alert' }, recoveryState.error) : null,
        accounting ? h('section', { 'aria-label': 'Native 运行用量' },
          h('p', null, `运行用量${accounting.incomplete ? '（统计不完整，显示已知用量）' : accounting.final ? '' : '（截至目前）'}：模型 ${accounting.total.modelCalls} 次 · 工具 ${accounting.total.toolCalls} 次 · 输入 ${accounting.total.inputTokens} / 输出 ${accounting.total.outputTokens} tokens。`),
          h('p', { style: { fontSize: '12px' } }, '包含本运行、工具内模型调用及已结算的子任务用量。')) : null,
        recoveryState.status && recoveryState.status.state !== 'closed' ? h('section', { 'aria-label': '原运行恢复' },
          h('p', null, recoveryState.status.state === 'recovering' ? '原运行已接管，正在继续。'
            : recoveryState.status.state === 'reconciliation_required' ? '有执行结果未知的操作，需要核对；不会自动重跑。'
              : recoveryState.status.state === 'failed' ? '恢复未完成，请核对原配置后重试。' : '检测到尚未结束的原运行，可继续原任务。'),
          recoveryState.status.canResume && !recoveryState.pending ? h('button', { type: 'button', style: buttonStyle(), disabled: recoveryState.sending,
            onClick: () => void recovery.resume() }, '恢复原运行') : null,
          recoveryState.status.canReconcile && !recoveryState.pending ? h('button', { type: 'button', style: buttonStyle(), disabled: recoveryState.sending,
            onClick: () => void recovery.reconcile() }, '核对结果并继续原运行') : null) : null,
        recoveryState.pending ? h('button', { type: 'button', style: buttonStyle(), disabled: recoveryState.sending,
          onClick: () => void recovery.retry() }, recoveryState.sending ? '正在确认…' : '确认原运行恢复请求') : null,
        ...(recoveryState.status?.a2aTasks ?? []).map(task => h(A2aTask, { key: `${task.runId}:${task.operationKey}:${task.callId}`,
          task: { ...task, agentId, sessionId } })),
        state.error ? h('p', { role: 'alert' }, state.error) : null,
        state.pending ? h('button', { type: 'button', style: buttonStyle(), disabled: state.sending, onClick: () => void controller.retryControl() }, state.sending ? '正在确认…' : '重试原子任务请求') : null,
        page && !page.tasks.length ? h('p', null, '本会话还没有子任务。') : null,
        ...(page?.tasks ?? []).map(task => h('article', { key: task.childRunId, style: { borderTop: '1px solid var(--border, #ddd)', padding: '14px 0', overflowWrap: 'anywhere' }, 'aria-label': `子任务：${task.role}` },
          h('strong', null, task.role), ' · ', phases[task.phase] || '运行中', ' · ', task.delivery === 'foreground' ? '前台等待' : '后台',
          task.parentRunId !== page.runId ? h('span', null, ' · 历史轮次') : null,
          task.continuationOf ? h('span', null, ' · 续接任务') : null,
          task.lastControl ? h('p', { role: task.lastControl.status === 'rejected' ? 'alert' : 'status' },
            task.lastControl.status === 'pending' ? '操作已接收，等待投递。' : task.lastControl.status === 'delivered' ? '操作已投递至原子任务。'
              : `操作未投递：${task.lastControl.reason === 'stale_child_goal_revision' ? '子任务目标已变化，请刷新后核对指导。' : task.lastControl.reason}`) : null,
          h('p', { style: { whiteSpace: 'pre-wrap' } }, task.goalPreview, task.goalComplete ? '' : '…'),
          h('p', { style: { fontSize: '12px' } }, `子任务用量${task.usageComplete ? '' : '（可能未完整）'}：模型 ${task.usage.modelCalls} 次 · 工具 ${task.usage.toolCalls} 次 · 输入 ${task.usage.inputTokens} / 输出 ${task.usage.outputTokens} tokens；${task.usageIncludedInParent ? '已计入父任务' : '结算后计入父任务'}。`),
          h('button', { type: 'button', disabled: state.reading, style: buttonStyle(), onClick: () => void controller.read(task) }, task.resultAvailable ? '查看结果' : '查看状态'),
          task.canPromote ? h('button', { type: 'button', disabled: Boolean(state.pending), style: buttonStyle(), onClick: () => void controller.promote(task) }, '转为后台') : null,
          task.canCancel ? h('button', { type: 'button', disabled: Boolean(state.pending), style: buttonStyle(), onClick: () => void controller.cancel(task) }, '停止子任务') : null,
          task.canSendInput ? h('div', null,
            h('textarea', { 'aria-label': `给 ${task.role} 补充指导`, maxLength: 32768, rows: 2, value: drafts[task.childRunId] ?? '',
              disabled: Boolean(state.pending), onChange: event => setDrafts({ ...drafts, [task.childRunId]: event.target.value }) }),
            h('button', { type: 'button', disabled: Boolean(state.pending) || !drafts[task.childRunId]?.trim(), style: buttonStyle(),
              onClick: () => void controller.sendInput(task, drafts[task.childRunId]) }, '发送指导')) : null,
          h('details', null, h('summary', null, '任务标识'), h('p', null, task.childRunId), h('p', null, `会话：${task.sessionId}`), h('p', null, `父任务：${task.parentRunId}`)))),
        page && !page.complete ? h('button', { type: 'button', disabled: state.loading, style: buttonStyle(), onClick: () => void controller.next() }, '加载更多子任务') : null,
        detail ? h('section', { 'aria-label': '子任务结果', style: { marginTop: '16px' } }, h('h4', null, detail.task.role),
          detail.task.resultAvailable ? h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, detail.text)
            : h('p', null, detail.task.phase === 'interrupted' ? '结果未知，需要恢复核对。不会自动重跑副作用。' : '尚无安全封存且已结算的结果。'),
          !detail.complete ? h('button', { type: 'button', disabled: state.reading, style: buttonStyle(), onClick: () => void controller.read(detail.task, true) }, '继续读取结果') : null) : null) : null);
  }
  return function NativeChildPanel({ sessionId, useSessions }) {
    const session = useSessions(state => state?.byId?.[sessionId]), presetId = session?.projectionValues?.agentPreset;
    const [agent, setAgent] = useState(null);
    useEffect(() => {
      let active = true; setAgent(null);
      (async () => {
        const first = await hostRemote.agents({ source: 'local', pageSize: 100 }), items = [...(first.items ?? [])];
        for (let page = 2; active && items.length < Number(first.total || 0); page++) {
          const next = await hostRemote.agents({ source: 'local', pageSize: 100, page });
          if (!next.items?.length) break; items.push(...next.items);
        }
        const id = agentFromSessionPreset(presetId, items), found = items.find(item => item.metadata?.id === id);
        if (active && found?.metadata?.local === true && ['dsh-native', 'harness', 'codex'].includes(found.spec?.runtime?.type))
          setAgent({ id: found.metadata.id, runtime: found.spec.runtime.type, sessionId, presetId });
      })().catch(() => {});
      return () => { active = false; };
    }, [sessionId, presetId]);
    return agent?.sessionId === sessionId && agent?.presetId === presetId
      ? h(Fragment, null, agent.runtime === 'harness' ? h(TaskPanel, { key: `${agent.id}:${sessionId}`, agentId: agent.id, sessionId }) : null,
        h(DshA2aPanel, { key: `a2a:${agent.id}:${sessionId}`, agentId: agent.id, sessionId })) : null;
  };
}
