export function createAgentEdit({ ui, hostRemote }) {
  const { React, AgentCreatePage, EmptyState, buttonStyle } = ui;
  const { createElement: h, useState, useEffect } = React;
  function AgentEditPage({ agentId, onBack, onSaved }) {
    const [agent, setAgent] = useState(null);
    const [error, setError] = useState('');
    useEffect(() => {
      let alive = true;
      hostRemote.agent(agentId).then(value => { if (alive) setAgent(value?.draft || value); })
        .catch(reason => { if (alive) setError(reason?.message || '读取 Agent 失败'); });
      return () => { alive = false; };
    }, [agentId]);
    if (!agent) return h(EmptyState, { title: error || '正在读取 Agent', detail: '读取当前版本和已有绑定。', action: h('button', { onClick: onBack, style: buttonStyle() }, '返回 Agents') });
    return h(AgentCreatePage, { initialAgent: agent, onBack, onCreated: onSaved });
  }
  return AgentEditPage;
}
