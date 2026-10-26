import { createNativeHostRemote } from './remote/node-client.mjs';
import { validateOperationResponse } from './contracts/transport.mjs';
/**
 * Narrow browser-to-AgentKit Host transport used by the Studio product layer.
 *
 * The DSH renderer remains the only conversation/session UI owner. This
 * module only carries the typed control-plane calls that Studio owns. It is
 * deliberately fetch based so the same contract can be used by Web and the
 * desktop application without introducing a second state store.
 */

export class StudioHostError extends Error {
  constructor(message, { status = 0, code = 'HOST_UNAVAILABLE', details } = {}) {
    super(message);
    this.name = 'StudioHostError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function safeMessage(payload, status) {
  if (payload && typeof payload === 'object') {
    const error = payload.error;
    if (error && typeof error === 'object' && typeof error.message === 'string') return error.message;
    if (typeof payload.message === 'string') return payload.message;
    if (typeof payload.detail === 'string') return payload.detail;
  }
  return `Studio Host request failed (${status || 'network'})`;
}

/**
 * @param {{baseUrl?: string, fetchImpl?: typeof fetch, sessionToken?: string, csrfToken?: string, connection?: import('./contracts/wire.mjs').StudioConnection}} options
 */
export function createStudioHostRemote(options = {}) {
  if (options.connection !== undefined) return createNativeHostRemote(options, StudioHostError);
  const baseUrl = String(options.baseUrl || '').replace(/\/$/, '');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is required for Studio Host Remote');
  let csrfToken = options.csrfToken || null;
  let sessionToken = options.sessionToken || null;

  async function request(path, init = {}) {
    const method = init.method || 'GET';
    const headers = new Headers(init.headers || {});
    headers.set('Accept', 'application/json');
    if (init.body !== undefined && !headers.has('Content-Type') && !(typeof FormData !== 'undefined' && init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
    if (method !== 'GET' && method !== 'HEAD' && csrfToken) headers.set('X-CSRF-Token', csrfToken);
    if (sessionToken) headers.set('X-AgentKit-Session', sessionToken);
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, { ...init, method, headers, credentials: 'include' });
    } catch (error) {
      throw new StudioHostError('Studio Host 不可达', { details: { cause: error?.name || 'NetworkError' } });
    }
    const text = await response.text();
    let payload = null;
    if (text) {
      try { payload = JSON.parse(text); } catch { payload = { detail: text.slice(0, 256) }; }
    }
    if (!response.ok) {
      const error = payload?.error || payload || {};
      throw new StudioHostError(safeMessage(payload, response.status), {
        status: response.status,
        code: typeof error.code === 'string' ? error.code : 'HOST_REQUEST_FAILED',
        details: error.details,
      });
    }
    return payload;
  }

  async function streamRequest(path, init = {}) {
    const method = init.method || 'GET';
    const headers = new Headers(init.headers || {});
    headers.set('Accept', 'text/event-stream');
    if (init.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    if (method !== 'GET' && method !== 'HEAD' && csrfToken) headers.set('X-CSRF-Token', csrfToken);
    if (sessionToken) headers.set('X-AgentKit-Session', sessionToken);
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, { ...init, method, headers, credentials: 'include' });
    } catch (error) {
      throw new StudioHostError('Studio Host 不可达', { details: { cause: error?.name || 'NetworkError' } });
    }
    if (!response.ok || !response.body) {
      const text = await response.text();
      let payload = null;
      if (text) {
        try { payload = JSON.parse(text); } catch { payload = { detail: text.slice(0, 256) }; }
      }
      const error = payload?.error || payload || {};
      throw new StudioHostError(safeMessage(payload, response.status), {
        status: response.status,
        code: typeof error.code === 'string' ? error.code : 'HOST_STREAM_FAILED',
        details: error.details,
      });
    }
    return response;
  }

  async function exchangeSession(token = sessionToken) {
    if (!token) return null;
    const result = await request('/api/v1/system/session', {
      method: 'POST', body: JSON.stringify({ token }),
    });
    csrfToken = result?.csrfToken || csrfToken;
    return result;
  }

  async function nativeChildOperation(operation, payload, signal) {
    const reply = await request('/agentkit', { method: 'POST', body: JSON.stringify({ method: operation, payload }), signal });
    const envelope = reply?.result;
    validateOperationResponse(operation, envelope);
    if (!envelope.ok) throw new StudioHostError(envelope.error?.message || 'Native child operation failed', {
      code: envelope.error?.code, status: envelope.error?.status, details: envelope.error?.details });
    return envelope.value;
  }

