export const STAR_HARNESS_CHANGED = 'agentkit-studio:star-harness-changed';

export function createStarHarnessPage({ ui, hostRemote, window }) {
  const { React: { createElement: h, useEffect, useRef, useState }, BRAND, buttonStyle, inputStyle } = ui;
  const button = (label, onClick, disabled) => h('button', { type: 'button', style: buttonStyle(), onClick, disabled }, label);
  const muted = { color: BRAND.inkMuted, margin: 0 };
  const row = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px' };
  const stack = { display: 'grid', gap: '14px' };

  return function StarHarnessItem({ view } = {}) {
    const [status, setStatus] = useState(null);
    const [busy, setBusy] = useState('');
    const [error, setError] = useState('');
    const [message, setMessage] = useState('');
    const [version, setVersion] = useState('');
    const [workspace, setWorkspace] = useState('');
    const [profileId, setProfileId] = useState('');
    const pending = useRef(false);

    useEffect(() => {
      if (view !== 'page') return;
      const lifetime = new AbortController();
      hostRemote.starHarnessStatus({}, lifetime.signal).then(value => {
        if (lifetime.signal.aborted) return;
        setStatus(value);
      }, reason => { if (!lifetime.signal.aborted) setError(reason.message || '读取 Star Harness 状态失败。'); });
      return () => lifetime.abort();
    }, [view]);

    if (view !== 'page') return h('p', { style: { ...muted, fontSize: '12px' } }, '安装、升级和管理 Star Harness 工作区。');

    async function perform(label, operation, success, changed = true) {
      if (pending.current) return;
      pending.current = true;
      setBusy(label); setError(''); setMessage('');
      try {
        setStatus(await operation());
        setMessage(success);
        if (changed) window.dispatchEvent(new window.Event(STAR_HARNESS_CHANGED));
      } catch (reason) {
        setError(reason?.message || 'Star Harness 操作失败。');
        try { setStatus(await hostRemote.starHarnessStatus()); } catch { /* keep the last known state */ }
      } finally { pending.current = false; setBusy(''); }
    }

    const requested = (version.trim() || status?.availableUpgrade || status?.version || status?.recommendedVersion || '');
    const reinstall = Boolean(status?.version && status.version === requested && version.trim());
    const bindable = status?.workspaces?.some(item => !item.missing);
    const disabled = Boolean(busy || status?.busy);
    const install = () => perform(status.version ? '正在升级 Star Harness…' : '正在安装 Star Harness…',
      async () => {
        const value = await hostRemote.installStarHarness(requested);
        setVersion('');
        return value;
      }, '版本已通过握手验证。');
    const restore = () => perform('正在切回上一版本…', () => hostRemote.installStarHarness(status.previousVersion), '已切回上一版本。');
    const enable = () => perform(status.enabled ? '正在停用 Star Harness…' : '正在启用 Star Harness…',
      () => hostRemote.enableStarHarness(!status.enabled), status.enabled ? '已停用 Star Harness。' : '已启用，可在创建 Agent 时选择 Star Harness。');
    const bind = event => {
      event.preventDefault();
      void perform('正在绑定工作区…', async () => {
        const result = await hostRemote.bindStarHarness(workspace.trim(), profileId);
        setWorkspace('');
        return result;
      }, '工作区已绑定。');
    };

    return h('section', { 'aria-label': 'Star Harness 管理', style: stack },
      h('div', { style: row },
        status?.supported !== false ? button('检查更新', () => perform('正在检查更新…',
          () => hostRemote.starHarnessStatus({ checkUpdates: true }), '', false), Boolean(busy)) : null,
        status?.supported === false ? h('p', { style: muted }, '此 Studio 部署由管理员管理。') : null,
        status && status.supported !== false ? h('span', null, status.version ? '已安装 ' + status.version : '未安装',
          status.version ? (status.enabled ? ' · 已启用' : ' · 已停用') : '') : null),
      !status && !busy && !error ? h('p', { role: 'status', style: muted }, '正在读取 Star Harness 状态…') : null,
      busy || message ? h('p', { role: 'status', style: muted }, busy || message) : null,
      !busy && status?.busy ? h('p', { role: 'status', style: muted }, '任务运行中。结束后可以更改版本或绑定。') : null,
      error ? h('p', { role: 'alert', style: muted }, error) : null,
      status?.registryUnavailable ? h('p', { role: 'status', style: muted }, '暂时无法读取 npm 的最新版本。') : null,
      status && status.supported !== false ? h('div', { style: stack },
        h('div', { style: row },
          h('label', null, '版本 ', h('input', { 'aria-label': '版本', style: { ...inputStyle(), width: '112px', marginTop: 0 },
            value: version, placeholder: requested, onChange: event => setVersion(event.target.value), disabled })),
          button(reinstall ? '重新安装' : status.version ? '升级' : '安装', install,
            disabled || !requested || status.version === requested && !reinstall),
          status.previousVersion ? button('回退到 ' + status.previousVersion, restore, disabled) : null,
          status.version ? button(status.enabled ? '停用' : '启用', enable, disabled || !status.enabled && !bindable) : null),
        h('section', { style: stack, 'aria-label': '工作区' },
          h('h3', { style: { margin: 0 } }, '工作区'),
          status.workspaces.length ? h('ul', { style: { ...stack, margin: 0, padding: 0, listStyle: 'none' } }, status.workspaces.map(item =>
            h('li', { key: item.workspace, style: { paddingBlock: '9px', borderBottom: '1px solid ' + BRAND.border } },
              h('div', { style: row },
                h('strong', { style: { overflowWrap: 'anywhere', flex: '1 1 245px' } }, item.workspace),
                item.external ? h('span', { style: muted }, '外部管理') : button('解除绑定', () => perform('正在解除绑定…',
                  () => hostRemote.unbindStarHarness(item.workspace), '工作区已解除绑定。'), disabled)),
              h('p', { style: muted }, [item.model, item.missing ? '目录已失效' : item.running ? '运行中' : '未运行', item.version].filter(Boolean).join(' · '))))) : null,
          status.version ? h('form', { onSubmit: bind, style: row },
            status.workspaceChoices?.length ? h('select', { 'aria-label': '选择已有工作区', disabled,
              value: status.workspaceChoices.some(item => item.path === workspace) ? workspace : '',
              onChange: event => setWorkspace(event.target.value),
              style: { ...inputStyle(), width: 'auto', maxWidth: '100%', marginTop: 0 } },
              h('option', { value: '' }, '选择已有工作区'),
              status.workspaceChoices.map(item => h('option', { key: item.path, value: item.path }, item.title || item.path))) : null,
            h('input', { 'aria-label': '工作区绝对路径', placeholder: '工作区绝对路径', value: workspace, disabled,
              onChange: event => setWorkspace(event.target.value), style: { ...inputStyle(), flex: '1 1 220px', marginTop: 0 } }),
            h('select', { 'aria-label': '工作区模型', value: profileId, disabled, onChange: event => setProfileId(event.target.value),
              style: { ...inputStyle(), width: 'auto', marginTop: 0 } }, h('option', { value: '' }, 'Studio 默认模型'),
              status.models.map(model => h('option', { key: model.id, value: model.id }, model.label))),
            h('button', { type: 'submit', style: buttonStyle(), disabled: disabled || !workspace.trim() }, '绑定工作区')) : null,
          status.version && !status.workspaces.length ? h('p', { style: muted }, '先绑定一个工作区，即可启用 Star Harness。') : null)) : null);
  };
}
