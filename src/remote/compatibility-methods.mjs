import { callStudioOperation } from '../contracts/transport.mjs';
/** Compatibility operations retained outside the product browser graph. */
export function createCompatibilityMethods({ connection, window, directServer, bridgeAvailable, studioBridgeOperation, serverAction, request, streamBaseUrl, sessionToken, ensureSession, getCsrfToken }) {
    async function streamRequest(path, init = {}) {
        if (directServer() && !path.startsWith('/agentkit/')) {
            const unavailable = new Error(`云端控制面暂未提供流式 REST 合同（${path}）；该流需本地 Studio Host 或 AgentEngine Server 开放对应合同`);
            unavailable.code = 'CLOUD_CONTRACT_UNAVAILABLE';
            unavailable.details = { path };
            throw unavailable;
        }
        if (sessionToken && !getCsrfToken())
            await ensureSession();
        const method = init.method || 'GET';
        const headers = new Headers(init.headers || {});
        headers.set('Accept', 'text/event-stream');
        if (init.body !== undefined && !headers.has('Content-Type'))
            headers.set('Content-Type', 'application/json');
        if (method !== 'GET' && method !== 'HEAD' && getCsrfToken())
            headers.set('X-CSRF-Token', getCsrfToken());
        if (sessionToken)
            headers.set('X-AgentKit-Session', sessionToken);
        let response;
        try {
            response = await window.fetch(streamBaseUrl() + path, { ...init, method, headers, credentials: 'include' });
        }
        catch (error) {
            const unavailable = new Error('Studio Host 不可达');
            unavailable.code = 'HOST_UNAVAILABLE';
            unavailable.cause = error;
            throw unavailable;
        }
        if (!response.ok || !response.body) {
            const text = await response.text();
            let payload = null;
            if (text) {
                try {
                    payload = JSON.parse(text);
                }
                catch {
                    payload = { detail: text.slice(0, 256) };
                }
            }
            const raw = payload?.error || payload || {};
            const failure = new Error(raw.message || payload?.message || payload?.detail || ('Host stream failed (' + response.status + ')'));
            failure.code = raw.code || 'HOST_STREAM_FAILED';
            failure.status = response.status;
            failure.details = raw.details;
            throw failure;
        }
        return response;
    }
    return {
        exchangeSession: ensureSession,
        conversationSurface: (agentId, sessionId) => directServer()
            ? (async () => {
                if (!connection?.rpc?.call)
                    throw Object.assign(new Error('AgentEngine Server 连接不可用'), { code: 'SERVER_CONNECTION_MISSING' });
                const result = await callStudioOperation(connection, 'agents/conversation-surface', { agentId, sessionId });
                if (!result?.ok)
                    throw Object.assign(new Error(result?.error?.message || '会话面解析失败'), { code: result?.error?.code || 'CONVERSATION_SURFACE_FAILED' });
                return result.value;
            })()
            : request('/api/v1/agents/' + encodeURIComponent(agentId) + '/conversation-surface?sessionId=' + encodeURIComponent(sessionId)),
        // Direct Server mode has no legacy Studio REST host. Keep local Agent
        // authoring on the authenticated control-plane bridge so the create
        // wizard does not render a form that can only fail with
        // CLOUD_CONTRACT_UNAVAILABLE.
        createAgent: payload => directServer()
            ? studioBridgeOperation('agents/create-local', payload)
            : request('/api/v1/agents', { method: 'POST', body: JSON.stringify(payload) }),
        composeAuthoringConversation: payload => request('/api/v1/authoring/conversations:compose', { method: 'POST', body: JSON.stringify(payload) }),
        authoringConversationStatus: requestId => request('/api/v1/authoring/conversations:status/' + encodeURIComponent(requestId)),
        updateAgentBindings: (id, bindings, revision) => directServer() && String(id).startsWith('ar-local-')
            ? studioBridgeOperation('agents/update-local', { agentId: id, bindings, expectedRevision: revision })
            : request('/api/v1/agents/' + encodeURIComponent(id) + '/bindings', {
                method: 'PUT',
                headers: { 'If-Match': String(revision) },
                body: JSON.stringify(bindings),
            }),
        build: id => request('/api/v1/builds/' + encodeURIComponent(id)),
        // Host-owned route reserved for the bound-Agent admission contract.
        // The official DSH composer currently has no public sink/input hook,
        // so this helper is not invoked by the native session.prompt path.
        streamAgentConversation: async (agentId, sessionId, input, signal) => {
            // Locally-stored agents execute through the plugin's same-origin
            // local runtime route (harness + gateway model) — no cloud Build.
            if (directServer() && String(agentId).startsWith('ar-local-')) {
                const response = await window.fetch(streamBaseUrl() + '/agentkit/local-conversation', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ agentId, sessionId, input: input?.parts?.[0]?.text || input?.input || String(input || ''), resourceMode: input?.resourceMode, history: input?.history }),
                    signal,
                });
                if (!response.ok || !response.body) {
                    const text = await response.text().catch(() => '');
                    let message = `本地运行失败（${response.status}）`;
                    try {
                        message = JSON.parse(text)?.error?.message || message;
                    }
                    catch { }
                    throw Object.assign(new Error(message), { code: 'LOCAL_RUN_FAILED' });
                }
                return response;
            }
            // Resolve the surface through the authenticated control-plane bridge.
            const surface = directServer()
                ? await (async () => {
                    if (!connection?.rpc?.call)
                        throw Object.assign(new Error('AgentEngine Server 连接不可用'), { code: 'SERVER_CONNECTION_MISSING' });
                    const result = await callStudioOperation(connection, 'agents/conversation-surface', { agentId, sessionId });
                    if (!result?.ok)
                        throw Object.assign(new Error(result?.error?.message || '会话面解析失败'), { code: result?.error?.code || 'CONVERSATION_SURFACE_FAILED' });
                    return result.value;
                })()
                : await request('/api/v1/agents/' + encodeURIComponent(agentId) + '/conversation-surface?sessionId=' + encodeURIComponent(sessionId));
            if (surface?.transport === 'agentengine-action') {
                return streamRequest('/agentkit/cloud-conversation', {
                    method: 'POST',
                    headers: { 'Idempotency-Key': input.idempotencyKey },
                    body: JSON.stringify({ agentId, sessionId, input }),
                    signal,
                });
            }
            const buildId = String(surface?.buildId || '').trim();
            if (!buildId) {
                const error = new Error('Agent 尚无可运行的 Build');
                error.code = 'BUILD_NOT_READY';
                throw error;
            }
            return streamRequest('/api/v1/builds/' + encodeURIComponent(buildId) + '/conversation:stream', {
                method: 'POST',
                headers: { 'Idempotency-Key': input.idempotencyKey },
                body: JSON.stringify({ input }),
                signal,
            });
        },
        cancelAgentConversation: (agentId, sessionId, invocationId) => directServer()
            ? serverAction('CancelRun', { AgentId: agentId, SessionId: sessionId, InvocationId: invocationId })
            : request('/api/v1/agents/' + encodeURIComponent(agentId) + '/conversation:cancel', { method: 'POST', body: JSON.stringify({ invocationId }) }),
        installDshPlugin: (source, acceptHostPermissions = false) => bridgeAvailable() ? studioBridgeOperation('plugins/dsh-install', { source, acceptHostPermissions }) : request('/api/v1/plugin-ecosystems/dsh/plugins:install', {
            method: 'POST', body: JSON.stringify({ source, acceptHostPermissions }),
        }),
        enableDshPlugin: pluginName => bridgeAvailable() ? studioBridgeOperation('plugins/dsh-enable', { pluginName }) : request('/api/v1/plugin-ecosystems/dsh/plugins/' + encodeURIComponent(pluginName) + ':enable', { method: 'POST' }),
        disableDshPlugin: pluginName => bridgeAvailable() ? studioBridgeOperation('plugins/dsh-disable', { pluginName }) : request('/api/v1/plugin-ecosystems/dsh/plugins/' + encodeURIComponent(pluginName) + ':disable', { method: 'POST' }),
        updateDshPlugin: pluginName => bridgeAvailable() ? studioBridgeOperation('plugins/dsh-update', { pluginName }) : request('/api/v1/plugin-ecosystems/dsh/plugins/' + encodeURIComponent(pluginName) + ':update', {
            method: 'POST', body: JSON.stringify({ acceptHostPermissions: true }),
        }),
        uninstallDshPlugin: pluginName => bridgeAvailable() ? studioBridgeOperation('plugins/dsh-remove', { pluginName }) : request('/api/v1/plugin-ecosystems/dsh/plugins/' + encodeURIComponent(pluginName), { method: 'DELETE' }),
        models: () => request('/api/v1/catalog/models'),
        credential: name => request('/api/v1/credentials/' + encodeURIComponent(name)),
        deleteCredential: name => request('/api/v1/credentials/' + encodeURIComponent(name), { method: 'DELETE' }),
        probeModelEndpoint: payload => request('/api/v1/model-endpoints:probe', { method: 'POST', body: JSON.stringify(payload) }),
        evaluations: (query = '') => directServer() ? studioBridgeOperation('evaluations/list', {}) : request('/api/v1/evaluations' + (query ? '?' + query : ''))
    };
}
