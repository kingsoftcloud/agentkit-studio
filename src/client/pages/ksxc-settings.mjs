import { createFormKit } from '../components/form-kit.mjs';

export const KSXC_CHANGED = 'agentkit-studio:ksxc-changed';

export function createKsxcSettings({ React, hostRemote, window }) {
  const { createElement: h, useEffect, useState } = React;
  const { Button, Note, Row, Section, Select } = createFormKit({ React });
  const cloudConnection = value => ({ connected: value?.Status === 'connected', account: value?.Account });
  const cloudStatus = hostRemote.ksxcCloudStatus && (async signal => ({ supported: true, connection: cloudConnection(await hostRemote.ksxcCloudStatus(signal)) }));
  const cloudLogin = async () => {
    const value = await hostRemote.ksxcCloudLogin();
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
  function SettingsControls({ managed }) {
    const [status, setStatus] = useState(null);
    const [version, setVersion] = useState('');
    const [pending, setPending] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const getStatus = managed ? cloudStatus : hostRemote.ksxcStatus;
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
    return h(React.Fragment, null,
      error ? Note({ tone: 'danger', role: 'alert' }, error) : null,
      !getStatus || status?.supported === false ? Note(null, '当前 Host 尚未配置 KSXC。') : null,
      getStatus && !status ? Row({ title: '运行状态' },
        Button({ disabled: busy, onClick: () => apply(() => readStatus()) }, '重新读取')) : null,
      release ? Row({ title: '桌面版本', desc: release.active ? `当前 ${release.active} · ${release.ready ? '已启用' : '暂不可运行'}` : '尚未安装' },
        Select({ value: version, 'aria-label': 'KSXC 版本', onChange: event => setVersion(event.target.value), disabled: busy || !release.versions.length },
          release.versions.length ? release.versions.map(item => h('option', { value: item, key: item }, item)) : h('option', { value: '' }, '无可用版本')),
        Button({ disabled: busy || !version || (release.active === version && release.ready), onClick: () => apply(() => hostRemote.ksxcActivate(version)) },
          release.active ? '切换版本' : '安装'),
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
