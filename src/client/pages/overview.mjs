import { ALLOWED_RUNTIME_TYPES as DEFAULT_ALLOWED_RUNTIME_TYPES, BRAND as DEFAULT_BRAND, RUNTIME_LABELS as DEFAULT_RUNTIME_LABELS } from '../theme.mjs';

export function createOverviewPage({ ui, hostRemote, window = globalThis.window, CustomEvent = globalThis.CustomEvent }) {
  const { React, EmptyState, Metric, Pill, SectionHeading, StartChecks, buttonStyle, ALLOWED_RUNTIME_TYPES = DEFAULT_ALLOWED_RUNTIME_TYPES, BRAND = DEFAULT_BRAND, RUNTIME_LABELS = DEFAULT_RUNTIME_LABELS } = ui;
  const { createElement: h, useEffect, useState } = React;
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
    const hero = h('section', {
      style: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr)', gap: '20px', padding: '24px', borderRadius: '16px', color: BRAND.ink, overflow: 'hidden', background: BRAND.surface, border: '1px solid ' + BRAND.border, boxShadow: '0 8px 24px rgba(0,0,0,0.04)' },
    },
    h('div', null,
      h(Pill, { tone: 'accent' }, '本地工作区'),
      h('h2', { style: { margin: '18px 0 10px', fontSize: '29px', lineHeight: 1.15, letterSpacing: '-0.04em' } }, '把 Agent 从想法交付到运行'),
      h('p', { style: { maxWidth: '560px', color: BRAND.inkMuted, lineHeight: 1.65, margin: 0, fontSize: '14px' } }, '在同一个工作区管理 Agent、运行时、资源和交付版本。对话与工作台会话由底层运行时统一承载。'),
      h('div', { style: { display: 'flex', gap: '10px', marginTop: '22px', flexWrap: 'wrap' } },
        h('button', { type: 'button', onClick: () => onNavigate && onNavigate('studio-agents'), style: buttonStyle() }, '创建第一个 Agent'),
        h('button', { type: 'button', onClick: () => onNavigate && onNavigate('studio-agents'), style: { border: '1px solid ' + BRAND.border, borderRadius: '9px', padding: '8px 12px', color: BRAND.ink, background: BRAND.surface, fontSize: '12px', fontWeight: 700 } }, '查看 Agents'))),
    );
    const metrics = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: '12px', marginTop: '18px' } },
      h(Metric, { label: 'Agent', value: String(connection.agents), detail: hostReady ? '当前目录总数' : '尚未读取' }), h(Metric, { label: '运行时', value: connection.runtimes === null ? '未提供' : String(connection.runtimes), detail: connection.runtimes === null ? '当前连接未提供目录' : hostReady ? '已发现的运行时类型' : '等待 DSH Host', tone: hostReady ? 'neutral' : 'signal' }),
      h(Metric, { label: '资源', value: '资源库', detail: '查看与绑定资源' }), h(Metric, { label: '交付', value: '构建与部署', detail: '在 Agent 中管理版本' }));
    const cards = h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr)', gap: '18px', marginTop: '18px' } },
      h('section', { style: { border: '1px solid ' + BRAND.border, borderRadius: '16px', padding: '20px', background: BRAND.surface } },
        h(SectionHeading, { eyebrow: 'Start here', title: '从一个 Agent 开始', detail: directServerMode ? 'Agent、运行时和资源由 AgentEngine Server 控制面提供；本地运行时承载会话与工具执行。' : 'Agent、运行时和资源会在接入 DSH Host 后成为可操作的产品对象。' }),
        connection.status === 'loading' ? h(EmptyState, { icon: '·', title: directServerMode ? '正在读取 AgentEngine Server' : '正在读取 DSH Host', detail: directServerMode ? '读取 Server catalog、详情和运行时能力。' : '读取 health、workspace 和 runtime capability。' }) : connection.status === 'error' ? h(EmptyState, { icon: '!', title: directServerMode ? 'AgentEngine Server 不可达' : 'DSH Host 尚未连接', detail: connection.error || (directServerMode ? '检查 ~/.agentkit 配置、云端凭证和网络。' : '启动本地 DSH Host 后点击重试。'), action: h('button', { type: 'button', onClick: load, style: buttonStyle() }, '重新连接') }) : h(EmptyState, { icon: '✦', title: connection.agents ? '继续配置 Agent' : '创建第一个 Agent', detail: directServerMode ? (connection.warning || '已读取 Agent 目录，可以进入 Agents 页面继续配置。') : '已连接 Host，可以进入 Agents 页面配置本地 Agent。', action: h('button', { type: 'button', onClick: () => onNavigate && onNavigate('studio-agents'), style: buttonStyle() }, '查看 Agents') })),
    );
    const credentialGuide = credential.status === 'ready' && !credential.configured ? h('section', {
      role: 'status', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', marginBottom: '18px', padding: '15px 18px', border: '1px solid ' + BRAND.border, borderRadius: '14px', background: BRAND.surface },
    }, h('div', null, h('strong', { style: { display: 'block', color: BRAND.ink, fontSize: '14px' } }, '先配置一个模型凭证'), h('span', { style: { display: 'block', marginTop: '5px', color: BRAND.inkMuted, fontSize: '12px' } }, '首次使用前完成 API Key 配置，Agent 对话和 DSH Native 模型目录才能正常工作。')), h('button', { type: 'button', onClick: () => window.dispatchEvent(new CustomEvent('agentkit-studio:open-settings')), style: buttonStyle() }, '去配置模型凭证')) : null;
    return h('div', null, credentialGuide, hero, h(StartChecks), metrics, cards);
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
      style: { border: '1px solid ' + BRAND.border, borderRadius: '14px', padding: '16px', background: BRAND.surface, boxShadow: '0 8px 24px rgba(11,18,32,0.04)' },
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
      onResources ? h('button', { type: 'button', onClick: () => onResources(metadata.id || agent?.id), style: { border: '1px solid ' + BRAND.border, borderRadius: '7px', padding: '5px 8px', color: BRAND.accentStrong, background: BRAND.surface, fontSize: '10px', fontWeight: 750 } }, '配置资源') : null));
  }
  return { OverviewPage };
}
