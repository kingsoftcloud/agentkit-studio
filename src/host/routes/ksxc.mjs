import { KSXC_DESKTOP_USER } from '../services/ksxc.mjs';

export function createKsxcRoute(ksxc) {
  return async (endpoint, payload, signal) => {
    const user = { userId: KSXC_DESKTOP_USER };
    const { releases, accounts, gatewayStatus } = ksxc || {};
    if (endpoint === 'ksxc/status') {
      if (!releases || !accounts) return { ok: true, value: { supported: false } };
      if (payload?.gatewayOnly) {
        return { ok: true, value: { supported: true, gateway: await gatewayStatus?.status() } };
      }
      const [release, connection, gateway] = await Promise.all([
        releases.status(payload?.refresh ? { refresh: true } : undefined),
        accounts.status(user),
        gatewayStatus?.status({ refresh: payload?.refresh === true }),
      ]);
      return { ok: true, value: { supported: true, release, connection, gateway } };
    }
    if (endpoint === 'ksxc/install-start' || endpoint === 'ksxc/install-status') {
      if (!releases?.startInstall) throw Object.assign(new Error('当前 Studio Host 不支持安装 KSXC。'), { code: 'KSXC_HOST_UNAVAILABLE' });
      return { ok: true, value: endpoint === 'ksxc/install-start'
        ? releases.startInstall(payload?.version) : releases.installStatus(payload?.requestId) };
    }
    if (endpoint === 'ksxc/cache-clear') {
      if (!ksxc?.managedConnection?.clear) return { ok: true, value: { cleared: false } };
      await ksxc.managedConnection.clear(payload?.userId);
      return { ok: true, value: { cleared: true } };
    }
    if (!accounts || !releases) throw Object.assign(new Error('当前 Studio Host 尚未配置 KSXC。'), { code: 'KSXC_HOST_UNAVAILABLE' });
    const operations = {
      'ksxc/activate': () => releases.activate(payload?.version),
      'ksxc/enable': () => releases.enable(payload?.enabled),
      'ksxc/rollback': () => releases.rollback(),
      'ksxc/login': () => accounts.begin(user),
      'ksxc/login-result': () => accounts.poll({ ...user, id: payload?.id }),
      'ksxc/login-cancel': () => accounts.cancel({ ...user, id: payload?.id }),
      'ksxc/disconnect': () => accounts.disconnect(user),
      'ksxc/models': () => ksxc.desktopModels(signal),
    };
    return { ok: true, value: await operations[endpoint]() };
  };
}
