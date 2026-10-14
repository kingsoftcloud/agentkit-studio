/** Host-owned adapters for resources bound to a local Agent revision. */
import { createHash, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { materializeCloudSkill, runtimeSkill } from './skill-files.mjs';

export class LocalResourceError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'LocalResourceError'; this.code = code; this.details = details; }
}

function resourceId(value) { return String(value?.resourceId || value?.id || value || '').trim(); }

/** AICP bounds AgentUserId and SessionId to 64 characters. */
function memorySubjectId(collectionId, userId, agentId = '') {
  const encoded = JSON.stringify([
    'memory-partition/v1',
    String(collectionId || ''),
    String(agentId || ''),
    String(userId || 'studio-anonymous').trim() || 'studio-anonymous',
  ]);
  return `mp1-${createHash('sha256').update(encoded).digest('hex').slice(0, 60)}`;
}

function memorySessionId(sessionId) {
  const raw = String(sessionId || '').trim();
  return raw ? createHash('sha256').update(`memory-session/v1|${raw}`).digest('hex') : '';
}
function contentHash(value, skillId) {
  const raw = String(value || '').trim().toLowerCase().replace(/^sha256:/, '');
  if (!raw) return '';
  if (!/^[0-9a-f]{64}$/.test(raw)) throw new LocalResourceError('SKILL_ARCHIVE_HASH_INVALID', '云端 Skill 的 ContentHash 不是有效的 sha256 摘要', { resourceId: skillId });
  return raw;
}
function looksLikeCloudSkillSpace(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(resourceId(value));
}

function skillServiceStatus(error) {
  const direct = Number(error?.status || error?.statusCode || error?.cause?.status || error?.cause?.statusCode || 0);
  if (direct) return direct;
  return Number(String(error?.message || error?.cause?.message || '').match(/\b(401|403|404|408|429|5\d{2})\b/)?.[1] || 0);
}

async function resolveCredential(credentials, reference, env = process.env) {
  const value = String(reference || '').trim();
  if (!value) return '';
  const name = value.startsWith('env://') ? value.slice('env://'.length) : value;
  if (credentials && typeof credentials.resolve === 'function') {
    const resolved = await credentials.resolve(name).catch(() => null);
    if (resolved?.value) return String(resolved.value);
  }
  return String(env[name] || '');
}

/** Shared Node-only auth materialization for local calls and frozen deployments. */
export async function resolveMcpConnection(detail, credentials, env = process.env) {
  const { resourceId, endpoint, envRefs = {}, credentialRef, apiKey: inlineApiKey } = detail;
  const headers = { ...detail.headers };
  for (const [header, reference] of Object.entries(envRefs)) {
    const resolved = await resolveCredential(credentials, reference, env);
    const existing = Object.keys(headers).find(name => name.toLowerCase() === String(header).toLowerCase());
    if (!resolved && !String(existing ? headers[existing] : '').trim()) throw new LocalResourceError('MCP_CREDENTIAL_MISSING', `MCP 缺少 ${header} 凭证，请在 Host 设置中配置后重新探测`, { resourceId, header: String(header), reference: String(reference) });
    if (resolved && !existing) headers[header] = String(header).toLowerCase() === 'authorization' && !/^\s*\w+\s+/i.test(resolved) ? `Bearer ${resolved}` : resolved;
  }
  const apiKey = inlineApiKey || await resolveCredential(credentials, credentialRef, env);
  if (credentialRef && !apiKey && !Object.keys(headers).some(name => name.toLowerCase() === 'authorization' && String(headers[name] || '').trim())) throw new LocalResourceError('MCP_CREDENTIAL_MISSING', 'MCP 缺少访问凭证，请在 Host 设置中配置后重新探测', { resourceId, reference: String(credentialRef) });
  if (apiKey && !Object.keys(headers).some(name => name.toLowerCase() === 'authorization')) headers.Authorization = `Bearer ${apiKey}`;
  return { resourceId, endpoint, headers };
}

