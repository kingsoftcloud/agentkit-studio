import { assistantRequestText } from '../state/assistant-attachments.mjs';
import { createAssistantNativeTransport } from '../dsh/assistant-native-transport.mjs';
import { createAssistantNativeGraph } from '../dsh/assistant-native-graph.mjs';

/** The cloud graph owns this subtree; a view change releases reads, not cloud work. */
export function createAssistantNativeComposer({ ui, hostRemote, nativeModules, window }) {
  const { React: { createElement: h, useEffect, useRef, useState }, Button, BRAND } = ui;
  return function AssistantNativeComposer({ agentId, onAccepted, hiddenComposer = false }) {
    const container = useRef(null), active = useRef(null), accepted = useRef(onAccepted);
    accepted.current = onAccepted;
    const [revision, setRevision] = useState(0), [state, setState] = useState({ loading: true, error: '', pending: null, busy: false });
    useEffect(() => {
      let alive = true, graph, transport; const lifetime = new AbortController();
      setState({ loading: true, error: '', pending: null, busy: false });
      const start = async () => {
        try {
          transport = await createAssistantNativeTransport({ execute: (id, operation, input, signal) => hostRemote.assistantExecute(id, operation, input, signal), agentId,
            storage: window.localStorage, crypto: window.crypto,
            onChange(next) { if (!alive) return; setState(previous => ({ ...previous, ...next })); if (!next.pending && !next.busy) accepted.current?.(); },
          });
          if (!alive) { await transport.dispose(); return; }
          graph = await createAssistantNativeGraph({ modules: nativeModules(), transport, window, signal: lifetime.signal });
          if (!alive) { await graph.dispose(); return; }
          graph.mount(container.current); active.current = graph;
          setState(previous => ({ ...previous, ...transport.getState(), loading: false }));
        } catch (error) { if (alive) setState(previous => ({ ...previous, loading: false, error: error.message, disconnected: true })); await transport?.dispose(); }
      };
      void start();
      return () => { alive = false; active.current = null; lifetime.abort(); void (graph ? graph.dispose() : transport?.dispose()); };
    }, [agentId, revision]);
    const action = (label, click, disabled = false) => h(Button || 'button', { type: 'button', onClick: click, disabled, ...(Button ? { size: 'sm', variant: 'secondary' } : {}) }, label);
    return h('section', { 'data-assistant-native-composer': true, 'aria-label': '云端原生输入', style: { minWidth: 0 } },
      state.loading ? h('p', { role: 'status' }, '正在连接云端输入…') : null,
      state.error || state.readError ? h('p', { role: 'alert', style: { color: BRAND.danger, fontSize: '12px' } }, state.error || state.readError) : null,
      state.pending ? h('div', { role: 'status', style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px' } },
        h('span', null, assistantRequestText(state.pending.request) || `附件消息（${state.pending.request.content?.filter(part => part.type !== 'text').length || 0} 个附件）`, ' · 保存待确认'),
        action('确认提交', async () => { const graph = active.current, result = await graph?.confirm(); if (result?.accepted && active.current === graph) { accepted.current?.(); if (result.reset) setRevision(value => value + 1); } }, state.busy || state.disconnected)) : null,
      state.errorCode === 'ASSISTANT_ATTACHMENT_EXPIRED' ? action('重新选择附件', () => { if (active.current?.transport.discardExpired()) setRevision(value => value + 1); }, state.busy) : null,
      state.disconnected ? action('重新连接输入', () => setRevision(value => value + 1), state.loading) : null,
      h('div', { ref: container, hidden: hiddenComposer, style: { minWidth: 0 } }));
  };
}
