import { createNativeConversationState } from '../state/native-conversation.mjs';

export function createNativeConversationPanel({ React, hostRemote, buttonStyle }) {
  const { createElement: h, useEffect, useState, Fragment } = React;
  function NativeConversationPanel({ agentId, sessionId }) {
    const [controller, setController] = useState(null);
    const [state, setState] = useState({ status: null, loading: false, sending: false, pending: null, error: '' });
    useEffect(() => {
      const next = createNativeConversationState({ hostRemote, agentId, sessionId });
      setController(next); setState(next.getSnapshot());
      const stop = next.subscribe(setState);
      return () => { stop(); next.dispose(); };
    }, [agentId, sessionId]);
    const status = state.status;
    return h(Fragment, null,
      h('details', { onToggle: event => { if (event.currentTarget.open) void controller?.refresh(); } },
        h('summary', null, '对话回退'),
        h('p', { style: { fontSize: '12px' } }, '回退到这条输入之前，后续对话将移出当前分支，工作区文件保留。'),
        status?.requiresStop ? h('p', null, '回退将先停止需要移除的任务；确认执行结果后切换对话分支。') : null,
        state.error ? h('p', { role: 'alert' }, state.error) : null,
        status && !status.canRewind ? h('p', null, '当前对话不可回退。') : null,
        status && status.canRewind ? (status.inputs.length
          ? status.inputs.map(input => h('div', { key: input.messageId, style: { borderTop: '1px solid var(--border, #ddd)', padding: '8px 0' } },
              h('p', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, input.text),
              h('button', { type: 'button', style: buttonStyle(), disabled: Boolean(state.pending) || state.sending,
                onClick: () => void controller.rewind(input.messageId) }, status.requiresStop ? '停止相关任务并回退' : '回退到这条输入之前'),
              status.canRewindWorkspace ? h('button', { type: 'button', style: buttonStyle(), disabled: Boolean(state.pending) || state.sending,
                onClick: () => void controller.previewWorkspace(input.messageId) }, status.requiresStop ? '停止相关任务并预览文件回退' : '预览同时回退文件') : null))
          : h('p', null, '没有可回退的用户输入。')) : null,
        state.pending ? h('p', { role: 'status' }, '回退请求尚未确认。') : null,
        state.preview ? h('div', { role: 'region', 'aria-label': '文件回退预览' },
          h('p', null, state.preview.files.length ? '以下文件将随对话一起回退：' : '没有需要恢复的文件，将回退对话。'),
          ...state.preview.files.map(file => h('p', { key: file.path }, `${file.action === 'delete' ? '删除' : '恢复'}：${file.path}`)),
          ...state.preview.unsafeFiles.map((file, index) => h('p', { key: index, role: 'alert' }, `${file.path ?? ''} ${file.reason}`)),
          h('button', { type: 'button', style: buttonStyle(), disabled: state.sending || !state.preview.canApply,
            onClick: () => void controller.confirmWorkspace() }, '确认回退对话和文件'),
          h('button', { type: 'button', style: buttonStyle(), disabled: state.sending,
            onClick: () => controller.cancelPreview() }, '取消预览')) : null,
        state.pending ? h('button', { type: 'button', style: buttonStyle(), disabled: state.sending,
          onClick: () => void controller.retry() }, state.sending ? '正在确认…' : '重试原回退请求') : null,
        h('button', { type: 'button', style: buttonStyle(), disabled: !controller || state.loading,
          onClick: () => void controller?.refresh() }, state.loading ? '读取中…' : '刷新')));
  }
  return NativeConversationPanel;
}
