/** Node client for the existing AgentEngine public Action API. */
import { randomUUID } from 'node:crypto';
import aws4 from 'aws4';

const KOP_HOSTS = new Set(['aicp.api.ksyun.com', 'aicp.inner.api.ksyun.com', 'aicp.internal.api.ksyun.com']);
const API_VERSION = '2024-06-12';

export class AgentEngineError extends Error {
  constructor(code, message, { status = 0, requestId = '', action = '' } = {}) {
    super(message); this.code = code; this.status = status; this.requestId = requestId; this.action = action;
  }
}

const SERVER_ACTIONS = new Set([
  'ListAgents', 'GetAgent', 'ListKnowledgeBases', 'ListMemoryInstances', 'ListMCPs',
  'ListSkillWorkspaces', 'ListAgentModels', 'ListSessions', 'GetSession',
  'ListSessionMessages', 'ListSessionEvents', 'ListAgentSchedules', 'GetAgentSchedule',
  'ListAgentScheduleOccurrences', 'GetObservabilityOverview', 'ListAgentRuntimeStats',
]);

function normalizeAgent(item = {}) {
  const basic = item.Basic || item.basic || item;
  const deployment = item.Deployment || item.deployment || {};
  const component = item.ComponentConfig || item.componentConfig || item.Advanced?.ComponentConfig || {};
  const id = basic.AgentId || basic.agentId || basic.id || item.AgentId || item.agentId || item.id;
  const name = basic.Name || basic.name || item.Name || item.name || id;
  const metadata = {
    id, name, description: basic.Description || basic.description || item.Description || item.description || '',
    revision: Number(basic.Revision || basic.revision || item.Revision || item.revision || 1),
    status: basic.Status || basic.status || item.Status || item.status,
    phase: basic.Phase || basic.phase || item.Phase || item.phase,
  };
  const runtimeType = String(item.HarnessRuntimeKind || item.harnessRuntimeKind || basic.Framework || basic.framework || item.Framework || item.framework || 'dsh-native').toLowerCase();
  const knowledge = component.KnowledgeBase || component.knowledge_base || component.knowledgeBase;
  const memory = component.Memory || component.memory;
  const skill = component.SkillWorkspace || component.skill_workspace || component.skillWorkspace;
  const plugins = [];
  if (knowledge?.Id || knowledge?.id) plugins.push({ config: { binding: { resource: { kind: 'knowledge-base', id: knowledge.Id || knowledge.id, region: knowledge.Region || knowledge.region } } } });
  if (memory?.Id || memory?.id) plugins.push({ config: { binding: { resource: { kind: 'memory-instance', id: memory.Id || memory.id, region: memory.Region || memory.region } } } });
  if (skill?.Id || skill?.id) plugins.push({ config: { binding: { resource: { kind: 'skill-space', id: skill.Id || skill.id, region: skill.Region || skill.region } } } });
  return {
    id, name, description: metadata.description, status: metadata.status, phase: metadata.phase,
    framework: basic.Framework || basic.framework || item.Framework || item.framework,
    region: basic.Region || basic.region || item.Region || item.region,
    metadata, spec: { runtime: { type: runtimeType }, bindings: { plugins } },
    deployment: { ...deployment }, builds: Array.isArray(item.Builds || item.builds) ? (item.Builds || item.builds) : [],
    source: 'agentengine-server',
  };
}

