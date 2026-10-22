import { hostFetch } from './http-fetch.mjs';
/** Host-owned adapters for resources bound to a local Agent revision. */
import { createHash, randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport, SSEClientTransport, StdioClientTransport, getDefaultEnvironment } from '../dist/native-mcp-client.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { materializeCloudSkill, runtimeSkill } from './skill-files.mjs';
import { fetchNativeSkillArchive } from './providers/native-skill-loader.mjs';
import { MCP_JSON_PARSER_CONTRACT, NATIVE_MCP_JSON_CODEC, nativeMcpJsonParser, nativeMcpSchemaValidator } from './providers/native-mcp-json.mjs';

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

function memoryReply(reply, requireReceipt = false) {
  let data = reply?.data;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { data = null; } }
  const code = data?.Code ?? data?.ResponseMetadata?.Error?.Code;
  const requestId = reply?.requestId || data?.RequestId || data?.ResponseMetadata?.RequestId;
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.Success === false || data.Error
    || data.ResponseMetadata?.Error || (code != null && ![0, 200, '0', '200'].includes(code))
    || (requireReceipt && !requestId)) {
    throw new LocalResourceError('MEMORY_RESPONSE_UNKNOWN', '记忆服务未确认结果，请刷新核对');
  }
  return { data, requestId };
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

