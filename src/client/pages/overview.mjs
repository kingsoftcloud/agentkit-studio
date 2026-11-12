import { ALLOWED_RUNTIME_TYPES as DEFAULT_ALLOWED_RUNTIME_TYPES, BRAND as DEFAULT_BRAND, RUNTIME_LABELS as DEFAULT_RUNTIME_LABELS } from '../theme.mjs';

export function createOverviewPage({
  ui: { React: { createElement: h, useEffect, useState }, EmptyState, Metric, Pill, SectionHeading, StartChecks, buttonStyle, ALLOWED_RUNTIME_TYPES = DEFAULT_ALLOWED_RUNTIME_TYPES, BRAND = DEFAULT_BRAND, RUNTIME_LABELS = DEFAULT_RUNTIME_LABELS },
  hostRemote, window = globalThis.window, CustomEvent = globalThis.CustomEvent
}) {
  function OverviewPage({ onNavigate }) {
    const directServerMode = Boolean(window.__AGENTKIT_STUDIO__?.controlPlane === 'agentengine-server');
    const [connection, setConnection] = useState({ status: 'loading', agents: 0, runtimes: 0, error: '' });
    const [credential, setCredential] = useState({ status: 'loading', configured: true });
    const load = async () => {
      setConnection(current => ({ ...current, status: 'loading', error: '' }));
      try {
        const [health, bootstrap, agentResult, runtimeResult] = await Promise.all([
          hostRemote.health(), hostRemote.bootstrap(), hostRemote.agents(), hostRemote.runtimes(),
        ]);
        const runtimeItems = Array.isArray(runtimeResult?.items)
          ? runtimeResult.items.filter(item => ALLOWED_RUNTIME_TYPES.includes(item.runtimeType)) : [];
        setConnection({
          status: health?.status === 'ok' && bootstrap?.workspaceReady !== false ? 'ready' : 'error',
          agents: Number(agentResult?.total) || (Array.isArray(agentResult?.items) ? agentResult.items.length : 0),
          cloudConnected: agentResult?.cloudConnected !== false,
          warning: (agentResult?.warnings || []).map(item => item.message).join(' '),
          runtimes: runtimeResult?.source === 'dsh' ? null : runtimeItems.length,
          error: health?.status === 'ok' ? '' : 'Host health 未通过',
        });
      } catch (reason) {
        setConnection({ status: 'error', agents: 0, runtimes: 0, error: reason?.message || (directServerMode ? 'AgentEngine Server 不可达' : 'DSH Host 不可达') });
      }
    };
    useEffect(() => { load(); }, []);
    useEffect(() => {
      let active = true;
      hostRemote.modelCredentialStatus().then(result => {
        if (active) setCredential({ status: 'ready', configured: result?.configured === true, source: result?.source || 'unknown' });
      }).catch(error => {
        if (active) setCredential({ status: 'error', configured: true, error: error?.message || '凭证状态暂不可用' });
      });
      return () => { active = false; };
    }, []);
    const hostReady = connection.status === 'ready';
    return h('div', { className: 'studio-overview studio-page' },
      credential.status === 'ready' && !credential.configured ? h('section', { role: 'status', className: 'studio-credential-note' }, h('span', null, '先配置一个模型凭证，即可开始对话。'), h('button', { type: 'button', onClick: () => window.dispatchEvent(new CustomEvent('agentkit-studio:open-settings')), style: buttonStyle('ghost') }, '去配置')) : null,
      h('h3', { className: 'studio-group-title' }, '创建 Agent'),
      h('div', { className: 'studio-start-cards' },
        h('button', { type: 'button', className: 'studio-start-card', 'data-primary': true, onClick: () => window.dispatchEvent(new CustomEvent('agentkit-studio:open-authoring')) }, h('span', { className: 'studio-tile', 'aria-hidden': 'true' }, '✦'), h('strong', null, '对话创建'), h('small', null, '和 AI 一起完善配置')),
        h('button', { type: 'button', className: 'studio-start-card', onClick: () => onNavigate?.('agents') }, h('span', { className: 'studio-tile', 'aria-hidden': 'true' }, '+'), h('strong', null, '手动配置'), h('small', null, '选择运行时与能力')),
        h('button', { type: 'button', className: 'studio-start-card', onClick: () => onNavigate?.('experts') }, h('span', { className: 'studio-tile', 'aria-hidden': 'true' }, '◈'), h('strong', null, '从模板开始'), h('small', null, '复用专家模板'))),
      h('h3', { className: 'studio-group-title', title: '在同一个工作区管理 Agent、运行时、资源和交付版本。对话与工作台会话由底层运行时统一承载。' }, '工作区'),
      h('div', { className: 'studio-stats studio-panel' }, [
        ['Agent', hostReady ? String(connection.agents) : '—', 'agents'], ['运行时', !hostReady || connection.runtimes === null ? '—' : String(connection.runtimes), null], ['资源', '—', 'studio-resources'], ['交付', '—', 'studio-operations'],
      ].map(([label, value, target]) => h(target ? 'button' : 'div', { key: label, type: target ? 'button' : undefined, onClick: target ? () => onNavigate?.(target) : undefined }, h('strong', null, value), h('small', null, label)))),
      h('details', { className: 'studio-start-checks' }, h('summary', null, '启动检查'), h(StartChecks)),
      connection.warning ? h('p', { role: 'status', className: 'studio-inline-note', title: connection.warning }, connection.warning) : null,
      connection.status === 'loading' ? h(EmptyState, { icon: '·', title: directServerMode ? '正在读取 AgentEngine Server' : '正在读取 DSH Host' }) : connection.status === 'error' ? h(EmptyState, { icon: '!', title: directServerMode ? 'AgentEngine Server 不可达' : 'DSH Host 尚未连接', detail: connection.error, action: h('button', { type: 'button', onClick: load, style: buttonStyle() }, '重新连接') }) : null);
  }

  function AgentCard({ agent, onResources }) {
    const metadata = agent?.metadata || agent || {};
    const spec = agent?.spec || {};
    const runtime = spec.runtime?.type || agent?.runtime?.type || 'harness';
    const bindings = spec.bindings || {};
    const modelCount = Array.isArray(bindings.modelProfileIds) && bindings.modelProfileIds.length
      ? bindings.modelProfileIds.length : bindings.modelProfileId ? 1 : 0;
    const mcpCount = Array.isArray(bindings.mcpServers) ? bindings.mcpServers.length : 0;
    const skillCount = Array.isArray(bindings.skills) ? bindings.skills.length : 0;
    const toolCount = Array.isArray(bindings.tools) ? bindings.tools.length : 0;
    const plugins = Array.isArray(bindings.plugins) ? bindings.plugins : [];
    const platformCount = kind => plugins.filter(item => String(item?.config?.binding?.resource?.kind || '') === kind).length;
    const knowledgeBaseCount = platformCount('knowledge-base');
    const memoryCount = platformCount('memory-instance') || (spec.memory?.enabled ? 1 : 0);
    const skillSpaceCount = platformCount('skill-space');
    return h('article', {
      style: { border: '.5px solid ' + BRAND.border, borderRadius: '14px', padding: '16px', background: BRAND.surface, },
    },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '14px', alignItems: 'flex-start' } },
      h('div', null,
        h('div', { style: { color: BRAND.ink, fontWeight: 750, fontSize: '15px' } }, metadata.name || metadata.id || '未命名 Agent'),
        h('div', { style: { color: BRAND.inkMuted, fontSize: '11px', marginTop: '5px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } }, metadata.id || '—')),
      h(Pill, { tone: runtime === 'dsh-native' || runtime === 'harness' ? 'accent' : 'neutral' }, RUNTIME_LABELS[runtime] || runtime)),
    h('p', { style: { color: BRAND.inkMuted, lineHeight: 1.55, margin: '14px 0 0', fontSize: '12px' } }, spec.description || '本地工作区 Agent，等待绑定模型与首次运行。'),
    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '14px' } },
      h(Pill, { tone: modelCount ? 'accent' : 'signal' }, `模型 ${modelCount}`),
      h(Pill, { tone: mcpCount ? 'accent' : 'neutral' }, `MCP ${mcpCount}`),
      h(Pill, { tone: skillCount ? 'accent' : 'neutral' }, `Skill ${skillCount}`),
      h(Pill, { tone: toolCount ? 'accent' : 'neutral' }, `Tool ${toolCount}`),
      h(Pill, { tone: knowledgeBaseCount ? 'accent' : 'neutral' }, `知识库 ${knowledgeBaseCount}`),
      h(Pill, { tone: memoryCount ? 'accent' : 'neutral' }, `记忆库 ${memoryCount}`),
      h(Pill, { tone: skillSpaceCount ? 'accent' : 'neutral' }, `Skill Center ${skillSpaceCount}`)),
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', marginTop: '12px' } },
      h('div', { style: { color: 'var(--dsw-alias-label-tertiary, #8a97a8)', fontSize: '11px' } }, 'Revision ' + String(metadata.revision || 1)),
      onResources ? h('button', { type: 'button', onClick: () => onResources(metadata.id || agent?.id), style: { border: '.5px solid ' + BRAND.border, borderRadius: '7px', padding: '5px 8px', color: BRAND.accentStrong, background: BRAND.surface, fontSize: '10px', fontWeight: 750 } }, '配置资源') : null));
  }
  return OverviewPage;
}
