import { createAssistantScheduleGraph } from '../dsh/assistant-schedule-graph.mjs';

/** A view change releases only task-manager reads; native scheduled work remains cloud-owned. */
export function createAssistantNativeSchedule({ ui, hostRemote, nativeModules }) {
  const { React: { createElement: h, useEffect, useRef, useState }, BRAND, Button } = ui;
  return function AssistantNativeSchedule({ agentId, sessionId, onConversation }) {
    const container = useRef(null), navigate = useRef(onConversation); navigate.current = onConversation;
    const [error, setError] = useState(''), [revision, setRevision] = useState(0);
    useEffect(() => {
      const lifetime = new AbortController(); let graph;
      setError('');
      void (async () => {
        try {
          graph = await createAssistantScheduleGraph({ modules: nativeModules(), agentId, sessionId, signal: lifetime.signal,
            execute: (id, operation, input, signal) => hostRemote.assistantExecute(id, operation, input, signal), onConversation: () => navigate.current?.() });
          if (lifetime.signal.aborted) { await graph.dispose(); return; }
          graph.mount(container.current);
        } catch (reason) { if (!lifetime.signal.aborted) setError(reason.message || '无法读取云端计划任务'); }
      })();
      return () => { lifetime.abort(); void graph?.dispose(); };
    }, [agentId, sessionId, revision]);
    return h('section', { 'data-assistant-native-schedule': true, style: { minWidth: 0 } },
      error ? h('div', { role: 'alert', style: { color: BRAND.danger } }, error, ' ', h(Button || 'button', { onClick: () => setRevision(value => value + 1) }, '重新连接')) : null,
      h('div', { ref: container, style: { height: 'min(680px, 65vh)', minHeight: '360px', minWidth: 0 } }));
  };
}
