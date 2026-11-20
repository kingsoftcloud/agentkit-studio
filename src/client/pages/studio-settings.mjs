export function createStudioSettingsSection({
  ui: { React: { createElement: h, useEffect, useState, useRef }, BRAND, SettingsRow, buttonStyle },
  hostRemote, versions, Switch, window = globalThis.window
}) {
  const { STUDIO_VERSION, STUDIO_PLUGIN_VERSION, DSH_VERSION } = versions;
  const SettingsGroup = (title, ...rows) => h('section', { 'data-studio-settings-group': true },
    h('h3', null, title), h('div', { className: 'studio-settings-panel studio-panel' }, ...rows));
  function PrivacySettings({ bridge }) {
    const [state, setState] = useState(undefined);
    const [busy, setBusy] = useState(false);
    const [preview, setPreview] = useState(null);
    const [error, setError] = useState(false);
    useEffect(() => {
      let active = true;
      bridge.status().then(result => { if (active) setState(result); })
        .catch(() => { if (active) setError(true); });
      return () => { active = false; };
    }, [bridge]);
    const run = async action => {
      setBusy(true);
      setError(false);
      try { await action(); }
      catch { setError(true); }
      finally { setBusy(false); }
    };
    const update = action => run(async () => {
      setPreview(null);
      setState(await action());
    });
    const showPreview = mode => run(async () => {
      setPreview({ mode, body: await bridge.preview(mode) });
    });
    const refresh = () => run(async () => setState(await bridge.status()));
    const action = (label, onClick) => h('button', {
      type: 'button', className: 'studio-privacy-action', disabled: busy, onClick,
    }, label);
    const switchRow = (key, label, detail) => h('div', { key, className: 'studio-privacy-row' },
      h('div', null, h('div', { className: 'agentkit-check-label' }, label),
        h('div', { className: 'agentkit-form-note' }, detail)),
      h(Switch, { checked: state.enabled[key], role: 'switch', 'aria-label': label, disabled: busy,
        onChange: event => {
          const { checked } = event.currentTarget;
          void update(() => bridge.set(key, checked));
        } }));
    const statusText = () => {
      if (error && state === undefined) return '读取失败';
      if (state === undefined) return '读取中…';
      if (!state) return '不可用';
      if (!state.endpoint) return '接收地址未配置';
      if (!state.available) return '已停用';
      const count = Object.values(state.enabled).filter(Boolean).length;
      return count ? `已开启 ${count} 项` : '未开启';
    };
    const diagnostics = state?.diagnostics;
    const needsDesktopUpdate = state?.noticePending && typeof bridge.notice === 'function';
    return h('details', { 'data-studio-privacy': true, className: 'studio-settings-panel studio-privacy' },
      h('summary', { className: 'studio-privacy-summary' }, h('span', null, '隐私与数据'),
        h('span', { className: 'studio-privacy-state' }, statusText())),
      h('div', { className: 'studio-privacy-body' },
        state === null ? h('p', { className: 'agentkit-form-note' }, '此版本无法使用遥测服务。') : null,
        state && !state.endpoint ? h('p', { className: 'agentkit-form-note' }, '当前安装包未配置接收地址。') : null,
        state?.endpoint && !state.available ? h('p', { className: 'agentkit-form-note' }, '当前桌面配置已停用上报。') : null,
        state ? h('details', { className: 'studio-privacy-details', open: state.noticePending || undefined },
          h('summary', { className: 'studio-privacy-summary' }, '数据与隐私说明'),
          h('p', { className: 'agentkit-form-note' }, '可随时开启或关闭各项统计。上报使用随机安装标识，凭证、会话内容和完整日志保留在本机。'),
          state.endpoint ? h('p', { className: 'agentkit-form-note' }, `接收方 ${state.endpoint}`) : null,
          state.endpoint && !state.selfHosted ? h('p', { className: 'agentkit-form-note' },
            '官方接收方保留事件 90 天。如需删除已上报的数据，可通过私密支持渠道提供「上报详情」中的安装标识。') : null) : null,
        needsDesktopUpdate ? h('p', { className: 'agentkit-form-note' }, '请更新桌面应用后在这里更改统计设置。') : null,
        state?.available && !needsDesktopUpdate ? [
          switchRow('basic', '基础运营统计', '打开次数、版本、启动和更新结果。'),
          switchRow('crash', '崩溃统计', '故障来源、阶段和错误类别。'),
          switchRow('run', '本地 Run 统计', '运行结果、时长和用量计数。'),
        ] : null,
        state ? h('details', { className: 'studio-privacy-details' },
          h('summary', { className: 'studio-privacy-summary' }, '上报详情'),
          state.installId ? h('p', { className: 'agentkit-form-note' }, `安装标识 ${state.installId}`) : null,
          diagnostics ? h('p', { className: 'agentkit-form-note' },
            `待发送 ${state.queued} · 发送失败 ${diagnostics.send_failed} · 队列丢弃 ${diagnostics.queue_drop} · 服务端拒收 ${diagnostics.rejected} · 存储错误 ${diagnostics.storage} · 发送器错误 ${diagnostics.export}`) : null,
          h('div', { className: 'studio-privacy-actions' },
            state.available ? action('查看待发送数据', () => void showPreview('queued')) : null,
            action('查看固定样例', () => void showPreview('example')),
            diagnostics ? action('刷新诊断', refresh) : null),
          preview ? h('div', { className: 'studio-privacy-preview', role: 'region',
            'aria-label': preview.mode === 'example' ? '本地固定样例' : '当前待发送数据' },
            h('pre', { tabIndex: 0 }, preview.body || '当前没有待发送数据。')) : null,
          state.available || state.installId ? h('div', { className: 'studio-privacy-actions studio-privacy-management' },
            action('停止所有遥测', () => void update(() => bridge.stop(false))),
            action('清除本地遥测数据', () => void update(() => bridge.stop(true)))) : null) : null,
        error ? h('div', { className: 'studio-privacy-row' },
          h('p', { role: 'status', className: 'agentkit-form-note' }, '无法读取或保存遥测设置。'),
          action('重试读取', refresh)) : null));
  }
  function StudioSettingsSection() {
    const [host, setHost] = useState({ status: 'loading', error: '' });
    const [promptPrediction, setPromptPrediction] = useState(() => {
      try { return window.localStorage.getItem('agentkit-studio.prompt-prediction.enabled') !== '0'; } catch { return true; }
    });
    const [desktopUpdate, setDesktopUpdate] = useState({ phase: 'idle' });
    const updateLifetime = useRef({ active: false, revision: 0, opening: false });
    const desktopUpdates = typeof window === 'undefined' ? undefined : window.dshDesktop?.updates;
    const desktopTelemetry = window?.dshDesktop?.telemetry;
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
    const togglePromptPrediction = () => {
      const enabled = !promptPrediction;
      setPromptPrediction(enabled);
      try { window.localStorage.setItem('agentkit-studio.prompt-prediction.enabled', enabled ? '1' : '0'); } catch { /* private mode */ }
      window.dispatchEvent(new CustomEvent('agentkit-studio:prompt-prediction-setting', { detail: { enabled } }));
    };
    return h('div', {
      'data-studio-settings': true, style: { color: BRAND.ink, fontFamily: 'inherit' },
    },
    h('div', { className: 'agentkit-form-heading' }, h('div', null, h('h3', null, 'AgentKit Studio'), h('i', { className: 'studio-help', role: 'img', 'aria-label': '管理本机运行和桌面更新。', title: '管理本机运行和桌面更新。' }, 'i'))),
    SettingsGroup('本机运行',
      h(SettingsRow, { label: '会话绑定策略', value: '可选 Agent', detail: '不选择 Agent 时直接使用 DSH 原生会话；选择后在新会话创建时固定主 Agent', tone: 'accent' }),
      h(SettingsRow, { label: '默认执行目标', value: 'Local Host', detail: '创建 Agent 和运行会话时使用的默认目标', tone: 'signal' }),
      h(SettingsRow, { label: 'Studio Host', value: host.status === 'ready' ? '已连接' : host.status === 'loading' ? '检查中' : '连接失败', detail: host.status === 'ready' ? '已成功读取 Host 配置' : host.error || '正在读取 Host 配置', tone: 'signal' }),
      h('div', { 'data-studio-settings-row': true, className: 'studio-srow' },
        h('div', null,
          h('div', { className: 'agentkit-check-label' }, '下一句提示'),
          h('div', { role: 'note', className: 'agentkit-form-note' }, '仅在输入框为空且上一轮完成后请求短文本预测；预测不会写入会话历史。')),
        h('button', { type: 'button', onClick: togglePromptPrediction, style: buttonStyle() }, promptPrediction ? '已开启' : '已关闭')),
    ),
    SettingsGroup('版本与更新',
      h(SettingsRow, { label: 'AgentKit Studio 版本', value: STUDIO_VERSION, detail: '当前安装的桌面应用版本' }),
      h(SettingsRow, { label: 'Studio 插件版本', value: STUDIO_PLUGIN_VERSION, detail: '产品功能与运行适配层版本' }),
      h(SettingsRow, { label: 'DSH 宿主兼容版本', value: DSH_VERSION, detail: '固定的宿主基线，不代表 Studio 产品版本' }),
      h('div', { 'data-studio-settings-row': true, className: 'studio-srow' },
        h('div', null,
          h('div', { className: 'agentkit-check-label' }, '桌面更新'),
          h('div', { role: 'status', className: 'agentkit-form-note' }, !desktopUpdates ? '请在 AgentKit Studio 桌面应用中检查更新。' : desktopUpdate.phase === 'error' ? '更新检查失败，可重试。' : desktopUpdate.version ? `目标版本：${desktopUpdate.version}` : '使用 Studio 的更新源检查新版本。')),
        h('button', { type: 'button', onClick: checkDesktopUpdate, disabled: !desktopUpdates || ['checking', 'downloading', 'verifying', 'installing'].includes(desktopUpdate.phase), style: buttonStyle() }, updateButtonLabel))),
    desktopTelemetry && h(PrivacySettings, { bridge: desktopTelemetry }),
    h('div', { className: 'agentkit-guide-entry' },
      h('p', { className: 'agentkit-form-note' }, '模型配置在「模型与凭证」中。首次使用可打开配置引导。'),
      h('button', { type: 'button', onClick: () => window.dispatchEvent(new CustomEvent('agentkit-studio:credential-onboarding')), style: { ...buttonStyle(), marginTop: '12px' } }, '重新打开凭证引导')));
  }
  return StudioSettingsSection;
}
