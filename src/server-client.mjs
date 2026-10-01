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
  'ListAgents', 'GetAgent', 'UpdateAgent', 'CreateSession', 'ListKnowledgeBases', 'ListMemoryInstances', 'ListMCPs',
  'GetMCP', 'RetrieveKnowledge',
  'QueryMemorySdk', 'CreateMemorySdk',
  'ListSkillWorkspaces', 'ListAgentModels', 'ListSessions', 'GetSession',
  'ListSessionMessages', 'ListSessionEvents', 'ListAgentSchedules', 'GetAgentSchedule',
  'ListAgentScheduleOccurrences', 'GetObservabilityOverview', 'ListAgentRuntimeStats',
  'RunAgent', 'CancelRun', 'ResumeRun', 'SubmitInteraction', 'SubmitAgentControl',
]);

const SKILL_SERVICE_ACTIONS = new Set([
  'ListSkillsBySpaceId', 'GetSkillDownloadUrl', 'GetPremadeSkillDownloadUrl',
]);

function normalizeAgent(item = {}) {
  // Local Studio's REST catalog returns the same normalized `metadata/spec`
  // shape consumed by the browser, while cloud Action responses use the
  // Basic/ComponentConfig envelope below. Preserve the local shape instead
  // of dropping its identity when the shared GetAgent Action is unavailable.
  if (item && typeof item === 'object' && (item.metadata || item.spec)) {
    const metadata = item.metadata || {};
    const spec = item.spec || {};
    const id = metadata.id || item.id || '';
    const name = metadata.name || item.name || id;
    const runtimeType = String(spec.runtime?.type || item.runtime?.type || item.framework || 'dsh-native').toLowerCase();
    return {
      ...item,
      id,
      name,
      description: metadata.description || item.description || spec.description || '',
      metadata: { ...metadata, id, name },
      spec: { ...spec, runtime: { ...(spec.runtime || {}), type: runtimeType }, bindings: spec.bindings || {} },
      source: 'agentengine-server',
    };
  }
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
  // GetAgent puts the deployed framework under Deployment while ListAgents
  // usually exposes it on Basic.Framework. Preserve that server-owned
  // runtime when opening the edit page; otherwise every cloud Agent falls
  // back to the misleading DSH Native label.
  const runtimeType = String(item.HarnessRuntimeKind || item.harnessRuntimeKind || basic.Framework || basic.framework || item.Framework || item.framework || deployment.Framework || deployment.framework || 'dsh-native').toLowerCase();
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

/**
 * Translate the Studio binding snapshot into the public AgentEngine update
 * contract.  The cloud API owns ComponentConfig; local MCP/Skill/Tool and
 * model profile IDs are Host concepts and must never be silently serialized
 * as an apparently successful cloud update.
 */
export function buildCloudAgentUpdate(agentId, { spec = {}, name = '', description = '' } = {}) {
  const id = String(agentId || '').trim();
  if (!id) throw new AgentEngineError('INVALID_AGENT_ID', 'AgentId 不能为空');
  const bindings = spec?.bindings && typeof spec.bindings === 'object' ? spec.bindings : {};
  const unsupported = [];
  for (const [key, label] of [['mcpServers', 'MCP'], ['skills', '本地 Skill'], ['tools', 'Tool'], ['modelProfileIds', '模型']]) {
    const value = key === 'modelProfileIds' && !Array.isArray(bindings[key])
      ? (bindings.modelProfileId ? [bindings.modelProfileId] : []) : bindings[key];
    if ((Array.isArray(value) && value.length) || (value && !Array.isArray(value))) unsupported.push(label);
  }
  if (unsupported.length) {
    throw new AgentEngineError('CLOUD_BINDING_UNSUPPORTED', `云端 Agent 不能通过 ComponentConfig 保存${unsupported.join('、')}绑定；请在云端运行时配置中管理`, { action: 'UpdateAgent' });
  }
  const components = { KnowledgeBase: null, Memory: null, SkillWorkspace: null };
  const componentFields = { 'knowledge-base': 'KnowledgeBase', 'memory-instance': 'Memory', 'skill-space': 'SkillWorkspace' };
  for (const binding of Array.isArray(bindings.plugins) ? bindings.plugins : []) {
    const resource = binding?.config?.binding?.resource || {};
    const field = componentFields[String(resource.kind || '').trim()];
    const resourceId = String(resource.id || resource.resourceId || '').trim();
    if (!field || !resourceId) continue;
    components[field] = {
      Id: resourceId,
      ...(resource.name ? { Name: String(resource.name) } : {}),
    };
  }
  const payload = { AgentId: id, ComponentConfig: components };
  if (name !== undefined && String(name).trim()) payload.Name = String(name).trim();
  if (description !== undefined) payload.Description = String(description || '');
  return payload;
}

/** AK/SK stay in Node; redirects and implicit mutation retries are disabled. */
export function createAgentEngineClient({ configuration, fetchImpl = fetch, timeoutMs = 15000, sessionToken = '', serverUrl = '' }) {
  async function listLocalAgents({ page = 1, pageSize = 20, query = '' } = {}, options = {}) {
    const { values } = await configuration.resolve();
    let base;
    try { base = new URL(values.cloudServerUrl || serverUrl || 'https://aicp.api.ksyun.com'); }
    catch { throw new AgentEngineError('SERVER_URL_INVALID', '控制面地址无效'); }
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || !sessionToken) {
      throw new AgentEngineError('SERVER_ACTION_FAILED', '本地 Agent 列表接口不可用', { status: 404, action: 'ListAgents' });
    }
    // The local Studio registry already returns the complete AgentDraft,
    // including runtime and resource bindings. Keep that catalog local: the
    // browser must not fan out to a server Action per row just to render
    // capability counts. Build history remains a detail concern of Delivery.
    const limit = Math.min(200, Math.max(page * pageSize, pageSize));
    const params = new URLSearchParams({ limit: String(limit) });
    if (String(query || '').trim()) params.set('query', String(query).trim());
    const url = new URL(`/api/v1/agents?${params.toString()}`, base);
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json', 'X-AgentKit-Session': sessionToken },
        redirect: 'error',
        signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new AgentEngineError('SERVER_UNAVAILABLE', '本地 Host 请求未完成，请检查连接', { action: 'ListAgents' });
    }
    let payload;
    try { payload = await response.json(); }
    catch { throw new AgentEngineError('SERVER_INVALID_RESPONSE', '本地 Host 未返回有效 JSON', { status: response.status, action: 'ListAgents' }); }
    if (!response.ok || !payload || typeof payload !== 'object' || !Array.isArray(payload.items)) {
      throw new AgentEngineError('SERVER_INVALID_RESPONSE', '本地 Agent 列表格式不兼容', { status: response.status, action: 'ListAgents' });
    }
    const items = payload.items.map(item => ({ ...normalizeAgent(item), source: 'local-studio' }));
    const start = (page - 1) * pageSize;
    const nextCursor = payload.nextCursor || null;
    // The local catalog is cursor-backed rather than total-count-backed. If
    // another cursor exists, expose a conservative lower bound that keeps the
    // next-page control enabled; the following read refines the bound again.
    return {
      items: items.slice(start, start + pageSize),
      total: items.length + (nextCursor ? 1 : 0),
      page,
      pageSize,
      nextCursor,
      source: 'local-studio',
      requestId: String(response.headers.get('x-request-id') || ''),
    };
  }

  async function getLocalAgent(agentId, options = {}) {
    const { values } = await configuration.resolve();
    let base;
    try { base = new URL(values.cloudServerUrl || serverUrl || 'https://aicp.api.ksyun.com'); }
    catch { throw new AgentEngineError('SERVER_URL_INVALID', '控制面地址无效'); }
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || !sessionToken) {
      throw new AgentEngineError('SERVER_ACTION_FAILED', '本地 Agent 详情接口不可用', { status: 404, action: 'GetAgent' });
    }
    const url = new URL(`/api/v1/agents/${encodeURIComponent(agentId)}`, base);
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json', 'X-AgentKit-Session': sessionToken },
        redirect: 'error',
        signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new AgentEngineError('SERVER_UNAVAILABLE', 'Server 请求未完成，请检查连接；写请求不会自动重试', { action: 'GetAgent' });
    }
    let payload;
    try { payload = await response.json(); }
    catch { throw new AgentEngineError('SERVER_INVALID_RESPONSE', 'Server 未返回有效 JSON', { status: response.status, action: 'GetAgent' }); }
    if (!response.ok || !payload || typeof payload !== 'object') {
      throw new AgentEngineError('SERVER_ACTION_FAILED', 'GetAgent 请求失败', { status: response.status, action: 'GetAgent' });
    }
    return { ...normalizeAgent(payload.draft || payload.agent || payload), requestId: String(response.headers.get('x-request-id') || '') };
  }

  async function action(name, payload = {}, { signal, apiVersion = API_VERSION } = {}) {
    if (!/^[A-Z][A-Za-z0-9]+$/.test(name)) throw new AgentEngineError('INVALID_ACTION', '无效 Server Action');
    if (!SERVER_ACTIONS.has(name)) throw new AgentEngineError('ACTION_NOT_ALLOWED', `Studio 当前不开放 ${name}`);
    const { values } = await configuration.resolve();
    let base;
    try { base = new URL(values.cloudServerUrl || serverUrl || 'https://aicp.api.ksyun.com'); }
    catch { throw new AgentEngineError('SERVER_URL_INVALID', '控制面地址无效'); }
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname);
    if (base.username || base.password || base.search || base.hash || base.pathname !== '/' ||
      (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback))) {
      throw new AgentEngineError('SERVER_URL_INVALID', '控制面地址须为 HTTPS origin；仅本机开发允许 HTTP');
    }
    const requestAgainst = async (requestBase, allowInnerFallback = true) => {
      const kop = KOP_HOSTS.has(requestBase.hostname);
      // `pre-online` is a logical environment, not a signing region: KOP and
      // AWS4 require a real region (cn-beijing-6) plus the X-KSC-CUSTOM-SOURCE
      // marker. Signing with the literal value makes KOP reject the request.
      const controlRegion = values.cloudRegion?.toLowerCase() === 'pre-online'
        ? 'cn-beijing-6'
        : (values.cloudRegion || 'cn-beijing-6');
      // The official ksyun AICP client carries the common KOP fields in the
      // JSON body when IsPostJson is enabled. Keep these fields on the signed
      // request as well; resource Actions such as QueryMemorySdk otherwise
      // respond with a misleading 404 even though the Action route exists.
      const requestPayload = kop ? {
        ...payload, Service: 'aicp', Action: name, Version: apiVersion,
        SdkVersion: 'agentkit-studio', Region: controlRegion, Accesskey: values.cloudAccessKey,
      } : payload;
      const body = JSON.stringify(requestPayload);
      const headers = { 'Content-Type': 'application/json', Accept: 'application/json',
        'X-Ksc-Request-Id': randomUUID(), 'X-Ksc-Region': controlRegion,
        'X-Ksc-Source': 'agentkit-studio' };
      if (values.cloudAccountId) headers['X-Ksc-Account-Id'] = values.cloudAccountId;
      const url = new URL(kop ? `/?Action=${name}&Version=${apiVersion}` : `/agentengine/api/v1/${name}`, requestBase);
      if (kop) {
        if (!values.cloudAccessKey || !values.cloudSecretKey) throw new AgentEngineError('CLOUD_CREDENTIALS_MISSING', '请在模型与凭证中配置云端 AK/SK');
        if (values.cloudRegion?.toLowerCase() === 'pre-online') headers['X-KSC-CUSTOM-SOURCE'] = values.cloudCustomSource || 'pre';
        Object.assign(headers, { 'X-Action': name, 'X-Version': apiVersion });
        const signedRequest = aws4.sign({ host: url.host, path: url.pathname + url.search, method: 'POST',
          service: 'aicp', region: controlRegion, headers, body },
        { accessKeyId: values.cloudAccessKey, secretAccessKey: values.cloudSecretKey,
          sessionToken: values.cloudSessionToken });
        // aws4 signs and returns the request object; it does not replace the
        // caller's plain header map. Copy the generated Authorization, Host and
        // date headers into the fetch request or KOP reports MissingAccesskey.
        Object.assign(headers, signedRequest.headers);
      } else {
        // Custom server origins must have their own credential. Never sign them using cloud AK/SK.
        if (values.cloudServiceToken) headers.Authorization = `Bearer ${values.cloudServiceToken}`;
        // The local AgentEngine Studio server protects its shared Action API
        // with the short-lived Studio session. Keep this on the Node side so
        // the browser never has to proxy a server credential through a
        // renderer request. The token is intentionally only attached to
        // loopback origins; remote custom origins still require their own
        // explicit service token.
        if (loopback && sessionToken) headers['X-AgentKit-Session'] = sessionToken;
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
      let responseText = '';
      try {
        responseText = await response.text();
        envelope = responseText ? JSON.parse(responseText) : null;
      } catch { envelope = null; }
      // KOP emits XML for the same inner-account transport denial on both
      // regular Actions and streaming Actions. Keep the fallback symmetric so
      // a fresh cloud Session can be admitted before its first RunAgent.
      const xmlMessage = responseText.match(/<Message>([^<]{0,400})<\/Message>/i)?.[1] || '';
      const upstreamMessage = String(envelope?.Error?.Message || envelope?.Message || xmlMessage).toLowerCase();
      if (allowInnerFallback && requestBase.hostname === 'aicp.api.ksyun.com' && response.status === 403 && upstreamMessage.includes('inner account')) {
        // Some account keys are restricted to the intranet AICP endpoint. This
        // is endpoint selection, not a retry of a mutating action: reuse the
        // same request id only at the transport layer and never fallback on
        // arbitrary 4xx responses.
        // The intranet AICP endpoint serves plain HTTP on the inner network
        // (matching the legacy SDK client); HTTPS there presents a certificate
        // for another SAN and fails with ERR_TLS_CERT_ALTNAME_INVALID.
        return requestAgainst(new URL('http://aicp.inner.api.ksyun.com'), false);
      }
      if (!envelope) throw new AgentEngineError('SERVER_INVALID_RESPONSE', 'Server 未返回有效 JSON', { status: response.status, action: name });
      const nativeResource = ['RetrieveKnowledge', 'QueryMemorySdk', 'CreateMemorySdk'].includes(name);
      const codeValid = envelope?.Code == null ? nativeResource : [0, 200].includes(Number(envelope.Code));
      if (!response.ok || !envelope || !codeValid || envelope.Error || envelope.ResponseMetadata?.Error) {
        const status = !response.ok ? response.status : Number(envelope?.Code) || 502;
        // Upstream messages can echo input or credentials. Keep the renderer error bounded and metadata-only.
        throw new AgentEngineError(status === 429 ? 'SERVER_RATE_LIMITED' : 'SERVER_ACTION_FAILED',
          `${name} 请求失败（${status}）`, { status, requestId: String(envelope?.RequestId || ''), action: name });
      }
      return { data: nativeResource ? (envelope.Data ?? envelope) : envelope.Data, requestId: String(envelope.RequestId || envelope.ResponseMetadata?.RequestId || '') };
    };
    return requestAgainst(base);
  }

  /**
   * Skill Service is an AICP KOP GET surface. Keep it separate from the
   * AgentEngine POST Action path so the request method, query canonicalization
   * and signing remain explicit. The returned payload is still normalized to
   * the same `{ data, requestId }` envelope used by `action()`.
   */
  async function skillAction(name, params = {}, { signal, apiVersion = API_VERSION } = {}) {
    if (!SKILL_SERVICE_ACTIONS.has(name)) throw new AgentEngineError('ACTION_NOT_ALLOWED', `Studio 当前不开放 ${name}`);
    const { values } = await configuration.resolve();
    let base;
    try { base = new URL(values.cloudServerUrl || serverUrl || 'https://aicp.api.ksyun.com'); }
    catch { throw new AgentEngineError('SERVER_URL_INVALID', '控制面地址无效'); }
    if (!KOP_HOSTS.has(base.hostname)) throw new AgentEngineError('SKILL_SERVICE_UNAVAILABLE', 'Skill Service 需要 AICP 云端凭证');
    const controlRegion = values.cloudRegion?.toLowerCase() === 'pre-online' ? 'cn-beijing-6' : (values.cloudRegion || 'cn-beijing-6');
    const query = new URLSearchParams({ Action: name, Version: apiVersion });
    for (const [key, value] of Object.entries(params || {})) {
      if (value === undefined || value === null || value === '') continue;
      query.set(key, String(value));
    }
    const requestAgainst = async requestBase => {
      const url = new URL(`/?${query.toString()}`, requestBase);
      if (!values.cloudAccessKey || !values.cloudSecretKey) throw new AgentEngineError('CLOUD_CREDENTIALS_MISSING', '请在模型与凭证中配置云端 AK/SK');
      const headers = {
        Accept: 'application/json',
        'X-Action': name,
        'X-Version': apiVersion,
        'X-Ksc-Region': controlRegion,
        'X-Ksc-Source': 'agentkit-studio',
      };
      if (values.cloudAccountId) headers['X-Ksc-Account-Id'] = values.cloudAccountId;
      if (values.cloudRegion?.toLowerCase() === 'pre-online') headers['X-KSC-CUSTOM-SOURCE'] = values.cloudCustomSource || 'pre';
      const signed = aws4.sign({ host: url.host, path: url.pathname + url.search, method: 'GET', headers, region: controlRegion, service: 'aicp' }, {
        accessKeyId: values.cloudAccessKey, secretAccessKey: values.cloudSecretKey, sessionToken: values.cloudSessionToken,
      });
      Object.assign(headers, signed.headers);
      let response;
      try {
        response = await fetchImpl(url, { method: 'GET', headers, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
      } catch {
        throw new AgentEngineError(signal?.aborted ? 'REQUEST_CANCELLED' : 'SERVER_UNAVAILABLE', signal?.aborted ? '请求已取消' : 'Skill Service 请求未完成，请检查连接', { action: name });
      }
      let envelope;
      try { envelope = await response.json(); }
      catch { throw new AgentEngineError('SERVER_INVALID_RESPONSE', 'Skill Service 未返回有效 JSON', { status: response.status, action: name }); }
      const message = String(envelope?.Error?.Message || envelope?.Message || '').toLowerCase();
      if (requestBase.hostname === 'aicp.api.ksyun.com' && response.status === 403 && message.includes('inner account')) {
        return requestAgainst(new URL('http://aicp.inner.api.ksyun.com'));
      }
      if (!response.ok || !envelope || ![0, 200].includes(Number(envelope.Code)) || envelope.Code == null) {
        const status = !response.ok ? response.status : Number(envelope?.Code) || 502;
        throw new AgentEngineError(status === 429 ? 'SERVER_RATE_LIMITED' : 'SKILL_SERVICE_FAILED', `${name} 请求失败（${status}）`, { status, requestId: String(envelope?.RequestId || ''), action: name });
      }
      return { data: envelope.Data || envelope.data || {}, requestId: String(envelope.RequestId || envelope.request_id || '') };
    };
    return requestAgainst(base);
  }

  // Streaming Server Actions use the same Node-only credential boundary as
  // action(). Keep this separate from the JSON envelope parser: RunAgent's
  // Stream=true response is an OpenAI-compatible SSE body, not an Action
  // envelope. The browser only receives the Host's authenticated stream.
  async function streamAction(name, payload = {}, { signal } = {}, overrideBase = null) {
    if (!SERVER_ACTIONS.has(name)) throw new AgentEngineError('ACTION_NOT_ALLOWED', `Studio 当前不开放 ${name}`);
    const { values } = await configuration.resolve();
    let base;
    try { base = new URL(values.cloudServerUrl || serverUrl || 'https://aicp.api.ksyun.com'); }
    catch { throw new AgentEngineError('SERVER_URL_INVALID', '控制面地址无效'); }
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname);
    if (base.username || base.password || base.search || base.hash || base.pathname !== '/' ||
      (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback))) {
      throw new AgentEngineError('SERVER_URL_INVALID', '控制面地址须为 HTTPS origin；仅本机开发允许 HTTP');
    }
    const body = JSON.stringify(payload);
    const requestBase = overrideBase || base;
    const kop = KOP_HOSTS.has(requestBase.hostname);
    const controlRegion = values.cloudRegion?.toLowerCase() === 'pre-online' ? 'cn-beijing-6' : (values.cloudRegion || 'cn-beijing-6');
    const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'X-Ksc-Request-Id': randomUUID(), 'X-Ksc-Region': controlRegion, 'X-Ksc-Source': 'agentkit-studio' };
    if (values.cloudAccountId) headers['X-Ksc-Account-Id'] = values.cloudAccountId;
    const url = new URL(kop ? `/?Action=${name}&Version=${API_VERSION}` : `/agentengine/api/v1/${name}`, requestBase);
    if (kop) {
      if (!values.cloudAccessKey || !values.cloudSecretKey) throw new AgentEngineError('CLOUD_CREDENTIALS_MISSING', '请在模型与凭证中配置云端 AK/SK');
      if (values.cloudRegion?.toLowerCase() === 'pre-online') headers['X-KSC-CUSTOM-SOURCE'] = values.cloudCustomSource || 'pre';
      Object.assign(headers, { 'X-Action': name, 'X-Version': API_VERSION });
      Object.assign(headers, aws4.sign({ host: url.host, path: url.pathname + url.search, method: 'POST', headers, body, service: 'aicp', region: controlRegion }, {
        accessKeyId: values.cloudAccessKey, secretAccessKey: values.cloudSecretKey, sessionToken: values.cloudSessionToken,
      }).headers);
    } else {
      if (values.cloudServiceToken) headers.Authorization = `Bearer ${values.cloudServiceToken}`;
      if (loopback && sessionToken) headers['X-AgentKit-Session'] = sessionToken;
      else if (!loopback) throw new AgentEngineError('SERVER_CREDENTIALS_MISSING', '自定义 Server 需要专属服务凭证');
    }
    let response;
    try {
      response = await fetchImpl(url, { method: 'POST', headers, body, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new AgentEngineError(signal?.aborted ? 'REQUEST_CANCELLED' : 'SERVER_UNAVAILABLE', signal?.aborted ? '请求已取消' : 'Server 请求未完成，请检查连接；写请求不会自动重试', { action: name });
    }
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      let envelope = null; try { envelope = text ? JSON.parse(text) : null; } catch {}
      // KOP returns an XML ErrorResponse for transport-level denials, while
      // normal Action errors are JSON. Parse only the bounded message fields
      // needed for the inner-account endpoint fallback; never surface the
      // response body to the renderer.
      const xmlMessage = text.match(/<Message>([^<]{0,400})<\/Message>/i)?.[1] || '';
      const upstreamMessage = String(envelope?.Error?.Message || envelope?.Message || xmlMessage).toLowerCase();
      if (requestBase.hostname === 'aicp.api.ksyun.com' && response.status === 403 && upstreamMessage.includes('inner account')) {
        return streamAction(name, payload, { signal }, new URL('http://aicp.inner.api.ksyun.com'));
      }
      throw new AgentEngineError('SERVER_ACTION_FAILED', `${name} 请求失败（${response.status}）`, { status: response.status, requestId: String(envelope?.RequestId || ''), action: name });
    }
    return response;
  }
  async function getObservabilityOverview({ range = '24h' } = {}, options) {
    const hours = { '1h': 1, '6h': 6, '24h': 24, '7d': 168, '30d': 720 }[String(range || '24h')] || 24;
    const end = Date.now();
    const result = await action('GetObservabilityOverview', { StartTime: end - hours * 3600 * 1000, EndTime: end }, options);
    return result.data || {};
  }

  async function listAgentRuntimeStats({ Page = 1, PageSize = 50 } = {}, options) {
    const end = Date.now();
    const result = await action('ListAgentRuntimeStats', { Page, PageSize, StartTime: end - 24 * 3600 * 1000, EndTime: end }, options);
    return result.data || {};
  }

  async function listAgents({ page = 1, pageSize = 20, query = '' } = {}, options) {
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100 || typeof query !== 'string') {
      throw new AgentEngineError('INVALID_QUERY', '分页参数无效');
    }
    // A packaged/local Studio Host is the owner of its on-disk AgentDraft
    // registry. Read that complete local catalog first so a local Agent row
    // does not depend on AgentEngine Server capabilities or N detail calls.
    try {
      const local = await listLocalAgents({ page, pageSize, query }, options);
      return local;
    } catch (error) {
      if (!(error?.status === 404 || error?.code === 'SERVER_ACTION_FAILED')) throw error;
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
    try {
      const result = await action('GetAgent', { AgentId: agentId.trim() }, options);
      return { ...normalizeAgent(result.data), requestId: result.requestId };
    } catch (error) {
      // Older local Studio servers expose the same resource through their
      // REST catalog but have not yet mounted the shared Web Action name.
      // Keep the public Action API first, then use that authenticated local
      // read-only seam instead of reporting a misleading network failure.
      if (error?.status === 404 && sessionToken) return getLocalAgent(agentId.trim(), options);
      throw error;
    }
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
      id: item.Id || item.id || item.mcp_id || item.ResourceId || item.resourceId || item.InstanceId || item.instanceId,
      resourceId: item.Id || item.id || item.mcp_id || item.ResourceId || item.resourceId || item.InstanceId || item.instanceId,
      name: item.Name || item.name || item.DisplayName || item.displayName || item.Id || item.id,
      region: item.Region || item.region,
      status: item.Status || item.status,
      disabled: Boolean(item.Disabled ?? item.disabled),
    })), total: raw.Total ?? raw.total ?? candidates.length, requestId: result.requestId, source: 'agentengine-server' };
  }

  /**
   * Read the local AgentEngine catalog when the Python Server exposes the
   * workspace-backed resource contract.  Cloud Action APIs intentionally do
   * not pretend to expose this catalog: Tool resources in particular are
   * authored by the local Studio workspace and have no ListTools Action.
   */
  async function listCatalogResources({ kind = '', query = '', limit = 100, cursor = '', source = '', status = '' } = {}, options = {}) {
    const { values } = await configuration.resolve();
    let base;
    try { base = new URL(values.cloudServerUrl || serverUrl || 'http://127.0.0.1:8789'); }
    catch { throw new AgentEngineError('SERVER_URL_INVALID', '控制面地址无效'); }
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname);
    if (!loopback || !sessionToken) {
      throw new AgentEngineError('CATALOG_UNAVAILABLE', '当前连接没有可用的本地 AgentEngine 资源目录', { status: 404, action: 'CatalogResources' });
    }
    const params = new URLSearchParams();
    if (kind) params.set('kind', String(kind));
    if (query) params.set('query', String(query));
    params.set('limit', String(Math.min(200, Math.max(1, Number(limit) || 100))));
    if (cursor) params.set('cursor', String(cursor));
    if (source) params.set('source', String(source));
    if (status) params.set('status', String(status));
    const url = new URL(`/api/v1/catalog/resources?${params.toString()}`, base);
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json', 'X-AgentKit-Session': sessionToken },
        redirect: 'error',
        signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new AgentEngineError(options.signal?.aborted ? 'REQUEST_CANCELLED' : 'CATALOG_UNAVAILABLE', options.signal?.aborted ? '请求已取消' : '本地 AgentEngine 资源目录不可用', { action: 'CatalogResources' });
    }
    let payload;
    try { payload = await response.json(); }
    catch { throw new AgentEngineError('SERVER_INVALID_RESPONSE', '本地资源目录未返回有效 JSON', { status: response.status, action: 'CatalogResources' }); }
    if (!response.ok || !payload || !Array.isArray(payload.items)) {
      throw new AgentEngineError('CATALOG_UNAVAILABLE', '本地 AgentEngine 资源目录请求失败', { status: response.status, action: 'CatalogResources' });
    }
    return { ...payload, source: 'agentengine-server', requestId: String(response.headers.get('x-request-id') || '') };
  }
  return {
    getObservabilityOverview, listAgentRuntimeStats, action, skillAction, streamAction,
    listAgents, getAgent, listResource, listCatalogResources,
  };
}
