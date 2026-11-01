export function createAgentEdit({
  ui: { React: { createElement: h, useState, useEffect }, AgentCreatePage, EmptyState, buttonStyle },
  hostRemote
}) {
  function AgentEditPage({ agentId, onBack, onSaved }) {
    const [agent, setAgent] = useState(null);
    const [error, setError] = useState('');
    const [generation, setGeneration] = useState(0);
    useEffect(() => {
      let alive = true;
      hostRemote.agent(agentId).then(value => { if (alive) setAgent(value?.draft || value); })
        .catch(reason => { if (alive) setError(reason?.message || '读取 Agent 失败'); });
      return () => { alive = false; };
    }, [agentId, generation]);
    if (!agent) return h(EmptyState, { title: error || '正在读取 Agent', detail: '读取当前版本和已有绑定。', action: h('button', { onClick: onBack, style: buttonStyle() }, '返回 Agents') });
    return h(AgentCreatePage, { key: `${agentId}:${agent.metadata?.revision}:${generation}`, initialAgent: agent, onBack, onCreated: onSaved,
      onReload: () => { setAgent(null); setError(''); setGeneration(value => value + 1); } });
  }
  return AgentEditPage;
}
