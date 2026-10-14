import { BRAND as DEFAULT_BRAND } from '../theme.mjs';

export function createCodexPluginPages({ ui, hostRemote }) {
  const { React, Pill, buttonStyle, EmptyState, ResourceDialog, inputStyle, BRAND = DEFAULT_BRAND } = ui;
  const { createElement: h, useEffect, useState } = React;
  function CodexPluginCapabilities({ pluginId }) {
    const [state, setState] = useState({ loading: true });
    const [revision, setRevision] = useState(0);
    useEffect(() => {
      let current = true;
      setState({ loading: true });
      Promise.resolve().then(() => hostRemote.inspectCodexPlugin(pluginId)).then(value => {
        if (current) setState({ value });
      }, error => { if (current) setState({ error: error?.message || '能力与连接状态读取失败' }); });
      return () => { current = false; };
    }, [pluginId, revision]);
    const labels = { callable: '可调用', disabled: '已禁用', 'not-callable': '尚不可调用', 'not-loaded': '未连接或未加载', unknown: '状态未确认' };
    return h('section', { style: { borderTop: '1px solid ' + BRAND.border, paddingTop: '16px', marginTop: '16px' } },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, h('h3', { style: { margin: 0, fontSize: '15px', color: BRAND.ink } }, '能力与连接状态'), h('button', { type: 'button', disabled: state.loading, onClick: () => setRevision(value => value + 1), style: buttonStyle() }, '刷新连接状态')),
      state.loading ? h('p', { role: 'status' }, '正在读取插件能力和连接状态…') : null,
      state.error ? h('p', { role: 'alert', style: { color: BRAND.danger } }, state.error) : null,
      state.value ? h('div', { style: { fontSize: '12px', lineHeight: 1.7, color: BRAND.inkMuted } },
        state.value.runtimeError ? h('p', { role: 'status' }, state.value.runtimeError) : null,
        state.value.apps.map(app => h('div', { key: app.id, style: { display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center', padding: '12px 0' } }, h('strong', { style: { color: BRAND.ink } }, app.name), h(Pill, { tone: app.state === 'callable' ? 'accent' : 'signal' }, labels[app.state] || labels.unknown), app.installUrl ? h('a', { href: app.installUrl, target: '_blank', rel: 'noopener noreferrer', style: { color: BRAND.accentStrong } }, '打开授权 / 管理连接') : null)),
        state.value.apps.length ? h('p', null, '授权完成后点击刷新连接状态。可调用表示 Codex 当前允许模型使用该连接器，实际效果仍以会话工具记录为准。') : null,
        state.value.skills.length ? h('p', null, 'Skill：', state.value.skills.map(item => item.name + (item.enabled ? '' : '（未启用）')).join('、')) : null,
        state.value.mcpServers.length ? h('p', null, '声明的 MCP：', state.value.mcpServers.join('、'), '。连接和工具执行结果请在 Codex Agent 会话中检查。') : null,
        !state.value.apps.length && !state.value.skills.length && !state.value.mcpServers.length ? h('p', null, '插件未声明连接器、Skill 或 MCP；其他能力由对应宿主加载。') : null,
      ) : null);
  }
  
  function CodexPluginMarketItem({ view } = {}) {
    const [status, setStatus] = useState('idle');
    const [items, setItems] = useState([]);
    const [query, setQuery] = useState('');
    const [selectedId, setSelectedId] = useState('');
    const [busyId, setBusyId] = useState('');
    const [message, setMessage] = useState('');
    const [error, setError] = useState('');
    const [authApps, setAuthApps] = useState([]);
    const [revision, setRevision] = useState(0);
    const [installOpen, setInstallOpen] = useState(false);
    const [installSource, setInstallSource] = useState('');
    const load = async () => {
      setStatus('loading'); setError('');
      try {
        const result = await hostRemote.codexPlugins();
        const next = Array.isArray(result?.items) ? result.items : [];
        setItems(next);
        setError(result?.error?.message || '');
        setStatus('ready');
        return next;
      } catch (reason) {
        setStatus('error'); setError(reason?.message || 'Codex 插件目录不可用');
        return null;
      }
    };
    useEffect(() => { if (view === 'page') void load(); }, [view]);
    if (view !== 'page') return h('p', { style: { margin: 0, color: BRAND.inkMuted, lineHeight: 1.55, fontSize: '12px' } }, '管理 Codex 官方插件、市场来源、连接器授权和会话加载状态。');
    const id = item => String(item?.pluginId || item?.id || '');
    const label = item => item?.displayName || item?.name || id(item) || '未命名插件';
    const installed = item => item?.installed === true;
    const lifecycleAvailable = item => item?.lifecycleAvailable !== false && !item?.readOnlyReason;
    const stateLabel = item => item?.readOnlyReason
      ? ({ 'codex-unavailable': '当前账户不可安装', 'codex-install-confirmation': '需在 Codex 中确认安装' })[item.readOnlyReason] || '状态未确认'
      : item?.status === 'cached' || item?.lifecycleAvailable === false ? '仅缓存，状态未确认'
      : installed(item) ? item.enabled === false ? '未启用' : '已安装' : '可安装';
    const selected = items.find(item => id(item) === selectedId) || null;
    const normalized = query.trim().toLowerCase();
    const visible = items.filter(item => !normalized || `${label(item)} ${id(item)} ${item.description || ''} ${item.marketplaceName || item.marketplace || ''}`.toLowerCase().includes(normalized));
    const mutate = async (item, operation) => {
      const pluginId = id(item).trim();
      if (!pluginId || busyId) return false;
      setBusyId(pluginId); setMessage(''); setError(''); setAuthApps([]);
      try {
        const result = operation === 'install'
          ? await hostRemote.installCodexPlugin(pluginId, item.marketplaceName || item.marketplace)
          : await hostRemote.uninstallCodexPlugin(pluginId);
        const refreshed = await load();
        if (operation === 'install' && refreshed?.some(row => id(row) === pluginId)) setSelectedId(pluginId);
        setMessage(`${label(item)}：${operation === 'install' ? '已安装' : '已卸载'}。${result?.note || ''}${result?.warnings?.length ? ' 加载提示：' + result.warnings.join('；') : ''}`);
        setAuthApps(result?.appsNeedingAuth || []);
        setRevision(value => value + 1);
        return true;
      } catch (reason) { setError(reason?.message || 'Codex 插件操作失败'); return false; }
      finally { setBusyId(''); }
    };
    const openInstall = () => { setInstallSource(''); setError(''); setInstallOpen(true); };
    const lifecycleButton = (item, compact = false) => lifecycleAvailable(item) ? h('button', {
      type: 'button', disabled: Boolean(busyId), onClick: () => void mutate(item, installed(item) ? 'uninstall' : 'install'),
      style: { ...buttonStyle(), padding: compact ? '5px 9px' : '7px 12px', fontSize: compact ? '10px' : '12px', color: installed(item) ? BRAND.danger : BRAND.primaryText, background: installed(item) ? BRAND.surface : BRAND.primaryFill, borderColor: installed(item) ? BRAND.border : 'transparent' },
    }, busyId === id(item) ? '处理中…' : installed(item) ? '卸载' : '安装') : null;
    const iconSquare = item => {
      const icon = item?.iconDataUrl || item?.iconUrl || item?.icon;
      return h('div', { style: { width: '42px', height: '42px', display: 'grid', placeItems: 'center', borderRadius: '11px', overflow: 'hidden', background: '#f2f0ff', color: '#6656c8', fontWeight: 800 } }, icon
        ? h('img', { src: icon, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer', style: { width: '70%', height: '70%', objectFit: 'contain' } }) : String(label(item)).charAt(0).toUpperCase());
    };
    const row = item => h('article', { key: id(item), style: { display: 'flex', flexWrap: 'wrap', gap: '11px', alignItems: 'center', padding: '12px 0', borderBottom: '1px solid ' + BRAND.border } },
      iconSquare(item),
      h('button', { type: 'button', onClick: () => setSelectedId(id(item)), style: { flex: '1 1 180px', minWidth: 0, padding: 0, border: 0, background: 'transparent', textAlign: 'left', color: BRAND.ink, cursor: 'pointer' } },
        h('strong', { style: { display: 'block', fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, label(item)),
        h('span', { style: { display: 'block', marginTop: '3px', color: BRAND.inkMuted, fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.description || item.marketplaceName || item.marketplace || id(item))),
      h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' } }, h(Pill, { tone: !lifecycleAvailable(item) ? 'signal' : installed(item) ? 'accent' : 'neutral' }, stateLabel(item)), lifecycleButton(item, true)));
    const section = (title, rows) => rows.length ? h('section', null,
      h('h3', { style: { margin: '12px 0 0', color: BRAND.ink, fontSize: '15px' } }, `${title} · ${rows.length}`), rows.map(row)) : null;
    const detail = selected ? h('section', { style: { display: 'grid', gap: '12px' } },
      h('button', { type: 'button', onClick: () => setSelectedId(''), style: { ...buttonStyle(), justifySelf: 'start', background: BRAND.surface } }, '← 返回 Codex 插件'),
      h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center', flexWrap: 'wrap' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } }, iconSquare(selected), h('div', null,
          h('h3', { style: { margin: 0, color: BRAND.ink, fontSize: '17px' } }, label(selected)),
          h('code', { style: { display: 'block', marginTop: '5px', color: BRAND.inkMuted, fontSize: '10px', wordBreak: 'break-word' } }, id(selected)))),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } }, h(Pill, { tone: !lifecycleAvailable(selected) ? 'signal' : 'accent' }, stateLabel(selected)), lifecycleButton(selected))),
      selected.description ? h('p', { style: { margin: 0, color: BRAND.ink, lineHeight: 1.65, fontSize: '12px', whiteSpace: 'pre-wrap' } }, selected.description) : null,
      h('dl', { style: { margin: 0, padding: '10px 0', borderTop: '1px solid ' + BRAND.border, borderBottom: '1px solid ' + BRAND.border, display: 'grid', gap: '6px' } },
        [['版本', selected.version], ['市场', selected.marketplaceName || selected.marketplace], ['来源', selected.source], ['分类', selected.category], ['状态', stateLabel(selected)]].map(([key, value]) => h('div', { key, style: { display: 'grid', gridTemplateColumns: '70px minmax(0, 1fr)', gap: '10px', fontSize: '11px' } }, h('dt', { style: { color: BRAND.inkMuted } }, key), h('dd', { style: { margin: 0, color: BRAND.ink, wordBreak: 'break-word' } }, value || '—')))),
      selected.error ? h('p', { role: 'alert', style: { margin: 0, color: BRAND.danger, whiteSpace: 'pre-wrap', fontSize: '12px' } }, selected.error.message || selected.error.diagnostic || selected.error.code || 'Codex 目录错误') : null,
      h('p', { style: { margin: 0, color: BRAND.inkMuted, fontSize: '12px', lineHeight: 1.6 } }, '插件在新建的 Codex Agent 会话中加载。需要登录的连接器沿用 Codex 授权状态。'),
      installed(selected) && selected.lifecycleAvailable !== false ? h(CodexPluginCapabilities, { key: `${id(selected)}:${revision}`, pluginId: id(selected) }) : null) : null;
    return h('div', { 'data-codex-plugin-center': 'true', style: { display: 'grid', gap: '13px' } },
      error ? h('p', { role: 'alert', style: { margin: 0, color: BRAND.signal, fontSize: '12px', lineHeight: 1.55 } }, error) : null,
      message ? h('p', { role: 'status', style: { margin: 0, color: BRAND.accentStrong, fontSize: '12px' } }, message) : null,
      authApps.length ? h('p', { role: 'status', style: { margin: 0, color: BRAND.inkMuted, fontSize: '12px' } }, '以下连接器仍需授权：', authApps.map(app => h('span', { key: app.id, style: { marginLeft: '10px' } }, app.installUrl ? h('a', { href: app.installUrl, target: '_blank', rel: 'noopener noreferrer' }, app.name) : app.name))) : null,
      busyId ? h('p', { role: 'status', style: { margin: 0, color: BRAND.inkMuted, fontSize: '12px' } }, '正在应用 Codex 插件变更，请稍候…') : null,
      selected ? detail : h(React.Fragment, null,
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
          h('input', { type: 'search', value: query, onChange: event => setQuery(event.target.value), placeholder: '搜索 Codex 插件', 'aria-label': '搜索 Codex 插件', style: { ...inputStyle(), marginTop: 0, flex: '1 1 260px' } }),
          h('button', { type: 'button', onClick: openInstall, disabled: Boolean(busyId), style: buttonStyle() }, '添加 Codex 插件'),
          h('button', { type: 'button', onClick: () => void load(), disabled: status === 'loading' || Boolean(busyId), style: buttonStyle() }, status === 'loading' ? '读取中…' : '刷新')),
        h('p', { style: { margin: 0, color: BRAND.inkMuted, fontSize: '12px', lineHeight: 1.6 } }, '安装状态与当前 Codex 配置共享。新建 Codex Agent 会话后加载插件，连接器仍需完成服务授权。'),
        status === 'loading' ? h(EmptyState, { icon: '·', title: '正在读取 Codex 插件目录', detail: '读取可用插件和当前安装状态。' }) : null,
        status !== 'loading' && visible.length ? h('div', { style: { maxHeight: 'min(65vh, 620px)', overflow: 'auto' } },
          section('已安装', visible.filter(installed)),
          section('精选', visible.filter(item => !installed(item) && item.featured && !normalized)),
          section('插件目录', visible.filter(item => !installed(item) && (normalized || !item.featured)))) : null,
        status === 'ready' && !visible.length ? h(EmptyState, { icon: '⌘', title: query.trim() ? '没有匹配的 Codex 插件' : '尚未发现 Codex 插件', detail: query.trim() ? '试试其他名称，或清空搜索查看全部插件。' : '可以点击添加 Codex 插件，输入插件名@市场名。市场需已在 Codex 中配置。' }) : null),
      installOpen ? h(ResourceDialog, { title: '添加 Codex 插件', detail: '输入完整插件标识，例如 plugin-name@marketplace。市场需要已在 Codex 中配置。', onClose: () => { if (!busyId) setInstallOpen(false); } },
        h('form', { onSubmit: async event => { event.preventDefault(); const pluginId = installSource.trim(); if (pluginId && await mutate({ pluginId }, 'install')) setInstallOpen(false); }, style: { display: 'grid', gap: '14px' } },
          h('input', { 'aria-label': 'Codex 插件标识', value: installSource, onChange: event => setInstallSource(event.target.value), required: true, placeholder: 'plugin-name@marketplace', style: inputStyle() }),
          error ? h('p', { role: 'alert', style: { color: BRAND.danger, whiteSpace: 'pre-wrap', margin: 0 } }, error) : null,
          h('button', { type: 'submit', disabled: Boolean(busyId) || !installSource.trim(), style: buttonStyle() }, busyId ? '正在安装…' : '安装插件'))) : null);
  }
  return { CodexPluginCapabilities, CodexPluginMarketItem };
}
