/** Workload-authenticated internal A2A Actions. No retries, credential cache,
 * public-service fallback or remote message dispatch. The Host persists each
 * potential-effect intent before calling this transport. */
import { createHash, randomUUID } from 'node:crypto';
import { canonical, copy, invariant, parseNativeJson } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { hostFetch } from '../http-fetch.mjs';
import { A2A_EVENT_PERMANENT_ERRORS } from './native-a2a-events.mjs';

export const INTERNAL_A2A_CONTROL_PLANE = 'agentkit.a2a-internal-control-plane/v1';
const prefix = '/agentengine/internal/v1/a2a/';
const audiences = Object.freeze({ ListA2ASpaceAgents: 'a2a-registry', PrepareA2ACall: 'a2a-registry',
  PrepareA2ATaskOperation: 'a2a-registry', BindA2ARemoteTask: 'a2a-task-sink', AppendA2ATaskEvents: 'a2a-task-sink',
  AppendA2AProductKernelFacts: 'a2a-task-sink', ListA2AProductKernelTasks: 'a2a-task-sink',
  SubmitA2AInboundMessage: 'a2a-registry', CancelA2AInboundTask: 'a2a-registry', ResolveA2ACredential: 'credential-broker' });
const kinds = new Set(['hosted_gateway', 'external_public', 'external_vpc']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const sha = value => createHash('sha256').update(canonical(value)).digest('hex');
const observe = value => { void Promise.resolve(value).catch(() => {}); };
const discard = response => { try { if (response?.body?.cancel) observe(response.body.cancel()); } catch {} };
const string = (value, max = 4096) => {
  invariant(typeof value === 'string' && value && value.length <= max && !value.includes('\0'), 'A2A_CONTROL_PLANE_FIELD_INVALID'); return value;
};
export function a2aResourceId(value, kind) {
  string(value, 256); const uuid = /^[a-f0-9]{12}4[a-f0-9]{3}[89ab][a-f0-9]{15}$/u;
  invariant(value.startsWith(`a2a-${kind}-`) && uuid.test(value.slice(`a2a-${kind}-`.length))
    || ['agent', 'version'].includes(kind) && uuid.test(value)
    || kind === 'space' && /^as-[a-f0-9]{12}$/u.test(value), 'A2A_CONTROL_PLANE_RESOURCE_INVALID'); return value;
}
function target(raw) {
  invariant(object(raw), 'A2A_CONTROL_PLANE_TARGET_INVALID');
  return { agentId: a2aResourceId(raw.A2AAgentId, 'agent'), versionId: a2aResourceId(raw.VersionId, 'version'), cardSha256: string(raw.CardSha256) };
}
function stringMap(raw) {
  if (raw == null) return {};
  invariant(object(raw) && Object.keys(raw).length <= 100, 'A2A_CREDENTIAL_INJECTION_INVALID');
  let bytes = 0;
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => {
    invariant(key && typeof value === 'string' && !key.includes('\0') && !value.includes('\0'), 'A2A_CREDENTIAL_INJECTION_INVALID');
    bytes += Buffer.byteLength(key) + Buffer.byteLength(value); invariant(bytes <= 32 * 1024, 'A2A_CREDENTIAL_INJECTION_INVALID');
    return [key, value];
  }));
}
export function preparedA2AOperation(raw) {
  invariant(object(raw) && object(raw.Route) && kinds.has(raw.Route.Kind) && object(raw.Route.Interface), 'A2A_CONTROL_PLANE_ROUTE_INVALID');
  const iface = raw.Route.Interface, streaming = raw.Route.Capabilities?.Streaming ?? false;
  invariant((raw.Route.Capabilities === undefined || object(raw.Route.Capabilities)) && typeof streaming === 'boolean'
    && iface.ProtocolVersion === '1.0' && ['JSONRPC', 'HTTP+JSON'].includes(iface.ProtocolBinding), 'A2A_CONTROL_PLANE_PROTOCOL_INVALID');
  invariant(raw.RemoteTask == null || object(raw.RemoteTask), 'A2A_CONTROL_PLANE_REMOTE_INVALID');
  return { taskId: a2aResourceId(raw.A2ATaskId, 'task'), target: target(raw.Target),
    route: { kind: raw.Route.Kind, streaming, url: string(iface.Url), protocolBinding: iface.ProtocolBinding, protocolVersion: iface.ProtocolVersion },
    permit: string(raw.CallPermit, 64 * 1024), expiresAt: string(raw.CallPermitExpiresAt),
    credentialHandle: raw.CredentialHandle == null ? null : string(raw.CredentialHandle),
    remoteTask: raw.RemoteTask == null ? null : { id: string(raw.RemoteTask.RemoteTaskId),
      contextId: raw.RemoteTask.RemoteContextId ? string(raw.RemoteTask.RemoteContextId) : null } };
}

