export function createStudioSettingsSection({
  ui: { React: { createElement: h, useEffect, useState, useRef }, BRAND, SettingsRow, buttonStyle },
  hostRemote, versions, window = globalThis.window
}) {
  const { STUDIO_VERSION, STUDIO_PLUGIN_VERSION, DSH_VERSION } = versions;
  const SettingsGroup = (title, ...rows) => h('section', { 'data-studio-settings-group': true },
    h('h3', null, title), h('div', { className: 'studio-settings-panel studio-panel' }, ...rows));
  function PrivacySettings({ bridge }) {
    const [state, setState] = useState(null);
    const [busy, setBusy] = useState(false);
    const [preview, setPreview] = useState(null);
    const [error, setError] = useState(false);
    useEffect(() => {
      let active = true;
      bridge.status().then(result => { if (active) setState(result); })
        .catch(() => { if (active) setError(true); });
      return () => { active = false; };
    }, [bridge]);
    const update = async action => {
      setBusy(true);
      setError(false);
      setPreview(null);
      try { setState(await action()); }
      catch { setError(true); }
      finally { setBusy(false); }
    };
    const showPreview = async mode => {
      setError(false);
      try { setPreview({ mode, body: await bridge.preview(mode) }); }
      catch { setError(true); }
    };
    const refresh = async () => {
      setError(false);
      try { setState(await bridge.status()); }
      catch { setError(true); }
    };
    const switchRow = (key, label, detail) => h('div', { className: 'agentkit-settings-row' },
      h('div', { className: 'agentkit-check-label' }, label),
      h('div', { className: 'agentkit-form-note' }, detail),
      h('button', { 'aria-label': label, 'aria-pressed': Boolean(state?.enabled[key]), style: buttonStyle(),
        disabled: busy || !state?.available || state.noticePending,
        onClick: () => void update(() => bridge.set(key, !state.enabled[key])) },
      state?.enabled[key] ? '已开启' : '已关闭'));
    return SettingsGroup('隐私与数据',
      switchRow('basic', '基础运营统计', '打开次数、版本、启动和更新结果。'),
      switchRow('crash', '崩溃统计', '故障来源、阶段和固定错误类别。'),
      switchRow('run', '本地 Run 统计', '运行结果、时长和可用的用量计数。'),
      state?.noticePending && h('button', { style: buttonStyle(), disabled: busy,
        onClick: () => void update(() => bridge.notice()) }, '查看数据与隐私说明'),
      state?.endpoint && h('div', { className: 'agentkit-form-note' }, `接收方 ${state.endpoint}`),
      state?.installId && h('div', { className: 'agentkit-form-note' }, `安装标识 ${state.installId}`),
      h('div', { className: 'agentkit-form-actions' },
        h('button', { style: buttonStyle(), disabled: busy || !state?.available, onClick: () => void showPreview('queued') }, '查看待发送数据'),
        h('button', { style: buttonStyle(), disabled: busy || !state, onClick: () => void showPreview('example') }, '查看固定样例'),
        h('button', { style: buttonStyle(), disabled: busy || !state, onClick: () => void update(() => bridge.stop(false)) }, '停止所有遥测'),
        h('button', { style: buttonStyle(), disabled: busy || !state, onClick: () => void update(() => bridge.stop(true)) }, '清除本地遥测数据')),
      preview && h('div', null,
        h('div', { className: 'agentkit-form-note' }, preview.mode === 'example' ? '本地固定样例' : '当前待发送数据'),
        h('pre', { tabIndex: 0, style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } },
          preview.body || '当前没有待发送数据。')),
      state?.diagnostics && h('details', null,
        h('summary', null, '本次启动的本地诊断'),
        h('div', { className: 'agentkit-form-note' }, `待发送 ${state.queued}，发送失败 ${state.diagnostics.send_failed}，队列丢弃 ${state.diagnostics.queue_drop}，服务端拒收 ${state.diagnostics.rejected}，存储错误 ${state.diagnostics.storage}，发送器错误 ${state.diagnostics.export}`),
        h('button', { style: buttonStyle(), disabled: busy, onClick: () => void refresh() }, '刷新诊断')),
      error && h('div', { role: 'status', className: 'agentkit-form-note' }, '无法读取或保存遥测设置。'));
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
