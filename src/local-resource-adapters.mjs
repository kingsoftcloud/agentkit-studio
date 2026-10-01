/** Host-owned adapters for resources bound to a local Agent revision. */
import { createHash, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { inflateRawSync } from 'node:zlib';

export class LocalResourceError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'LocalResourceError'; this.code = code; this.details = details; }
}

function resourceId(value) { return String(value?.resourceId || value?.id || value || '').trim(); }
function contentHash(value, skillId) {
  const raw = String(value || '').trim().toLowerCase().replace(/^sha256:/, '');
  if (!raw) return '';
  if (!/^[0-9a-f]{64}$/.test(raw)) throw new LocalResourceError('SKILL_ARCHIVE_HASH_INVALID', '云端 Skill 的 ContentHash 不是有效的 sha256 摘要', { resourceId: skillId });
  return raw;
}
function looksLikeCloudSkillSpace(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(resourceId(value));
}

async function resolveCredential(credentials, reference) {
  const value = String(reference || '').trim();
  if (!value) return '';
  const name = value.startsWith('env://') ? value.slice('env://'.length) : value;
  if (credentials && typeof credentials.resolve === 'function') {
    const resolved = await credentials.resolve(name).catch(() => null);
    if (resolved?.value) return String(resolved.value);
  }
  return String(process.env[name] || '');
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

function mcpFailure(error, resourceId, phase = 'connect') {
  if (error instanceof LocalResourceError && !['MCP_CONNECT_FAILED', 'MCP_TOOL_DISCOVERY_FAILED'].includes(error.code)) return error;
  const status = mcpStatus(error);
  const code = status === 401 ? 'MCP_AUTH_FAILED'
    : status === 403 ? 'MCP_PERMISSION_DENIED'
      : status === 404 ? 'MCP_ENDPOINT_NOT_FOUND'
        : phase === 'list' ? 'MCP_TOOL_DISCOVERY_FAILED' : 'MCP_CONNECT_FAILED';
  const message = status === 401
    ? 'MCP Endpoint 鉴权失败（HTTP 401），请更新凭证后重新探测'
    : status === 403
      ? 'MCP Endpoint 拒绝访问（HTTP 403），请检查凭证权限后重新探测'
      : status === 404
        ? 'MCP Endpoint 不存在（HTTP 404），请检查地址后重新探测'
        : phase === 'list'
          ? 'MCP 工具目录读取失败，请检查 Endpoint 和网络配置'
          : 'MCP Endpoint 连接失败，请检查 Endpoint TLS、网络和认证配置';
  const cause = String(error?.cause?.message || error?.cause?.code || error?.message || error || '').slice(0, 240);
  return new LocalResourceError(code, message, { resourceId, ...(status ? { status } : {}), ...(cause ? { cause } : {}) });
}

export function createLocalResourceAdapters({ serverClient, skillDiscovery, credentials, resourceStore, fetchImpl = fetch } = {}) {
  const mcpClients = new Map();
  const cloudSkillSpaces = new Map();

  async function mcp(binding) {
    const key = resourceId(binding);
    if (!key) throw new LocalResourceError('MCP_ID_MISSING', 'MCP 资源 ID 不能为空');
    const config = binding && typeof binding === 'object' ? binding : {};
    const detail = config.endpoint || config.endpointUrl || config.url
      ? config
      : (await resourceStore?.get(key)) || (await serverClient.action('GetMCP', { Id: key })).data || {};
    const server = detail.server && typeof detail.server === 'object' ? detail.server : {};
    const endpoint = detail.endpoint || detail.endpointUrl || detail.url || detail.mcp_endpoint || detail.private_mcp_endpoint || server.endpointUrl;
    if (!endpoint || !/^https?:\/\//i.test(endpoint)) throw new LocalResourceError('MCP_ENDPOINT_UNAVAILABLE', 'MCP 没有可用的 HTTP Endpoint', { resourceId: key });
    const headers = { ...(detail.headers || config.headers || {}) };
    const envRefs = { ...(server.envRefs || detail.envRefs || config.envRefs || {}) };
    for (const [header, reference] of Object.entries(envRefs)) {
      const resolved = await resolveCredential(credentials, reference);
      const existing = Object.keys(headers).find(name => name.toLowerCase() === String(header).toLowerCase());
      if (!resolved && !String(existing ? headers[existing] : '').trim()) {
        throw new LocalResourceError('MCP_CREDENTIAL_MISSING', `MCP 缺少 ${header} 凭证，请在 Host 设置中配置后重新探测`, { resourceId: key, header: String(header), reference: String(reference) });
      }
      if (resolved && !existing) headers[header] = String(header).toLowerCase() === 'authorization' && !/^\s*\w+\s+/i.test(resolved) ? `Bearer ${resolved}` : resolved;
    }
    const credentialRef = detail.credentialRef || config.credentialRef;
    const apiKey = detail.api_key || detail.apiKey || await resolveCredential(credentials, credentialRef);
    if (credentialRef && !apiKey && !Object.keys(headers).some(name => name.toLowerCase() === 'authorization' && String(headers[name] || '').trim())) {
      throw new LocalResourceError('MCP_CREDENTIAL_MISSING', 'MCP 缺少访问凭证，请在 Host 设置中配置后重新探测', { resourceId: key, reference: String(credentialRef) });
    }
    if (apiKey && !Object.keys(headers).some(name => name.toLowerCase() === 'authorization')) headers.Authorization = `Bearer ${apiKey}`;
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
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: { headers }, fetch: fetchImpl });
    try {
      await client.connect(transport);
    } catch (error) {
      await Promise.resolve(transport.close?.()).catch(() => {});
      throw mcpFailure(error, key);
    }
    const entry = { client, transport, fingerprint };
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

  async function callMcpTool(id, name, args = {}) {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(String(name || ''))) throw new LocalResourceError('MCP_TOOL_NAME_INVALID', 'MCP 工具名无效');
    const key = resourceId(id);
    const entry = await mcp(id);
    let result;
    try { result = await entry.client.callTool({ name: String(name), arguments: args }); }
    catch (error) {
      await Promise.resolve(entry.client.close?.()).catch(() => {});
      if (mcpClients.get(key) === entry) mcpClients.delete(key);
      throw mcpFailure(error, key, 'call');
    }
    if (result?.isError) throw new LocalResourceError('MCP_TOOL_FAILED', 'MCP 工具执行失败', { resourceId: key, name });
    return result?.content || result;
  }

  function archiveSkillManifest(buffer, skillId) {
    if (!Buffer.isBuffer(buffer) || buffer.length > 20 * 1024 * 1024) throw new LocalResourceError('SKILL_ARCHIVE_INVALID', '云端 Skill 压缩包超过大小限制', { resourceId: skillId });
    const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (end < 0 || end + 22 > buffer.length) throw new LocalResourceError('SKILL_ARCHIVE_INVALID', '云端 Skill 压缩包格式无效', { resourceId: skillId });
    const count = buffer.readUInt16LE(end + 10);
    const centralOffset = buffer.readUInt32LE(end + 16);
    let cursor = centralOffset;
    for (let index = 0; index < count && cursor + 46 <= buffer.length; index += 1) {
      if (buffer.readUInt32LE(cursor) !== 0x02014b50) break;
      const compression = buffer.readUInt16LE(cursor + 10);
      const compressedSize = buffer.readUInt32LE(cursor + 20);
      const uncompressedSize = buffer.readUInt32LE(cursor + 24);
      const nameLength = buffer.readUInt16LE(cursor + 28);
      const extraLength = buffer.readUInt16LE(cursor + 30);
      const commentLength = buffer.readUInt16LE(cursor + 32);
      const localOffset = buffer.readUInt32LE(cursor + 42);
      const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
      cursor += 46 + nameLength + extraLength + commentLength;
      if (!/^(?:^|\/)SKILL\.md$/i.test(name) && !/\/SKILL\.md$/i.test(name)) continue;
      if (uncompressedSize > 1024 * 1024 || localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
        throw new LocalResourceError('SKILL_ARCHIVE_INVALID', '云端 Skill 的 SKILL.md 超过大小限制或压缩包损坏', { resourceId: skillId });
      }
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = buffer.subarray(start, start + compressedSize);
      let content;
      if (compression === 0) content = compressed;
      else if (compression === 8) content = inflateRawSync(compressed);
      else throw new LocalResourceError('SKILL_ARCHIVE_INVALID', '云端 Skill 使用了不支持的压缩算法', { resourceId: skillId });
      return content.toString('utf8');
    }
    throw new LocalResourceError('SKILL_MANIFEST_MISSING', '云端 Skill 缺少 SKILL.md', { resourceId: skillId });
  }

  async function loadCloudSkillSpace(id) {
    const key = resourceId(id);
    if (cloudSkillSpaces.has(key)) return cloudSkillSpaces.get(key);
    if (!serverClient?.skillAction) throw new LocalResourceError('SKILL_SERVICE_UNAVAILABLE', '云端 Skill Service 适配器未启用', { resourceId: key });
    const listed = await serverClient.skillAction('ListSkillsBySpaceId', { SpaceId: key, PageNumber: 1, PageSize: 100 });
    const raw = listed.data?.Skills || listed.data?.skills || listed.data?.Items || listed.data?.items || [];
    const manifests = [];
    for (const item of raw.slice(0, 20)) {
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
      const content = archiveSkillManifest(archive, skillId);
      manifests.push({ name: String(item.Name || item.name || skillId), content });
    }
    const result = manifests.length ? manifests.map(item => `Skill ${item.name}:\n${item.content}`).join('\n\n') : '';
    cloudSkillSpaces.set(key, result);
    return result;
  }

  async function loadSkill(id) {
    const key = resourceId(id);
    if (skillDiscovery) {
      const installed = await skillDiscovery.listInstalled();
      if (installed.items?.some(item => item.resourceId === key)) {
        const value = await skillDiscovery.previewInstalled(key);
        const manifest = value.files?.find(file => file.path === 'SKILL.md');
        if (!manifest) throw new LocalResourceError('SKILL_MANIFEST_MISSING', 'Skill 缺少 SKILL.md', { resourceId: key });
        const content = (await skillDiscovery.previewInstalled(key, 'SKILL.md')).content || '';
        return { name: key, content };
      }
    }
    if (!looksLikeCloudSkillSpace(key)) {
      throw new LocalResourceError('SKILL_NOT_INSTALLED', `绑定的 Skill（${key}）不在本地导入目录中；请在 Agent 编辑页重新选择 Skill。`, { resourceId: key });
    }
    const content = await loadCloudSkillSpace(key);
    return { name: key, content };
  }

  async function searchKnowledge(id, query) {
    const result = await serverClient.action('RetrieveKnowledge', {
      DatasetId: resourceId(id), Query: String(query || ''),
      RetrievalModel: { SearchMethod: 'semantic', TopK: 5, RerankingEnable: true },
    }, { apiVersion: '2025-11-14' });
    return result.data?.Records || result.data?.records || [];
  }

  async function searchMemory(id, query, userId) {
    if (!serverClient?.action) throw new LocalResourceError('MEMORY_SERVICE_UNAVAILABLE', '云端记忆库适配器未启用', { resourceId: resourceId(id) });
    const result = await serverClient.action('QueryMemorySdk', {
      MemoryCollectionId: resourceId(id), AgentUserId: String(userId || 'studio-anonymous'),
      Query: String(query || ''), Limit: 5, SceneId: '_sys_general',
    }, { apiVersion: '2025-11-14' });
    const data = result.data;
    if (Array.isArray(data)) return data.flatMap(item => Array.isArray(item?.Memories || item?.memories) ? (item.Memories || item.memories) : [item]);
    return data?.Memories || data?.memories || data?.Records || data?.records || [];
  }

  async function writeMemory(id, userId, messages, { sessionId = '', agentId = '', flush = false } = {}) {
    if (!serverClient?.action) throw new LocalResourceError('MEMORY_SERVICE_UNAVAILABLE', '云端记忆库适配器未启用', { resourceId: resourceId(id) });
    const conversation = (Array.isArray(messages) ? messages : [])
      .filter(message => ['user', 'assistant'].includes(message?.role) && String(message?.content || '').trim())
      .slice(-20)
      .map(message => ({
        Role: message.role,
        CreatedAt: Date.now(),
        MessageId: `${String(sessionId || 'studio')}-${randomUUID()}`,
        Content: [{ Type: 'input_text', Text: String(message.content).slice(0, 16000) }],
      }));
    if (!conversation.length) return { accepted: false, reason: 'empty' };
    const payload = {
      MemoryCollectionId: resourceId(id),
      AgentUserId: String(userId || 'studio-anonymous'),
      SceneId: '_sys_general',
      DataType: 'conversation',
      Data: { Conversation: conversation },
      ...(agentId ? { AgentId: String(agentId) } : {}),
      ...(sessionId ? { SessionId: String(sessionId) } : {}),
      ...(flush === true ? { Flush: true } : {}),
    };
    const result = await serverClient.action('CreateMemorySdk', payload, { apiVersion: '2025-11-14' });
    return { accepted: true, data: result.data || {} };
  }

  async function close() {
    for (const { client } of mcpClients.values()) await client.close().catch(() => {});
    mcpClients.clear();
  }

  return { listMcpTools, callMcpTool, loadSkill, searchKnowledge, searchMemory, writeMemory, close };
}
