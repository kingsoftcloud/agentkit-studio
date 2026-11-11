import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { Agent } from 'undici';
import { setTimeout as sleep } from 'node:timers/promises';
import { ENGINE_PROTOCOL } from './engine-protocol-client.mjs';

const RETRYABLE_RPC = new Set(['initialize', 'run/start', 'run/status', 'run/events', 'run/approve', 'ui/view']);

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
export function connectEngineService({ endpoint, token, sessionId, onApproveTool, onCallTool, requiredToolPolicy, fetchImpl = fetch }) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new Error('engine_service_binding_invalid');
  const root = engineServiceEndpoint(endpoint, token) + '/v1/sessions/' + sessionId + '/';
  const lifetime = new AbortController();
  let poll, initializing;
  const initialization = { protocolVersions: [ENGINE_PROTOCOL], host: { name: 'agentkit-studio' },
    services: { approvals: Boolean(onApproveTool), durableApprovals: Boolean(onApproveTool), tools: Boolean(onCallTool) } };

  async function request(path, body) {
    const headers = { authorization: 'Bearer ' + token };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response;
    try {
      response = await fetchImpl(root + path, { headers, redirect: 'error',
        signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(35000)]),
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    } catch (error) {
      // Fetch can reuse a socket the old worker closed during replacement.
      const transient = ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'UND_ERR_SOCKET'].includes(error?.cause?.code);
      throw Object.assign(new Error('engine_service_transport_unavailable', { cause: error }), { transient });
    }
    if (!response.ok) {
      const body = [404, 409].includes(response.status) ? await response.json().catch(() => null) : null;
      throw Object.assign(new Error('engine_service_http_' + response.status), {
        code: body?.error === 'session_not_found' ? -32010 : undefined,
        transient: body?.error === 'request_unavailable' || [502, 503, 504].includes(response.status),
      });
    }
    return response.json();
  }

  async function rpc(method, params) {
    const id = randomUUID();
    const response = await request('rpc', { jsonrpc: '2.0', id, method, params });
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

  function initialize() {
    initializing ??= exchange('initialize', initialization).then(result => {
      if (requiredToolPolicy && (result.capabilities?.toolPolicy !== requiredToolPolicy
        || result.capabilities?.approvals !== 'durable'))
        throw Object.assign(new Error('当前 Harness 服务不支持该 Agent 的工具审批规则。'),
          { code: 'NATIVE_ENGINE_TOOL_POLICY_UNAVAILABLE' });
      if ((onCallTool || onApproveTool && result.capabilities?.approvals !== 'durable') && !poll)
        poll = pollHost().catch(() => { poll = undefined; });
      return result;
    }).finally(() => { initializing = null; });
    return initializing;
  }

  async function call(method, params = {}) {
    try { return await exchange(method, params); }
    catch (error) {
      // A replacement worker reopens the same persisted session. A frame
      // rejected before initialization has not reached its method handler.
      if (error.code !== -32010 || lifetime.signal.aborted) throw error;
      await initialize();
      return exchange(method, params);
    }
  }

  async function reply(frame) {
    const envelope = { jsonrpc: '2.0', id: frame.id };
    if (frame.method === 'host/approveTool') {
      let decision = 'deny';
      try { if (await onApproveTool?.(frame.params) === 'allow') decision = 'allow'; } catch { /* deny */ }
      envelope.result = { decision };
    } else if (frame.method === 'host/callTool' && onCallTool) {
      try { envelope.result = await onCallTool(frame.params); }
      catch { envelope.result = { status: 'error', content: { code: 'host_tool_failed' } }; }
    } else envelope.error = { code: -32601, message: 'Unsupported host method' };
    if (!lifetime.signal.aborted) await request('host-reply', envelope);
  }

  async function pollHost() {
    while (!lifetime.signal.aborted) {
      const { requests } = await request('host-requests');
      for (const frame of requests) {
        // These ephemeral callbacks belong to the original worker. A
        // replacement worker will recover them from its Run's effect policy.
        void reply(frame).catch(() => {});
      }
      await sleep(125, undefined, { signal: lifetime.signal });
    }
  }

  return {
    initialize,
    startRun: params => call('run/start', params),
    status: runId => call('run/status', { runId }),
    events: (runId, cursor = 0, waitMs = 0) => call('run/events', { runId, cursor, waitMs, follow: true }),
    resume: runId => call('run/resume', { runId }),
    approve: (runId, interactionId, decision) => call('run/approve', { runId, interactionId, decision }),
    cancel: runId => call('run/cancel', { runId }),
    view: sha256 => call('ui/view', sha256 === undefined ? {} : { sha256 }),
    async close() {
      lifetime.abort();
      await poll;
    },
  };
}
