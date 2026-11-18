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
    const pending = useRef(false);

    useEffect(() => {
      const lifetime = new AbortController();
      const refresh = () => hostRemote.starHarnessStatus({}, lifetime.signal).then(value => {
        if (!lifetime.signal.aborted && !pending.current) setStatus(value);
      }, reason => {
        if (!lifetime.signal.aborted) setError(reason.message || '读取 Star Harness 状态失败。');
      });
      void refresh();
      window.addEventListener(STAR_HARNESS_CHANGED, refresh);
      return () => {
        lifetime.abort();
        window.removeEventListener(STAR_HARNESS_CHANGED, refresh);
      };
    }, []);

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

    const disabled = Boolean(busy || status?.busy);
    if (view !== 'page') {
      const enabled = status?.enabled === true;
      return h('span', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' } },
        h('span', { role: error ? 'alert' : undefined, title: error || undefined,
          style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
        error || (status?.version ? '已安装 ' + status.version : '管理 Star Harness 版本')),
        status?.version ? h('button', { type: 'button', role: 'switch', 'aria-label': '启用 Star Harness',
          'aria-checked': enabled, disabled,
          onClick: () => perform(enabled ? '正在停用…' : '正在启用…', () => hostRemote.enableStarHarness(!enabled), ''),
          style: { display: 'inline-flex', alignItems: 'center', justifyContent: enabled ? 'flex-end' : 'flex-start',
            padding: '2px', width: '32px', height: '16px', flex: 'none', border: 0, borderRadius: '999px',
            background: enabled ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-border-l2)',
            cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1 },
        }, h('span', { 'aria-hidden': true, style: { width: '12px', height: '12px', borderRadius: '50%',
          background: enabled ? 'var(--dsw-alias-bg-l1)' : 'var(--dsw-alias-label-secondary)' } })) : null);
    }

    const requested = version.trim() || status?.availableUpgrade || status?.version || status?.recommendedVersion || '';
    const reinstall = Boolean(status?.version && status.version === requested && version.trim());
    const install = () => perform(status.version ? '正在升级 Star Harness…' : '正在安装 Star Harness…',
      async () => {
        const value = await hostRemote.installStarHarness(requested);
        setVersion('');
        return value;
      }, '版本已通过握手验证。');
    const restore = () => perform('正在切回上一版本…', () => hostRemote.installStarHarness(status.previousVersion), '已切回上一版本。');

    return h('section', { 'aria-label': 'Star Harness 管理', style: stack },
      !status && !busy && !error ? h('p', { role: 'status', style: muted }, '正在读取 Star Harness 状态…') : null,
      busy || message ? h('p', { role: 'status', style: muted }, busy || message) : null,
      !busy && status?.busy ? h('p', { role: 'status', style: muted }, '任务运行中，结束后可以更改版本。') : null,
      error ? h('p', { role: 'alert', style: muted }, error) : null,
      status?.registryUnavailable ? h('p', { role: 'status', style: muted }, '暂时无法读取 npm 的最新版本。') : null,
      status?.supported === false ? h('p', { style: muted }, '此 Studio 部署由管理员管理。') : null,
      status && status.supported !== false ? h('div', { style: stack },
        h('div', { style: row }, h('strong', null, '版本'),
          status.version ? h('span', { style: muted }, '已安装 ' + status.version) : null,
          status.availableUpgrade ? h('span', { style: muted }, '可升级到 ' + status.availableUpgrade) : null,
          button('检查更新', () => perform('正在检查更新…',
            () => hostRemote.starHarnessStatus({ checkUpdates: true }), '', false), Boolean(busy))),
        h('div', { style: row },
          h('input', { 'aria-label': '版本', style: { ...inputStyle(), width: '112px', marginTop: 0 },
            value: version, placeholder: requested, onChange: event => setVersion(event.target.value), disabled }),
          button(reinstall ? '重新安装' : status.version ? '升级' : '安装', install,
            disabled || !requested || status.version === requested && !reinstall),
          status.previousVersion ? button('回退到 ' + status.previousVersion, restore, disabled) : null),
        h('p', { style: muted }, '启用后，Star Harness 会使用会话在 Studio 中选择的工作区。'),
        status.workspaces?.some(item => item.external) ? h('ul', { style: { ...stack, margin: 0, padding: 0, listStyle: 'none' } },
          status.workspaces.filter(item => item.external).map(item => h('li', { key: item.workspace },
            h('strong', { style: { overflowWrap: 'anywhere' } }, item.workspace),
            h('p', { style: muted }, ['外部管理', item.model, item.running ? '运行中' : '未连接', item.version].filter(Boolean).join(' · '))))) : null) : null);
  };
}