export function createInternalA2AControlPlane({ baseUrl, tokenProvider, fetchImpl = hostFetch, allowPrivate = false, timeoutMs = 15000 } = {}) {
  const base = new URL(baseUrl);
  invariant(['https:', 'http:'].includes(base.protocol) && !base.username && !base.password && !base.search && !base.hash
    && (base.protocol === 'https:' || allowPrivate || ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)), 'A2A_CONTROL_PLANE_URL_INVALID');
  invariant(tokenProvider && typeof tokenProvider.getToken === 'function' && typeof fetchImpl === 'function'
    && Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 90000, 'A2A_CONTROL_PLANE_CONFIGURATION_INVALID');
  const getToken = tokenProvider.getToken, tokenBinding = copy(tokenProvider.binding ?? null), lifetime = new AbortController();
  const binding = Object.freeze({ contract: INTERNAL_A2A_CONTROL_PLANE, bindingDigest: sha({ base: base.href, tokenBinding, timeoutMs, allowPrivate }) });
  function context(request) {
    invariant(object(request) && request.signal instanceof AbortSignal && typeof request.assertCurrent === 'function', 'A2A_CONTROL_PLANE_AUTHORITY_REQUIRED');
    const originalSignal = request.signal, authority = request.assertCurrent;
    const original = canonical(Object.fromEntries(Object.entries(request).filter(([key]) => !['signal', 'assertCurrent'].includes(key))));
    const signal = AbortSignal.any([originalSignal, lifetime.signal, AbortSignal.timeout(timeoutMs)]);
    const unchanged = () => invariant(request.signal === originalSignal && request.assertCurrent === authority
      && canonical(Object.fromEntries(Object.entries(request).filter(([key]) => !['signal', 'assertCurrent'].includes(key)))) === original
      && tokenProvider.getToken === getToken && canonical(tokenProvider.binding ?? null) === canonical(tokenBinding), 'A2A_CONTROL_PLANE_REQUEST_CHANGED');
    function guard() {
      signal.throwIfAborted(); unchanged(); const verdict = authority();
      if (verdict && typeof verdict.then === 'function') observe(verdict);
      invariant(verdict === true, 'A2A_CONTROL_PLANE_AUTHORITY_LOST'); unchanged(); signal.throwIfAborted(); return true;
    }
    async function step(effect, release = () => {}) {
      guard(); let abort, abandoned = false, arrived = false, value;
      const canceled = new Promise((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); });
      const pending = Promise.resolve().then(() => { guard(); return effect(); });
      observe(pending.then(result => { arrived = true; value = result; if (abandoned) release(result); }));
      try { signal.throwIfAborted(); const result = await Promise.race([pending, canceled]); guard(); return result; }
      catch (error) { abandoned = true; if (arrived) release(value); throw error; }
      finally { signal.removeEventListener('abort', abort); }
    }
    return { signal, guard, step };
  }
  async function post(action, payload, request) {
    invariant(Object.hasOwn(audiences, action), 'A2A_CONTROL_PLANE_ACTION_INVALID');
    const ctx = context(request), body = canonical(payload); ctx.guard();
    invariant(Buffer.byteLength(body) <= 2 * 1024 ** 2, 'A2A_CONTROL_PLANE_REQUEST_LIMIT');
    let token;
    try { token = getToken.call(tokenProvider, { audience: audiences[action], signal: ctx.signal, assertCurrent: ctx.guard }); }
    catch { ctx.signal.throwIfAborted(); invariant(false, 'A2A_WORKLOAD_TOKEN_INVALID'); }
    if (token && typeof token.then === 'function') observe(token);
    ctx.guard();
    invariant(typeof token === 'string' && token && token.length <= 16 * 1024 && !/[\r\n]/u.test(token), 'A2A_WORKLOAD_TOKEN_INVALID');
    let response;
    try {
      response = await ctx.step(() => fetchImpl(base.href.replace(/\/$/u, '') + prefix + action, { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}`,
          'X-Ksc-Request-Id': randomUUID(), 'X-Ksc-Source': 'agentkit-studio' }, body, signal: ctx.signal }), discard);
      invariant(response?.body?.getReader, 'A2A_CONTROL_PLANE_INVALID_RESPONSE');
      const reader = response.body.getReader(), chunks = []; let bytes = 0;
      try {
        for (;;) { const chunk = await ctx.step(() => reader.read()); if (chunk.done) break;
          bytes += chunk.value.byteLength; invariant(bytes <= 8 * 1024 ** 2, 'A2A_CONTROL_PLANE_RESPONSE_LIMIT'); chunks.push(chunk.value); }
      } finally { try { observe(reader.cancel()); } catch {} try { reader.releaseLock(); } catch {} }
      ctx.guard(); const envelope = parseNativeJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      invariant(object(envelope) && Number.isSafeInteger(Number(envelope.Code ?? 0)), 'A2A_CONTROL_PLANE_INVALID_RESPONSE');
      if (!response.ok || Number(envelope.Code ?? 0) !== 0) {
        const code = action === 'AppendA2ATaskEvents' && A2A_EVENT_PERMANENT_ERRORS.includes(envelope.Data?.ErrorCode)
          ? envelope.Data.ErrorCode : 'A2A_CONTROL_PLANE_ACTION_FAILED';
        invariant(false, code);
      }
      invariant(object(envelope.Data), 'A2A_CONTROL_PLANE_INVALID_RESPONSE'); ctx.guard(); return copy(envelope.Data);
    } catch (error) {
      discard(response); ctx.signal.throwIfAborted();
      // Never echo server messages, injected headers/query, JWTs or fetch causes.
      const safe = new Set(['A2A_CONTROL_PLANE_INVALID_RESPONSE', 'A2A_CONTROL_PLANE_ACTION_FAILED', 'A2A_CONTROL_PLANE_RESPONSE_LIMIT',
        'A2A_CONTROL_PLANE_REQUEST_CHANGED', 'A2A_CONTROL_PLANE_AUTHORITY_LOST', 'A2A_CONTROL_AUTHORITY_LOST']);
      invariant(false, safe.has(error?.code) || action === 'AppendA2ATaskEvents' && A2A_EVENT_PERMANENT_ERRORS.includes(error?.code)
        ? error.code : 'A2A_CONTROL_PLANE_UNAVAILABLE');
    }
  }
  async function listSpaceAgents(request) {
    const payload = { A2ASpaceId: a2aResourceId(request.spaceId, 'space') };
    for (const [key, wire] of [['cursor', 'Cursor'], ['ifNoneMatch', 'IfNoneMatch'], ['prompt', 'Prompt'], ['skillId', 'SkillId']])
      if (request[key] !== undefined) payload[wire] = string(request[key]);
    if (request.includeBlocked) payload.IncludeBlocked = true;
    if (request.pageSize !== undefined) { invariant(Number.isSafeInteger(request.pageSize) && request.pageSize >= 1 && request.pageSize <= 100, 'A2A_CONTROL_PLANE_PAGE_INVALID'); payload.PageSize = request.pageSize; }
    const raw = await post('ListA2ASpaceAgents', payload, request);
    invariant(Array.isArray(raw.Agents ?? []) && (raw.Agents ?? []).length <= 100 && (raw.NotModified === undefined || typeof raw.NotModified === 'boolean'), 'A2A_CONTROL_PLANE_DISCOVERY_INVALID');
    const agents = (raw.Agents ?? []).map(item => {
      invariant(object(item) && ['hosted', 'external'].includes(item.Source) && kinds.has(item.RouteKind)
        && typeof item.Callable === 'boolean' && object(item.AgentCard), 'A2A_CONTROL_PLANE_DISCOVERY_INVALID');
      return { agent_id: a2aResourceId(item.A2AAgentId, 'agent'), version_id: a2aResourceId(item.VersionId, 'version'),
        name: item.AgentCard.name ?? '', description: item.AgentCard.description ?? '', source: item.Source,
        card_sha256: item.CardSha256 ?? '', card: copy(item.AgentCard), callable: item.Callable,
        route_kind: item.RouteKind, blocked_reason: item.BlockedReason ?? null };
    });
    return { agents, nextCursor: raw.NextCursor == null || raw.NextCursor === '' ? null : string(raw.NextCursor),
      etag: raw.ETag == null || raw.ETag === '' ? null : string(raw.ETag), notModified: raw.NotModified ?? false };
  }
  const digest = value => { invariant(typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value), 'A2A_CONTROL_PLANE_DIGEST_INVALID'); return value; };
  return Object.freeze({ binding, listSpaceAgents, close: () => lifetime.abort(new Error('A2A control plane closed')),
    async prepareCall(request) { return preparedA2AOperation(await post('PrepareA2ACall', {
      A2ASpaceId: a2aResourceId(request.spaceId, 'space'), TargetA2AAgentId: a2aResourceId(request.agentId, 'agent'),
      ExpectedVersionId: a2aResourceId(request.versionId, 'version'), MessageId: string(request.messageId, 128),
      MessageSha256: digest(request.messageSha256), IdempotencyToken: string(request.idempotencyToken, 256) }, request)); },
    async prepareTaskOperation(request) {
      invariant(['send_message', 'get_task', 'cancel_task', 'subscribe_to_task'].includes(request.operation), 'A2A_CONTROL_PLANE_OPERATION_INVALID');
      const payload = { A2ATaskId: a2aResourceId(request.taskId, 'task'), Operation: request.operation };
      if (request.operation === 'send_message') Object.assign(payload, { MessageId: string(request.messageId, 128), MessageSha256: digest(request.messageSha256) });
      else invariant(request.messageId === undefined && request.messageSha256 === undefined, 'A2A_CONTROL_PLANE_OPERATION_INVALID');
      if (['send_message', 'cancel_task'].includes(request.operation)) payload.IdempotencyToken = string(request.idempotencyToken, 256);
      else invariant(request.idempotencyToken === undefined, 'A2A_CONTROL_PLANE_OPERATION_INVALID');
      return preparedA2AOperation(await post('PrepareA2ATaskOperation', payload, request));
    },
    async bindRemoteTask(request) { return post('BindA2ARemoteTask', { A2ATaskId: a2aResourceId(request.taskId, 'task'),
      RemoteTaskId: string(request.remoteTaskId), ...(request.remoteContextId ? { RemoteContextId: string(request.remoteContextId) } : {}),
      ObservedAt: string(request.observedAt) }, request); },
    async appendTaskEvents(request) { invariant(Array.isArray(request.events) && request.events.length <= 100, 'A2A_CONTROL_PLANE_EVENTS_INVALID');
      return post('AppendA2ATaskEvents', { A2ATaskId: a2aResourceId(request.taskId, 'task'), Events: copy(request.events) }, request); },
    async resolveCredential(request) {
      const raw = await post('ResolveA2ACredential', { A2ATaskId: a2aResourceId(request.taskId, 'task'),
        CredentialHandle: request.credentialHandle ?? null, CallPermit: string(request.permit, 64 * 1024) }, request);
      invariant(raw.Injection == null || object(raw.Injection), 'A2A_CREDENTIAL_INJECTION_INVALID');
      return { headers: stringMap(raw.Injection?.Headers), query: stringMap(raw.Injection?.Query), cookies: stringMap(raw.Injection?.Cookies), expiresAt: raw.ExpiresAt ?? null };
    },
    gatewayToken(request) { const ctx = context(request); ctx.guard();
      let token;
      try { token = getToken.call(tokenProvider, { audience: 'a2a-gateway', signal: ctx.signal, assertCurrent: ctx.guard }); }
      catch { ctx.signal.throwIfAborted(); invariant(false, 'A2A_WORKLOAD_TOKEN_INVALID'); }
      if (token && typeof token.then === 'function') observe(token);
      ctx.guard();
      invariant(typeof token === 'string' && token && token.length <= 16 * 1024 && !/[\r\n]/u.test(token), 'A2A_WORKLOAD_TOKEN_INVALID'); return token; },
  });
}
