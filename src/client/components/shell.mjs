import { BRAND as DEFAULT_BRAND, PANELS as DEFAULT_PANELS } from '../theme.mjs';

export function createStudioShell({
  ui: { React: { createElement: h, useEffect, useState }, Pill, AgentWorkspace, AssistantPage, DomainPage, OperationsWorkspace, OverviewPage, ResourceWorkspace, BRAND = DEFAULT_BRAND, PANELS = DEFAULT_PANELS },
  hostRemote
}) {
  function HostStatusPill() {
    const [status, setStatus] = useState('loading');
    useEffect(() => {
      let alive = true;
      const probe = async () => {
        try {
          const result = await hostRemote.health();
          if (alive && result?.status === 'ok') { setStatus('ready'); return; }
        } catch { /* The session exchange can race on the first panel mount. */ }
        try {
          const result = await hostRemote.bootstrap();
          if (alive) setStatus(result?.workspaceReady === false ? 'error' : 'ready');
        } catch {
          if (alive) setStatus('error');
        }
      };
      void probe();
      return () => { alive = false; };
    }, []);
    return h(Pill, { tone: status === 'ready' ? 'accent' : 'signal' }, status === 'ready' ? 'Host 已连接' : status === 'loading' ? '读取 Host' : 'Host 待接入');
  }

  function StudioShell({ scheduleRemote, page = 'overview', onNavigate }) {
    const activeNav = PANELS.find(item => item.page === page) || PANELS[0];
    return h('div', {
      'data-agentkit-studio': 'product-application',
      style: { height: '100%', minHeight: 0, minWidth: 0, overflow: 'auto', background: page === 'resource-hub' ? BRAND.surface : BRAND.canvas, color: BRAND.ink, fontFamily: 'inherit' },
    },
    h('main', { 'data-studio-shell-main': 'true', style: { minWidth: 0, minHeight: '100%', boxSizing: 'border-box', padding: '24px 28px 32px' } },
      h('header', { 'data-studio-header': 'true', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '20px', marginBottom: '24px' } },
        h('div', null,
          h('div', { style: { color: BRAND.accentStrong, fontSize: '11px', fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase' } }, 'AgentKit Studio'),
          h('h1', { style: { color: BRAND.ink, margin: '6px 0 5px', fontSize: '25px', letterSpacing: '-0.035em' } }, activeNav.label),
          h('p', { style: { color: BRAND.inkMuted, margin: 0, fontSize: '13px' } }, activeNav.note)),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '9px' } }, h(Pill, { tone: 'neutral' }, page === 'assistant' ? '云端' : 'Local'), h(HostStatusPill))),
      page === 'assistant' ? h(AssistantPage) : page === 'overview' ? h(OverviewPage, { onNavigate }) : page === 'agents' ? h(AgentWorkspace, { onNavigate }) : page === 'resource-hub' ? h(ResourceWorkspace) : page === 'operations' ? h(OperationsWorkspace, { scheduleRemote }) : h(DomainPage, { page })));
  }

  function StudioPanelIcon({ size, active, glyph, panelId }) {
    const paths = {
      'studio-assistant': h('path', { d: 'M12 3 15 9l6 3-6 3-3 6-3-6-6-3 6-3 3-6Z', fill: 'none', stroke: 'currentColor', strokeWidth: '1.6', strokeLinejoin: 'round' }),
      'studio-overview': h('path', { d: 'M5 11 12 5l7 6v7h-5v-5h-4v5H5v-7Z', fill: 'none', stroke: 'currentColor', strokeWidth: '1.7', strokeLinejoin: 'round' }),
      'studio-agents': h('path', { d: 'm12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Zm5.5 12.5.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z', fill: 'none', stroke: 'currentColor', strokeWidth: '1.5', strokeLinejoin: 'round' }),
      'studio-resources': h('path', { d: 'm12 3 8 8-8 8-8-8 8-8Zm0 5 3 3-3 3-3-3 3-3Z', fill: 'none', stroke: 'currentColor', strokeWidth: '1.6', strokeLinejoin: 'round' }),
      'studio-operations': h('path', { d: 'M5 19 19 5m0 0h-7m7 0v7', fill: 'none', stroke: 'currentColor', strokeWidth: '1.8', strokeLinecap: 'round', strokeLinejoin: 'round' }),
    };
    return h('span', {
      'aria-hidden': 'true',
      'data-studio-panel-id': panelId || undefined,
      style: { display: 'inline-grid', placeItems: 'center', width: String(size) + 'px', height: String(size) + 'px', borderRadius: '5px', color: active ? BRAND.accentStrong : 'currentColor', background: active ? BRAND.accentSoft : 'transparent', fontSize: size >= 18 ? '16px' : '14px', fontWeight: 700 },
    }, h('svg', { width: Math.max(14, Number(size || 18) - 1), height: Math.max(14, Number(size || 18) - 1), viewBox: '0 0 24 24', fill: 'none' }, paths[panelId] || h('path', { d: 'M5 12h14', stroke: 'currentColor', strokeWidth: '1.7', strokeLinecap: 'round' })));
  }

  function SettingsRow({ label, value, detail, tone = 'neutral' }) {
    return h('div', {
      'data-studio-settings-row': true,
    },
    h('div', null,
      h('div', { className: 'agentkit-check-label' }, label),
      h('div', { className: 'agentkit-form-note' }, detail)),
    h('span', { 'data-tone': tone }, value));
  }
  return { HostStatusPill, StudioShell, StudioPanelIcon, SettingsRow };
}
