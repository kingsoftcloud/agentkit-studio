import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { Agent } from 'undici';
import { setTimeout as sleep } from 'node:timers/promises';
import { ENGINE_PROTOCOL } from './engine-protocol-client.mjs';

const RETRYABLE_RPC = new Set(['initialize', 'run/start', 'run/status', 'run/events', 'run/approve', 'run/guide', 'ui/view']);
// Every operation here is either read-only or has a durable identity supplied by Studio.
const ATTACHED_RPC = new Set(['run/start', 'run/status', 'run/events', 'run/approve', 'run/guide']);
const RETRYABLE_SOCKET_ERRORS = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT']);
export const ENGINE_TOOL_RECEIPT = 'agentkit.tool-receipt-observation/v1';

export function engineServiceEndpoint(endpoint, token) {
  const url = new URL(endpoint);
  const localHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !localHttp || url.username || url.password || url.search || url.hash
    || typeof token !== 'string' || token.length < 24)
    throw new Error('engine_service_binding_invalid');
  return url.href.replace(/\/+$/, '');
}

export function engineServiceFetch(endpoint, caFile) {
  if (caFile === undefined) return fetch;
  if (typeof caFile !== 'string' || !isAbsolute(caFile) || new URL(endpoint).protocol !== 'https:')
    throw new Error('engine_service_ca_binding_invalid');
  const dispatcher = new Agent({ connect: { ca: readFileSync(caFile) } });
  return (url, options) => fetch(url, { ...options, dispatcher });
}

export async function fetchEngineServiceView(endpoint, token, sha256, fetchImpl = fetch) {
  if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) return null;
  const response = await fetchImpl(engineServiceEndpoint(endpoint, token) + '/v1/views/' + sha256, {
    headers: { authorization: 'Bearer ' + token }, redirect: 'error', signal: AbortSignal.timeout(5000),
  });
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok || !response.headers.get('content-type')?.startsWith('text/html') || !response.body) {
    await response.body?.cancel();
    throw new Error('engine_service_view_unavailable');
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > 2 * 1024 * 1024) throw new Error('engine_service_view_too_large');
    chunks.push(chunk);
  }
  const html = Buffer.concat(chunks);
  if (createHash('sha256').update(html).digest('hex') !== sha256) throw new Error('engine_service_view_mismatch');
  return html.toString('utf8');
}