function numericStatus(value) {
  const number = Number(String(value ?? '').match(/\b(401|403|404|408|429|5\d{2})\b/)?.[1] || 0);
  return number || 0;
}

function mcpStatus(error) {
  return numericStatus(error?.status) || numericStatus(error?.statusCode)
    || numericStatus(error?.cause?.status) || numericStatus(error?.cause?.statusCode)
    || numericStatus(error?.code) || numericStatus(error?.cause?.code)
    || numericStatus(error?.message) || numericStatus(error?.cause?.message);
}

function mcpFailure(error, resourceId, phase = 'connect', toolName = '') {
  if (error instanceof LocalResourceError && !['MCP_CONNECT_FAILED', 'MCP_TOOL_DISCOVERY_FAILED'].includes(error.code)) return error;
  const status = mcpStatus(error);
  const tlsFailure = !status && /(?:CERT_|ERR_TLS_|self.signed certificate|certificate (?:has expired|chain|verify)|unable to verify.*certificate)/i.test(String(error?.cause?.code || error?.cause?.message || error?.message || ''));
  const code = status === 401 ? 'MCP_AUTH_FAILED'
    : status === 403 ? 'MCP_PERMISSION_DENIED'
      : status === 404 ? 'MCP_ENDPOINT_NOT_FOUND'
        : tlsFailure ? 'MCP_TLS_FAILED' : phase === 'list' ? 'MCP_TOOL_DISCOVERY_FAILED'
          : phase === 'call' ? 'MCP_TOOL_FAILED' : 'MCP_CONNECT_FAILED';
  const message = status === 401
    ? 'MCP Endpoint 鉴权失败（HTTP 401），请更新凭证后重新探测'
    : status === 403
      ? 'MCP Endpoint 拒绝访问（HTTP 403），请检查凭证权限后重新探测'
      : status === 404
        ? 'MCP Endpoint 不存在（HTTP 404），请检查地址后重新探测'
        : tlsFailure ? 'MCP TLS 证书验证失败，请检查服务证书或配置可信 CA 后重新探测'
          : phase === 'list'
          ? 'MCP 工具目录读取失败，请检查 Endpoint 和网络配置'
          : phase === 'call'
            ? 'MCP 工具调用失败，请检查工具参数或服务状态'
            : 'MCP Endpoint 连接失败，请检查 Endpoint TLS、网络和认证配置';
  const cause = String(error?.cause?.message || error?.cause?.code || error?.message || error || '').slice(0, 240);
  return new LocalResourceError(code, message, {
    resourceId,
    ...(phase === 'call' && toolName ? { name: String(toolName) } : {}),
    ...(status ? { status } : {}),
    ...(cause ? { cause } : {}),
  });
}

