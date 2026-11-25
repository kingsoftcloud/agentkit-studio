import { createFormKit } from '../components/form-kit.mjs';

export const KSXC_CHANGED = 'agentkit-studio:ksxc-changed';

const CATALOG_ERRORS = {
  KSXC_RELEASES_UNREACHABLE: '无法连接 KSXC 发布源，请检查网络后重试。',
  KSXC_RELEASE_INVALID: 'KSXC 发布源返回了无法识别的版本信息，请稍后重试。',
};

/** One line of install progress; phases without a byte count say what they are doing. */
export function installProgressText(progress, version) {
  if (progress.phase === 'download') {
    const total = progress.totalBytes ? ` / ${Math.round(progress.totalBytes / 1024 / 1024)} MB` : '';
    return `正在下载 ${version}（${Math.round(progress.receivedBytes / 1024 / 1024)}${total}）${progress.retrying ? ' · 连接中断，正在重试' : ''}`;
  }
  if (progress.phase === 'extract') return `正在解包 ${version}…`;
  if (progress.phase === 'probe') return `正在校验 ${version}…`;
  return '正在准备安装…';
}

export function createKsxcSettings({ React, hostRemote, window }) {
  const { createElement: h, useEffect, useRef, useState } = React;
  const { Button, Note, Progress, Row, Section, Select, Spinner } = createFormKit({ React });
  const cloudConnection = value => ({ connected: value?.Status === 'connected', account: value?.Account });
  const cloudStatus = hostRemote.ksxcCloudStatus && (async signal => ({ supported: true, connection: cloudConnection(await hostRemote.ksxcCloudStatus(signal)) }));
  const cloudLogin = async () => {    const value = await hostRemote.ksxcCloudLogin();
    const url = new URL(value?.LoginUrl);
    if (value.Status !== 'pending' || typeof value.AttemptId !== 'string' || !value.AttemptId || url.protocol !== 'https:' || url.username || url.password) {
      throw Error('托管 KSXC 服务返回了无效授权入口。');
    }
    return { id: value.AttemptId, url: url.href };
  };
  const cloudPoll = async (id, signal) => {
    const value = await hostRemote.ksxcCloudLoginResult(id, signal);
    if (value?.Status === 'pending') return { status: 'pending' };
    if (value?.Status === 'connected') return { status: 'connected', connection: cloudConnection(value) };
    throw Error('托管 KSXC 授权已结束，请重新登录。');
  };
  // The settings page is the only caller that asks the Host to re-read the company
  // gateway; the Agent form and the runtime catalog read the cached answer.
  // Defined once: the status effect depends on its identity.
  const desktopStatus = hostRemote.ksxcStatus
    ? signal => hostRemote.ksxcStatus(signal, { refresh: true })
    : undefined;
  function SettingsControls({ managed }) {
    const [status, setStatus] = useState(null);
    const [version, setVersion] = useState('');
    const [pending, setPending] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [progress, setProgress] = useState(null);
    // Polling must stop when the section unmounts: the install itself keeps running in the Host.
    const mounted = useRef(true);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const getStatus = managed ? cloudStatus : desktopStatus;
    const login = managed ? cloudLogin : hostRemote.ksxcLogin;
    const pollLogin = managed ? cloudPoll : hostRemote.ksxcLoginResult;
    const disconnectAccount = managed ? hostRemote.ksxcCloudDisconnect : hostRemote.ksxcDisconnect;
    const readStatus = async signal => {
      const next = await getStatus(signal);
      if (signal?.aborted) return;
      setStatus(next);
      setVersion(checked => next.release?.versions.includes(checked) ? checked : next.release?.active || next.release?.versions[0] || '');
    };
    const changed = () => window.dispatchEvent(new window.CustomEvent(KSXC_CHANGED));
    useEffect(() => {
      if (!getStatus) return;
      const lifetime = new AbortController();
      void readStatus(lifetime.signal).catch(reason => { if (!lifetime.signal.aborted) setError(reason.message); });
      return () => lifetime.abort();
    }, [getStatus]);
    useEffect(() => {
      if (!pending) return;
      const controller = new AbortController();
      let timer;
      const poll = async () => {
        try {
          const result = await pollLogin(pending.id, controller.signal);
          if (controller.signal.aborted) return;
          if (result.status === 'connected') {
            setPending(null);
            setStatus(previous => ({ ...previous, connection: result.connection }));
            changed();
          } else timer = window.setTimeout(poll, 2000);
        } catch (reason) {
          if (controller.signal.aborted) return;
          setError(reason.message);
          if (reason.code !== 'KSXC_AUTH_SERVICE_UNAVAILABLE') setPending(null);
          else timer = window.setTimeout(poll, 3000);
        }
      };
      timer = window.setTimeout(poll, 1200);
      return () => {
        controller.abort();
        window.clearTimeout(timer);
        if (!managed) void hostRemote.ksxcLoginCancel(pending.id).catch(() => {});
      };
    }, [pending]);

    async function applyInstall(selected) {
      setBusy(true); setError('');
      setProgress({ status: 'running', phase: 'prepare', receivedBytes: 0, totalBytes: null });
      try {
        const { requestId } = await hostRemote.ksxcInstallStart(selected);
        for (;;) {
          const next = await hostRemote.ksxcInstallStatus(requestId);
          if (!mounted.current) return;
          setProgress(next);
          if (next.status === 'failed') throw Object.assign(new Error(next.error?.message || 'KSXC 安装失败。'), { code: next.error?.code });
          if (next.status !== 'running') break;
          await new Promise(resolve => window.setTimeout(resolve, 300));
        }
        await readStatus();
        changed();
      } catch (reason) { if (mounted.current) setError(reason.message || 'KSXC 安装失败。'); }
      finally { if (mounted.current) { setBusy(false); setProgress(null); } }
    }
    async function apply(operation, { login = false, disconnect = false } = {}) {
      setBusy(true);
      setError('');
      try {
        const result = await operation();
        if (login) setPending(result);
        else {
          if (disconnect) setPending(null);
          await readStatus();
          changed();
        }
      } catch (reason) { setError(reason.message || 'KSXC 操作失败。'); }
      finally { setBusy(false); }
    }
    const { release, connection } = status || {};
    const installing = progress?.status === 'running';
    const installLabel = release?.active ? '切换版本' : '安装';
    return h(React.Fragment, null,
      error ? Note({ tone: 'danger', role: 'alert' }, error) : null,
      !getStatus || status?.supported === false ? Note(null, '当前 Host 尚未配置 KSXC。') : null,
      getStatus && !status ? Row({ title: '运行状态' },
        Button({ disabled: busy, onClick: () => apply(() => readStatus()) }, '重新读取')) : null,
      release && release.catalogError ? Note({ tone: 'warn', role: 'status' }, CATALOG_ERRORS[release.catalogError] || '无法读取 KSXC 的可用版本，请稍后重试。') : null,
      release ? Row({ title: '桌面版本',
        desc: installing ? installProgressText(progress, version) : release.active ? `当前 ${release.active} · ${release.ready ? '已启用' : '暂不可运行'}` : '尚未安装',
        footer: installing ? Progress({ label: 'KSXC 安装进度', indeterminate: progress.phase !== 'download' || !progress.totalBytes,
          value: progress.phase === 'download' ? progress.receivedBytes : 1, max: progress.phase === 'download' ? progress.totalBytes || 1 : 1 }) : null },
        Select({ value: version, 'aria-label': 'KSXC 版本', onChange: event => setVersion(event.target.value), disabled: busy || !release.versions.length },
          release.versions.length ? release.versions.map(item => h('option', { value: item, key: item }, item)) : h('option', { value: '' }, '无可用版本')),
        Button({ disabled: busy || !version || (release.active === version && release.ready),
          onClick: () => (hostRemote.ksxcInstallStart ? applyInstall(version) : apply(() => hostRemote.ksxcActivate(version))) },
          installing ? [Spinner({ label: '安装中' }), '安装中'] : installLabel),
        release.active ? Button({ disabled: busy, onClick: () => apply(() => hostRemote.ksxcEnable(!release.enabled)) },
          release.enabled ? '停用' : '启用') : null,
        release.previous ? Button({ disabled: busy, onClick: () => apply(hostRemote.ksxcRollback) }, `回退到 ${release.previous}`) : null) : null,
      connection ? Row({ title: '企业账号', desc: connection.connected ? [connection.account, connection.companyCode].filter(Boolean).join(' · ') : '尚未连接' },
        Button({ disabled: busy || Boolean(pending), onClick: () => apply(login, { login: true }) }, connection.connected ? '切换 WPS 账号' : '用 WPS 登录'),
        connection.connected ? Button({ disabled: busy, onClick: () => apply(disconnectAccount, { disconnect: true }) }, '断开') : null,
        pending ? h('span', { role: 'status' },
          h('a', { href: pending.url, target: '_blank', rel: 'noopener noreferrer' }, '打开 WPS 授权页'),
          ' · 等待授权',
          Button({ size: 'sm', onClick: () => setPending(null) }, '取消')) : null) : null);
  }
  return function KsxcSettings() {
    const [scope, setScope] = useState('desktop');
    return Section({ title: 'KSXC' },
      cloudStatus ? Row({ title: '连接位置' }, Select({ value: scope, 'aria-label': '连接位置', onChange: event => setScope(event.target.value) },
        h('option', { value: 'desktop' }, '本机 Studio'),
        h('option', { value: 'managed' }, '托管 Agent'))) : null,
      h(SettingsControls, { key: scope, managed: scope === 'managed' }));
  };
}
