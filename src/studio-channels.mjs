/** Channel connector for the Studio plugin Node host.
 *
 * Port of the legacy Studio channel surface: configuration store, proxy
 * forwarding to an external channel gateway, and an optional WebSocket
 * connector stub for live message intake. The gateway URL, account, and
 * workspace come from user configuration stored locally; KOP credentials
 * are not used for the channel service API.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export class ChannelError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ChannelError';
    this.code = code;
    this.details = details;
  }
}

export function createStudioChannels({ storeDir } = {}) {
  const configPath = join(storeDir, 'channels.json');

  async function ensureDir() { await mkdir(dirname(configPath), { recursive: true, mode: 0o700 }); }

  async function readConfig() {
    try { return JSON.parse(await readFile(configPath, 'utf8')); } catch { return { serverUrl: '', accountId: '', workspaceId: '', apiToken: '', enabled: false }; }
  }

  async function writeConfig(config) {
    await ensureDir();
    const record = { ...config, updatedAt: new Date().toISOString() };
    await writeFile(configPath, JSON.stringify(record, null, 2));
    return redact(record);
  }

  function redact(config) {
    const { apiToken, ...safe } = config;
    return { ...safe, configured: Boolean(config.serverUrl && config.accountId), tokenConfigured: Boolean(apiToken) };
  }

  async function getConnection() {
    const config = await readConfig();
    return redact(config);
  }

  async function updateConnection(patch) {
    const current = await readConfig();
    const next = {
      serverUrl: String(patch.serverUrl !== undefined ? patch.serverUrl : (current.serverUrl || '')).trim(),
      accountId: String(patch.accountId !== undefined ? patch.accountId : (current.accountId || '')).trim(),
      workspaceId: String(patch.workspaceId !== undefined ? patch.workspaceId : (current.workspaceId || '')).trim(),
      apiToken: String(patch.apiToken || current.apiToken || '').trim(),
      enabled: patch.enabled !== undefined ? Boolean(patch.enabled) : current.enabled,
    };
    if (next.serverUrl) {
      try {
        const url = new URL(next.serverUrl);
        if (!['http:', 'https:'].includes(url.protocol)) throw new ChannelError('CHANNEL_URL_INVALID', '渠道地址必须是 http(s)');
      } catch { throw new ChannelError('CHANNEL_URL_INVALID', '渠道地址无效'); }
    }
    return writeConfig(next);
  }

  async function proxyAction(action, payload = {}) {
    const config = await readConfig();
    if (!config.serverUrl || !config.accountId) throw new ChannelError('CHANNEL_NOT_CONFIGURED', '请先配置渠道连接（serverUrl 和 accountId）');
    const url = new URL(`/agentengine/api/v1/${encodeURIComponent(action)}`, config.serverUrl.replace(/\/$/, ''));
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Ksc-Account-Id': config.accountId };
    if (config.workspaceId) headers['X-Ksc-Workspace-Id'] = config.workspaceId;
    if (config.apiToken) headers.Authorization = `Bearer ${config.apiToken}`;
    let response;
    try { response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(30000) }); }
    catch (error) { throw new ChannelError('CHANNEL_PROXY_FAILED', '渠道服务请求未完成', { action, cause: String(error?.cause?.code || error?.message || error).slice(0, 200) }); }
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); }
    catch { throw new ChannelError('CHANNEL_RESPONSE_INVALID', `渠道服务返回了无效响应（HTTP ${response.status}）`, { action, status: response.status }); }
    const failed = !response.ok || (body?.Code !== undefined && body.Code !== 0);
    if (failed) {
      // FastAPI validation errors include input values: expose field names only,
      // never the echoed AppSecret, credentials, or an untrusted response body.
      const missing = Array.isArray(body?.detail) ? body.detail.map(item => item?.loc?.filter(part => part !== 'body').join('.')).filter(Boolean) : [];
      const message = missing.length ? `渠道参数校验失败：${missing.join('、')}` : String(body?.Message || body?.message || `渠道服务返回 ${response.status}`);
      throw new ChannelError('CHANNEL_PROXY_ERROR', message, { action, status: response.status, ...(body?.Code !== undefined ? { serviceCode: body.Code } : {}) });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body) || body.Code !== 0 || !Object.hasOwn(body, 'Data')) {
      throw new ChannelError('CHANNEL_RESPONSE_INVALID', '渠道服务返回了不符合合同的响应', { action, status: response.status });
    }
    return body;
  }

  return { getConnection, updateConnection, proxyAction };
}