export function createLocalResourceAdapters({ serverClient, skillDiscovery, credentials, resourceStore, fetchImpl = fetch, cacheDir = join(process.env.AGENTKIT_HOME || join(homedir(), '.agentkit'), 'studio', 'cloud-skills') } = {}) {
  const mcpClients = new Map();
  const connectingClients = new Set();
  const cloudSkillSpaces = new Map();
  let closed = false;
  const assertOpen = () => { if (closed) throw new LocalResourceError('RESOURCE_ADAPTER_CLOSED', '资源适配器已关闭'); };

  async function describeMcp(binding) {
    const key = resourceId(binding);
    if (!key) throw new LocalResourceError('MCP_ID_MISSING', 'MCP 资源 ID 不能为空');
    const config = binding && typeof binding === 'object' ? binding : {};
    const detail = config.endpoint || config.endpointUrl || config.url
      ? config
      : (await resourceStore?.get(key)) || (await serverClient.action('GetMCP', { Id: key })).data || {};
    const server = detail.server && typeof detail.server === 'object' ? detail.server : {};
    const endpoint = detail.mcp_endpoint || detail.private_mcp_endpoint || detail.endpointUrl || detail.url || server.endpointUrl || detail.endpoint;
    if (!endpoint || !/^https?:\/\//i.test(endpoint)) throw new LocalResourceError('MCP_ENDPOINT_UNAVAILABLE', 'MCP 没有可用的 HTTP Endpoint', { resourceId: key });
    return { resourceId: key, endpoint, headers: { ...(detail.headers || config.headers || {}) },
      envRefs: { ...(server.envRefs || detail.envRefs || config.envRefs || {}) },
      credentialRef: detail.credentialRef || config.credentialRef, apiKey: detail.api_key || detail.apiKey };
  }

  async function mcp(binding) {
    assertOpen();
    const { resourceId: key, endpoint, headers } = await resolveMcpConnection(await describeMcp(binding), credentials);
    assertOpen();
    // DSH credentials are mutable. Re-resolve them on every operation and
    // replace a cached client when the effective auth material changes. The
    // fingerprint is one-way and never leaves this process.
    const fingerprint = createHash('sha256').update(JSON.stringify({ endpoint, headers: Object.entries(headers).sort(([a], [b]) => a.localeCompare(b)) })).digest('hex');
    const cached = mcpClients.get(key);
    if (cached?.fingerprint === fingerprint) return cached;
    if (cached) {
      await Promise.resolve(cached.client.close?.()).catch(() => {});
      mcpClients.delete(key);
    }
    const client = new Client({ name: 'agentkit-studio-local-runtime', version: '0.0.1' });
    connectingClients.add(client);
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: { headers }, fetch: fetchImpl });
    try {
      await client.connect(transport);
      assertOpen();
    } catch (error) {
      await Promise.resolve(client.close()).catch(() => {});
      await Promise.resolve(transport.close?.()).catch(() => {});
      throw mcpFailure(error, key);
    } finally { connectingClients.delete(client); }
    const entry = { client, transport, fingerprint };
    const displaced = mcpClients.get(key);
    if (displaced && displaced !== entry) await displaced.client.close().catch(() => {});
    if (closed) { await client.close().catch(() => {}); assertOpen(); }
    mcpClients.set(key, entry);
    return entry;
  }

  async function listMcpTools(id) {
    const key = resourceId(id);
    const entry = await mcp(id);
    try { return (await entry.client.listTools()).tools || []; }
    catch (error) {
      await Promise.resolve(entry.client.close?.()).catch(() => {});
      if (mcpClients.get(key) === entry) mcpClients.delete(key);
      throw mcpFailure(error, key, 'list');
    }
  }

  async function callMcpTool(id, name, args = {}, { signal } = {}) {
    signal?.throwIfAborted();
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(String(name || ''))) throw new LocalResourceError('MCP_TOOL_NAME_INVALID', 'MCP 工具名无效');
    const key = resourceId(id);
    const entry = await mcp(id);
    let result;
    try { result = await entry.client.callTool({ name: String(name), arguments: args }, undefined, { signal }); }
    catch (error) {
      await Promise.resolve(entry.client.close?.()).catch(() => {});
      if (mcpClients.get(key) === entry) mcpClients.delete(key);
      throw mcpFailure(error, key, 'call', name);
    }
    if (result?.isError) throw new LocalResourceError('MCP_TOOL_FAILED', 'MCP 工具执行失败', { resourceId: key, name });
    return result?.content || result;
  }

  async function loadCloudSkillSpace(id) {
    const key = resourceId(id);
    if (cloudSkillSpaces.has(key)) return cloudSkillSpaces.get(key);
    if (!serverClient?.skillAction) throw new LocalResourceError('SKILL_SERVICE_UNAVAILABLE', '云端 Skill Service 适配器未启用', { resourceId: key });
    let listed;
    try {
      listed = await serverClient.skillAction('ListSkillsBySpaceId', { SpaceId: key, PageNumber: 1, PageSize: 100 });
    } catch (error) {
      const status = skillServiceStatus(error);
      if (status === 404) {
        throw new LocalResourceError(
          'SKILL_SPACE_NOT_FOUND',
          '绑定的 Skill Center 已不存在或当前云端凭证无权访问，请在 Agent 编辑页重新选择 Skill Center。',
          { resourceId: key, status },
        );
      }
      throw error;
    }
    const raw = listed.data?.Skills || listed.data?.skills || listed.data?.Items || listed.data?.items || [];
    const manifests = [];
    for (const item of raw) {
      const skillId = String(item.SkillId || item.skill_id || item.Id || item.id || '').trim();
      const versionId = String(item.VersionId || item.version_id || '').trim();
      if (!skillId) continue;
      const expectedHash = contentHash(item.ContentHash || item.contentHash || item.content_hash || item.Hash || item.hash, skillId);
      const download = await serverClient.skillAction(versionId ? 'GetSkillDownloadUrl' : 'GetPremadeSkillDownloadUrl', { SkillId: skillId, ...(versionId ? { VersionId: versionId } : {}) });
      const url = String(download.data?.DownloadUrl || download.data?.download_url || '').trim();
      if (!/^https:\/\//i.test(url)) throw new LocalResourceError('SKILL_DOWNLOAD_URL_INVALID', '云端 Skill 下载地址无效', { resourceId: skillId });
      const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new LocalResourceError('SKILL_DOWNLOAD_FAILED', `云端 Skill 下载失败（${response.status}）`, { resourceId: skillId });
      const length = Number(response.headers.get('content-length') || 0);
      if (length > 20 * 1024 * 1024) throw new LocalResourceError('SKILL_ARCHIVE_INVALID', '云端 Skill 压缩包超过大小限制', { resourceId: skillId });
      const archive = Buffer.from(await response.arrayBuffer());
      if (archive.length > 20 * 1024 * 1024) throw new LocalResourceError('SKILL_ARCHIVE_INVALID', '云端 Skill 压缩包超过大小限制', { resourceId: skillId });
      if (expectedHash) {
        const actualHash = createHash('sha256').update(archive).digest('hex');
        if (actualHash !== expectedHash) throw new LocalResourceError('SKILL_ARCHIVE_HASH_MISMATCH', '云端 Skill 压缩包完整性校验失败', { resourceId: skillId, expected: expectedHash, actual: actualHash });
      }
      try { manifests.push(...await materializeCloudSkill(archive, cacheDir, String(item.Name || item.name || skillId))); }
      catch (error) { throw new LocalResourceError(error.code || 'SKILL_ARCHIVE_INVALID', '云端 Skill 文件无法完整加载：' + error.message, { resourceId: skillId }); }
    }
    const result = { name: key, content: manifests.map(item => `Skill ${item.name}:\n${item.content}`).join('\n\n'), ...(manifests.length ? { definitions: manifests } : {}) };
    cloudSkillSpaces.set(key, result);
    return result;
  }

  async function loadSkill(id) {
    const key = resourceId(id);
    if (skillDiscovery) {
      const installed = await skillDiscovery.listInstalled();
      const local = installed.items?.find(item => item.resourceId === key);
      if (local) {
        const value = await skillDiscovery.previewInstalled(key);
        const manifest = value.files?.find(file => file.path === 'SKILL.md');
        if (!manifest) throw new LocalResourceError('SKILL_MANIFEST_MISSING', 'Skill 缺少 SKILL.md', { resourceId: key });
        const content = (await skillDiscovery.previewInstalled(key, 'SKILL.md')).content || '';
        return { name: key, content, ...(skillDiscovery.store ? { definitions: [runtimeSkill({ name: local.name, content, path: join(skillDiscovery.store, local.name, 'SKILL.md') })] } : {}) };
      }
    }
    if (!looksLikeCloudSkillSpace(key)) {
      throw new LocalResourceError('SKILL_NOT_INSTALLED', `绑定的 Skill（${key}）不在本地导入目录中；请在 Agent 编辑页重新选择 Skill。`, { resourceId: key });
    }
    return loadCloudSkillSpace(key);
  }

  async function searchKnowledge(id, query) {
    const datasetId = resourceId(id);
    // RetrieveKnowledge rejects queries longer than 250 characters. DSH can
    // include pasted context or slash-command text in the final user turn;
    // keep the lookup within the cloud contract while preserving the leading
    // intent that normally carries the search terms.
    const searchQuery = String(query || '').trim().slice(0, 250);
    try {
      const result = await serverClient.action('RetrieveKnowledge', {
        DatasetId: datasetId, Query: searchQuery,
        RetrievalModel: { SearchMethod: 'semantic', TopK: 5, RerankingEnable: true },
      }, { apiVersion: '2025-11-14' });
      return result.data?.Records || result.data?.records || [];
    } catch (error) {
      console.warn('[agentkit-studio] cloud knowledge lookup failed', JSON.stringify({
        resourceId: datasetId, code: error?.code || '', status: error?.status || 0,
      }));
      throw error;
    }
  }

  async function searchMemory(id, query, userId, { agentId = '' } = {}) {
    if (!serverClient?.action) throw new LocalResourceError('MEMORY_SERVICE_UNAVAILABLE', '云端记忆库适配器未启用', { resourceId: resourceId(id) });
    const collectionId = resourceId(id);
    const subjectId = memorySubjectId(collectionId, userId, agentId);
    const result = await serverClient.action('QueryMemorySdk', {
      MemoryCollectionId: collectionId, AgentUserId: subjectId,
      Query: String(query || ''), Limit: 5, SceneId: '_sys_general',
    }, { apiVersion: '2025-11-14' });
    const rawData = result.data;
    let data = rawData;
    if (typeof rawData === 'string') {
      try { data = JSON.parse(rawData); } catch { data = null; }
    }
    const items = Array.isArray(data) ? data : Array.isArray(data?.Data) ? data.Data : [];
    const memories = items.length
      ? items.flatMap(item => Array.isArray(item?.Memories || item?.memories) ? (item.Memories || item.memories) : [item])
      : data?.Memories || data?.memories || data?.Records || data?.records || [];
    return memories;
  }

  async function writeMemory(id, userId, messages, { sessionId = '', agentId = '', flush = false } = {}) {
    if (!serverClient?.action) throw new LocalResourceError('MEMORY_SERVICE_UNAVAILABLE', '云端记忆库适配器未启用', { resourceId: resourceId(id) });
    const collectionId = resourceId(id);
    const conversation = (Array.isArray(messages) ? messages : [])
      .filter(message => ['user', 'assistant'].includes(message?.role) && String(message?.content || '').trim())
      .slice(-20)
      .map(message => ({
        Role: message.role,
        CreatedAt: Date.now(),
        MessageId: randomUUID(),
        Content: [{ Type: 'input_text', Text: String(message.content).slice(0, 16000) }],
      }));
    if (!conversation.length) return { accepted: false, reason: 'empty' };
    const payload = {
      MemoryCollectionId: collectionId,
      AgentUserId: memorySubjectId(collectionId, userId, agentId),
      SceneId: '_sys_general',
      DataType: 'conversation',
      Data: { Conversation: conversation },
      ...(agentId ? { AgentId: String(agentId) } : {}),
      ...(memorySessionId(sessionId) ? { SessionId: memorySessionId(sessionId) } : {}),
      ...(flush === true ? { Flush: true } : {}),
    };
    const result = await serverClient.action('CreateMemorySdk', payload, { apiVersion: '2025-11-14' });
    return { accepted: true, data: result.data || {} };
  }

  async function close() {
    closed = true;
    const clients = new Set([...connectingClients, ...[...mcpClients.values()].map(entry => entry.client)]);
    await Promise.allSettled([...clients].map(client => client.close()));
    connectingClients.clear();
    mcpClients.clear();
    cloudSkillSpaces.clear();
  }

  // Host-only descriptor; it can contain credentials. Never expose it through RPC.
  return { describeMcp, listMcpTools, callMcpTool, loadSkill, searchKnowledge, searchMemory, writeMemory, close };
}
