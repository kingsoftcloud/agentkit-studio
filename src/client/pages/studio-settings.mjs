export function createStudioSettingsSection({ ui, hostRemote, versions, window = globalThis.window }) {
  const { React, BRAND, SettingsRow, buttonStyle } = ui;
  const { createElement: h, useEffect, useState, useRef } = React;
  const { STUDIO_VERSION, STUDIO_PLUGIN_VERSION, DSH_VERSION } = versions;
  function StudioSettingsSection() {
    const [host, setHost] = useState({ status: 'loading', error: '' });
    const [desktopUpdate, setDesktopUpdate] = useState({ phase: 'idle' });
    const updateLifetime = useRef({ active: false, revision: 0, opening: false });
    const desktopUpdates = typeof window === 'undefined' ? undefined : window.dshDesktop?.updates;
    useEffect(() => {
      let active = true;
      hostRemote.settings().then(() => { if (active) setHost({ status: 'ready', error: '' }); })
        .catch(error => { if (active) setHost({ status: 'error', error: error?.message || 'Studio Host 不可达' }); });
      return () => { active = false; };
    }, []);
    useEffect(() => {
      const bridge = desktopUpdates;
      if (!bridge) return undefined;
      const lifetime = updateLifetime.current;
      lifetime.active = true;
      const revision = lifetime.revision;
      const unsubscribe = bridge.subscribe(state => {
        lifetime.revision += 1;
        if (lifetime.active && state) setDesktopUpdate(state);
      });
      bridge.status().then(state => {
        if (lifetime.active && revision === lifetime.revision && state) setDesktopUpdate(state);
      }).catch(() => undefined);
      return () => { lifetime.active = false; lifetime.revision += 1; unsubscribe?.(); };
    }, [desktopUpdates]);
    const checkDesktopUpdate = async () => {
      const bridge = desktopUpdates;
      const lifetime = updateLifetime.current;
      if (!bridge || lifetime.opening || ['checking', 'downloading', 'verifying', 'installing'].includes(desktopUpdate.phase)) return;
      lifetime.opening = true;
      lifetime.revision += 1;
      setDesktopUpdate(current => ({ ...current, phase: 'checking' }));
      try {
        await bridge.open();
        const revision = lifetime.revision;
        const state = await bridge.status();
        if (lifetime.active && revision === lifetime.revision && state) setDesktopUpdate(state);
      } catch {
        if (lifetime.active) setDesktopUpdate({ phase: 'error', failure: 'check' });
      } finally { lifetime.opening = false; }
    };
    const updateButtonLabel = desktopUpdate.phase === 'checking' ? '检查中…'
      : desktopUpdate.phase === 'available' ? `发现 ${desktopUpdate.version || '新版本'}`
        : desktopUpdate.phase === 'ready' ? `安装 ${desktopUpdate.version || '新版本'}`
          : desktopUpdate.phase === 'error' ? '重试检查更新' : '检查更新';
    return h('div', {
      'data-studio-settings': true, style: { color: BRAND.ink, fontFamily: 'inherit' },
    },
    h('div', { className: 'agentkit-form-heading' }, h('div', null, h('h3', null, 'AgentKit Studio'), h('p', null, '管理本机运行和桌面更新。'))),
    h('section', { 'data-studio-settings-group': true }, h('h3', null, '本机运行'),
      h(SettingsRow, { label: '会话绑定策略', value: '可选 Agent', detail: '不选择 Agent 时直接使用 DSH 原生会话；选择后在新会话创建时固定主 Agent', tone: 'accent' }),
      h(SettingsRow, { label: '默认执行目标', value: 'Local Host', detail: '创建 Agent 和运行会话时使用的默认目标', tone: 'signal' }),
      h(SettingsRow, { label: 'Studio Host', value: host.status === 'ready' ? '已连接' : host.status === 'loading' ? '检查中' : '连接失败', detail: host.status === 'ready' ? '已成功读取 Host 配置' : host.error || '正在读取 Host 配置', tone: 'signal' }),
    ),
    h('section', { 'data-studio-settings-group': true }, h('h3', null, '版本与更新'),
      h(SettingsRow, { label: 'AgentKit Studio 版本', value: STUDIO_VERSION, detail: '当前安装的桌面应用版本' }),
      h(SettingsRow, { label: 'Studio 插件版本', value: STUDIO_PLUGIN_VERSION, detail: '产品功能与运行适配层版本' }),
      h(SettingsRow, { label: 'DSH 宿主兼容版本', value: DSH_VERSION, detail: '固定的宿主基线，不代表 Studio 产品版本' }),
      h('div', { 'data-studio-settings-row': true },
        h('div', null,
          h('div', { className: 'agentkit-check-label' }, '桌面更新'),
          h('div', { role: 'status', className: 'agentkit-form-note' }, !desktopUpdates ? '请在 AgentKit Studio 桌面应用中检查更新。' : desktopUpdate.phase === 'error' ? '更新检查失败，可重试。' : desktopUpdate.version ? `目标版本：${desktopUpdate.version}` : '使用 Studio 的更新源检查新版本。')),
        h('button', { type: 'button', onClick: checkDesktopUpdate, disabled: !desktopUpdates || ['checking', 'downloading', 'verifying', 'installing'].includes(desktopUpdate.phase), style: buttonStyle() }, updateButtonLabel))),
    h('div', { className: 'agentkit-guide-entry' },
      h('p', { className: 'agentkit-form-note' }, '模型配置在「模型与凭证」中。首次使用可打开配置引导。'),
      h('button', { type: 'button', onClick: () => window.dispatchEvent(new CustomEvent('agentkit-studio:credential-onboarding')), style: { ...buttonStyle(), marginTop: '12px' } }, '重新打开凭证引导')));
  }
  return StudioSettingsSection;
}