/** AK/SK stay in Node; redirects and implicit mutation retries are disabled. */
export function createAgentEngineClient({ configuration, fetchImpl = fetch, timeoutMs = 15000 }) {
  async function action(name, payload = {}, { signal } = {}) {
    if (!/^[A-Z][A-Za-z0-9]+$/.test(name)) throw new AgentEngineError('INVALID_ACTION', '无效 Server Action');
    if (!SERVER_ACTIONS.has(name)) throw new AgentEngineError('ACTION_NOT_ALLOWED', `Studio 当前不开放 ${name}`);
    const { values } = await configuration.resolve();
    let base;
    try { base = new URL(values.cloudServerUrl || 'https://aicp.api.ksyun.com'); }
    catch { throw new AgentEngineError('SERVER_URL_INVALID', '控制面地址无效'); }
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname);
    if (base.username || base.password || base.search || base.hash || base.pathname !== '/' ||
      (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback))) {
      throw new AgentEngineError('SERVER_URL_INVALID', '控制面地址须为 HTTPS origin；仅本机开发允许 HTTP');
    }
    const body = JSON.stringify(payload);
    const requestAgainst = async (requestBase, allowInnerFallback = true) => {
      const kop = KOP_HOSTS.has(requestBase.hostname);
      const headers = { 'Content-Type': 'application/json', Accept: 'application/json',
        'X-Ksc-Request-Id': randomUUID(), 'X-Ksc-Region': values.cloudRegion || 'cn-beijing-6',
        'X-Ksc-Source': 'agentkit-studio' };
      if (values.cloudAccountId) headers['X-Ksc-Account-Id'] = values.cloudAccountId;
      const url = new URL(kop ? `/?Action=${name}&Version=${API_VERSION}` : `/agentengine/api/v1/${name}`, requestBase);
      if (kop) {
        if (!values.cloudAccessKey || !values.cloudSecretKey) throw new AgentEngineError('CLOUD_CREDENTIALS_MISSING', '请在模型与凭证中配置云端 AK/SK');
        if (values.cloudRegion === 'pre-online') headers['X-KSC-CUSTOM-SOURCE'] = values.cloudCustomSource || 'pre';
        Object.assign(headers, { 'X-Action': name, 'X-Version': API_VERSION });
        const signedRequest = aws4.sign({ host: url.host, path: url.pathname + url.search, method: 'POST',
          service: 'aicp', region: values.cloudRegion || 'cn-beijing-6', headers, body },
        { accessKeyId: values.cloudAccessKey, secretAccessKey: values.cloudSecretKey,
          sessionToken: values.cloudSessionToken });
        // aws4 signs and returns the request object; it does not replace the
        // caller's plain header map. Copy the generated Authorization, Host and
        // date headers into the fetch request or KOP reports MissingAccesskey.
        Object.assign(headers, signedRequest.headers);
      } else {
        // Custom server origins must have their own credential. Never sign them using cloud AK/SK.
        if (values.cloudServiceToken) headers.Authorization = `Bearer ${values.cloudServiceToken}`;
        else if (!loopback) throw new AgentEngineError('SERVER_CREDENTIALS_MISSING', '自定义 Server 需要专属服务凭证');
      }
      let response;
      try {
        response = await fetchImpl(url, { method: 'POST', headers, body, redirect: 'error',
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
      } catch {
        throw new AgentEngineError(signal?.aborted ? 'REQUEST_CANCELLED' : 'SERVER_UNAVAILABLE',
          signal?.aborted ? '请求已取消' : 'Server 请求未完成，请检查连接；写请求不会自动重试', { action: name });
      }
      let envelope;
      try { envelope = await response.json(); }
      catch { throw new AgentEngineError('SERVER_INVALID_RESPONSE', 'Server 未返回有效 JSON', { status: response.status, action: name }); }
      const upstreamMessage = String(envelope?.Error?.Message || envelope?.Message || '').toLowerCase();
      if (allowInnerFallback && requestBase.hostname === 'aicp.api.ksyun.com' && response.status === 403 && upstreamMessage.includes('inner account')) {
        // Some account keys are restricted to the intranet AICP endpoint. This
        // is endpoint selection, not a retry of a mutating action: reuse the
        // same request id only at the transport layer and never fallback on
        // arbitrary 4xx responses.
        return requestAgainst(new URL('https://aicp.inner.api.ksyun.com'), false);
      }
      if (!response.ok || !envelope || ![0, 200].includes(Number(envelope.Code)) || envelope.Code == null) {
        const status = !response.ok ? response.status : Number(envelope?.Code) || 502;
        // Upstream messages can echo input or credentials. Keep the renderer error bounded and metadata-only.
        throw new AgentEngineError(status === 429 ? 'SERVER_RATE_LIMITED' : 'SERVER_ACTION_FAILED',
          `${name} 请求失败（${status}）`, { status, requestId: String(envelope?.RequestId || ''), action: name });
      }
      return { data: envelope.Data, requestId: String(envelope.RequestId || '') };
    };
    return requestAgainst(base);
  }
  async function listAgents({ page = 1, pageSize = 20, query = '' } = {}, options) {
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100 || typeof query !== 'string') {
      throw new AgentEngineError('INVALID_QUERY', '分页参数无效');
    }
    const result = await action('ListAgents', { Page: page, PageSize: pageSize, ...(query.trim() ? { Name: query.trim() } : {}) }, options);
    if (!Array.isArray(result.data?.Agents)) throw new AgentEngineError('SERVER_INVALID_RESPONSE', 'Server Agent 列表格式不兼容');
    return { items: result.data.Agents.map(item => ({
      ...normalizeAgent(item), updatedAt: item.UpdatedAt || item.updatedAt,
    })), total: result.data.Total, page: result.data.Page || page, pageSize: result.data.PageSize || pageSize,
    requestId: result.requestId, source: 'agentengine-server' };
  }
  async function getAgent(agentId, options) {
    if (typeof agentId !== 'string' || !agentId.trim()) throw new AgentEngineError('INVALID_AGENT_ID', 'AgentId 不能为空');
    const result = await action('GetAgent', { AgentId: agentId.trim() }, options);
    return { ...normalizeAgent(result.data), requestId: result.requestId };
  }
  async function listResource(kind, payload = {}, options) {
    const actions = {
      'knowledge-base': 'ListKnowledgeBases',
      'memory-instance': 'ListMemoryInstances',
      mcp: 'ListMCPs',
      'skill-space': 'ListSkillWorkspaces',
    };
    const name = actions[kind];
    if (!name) throw new AgentEngineError('INVALID_RESOURCE_KIND', '不支持的资源类型');
    const result = await action(name, payload, options);
    const raw = result.data || {};
    const candidates = raw.Items || raw.items || raw.Records || raw.records || raw[name.replace(/^List/, '')] || [];
    if (!Array.isArray(candidates)) throw new AgentEngineError('SERVER_INVALID_RESPONSE', `${name} 返回格式不兼容`);
    return { items: candidates.map(item => ({
      ...item,
      id: item.Id || item.id || item.ResourceId || item.resourceId || item.InstanceId || item.instanceId,
      name: item.Name || item.name || item.DisplayName || item.displayName || item.Id || item.id,
      region: item.Region || item.region,
      disabled: Boolean(item.Disabled ?? item.disabled),
    })), total: raw.Total ?? raw.total ?? candidates.length, requestId: result.requestId, source: 'agentengine-server' };
  }
  return { action, listAgents, getAgent, listResource };
}
