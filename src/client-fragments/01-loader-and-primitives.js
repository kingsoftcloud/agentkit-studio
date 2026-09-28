/* global window */

/**
 * Browser half of AgentKit Studio.
 *
 * Studio contributes one DSH global panel containing its product surface. The
 * product surface owns Studio navigation and control-plane pages; DSH keeps ownership
 * of conversation, session, tool and dock state.
 */
window.__ModuleLoader__.load({
  id: '@kingsoftcloud/agentkit-studio',
  factory: require => {
    const React = require('react');
    const { createElement: h, useEffect, useRef, useState } = React;
    const STUDIO_VERSION = '0.0.1';
    const DSH_VERSION = String((window.__AGENTKIT_STUDIO__ || {}).dshVersion || '0.1.7-rc.2');
    const CONVERSATION_AGENT_KEY = 'agentkit-studio:conversation-agent';
    const OPEN_BOUND_CONVERSATION_KEY = 'agentkit-studio:open-bound-agent';
    // DSH Native is the official DSH SDK-backed loop. Resource-bearing
    // revisions still fail closed in the Host until their resource profile is
    // materialized, while a no-resource Agent is a real selectable target.
    const ALLOWED_RUNTIME_TYPES = ['dsh-native', 'harness', 'codex'];
    const RUNTIME_LABELS = {
      'dsh-native': 'DSH Native Harness',
      harness: 'AgentKit Harness',
      codex: 'Codex Agent',
    };

    // The Host URL is injected by the Host half for packaged builds. A
    // loopback default keeps the local Web spike usable without requiring a
    // global CLI or a second browser application. Credentials never enter
    // this renderer; the Host owns session exchange and secret storage.
    function createHostRemote(connection) {
      const config = window.__AGENTKIT_STUDIO__ || {};
      const directServer = () => config.controlPlane === 'agentengine-server' && Boolean(connection?.rpc?.call);
      const baseUrl = String(config.hostUrl || 'http://127.0.0.1:8789').replace(/\/$/, '');
      let csrfToken = config.csrfToken || null;
      // `ksadk studio` puts its short-lived Host handoff in the launch URL
      // fragment (`#session=...`). Packaged DSH runs inject the same value
      // through `__AGENTKIT_STUDIO__`; accepting both keeps authoring routes
      // usable in either launch mode without a long-lived browser credential.
      const launchSessionToken = (() => {
        try {
          const params = new URLSearchParams(String(window.location.hash || '').replace(/^#/, ''));
          return params.get('session') || null;
        } catch { return null; }
      })();
      const sessionToken = config.sessionToken || launchSessionToken;
      let exchangePromise = null;
      async function ensureSession() {
        if (!sessionToken || csrfToken) return null;
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
        if (path !== '/api/v1/system/session' && sessionToken && !csrfToken) await ensureSession();
        const method = init.method || 'GET';
        if (method !== 'GET' && method !== 'HEAD' && !sessionToken) {
          const unavailable = new Error('Studio 本地会话未注入，请通过 Studio Host 启动 DSH');
          unavailable.code = 'HOST_SESSION_MISSING';
          throw unavailable;
        }
        const headers = new Headers(init.headers || {});
        headers.set('Accept', 'application/json');
        if (init.body !== undefined && !headers.has('Content-Type') && !(typeof FormData !== 'undefined' && init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
        if (method !== 'GET' && method !== 'HEAD' && csrfToken) headers.set('X-CSRF-Token', csrfToken);
        if (sessionToken) headers.set('X-AgentKit-Session', sessionToken);
        let response;
        try {
          response = await window.fetch(baseUrl + path, { ...init, method, headers, credentials: 'include' });
        } catch (error) {
          const unavailable = new Error('Studio Host 不可达');
          unavailable.code = 'HOST_UNAVAILABLE';
          unavailable.cause = error;
          throw unavailable;
        }
        const text = await response.text();
        let payload = null;
        if (text) { try { payload = JSON.parse(text); } catch { payload = { detail: text.slice(0, 256) }; } }
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
      async function streamRequest(path, init = {}) {
        if (sessionToken && !csrfToken) await ensureSession();
        const method = init.method || 'GET';
        const headers = new Headers(init.headers || {});
        headers.set('Accept', 'text/event-stream');
        if (init.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
        if (method !== 'GET' && method !== 'HEAD' && csrfToken) headers.set('X-CSRF-Token', csrfToken);
        if (sessionToken) headers.set('X-AgentKit-Session', sessionToken);
        let response;
        try {
          response = await window.fetch(baseUrl + path, { ...init, method, headers, credentials: 'include' });
        } catch (error) {
          const unavailable = new Error('Studio Host 不可达');
          unavailable.code = 'HOST_UNAVAILABLE';
          unavailable.cause = error;
          throw unavailable;
        }
        if (!response.ok || !response.body) {
          const text = await response.text();
          let payload = null;
          if (text) { try { payload = JSON.parse(text); } catch { payload = { detail: text.slice(0, 256) }; } }
          const raw = payload?.error || payload || {};
          const failure = new Error(raw.message || payload?.message || payload?.detail || ('Host stream failed (' + response.status + ')'));
          failure.code = raw.code || 'HOST_STREAM_FAILED';
          failure.status = response.status;
          failure.details = raw.details;
          throw failure;
        }
        return response;
      }
      async function serverAction(action, payload = {}) {
        if (!connection?.rpc?.call) {
          const error = new Error('AgentEngine Server 连接不可用');
          error.code = 'SERVER_CONNECTION_MISSING';
          throw error;
        }
        const result = await connection.rpc.call('/agentkit', 'server/action', { action, payload });
        if (!result?.ok) {
          const error = new Error(result?.error?.message || `${action} 请求失败`);
          error.code = result?.error?.code || 'SERVER_ACTION_FAILED';
          error.details = result?.error?.details;
          throw error;
        }
        return result.value;
      }
      async function ensureDshPreset(agentId) {
        if (!connection?.rpc?.call) {
          const error = new Error('DSH Agent preset 准入需要已连接的 Studio Host');
          error.code = 'DSH_PRESET_HOST_CONNECTION_MISSING';
          throw error;
        }
        const result = await connection.rpc.call('/agentkit', 'agents/ensure-preset', { agentId });
        if (!result?.ok) {
          const error = new Error(result?.error?.message || 'DSH Agent preset 准入失败');
          error.code = result?.error?.code || 'DSH_PRESET_ADMISSION_FAILED';
          error.details = result?.error?.details;
          throw error;
        }
        return result.value;
      }
      async function syncModelCredential() {
        if (!connection?.rpc?.call) return { configured: false, source: 'host-unavailable' };
        const result = await connection.rpc.call('/agentkit', 'models/sync-credential', {});
        if (!result?.ok) {
          const error = new Error(result?.error?.message || 'Studio 模型凭证同步失败');
          error.code = result?.error?.code || 'MODEL_CREDENTIAL_SYNC_FAILED';
          throw error;
        }
        return result.value || { configured: false, source: 'missing' };
      }
      return {
        get baseUrl() { return baseUrl; },
        exchangeSession: ensureSession,
        health: () => directServer() ? Promise.resolve({ status: 'ok', source: 'agentengine-server', controlPlane: true }) : request('/api/v1/system/health'),
        bootstrap: () => directServer() ? Promise.resolve({ workspaceReady: true, source: 'agentengine-server' }) : request('/api/v1/system/bootstrap'),
        settings: () => request('/api/v1/system/settings'),
        updateSettings: payload => request('/api/v1/system/settings', { method: 'PUT', body: JSON.stringify(payload) }),
        runtimes: () => directServer()
          ? Promise.resolve({ items: [{ runtimeType: 'dsh-native', label: 'DSH Native Harness', source: 'dsh' }], source: 'dsh' })
          : request('/api/v1/catalog/runtimes'),
        // `/api/v1/agents` is an older collection endpoint in some Hosts and
        // returns an array; normalize it to the Studio `{ items }` contract.
        agents: async ({ page = 1, pageSize = 50, query = '' } = {}) => {
          // DSH Web renders plugin UI in an opaque srcdoc frame.  Use the
          // authenticated Connection carrier for the local control plane;
              // direct cross-origin fetch is blocked before the DSH Host can answer.
          if (connection?.rpc?.call) {
            try {
              const result = await connection.rpc.call('/agentkit', 'agents/list', { page, limit: pageSize, query });
              if (result?.ok) return Array.isArray(result.value) ? { items: result.value, page, pageSize } : result.value;
              const error = new Error(result?.error?.message || 'Agent catalog unavailable');
              error.code = result?.error?.code || 'HOST_REQUEST_FAILED';
              throw error;
            } catch (serverError) {
              // The local DSH Host remains a valid authoring/runtime fallback
              // when the optional AgentEngine Server is offline. This does not
              // fabricate data: the same authenticated Host catalog is read.
              try {
                const payload = await request('/api/v1/agents?' + new URLSearchParams({ limit: String(Math.min(pageSize, 100)), page: String(page), ...(query ? { query } : {}) }).toString());
                return Array.isArray(payload) ? { items: payload } : payload;
              } catch { throw serverError; }
            }
          }
          const payload = await request('/api/v1/agents?' + new URLSearchParams({ limit: String(Math.min(pageSize, 100)), page: String(page), ...(query ? { query } : {}) }).toString());
          return Array.isArray(payload) ? { items: payload } : payload;
        },
        agent: id => directServer()
          ? serverAction('GetAgent', { AgentId: id }).catch(() => request('/api/v1/agents/' + encodeURIComponent(id)))
          : request('/api/v1/agents/' + encodeURIComponent(id)),
        ensureDshPreset,
        syncModelCredential,
        createAgent: payload => request('/api/v1/agents', { method: 'POST', body: JSON.stringify(payload) }),
        quickAuthorAgent: payload => request('/api/v1/authoring/quick', { method: 'POST', body: JSON.stringify(payload) }),
        composeAuthoringConversation: payload => request('/api/v1/authoring/conversations:compose', { method: 'POST', body: JSON.stringify(payload) }),
        authoringConversationStatus: requestId => request('/api/v1/authoring/conversations:status/' + encodeURIComponent(requestId)),
        updateAgent: (id, spec, revision, name) => request('/api/v1/agents/' + encodeURIComponent(id) + (name ? '?name=' + encodeURIComponent(name) : ''), {
          method: 'PUT',
          headers: { 'If-Match': String(revision) },
          body: JSON.stringify(spec),
        }),
        updateAgentBindings: (id, bindings, revision) => request('/api/v1/agents/' + encodeURIComponent(id) + '/bindings', {
          method: 'PUT',
          headers: { 'If-Match': String(revision) },
          body: JSON.stringify(bindings),
        }),
        createBuild: (id, revision, idempotencyKey) => request('/api/v1/agents/' + encodeURIComponent(id) + '/builds', {
          method: 'POST',
          headers: { 'Idempotency-Key': idempotencyKey },
          body: JSON.stringify({ revision }),
        }),
        build: id => request('/api/v1/builds/' + encodeURIComponent(id)),
        createDeployment: (buildId, payload, idempotencyKey) => request('/api/v1/builds/' + encodeURIComponent(buildId) + '/deployments', {
          method: 'POST',
          headers: { 'Idempotency-Key': idempotencyKey },
          body: JSON.stringify(payload),
        }),
        deployments: () => request('/api/v1/deployments'),
        operations: () => request('/api/v1/workspaces/operations'),
        cancelOperation: id => request('/api/v1/operations/' + encodeURIComponent(id) + ':cancel', { method: 'POST' }),
        // Host-owned route reserved for the bound-Agent admission contract.
        // The official DSH composer currently has no public sink/input hook,
        // so this helper is not invoked by the native session.prompt path.
        streamAgentConversation: async (agentId, sessionId, input, signal) => {
          const surface = await request('/api/v1/agents/' + encodeURIComponent(agentId)
            + '/conversation-surface?sessionId=' + encodeURIComponent(sessionId));
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
        resources: options => {
          const value = typeof options === 'string' ? { kind: options, limit: 200 } : (options || {});
          if (directServer() && ['mcp', 'skill'].includes(value.kind)) {
            const action = value.kind === 'mcp' ? 'ListMCPs' : 'ListSkillWorkspaces';
            return serverAction(action, { Page: 1, PageSize: Math.min(Number(value.limit || 200), 100) })
              .catch(() => request('/api/v1/catalog/resources?' + new URLSearchParams({ kind: value.kind, limit: String(value.limit || 20), ...(value.cursor ? { cursor: value.cursor } : {}), ...(value.query ? { query: value.query } : {}) }).toString()));
          }
          const params = new URLSearchParams();
          if (value.kind) params.set('kind', value.kind);
          params.set('limit', String(value.limit || 20));
          if (value.cursor) params.set('cursor', value.cursor);
          if (value.query) params.set('query', value.query);
          if (value.status) params.set('status', value.status);
          if (value.source) params.set('source', value.source);
          if (value.sort) params.set('sort', value.sort);
          return request('/api/v1/catalog/resources?' + params.toString());
        },
        // Resource lifecycle routes intentionally stay Host-owned.  The
        // catalog page uses these public contracts to create/probe MCPs and
        // to inspect/commit local Skills; it never writes the workspace from
        // the browser itself.
        createMcpResource: payload => request('/api/v1/catalog/mcp-servers', { method: 'POST', body: JSON.stringify(payload) }),
        createModelResource: payload => request('/api/v1/catalog/model-profiles', { method: 'POST', body: JSON.stringify(payload) }),
        createToolResource: payload => request('/api/v1/catalog/tools', { method: 'POST', body: JSON.stringify(payload) }),
        deleteResource: resourceId => request('/api/v1/catalog/resources/' + encodeURIComponent(resourceId), { method: 'DELETE' }),
        probeMcpResource: (resourceId, timeoutSeconds = 15) => request('/api/v1/catalog/mcp-servers/' + encodeURIComponent(resourceId) + ':probe?timeoutSeconds=' + encodeURIComponent(timeoutSeconds), { method: 'POST' }),
        discoverSkills: scanPaths => request('/api/v1/catalog/skills:discover', { method: 'POST', body: JSON.stringify({ scanPaths: Array.isArray(scanPaths) ? scanPaths : [] }) }),
        previewDiscoveredSkill: (inspectionToken, candidateId, path) => request('/api/v1/catalog/skills/discoveries/' + encodeURIComponent(inspectionToken) + '/candidates/' + encodeURIComponent(candidateId) + '/files' + (path ? '?path=' + encodeURIComponent(path) : '')),
        commitDiscoveredSkill: (inspectionToken, candidateId, overwrite = false) => request('/api/v1/catalog/skills/discoveries/' + encodeURIComponent(inspectionToken) + ':commit', { method: 'POST', body: JSON.stringify({ candidateId, overwrite }) }),
        previewInstalledSkill: (resourceId, path) => request('/api/v1/catalog/skills/' + encodeURIComponent(resourceId) + '/files' + (path ? '?path=' + encodeURIComponent(path) : '')),
        putCredential: (name, value) => request('/api/v1/credentials/' + encodeURIComponent(name), { method: 'PUT', body: JSON.stringify({ value, persistence: 'session' }) }),
        platformResources: kind => {
          if (directServer()) {
            const actions = { 'knowledge-base': 'ListKnowledgeBases', 'memory-instance': 'ListMemoryInstances', 'skill-space': 'ListSkillWorkspaces' };
            const action = actions[kind];
            if (action) return serverAction(action, {})
              .then(value => ({ ...value, connectionRef: 'agentengine-server', pluginRef: 'agentengine-server', componentId: kind, pluginSnapshotDigest: 'server-action-v1' }))
              .catch(() => request('/api/v1/platform-resources?kind=' + encodeURIComponent(kind)));
          }
          return request('/api/v1/platform-resources?kind=' + encodeURIComponent(kind));
        },
        bootstrapPlatformResources: () => request('/api/v1/resource-connections:bootstrap', { method: 'POST' }),
        schedules: agentId => request(agentId ? '/api/v1/agents/' + encodeURIComponent(agentId) + '/schedules' : '/api/v1/schedules'),
        scheduleOccurrences: (taskId, agentId) => request(agentId
          ? '/api/v1/agents/' + encodeURIComponent(agentId) + '/schedules/' + encodeURIComponent(taskId) + '/occurrences'
          : '/api/v1/schedules/' + encodeURIComponent(taskId) + '/occurrences'),
        createSchedule: (agentId, payload) => request('/api/v1/agents/' + encodeURIComponent(agentId) + '/schedules', { method: 'POST', body: JSON.stringify(payload) }),
        updateSchedule: (agentId, taskId, payload) => request('/api/v1/agents/' + encodeURIComponent(agentId) + '/schedules/' + encodeURIComponent(taskId), { method: 'PUT', body: JSON.stringify(payload) }),
        deleteSchedule: (agentId, taskId) => request('/api/v1/agents/' + encodeURIComponent(agentId) + '/schedules/' + encodeURIComponent(taskId), { method: 'DELETE' }),
        runSchedule: (agentId, taskId) => request('/api/v1/agents/' + encodeURIComponent(agentId) + '/schedules/' + encodeURIComponent(taskId) + ':run', { method: 'POST' }),
        dshPlugins: () => request('/api/v1/plugin-ecosystems/dsh/plugins'),
        installDshPlugin: (source, acceptHostPermissions = false) => request('/api/v1/plugin-ecosystems/dsh/plugins:install', {
          method: 'POST', body: JSON.stringify({ source, acceptHostPermissions }),
        }),
        enableDshPlugin: pluginName => request('/api/v1/plugin-ecosystems/dsh/plugins/' + encodeURIComponent(pluginName) + ':enable', { method: 'POST' }),
        disableDshPlugin: pluginName => request('/api/v1/plugin-ecosystems/dsh/plugins/' + encodeURIComponent(pluginName) + ':disable', { method: 'POST' }),
        updateDshPlugin: pluginName => request('/api/v1/plugin-ecosystems/dsh/plugins/' + encodeURIComponent(pluginName) + ':update', {
          method: 'POST', body: JSON.stringify({ acceptHostPermissions: true }),
        }),
        uninstallDshPlugin: pluginName => request('/api/v1/plugin-ecosystems/dsh/plugins/' + encodeURIComponent(pluginName), { method: 'DELETE' }),
        codexPlugins: () => request('/api/v1/plugin-ecosystems/codex/plugins'),
        installCodexPlugin: (pluginId, marketplaceName) => request('/api/v1/plugin-ecosystems/codex/plugins/' + encodeURIComponent(pluginId) + ':install', {
          method: 'POST', body: JSON.stringify({ marketplaceName: marketplaceName || undefined, acceptUndeclaredPermissions: true }),
        }),
        uninstallCodexPlugin: pluginId => request('/api/v1/plugin-ecosystems/codex/plugins/' + encodeURIComponent(pluginId), { method: 'DELETE' }),
        models: () => request('/api/v1/catalog/models'),
        credential: name => request('/api/v1/credentials/' + encodeURIComponent(name)),
        putCredential: (name, value) => request('/api/v1/credentials/' + encodeURIComponent(name), { method: 'PUT', body: JSON.stringify({ value, persistence: 'session' }) }),
        deleteCredential: name => request('/api/v1/credentials/' + encodeURIComponent(name), { method: 'DELETE' }),
        probeModelEndpoint: payload => request('/api/v1/model-endpoints:probe', { method: 'POST', body: JSON.stringify(payload) }),
        evaluationTargets: (query = '') => request('/api/v1/evaluation-targets' + (query ? '?' + query : '')),
        evaluations: (query = '') => request('/api/v1/evaluations' + (query ? '?' + query : '')),
        evaluation: id => request('/api/v1/evaluations/' + encodeURIComponent(id)),
        evaluationRun: id => request('/api/v1/evaluation-runs/' + encodeURIComponent(id)),
        evaluationRuns: (query = '') => request('/api/v1/evaluation-runs' + (query ? '?' + query : '')),
        createEvaluation: (payload, idempotencyKey) => request('/api/v1/evaluations', { method: 'POST', headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined, body: JSON.stringify(payload) }),
        importEvaluationFile: body => request('/api/v1/evaluation-files', { method: 'POST', body }),
        tracesOverview: (query = '') => request('/api/v1/traces/overview' + (query ? '?' + query : '')),
        traces: (query = '') => request('/api/v1/traces' + (query ? '?' + query : '')),
        trace: id => request('/api/v1/traces/' + encodeURIComponent(id)),
        traceOtlp: id => request('/api/v1/traces/' + encodeURIComponent(id) + '/otlp'),
        exportSessionLog: (id, query = '') => request('/api/v1/sessions/' + encodeURIComponent(id) + ':export' + (query ? '?' + query : '')),
        channelConnection: () => request('/api/v1/channels/connection'),
        updateChannelConnection: payload => request('/api/v1/channels/connection', { method: 'PUT', body: JSON.stringify(payload) }),
        updateAgentChannelConnection: (id, payload) => request('/api/v1/channels/agents/' + encodeURIComponent(id) + '/connection', { method: 'PUT', body: JSON.stringify(payload) }),
        channelAction: (action, payload = {}) => request('/agentengine/api/v1/' + encodeURIComponent(action), { method: 'POST', body: JSON.stringify(payload) }),
      };
    }

    let activeConnection = null;
    const hostRemote = createHostRemote({ get rpc() { return activeConnection?.rpc; } });

    function conversationAgentStorageKey(sessionId) {
      return sessionId ? `${CONVERSATION_AGENT_KEY}:${sessionId}` : CONVERSATION_AGENT_KEY;
    }

    function readConversationAgent(sessionId) {
      try {
        const raw = window.localStorage.getItem(conversationAgentStorageKey(sessionId));
        if (!raw) return null;
        const value = JSON.parse(raw);
        return typeof value?.agentId === 'string' && value.agentId ? value.agentId : null;
      } catch {
        return null;
      }
    }

    function writeConversationAgent(agentId, sessionId) {
      const value = { agentId: agentId || null, updatedAt: Date.now() };
      try { window.localStorage.setItem(conversationAgentStorageKey(sessionId), JSON.stringify(value)); } catch { /* private mode */ }
      window.__AGENTKIT_STUDIO_CONVERSATION__ = value;
      window.dispatchEvent(new CustomEvent('agentkit-studio:conversation-context-change', { detail: value }));
    }

    const BRAND = {
      // Use the established Studio neutral console tokens. The AgentKit mark,
      // layout and product surfaces remain owned by this application.
      ink: 'var(--dsw-alias-label-primary, #0d0d0d)',
      inkMuted: 'var(--dsw-alias-label-secondary, #676767)',
      canvas: 'var(--dsw-alias-bg-base, #f9f9f9)',
      surface: 'var(--dsw-alias-bg-layer-1, #ffffff)',
      border: 'var(--dsw-alias-border-l1, #e5e5e5)',
      accent: 'var(--dsw-alias-brand-primary, #0d0d0d)',
      accentStrong: 'var(--dsw-alias-label-primary, #000000)',
      // DSH's primary button token intentionally flips to white in dark mode.
      // Studio buttons always pair a dark fill with white text so the product
      // controls remain legible in both themes.
      primaryFill: '#0b0b0d',
      accentSoft: 'var(--dsw-alias-interactive-bg-hover, #f0f0f0)',
      signal: 'var(--dsw-alias-state-warn-primary, #946200)',
      danger: 'var(--dsw-alias-state-error-primary, #b42318)',
    };

    // These rows are mounted directly below DSH's New Session control. There
    // is no parent "AgentKit Studio" tab; DSH owns the workspace/session list
    // immediately below this product navigation.
    // Keep the first level small like the original Studio. A runtime is an
    // Agent Revision's execution target, while the operations group is where
    // runs, builds and their evidence live. The detailed domains are exposed
    // as secondary tabs inside these workspaces instead of nine competing
    // sidebar rows.
    const PANELS = [
      { id: 'studio-overview', page: 'overview', label: '总览', note: '工作区状态', glyph: '⌂' },
      { id: 'studio-agents', page: 'agents', label: 'Agents', note: '创建与版本', glyph: '✦' },
      { id: 'studio-resources', page: 'resource-hub', label: '资源库', note: '模型、工具与插件', glyph: '◈' },
      { id: 'studio-operations', page: 'operations', label: '运行中心', note: '构建、部署与观测', glyph: '↗' },
    ];

    // The product mark must not inherit DSH's `--dsw-alias-brand-primary`.
    // That token is intentionally black in the neutral Studio console and
    // made the AgentKit A look like the host mark in the sidebar.  Keep the
    // approved AgentKit teal fixed across light/dark themes and the favicon.
    const STUDIO_MARK_COLOR = '#0aa6a6';

    function StudioMark({ size = 28, title = 'AgentKit Studio' }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 64 64',
        role: title ? 'img' : 'presentation',
        'aria-label': title || undefined,
        'aria-hidden': title ? undefined : 'true',
        style: { display: 'block', flex: '0 0 auto' },
      },
      title ? h('title', null, title) : null,
      // The mark is shared by the sidebar, conversation hero and favicon. Use
      // the Studio teal for the A itself so the product stays recognisable in
      // both DSH light and dark themes; the surrounding ring is deliberately
      // unfilled, matching the original Studio chrome instead of the DSH
      // whale/black-square mark.
      h('path', {
        d: 'M32 6 7 54h11l5-10h18l5 10h11L32 6Zm0 18 5 10H27l5-10Z',
        fill: STUDIO_MARK_COLOR,
      }),
      h('circle', { cx: '32', cy: '32', r: '29', fill: 'none', stroke: STUDIO_MARK_COLOR, strokeWidth: '2', opacity: '0.78' }));
    }

    function NavGlyph({ glyph, active }) {
      return h('span', {
        'aria-hidden': 'true',
        style: {
          display: 'grid',
          placeItems: 'center',
          width: '24px',
          height: '24px',
          borderRadius: '7px',
          color: active ? BRAND.accentStrong : BRAND.inkMuted,
          background: active ? BRAND.accentSoft : 'transparent',
          fontSize: '15px',
          fontWeight: 700,
        },
      }, glyph || '·');
    }

    function Pill({ children, tone = 'neutral' }) {
      const styles = {
        neutral: { color: BRAND.inkMuted, background: 'var(--dsw-alias-bg-layer-2, #edf2f7)' },
        accent: { color: BRAND.accentStrong, background: BRAND.accentSoft },
        signal: { color: 'var(--dsw-alias-state-warn-primary, #8a5b13)', background: 'var(--dsw-alias-state-warn-tertiary, #fff3da)' },
      }[tone];
      return h('span', {
        style: {
          display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '5px 9px',
          borderRadius: '999px', fontSize: '11px', fontWeight: 700, whiteSpace: 'nowrap', ...styles,
        },
      }, children);
    }

    function SectionHeading({ eyebrow, title, detail, action }) {
      return h('div', { 'data-studio-heading': 'true', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: '20px', marginBottom: '18px' } },
        h('div', null,
          eyebrow ? h('div', { style: { color: BRAND.accentStrong, fontSize: '11px', fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: '7px' } }, eyebrow) : null,
          h('h2', { style: { margin: 0, color: BRAND.ink, fontSize: '22px', letterSpacing: '-0.02em' } }, title),
          detail ? h('p', { style: { color: BRAND.inkMuted, margin: '7px 0 0', lineHeight: 1.55, fontSize: '13px' } }, detail) : null),
        action || null);
    }

    // Operational pages use the compact document-header rhythm: one
    // compact title row, a short description and the actions at the same
    // baseline.  The application already owns the global page title, so repeating
    // the all-caps eyebrow here only consumed vertical space and made the
    // Channels/Automation/Evaluation pages look like nested mock screens.
    function OperationalPageHeading({ title, detail, action }) {
      return h('div', {
        'data-studio-heading': 'true',
        style: {
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          gap: '16px', flexWrap: 'wrap', marginBottom: '14px', paddingBottom: '12px',
          borderBottom: '1px solid ' + BRAND.border,
        },
      },
      h('div', { style: { minWidth: 0 } },
        h('h2', { style: { margin: 0, color: BRAND.ink, fontSize: '19px', letterSpacing: '-0.02em' } }, title),
        detail ? h('p', { style: { color: BRAND.inkMuted, margin: '5px 0 0', lineHeight: 1.45, fontSize: '12px', maxWidth: '760px' } }, detail) : null),
      action || null);
    }

    function OperationalPanel({ title, detail, action, children }) {
      return h('section', {
        style: { border: '1px solid ' + BRAND.border, borderRadius: '12px', overflow: 'hidden', background: BRAND.surface },
      },
      (title || action) ? h('div', {
        style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap', padding: '11px 14px', borderBottom: '1px solid ' + BRAND.border },
      }, h('div', null,
        title ? h('strong', { style: { color: BRAND.ink, fontSize: '13px' } }, title) : null,
        detail ? h('div', { style: { color: BRAND.inkMuted, fontSize: '11px', marginTop: '3px' } }, detail) : null), action || null) : null,
      children);
    }

    // The Studio application already owns the page title. Inner workspaces use this
    // compact context row so a panel never renders the same title twice.
    function ContentIntro({ detail, action }) {
      return h('div', {
        'data-studio-content-intro': 'true',
        style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px', marginBottom: '16px' },
      }, h('p', { style: { color: BRAND.inkMuted, margin: 0, lineHeight: 1.55, fontSize: '12px' } }, detail), action || null);
    }

    function Metric({ label, value, detail, tone = 'neutral' }) {
      return h('article', {
        style: {
          border: '1px solid ' + BRAND.border, borderRadius: '14px', padding: '16px',
          background: BRAND.surface, minHeight: '106px', boxShadow: '0 8px 24px rgba(11,18,32,0.04)',
        },
      },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' } },
        h('span', { style: { color: BRAND.inkMuted, fontSize: '12px', fontWeight: 700 } }, label),
        tone === 'signal' ? h(Pill, { tone: 'signal' }, '待接入') : null),
      h('div', { style: { color: BRAND.ink, fontSize: '24px', fontWeight: 750, marginTop: '14px', letterSpacing: '-0.03em' } }, value),
      h('div', { style: { color: BRAND.inkMuted, fontSize: '12px', marginTop: '4px' } }, detail));
    }

    function EmptyState({ icon, title, detail, action }) {
      return h('div', {
        style: {
          minHeight: '220px', display: 'grid', placeItems: 'center', textAlign: 'center', padding: '28px',
          border: '1px dashed ' + BRAND.border, borderRadius: '16px', background: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.66))',
        },
      },
      h('div', null,
        h('div', { style: { margin: '0 auto 14px', display: 'grid', placeItems: 'center', width: '44px', height: '44px', borderRadius: '13px', color: BRAND.accentStrong, background: BRAND.accentSoft, fontSize: '22px', fontWeight: 800 } }, icon),
        h('h3', { style: { margin: 0, color: BRAND.ink, fontSize: '16px' } }, title),
        h('p', { style: { maxWidth: '420px', color: BRAND.inkMuted, lineHeight: 1.6, margin: '8px auto 16px', fontSize: '13px' } }, detail),
        action || null));
    }

    function DisabledAction({ children }) {
      return h('button', {
        type: 'button', disabled: true,
        style: { border: '1px solid ' + BRAND.border, borderRadius: '9px', padding: '8px 12px', color: 'var(--dsw-alias-label-tertiary, #8290a1)', background: 'var(--dsw-alias-bg-layer-2, #f4f7fa)', fontSize: '12px', fontWeight: 700, cursor: 'not-allowed' },
      }, children);
    }
