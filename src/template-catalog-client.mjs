/** Server metadata stays on the authenticated Host. Signed KS3 URLs never reach the renderer. */
import { createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';
export const canonicalJson = value => JSON.stringify(value, (_, row) => row && typeof row === 'object' && !Array.isArray(row) ? Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])) : row);
export const templateDigest = value => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
export const localCatalogKey = secret => Buffer.from(hkdfSync('sha256', secret, 'agentkit-studio', 'studio-template-catalog/loopback/v1', 32)).toString('hex');
export function createTemplateCatalogClient({ origin, configuration, serverClient, environment, fetchImpl = fetch, timeoutMs = 30000 }) {
  if (origin) {
    const url = new URL(origin);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) throw new Error('本地模板 Server 需要有效的回环地址');
  }
  return { async action(action, payload = {}, { signal } = {}) {
    if (!origin) return (await (await serverClient()).action(action, payload, { signal, ...(environment?{templateEnvironment:environment}:{}) })).data;
    const { values } = await (await configuration()).resolve();
    if (!values.cloudSecretKey) throw Object.assign(new Error('本地模板 Server 需要当前云端凭据派生的专用认证'), { code: 'TEMPLATE_SERVER_CREDENTIAL_MISSING' });
    const body = JSON.stringify(payload), path = `/agentengine/api/v1/${action}`, timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString('hex');
    const message = ['studio-template-catalog/v1', 'POST', path, timestamp, nonce, createHash('sha256').update(body).digest('hex')].join('\n');
    const headers = { 'Content-Type': 'application/json', 'X-Studio-Time': timestamp, 'X-Studio-Nonce': nonce, Authorization: `Studio-HMAC ${createHmac('sha256', localCatalogKey(values.cloudSecretKey)).update(message).digest('hex')}` };
    let response;
    try { response = await fetchImpl(new URL(path, origin), { method: 'POST', body, headers, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) }); }
    catch { throw Object.assign(new Error(signal?.aborted ? '已取消模板操作' : '模板 Server 暂时无法连接'), { code: signal?.aborted ? 'TEMPLATE_CANCELLED' : 'TEMPLATE_SERVER_UNAVAILABLE' }); }
    const envelope = await response.json().catch(() => null);
    if (!response.ok || envelope?.Code !== 0 || !envelope?.Data) throw Object.assign(new Error(response.status === 401 ? '模板 Server 认证失效，请检查当前连接' : response.status === 409 ? '模板版本或资源已变化，请刷新目录' : response.status === 404 ? '模板版本暂不可用，请刷新目录' : '模板 Server 请求失败'), { code: 'TEMPLATE_SERVER_REJECTED', status: response.status });
    return envelope.Data;
  } };
}
