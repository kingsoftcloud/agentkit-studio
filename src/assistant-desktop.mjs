/**
 * Studio-side personal-assistant desktop proxy.
 *
 * The standalone `@kingsoftcloud/agentkit-personal-assistant` DSH plugin keeps
 * its own credentials only in development hosts. Inside Studio the plugin asks
 * this service for the account's bound cloud instance and for one-shot desktop
 * tickets, so the gateway API key never enters the plugin, the page, a URL or
 * the logs. See the PA repository's `Studio-Host桌面代理契约-v1.md`.
 *
 * Ownership: Host-only module. It never exposes the credential through RPC,
 * HTTP or plugin return values, and every failure carries `status` (or
 * `details.status`) so the plugin can keep a truthful error state.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const FORMAT = 'agentkit.studio-assistant-binding/v1';
const SERVICE = 'studioPersonalAssistantDesktop';
const PROTOCOL = 'agentkit.personal-assistant.desktop.v1';
const WS_PATH = 'personal-assistant/desktop/ws';
const DIRECTORY_BOT_ID = '__directory__';
const TICKET = /^[A-Za-z0-9_-]{32,512}$/u;
const AGENT_ID = /^ar-[A-Za-z0-9-]{4,120}$/u;
const BOT_ID = /^[A-Za-z0-9._:-]{1,64}$/u;
const MAX_TICKET_SECONDS = 60;

const fail = (code, message, status = 409, details = {}) => Object.assign(new Error(message), { code, status, details });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' ? value.trim() : '';

function gatewayOrigin(value) {
  let url;
  try { url = new URL(text(value)); } catch { throw fail('ASSISTANT_GATEWAY_INVALID', '云网关地址无效', 400); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw fail('ASSISTANT_GATEWAY_INVALID', '云网关必须是 https 根地址', 400);
  }
  return url.origin;
}

export function createAssistantDesktop({ storeDir, fetchImpl = fetch, env = process.env, configuration: configurationSource, getClient, getDeploymentClient } = {}) {
  const file = join(storeDir, 'assistant-binding.json');
  let cached, cacheAt = 0;
  const ttl = 5_000;

  async function readBinding() {
    if (cached && Date.now() - cacheAt < ttl) return cached;
    let raw;
    try { raw = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') {
        if (error instanceof SyntaxError) throw fail('ASSISTANT_BINDING_CORRUPT', '个人助理绑定无法读取，请重新连接', 500);
        throw fail('ASSISTANT_BINDING_UNREADABLE', '个人助理绑定无法读取', 500);
      }
      cached = null; cacheAt = Date.now(); return null;
    }
    if (!record(raw) || raw.format !== FORMAT || !text(raw.gatewayUrl) || !AGENT_ID.test(text(raw.agentId)) || !text(raw.apiKey))
      throw fail('ASSISTANT_BINDING_CORRUPT', '个人助理绑定无法读取，请重新连接', 500);
    cached = { gatewayUrl: gatewayOrigin(raw.gatewayUrl), agentId: text(raw.agentId), apiKey: text(raw.apiKey), label: text(raw.label), updatedAt: text(raw.updatedAt) };
    cacheAt = Date.now();
    return cached;
  }

  async function writeBinding(binding) {
    await mkdir(storeDir, { recursive: true, mode: 0o700 });
    const next = `${file}.${randomUUID()}.next`;
    await writeFile(next, JSON.stringify({ format: FORMAT, gatewayUrl: binding.gatewayUrl, agentId: binding.agentId,
      apiKey: binding.apiKey, label: binding.label || '', updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    await rename(next, file);
    cached = null; cacheAt = 0;
  }

  async function gatewayTicket(binding, { botId, mode, leaseId }, signal) {
    const body = JSON.stringify({ AgentId: binding.agentId, BotId: botId, Mode: mode === 'read' ? 'read' : 'control',
      ...(leaseId ? { LeaseId: String(leaseId) } : {}) });
    const url = new URL('IssuePersonalAssistantDesktopTicket', binding.gatewayUrl.endsWith('/') ? binding.gatewayUrl : `${binding.gatewayUrl}/`);
    let response;
    try {
      response = await fetchImpl(url, { method: 'POST', redirect: 'error',
        headers: { authorization: `Bearer ${binding.apiKey}`, 'content-type': 'application/json' },
        body, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
    } catch (error) {
      if (signal?.aborted) throw fail('ASSISTANT_TICKET_CANCELLED', '桌面授权已取消', 499);
      throw fail('ASSISTANT_GATEWAY_UNREACHABLE', '云网关暂时不可达，请检查网络后重试', 502);
    }
    let payload;
    try { payload = await response.json(); } catch { payload = null; }
    if (!response.ok || !record(payload) || payload.Code !== 0) {
      const status = response.status === 401 || response.status === 403 ? 401 : response.status >= 500 ? 503 : 409;
      throw fail('ASSISTANT_TICKET_REFUSED', response.status === 401 || response.status === 403
        ? '云网关拒绝了实例凭证，请重新连接个人助理'
        : '云网关未能签发桌面授权，请检查实例状态后重试', status);
    }
    return payload.Data;
  }

  function publicTicket(binding, input, data) {
    const expiresAt = Number(data?.ExpiresAt);
    const remaining = expiresAt * 1000 - Date.now();
    if (!record(data) || !TICKET.test(String(data.Ticket || ''))
      || data.AgentId !== input.agentId || data.BotId !== input.botId
      || data.WsPath !== WS_PATH || data.Protocol !== PROTOCOL
      || !Number.isFinite(remaining) || remaining <= 0 || remaining > MAX_TICKET_SECONDS * 1000) {
      throw fail('ASSISTANT_TICKET_INVALID', '云网关返回的桌面授权格式错误', 502);
    }
    const wsUrl = new URL(WS_PATH, `${binding.gatewayUrl}/`);
    wsUrl.protocol = binding.gatewayUrl.startsWith('https:') ? 'wss:' : 'ws:';
    return { ticket: String(data.Ticket), expiresAt: new Date(expiresAt * 1000).toISOString(),
      agentId: input.agentId, botId: input.botId, wsUrl: wsUrl.href, protocol: PROTOCOL,
      leaseId: data.LeaseId ?? input.leaseId ?? null, readOnly: input.mode === 'read' };
  }

  function need(input) {
    if (!record(input)) throw fail('ASSISTANT_TICKET_INPUT_INVALID', '桌面授权参数无效', 400);
    const agentId = text(input.agentId), botId = text(input.botId);
    if (!AGENT_ID.test(agentId)) throw fail('ASSISTANT_AGENT_INVALID', '云端实例标识无效', 400);
    if (!BOT_ID.test(botId)) throw fail('ASSISTANT_BOT_INVALID', '请选择已创建的助理', 400);
    const mode = input.mode === 'read' ? 'read' : 'control';
    const leaseId = input.leaseId === undefined || input.leaseId === null ? null : text(input.leaseId);
    if (leaseId && leaseId.length > 256) throw fail('ASSISTANT_LEASE_INVALID', '桌面租约标识无效', 400);
    return { agentId, botId, mode, leaseId };
  }

  /** Gateway address for the current account environment. Preprod runs the
   * personal-assistant gateway on its own frozen host; production uses the
   * account's configured gateway and never guesses a public host. */
  async function environmentGateway() {
    const configured = text(env.AGENTKIT_PERSONAL_ASSISTANT_GATEWAY_URL);
    if (configured) return gatewayOrigin(configured);
    const source = typeof configurationSource === 'function' ? configurationSource() : configurationSource;
    const { values } = await (await source)?.resolve();
    if (!values) throw fail('ASSISTANT_CLOUD_UNCONFIGURED', '还没有配置云账号，请先在 Studio 中完成云账号设置', 409);
    const region = String(values?.cloudRegion || '').toLowerCase();
    if (region === 'pre-online') return 'https://pa-desktop-dev.agent-pre.kspmas.ksyun.com';
    throw fail('ASSISTANT_GATEWAY_UNCONFIGURED', '当前环境还没有配置个人助理云网关', 409);
  }

  /** The account's own personal-assistant instances, newest first. */
  async function discover(signal) {
    if (typeof getClient !== 'function') return [];
    const client = await getClient();
    const result = await client.action('ListAgents', { Page: 1, PageSize: 100 }, { signal });
    const rows = result?.data?.Agents ?? result?.Agents ?? [];
    return rows.filter(row => record(row) && row.Framework === 'personal-assistant'
      && row.Status === 'RUNNING' && AGENT_ID.test(text(row.AgentId)))
      .sort((left, right) => String(right.CreatedAt || '').localeCompare(String(left.CreatedAt || '')));
  }

  /** Read the created API key out of the platform's create response once. */
  function createdKey(data) {
    if (!record(data)) return '';
    for (const field of ['ApiKey', 'api_key', 'Key', 'key', 'ApiKeyValue']) {
      const value = text(data[field]);
      if (/^[A-Za-z0-9_-]{16,256}$/u.test(value)) return value;
    }
    return '';
  }

  /** Mint a fresh instance key through the platform. Returns '' when the
   * account cannot rotate credentials (deployment environment gap). */
  async function acquireKey(agentId, signal) {
    if (typeof getClient !== 'function') return '';
    const client = await getClient();
    let result;
    try { result = await client.action('CreateAgentApiKey', { AgentId: agentId, Name: 'studio-desktop' }, { signal }); }
    catch { return ''; }
    const data = result?.data ?? result;
    return createdKey(record(data?.Data) ? data.Data : data);
  }

  async function bindingUsable(binding, signal) {
    try {
      const data = await gatewayTicket(binding, { botId: DIRECTORY_BOT_ID, mode: 'read' }, signal);
      return record(data) && TICKET.test(String(data.Ticket || ''));
    } catch (error) {
      if (error?.status === 401 || error?.status === 403) return false;
      throw error;
    }
  }

  /** Resolve, verify and (when the stored key is gone) re-acquire the binding. */
  async function refresh(signal) {
    const agents = await discover(signal).catch(() => []);
    const candidates = agents.map(row => ({ agentId: row.AgentId, name: text(row.Name), status: text(row.Status),
      framework: text(row.Framework), endpoint: text(row.Endpoint), createdAt: text(row.CreatedAt) }));
    const selected = candidates[0] ? agents[0] : null;
    let binding = await readBinding();
    // The account moved to a newer instance: the stored key still belongs to
    // the old one, so fall through to the re-acquisition path.
    if (binding && selected && binding.agentId !== selected.AgentId) binding = null;
    if (binding && await bindingUsable(binding, signal)) return { binding, candidates, reason: '' };
    // The stored key is stale (or belonged to another instance). Never keep it.
    binding = null;
    if (!selected) return { binding: null, candidates, reason: 'needs-create' };
    const gatewayUrl = await environmentGateway();
    const apiKey = await acquireKey(selected.AgentId, signal);
    if (!apiKey) return { binding: null, candidates, reason: 'credential-unavailable' };
    const next = { gatewayUrl, agentId: selected.AgentId, apiKey, label: text(selected.Name).slice(0, 80) };
    // Prove the fresh key before persisting: a platform gap must not leave a
    // dead credential in the Host store.
    if (!await bindingUsable(next, signal)) return { binding: null, candidates, reason: 'credential-unavailable' };
    await writeBinding(next);
    return { binding: next, candidates, reason: '' };
  }

  async function configuration(input = {}, signal) {
    let resolved;
    try { resolved = await refresh(signal); }
    catch (error) { if (error?.code === 'ASSISTANT_GATEWAY_UNCONFIGURED') return { configured: false }; throw error; }
    if (!resolved.binding) return { configured: false };
    const candidate = text(input?.agentId);
    // A page-supplied agent is only a candidate: report the persisted binding
    // instead of trusting the caller.
    if (candidate && candidate !== resolved.binding.agentId) return { configured: false };
    return { configured: true, agentId: resolved.binding.agentId };
  }

  /** Page-facing snapshot: fetchable without leaking the credential. */
  async function status(input = {}, signal) {
    const resolved = await refresh(signal).catch(error => ({ binding: null, candidates: [], reason: error?.code || 'unavailable' }));
    return { configured: Boolean(resolved.binding), agentId: resolved.binding?.agentId,
      gatewayUrl: resolved.binding?.gatewayUrl, reason: resolved.binding ? '' : resolved.reason,
      candidates: resolved.candidates };
  }

  async function connect(payload = {}, signal) {
    const requested = text(payload.agentId);
    const resolved = await refresh(signal);
    if (requested && resolved.binding && requested !== resolved.binding.agentId) {
      const other = resolved.candidates.find(row => row.agentId === requested);
      if (!other) throw fail('ASSISTANT_AGENT_MISMATCH', '该实例不属于当前账号', 403);
      const gatewayUrl = await environmentGateway();
      const apiKey = await acquireKey(requested, signal);
      if (!apiKey) throw fail('ASSISTANT_CREDENTIAL_UNAVAILABLE', '云端暂时无法为这个实例生成连接凭证，请稍后重试', 503);
      const next = { gatewayUrl, agentId: requested, apiKey, label: text(other.name).slice(0, 80) };
      await writeBinding(next);
      return { configured: true, agentId: requested };
    }
    if (!resolved.binding) {
      if (resolved.reason === 'needs-create') throw fail('ASSISTANT_NOT_CREATED', '账号下还没有可用的个人助理实例', 409);
      throw fail('ASSISTANT_CREDENTIAL_UNAVAILABLE', '云端暂时无法获取实例连接凭证，请稍后重试', 503);
    }
    return { configured: true, agentId: resolved.binding.agentId };
  }

  async function issueTicket(input = {}, signal) {
    const scope = need(input);
    const resolved = await refresh(signal);
    const binding = resolved.binding;
    if (!binding) {
      if (scope.botId === DIRECTORY_BOT_ID) throw fail('ASSISTANT_UNCONFIGURED', '当前账号还没有可用的个人助理实例', 409);
      if (resolved.reason === 'needs-create') throw fail('ASSISTANT_NOT_CREATED', '账号下还没有可用的个人助理实例', 409);
      throw fail('ASSISTANT_CREDENTIAL_UNAVAILABLE', '云端暂时无法获取实例连接凭证，请稍后重试', 503);
    }
    if (scope.agentId !== binding.agentId) throw fail('ASSISTANT_AGENT_MISMATCH', '云端实例与 Studio 绑定不一致', 403);
    const data = await gatewayTicket(binding, scope, signal);
    return publicTicket(binding, scope, data);
  }



  /** Create the account's personal assistant through the platform catalog.
   * The managed runtime name mirrors the framework, and the manifest keeps the
   * instance identity in sync with the request. */
  async function create(payload = {}, signal) {
    if (typeof getClient !== 'function') throw fail('ASSISTANT_CREATE_UNAVAILABLE', '当前 Studio 版本不支持创建个人助理', 503);
    const version = text(env.AGENTKIT_PERSONAL_ASSISTANT_RUNTIME_VERSION) || '0.1.9';
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const name = `personal-assistant-${stamp}-${randomUUID().slice(0, 10)}`;
    const manifest = `name: ${name}\nframework: personal-assistant\nartifact_type: ManagedRuntime\nruntime:\n  name: personal-assistant\n  version: "${version}"\n`;
    const client = await getClient();
    const { values } = await (await configurationSource)?.resolve() || {};
    const region = text(values?.cloudRegion) === 'pre-online' ? 'cn-beijing-6' : (text(values?.cloudRegion) || 'cn-beijing-6');
    const request = {
      Name: name, Description: '个人助理', Framework: 'personal-assistant', Region: region,
      DeploymentType: 'ManagedRuntime',
      ManagedRuntimeConfig: { RuntimeName: 'personal-assistant', RuntimeVersion: version, Manifest: manifest },
      Resource: { Cpu: 1, Memory: 4 }, Scaling: { MinReplicas: 1, MaxReplicas: 1 },
      Storage: { MountPath: '/data', SizeGi: 20 }, Network: { EnablePublicAccess: true, EnableVpcAccess: false },
      Advanced: { EnableObservability: false, EnvironmentVariables: [{ Key: 'OPENAI_BASE_URL', Value: text(values?.modelBaseUrl) || 'https://kspmas.ksyun.com/v1' }] },
      InstanceId: randomUUID(),
    };
    let created;
    try { created = await client.action('CreateAgent', request, { signal }); }
    catch (error) {
      throw fail('ASSISTANT_CREATE_UNAVAILABLE', text(error?.message).includes('Framework') ? '当前云端还没有开放个人助理创建，请稍后再试' : '云端未能创建个人助理，请稍后再试', 503);
    }
    const data = created?.data ?? created;
    const agentId = text(data?.AgentId ?? data?.Data?.AgentId ?? data?.Agent?.AgentId);
    // Wait for the instance to become callable before minting its credential.
    const deadline = Date.now() + 300_000;
    let agent = null;
    while (Date.now() < deadline) {
      signal?.throwIfAborted?.();
      const rows = await discover(signal).catch(() => []);
      agent = rows.find(row => (agentId && row.AgentId === agentId) || row.Name === name) || null;
      if (agent) break;
      await new Promise(resolve => setTimeout(resolve, 5_000));
    }
    if (!agent) throw fail('ASSISTANT_CREATE_TIMEOUT', '个人助理正在创建中，请稍后重试', 504);
    const resolved = await refresh(signal);
    if (!resolved.binding) throw fail('ASSISTANT_CREDENTIAL_UNAVAILABLE', '个人助理已创建，但云端暂时无法获取连接凭证，请稍后重试', 503);
    return { configured: true, agentId: resolved.binding.agentId };
  }

  async function disconnect() {
    await rm(file, { force: true });
    cached = null; cacheAt = 0;
    return { configured: false };
  }

  /** Close the bound cloud assistant for good: remove the managed runtime
   * (the pod), let the platform release the AICP key and the Ding order, then
   * drop the local binding. The page must echo the instance id, so a stale
   * button can never delete a different agent. */
  async function destroy(input = {}, signal) {
    const binding = await readBinding();
    const agentId = binding?.agentId || text(input.agentId);
    if (!AGENT_ID.test(agentId)) throw fail('ASSISTANT_NOT_CREATED', '当前没有可关闭的个人助理', 409);
    const confirmed = text(input.confirmAgentId);
    if (!confirmed) throw fail('ASSISTANT_DELETE_CONFIRMATION_REQUIRED', '关闭个人助理需要再次确认', 409, { agentId });
    if (confirmed !== agentId) throw fail('ASSISTANT_DELETE_CONFIRMATION_REQUIRED', '确认的实例标识与当前绑定不一致，请刷新后重试', 409, { agentId });
    if (typeof getDeploymentClient !== 'function') throw fail('ASSISTANT_DELETE_UNAVAILABLE', '当前 Studio 版本不支持关闭个人助理', 503);
    let client;
    try { client = await getDeploymentClient(); }
    catch { throw fail('ASSISTANT_DELETE_UNAVAILABLE', '暂时无法连接云端控制面，请稍后重试', 503); }
    try { await client.forAgent(agentId).remove({ signal }); }
    catch (error) {
      // A missing agent is already closed; everything else keeps the binding so
      // the user can retry the same instance instead of losing the reference.
      if (Number(error?.status) === 404 || /not found|not exist|未找到/iu.test(String(error?.message))) { /* already gone */ }
      else throw fail('ASSISTANT_DELETE_FAILED', String(error?.message || '云端未能关闭个人助理，请稍后重试').slice(0, 240), Number(error?.status) >= 400 && Number(error?.status) <= 599 ? Number(error.status) : 503);
    }
    await rm(file, { force: true });
    cached = null; cacheAt = 0;
    return { configured: false, agentId, closed: true };
  }

  return Object.freeze({ configuration, issueTicket, status, connect, create, disconnect, destroy });
}

/** The service shape the standalone plugin consumes via `ctx.get()`. */
export function assistantDesktopService(impl) {
  return Object.freeze({ format: SERVICE, configuration: impl.configuration, issueTicket: impl.issueTicket,
    status: impl.status, connect: impl.connect, create: impl.create, disconnect: impl.disconnect, destroy: impl.destroy });
}

export const ASSISTANT_DESKTOP_SERVICE = SERVICE;