export function createLocalResourceAdapters({ serverClient, skillDiscovery, credentials, resourceStore, fetchImpl = hostFetch, cacheDir = join(process.env.AGENTKIT_HOME || join(homedir(), '.agentkit'), 'studio', 'cloud-skills') } = {}) {
  const mcpClients = new Map();
  const connectingClients = new Set();
  const cloudSkillSpaces = new Map();
  let closed = false;
  const assertOpen = () => { if (closed) throw new LocalResourceError('RESOURCE_ADAPTER_CLOSED', '资源适配器已关闭'); };

  async function describeMcp(binding) {
    const key = resourceId(binding);
    if (!key) throw new LocalResourceError('MCP_ID_MISSING', 'MCP 资源 ID 不能为空');
    const config = binding && typeof binding === 'object' ? binding : {};
    const detail = config.endpoint || config.endpointUrl || config.url || config.server?.endpointUrl || config.server?.command
      ? config
      : (await resourceStore?.get(key)) || (await serverClient.action('GetMCP', { Id: key })).data || {};
    const server = detail.server && typeof detail.server === 'object' ? detail.server : {};
    const endpoint = detail.mcp_endpoint || detail.private_mcp_endpoint || detail.endpointUrl || detail.url || server.endpointUrl || detail.endpoint;
    const transport = server.transport || detail.transport || 'http';
    if (transport === 'stdio' && !server.command) throw new LocalResourceError('MCP_COMMAND_UNAVAILABLE', 'MCP 缺少启动命令', { resourceId: key });
    if (transport !== 'stdio' && (!endpoint || !/^https?:\/\//i.test(endpoint))) throw new LocalResourceError('MCP_ENDPOINT_UNAVAILABLE', 'MCP 没有可用的 HTTP Endpoint', { resourceId: key });
    return { resourceId: key, endpoint, transport, command: server.command, args: server.args || [], env: server.env || {}, headers: { ...(server.headers || detail.headers || config.headers || {}) },
      envRefs: { ...(server.envRefs || detail.envRefs || config.envRefs || {}) },
      credentialRef: detail.credentialRef || config.credentialRef, apiKey: detail.api_key || detail.apiKey };
  }

  async function mcp(binding, jsonCodec, cacheId) {
    assertOpen();
    if (jsonCodec !== undefined && jsonCodec !== NATIVE_MCP_JSON_CODEC) throw new LocalResourceError('MCP_JSON_CODEC_INVALID', 'MCP JSON 解析契约无效');
    const exact = jsonCodec === NATIVE_MCP_JSON_CODEC;
    const detail = await describeMcp(binding), stdio = detail.transport === 'stdio';
    const { resourceId: key, endpoint, headers } = stdio ? detail : await resolveMcpConnection(detail, credentials);
    const environment = { ...getDefaultEnvironment(), ...detail.env };
    if (stdio) for (const [name, reference] of Object.entries(detail.envRefs)) {
      const value = await resolveCredential(credentials, reference);
      if (!value) throw new LocalResourceError('MCP_CREDENTIAL_MISSING', `MCP 缺少 ${name} 凭证`, { resourceId: key, reference });
      environment[name] = value;
    }
    assertOpen();
    // DSH credentials are mutable. Re-resolve them on every operation and
    // replace a cached client when the effective auth material changes. The
    // fingerprint is one-way and never leaves this process.
    const fingerprint = createHash('sha256').update(JSON.stringify({ endpoint, transport: detail.transport, command: detail.command, args: detail.args, ...(stdio ? { environment } : { headers: Object.entries(headers).sort(([a], [b]) => a.localeCompare(b)) }) })).digest('hex');
    // Native and ordinary callers may use the same resource concurrently.
    // Keep their parser/schema contracts on separate connections.
    const cacheKey = cacheId ?? JSON.stringify([key, jsonCodec ?? null]);
    const cached = mcpClients.get(cacheKey);
    if (cached?.fingerprint === fingerprint) return cached;
    if (cached) {
      await Promise.resolve(cached.client.close?.()).catch(() => {});
      mcpClients.delete(cacheKey);
    }
    const Transport = stdio ? StdioClientTransport : detail.transport === 'sse' ? SSEClientTransport : StreamableHTTPClientTransport;
    if (exact && Transport.jsonParserContract !== MCP_JSON_PARSER_CONTRACT) throw new LocalResourceError('MCP_JSON_CODEC_UNAVAILABLE', 'MCP 客户端缺少精确 JSON 解析接口');
    const jsonOptions = exact ? { jsonParser: nativeMcpJsonParser } : {};
    const transport = stdio ? new Transport({ command: detail.command, args: detail.args, env: environment, stderr: 'pipe', ...jsonOptions })
      : new Transport(new URL(endpoint), { requestInit: { headers }, fetch: fetchImpl, ...jsonOptions });
    const client = new Client({ name: 'agentkit-studio-local-runtime', version: '0.0.1' },
      exact ? { jsonSchemaValidator: nativeMcpSchemaValidator } : undefined);
    connectingClients.add(client);
    if (stdio) transport.stderr?.resume();
    try {
      await client.connect(transport, { timeout: 20000 });
      assertOpen();
    } catch (error) {
      await Promise.resolve(client.close()).catch(() => {});
      await Promise.resolve(transport.close?.()).catch(() => {});
      throw mcpFailure(error, key);
    } finally { connectingClients.delete(client); }
    const entry = { client, transport, fingerprint, cacheKey };
    const displaced = mcpClients.get(cacheKey);
    if (displaced && displaced !== entry) await displaced.client.close().catch(() => {});
    if (closed) { await client.close().catch(() => {}); assertOpen(); }
    mcpClients.set(cacheKey, entry);
    return entry;
  }

  async function listMcpTools(id, { jsonCodec, snapshot = false } = {}) {
    if (typeof snapshot !== 'boolean') throw new LocalResourceError('MCP_SNAPSHOT_INVALID', 'MCP 目录快照选项无效');
    const key = resourceId(id);
    // A revision's schema discovery must not replace an active caller's
    // connection or populate that caller's mutable output-validator cache.
    const entry = await mcp(id, jsonCodec, snapshot ? Symbol('MCP catalog snapshot') : undefined);
    try { return (await entry.client.listTools()).tools || []; }
    catch (error) {
      await Promise.resolve(entry.client.close?.()).catch(() => {});
      if (mcpClients.get(entry.cacheKey) === entry) mcpClients.delete(entry.cacheKey);
      throw mcpFailure(error, key, 'list');
    } finally {
      if (snapshot) {
        await Promise.resolve(entry.client.close?.()).catch(() => {});
        if (mcpClients.get(entry.cacheKey) === entry) mcpClients.delete(entry.cacheKey);
      }
    }
  }

  async function callMcpTool(id, name, args = {}, { signal, resultFormat = 'content', assertCurrent } = {}) {
    const check = () => {
      signal?.throwIfAborted();
      if (assertCurrent === undefined) return;
      if (typeof assertCurrent !== 'function') throw new LocalResourceError('MCP_AUTHORITY_INVALID', 'MCP 调用权限校验无效');
      const result = assertCurrent();
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).catch(() => {});
        throw new LocalResourceError('MCP_AUTHORITY_INVALID', 'MCP 调用权限校验必须同步完成');
      }
      if (result === false) throw new LocalResourceError('MCP_AUTHORITY_STALE', 'MCP 调用权限已失效');
    };
    check();
    if (!['content', 'mcp-result/v1'].includes(resultFormat)) throw new LocalResourceError('MCP_RESULT_FORMAT_INVALID', 'MCP 结果格式无效');
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(String(name || ''))) throw new LocalResourceError('MCP_TOOL_NAME_INVALID', 'MCP 工具名无效');
    const key = resourceId(id);
    const entry = await mcp(id, resultFormat === 'mcp-result/v1' ? NATIVE_MCP_JSON_CODEC : undefined);
    // Credentials and connection initialization may wait. Borrowing a parent
    // connection cannot extend the child's original dispatch authority.
    check();
    let result;
    try { result = await entry.client.callTool({ name: String(name), arguments: args }, undefined, { signal }); }
    catch (error) {
      await Promise.resolve(entry.client.close?.()).catch(() => {});
      if (mcpClients.get(entry.cacheKey) === entry) mcpClients.delete(entry.cacheKey);
      throw mcpFailure(error, key, 'call', name);
    }
    if (resultFormat === 'mcp-result/v1') return result;
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
      let archive;
      try {
        // This is trusted pre-Run resource admission. Native tool execution
        // uses the same downloader with its actual intent/fence authority.
        ({ archive } = await fetchNativeSkillArchive({ url, contentHash: expectedHash,
          signal: AbortSignal.timeout(30000), assertCurrent: () => true, fetchImpl }));
      } catch (error) {
        throw new LocalResourceError(error.code || 'SKILL_DOWNLOAD_FAILED', '云端 Skill 下载或完整性校验失败', { resourceId: skillId });
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
        const directory = skillDiscovery.resolveInstalled ? await skillDiscovery.resolveInstalled(key) : join(skillDiscovery.store, local.name);
        return { name: key, content, ...(skillDiscovery.store ? { definitions: [runtimeSkill({ name: local.name, content, path: join(directory, 'SKILL.md') })] } : {}) };
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
      // Memory API accepts at most 512 Unicode characters. A delegated task
      // carries role guidance as well as the user task; bound only this
      // retrieval query, never the durable task/message or memory write.
      Query: Array.from(String(query || '').trim()).slice(0,512).join(''), Limit: 5, SceneId: '_sys_general',
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
    return { accepted: true, data: memoryReply(result, true).data };
  }

  async function close() {
    closed = true;
    const clients = new Set([...connectingClients, ...[...mcpClients.values()].map(entry => entry.client)]);
    await Promise.allSettled([...clients].map(client => client.close()));
    connectingClients.clear();
    mcpClients.clear();
    cloudSkillSpaces.clear();
  }

  async function memoryAction(action, id, userId, payload, { agentId = '' } = {}) {
    if (!serverClient?.action) throw new LocalResourceError('MEMORY_SERVICE_UNAVAILABLE', '云端记忆库适配器未启用');
    const reply = await serverClient.action(action, { MemoryCollectionId: resourceId(id),
      AgentUserId: memorySubjectId(resourceId(id), userId, agentId), ...payload }, { apiVersion: '2025-11-14' });
    return memoryReply(reply, action !== 'ListMemories');
  }
  async function listMemory(id, userId, options) {
    const { data } = await memoryAction('ListMemories', id, userId, { Page: 1, PageSize: 100 }, options);
    if (!Array.isArray(data.MemoryList)) throw new LocalResourceError('MEMORY_RESPONSE_UNKNOWN', '记忆列表格式无法识别');
    const subjectId = memorySubjectId(resourceId(id), userId, options?.agentId);
    if (data.MemoryList.some(item => item.AgentUserId && item.AgentUserId !== subjectId)) throw new LocalResourceError('MEMORY_PARTITION_MISMATCH', '记忆归属无法核对');
    return { items: data.MemoryList.filter(item => typeof item.MemoryId === 'string' && typeof item.Memory === 'string')
      .map(item => ({ id: item.MemoryId, text: item.Memory })), hasMore: Number(data.Total || data.TotalCount || 0) > data.MemoryList.length };
  }
  async function mutateMemory(action, id, userId, memoryId, content, options) {
    const { data, requestId } = await memoryAction(action, id, userId, { MemoryId: memoryId, ...(content === undefined ? {} : { Content: content }) }, options);
    if (!requestId && !data.RequestId && !data.ResponseMetadata?.RequestId) throw new LocalResourceError('MEMORY_RESPONSE_UNKNOWN', '记忆修改结果尚未确认，请刷新核对');
    return { accepted: true };
  }

  // Host-only descriptor; it can contain credentials. Never expose it through RPC.
  return { describeMcp, listMcpTools, callMcpTool, loadSkill, searchKnowledge, searchMemory, writeMemory, listMemory,
    deleteMemory: (id, userId, memoryId, options) => mutateMemory('DeleteMemory', id, userId, memoryId, undefined, options),
    updateMemory: (id, userId, memoryId, content, options) => mutateMemory('UpdateMemory', id, userId, memoryId, content, options), close };
}
