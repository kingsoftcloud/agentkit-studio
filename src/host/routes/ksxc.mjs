import { KSXC_DESKTOP_USER } from '../services/ksxc.mjs';

export function createKsxcRoute(ksxc) {
  return async (endpoint, payload, signal) => {
    const user = { userId: KSXC_DESKTOP_USER };
    const { releases, accounts } = ksxc || {};
    if (endpoint === 'ksxc/status') {
      return { ok: true, value: releases && accounts
        ? { supported: true, release: await releases.status(), connection: await accounts.status(user) }
        : { supported: false } };
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