/** Host-side network transport for agentkit.engine/v1. */
export function connectEngineService({ endpoint, token, sessionId, runId, onApproveTool, onCallTool, onReadToolReceipt,
  requiredToolPolicy, requiredToolEffects, observeOnly = false, runSignal, fetchImpl = fetch }) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new Error('engine_service_binding_invalid');
  const root = engineServiceEndpoint(endpoint, token) + '/v1/sessions/' + sessionId + '/';
  const lifetime = new AbortController();
  const attachment = runSignal ? AbortSignal.any([lifetime.signal, runSignal]) : lifetime.signal;
  let poll, initializing;
  const initialization = { protocolVersions: [ENGINE_PROTOCOL], host: { name: 'agentkit-studio', ...(observeOnly ? { observeOnly } : {}) },
    services: { approvals: Boolean(onApproveTool), durableApprovals: Boolean(onApproveTool), tools: Boolean(onCallTool),
      ...(requiredToolEffects ? { toolEffects: 'agentkit.engine-host-tool-effect/v1' } : {}),
      ...(onReadToolReceipt ? { toolReceipts: ENGINE_TOOL_RECEIPT } : {}) } };
  const requestPath = runId ? 'host-requests?' + new URLSearchParams({ runId, receiver: randomUUID() }) : 'host-requests';
  // One callback execution per frame for this attached Run. A transport
  // retry may resend the already computed reply, never rerun the effect.
  const hostReplies = new Map();

  async function request(path, body, signal = lifetime.signal) {
    const headers = { authorization: 'Bearer ' + token };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(35000)]);
    let response;
    const transportError = error => {
      signal.throwIfAborted();
      // The connection can disappear after response headers but before the JSON body.
      const transient = requestSignal.reason?.name === 'TimeoutError' || error?.name === 'TimeoutError'
        || RETRYABLE_SOCKET_ERRORS.has(error?.cause?.code ?? error?.code);
      return Object.assign(new Error('engine_service_transport_unavailable', { cause: error }), { transient });
    };
    try {
      response = await fetchImpl(root + path, { headers, redirect: 'error',
        signal: requestSignal,
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    } catch (error) {
      throw transportError(error);
    }
    if (!response.ok) {
      const body = [404, 409].includes(response.status) ? await response.json().catch(() => null) : null;
      throw Object.assign(new Error('engine_service_http_' + response.status), {
        code: body?.error === 'session_not_found' ? -32010 : undefined,
        transient: body?.error === 'request_unavailable' || [502, 503, 504].includes(response.status),
        hostReplyGone: body?.error === 'host_request_not_found',
      });
    }
    try { return await response.json(); }
    catch (error) {
      if (error instanceof SyntaxError) throw new Error('engine_service_reply_invalid', { cause: error });
      throw transportError(error);
    }
  }

  async function rpc(method, params, signal) {
    const id = randomUUID();
    const response = await request('rpc', { jsonrpc: '2.0', id, method, params }, signal);
    if (response?.jsonrpc !== '2.0' || response.id !== id) throw new Error('engine_service_reply_invalid');
    if (response.error) throw Object.assign(new Error(response.error.message), { code: response.error.code });
    return response.result;
  }

  async function exchange(method, params) {
    for (let delay = 125, deadline = Date.now() + 15000; ;) {
      try { return await rpc(method, params); }
      catch (error) {
        if (!RETRYABLE_RPC.has(method) || method === 'run/start' && !params.runId || !error.transient
          || lifetime.signal.aborted || Date.now() + delay >= deadline) throw error;
        await sleep(delay, undefined, { signal: lifetime.signal });
        delay = Math.min(delay * 2, 2000);
      }
    }
  }

  function initialize(reattaching = false) {
    initializing ??= (reattaching ? rpc('initialize', initialization, attachment)
      : exchange('initialize', initialization)).then(result => {
      if (requiredToolPolicy && (result.capabilities?.toolPolicy !== requiredToolPolicy
        || result.capabilities?.approvals !== 'durable'))
        throw Object.assign(new Error('当前 Harness 服务不支持该 Agent 的工具审批规则。'),
          { code: 'NATIVE_ENGINE_TOOL_POLICY_UNAVAILABLE' });
      if (requiredToolEffects && result.capabilities?.hostToolEffects !== initialization.services.toolEffects)
        throw Object.assign(new Error('当前 Harness 服务不支持已绑定工具的持久执行回执。'),
          { code: 'NATIVE_ENGINE_TOOL_EFFECT_UNAVAILABLE' });
      if ((onCallTool || onReadToolReceipt || onApproveTool && result.capabilities?.approvals !== 'durable') && !poll)
        poll = pollHost().catch(() => { poll = undefined; });
      return result;
    }).finally(() => { initializing = null; });
    return initializing;
  }

  async function call(method, params = {}) {
    const attached = !observeOnly && !!runId && params.runId === runId && ATTACHED_RPC.has(method);
    const signal = attached ? attachment : lifetime.signal;
    const attempt = () => attached ? rpc(method, params, signal) : exchange(method, params);
    // Keep the Studio turn attached to its original identity and cursor for
    // as long as the user keeps it open. The service reclaims the durable Run
    // on a following event read; this loop never issues run/resume or a tool call.
    for (let delay = 125; ;) {
      signal.throwIfAborted();
      try {
        try { return await attempt(); }
        catch (error) {
          if (error.code !== -32010) throw error;
          signal.throwIfAborted();
          await initialize(attached);
          return await attempt();
        }
      } catch (error) {
        signal.throwIfAborted();
        if (!attached || !error.transient && error.code !== -32010) throw error;
        await sleep(delay, undefined, { signal });
        delay = Math.min(delay * 2, 2000);
      }
    }
  }

  async function hostReply(frame) {
    const envelope = { jsonrpc: '2.0', id: frame.id };
    if (frame.method === 'host/approveTool') {
      let decision = 'deny';
      try { if (await onApproveTool?.(frame.params) === 'allow') decision = 'allow'; } catch { /* deny */ }
      envelope.result = { decision };
    } else if (frame.method === 'host/callTool' && onCallTool) {
      try { envelope.result = await onCallTool(frame.params); }
      catch { envelope.result = { status: frame.params?.effect ? 'uncertain' : 'error', content: { code: 'host_tool_failed' } }; }
    } else if (frame.method === 'host/readToolReceipt' && onReadToolReceipt) {
      try {
        const expiresIn = frame.expiresAt - Date.now();
        if (!Number.isSafeInteger(expiresIn) || expiresIn <= 0) return;
        const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(expiresIn)]);
        envelope.result = await onReadToolReceipt(frame.params, signal);
      } catch { envelope.error = { code: -32603, message: 'Host receipt unavailable' }; }
    } else envelope.error = { code: -32601, message: 'Unsupported host method' };
    return envelope;
  }

  function reply(frame) {
    const now = Date.now();
    for (const [id, state] of hostReplies) if (state.expiresAt <= now) hostReplies.delete(id);
    if (typeof frame?.id !== 'string' || !Number.isSafeInteger(frame.expiresAt) || frame.expiresAt <= now) return;
    let state = hostReplies.get(frame.id);
    if (state) return;
    state = { expiresAt: frame.expiresAt };
    hostReplies.set(frame.id, state);
    void (async () => {
      const envelope = await hostReply(frame);
      if (!envelope) return;
      for (let delay = 125; !attachment.aborted && Date.now() < state.expiresAt;) {
        const signal = AbortSignal.any([attachment, AbortSignal.timeout(Math.max(1, state.expiresAt - Date.now()))]);
        try { await request('host-reply', envelope, signal); return; }
        catch (error) {
          if (error.hostReplyGone || !error.transient || Date.now() + delay >= state.expiresAt) return;
          await sleep(delay, undefined, { signal });
          delay = Math.min(delay * 2, 2000);
        }
      }
    })().catch(() => {});
  }

  async function pollHost() {
    let backoff = 125;
    while (!lifetime.signal.aborted) {
      let requests;
      try { ({ requests } = await request(requestPath, undefined, attachment)); }
      catch (error) {
        if (!error.transient && error.code !== -32010) throw error;
        await sleep(backoff, undefined, { signal: lifetime.signal });
        backoff = Math.min(backoff * 2, 2000);
        continue;
      }
      backoff = 125;
      for (const frame of requests) {
        // These ephemeral callbacks belong to the original worker. A
        // replacement worker will recover them from its Run's effect policy.
        reply(frame);
      }
      await sleep(125, undefined, { signal: attachment });
    }
  }

  return {
    initialize: () => initialize(),
    startRun: params => call('run/start', params),
    status: (runId, options) => call('run/status', { runId, ...options }),
    events: (runId, cursor = 0, waitMs = 0, thinkingCursor, toolDraftCursor) =>
      call('run/events', { runId, cursor, waitMs, thinkingCursor, toolDraftCursor, follow: true }),
    resume: runId => call('run/resume', { runId }),
    approve: (runId, interactionId, reply) => call('run/approve', { runId, interactionId,
      decision: typeof reply === 'string' ? reply : reply.decision,
      ...(reply?.denialReason === undefined ? {} : { denialReason: reply.denialReason }) }),
    cancel: runId => call('run/cancel', { runId }),
    guide: (runId, inputId, text) => call('run/guide', { runId, inputId, text }),
    view: sha256 => call('ui/view', sha256 === undefined ? {} : { sha256 }),
    async close() {
      lifetime.abort();
      await poll;
    },
  };
}
