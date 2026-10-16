import { callStudioOperation } from '../contracts/transport.mjs';
/** Shared product transport; credentials and providers remain in the Host. */
export function createProductClient(connection, { window = globalThis.window } = {}, extend) {
    const config = window.__AGENTKIT_STUDIO__ || {};
    const directServer = () => Boolean(connection?.rpc?.call) && (!config.controlPlane || config.controlPlane === 'agentengine-server');
    // DSH embeds the product panel in an opaque srcdoc frame.  Packaged
    // local Hosts may omit the global control-plane marker even though the
    // authenticated Connection RPC is available.  Resource mutations must
    // still use the Node Host bridge in that mode; falling back to the old
    // REST surface loses local credentials before an MCP can be created.
    const bridgeAvailable = () => Boolean(connection?.rpc?.call);
    const localMcpId = resourceId => String(resourceId || '').startsWith('mcp-local-');
    const baseUrl = String(config.hostUrl || 'http://127.0.0.1:8789').replace(/\/$/, '');
    const streamBaseUrl = () => directServer() ? window.location.origin : baseUrl;
    let csrfToken = config.csrfToken || null;
    // `ksadk studio` puts its short-lived Host handoff in the launch URL
    // fragment (`#session=...`). Packaged DSH runs inject the same value
    // through `__AGENTKIT_STUDIO__`; accepting both keeps authoring routes
    // usable in either launch mode without a long-lived browser credential.
    const launchSessionToken = (() => {
        try {
            const params = new URLSearchParams(String(window.location.hash || '').replace(/^#/, ''));
            return params.get('session') || null;
        }
        catch {
            return null;
        }
    })();
    const sessionToken = config.sessionToken || launchSessionToken;
    let exchangePromise = null;
    async function ensureSession() {
        if (!sessionToken || csrfToken)
            return null;
        if (!exchangePromise) {
            exchangePromise = (async () => {
                const result = await request('/api/v1/system/session', { method: 'POST', body: JSON.stringify({ token: sessionToken }) });
                csrfToken = result?.csrfToken || csrfToken;
                return result;
            })().finally(() => { exchangePromise = null; });
        }
        return exchangePromise;
    }
    async function request(path, init = {}) {
        if (directServer() && path !== '/api/v1/system/session') {
            // In directServer mode no local Studio Host serves the REST
            // surface. Failing fast with a typed error beats a doomed fetch to
            // the default hostUrl that reports as "Studio Host 不可达".
            const unavailable = new Error(`云端控制面暂未提供 REST 合同（${path}）；该接口需 AgentEngine Server 开放对应 Action 或本地 Studio Host`);
            unavailable.code = 'CLOUD_CONTRACT_UNAVAILABLE';
            unavailable.details = { path };
            throw unavailable;
        }
        if (path !== '/api/v1/system/session' && sessionToken && !csrfToken)
            await ensureSession();
        const method = init.method || 'GET';
        if (method !== 'GET' && method !== 'HEAD' && !sessionToken) {
            const unavailable = new Error('Studio 本地会话未注入，请通过 Studio Host 启动 DSH');
            unavailable.code = 'HOST_SESSION_MISSING';
            throw unavailable;
        }
        const headers = new Headers(init.headers || {});
        headers.set('Accept', 'application/json');
        if (init.body !== undefined && !headers.has('Content-Type') && !(typeof FormData !== 'undefined' && init.body instanceof FormData))
            headers.set('Content-Type', 'application/json');
        if (method !== 'GET' && method !== 'HEAD' && csrfToken)
            headers.set('X-CSRF-Token', csrfToken);
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
        if (!response.ok) {
            const raw = payload?.error || payload || {};
            const error = new Error(raw.message || payload?.message || payload?.detail || ('Host request failed (' + response.status + ')'));
            error.code = raw.code || 'HOST_REQUEST_FAILED';
            error.status = response.status;
            error.details = raw.details;
            throw error;
        }
        return payload;
    }
    async function serverAction(action, payload = {}) {
        if (!connection?.rpc?.call) {
            const error = new Error('AgentEngine Server 连接不可用');
            error.code = 'SERVER_CONNECTION_MISSING';
            throw error;
        }
        const result = await callStudioOperation(connection, 'server/action', { action, payload });
        if (!result?.ok) {
            const error = new Error(result?.error?.message || `${action} 请求失败`);
            error.code = result?.error?.code || 'SERVER_ACTION_FAILED';
            error.details = result?.error?.details;
            throw error;
        }
        return result.value;
    }
    // Cloud control-plane contract gaps must surface as typed, actionable
    // errors — never as the misleading local-Studio-Host "unreachable".
    function cloudUnsupported(what) {
        const error = new Error(`云端控制面暂未提供${what}合同；该资源面在 AgentEngine Server 开放对应 Action 前不可用`);
        error.code = 'CLOUD_CONTRACT_UNAVAILABLE';
        return Promise.reject(error);
    }
    // Local studio operations (builds/tasks) run inside the plugin Node
    // host; this helper reaches them over the authenticated bridge with a
    // local-Host REST fallback for packaged hosts.
    async function studioBridgeOperation(endpoint, payload) {
        if (connection?.rpc?.call) {
            const result = await callStudioOperation(connection, endpoint, payload);
            if (!result?.ok) {
                const error = new Error(result?.error?.message || 'Studio 本地任务请求失败');
                error.code = result?.error?.code || 'STUDIO_OPERATION_FAILED';
                error.status = result?.error?.details?.status || result?.error?.status;
                error.details = result?.error?.details;
                throw error;
            }
            return result.value;
        }
        throw Object.assign(new Error('Studio 本地任务需要已连接的 Studio Host'), { code: 'HOST_CONNECTION_MISSING' });
    }
    async function ensureDshPreset(agentId, buildId = '') {
        if (!connection?.rpc?.call) {
            const error = new Error('DSH Agent preset 准入需要已连接的 Studio Host');
            error.code = 'DSH_PRESET_HOST_CONNECTION_MISSING';
            throw error;
        }
        const result = await callStudioOperation(connection, 'agents/ensure-preset', { agentId, ...(buildId ? { buildId } : {}) });
        if (!result?.ok) {
            const error = new Error(result?.error?.message || 'DSH Agent preset 准入失败');
            error.code = result?.error?.code || 'DSH_PRESET_ADMISSION_FAILED';
            error.details = result?.error?.details;
            throw error;
        }
        return result.value;
    }
    async function syncModelCredential() {
        if (!connection?.rpc?.call)
            return { configured: false, source: 'host-unavailable' };
        const result = await callStudioOperation(connection, 'server/action', { action: 'models/sync-credential', payload: {} });
        if (!result?.ok) {
            const error = new Error(result?.error?.message || 'Studio 模型凭证同步失败');
            error.code = result?.error?.code || 'MODEL_CREDENTIAL_SYNC_FAILED';
            throw error;
        }
        return result.value || { configured: false, source: 'missing' };
    }
    async function modelCredentialStatus() {
        if (!connection?.rpc?.call)
            throw Object.assign(new Error('Studio Host 尚未连接，请稍后重试'), { code: 'HOST_CONNECTION_MISSING' });
        const result = await callStudioOperation(connection, 'server/action', { action: 'models/credential-status', payload: {} });
        if (!result?.ok) {
            const error = new Error(result?.error?.message || 'Studio 模型凭证状态不可用');
            error.code = result?.error?.code || 'MODEL_CREDENTIAL_STATUS_FAILED';
            throw error;
        }
        return result.value || { configured: false, source: 'missing' };
    }
    async function studioCall(action, payload = {}) {
        const result = await callStudioOperation(connection, 'server/action', { action, payload });
        if (!result?.ok)
            throw Object.assign(new Error(result?.error?.message || 'Studio 请求失败'), { code: result?.error?.code });
        return result.value;
    }
    // Skill discovery runs locally inside the plugin Node host over the
    // same authenticated bridge; the legacy Studio Host REST routes are
    // kept for a local-Host deployment only. Declared in factory scope so
    // every hostRemote method can reach it.
    async function skillBridgeCall(endpoint, payload = {}) {
        if (connection?.rpc?.call) {
            const result = await callStudioOperation(connection, endpoint, payload);
            if (!result?.ok) {
                const error = new Error(result?.error?.message || '本地 Skill 操作失败');
                error.code = result?.error?.code || 'SKILL_DISCOVERY_FAILED';
                error.details = result?.error?.details;
                throw error;
            }
            return result.value;
        }
        const bridgeByEndpoint = {
            'skills/discover': scanPaths => request('/api/v1/catalog/skills:discover', { method: 'POST', body: JSON.stringify({ scanPaths: Array.isArray(scanPaths) ? scanPaths : [] }) }),
            'skills/preview-discovered': ({ inspectionToken, candidateId, path }) => request('/api/v1/catalog/skills/discoveries/' + encodeURIComponent(inspectionToken) + '/candidates/' + encodeURIComponent(candidateId) + '/files' + (path ? '?path=' + encodeURIComponent(path) : '')),
            'skills/commit-discovered': ({ inspectionToken, candidateId, overwrite }) => request('/api/v1/catalog/skills/discoveries/' + encodeURIComponent(inspectionToken) + ':commit', { method: 'POST', body: JSON.stringify({ candidateId, overwrite }) }),
            'skills/preview-installed': ({ resourceId, path }) => request('/api/v1/catalog/skills/' + encodeURIComponent(resourceId) + '/files' + (path ? '?path=' + encodeURIComponent(path) : '')),
        };
        return bridgeByEndpoint[endpoint](payload);
    }
    return {
        assistantCatalog: () => studioBridgeOperation('assistant/catalog', {}),
        assistantExecute: (agentId, operation, input = {}) => studioBridgeOperation('assistant/execute', { agentId, operation, input }),
        get baseUrl() { return baseUrl; },
        health: () => directServer() ? Promise.resolve({ status: 'ok', source: 'agentengine-server', controlPlane: true }) : request('/api/v1/system/health'),
        bootstrap: () => directServer() ? Promise.resolve({ workspaceReady: true, source: 'agentengine-server' }) : request('/api/v1/system/bootstrap'),
        settings: () => studioCall('settings/get'),
        modelCatalog: profileId => studioCall('models/catalog', { profileId }),
        updateSettings: payload => studioCall('settings/update', payload),
        runtimes: () => directServer()
            ? Promise.resolve({ items: [{ runtimeType: 'dsh-native', label: 'DSH Native Harness', source: 'dsh' }], source: 'dsh' })
            : request('/api/v1/catalog/runtimes'),
        // `/api/v1/agents` is an older collection endpoint in some Hosts and
        // returns an array; normalize it to the Studio `{ items }` contract.
        agents: async ({ page = 1, pageSize = 50, query = '', source = 'all' } = {}) => {
            // DSH Web renders plugin UI in an opaque srcdoc frame.  Use the
            // authenticated Connection carrier for the local control plane;
            // direct cross-origin fetch is blocked before the DSH Host can answer.
            if (connection?.rpc?.call) {
                try {
                    const result = await callStudioOperation(connection, 'agents/list', { page, limit: pageSize, query, source });
                    if (result?.ok)
                        return Array.isArray(result.value) ? { items: result.value, page, pageSize } : result.value;
                    const error = new Error(result?.error?.message || 'Agent catalog unavailable');
                    error.code = result?.error?.code || 'HOST_REQUEST_FAILED';
                    throw error;
                }
                catch (serverError) {
                    // The local DSH Host remains a valid authoring/runtime fallback
                    // when the optional AgentEngine Server is offline. This does not
                    // fabricate data: the same authenticated Host catalog is read.
                    try {
                        const payload = await request('/api/v1/agents?' + new URLSearchParams({ limit: String(Math.min(pageSize, 100)), page: String(page), source, ...(query ? { query } : {}) }).toString());
                        return Array.isArray(payload) ? { items: payload } : payload;
                    }
                    catch {
                        throw serverError;
                    }
                }
            }
            const payload = await request('/api/v1/agents?' + new URLSearchParams({ limit: String(Math.min(pageSize, 100)), page: String(page), source, ...(query ? { query } : {}) }).toString());
            return Array.isArray(payload) ? { items: payload } : payload;
        },
        agent: id => directServer()
            ? (async () => {
                // Local agents (conversation-created) live in the plugin store;
                // cloud agents come from GetAgent. Reading order: local, cloud.
                try {
                    const local = await studioBridgeOperation('agents/local-get', { agentId: id });
                    if (local) {
                        const builds = await studioBridgeOperation('builds/list', { agentId: id });
                        return { ...local, builds: Array.isArray(builds?.items) ? builds.items : [] };
                    }
                }
                catch { /* fall through to the cloud read */ }
                const detail = await serverAction('GetAgent', { AgentId: id });
                try {
                    const local = await studioBridgeOperation('builds/list', { agentId: id });
                    return { ...detail, builds: Array.isArray(local?.items) ? local.items : [] };
                }
                catch {
                    return detail;
                }
            })()
            : request('/api/v1/agents/' + encodeURIComponent(id)),
        ensureDshPreset,
        syncModelCredential,
        modelCredentialStatus,
        quickAuthorAgent: payload => directServer()
            ? studioBridgeOperation('agents/create-local', payload)
            : request('/api/v1/authoring/quick', { method: 'POST', body: JSON.stringify(payload) }),
        updateAgent: (id, spec, revision, name) => directServer() && String(id).startsWith('ar-local-')
            ? studioBridgeOperation('agents/update-local', { agentId: id, spec, name })
            : directServer()
                ? studioBridgeOperation('agents/update-cloud', { agentId: id, spec, revision, name })
                : request('/api/v1/agents/' + encodeURIComponent(id) + (name ? '?name=' + encodeURIComponent(name) : ''), {
                    method: 'PUT',
                    headers: { 'If-Match': String(revision) },
                    body: JSON.stringify(spec),
                }),
        deleteLocalAgent: id => directServer() ? studioBridgeOperation('agents/local-delete', { agentId: id }) : Promise.reject(Object.assign(new Error('本地 Agent 删除需要 Studio Host'), { code: 'HOST_CONNECTION_MISSING' })),
        createBuild: (id, revision, idempotencyKey) => directServer()
            ? studioBridgeOperation('builds/create', { agentId: id, revision, idempotencyKey })
            : request('/api/v1/agents/' + encodeURIComponent(id) + '/builds', {
                method: 'POST',
                headers: { 'Idempotency-Key': idempotencyKey },
                body: JSON.stringify({ revision }),
            }),
        codexModels: () => studioBridgeOperation('models/codex'),
        exportPortableBuild: (agentId, buildId) => studioBridgeOperation('builds/export-portable', { agentId, buildId }),
        downloadBuild: (agentId, buildId) => studioBridgeOperation('builds/download', { agentId, buildId }),
        prepareDeploymentUpdate: payload => studioBridgeOperation('deployments/prepareUpdate', payload),
        applyDeploymentUpdate: payload => studioBridgeOperation('deployments/applyUpdate', payload),
        prepareDeployment: payload => studioBridgeOperation('deployments/prepare', payload),
        refreshDeployment: deploymentId => studioBridgeOperation('deployments/refresh', { deploymentId }),
        repairDeploymentAccess: deploymentId => studioBridgeOperation('deployments/repairAccess', { deploymentId }),
        reconcileDeployment: deploymentId => studioBridgeOperation('deployments/reconcile', { deploymentId }),
        deploymentLogs: deploymentId => studioBridgeOperation('deployments/logs', { deploymentId }),
        removeDeployment: deploymentId => studioBridgeOperation('deployments/remove', { deploymentId }),
        createDeployment: (buildId, payload, idempotencyKey) => directServer() ? studioBridgeOperation('deployments/create', { ...payload, buildId, idempotencyKey }) : request('/api/v1/builds/' + encodeURIComponent(buildId) + '/deployments', {
            method: 'POST',
            headers: { 'Idempotency-Key': idempotencyKey },
            body: JSON.stringify(payload),
        }),
        deployments: () => directServer()
            ? studioBridgeOperation('deployments/list', {})
            : request('/api/v1/deployments'),
        operations: () => directServer()
            ? studioBridgeOperation('operations/list', {}).then(value => ({ items: Array.isArray(value?.items) ? value.items : [] }))
            : request('/api/v1/workspaces/operations'),
        cancelOperation: id => directServer()
            ? studioBridgeOperation('operations/cancel', { operationId: id })
            : request('/api/v1/operations/' + encodeURIComponent(id) + ':cancel', { method: 'POST' }),
        resources: options => {
            const value = typeof options === 'string' ? { kind: options, limit: 200 } : (options || {});
            if (!value.kind && bridgeAvailable())
                return studioBridgeOperation('resources/list', value);
            if (directServer()) {
                // Resource catalogs with a public Server Action read from the
                // authenticated control plane. The model catalog comes from the
                // configured model gateway's OpenAI-compatible /models endpoint
                // (same discovery the legacy Studio used) via the Node-side
                // model service. `skill` is the locally-imported skill catalog —
                // a local-Host contract with no cloud Action; the platform skill
                // workspace list lives under the `skill-space` kind instead.
                const cloudActions = {
                    mcp: 'ListMCPs',
                    'knowledge-base': 'ListKnowledgeBases',
                    'memory-instance': 'ListMemoryInstances',
                };
                const action = cloudActions[value.kind];
                if (value.kind === 'mcp') {
                    // MCPs can be authored in the local Host catalog. Merge that
                    // catalog with the cloud Action instead of sending a write/read
                    // request to a REST contract that direct Server mode does not
                    // expose.
                    return studioBridgeOperation('resources/list', value);
                }
                if (action) {
                    return serverAction(action, { Page: 1, PageSize: Math.min(Number(value.limit || 200), 100) })
                        .catch(() => request('/api/v1/catalog/resources?' + new URLSearchParams({ kind: value.kind, limit: String(value.limit || 20), ...(value.cursor ? { cursor: value.cursor } : {}), ...(value.query ? { query: value.query } : {}) }).toString()));
                }
                if (value.kind === 'model') {
                    return studioBridgeOperation('resources/list', value);
                }
                if (value.kind === 'tool' || value.kind === 'skill')
                    return studioBridgeOperation('resources/list', value);
            }
            if (value.kind === 'mcp' && bridgeAvailable())
                return studioBridgeOperation('resources/list', value);
            const params = new URLSearchParams();
            if (value.kind)
                params.set('kind', value.kind);
            params.set('limit', String(value.limit || 20));
            if (value.cursor)
                params.set('cursor', value.cursor);
            if (value.query)
                params.set('query', value.query);
            if (value.status)
                params.set('status', value.status);
            if (value.source)
                params.set('source', value.source);
            if (value.sort)
                params.set('sort', value.sort);
            return request('/api/v1/catalog/resources?' + params.toString());
        },
        // Resource lifecycle routes intentionally stay Host-owned.  The
        // catalog page uses these public contracts to create/probe MCPs and
        // to inspect/commit local Skills; it never writes the workspace from
        // the browser itself.
        createMcpResource: payload => bridgeAvailable()
            ? studioBridgeOperation('mcp/create', payload)
            : request('/api/v1/catalog/mcp-servers', { method: 'POST', body: JSON.stringify(payload) }),
        updateMcpResource: (resourceId, payload) => (bridgeAvailable() && localMcpId(resourceId))
            ? studioBridgeOperation('mcp/update', { resourceId, ...payload })
            : request('/api/v1/catalog/mcp-servers/' + encodeURIComponent(resourceId), { method: 'PUT', body: JSON.stringify(payload) }),
        createModelResource: payload => bridgeAvailable() ? studioBridgeOperation('models/create', payload) : request('/api/v1/catalog/model-profiles', { method: 'POST', body: JSON.stringify(payload) }),
        createToolResource: payload => request('/api/v1/catalog/tools', { method: 'POST', body: JSON.stringify(payload) }),
        deleteResource: (resourceId, scope = 'local') => bridgeAvailable()
            ? studioBridgeOperation('resources/delete', { resourceId, scope })
            : scope === 'cloud' ? Promise.reject(new Error('删除云端 MCP 需要连接 Studio Host'))
                : request('/api/v1/catalog/resources/' + encodeURIComponent(resourceId), { method: 'DELETE' }),
        probeMcpResource: (resourceId, timeoutSeconds = 15) => (bridgeAvailable() && (localMcpId(resourceId) || directServer()))
            ? studioBridgeOperation('mcp/probe', { resourceId, timeoutSeconds })
            : request('/api/v1/catalog/mcp-servers/' + encodeURIComponent(resourceId) + ':probe?timeoutSeconds=' + encodeURIComponent(timeoutSeconds), { method: 'POST' }),
        // Skill discovery runs locally inside the plugin Node host over the
        // same authenticated bridge; the legacy Studio Host REST routes are
        // kept for a local-Host deployment only.
        discoverSkills: (scanPaths = []) => skillBridgeCall('skills/discover', { scanPaths: Array.isArray(scanPaths) ? scanPaths : [] }),
        previewDiscoveredSkill: (inspectionToken, candidateId, path = '') => skillBridgeCall('skills/preview-discovered', { inspectionToken, candidateId, path }),
        commitDiscoveredSkill: (inspectionToken, candidateId, overwrite = false) => skillBridgeCall('skills/commit-discovered', { inspectionToken, candidateId, overwrite }),
        previewInstalledSkill: (resourceId, path = '') => skillBridgeCall('skills/preview-installed', { resourceId, path }),
        platformResources: kind => {
            if (directServer()) {
                const actions = { 'knowledge-base': 'ListKnowledgeBases', 'memory-instance': 'ListMemoryInstances', 'skill-space': 'ListSkillWorkspaces' };
                const action = actions[kind];
                if (action)
                    return serverAction(action, {})
                        .then(value => ({ ...value, connectionRef: 'agentengine-server', pluginRef: 'agentengine-server', componentId: kind, pluginSnapshotDigest: 'server-action-v1' }))
                        .catch(() => request('/api/v1/platform-resources?kind=' + encodeURIComponent(kind)));
            }
            return request('/api/v1/platform-resources?kind=' + encodeURIComponent(kind));
        },
        bootstrapPlatformResources: () => request('/api/v1/resource-connections:bootstrap', { method: 'POST' }),
        schedules: (agentId, scope = 'local') => directServer() ? studioBridgeOperation('schedules/list', { agentId, scope }) : request(agentId ? '/api/v1/agents/' + encodeURIComponent(agentId) + '/schedules' : '/api/v1/schedules'),
        scheduleDeliveryTargets: agentId => studioBridgeOperation('schedules/delivery-targets', { agentId, scope: 'cloud' }),
        scheduleOccurrences: (taskId, agentId) => directServer() ? studioBridgeOperation('schedules/occurrences', { taskId, agentId }) : request(agentId
            ? '/api/v1/agents/' + encodeURIComponent(agentId) + '/schedules/' + encodeURIComponent(taskId) + '/occurrences'
            : '/api/v1/schedules/' + encodeURIComponent(taskId) + '/occurrences'),
        createSchedule: (agentId, payload) => directServer() ? studioBridgeOperation('schedules/create', { agentId, spec: payload }) : request('/api/v1/agents/' + encodeURIComponent(agentId) + '/schedules', { method: 'POST', body: JSON.stringify(payload) }),
        updateSchedule: (agentId, taskId, payload) => directServer() ? studioBridgeOperation('schedules/update', { agentId, taskId, patch: payload }) : request('/api/v1/agents/' + encodeURIComponent(agentId) + '/schedules/' + encodeURIComponent(taskId), { method: 'PUT', body: JSON.stringify(payload) }),
        deleteSchedule: (agentId, taskId) => directServer() ? studioBridgeOperation('schedules/delete', { taskId, agentId }) : request('/api/v1/agents/' + encodeURIComponent(agentId) + '/schedules/' + encodeURIComponent(taskId), { method: 'DELETE' }),
        runSchedule: (agentId, taskId) => directServer() ? studioBridgeOperation('schedules/run', { taskId, agentId }) : request('/api/v1/agents/' + encodeURIComponent(agentId) + '/schedules/' + encodeURIComponent(taskId) + ':run', { method: 'POST' }),
        dshPlugins: () => bridgeAvailable() ? studioBridgeOperation('plugins/dsh-list', {}) : request('/api/v1/plugin-ecosystems/dsh/plugins'),
        codexPlugins: () => bridgeAvailable() ? studioBridgeOperation('plugins/codex-list', {}) : request('/api/v1/plugin-ecosystems/codex/plugins'),
        inspectCodexPlugin: pluginId => studioBridgeOperation('plugins/codex-inspect', { pluginId }),
        installCodexPlugin: (pluginId, marketplaceName) => bridgeAvailable() ? studioBridgeOperation('plugins/codex-install', { pluginId, marketplaceName }) : request('/api/v1/plugin-ecosystems/codex/plugins/' + encodeURIComponent(pluginId) + ':install', {
            method: 'POST', body: JSON.stringify({ marketplaceName: marketplaceName || undefined, acceptUndeclaredPermissions: true }),
        }),
        uninstallCodexPlugin: pluginId => bridgeAvailable() ? studioBridgeOperation('plugins/codex-remove', { pluginId }) : request('/api/v1/plugin-ecosystems/codex/plugins/' + encodeURIComponent(pluginId), { method: 'DELETE' }),
        putCredential: (name, value) => bridgeAvailable()
            ? studioBridgeOperation('credentials/put', { name, value, persistence: 'session' })
            : request('/api/v1/credentials/' + encodeURIComponent(name), { method: 'PUT', body: JSON.stringify({ value, persistence: 'session' }) }),
        evaluationSets: () => directServer() ? studioBridgeOperation('evaluations/evalsets', {}) : request('/api/v1/evaluation-files'),
        evaluationTargets: (query = '') => directServer() ? studioBridgeOperation('evaluations/targets', {}) : request('/api/v1/evaluation-targets' + (query ? '?' + query : '')),
        evaluation: id => directServer() ? studioBridgeOperation('evaluations/get', { runId: id }) : request('/api/v1/evaluations/' + encodeURIComponent(id)),
        evaluationRun: id => directServer() ? studioBridgeOperation('evaluations/get', { runId: id }) : request('/api/v1/evaluation-runs/' + encodeURIComponent(id)),
        evaluationRuns: (query = '') => directServer() ? studioBridgeOperation('evaluations/list', {}) : request('/api/v1/evaluation-runs' + (query ? '?' + query : '')),
        createEvaluation: (payload, idempotencyKey) => directServer() ? studioBridgeOperation('evaluations/create', payload) : request('/api/v1/evaluations', { method: 'POST', headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined, body: JSON.stringify(payload) }),
        importEvaluationFile: async (body) => {
            if (!directServer())
                return request('/api/v1/evaluation-files', { method: 'POST', body });
            const file = typeof body?.get === 'function' ? body.get('file') : null;
            if (file?.size > 1024 * 1024)
                throw new Error('EvalSet 文件超过 1 MiB 上限');
            const content = file?.text ? await file.text() : typeof body === 'string' ? body : JSON.stringify(body);
            return studioBridgeOperation('evaluations/import', { content, fileName: file?.name || 'uploaded.yaml' });
        },
        tracesOverview: (query = '') => directServer() ? studioBridgeOperation('traces/overview', Object.fromEntries(new URLSearchParams(query))) : request('/api/v1/traces/overview' + (query ? '?' + query : '')),
        traces: (query = '') => directServer() ? studioBridgeOperation('traces/list', Object.fromEntries(new URLSearchParams(query))) : request('/api/v1/traces' + (query ? '?' + query : '')),
        trace: id => directServer() ? studioBridgeOperation('traces/get', { traceId: id }) : request('/api/v1/traces/' + encodeURIComponent(id)),
        traceOtlp: id => directServer() ? studioBridgeOperation('traces/otlp', { traceId: id }) : request('/api/v1/traces/' + encodeURIComponent(id) + '/otlp'),
        exportSessionLog: (id, query = '') => directServer() ? studioBridgeOperation('sessions/export-log', { sessionId: id }) : request('/api/v1/sessions/' + encodeURIComponent(id) + ':export' + (query ? '?' + query : '')),
        channelConnection: () => directServer() ? studioBridgeOperation('channels/connection', {}) : request('/api/v1/channels/connection'),
        updateChannelConnection: payload => directServer() ? studioBridgeOperation('channels/update', payload) : request('/api/v1/channels/connection', { method: 'PUT', body: JSON.stringify(payload) }),
        updateAgentChannelConnection: (id, payload) => directServer() ? studioBridgeOperation('channels/agent-update', { ...payload, agentId: id }) : request('/api/v1/channels/agents/' + encodeURIComponent(id) + '/connection', { method: 'PUT', body: JSON.stringify(payload) }),
        channelAction: (action, payload = {}) => directServer() ? studioBridgeOperation('channels/action', { action, payload }) : request('/agentengine/api/v1/' + encodeURIComponent(action), { method: 'POST', body: JSON.stringify(payload) }),
        ...(extend ? extend({ connection, window, directServer, bridgeAvailable, studioBridgeOperation, serverAction, request, streamBaseUrl, sessionToken, ensureSession, getCsrfToken: () => csrfToken }) : {}),
    };
}
