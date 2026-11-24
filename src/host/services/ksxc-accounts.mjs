import { createHash, randomUUID } from 'node:crypto';
import { KsxcRuntimeError } from '../../providers/ksxc-command.mjs';

const LOGIN_DURATION_MS = 5 * 60_000;
const WPS_ORIGIN = 'https://openapi.wps.cn';
const connectionRequired = () => new KsxcRuntimeError('KSXC_CONNECTION_REQUIRED', '请先连接你自己的 KSXC 企业账号。');
const unavailable = () => new KsxcRuntimeError('KSXC_AUTH_SERVICE_UNAVAILABLE', '暂时无法连接 KSXC 授权服务，请重试。');
const expired = () => new KsxcRuntimeError('KSXC_LOGIN_EXPIRED', '此次 WPS 授权已结束，请重新发起。');
const validToken = value => typeof value === 'string' && value.length <= 8192 && /^[^\s\x00-\x1f\x7f]+$/.test(value);

export function createKsxcAccounts({ credentials, companyConfig, gateway, fetchImpl = fetch, now = Date.now }) {
  const attempts = new Map();
  const mutations = new Map();
  const keyFor = userId => {
    if (typeof userId !== 'string' || !userId.trim()) throw connectionRequired();
    const scope = JSON.stringify([userId, companyConfig.code, gateway.origin, companyConfig.baseUrl]);
    return `agentkit-studio/ksxc-${createHash('sha256').update(scope).digest('hex')}`;
  };
  function mutate(key, task) {
    const result = (mutations.get(key) || Promise.resolve()).then(task);
    const tail = result.catch(() => {});
    mutations.set(key, tail);
    return result.finally(() => { if (mutations.get(key) === tail) mutations.delete(key); });
  }
  async function call(path, params, signal) {
    const url = new URL(`/kscc-web/auth/login/${path}`, gateway);
    url.search = new URLSearchParams(params);
    const timeout = AbortSignal.timeout(10_000);
    let payload;
    try {
      const response = await fetchImpl(url, { redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (!response.ok) throw unavailable();
      payload = await response.json();
    } catch { throw unavailable(); }
    if (payload?.code !== 200 || !payload.data || typeof payload.data !== 'object') throw unavailable();
    return payload.data;
  }
  function clear(key) {
    const attempt = attempts.get(key);
    attempt?.controller.abort();
    if (attempt) clearTimeout(attempt.timer);
    attempts.delete(key);
  }
  async function read(key) {
    const record = await credentials.readRecord(key);
    const data = record?.kind === 'grant' ? record.payload : null;
    return data?.companyCode === companyConfig.code && typeof data.accountId === 'string' && validToken(data.token) ? data : null;
  }
  async function view(key) {
    const data = await read(key);
    return data ? { connected: true, companyCode: data.companyCode, account: data.displayName } : { connected: false };
  }
  return {
    status: ({ userId }) => view(keyFor(userId)),
    async begin({ userId }) {
      const key = keyFor(userId);
      clear(key);
      const attempt = { id: randomUUID(), controller: new AbortController(), expiresAt: now() + LOGIN_DURATION_MS };
      attempts.set(key, attempt);
      attempt.timer = setTimeout(() => {
        if (attempts.get(key) === attempt) clear(key);
      }, LOGIN_DURATION_MS);
      attempt.timer.unref?.();
      try {
        const data = await call('url', { companyCode: companyConfig.code }, attempt.controller.signal);
        if (attempts.get(key) !== attempt) throw expired();
        const url = new URL(data.loginUrl);
        if (url.origin !== WPS_ORIGIN || url.username || url.password || typeof data.loginUUID !== 'string' || !data.loginUUID.trim()) {
          throw unavailable();
        }
        attempt.uuid = data.loginUUID;
        return { id: attempt.id, url: url.href, expiresAt: attempt.expiresAt };
      } catch (error) {
        if (attempts.get(key) === attempt) clear(key);
        throw error instanceof KsxcRuntimeError ? error : unavailable();
      }
    },
    async poll({ userId, id }) {
      const key = keyFor(userId);
      const attempt = attempts.get(key);
      if (!attempt?.uuid || attempt.id !== id || attempt.expiresAt <= now()) throw expired();
      attempt.result ??= (async () => {
        const data = await call('result', { loginUUID: attempt.uuid }, attempt.controller.signal);
        if (attempts.get(key) !== attempt || attempt.expiresAt <= now()) throw expired();
        if (data.status === 'pending') return { status: 'pending' };
        const { userInfo, sk } = data;
        if (data.status !== 'success' || userInfo?.companyCode !== companyConfig.code || userInfo.source !== 'wps'
          || userInfo.status !== 'active' || !['number', 'string'].includes(typeof userInfo.id)
          || !String(userInfo.id).trim() || !validToken(sk)) {
          clear(key);
          throw new KsxcRuntimeError('KSXC_LOGIN_IDENTITY_INVALID', 'WPS 授权未返回有效的 KSXC 企业账号。');
        }
        const record = {
          accountId: String(userInfo.id), companyCode: companyConfig.code,
          displayName: String(userInfo.userName || userInfo.id).slice(0, 100), token: sk,
        };
        return mutate(key, async () => {
          if (attempts.get(key) !== attempt || attempt.expiresAt <= now()) throw expired();
          await credentials.modifyRecord(key, async () => ({ kind: 'grant', payload: record }));
          if (attempts.get(key) === attempt) clear(key);
          return { status: 'connected', connection: await view(key) };
        });
      })().finally(() => { attempt.result = undefined; });
      return attempt.result;
    },
    cancel({ userId, id }) {
      const key = keyFor(userId);
      if (attempts.get(key)?.id === id) clear(key);
      return { canceled: true };
    },
    async disconnect({ userId }) {
      const key = keyFor(userId);
      clear(key);
      return mutate(key, async () => {
        await credentials.deleteRecord(key);
        return { connected: false };
      });
    },
    async connection({ userId }) {
      return read(keyFor(userId));
    },
    close() {
      for (const key of attempts.keys()) clear(key);
    },
  };
}
