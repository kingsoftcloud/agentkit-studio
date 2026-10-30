import { createDshA2aHistoryState } from '../state/dsh-a2a-history.mjs';
import { createNativeA2aPanel } from './native-a2a.mjs';
export function createDshA2aPanel({ ui: { React, ResourceDialog, buttonStyle }, hostRemote }) {
  const { createElement: h, useEffect, useState, Fragment } = React;
  const Task = createNativeA2aPanel({ React, hostRemote, buttonStyle });
  return function DshA2aTasks({ agentId, sessionId }) {
    const [controller, setController] = useState(null), [state, setState] = useState({ page: null }), [open, setOpen] = useState(false);
    useEffect(() => {
      const next = createDshA2aHistoryState({ hostRemote, agentId, sessionId }); setController(next); setState(next.getSnapshot());
      const stop = next.subscribe(setState); void next.refresh(); return () => { stop(); next.dispose(); };
    }, [agentId, sessionId]);
    if (!state.error && !state.page?.applicable) return null;
    return h(Fragment, null,
      h('button', { type: 'button', style: buttonStyle(), onClick: () => { setOpen(true); void controller?.refresh(); } }, 'A2A 远端任务'),
      open ? h(ResourceDialog, { title: '本会话的 A2A 远端任务', detail: '查看和操作原远端任务。刷新清单只读取本地记录。', wide: true, onClose: () => setOpen(false) },
        h('button', { type: 'button', style: buttonStyle(), disabled: state.loading, onClick: () => void controller.refresh() }, '刷新任务清单'),
        state.error ? h('p', { role: 'alert' }, state.error) : null,
        state.page && !state.page.items.length ? h('p', null, '本会话尚无 A2A 调用记录。') : null,
        ...(state.page?.items ?? []).map(task => h(Task, { key: task.callId, task: { ...task, ownerKind: 'dsh' } })),
        state.page && !state.page.complete ? h('button', { type: 'button', style: buttonStyle(), disabled: state.loading,
          onClick: () => void controller.next() }, '加载更多远端任务') : null) : null);
  };
}
