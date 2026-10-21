import { agentFromSessionPreset } from '../state/conversation-agent.mjs';
import { createNativeChildrenState } from '../state/native-children.mjs';

const phases = { created: '已准备', preparing: '准备中', requesting_model: '推理中', requesting_context: '整理上下文',
  requesting_input: '读取输入', executing_tools: '执行工具', awaiting_interaction: '等待审批', paused: '已暂停',
  completed: '已完成', failed: '已失败', interrupted: '需要恢复核对', canceled: '已取消', finalizing: '收尾中' };

export function createNativeChildPanel({ ui: { React: { createElement: h, useEffect, useState, Fragment }, ResourceDialog, buttonStyle },
  hostRemote, setInterval = globalThis.setInterval, clearInterval = globalThis.clearInterval }) {
  function TaskPanel({ agentId, sessionId }) {
    const [controller, setController] = useState(null), [state, setState] = useState({ page: null, detail: null }), [open, setOpen] = useState(false);
    useEffect(() => {
      const next = createNativeChildrenState({ hostRemote, agentId, sessionId });
      setController(next); setState(next.getSnapshot()); const stop = next.subscribe(setState);
      return () => { stop(); next.dispose(); };
    }, [agentId, sessionId]);
    useEffect(() => {
      if (!open || !controller) return;
      void controller.refresh();
      const timer = setInterval(() => { if ((controller.getSnapshot().page?.offset ?? 0) === 0) void controller.refresh(); }, 2500);
      return () => clearInterval(timer);
    }, [open, controller]);
    const page = state.page, detail = state.detail;
    return h(Fragment, null,
      h('button', { type: 'button', style: buttonStyle(), onClick: () => setOpen(true) }, '子任务'),
      open ? h(ResourceDialog, { title: '本会话的子任务', detail: '显示当前轮和历史轮次；子任务结果是证据，不代表父任务验收通过。', wide: true, onClose: () => setOpen(false) },
        h('button', { type: 'button', style: buttonStyle(), disabled: !controller || state.loading, onClick: () => void controller?.refresh() }, state.loading ? '读取中…' : '刷新'),
        state.error ? h('p', { role: 'alert' }, state.error) : null,
        state.pending ? h('button', { type: 'button', style: buttonStyle(), disabled: state.sending, onClick: () => void controller.retryPromotion() }, state.sending ? '正在确认…' : '重试原转后台请求') : null,
        page && !page.tasks.length ? h('p', null, '本会话还没有子任务。') : null,
        ...(page?.tasks ?? []).map(task => h('article', { key: task.childRunId, style: { borderTop: '1px solid var(--border, #ddd)', padding: '14px 0', overflowWrap: 'anywhere' }, 'aria-label': `子任务：${task.role}` },
          h('strong', null, task.role), ' · ', phases[task.phase] || '运行中', ' · ', task.delivery === 'foreground' ? '前台等待' : '后台',
          task.parentRunId !== page.runId ? h('span', null, ' · 历史轮次') : null,
          task.continuationOf ? h('span', null, ' · 续接任务') : null,
          h('p', { style: { whiteSpace: 'pre-wrap' } }, task.goalPreview, task.goalComplete ? '' : '…'),
          h('p', { style: { fontSize: '12px' } }, `子任务用量${task.usageComplete ? '' : '（可能未完整）'}：模型 ${task.usage.modelCalls} 次 · 工具 ${task.usage.toolCalls} 次 · 输入 ${task.usage.inputTokens} / 输出 ${task.usage.outputTokens} tokens；${task.usageIncludedInParent ? '已计入父任务' : '结算后计入父任务'}。`),
          h('button', { type: 'button', disabled: state.reading, style: buttonStyle(), onClick: () => void controller.read(task) }, task.resultAvailable ? '查看结果' : '查看状态'),
          task.canPromote ? h('button', { type: 'button', disabled: Boolean(state.pending), style: buttonStyle(), onClick: () => void controller.promote(task) }, '转为后台') : null,
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
        if (active && found?.metadata?.local === true && found.spec?.runtime?.type === 'harness') setAgent({ id: found.metadata.id, sessionId, presetId });
      })().catch(() => {});
      return () => { active = false; };
    }, [sessionId, presetId]);
    return agent?.sessionId === sessionId && agent?.presetId === presetId
      ? h(TaskPanel, { key: `${agent.id}:${sessionId}`, agentId: agent.id, sessionId }) : null;
  };
}
