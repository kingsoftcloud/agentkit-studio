/** Channel connector for the Studio plugin Node host.
 *
 * Port of the legacy Studio channel surface: configuration store, proxy
 * forwarding to an external channel gateway, and an outbound WebSocket
 * connector for native Agent execution. The gateway URL, account, and
 * workspace come from user configuration stored locally; KOP credentials
 * are not used for the channel service API.
 */
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createChannelConnector, connectorUrl } from './channel-connector.mjs';
import { scheduleDeliveryTargets } from './cloud-schedule-targets.mjs';

export class ChannelError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ChannelError';
    this.code = code;
    this.details = details;
  }
}

export function createStudioChannels({ storeDir, getAgent, listAgents, listCloudAgents, resolveCloudAgent, runner, connectorFactory = createChannelConnector } = {}) {
  const configPath = join(storeDir, 'channels.json');
  const connectors = new Map(), connectionKeys = new Map();
  let mutation = Promise.resolve(), disposed = false;
  const serialize = work => { const result = mutation.catch(() => {}).then(work); mutation = result; return result; };
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

  async function ensureDir() { await mkdir(dirname(configPath), { recursive: true, mode: 0o700 }); }

  async function readConfig() {
    try { return JSON.parse(await readFile(configPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw new ChannelError('CHANNEL_CONFIG_INVALID', '渠道配置无法读取'); return { serverUrl: '', accountId: '', workspaceId: '', apiToken: '', enabled: false }; }
  }

  async function writeConfig(config) {
    await ensureDir();
    const record = { ...config, updatedAt: new Date().toISOString() };
    const temporary = `${configPath}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(record, null, 2), { mode: 0o600 }); await rename(temporary, configPath); }
    finally { await rm(temporary, { force: true }); }
    return redact(record);
  }

  function redact(config) {
    const { apiToken, agentConnections = {}, ...safe } = config;
    return { ...safe, configured: Boolean(config.serverUrl && config.accountId), tokenConfigured: Boolean(apiToken), agentConnections: Object.entries(agentConnections).map(([agentId, entry]) => ({ agentId, enabled: Boolean(entry.enabled), tokenConfigured: Boolean(entry.token), ...(connectors.get(agentId)?.status || { state: entry.enabled ? 'unavailable' : 'stopped', connected: false, activeTasks: 0, lastError: null }) })) };
  }

  async function getConnection() {
    const config = await readConfig();
    const localAgents = listAgents ? (await listAgents()).map(agent => ({ id: agent.metadata.id, name: agent.metadata.name || agent.metadata.id })) : [];
    let cloudAgents = [], cloudError = '';
    try {
      cloudAgents = listCloudAgents ? (await listCloudAgents()).map(agent => ({ id: agent.metadata.id, name: agent.metadata.name, state: agent.deployment?.state })) : [];
    } catch { cloudError = '云端部署目录读取失败，请检查云端配置后刷新'; }
    return { ...redact(config), localAgents, cloudAgents, cloudError };
  }

  const updateConnection = patch => serialize(async () => {
    const current = await readConfig();
    const next = {
      serverUrl: String(patch.serverUrl !== undefined ? patch.serverUrl : (current.serverUrl || '')).trim(),
      accountId: String(patch.accountId !== undefined ? patch.accountId : (current.accountId || '')).trim(),
      workspaceId: String(patch.workspaceId !== undefined ? patch.workspaceId : (current.workspaceId || '')).trim(),
      apiToken: String(patch.apiToken || current.apiToken || '').trim(),
      enabled: patch.enabled !== undefined ? Boolean(patch.enabled) : current.enabled,
      agentConnections: current.agentConnections || {},
    };
    if (next.serverUrl) {
      try {
        const url = new URL(next.serverUrl);
        if (!['http:', 'https:'].includes(url.protocol)) throw new ChannelError('CHANNEL_URL_INVALID', '渠道地址必须是 http(s)');
      } catch { throw new ChannelError('CHANNEL_URL_INVALID', '渠道地址无效'); }
    }
    if (['serverUrl', 'accountId', 'workspaceId'].some(key => (current[key] || '') !== next[key])) next.agentConnections = {};
    if (current.serverUrl !== next.serverUrl && !patch.apiToken) next.apiToken = '';
    await writeConfig(next); await reconcile(next); return getConnection();
  });

  async function reconcile(config) {
    if (disposed || !runner) return;
    for (const [agentId, connector] of connectors) {
      const entry = config.agentConnections?.[agentId];
      const key = digest([config.serverUrl, config.accountId, config.workspaceId, agentId, entry?.token]);
      if (!entry?.enabled || connectionKeys.get(agentId) !== key) { connector.stop(); connectors.delete(agentId); connectionKeys.delete(agentId); }
    }
    for (const [agentId, entry] of Object.entries(config.agentConnections || {})) {
      if (!entry.enabled) continue;
      if (connectors.has(agentId)) continue;
      try {
        if (!await getAgent?.(agentId)) continue;
        const identity = [config.serverUrl, config.accountId, config.workspaceId, agentId];
        const connector = connectorFactory({ url: config.serverUrl, token: entry.token, tenantId: config.accountId, workspaceId: config.workspaceId, agentId,
          invoke: async request => {
            const namespace = [...identity, request.channel || '', request.session_id];
            const result = await runner({ agentId, sessionId: `channel-${digest(namespace)}`, occurrenceId: `channel-request-${digest([...namespace, request.idempotency_key || request.task_id])}`, input: request.message, signal: request.signal });
            return result.output;
          },
        });
        if (disposed) { connector.stop(); return; }
        connectors.set(agentId, connector); connectionKeys.set(agentId, digest([...identity, entry.token])); connector.start();
      } catch { connectors.set(agentId, { status: { state: 'error', connected: false, activeTasks: 0, lastError: 'configuration_invalid' }, stop() {} }); }
    }
  }

  const updateAgentConnection = (agentId, patch = {}) => serialize(async () => {
    const config = await readConfig();
    const entries = { ...config.agentConnections };
    const current = entries[agentId] || {};
    const next = { enabled: Boolean(patch.enabled), token: String(patch.token || current.token || '').trim() };
    if (next.enabled) {
      if (!runner || !await getAgent?.(agentId)) throw new ChannelError('CHANNEL_AGENT_UNAVAILABLE', '请选择已创建的本地 Agent');
      if (!config.accountId || !config.workspaceId || !next.token) throw new ChannelError('CHANNEL_CONNECTOR_CONFIG_REQUIRED', '本地 Agent 连接需要账号、工作区 ID 和该 Agent 的连接凭证');
      connectorUrl(config.serverUrl);
    }
    entries[agentId] = next;
    const updated = { ...config, agentConnections: entries };
    await writeConfig(updated);
    connectors.get(agentId)?.stop(); connectors.delete(agentId); connectionKeys.delete(agentId);
    await reconcile(updated); return getConnection();
  });

  async function proxyAction(action, payload = {}) {
    const config = await readConfig();
    let cloudActor;
    if (!config.serverUrl || !config.accountId) throw new ChannelError('CHANNEL_NOT_CONFIGURED', '请先配置渠道连接（serverUrl 和 accountId）');
    const requireCloudActor = async agentId => {
      if (!resolveCloudAgent) throw new ChannelError('CHANNEL_AGENT_UNAVAILABLE', '请选择 Studio 创建的本地 Agent 或其云端部署');
      const target = await resolveCloudAgent(agentId);
      if (!target?.accountId || target.accountId !== config.accountId) throw new ChannelError('CHANNEL_ACCOUNT_MISMATCH', '渠道账号与当前子账号所属的云端账号不一致，请核对连接配置');
      if (!target.userUuid) throw new ChannelError('CHANNEL_ACTOR_REQUIRED', '云端渠道操作需要已核验的子账号身份');
      return target.userUuid;
    };
    if (['ApprovePairing', 'RejectPairing'].includes(action)) {
      // Resolve the stored request, not an Agent ID or actor supplied by the page.
      let pairing;
      for (let offset = 0; offset < 1000; offset += 100) {
        const { Data } = await proxyAction('ListPairingRequests', { Offset: offset, Limit: 100 });
        if (!Array.isArray(Data?.Items)) throw new ChannelError('CHANNEL_RESPONSE_INVALID', '配对请求目录格式不兼容');
        pairing = Data.Items.find(item => item.Id === payload.Id);
        if (pairing || Data.Items.length < 100 || offset + Data.Items.length >= Data.Total) break;
      }
      if (!pairing?.AgentId) throw new ChannelError('CHANNEL_PAIRING_UNAVAILABLE', '配对请求不存在或不可访问，请刷新后重试');
      if (!await getAgent?.(pairing.AgentId)) cloudActor = await requireCloudActor(pairing.AgentId);
      payload = { Id: pairing.Id };
    }
    if (['CreateChannel', 'UpdateChannel'].includes(action) && payload.AgentId) {
      if (await getAgent?.(payload.AgentId)) {
        if (!config.agentConnections?.[payload.AgentId]?.enabled || !config.workspaceId) throw new ChannelError('CHANNEL_LOCAL_OFFLINE', '请先启用这个本地 Agent 的渠道连接');
        payload = { ...payload, ConnectorWorkspaceId: config.workspaceId };
      } else {
        cloudActor = await requireCloudActor(payload.AgentId);
        // Explicitly clear a previous local connector when changing targets.
        // The Channel Worker invokes Server RunAgent even when Studio is closed.
        payload = { ...payload, ConnectorWorkspaceId: '' };
      }
    }
    const url = new URL(`/agentengine/api/v1/${encodeURIComponent(action)}`, config.serverUrl.replace(/\/$/, ''));
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Ksc-Account-Id': config.accountId };
    if (cloudActor) headers['X-Ksc-User-uuid'] = cloudActor;
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

  async function deliveryTargets(agentId) {
    const config = await readConfig();
    const target = await resolveCloudAgent?.(agentId);
    if (!target?.accountId || target.accountId !== config.accountId) throw new ChannelError('CHANNEL_ACCOUNT_MISMATCH', '渠道连接与所选云端 Agent 的账号不一致');
    const list = async action => {
      const items = [];
      for (let offset = 0; offset < 1000; offset += 100) {
        const { Data } = await proxyAction(action, { AgentId: agentId, Offset: offset, Limit: 100 });
        if (!Array.isArray(Data?.Items)) throw new ChannelError('CHANNEL_RESPONSE_INVALID', '渠道会话目录格式不兼容');
        items.push(...Data.Items);
        if (Data.Items.length < 100 || items.length >= Data.Total) return items;
      }
      throw new ChannelError('CHANNEL_CATALOG_TOO_LARGE', '此 Agent 的渠道会话过多，请先整理会话绑定');
    };
    const [channels, bindings] = await Promise.all([list('ListChannels'), list('ListBindings')]);
    return { items: scheduleDeliveryTargets(agentId, channels, bindings) };
  }

  return { getConnection, updateConnection, updateAgentConnection, proxyAction, deliveryTargets,
    ensureReady: () => serialize(async () => { if (!disposed) await reconcile(await readConfig()); }),
    dispose() { disposed = true; for (const connector of connectors.values()) connector.stop(); connectors.clear(); connectionKeys.clear(); },
  };
}