  return {
    get csrfToken() { return csrfToken; },
    get sessionToken() { return sessionToken; },
    setSessionToken(token) { sessionToken = token || null; },
    exchangeSession,
    health: () => request('/api/v1/system/health'),
    bootstrap: () => request('/api/v1/system/bootstrap'),
    capabilities: () => request('/api/v1/capabilities'),
    settings: () => request('/api/v1/system/settings'),
    updateSettings: payload => request('/api/v1/system/settings', { method: 'PUT', body: JSON.stringify(payload) }),
    runtimes: () => request('/api/v1/catalog/runtimes'),
    // Older Hosts return a top-level array while newer collection routes use
    // `{ items }`. Keep the browser contract stable across both responses.
    agents: async ({ query = '', page = 1, pageSize = 50, limit } = {}) => {
      const size = limit ?? pageSize;
      const pageParam = page !== 1 ? `&page=${encodeURIComponent(page)}` : '';
      const payload = await request(`/api/v1/agents?limit=${encodeURIComponent(size)}&query=${encodeURIComponent(query)}${pageParam}`);
      return Array.isArray(payload) ? { items: payload } : payload;
    },
    agent: id => request(`/api/v1/agents/${encodeURIComponent(id)}`),
    createAgent: payload => request('/api/v1/agents', { method: 'POST', body: JSON.stringify(payload) }),
    quickAuthorAgent: payload => request('/api/v1/authoring/quick', { method: 'POST', body: JSON.stringify(payload) }),
    composeAuthoringConversation: payload => request('/api/v1/authoring/conversations:compose', { method: 'POST', body: JSON.stringify(payload) }),
    authoringConversationStatus: requestId => request(`/api/v1/authoring/conversations:status/${encodeURIComponent(requestId)}`),
    updateAgent: (id, payload) => request(`/api/v1/agents/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(payload) }),
    deleteAgent: id => request(`/api/v1/agents/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    models: () => request('/api/v1/catalog/models'),
    resources: (query = '') => request(`/api/v1/catalog/resources${query ? `?${query}` : ''}`),
    createMcpResource: payload => request('/api/v1/catalog/mcp-servers', { method: 'POST', body: JSON.stringify(payload) }),
    updateMcpResource: (resourceId, payload) => request(`/api/v1/catalog/mcp-servers/${encodeURIComponent(resourceId)}`, { method: 'PUT', body: JSON.stringify(payload) }),
    probeMcpResource: (resourceId, timeoutSeconds = 15) => request(`/api/v1/catalog/mcp-servers/${encodeURIComponent(resourceId)}:probe?timeoutSeconds=${encodeURIComponent(timeoutSeconds)}`, { method: 'POST' }),
    discoverSkills: scanPaths => request('/api/v1/catalog/skills:discover', { method: 'POST', body: JSON.stringify({ scanPaths: Array.isArray(scanPaths) ? scanPaths : [] }) }),
    previewDiscoveredSkill: (inspectionToken, candidateId, path) => request(`/api/v1/catalog/skills/discoveries/${encodeURIComponent(inspectionToken)}/candidates/${encodeURIComponent(candidateId)}/files${path ? `?path=${encodeURIComponent(path)}` : ''}`),
    commitDiscoveredSkill: (inspectionToken, candidateId, overwrite = false) => request(`/api/v1/catalog/skills/discoveries/${encodeURIComponent(inspectionToken)}:commit`, { method: 'POST', body: JSON.stringify({ candidateId, overwrite }) }),
    previewInstalledSkill: (resourceId, path) => request(`/api/v1/catalog/skills/${encodeURIComponent(resourceId)}/files${path ? `?path=${encodeURIComponent(path)}` : ''}`),
    credential: name => request(`/api/v1/credentials/${encodeURIComponent(name)}`),
    putCredential: (name, value) => request(`/api/v1/credentials/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify({ value, persistence: 'session' }) }),
    deleteCredential: name => request(`/api/v1/credentials/${encodeURIComponent(name)}`, { method: 'DELETE' }),
    probeModelEndpoint: payload => request('/api/v1/model-endpoints:probe', { method: 'POST', body: JSON.stringify(payload) }),
    testModelProfile: id => request(`/api/v1/model-profiles/${encodeURIComponent(id)}:test`, { method: 'POST', body: '{}' }),
    sessions: (query = '') => request(`/api/v1/sessions${query ? `?${query}` : ''}`),
    sessionSnapshot: (id, query = '') => request(`/api/v1/sessions/${encodeURIComponent(id)}/snapshot${query ? `?${query}` : ''}`),
    sessionCommand: (id, payload) => request(`/api/v1/sessions/${encodeURIComponent(id)}/commands`, { method: 'POST', body: JSON.stringify(payload) }),
    streamAgentConversation: async (agentId, sessionId, input, signal) => {
      const surface = await request(`/api/v1/agents/${encodeURIComponent(agentId)}/conversation-surface?sessionId=${encodeURIComponent(sessionId)}`);
      const buildId = String(surface?.buildId || '').trim();
      if (!buildId) throw new StudioHostError('Agent 尚无可运行的 Build', { status: 409, code: 'BUILD_NOT_READY' });
      return streamRequest(`/api/v1/builds/${encodeURIComponent(buildId)}/conversation:stream`, {
        method: 'POST',
        headers: { 'Idempotency-Key': input.idempotencyKey },
        body: JSON.stringify({ input }),
        signal,
      });
    },
    evaluationTargets: (query = '') => request(`/api/v1/evaluation-targets${query ? `?${query}` : ''}`),
    evaluations: (query = '') => request(`/api/v1/evaluations${query ? `?${query}` : ''}`),
    evaluation: id => request(`/api/v1/evaluations/${encodeURIComponent(id)}`),
    evaluationRun: id => request(`/api/v1/evaluation-runs/${encodeURIComponent(id)}`),
    evaluationRuns: (query = '') => request(`/api/v1/evaluation-runs${query ? `?${query}` : ''}`),
    createEvaluation: (payload, idempotencyKey) => request('/api/v1/evaluations', { method: 'POST', headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined, body: JSON.stringify(payload) }),
    importEvaluationFile: body => request('/api/v1/evaluation-files', { method: 'POST', body }),
    tracesOverview: (query = '') => request(`/api/v1/traces/overview${query ? `?${query}` : ''}`),
    traces: (query = '') => request(`/api/v1/traces${query ? `?${query}` : ''}`),
    trace: id => request(`/api/v1/traces/${encodeURIComponent(id)}`),
    traceOtlp: id => request(`/api/v1/traces/${encodeURIComponent(id)}/otlp`),
    exportSessionLog: (id, query = '') => request(`/api/v1/sessions/${encodeURIComponent(id)}:export${query ? `?${query}` : ''}`),
    nativeChildHistory: (payload, signal) => nativeChildOperation('sessions/native-child-history', payload, signal),
    nativeRecoveryStatus: (payload, signal) => nativeChildOperation('sessions/native-recovery-status', payload, signal),
    resumeNativeRun: (payload, signal) => nativeChildOperation('sessions/native-recovery-resume', payload, signal),
    reconcileNativeTool: (payload, signal) => nativeChildOperation('sessions/native-recovery-reconcile', payload, signal),
    repairNativeWorkspace: (payload, signal) => nativeChildOperation('sessions/native-workspace-repair', payload, signal),
    nativeConversationStatus: (payload, signal) => nativeChildOperation('sessions/native-conversation-status', payload, signal),
    rewindNativeConversation: (payload, signal) => nativeChildOperation('sessions/native-conversation-rewind', payload, signal),
    previewNativeConversationWorkspace: (payload, signal) => nativeChildOperation('sessions/native-conversation-workspace-preview', payload, signal),
    controlNativeA2aTask: (payload, signal) => nativeChildOperation('sessions/native-a2a-control', payload, signal),
    dshA2aTaskHistory: (payload, signal) => nativeChildOperation('sessions/dsh-a2a-history', payload, signal),
    controlDshA2aTask: (payload, signal) => nativeChildOperation('sessions/dsh-a2a-control', payload, signal),
    nativeChildResult: (payload, signal) => nativeChildOperation('sessions/native-child-result', payload, signal),
    promoteNativeChild: (payload, signal) => nativeChildOperation('sessions/native-child-promote', payload, signal),
    sendNativeChildInput: (payload, signal) => nativeChildOperation('sessions/native-child-send', payload, signal),
    cancelNativeChild: (payload, signal) => nativeChildOperation('sessions/native-child-cancel', payload, signal),
    channelConnection: () => request('/api/v1/channels/connection'),
    updateChannelConnection: payload => request('/api/v1/channels/connection', { method: 'PUT', body: JSON.stringify(payload) }),
    updateAgentChannelConnection: (id, payload) => request(`/api/v1/channels/agents/${encodeURIComponent(id)}/connection`, { method: 'PUT', body: JSON.stringify(payload) }),
    // The legacy Studio channel surface is an external channel control-plane
    // contract. Keep it as a narrow Host call instead of recreating a channel
    // database in the DSH plugin. Hosts that do not install the connector
    // return a typed unavailable error and the page stays honest.
    channelAction: (action, payload = {}) => request(`/agentengine/api/v1/${encodeURIComponent(action)}`, { method: 'POST', body: JSON.stringify(payload) }),
  };
}
