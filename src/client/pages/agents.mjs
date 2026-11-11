import { createFormKit } from '../components/form-kit.mjs';

export function createAgentPages({
  ui: { React: { createElement: h, useState, useEffect, useRef, Fragment }, Menu, MenuItemButton, BRAND, inputStyle, buttonStyle, pagerButtonStyle, StudioSubnav, RuntimeCatalogPage, EmptyState, Pill, RUNTIME_LABELS, DEPLOYMENT_LABELS, AgentCreatePage, AgentEditPage },
  window = globalThis.window, hostRemote, actions
}) {
  const { Button } = createFormKit({ React: { createElement: h } });
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
      onSaved: agent => { setCreated({ ...agent, updated: true }); setView('list'); window.dispatchEvent(new CustomEvent('agentkit-studio:cloud-agent-changed')); },
    });
    return h(AgentsPage, {
      created,
      onDeleteLocal: async agentId => { try { await hostRemote.deleteLocalAgent(agentId); window.dispatchEvent(new CustomEvent('agentkit-studio:local-agent-changed', { detail: { agentId } })); } catch (reason) { window.dispatchEvent(new CustomEvent('agentkit-studio:local-agent-error', { detail: reason?.message })); } },
      onDeleteManaged: async agentId => { try { await hostRemote.deleteManagedAgent(agentId); window.dispatchEvent(new CustomEvent('agentkit-studio:cloud-agent-changed', { detail: { agentId } })); } catch (reason) { await actions.confirm({ title: '删除托管 Runtime 失败', detail: reason?.message || '云端未确认删除，请刷新列表核对。', confirmLabel: '知道了' }); } },
      onNavigate,
      tab,
      onTabChange: setTab,
      onEdit: agent => { setEditingAgent(agent?.metadata?.id || agent.id); setView('edit'); },
      onBindAgent: agent => actions.bindAgent(agent?.metadata?.id || agent?.id),
      onCreate: mode => { setCreated(null); if (mode === 'conversation') window.dispatchEvent(new CustomEvent('agentkit-studio:open-authoring')); else setView('create'); },
    });
  }

  function AgentsPage({ onCreate, created, onNavigate, onBindAgent, onEdit, tab, onTabChange, onDeleteLocal, onDeleteManaged }) {
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
    const [createMenuOpen, setCreateMenuOpen] = useState(false);
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
      window.addEventListener('agentkit-studio:cloud-agent-changed', changed);
      return () => { window.removeEventListener('agentkit-studio:local-agent-changed', changed); window.removeEventListener('agentkit-studio:cloud-agent-changed', changed); };
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
    const agentTable = agents.length || query.trim() ? h('section', { 'data-studio-agent-list': 'true', className: 'ak-agents-list' },
      h('div', { className: 'ak-agents-list-head' },
        h('strong', null, `${total} 个${tab === 'cloud' ? '云端' : '本地'} Agent`),
        h('div', { style: { display: 'flex', gap: '8px', minWidth: 'min(100%, 430px)' } },
          h('input', { type: 'search', value: query, onChange: event => setQuery(event.target.value), placeholder: '搜索 Agent 名称或 ID', 'aria-label': '搜索 Agent', style: { ...inputStyle(), marginTop: 0, flex: 1, minWidth: '180px' } }),
          h('select', { hidden: tab === 'cloud', value: statusFilter, onChange: event => setStatusFilter(event.target.value), 'aria-label': '筛选 Agent 状态', style: { ...inputStyle(), display: tab === 'cloud' ? 'none' : undefined, marginTop: 0, width: '112px' } }, h('option', { value: 'all' }, '全部状态'), h('option', { value: 'built' }, '已构建'), h('option', { value: 'draft' }, '草稿')))),
      h('div', { 'data-studio-agent-grid': 'true', style: { overflow: 'auto', maxHeight: 'min(64vh, 680px)', padding: '0 8px', display: 'flex', flexDirection: 'column', gap: '2px' } }, filteredPageAgents.map(agent => {
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
        const studioDeployment = agent.source === 'studio-deployment';
        const statusLabel = studioDeployment ? (DEPLOYMENT_LABELS[agent.deployment?.state] || agent.deployment?.state) : agent.managedRuntime ? (agent.deployment?.available ? '托管可用' : (agent.metadata?.status || '托管不可用')) : built ? '已构建' : successfulBuilds(agent).length ? '有历史构建' : agent.source === 'local-studio' ? '本地配置' : '草稿';
        const openCard = () => { if (studioDeployment) onNavigate?.('studio-operations'); else onEdit?.(agent); };
        const stop = event => event?.stopPropagation?.();
        return h('article', { key: id, 'data-studio-agent-card': id, tabIndex: 0, role: 'article', onClick: openCard, onKeyDown: event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); openCard(); } }, className: 'ak-agent-card' },
          h('div', { className: 'ak-agent-icon', 'aria-hidden': 'true' }, '✦'),
          h('div', { className: 'ak-agent-main' },
            h('strong', { className: 'ak-agent-title' }, metadata.name || id),
            h('div', { className: 'ak-agent-meta', title: `${counts.length ? counts.map(([label, count]) => `${count} ${label}`).join(' · ') : '—'} · 创建时间：${Number.isFinite(createdTime.getTime()) ? createdTime.toLocaleString('zh-CN', { hour12: false }) : '—'}` }, [agent.assistant?.configuration ? '个人助理配置 · 云端运行' : RUNTIME_LABELS[runtime] || runtime, `r${metadata.revision || 1}`, id].join(' · '))),
          h('span', { className: 'ak-agent-status' }, h('span', { className: 'studio-status-dot', 'aria-hidden': 'true', style: { background: built ? 'var(--dsw-alias-state-success-primary, #36865a)' : 'var(--dsw-alias-label-tertiary, #999)' } }), h(Pill, { tone: built ? 'accent' : 'signal' }, statusLabel)),
          h('div', { className: 'ak-agent-actions', style: { display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' } },
              h('button', { type: 'button', disabled: Boolean(bindingAgent) || agent.deployment?.available === false, onClick: event => { stop(event); void bindAgent(agent); }, className: 'af-btn', 'data-size': 'sm', 'data-variant': 'primary' }, bindingAgent === (agent?.metadata?.id || agent?.id) ? '正在绑定…' : agent.assistant?.configuration ? '绑定云端助理' : '绑定到新会话'),
              studioDeployment ? h('button', { type: 'button', onClick: event => { stop(event); openCard(); }, className: 'af-btn', 'data-size': 'sm' }, '管理部署') : agent.managedRuntime ? h(Fragment, null,
                h('button', { type: 'button', onClick: event => { stop(event); openCard(); }, className: 'af-btn', 'data-size': 'sm' }, '管理'),
                h('button', { type: 'button', onClick: async event => { stop(event); if (!await actions.confirm({ title: '删除托管 Runtime', detail: `确定删除云端托管 Runtime「${metadata.name || id}」吗？删除后云端实例和访问凭据都会失效。`, confirmLabel: '删除 Runtime', danger: true })) return; await onDeleteManaged?.(id); }, className: 'af-btn', 'data-size': 'sm', style: { color: BRAND.danger, borderColor: 'rgba(194, 64, 42, .35)' } }, '删除')) : h('button', { type: 'button', onClick: event => { stop(event); openCard(); }, className: 'af-btn', 'data-size': 'sm' }, '编辑 Agent'),
              agent?.metadata?.local ? h('button', { type: 'button', onClick: async event => { stop(event); if (!await actions.confirm({ title: '删除本地 Agent', detail: `确定删除本地 Agent「${agent?.metadata?.name || agent?.metadata?.id}」吗？此操作不可撤销。`, confirmLabel: '删除', danger: true })) return; void onDeleteLocal?.(agent?.metadata?.id); }, className: 'af-btn', 'data-size': 'sm', style: { color: BRAND.danger } }, '删除') : null));
      })),
      h('div', { 'data-studio-pager': 'true', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap', padding: '10px 14px', borderTop: '.5px solid var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px' } },
        h('span', null, `${total || filteredPageAgents.length} 个 Agent · 第 ${Math.min(page, pageCount)}/${pageCount} 页`),
        h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
          h('select', { value: String(pageSize), onChange: event => { setPageSize(Number(event.target.value)); setPage(1); }, 'aria-label': '每页显示数量', style: { ...inputStyle(), width: '112px', marginTop: 0, padding: '0 7px' } }, h('option', { value: '10' }, '每页 10 条'), h('option', { value: '20' }, '每页 20 条'), h('option', { value: '50' }, '每页 50 条')),
          h('button', { type: 'button', 'aria-label': 'Agent 上一页', disabled: page <= 1 || status === 'loading', onClick: () => setPage(current => Math.max(1, current - 1)), style: pagerButtonStyle(page <= 1 || status === 'loading') }, '上一页'),
          h('button', { type: 'button', 'aria-label': 'Agent 下一页', disabled: page >= pageCount || status === 'loading', onClick: () => setPage(current => Math.min(pageCount, current + 1)), style: pagerButtonStyle(page >= pageCount || status === 'loading') }, '下一页')))
    ) : null;
    return h('div', null,
      h('div', { className: 'ak-agents-toolbar' },
        h(StudioSubnav, { variant: 'segmented', ariaLabel: 'Agent 范围', value: tab, onChange: value => { if (value === tab) return; setPage(1); setQuery(''); setStatusFilter('all'); setAgents([]); setTotal(0); setStatus('loading'); onTabChange(value); }, items: [{ id: 'local', label: '本地' }, { id: 'cloud', label: '云端' }, { id: 'runtime', label: '运行目标' }] }),
        tab === 'runtime' ? null : h('div', { className: 'ak-agents-actions ak-create-group' },
          Button({ variant: 'primary', className: 'ak-create-primary', 'aria-label': '对话创建', onClick: () => onCreate('conversation'), disabled: status !== 'ready', title: '通过多轮对话完善提示词和资源绑定，确认草稿后创建' },
            h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': 'true' }, h('path', { d: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z' })), '对话创建'),
          h(Menu, { open: createMenuOpen, portal: true, compact: true, align: 'end', onClose: () => setCreateMenuOpen(false),
            anchor: Button({ variant: 'primary', className: 'ak-create-more', 'aria-label': '更多创建方式', 'aria-haspopup': 'menu', 'aria-expanded': createMenuOpen, onClick: () => setCreateMenuOpen(value => !value) },
              h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': 'true' }, h('path', { d: 'm6 9 6 6 6-6', strokeLinecap: 'round', strokeLinejoin: 'round' }))) },
            h(MenuItemButton, { disabled: status !== 'ready', onSelect: () => { setCreateMenuOpen(false); onCreate('manual'); } }, '手动配置'),
            h(MenuItemButton, { onSelect: () => { setCreateMenuOpen(false); onNavigate('experts'); } }, '从专家模板创建')))),
      tab === 'runtime' ? h(RuntimeCatalogPage, { onNavigate }) : null,
      tab === 'runtime' ? null : h(Fragment, null,
      created ? h('div', { role: 'status', className: 'ak-agents-notice' }, `${created.updated ? '已保存' : '已创建'} ${created.name || created.id}（r${created.revision || 1}），${created.source === 'agentengine-managed-runtime' ? '新会话将使用更新后的云端配置。' : '可在运行中心构建。'}`) : null,
      status === 'loading' ? h(EmptyState, { icon: '·', title: directServerMode ? '正在读取 AgentEngine Server' : '正在读取 Host', detail: directServerMode ? '从 AgentEngine Server 读取 Agent Catalog 和运行时能力。' : '从 DSH Host 读取 Agent Catalog 和运行时能力。' }) : null,
      status === 'error' ? h(EmptyState, { icon: '!', title: directServerMode ? 'AgentEngine Server 不可达' : 'Host 尚未连接', detail: error || (directServerMode ? '请检查全局 ~/.agentkit 配置、云端凭证和网络；当前不会回退到本地 DSH Host。' : '启动本地 DSH Host 后点击刷新。'), action: h('button', { type: 'button', onClick: load, style: buttonStyle() }, '重新连接') }) : null,
      catalogWarnings.length ? h('p', { role: 'status', style: { color: BRAND.inkMuted, fontSize: '12px' } }, catalogWarnings.map(item => item.message || item).join(' ')) : null,
      status === 'ready' && agents.length === 0 && !query.trim() ? h(EmptyState, { icon: '✦', title: tab === 'cloud' ? '暂无云端 Agent' : '还没有 Agent', detail: tab === 'cloud' ? '这里展示 Studio 部署和通过 AgentEngine API 创建的 Codex / DSH ManagedRuntime。' : '描述你希望 Agent 完成的任务，或手动填写配置。' }) : null,
      status === 'ready' && (agents.length > 0 || query.trim()) && filteredAgents.length === 0 ? h(EmptyState, { icon: '⌕', title: '没有匹配的 Agent', detail: '调整搜索词或状态筛选。' }) : null,
      agentTable));
  }
  return { AgentWorkspace, AgentsPage };
}
