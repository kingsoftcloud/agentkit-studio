export function createAgentPages({
  ui: { React: { createElement: h, useState, useEffect, useRef, Fragment }, BRAND, inputStyle, buttonStyle, pagerButtonStyle, StudioSubnav, RuntimeCatalogPage, EmptyState, Pill, RUNTIME_LABELS, DEPLOYMENT_LABELS, AgentCreatePage, AgentEditPage },
  window = globalThis.window, hostRemote, actions
}) {
  function AgentWorkspace({ onNavigate }) {
    const [view, setView] = useState('list');
    const [tab, setTab] = useState('local');
    const [created, setCreated] = useState(null);
    const [editingAgent, setEditingAgent] = useState(null);
    if (view === 'create') {
      return h(AgentCreatePage, {
        onBack: () => setView('list'),
        onCreated: agent => { setCreated(agent); setTab('local'); setView('list'); },
      });
    }
    if (view === 'edit') return h(AgentEditPage, {
      agentId: editingAgent,
      onBack: () => setView('list'),
      onSaved: agent => { setCreated({ ...agent, updated: true }); setView('list'); },
    });
    return h(AgentsPage, {
      created,
      onDeleteLocal: async agentId => { try { await hostRemote.deleteLocalAgent(agentId); window.dispatchEvent(new CustomEvent('agentkit-studio:local-agent-changed', { detail: { agentId } })); } catch (reason) { window.dispatchEvent(new CustomEvent('agentkit-studio:local-agent-error', { detail: reason?.message })); } },
      onNavigate,
      tab,
      onTabChange: setTab,
      onEdit: agent => { setEditingAgent(agent?.metadata?.id || agent.id); setView('edit'); },
      onBindAgent: agent => actions.bindAgent(agent?.metadata?.id || agent?.id),
      onCreate: mode => { setCreated(null); if (mode === 'conversation') window.dispatchEvent(new CustomEvent('agentkit-studio:open-authoring')); else setView('create'); },
    });
  }

  function AgentsPage({ onCreate, created, onNavigate, onBindAgent, onEdit, tab, onTabChange, onDeleteLocal }) {
    const directServerMode = Boolean(window.__AGENTKIT_STUDIO__?.controlPlane === 'agentengine-server');
    const [agents, setAgents] = useState([]);
    const [status, setStatus] = useState('loading');
    const [error, setError] = useState('');
    const [catalogWarnings, setCatalogWarnings] = useState([]);
    const [query, setQuery] = useState('');
    const [statusFilter, setStatusFilter] = useState('all');
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(20);
    const [total, setTotal] = useState(0);
    const [bindingAgent, setBindingAgent] = useState('');
    const requestVersion = useRef(0);
    const bindAgent = async agent => {
      if (bindingAgent) return;
      setBindingAgent(agent?.metadata?.id || agent?.id || 'pending');
      try { await onBindAgent?.(agent); } finally { setBindingAgent(''); }
    };
    const successfulBuilds = agent => (agent?.builds || []).filter(item => String(item?.status || '').toUpperCase() === 'SUCCEEDED');
    const hasCurrentBuild = agent => successfulBuilds(agent).some(item => Number(item.revision || 1) === Number(agent?.metadata?.revision || 1));

    const load = async () => {
      const version = ++requestVersion.current;
      setStatus('loading');
      setError('');
      try {
        // Agent cards are rendered from the catalog's Revision metadata.
        // Runtime capability discovery belongs to the separate Runtime tab;
        // the list path must never fan out into one detail/capability call
        // per card. Detail is loaded only when the user opens edit/inspect.
        const agentResult = await hostRemote.agents({ page, pageSize, query, source: tab === 'cloud' ? 'cloud' : 'local' });
        if (version !== requestVersion.current) return;
        setCatalogWarnings(agentResult?.warnings || []);
        const listedAgents = Array.isArray(agentResult?.items) ? agentResult.items : [];
        setAgents(listedAgents);
        setTotal(Number.isFinite(Number(agentResult?.total)) ? Number(agentResult.total) : listedAgents.length);
        setStatus('ready');
      } catch (reason) {
        if (version !== requestVersion.current) return;
        setStatus('error');
        setError(reason?.message || 'Host 尚未连接');
      }
    };
    useEffect(() => { if (tab !== 'runtime') void load(); return () => { requestVersion.current += 1; }; }, [page, pageSize, query, tab]);
    useEffect(() => {
      const changed = () => { if (tab !== 'runtime') void load(); };
      window.addEventListener('agentkit-studio:local-agent-changed', changed);
      return () => window.removeEventListener('agentkit-studio:local-agent-changed', changed);
    }, [page, pageSize, query, tab]);
    useEffect(() => { setPage(1); }, [query, pageSize]);

    const filteredAgents = agents.filter(agent => {
      const metadata = agent?.metadata || agent || {};
      const id = metadata.id || agent?.id || '';
      const name = metadata.name || agent?.name || id;
      const q = query.trim().toLowerCase();
      const built = hasCurrentBuild(agent);
      return (!q || String(name).toLowerCase().includes(q) || String(id).toLowerCase().includes(q))
        && (tab === 'cloud' || statusFilter === 'all' || (statusFilter === 'built' ? built : !built));
    });
    const filteredPageAgents = filteredAgents;
    const pageCount = Math.max(1, Math.ceil((total || filteredPageAgents.length) / pageSize));
    const agentTable = agents.length || query.trim() ? h('section', { style: { border: '1px solid ' + BRAND.border, borderRadius: '14px', background: BRAND.surface, overflow: 'hidden' } },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', padding: '14px 16px', borderBottom: '1px solid ' + BRAND.border, flexWrap: 'wrap' } },
        h('strong', { style: { color: BRAND.ink, fontSize: '13px' } }, `${total} 个${tab === 'cloud' ? '云端' : '本地'} Agent · 最新创建优先`),
        h('div', { style: { display: 'flex', gap: '8px', minWidth: 'min(100%, 430px)' } },
          h('input', { type: 'search', value: query, onChange: event => setQuery(event.target.value), placeholder: '搜索 Agent 名称或 ID', 'aria-label': '搜索 Agent', style: { ...inputStyle(), marginTop: 0, flex: 1, minWidth: '180px' } }),
          h('select', { hidden: tab === 'cloud', value: statusFilter, onChange: event => setStatusFilter(event.target.value), 'aria-label': '筛选 Agent 状态', style: { ...inputStyle(), display: tab === 'cloud' ? 'none' : undefined, marginTop: 0, width: '112px' } }, h('option', { value: 'all' }, '全部状态'), h('option', { value: 'built' }, '已构建'), h('option', { value: 'draft' }, '草稿')))),
      h('div', { style: { overflow: 'auto', maxHeight: 'min(64vh, 680px)' } }, h('table', { style: { width: '100%', borderCollapse: 'collapse', minWidth: '860px', fontSize: '12px' } },
        h('thead', null, h('tr', { style: { color: BRAND.inkMuted, textAlign: 'left', background: BRAND.canvas, position: 'sticky', top: 0, zIndex: 1 } }, ['Agent', '运行时', '能力', '版本', '创建时间', tab === 'cloud' ? '部署状态' : '构建', '操作'].map(label => h('th', { key: label, style: { padding: '11px 14px', borderBottom: '1px solid ' + BRAND.border, fontWeight: 750, whiteSpace: 'nowrap' } }, label)))),
        h('tbody', null, filteredPageAgents.map(agent => {
          const metadata = agent?.metadata || agent || {};
          const spec = agent?.spec || {};
          const id = metadata.id || agent?.id || '—';
          const runtime = spec.runtime?.type || agent?.runtime?.type || 'harness';
          const createdTime = new Date(String(metadata.createdAt || agent.createdAt || '').replace(/([+-]\d{2}:\d{2})Z$/, '$1'));
          const bindings = spec.bindings || {};
          const plugins = Array.isArray(bindings.plugins) ? bindings.plugins : [];
          const platformCount = kind => plugins.filter(item => String(item?.config?.binding?.resource?.kind || '') === kind).length;
          const counts = [
            ['模型', bindings.modelProfileIds?.length || (bindings.modelProfileId ? 1 : 0)],
            ['MCP', bindings.mcpServers?.length || 0],
            ['Skill', bindings.skills?.length || 0],
            ['Tool', bindings.tools?.length || 0],
            ['知识库', platformCount('knowledge-base')],
            ['记忆库', platformCount('memory-instance') || (spec.memory?.enabled ? 1 : 0)],
            ['Skill Center', platformCount('skill-space')],
          ].filter(([, count]) => count);
          const built = hasCurrentBuild(agent);
          return h('tr', { key: id, style: { borderBottom: '1px solid ' + BRAND.border } },
            h('td', { style: { padding: '13px 14px' } }, h('div', { style: { color: BRAND.ink, fontWeight: 800 } }, metadata.name || id), agent.assistant?.configuration ? h('div', { style: { color: BRAND.inkMuted, fontSize: '11px', marginTop: '4px' } }, '个人助理配置 · 云端运行') : null, h('div', { style: { color: BRAND.inkMuted, fontSize: '10px', marginTop: '3px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } }, id)),
            h('td', { style: { padding: '13px 14px', color: BRAND.inkMuted, whiteSpace: 'nowrap' } }, RUNTIME_LABELS[runtime] || runtime),
            h('td', { style: { padding: '13px 14px', color: BRAND.inkMuted, whiteSpace: 'nowrap' } }, counts.length ? counts.map(([label, count]) => `${count} ${label}`).join(' · ') : '—'),
            h('td', { style: { padding: '13px 14px', color: BRAND.inkMuted, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } }, `r${metadata.revision || 1}`),
            h('td', { style: { padding: '13px 14px', color: BRAND.inkMuted, whiteSpace: 'nowrap' } }, Number.isFinite(createdTime.getTime()) ? createdTime.toLocaleString('zh-CN', { hour12: false }) : '—'),
            h('td', { style: { padding: '13px 14px' } }, h(Pill, { tone: built ? 'accent' : 'signal' }, agent.deployment ? (DEPLOYMENT_LABELS[agent.deployment.state] || agent.deployment.state) : built ? '已构建' : successfulBuilds(agent).length ? '有历史构建' : agent.source === 'local-studio' ? '本地配置' : '草稿')),
            h('td', { style: { padding: '13px 14px', whiteSpace: 'nowrap' } }, h('div', { style: { display: 'flex', gap: '6px' } }, h('button', { type: 'button', disabled: Boolean(bindingAgent) || agent.deployment?.available === false, onClick: () => { void bindAgent(agent); }, style: { ...buttonStyle(), padding: '6px 9px', fontSize: '11px', color: BRAND.primaryText, background: BRAND.primaryFill, borderColor: 'transparent' } }, bindingAgent === (agent?.metadata?.id || agent?.id) ? '正在绑定…' : agent.assistant?.configuration ? '绑定云端助理' : '绑定到新会话'), h('button', { type: 'button', onClick: () => agent.deployment ? onNavigate('studio-operations') : onEdit(agent), style: { ...buttonStyle(), padding: '6px 9px', fontSize: '11px' } }, agent.deployment ? '管理部署' : '编辑 Agent'), agent?.metadata?.local ? h('button', { type: 'button', onClick: async () => { if (!await actions.confirm({ title: '删除本地 Agent', detail: `确定删除本地 Agent「${agent?.metadata?.name || agent?.metadata?.id}」吗？此操作不可撤销。`, confirmLabel: '删除', danger: true })) return; void onDeleteLocal?.(agent?.metadata?.id); }, style: { ...buttonStyle(), padding: '6px 9px', fontSize: '11px', color: BRAND.danger } }, '删除') : null)));
        })))),
      h('div', { 'data-studio-pager': 'true', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap', padding: '10px 14px', borderTop: '1px solid ' + BRAND.border, color: BRAND.inkMuted, fontSize: '11px' } },
        h('span', null, `${total || filteredPageAgents.length} 个 Agent · 第 ${Math.min(page, pageCount)}/${pageCount} 页`),
        h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
          h('select', { value: String(pageSize), onChange: event => { setPageSize(Number(event.target.value)); setPage(1); }, 'aria-label': '每页显示数量', style: { ...inputStyle(), width: '112px', marginTop: 0, padding: '0 7px' } }, h('option', { value: '10' }, '每页 10 条'), h('option', { value: '20' }, '每页 20 条'), h('option', { value: '50' }, '每页 50 条')),
          h('button', { type: 'button', 'aria-label': 'Agent 上一页', disabled: page <= 1 || status === 'loading', onClick: () => setPage(current => Math.max(1, current - 1)), style: pagerButtonStyle(page <= 1 || status === 'loading') }, '上一页'),
          h('button', { type: 'button', 'aria-label': 'Agent 下一页', disabled: page >= pageCount || status === 'loading', onClick: () => setPage(current => Math.min(pageCount, current + 1)), style: pagerButtonStyle(page >= pageCount || status === 'loading') }, '下一页')))
    ) : null;
    return h('div', null,
      h(StudioSubnav, { value: tab, onChange: value => { if (value === tab) return; setPage(1); setQuery(''); setStatusFilter('all'); setAgents([]); setTotal(0); setStatus('loading'); onTabChange(value); }, items: [{ id: 'local', label: '本地 Agent' }, { id: 'cloud', label: '云端 Agent' }, { id: 'runtime', label: '运行目标' }] }),
      tab === 'runtime' ? h(RuntimeCatalogPage, { onNavigate }) : null,
      tab === 'runtime' ? null : h(Fragment, null,
      h('section', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px', flexWrap: 'wrap', border: '1px solid ' + BRAND.border, borderRadius: '16px', padding: '18px', background: BRAND.surface, marginBottom: '18px' } },
        h('div', null,
          h('div', { style: { color: BRAND.ink, fontSize: '15px', fontWeight: 800 } }, '描述需求，创建 Agent'),
          h('div', { style: { color: BRAND.inkMuted, fontSize: '12px', lineHeight: 1.55, marginTop: '5px' } }, '通过多轮对话完善提示词和资源绑定，确认草稿后创建；也可以直接手动配置。')),
        h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
          h('button', { type: 'button', onClick: () => onNavigate('experts'), style: { ...buttonStyle(), height: '38px', padding: '0 14px' } }, '从专家模板创建'),
          h('button', { type: 'button', onClick: () => onCreate('conversation'), disabled: status !== 'ready', style: { ...buttonStyle(), height: '38px', padding: '0 14px', color: BRAND.primaryText, background: status !== 'ready' ? 'var(--dsw-alias-label-tertiary, #aab7c4)' : BRAND.primaryFill, borderColor: 'transparent' } }, '对话创建'),
          h('button', { type: 'button', onClick: () => onCreate('manual'), disabled: status !== 'ready', style: { ...buttonStyle(), height: '38px', padding: '0 14px' } }, '手动配置'))),
      created ? h('div', { role: 'status', style: { marginBottom: '14px', padding: '11px 13px', borderRadius: '10px', color: BRAND.accentStrong, background: BRAND.accentSoft, fontSize: '12px' } }, `${created.updated ? '已保存' : '已创建'} ${created.name || created.id}，Revision ${created.revision || 1}。可在编辑页调整绑定，在运行中心构建。`) : null,
      status === 'loading' ? h(EmptyState, { icon: '·', title: directServerMode ? '正在读取 AgentEngine Server' : '正在读取 Host', detail: directServerMode ? '从 AgentEngine Server 读取 Agent Catalog 和运行时能力。' : '从 DSH Host 读取 Agent Catalog 和运行时能力。' }) : null,
      status === 'error' ? h(EmptyState, { icon: '!', title: directServerMode ? 'AgentEngine Server 不可达' : 'Host 尚未连接', detail: error || (directServerMode ? '请检查全局 ~/.agentkit 配置、云端凭证和网络；当前不会回退到本地 DSH Host。' : '启动本地 DSH Host 后点击刷新。'), action: h('button', { type: 'button', onClick: load, style: buttonStyle() }, '重新连接') }) : null,
      catalogWarnings.length ? h('p', { role: 'status', style: { color: BRAND.inkMuted, fontSize: '12px' } }, catalogWarnings.map(item => item.message || item).join(' ')) : null,
      status === 'ready' && agents.length === 0 && !query.trim() ? h(EmptyState, { icon: '✦', title: tab === 'cloud' ? '暂无 Studio 云端部署' : '还没有 Agent', detail: tab === 'cloud' ? '在运行中心将本地构建部署到云端；这里只展示当前账号下的 Studio 部署。' : '描述你希望 Agent 完成的任务，或手动填写配置。' }) : null,
      status === 'ready' && (agents.length > 0 || query.trim()) && filteredAgents.length === 0 ? h(EmptyState, { icon: '⌕', title: '没有匹配的 Agent', detail: '调整搜索词或状态筛选。' }) : null,
      agentTable));
  }
  return { AgentWorkspace, AgentsPage };
}
