/* global window */

/**
 * Browser half of AgentKit Studio.
 *
 * Studio contributes one DSH global panel containing its product shell. The
 * shell owns Studio navigation and control-plane pages; DSH keeps ownership
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
      harness: 'KsADK Harness（外部运行时）',
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
        evaluationTargets: () => request('/api/v1/evaluation-targets'),
        evaluations: () => request('/api/v1/evaluations'),
        evaluationRuns: () => request('/api/v1/evaluation-runs'),
        tracesOverview: () => request('/api/v1/traces/overview'),
        channelConnection: () => request('/api/v1/channels/connection'),
      };
    }

    let activeConnection = null;
    const hostRemote = createHostRemote({ get rpc() { return activeConnection?.rpc; } });

    function readConversationAgent() {
      try {
        const raw = window.localStorage.getItem(CONVERSATION_AGENT_KEY);
        if (!raw) return null;
        const value = JSON.parse(raw);
        return typeof value?.agentId === 'string' && value.agentId ? value.agentId : null;
      } catch {
        return null;
      }
    }

    function writeConversationAgent(agentId) {
      const value = { agentId: agentId || null, updatedAt: Date.now() };
      try { window.localStorage.setItem(CONVERSATION_AGENT_KEY, JSON.stringify(value)); } catch { /* private mode */ }
      window.__AGENTKIT_STUDIO_CONVERSATION__ = value;
      window.dispatchEvent(new CustomEvent('agentkit-studio:conversation-context-change', { detail: value }));
    }

    const BRAND = {
      // Match the original Studio neutral console tokens. The AgentKit mark
      // remains ours, while surfaces, controls and status colors follow the
      // old Studio so the plugin feels like one product instead of a second
      // visual system mounted inside DSH.
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
      return h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: '20px', marginBottom: '18px' } },
        h('div', null,
          eyebrow ? h('div', { style: { color: BRAND.accentStrong, fontSize: '11px', fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: '7px' } }, eyebrow) : null,
          h('h2', { style: { margin: 0, color: BRAND.ink, fontSize: '22px', letterSpacing: '-0.02em' } }, title),
          detail ? h('p', { style: { color: BRAND.inkMuted, margin: '7px 0 0', lineHeight: 1.55, fontSize: '13px' } }, detail) : null),
        action || null);
    }

    // The StudioShell already owns the page title. Inner workspaces use this
    // compact context row so a panel never renders the same title twice.
    function ContentIntro({ detail, action }) {
      return h('div', {
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

    function OverviewPage({ onNavigate }) {
      const directServerMode = Boolean(window.__AGENTKIT_STUDIO__?.controlPlane === 'agentengine-server');
      const [connection, setConnection] = useState({ status: 'loading', agents: 0, runtimes: 0, error: '' });
      const load = async () => {
        setConnection(current => ({ ...current, status: 'loading', error: '' }));
        try {
          const [health, bootstrap, agentResult, runtimeResult] = await Promise.all([
            hostRemote.health(), hostRemote.bootstrap(), hostRemote.agents(), hostRemote.runtimes(),
          ]);
          const runtimeItems = Array.isArray(runtimeResult?.items)
            ? runtimeResult.items.filter(item => ALLOWED_RUNTIME_TYPES.includes(item.runtimeType)) : [];
          setConnection({
            status: health?.status === 'ok' && bootstrap?.workspaceReady !== false ? 'ready' : 'error',
            agents: Array.isArray(agentResult?.items) ? agentResult.items.length : 0,
          runtimes: runtimeItems.length,
            error: health?.status === 'ok' ? '' : 'Host health 未通过',
          });
        } catch (reason) {
          setConnection({ status: 'error', agents: 0, runtimes: 0, error: reason?.message || (directServerMode ? 'AgentEngine Server 不可达' : 'DSH Host 不可达') });
        }
      };
      useEffect(() => { load(); }, []);
      const hostReady = connection.status === 'ready';
      const readiness = hostReady ? 4 : 3;
      const statusRows = [
        ['AgentKit Studio 外壳', true],
        ['官方会话内核', true],
        ['工作台 Dock', true],
        [directServerMode ? 'AgentEngine Server' : 'DSH Host', hostReady],
      ].map(([item, ready], index) => h('div', {
        key: item,
        style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: index === 3 ? 'none' : '1px solid ' + BRAND.border, fontSize: '13px' },
      }, h('span', { style: { color: BRAND.ink } }, item), h(Pill, { tone: ready ? 'accent' : 'signal' }, ready ? '就绪' : '等待')));
      const hero = h('section', {
        style: { display: 'grid', gridTemplateColumns: 'minmax(0,1.45fr) minmax(260px,0.75fr)', gap: '20px', padding: '24px', borderRadius: '16px', color: BRAND.ink, overflow: 'hidden', background: BRAND.surface, border: '1px solid ' + BRAND.border, boxShadow: '0 8px 24px rgba(0,0,0,0.04)' },
      },
      h('div', null,
        h(Pill, { tone: 'accent' }, '本地工作区'),
        h('h2', { style: { margin: '18px 0 10px', fontSize: '29px', lineHeight: 1.15, letterSpacing: '-0.04em' } }, '把 Agent 从想法交付到运行'),
        h('p', { style: { maxWidth: '560px', color: BRAND.inkMuted, lineHeight: 1.65, margin: 0, fontSize: '14px' } }, '在同一个工作区管理 Agent、运行时、资源和交付版本。对话与工作台会话由底层运行时统一承载。'),
        h('div', { style: { display: 'flex', gap: '10px', marginTop: '22px', flexWrap: 'wrap' } },
          h(DisabledAction, null, '创建第一个 Agent'),
          h('button', { type: 'button', onClick: () => onNavigate && onNavigate('studio-agents'), style: { border: '1px solid ' + BRAND.border, borderRadius: '9px', padding: '8px 12px', color: BRAND.ink, background: BRAND.surface, fontSize: '12px', fontWeight: 700 } }, '查看 Agents'))),
      h('div', { style: { alignSelf: 'stretch', borderLeft: '1px solid ' + BRAND.border, paddingLeft: '20px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' } },
        h('div', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase' } }, 'Workspace readiness'),
        h('div', null,
          h('div', { style: { fontSize: '34px', fontWeight: 750, letterSpacing: '-0.04em' } }, `${readiness} / 4`),
          h('div', { style: { color: BRAND.inkMuted, fontSize: '12px', marginTop: '5px' } }, hostReady ? (directServerMode ? 'AgentEngine 控制面已连接' : 'DSH Host 已连接') : (directServerMode ? '等待 AgentEngine Server' : '等待本机 DSH Host')),
          h('div', { style: { marginTop: '18px', height: '5px', borderRadius: '5px', background: BRAND.accentSoft } },
            h('div', { style: { width: `${readiness * 25}%`, height: '100%', borderRadius: '5px', background: BRAND.primaryFill } })))));
      const metrics = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: '12px', marginTop: '18px' } },
        h(Metric, { label: 'Agent', value: String(connection.agents), detail: connection.agents ? '当前工作区' : '尚未读取' }), h(Metric, { label: '运行时', value: String(connection.runtimes), detail: hostReady ? 'DSH Native / KsADK Harness / Codex 可用' : (directServerMode ? '等待 AgentEngine Server' : '等待 DSH Host'), tone: hostReady ? 'neutral' : 'signal' }),
        h(Metric, { label: '资源', value: '—', detail: '尚未绑定' }), h(Metric, { label: '交付', value: '—', detail: '尚未构建' }));
      const cards = h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0,1.12fr) minmax(260px,0.88fr)', gap: '18px', marginTop: '18px' } },
        h('section', { style: { border: '1px solid ' + BRAND.border, borderRadius: '16px', padding: '20px', background: BRAND.surface } },
          h(SectionHeading, { eyebrow: 'Start here', title: '从一个 Agent 开始', detail: directServerMode ? 'Agent、运行时和资源由 AgentEngine Server 控制面提供；本地 DSH 只承载 Studio 壳和原生会话。' : 'Agent、运行时和资源会在接入 DSH Host 后成为可操作的产品对象。' }),
          connection.status === 'loading' ? h(EmptyState, { icon: '·', title: directServerMode ? '正在读取 AgentEngine Server' : '正在读取 DSH Host', detail: directServerMode ? '读取 Server catalog、详情和运行时能力。' : '读取 health、workspace 和 runtime capability。' }) : connection.status === 'error' ? h(EmptyState, { icon: '!', title: directServerMode ? 'AgentEngine Server 不可达' : 'DSH Host 尚未连接', detail: connection.error || (directServerMode ? '检查 ~/.agentkit 配置、云端凭证和网络。' : '启动本地 DSH Host 后点击重试。'), action: h('button', { type: 'button', onClick: load, style: buttonStyle() }, '重新连接') }) : h(EmptyState, { icon: '✦', title: connection.agents ? '继续配置 Agent' : '创建第一个 Agent', detail: directServerMode ? 'Server catalog 和运行时能力已通过，可以进入 Agents 页面继续。' : 'Host health 与运行时能力已通过，可以进入 Agents 页面创建本地 Agent。', action: h('button', { type: 'button', onClick: () => onNavigate && onNavigate('studio-agents'), style: buttonStyle() }, '查看 Agents') })),
        h('section', { style: { border: '1px solid ' + BRAND.border, borderRadius: '16px', padding: '20px', background: BRAND.surface } },
          h(SectionHeading, { eyebrow: 'System', title: '工作区状态', detail: '所有状态都来自唯一的 Host 与会话来源。' }),
          h('div', { style: { display: 'grid', gap: '10px' } }, statusRows)));
      return h('div', null, hero, metrics, cards);
    }

    function AgentCard({ agent, onResources }) {
      const metadata = agent?.metadata || agent || {};
      const spec = agent?.spec || {};
      const runtime = spec.runtime?.type || agent?.runtime?.type || 'harness';
      const bindings = spec.bindings || {};
      const modelCount = Array.isArray(bindings.modelProfileIds) && bindings.modelProfileIds.length
        ? bindings.modelProfileIds.length : bindings.modelProfileId ? 1 : 0;
      const mcpCount = Array.isArray(bindings.mcpServers) ? bindings.mcpServers.length : 0;
      const skillCount = Array.isArray(bindings.skills) ? bindings.skills.length : 0;
      const toolCount = Array.isArray(bindings.tools) ? bindings.tools.length : 0;
      const plugins = Array.isArray(bindings.plugins) ? bindings.plugins : [];
      const platformCount = kind => plugins.filter(item => String(item?.config?.binding?.resource?.kind || '') === kind).length;
      const knowledgeBaseCount = platformCount('knowledge-base');
      const memoryCount = platformCount('memory-instance') || (spec.memory?.enabled ? 1 : 0);
      const skillSpaceCount = platformCount('skill-space');
      return h('article', {
        style: { border: '1px solid ' + BRAND.border, borderRadius: '14px', padding: '16px', background: BRAND.surface, boxShadow: '0 8px 24px rgba(11,18,32,0.04)' },
      },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '14px', alignItems: 'flex-start' } },
        h('div', null,
          h('div', { style: { color: BRAND.ink, fontWeight: 750, fontSize: '15px' } }, metadata.name || metadata.id || '未命名 Agent'),
          h('div', { style: { color: BRAND.inkMuted, fontSize: '11px', marginTop: '5px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } }, metadata.id || '—')),
        h(Pill, { tone: runtime === 'dsh-native' || runtime === 'harness' ? 'accent' : 'neutral' }, RUNTIME_LABELS[runtime] || runtime)),
      h('p', { style: { color: BRAND.inkMuted, lineHeight: 1.55, margin: '14px 0 0', fontSize: '12px' } }, spec.description || '本地工作区 Agent，等待绑定模型与首次运行。'),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '14px' } },
        h(Pill, { tone: modelCount ? 'accent' : 'signal' }, `模型 ${modelCount}`),
        h(Pill, { tone: mcpCount ? 'accent' : 'neutral' }, `MCP ${mcpCount}`),
        h(Pill, { tone: skillCount ? 'accent' : 'neutral' }, `Skill ${skillCount}`),
        h(Pill, { tone: toolCount ? 'accent' : 'neutral' }, `Tool ${toolCount}`),
        h(Pill, { tone: knowledgeBaseCount ? 'accent' : 'neutral' }, `知识库 ${knowledgeBaseCount}`),
        h(Pill, { tone: memoryCount ? 'accent' : 'neutral' }, `记忆库 ${memoryCount}`),
        h(Pill, { tone: skillSpaceCount ? 'accent' : 'neutral' }, `Skill Center ${skillSpaceCount}`)),
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', marginTop: '12px' } },
        h('div', { style: { color: 'var(--dsw-alias-label-tertiary, #8a97a8)', fontSize: '11px' } }, 'Revision ' + String(metadata.revision || 1)),
        onResources ? h('button', { type: 'button', onClick: () => onResources(metadata.id || agent?.id), style: { border: '1px solid ' + BRAND.border, borderRadius: '7px', padding: '5px 8px', color: BRAND.accentStrong, background: BRAND.surface, fontSize: '10px', fontWeight: 750 } }, '配置资源') : null));
    }

    /**
     * The header control is deliberately a context selector, not a required
     * Agent picker. DSH can always start a native session with the empty value.
     * Until a public admission/provider mapping exists, a selected Studio
     * Agent is metadata only and must be shown as such instead of implying that
     * the DSH composer has switched execution targets.
     */
    function AgentContextSelector() {
      const [agents, setAgents] = useState([]);
      const [selected, setSelected] = useState(readConversationAgent);

      useEffect(() => {
        let alive = true;
        hostRemote.agents().then(result => {
          if (alive) setAgents(Array.isArray(result?.items) ? result.items : []);
        }).catch(() => { /* no Agent is a valid offline/default state */ });
        return () => { alive = false; };
      }, []);

      const select = event => {
        const value = event.target.value || null;
        setSelected(value);
        writeConversationAgent(value);
      };
      const openBoundConversation = () => {
        if (!selected) return;
        try { window.localStorage.setItem(OPEN_BOUND_CONVERSATION_KEY, selected); } catch {}
        window.dispatchEvent(new CustomEvent('agentkit-studio:open-bound-conversation', { detail: { agentId: selected } }));
      };
      const selectedAgent = agents.find(agent => (agent?.metadata?.id || agent?.id) === selected);
      return h('div', {
        title: '这里只记录候选智能体，不改变当前会话。要使用指定智能体，请从 Agents 页面打开绑定对话。',
        style: { display: 'inline-flex', alignItems: 'center', gap: '7px', minWidth: '0', color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 },
      },
      h('span', { style: { color: BRAND.accentStrong, whiteSpace: 'nowrap' } }, '候选智能体'),
      h('select', {
        'aria-label': '候选智能体（不改变当前会话）',
        value: selected || '',
        onChange: select,
        style: { maxWidth: '230px', height: '30px', padding: '0 9px', border: '1px solid ' + BRAND.border, borderRadius: '8px', color: BRAND.ink, background: BRAND.surface, fontSize: '11px', fontWeight: 700 },
      },
      h('option', { value: '' }, '无 Agent · DSH 原生会话'),
      selected && !selectedAgent ? h('option', { value: selected }, `已选：${selected}（暂不可读取）`) : null,
      agents.map(agent => {
        const id = agent?.metadata?.id || agent?.id;
        const name = agent?.metadata?.name || agent?.name || id;
        const runtime = agent?.spec?.runtime?.type || agent?.runtime?.type;
        return h('option', { key: id, value: id }, `${name} · ${RUNTIME_LABELS[runtime] || runtime || 'Agent'}`);
      })),
      h(Pill, { tone: selected ? 'signal' : 'accent' }, selected ? '未绑定当前会话' : 'DSH 原生'),
      selected && selectedAgent ? h('button', { type: 'button', onClick: openBoundConversation, title: '打开一个绑定该 Agent 的新会话；当前 DSH 会话保持不变', style: { height: '28px', border: '1px solid ' + BRAND.border, borderRadius: '7px', padding: '0 8px', color: BRAND.ink, background: BRAND.surface, fontSize: '10px', fontWeight: 750, cursor: 'pointer' } }, '打开绑定对话') : null,
      h('button', { type: 'button', onClick: () => { try { window.localStorage.setItem('agentkit-studio:open-authoring', 'conversation'); } catch {} window.dispatchEvent(new CustomEvent('agentkit-studio:open-authoring', { detail: 'conversation' })); }, style: { height: '28px', border: '1px solid ' + BRAND.border, borderRadius: '7px', padding: '0 8px', color: BRAND.ink, background: BRAND.surface, fontSize: '10px', fontWeight: 750, cursor: 'pointer' } }, '创建 Agent'));
      // This entry point is available from the real DSH conversation header.
      // It opens Studio's multi-turn authoring surface without replacing the
      // native session composer or pretending that an Agent has been bound.
    }

    function StudioSubnav({ items, value, onChange }) {
      return h('nav', {
        'aria-label': 'Studio 二级导航',
        style: { display: 'flex', flexWrap: 'wrap', gap: 0, padding: 0, marginBottom: '20px', border: 0, borderBottom: '1px solid ' + BRAND.border, borderRadius: 0, background: 'transparent' },
      }, items.map(item => h('button', {
        key: item.id,
        type: 'button',
        onClick: () => onChange(item.id),
        'aria-current': value === item.id ? 'page' : undefined,
        style: { minHeight: '32px', border: 0, borderBottom: '2px solid ' + (value === item.id ? BRAND.accentStrong : 'transparent'), borderRadius: 0, padding: '0 16px', color: value === item.id ? BRAND.accentStrong : BRAND.inkMuted, background: 'transparent', fontSize: '12px', fontWeight: value === item.id ? 800 : 650, cursor: 'pointer' },
      }, item.label)));
    }

    function StudioPageTabs({ items, value, onChange, ariaLabel }) {
      return h('nav', {
        'aria-label': ariaLabel || '页面标签',
        role: 'tablist',
        style: { display: 'flex', flexWrap: 'wrap', gap: 0, padding: 0, marginBottom: '14px', border: 0, borderBottom: '1px solid ' + BRAND.border, borderRadius: 0, background: 'transparent' },
      }, items.map(item => h('button', {
        key: item.id,
        type: 'button',
        role: 'tab',
        'aria-selected': value === item.id,
        onClick: () => onChange(item.id),
        style: { minHeight: '32px', border: 0, borderBottom: '2px solid ' + (value === item.id ? BRAND.accentStrong : 'transparent'), borderRadius: 0, padding: '0 16px', color: value === item.id ? BRAND.accentStrong : BRAND.inkMuted, background: 'transparent', fontSize: '12px', fontWeight: value === item.id ? 800 : 650, cursor: 'pointer' },
      }, item.label)));
    }

    function RuntimeCatalogPage({ onNavigate }) {
      const [status, setStatus] = useState('loading');
      const [items, setItems] = useState([]);
      const [codexProviderReady, setCodexProviderReady] = useState(true);
      const [error, setError] = useState('');
      const directServerMode = Boolean(window.__AGENTKIT_STUDIO__?.controlPlane === 'agentengine-server');
      const load = async () => {
        setStatus('loading'); setError('');
        try {
          const [result, pluginResult] = await Promise.all([
            hostRemote.runtimes(),
            directServerMode ? Promise.resolve(null) : hostRemote.dshPlugins().catch(() => null),
          ]);
          setItems((result?.items || []).filter(item => ALLOWED_RUNTIME_TYPES.includes(item.runtimeType)));
          if (!directServerMode && pluginResult) {
            const codex = (pluginResult.items || []).find(item => String(item.pluginId || item.id || item.name || '').includes('subagent-codex'));
            setCodexProviderReady(Boolean(codex?.installed && codex?.enabled !== false));
          }
          setStatus('ready');
        } catch (reason) { setError(reason?.message || 'Host 尚未连接'); setStatus('error'); }
      };
      useEffect(() => { void load(); }, []);
      return h('div', null,
        h(SectionHeading, { eyebrow: 'Agents / Runtime target', title: '运行目标', detail: '运行时回答“这个 Agent 由谁执行”；它属于 Agent Revision，不是独立会话类型。对话页未选择 Agent 时仍走 DSH 原生会话。', action: h(Pill, { tone: status === 'ready' ? 'accent' : 'signal' }, status === 'ready' ? '目录已读取' : 'Host 待接入') }),
        status === 'loading' ? h(EmptyState, { icon: '·', title: '正在读取运行目标', detail: directServerMode ? '从 AgentEngine Server 读取已注册的运行时能力。' : '从本地 Host 读取可用 Harness capability。' }) : null,
        status === 'error' ? h(EmptyState, { icon: '!', title: '运行目标不可用', detail: error, action: h('button', { type: 'button', onClick: load, style: buttonStyle() }, '重新读取') }) : null,
        status === 'ready' && !items.length ? h(EmptyState, { icon: '⌁', title: '没有可用运行目标', detail: 'Host 没有返回 DSH Native、KsADK Harness 或 Codex capability。' }) : null,
        status === 'ready' && items.length ? h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: '12px' } }, items.map(item => {
          const codexUnavailable = item.runtimeType === 'codex' && !codexProviderReady;
          return h('article', { key: item.runtimeType, style: { border: '1px solid ' + BRAND.border, borderRadius: '12px', padding: '16px', background: BRAND.surface } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center' } }, h('strong', { style: { color: BRAND.ink, fontSize: '14px' } }, RUNTIME_LABELS[item.runtimeType] || item.runtimeType), h(Pill, { tone: codexUnavailable ? 'signal' : 'accent' }, codexUnavailable ? 'Provider 未注册' : '可选')),
          h('div', { style: { marginTop: '8px', color: BRAND.inkMuted, fontSize: '11px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } }, item.runtimeType),
          h('p', { style: { margin: '12px 0 0', color: BRAND.inkMuted, lineHeight: 1.55, fontSize: '12px' } }, codexUnavailable ? '请在插件市场安装并启用官方 @deepseek-ai/dsh-subagent-codex，重启 DSH profile 后再创建 Codex Agent。' : item.description || '由 Host 提供的 Agent 执行目标。'),
          codexUnavailable ? h('button', { type: 'button', onClick: () => { try { window.localStorage.setItem('agentkit-studio:resource-tab', 'marketplace'); } catch {} onNavigate?.('studio-resources'); }, style: { ...buttonStyle(), marginTop: '12px' } }, '打开插件市场') : null);
        })) : null);
    }

    function AgentWorkspace({ onNavigate }) {
      const [view, setView] = useState(() => {
        try {
          const requested = window.localStorage.getItem('agentkit-studio:open-authoring');
          if (requested) window.localStorage.removeItem('agentkit-studio:open-authoring');
          return requested === 'conversation' ? 'conversation-create' : 'list';
        } catch { return 'list'; }
      });
      const [tab, setTab] = useState('agents');
      const [createMode, setCreateMode] = useState('quick');
      const [created, setCreated] = useState(null);
      const [editingAgent, setEditingAgent] = useState(null);
      const [conversationAgent, setConversationAgent] = useState(null);
      const [pendingBoundAgent, setPendingBoundAgent] = useState(() => {
        try {
          const value = window.localStorage.getItem(OPEN_BOUND_CONVERSATION_KEY);
          if (value) window.localStorage.removeItem(OPEN_BOUND_CONVERSATION_KEY);
          return value || null;
        } catch { return null; }
      });
      useEffect(() => {
        const open = event => { if (event?.detail === 'conversation') setView('conversation-create'); };
        const openBound = event => {
          const agentId = String(event?.detail?.agentId || '').trim();
          if (agentId) setPendingBoundAgent(agentId);
        };
        window.addEventListener('agentkit-studio:open-authoring', open);
        window.addEventListener('agentkit-studio:open-bound-conversation', openBound);
        return () => {
          window.removeEventListener('agentkit-studio:open-authoring', open);
          window.removeEventListener('agentkit-studio:open-bound-conversation', openBound);
        };
      }, []);
      useEffect(() => {
        if (!pendingBoundAgent) return undefined;
        let alive = true;
        hostRemote.agent(pendingBoundAgent).then(agent => {
          if (!alive || !agent) return;
          setConversationAgent(agent);
          setPendingBoundAgent(null);
          setView('bound-conversation');
        }).catch(() => { if (alive) setPendingBoundAgent(null); });
        return () => { alive = false; };
      }, [pendingBoundAgent]);
      if (view === 'conversation-create') {
        return h(ConversationalAgentCreatePage, {
          onBack: () => setView('list'),
          onCreated: agent => { setCreated(agent); setView('list'); },
        });
      }
      if (view === 'bound-conversation') {
        return h(BoundAgentConversationPage, {
          agent: conversationAgent,
          onBack: () => { setConversationAgent(null); setView('list'); },
        });
      }
      if (view === 'create') {
        return h(AgentCreatePage, {
          mode: createMode,
          onBack: () => setView('list'),
          onCreated: agent => { setCreated(agent); setView('list'); },
        });
      }
      if (view === 'edit') return h(AgentEditPage, {
        agentId: editingAgent,
        onBack: () => setView('list'),
        onSaved: agent => { setCreated({ ...agent, updated: true }); setView('list'); },
      });
      return h(AgentsPage, {
        created,
        onNavigate,
        tab,
        onTabChange: setTab,
        onEdit: agent => { setEditingAgent(agent?.metadata?.id || agent.id); setView('edit'); },
        onOpenConversation: agent => { setConversationAgent(agent); setView('bound-conversation'); },
        onCreate: mode => { setCreated(null); if (mode === 'conversation') setView('conversation-create'); else { setCreateMode(mode); setView('create'); } },
      });
    }

    function BoundAgentConversationPage({ agent, onBack }) {
      const metadata = agent?.metadata || agent || {};
      const agentId = String(metadata.id || agent?.id || '').trim();
      const agentName = metadata.name || agent?.name || agentId || '未命名 Agent';
      const runtime = agent?.spec?.runtime?.type || agent?.runtime?.type || 'harness';
      const sessionId = useRef(`studio-agent-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
      const abortRef = useRef(null);
      const [input, setInput] = useState('');
      const [messages, setMessages] = useState([]);
      const [status, setStatus] = useState('ready');
      const [error, setError] = useState('');
      const [runId, setRunId] = useState('');

      useEffect(() => () => abortRef.current?.abort(), []);

      const applyItem = item => {
        if (!item || item.visibility === 'hidden') return;
        const id = String(item.itemId || item.item_id || `item-${Date.now()}`);
        const kind = String(item.kind || 'unknown');
        const payload = item.payload && typeof item.payload === 'object' ? item.payload : {};
        const text = typeof payload.text === 'string' ? payload.text : '';
        if (kind === 'user_message') return;
        if (kind === 'assistant_text' || kind === 'reasoning') {
          setMessages(current => {
            const index = current.findIndex(message => message.id === id);
            const previous = index >= 0 ? current[index] : { id, role: kind === 'reasoning' ? 'reasoning' : 'assistant', text: '' };
            const nextText = item.operation === 'append' ? previous.text + text : (text || previous.text);
            const next = { ...previous, role: kind === 'reasoning' ? 'reasoning' : 'assistant', text: nextText, completed: item.lifecycle === 'completed' };
            if (index < 0) return [...current, next];
            return current.map((message, cursor) => cursor === index ? next : message);
          });
        }
        if (kind === 'progress' && payload.status) setStatus(String(payload.status));
        if (kind === 'error') {
          setError(String(payload.message || payload.error || 'Agent 运行失败'));
          setStatus('failed');
        }
        if (item.runId || item.run_id) setRunId(String(item.runId || item.run_id));
      };

      const consume = async response => {
        if (!response?.body) throw new Error('Host 没有返回事件流');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        const feed = chunk => {
          buffer += chunk;
          let split = buffer.indexOf('\n\n');
          while (split >= 0) {
            const record = buffer.slice(0, split); buffer = buffer.slice(split + 2);
            const data = record.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (data && data !== '[DONE]') {
              try {
                const payload = JSON.parse(data);
                if (payload.conversationItem) applyItem(payload.conversationItem);
                if (payload.runId) setRunId(String(payload.runId));
                const eventType = payload.runtimeEvent?.event_type || payload.type || '';
                if (eventType === 'run.completed') setStatus('completed');
                if (eventType === 'run.failed') setStatus('failed');
              } catch { /* malformed event is ignored; Host contract reports terminal error separately */ }
            }
            split = buffer.indexOf('\n\n');
          }
        };
        try {
          while (true) {
            const result = await reader.read();
            if (result.done) break;
            feed(decoder.decode(result.value, { stream: true }));
          }
          feed(decoder.decode());
        } finally { reader.releaseLock(); }
      };

      const send = async event => {
        event?.preventDefault?.();
        const text = input.trim();
        if (!text || status === 'running' || !agentId) return;
        const inputId = `input-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const idempotencyKey = `studio-${sessionId.current}-${inputId}`;
        const controller = new AbortController();
        abortRef.current = controller;
        setInput(''); setError(''); setStatus('running'); setRunId('');
        setMessages(current => [...current, { id: inputId, role: 'user', text }]);
        try {
          const response = await hostRemote.streamAgentConversation(agentId, sessionId.current, {
            apiVersion: 'conversation.ksadk.io/v1',
            kind: 'ConversationInput', inputId, sessionId: sessionId.current, idempotencyKey,
            parts: [{ kind: 'text', text }],
          }, controller.signal);
          await consume(response);
          setStatus(current => current === 'running' ? 'completed' : current);
        } catch (reason) {
          if (reason?.name === 'AbortError' || controller.signal.aborted) return;
          setError(reason?.message || '绑定 Agent 对话失败'); setStatus('failed');
        } finally { if (abortRef.current === controller) abortRef.current = null; }
      };

      if (!agentId) return h(EmptyState, { icon: '!', title: '没有选择 Agent', detail: '从 Agents 列表打开一个已创建的 Agent。', action: h('button', { type: 'button', onClick: onBack, style: buttonStyle() }, '返回 Agents') });
      return h('div', null,
        h(SectionHeading, { eyebrow: 'Studio domain / Bound conversation', title: agentName, detail: `绑定 Agent 对话 · ${RUNTIME_LABELS[runtime] || runtime} · 会话 ${sessionId.current}`, action: h('button', { type: 'button', onClick: onBack, style: buttonStyle() }, '返回 Agents') }),
        h('section', { style: { border: '1px solid ' + BRAND.border, borderRadius: '14px', padding: '14px', background: BRAND.surface, minHeight: '260px', display: 'flex', flexDirection: 'column', gap: '10px' } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center', color: BRAND.inkMuted, fontSize: '11px' } }, h('span', null, 'Host canonical conversation'), h(Pill, { tone: status === 'completed' ? 'accent' : status === 'failed' ? 'signal' : 'neutral' }, status === 'running' ? '运行中' : status === 'completed' ? '已完成' : status === 'failed' ? '失败' : '就绪')),
          h('div', { style: { flex: 1, display: 'grid', alignContent: 'start', gap: '8px', overflow: 'auto', padding: '4px 0' } }, messages.length ? messages.map(message => h('div', { key: message.id, style: { maxWidth: '82%', justifySelf: message.role === 'user' ? 'end' : 'start', padding: '9px 11px', borderRadius: '10px', whiteSpace: 'pre-wrap', color: BRAND.ink, background: message.role === 'user' ? BRAND.accentSoft : BRAND.canvas, fontSize: '12px', lineHeight: 1.55 } }, message.text || (message.role === 'reasoning' ? '正在思考…' : '…'))) : h('div', { style: { color: BRAND.inkMuted, fontSize: '12px', padding: '28px 0', textAlign: 'center' } }, '发送一条消息，验证当前 Agent 的真实运行时与资源绑定。')),
          runId ? h('div', { style: { color: BRAND.inkMuted, fontSize: '10px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } }, `Run ${runId}`) : null,
          error ? h('div', { role: 'alert', style: { color: BRAND.danger, fontSize: '11px' } }, error) : null,
          h('form', { onSubmit: send, style: { display: 'flex', gap: '8px', alignItems: 'flex-end', borderTop: '1px solid ' + BRAND.border, paddingTop: '10px' } }, h('textarea', { value: input, onChange: event => setInput(event.target.value), disabled: status === 'running', rows: 2, placeholder: '输入消息，发送到这个 Agent…', style: { ...inputStyle(), height: 'auto', padding: '9px 10px', resize: 'vertical', marginTop: 0, flex: 1 } }), h('button', { type: 'submit', disabled: status === 'running' || !input.trim(), style: { ...buttonStyle(), color: status === 'running' || !input.trim() ? BRAND.inkMuted : 'var(--dsw-static-neutral-00, #fff)', background: status === 'running' || !input.trim() ? BRAND.accentSoft : BRAND.primaryFill, borderColor: status === 'running' || !input.trim() ? BRAND.border : 'transparent' } }, status === 'running' ? '运行中…' : '发送'))));
    }

    function AgentsPage({ onCreate, created, onNavigate, onOpenConversation, onEdit, tab, onTabChange }) {
      const directServerMode = Boolean(window.__AGENTKIT_STUDIO__?.controlPlane === 'agentengine-server');
      const [agents, setAgents] = useState([]);
      const [runtimes, setRuntimes] = useState([]);
      const [status, setStatus] = useState('loading');
      const [error, setError] = useState('');
      const [query, setQuery] = useState('');
      const [statusFilter, setStatusFilter] = useState('all');
      const [page, setPage] = useState(1);
      const [pageSize, setPageSize] = useState(20);
      const [total, setTotal] = useState(0);

      const load = async () => {
        setStatus('loading');
        setError('');
        try {
          const [agentResult, runtimeResult] = await Promise.all([hostRemote.agents({ page, pageSize, query }), hostRemote.runtimes()]);
          const listedAgents = Array.isArray(agentResult?.items) ? agentResult.items : [];
          // The list contract is intentionally compact and omits build
          // history. Hydrate each card from the detail contract so status
          // filters, build badges and capability counts reflect the actual
          // Agent Revision instead of a permanently empty list row.
          const hydratedAgents = await Promise.all(listedAgents.map(async item => {
            const id = item?.metadata?.id || item?.id;
            if (!id) return item;
            try {
              const detail = await hostRemote.agent(id);
              return detail ? { ...item, ...detail } : item;
            } catch {
              return item;
            }
          }));
          setAgents(hydratedAgents);
          setTotal(Number.isFinite(Number(agentResult?.total)) ? Number(agentResult.total) : listedAgents.length);
          setRuntimes((runtimeResult?.items || []).filter(item => ALLOWED_RUNTIME_TYPES.includes(item.runtimeType)));
          setStatus('ready');
        } catch (reason) {
          setStatus('error');
          setError(reason?.message || 'Host 尚未连接');
        }
      };
      useEffect(() => { load(); }, [page, pageSize, query]);
      useEffect(() => { setPage(1); }, [query, pageSize]);

      const filteredAgents = agents.filter(agent => {
        const metadata = agent?.metadata || agent || {};
        const id = metadata.id || agent?.id || '';
        const name = metadata.name || agent?.name || id;
        const q = query.trim().toLowerCase();
        const built = Array.isArray(agent?.builds) && agent.builds.some(item => String(item?.status || '').toUpperCase() === 'SUCCEEDED');
        return (!q || String(name).toLowerCase().includes(q) || String(id).toLowerCase().includes(q))
          && (statusFilter === 'all' || (statusFilter === 'built' ? built : !built));
      });
      const filteredPageAgents = filteredAgents;
      const pageCount = Math.max(1, Math.ceil((total || filteredPageAgents.length) / pageSize));
      const agentTable = agents.length ? h('section', { style: { border: '1px solid ' + BRAND.border, borderRadius: '14px', background: BRAND.surface, overflow: 'hidden' } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', padding: '14px 16px', borderBottom: '1px solid ' + BRAND.border, flexWrap: 'wrap' } },
          h('strong', { style: { color: BRAND.ink, fontSize: '13px' } }, `${filteredAgents.length} / ${agents.length} 个 Agent`),
          h('div', { style: { display: 'flex', gap: '8px', minWidth: 'min(100%, 430px)' } },
            h('input', { type: 'search', value: query, onChange: event => setQuery(event.target.value), placeholder: '搜索 Agent 名称或 ID', 'aria-label': '搜索 Agent', style: { ...inputStyle(), marginTop: 0, flex: 1, minWidth: '180px' } }),
            h('select', { value: statusFilter, onChange: event => setStatusFilter(event.target.value), 'aria-label': '筛选 Agent 状态', style: { ...inputStyle(), marginTop: 0, width: '112px' } }, h('option', { value: 'all' }, '全部状态'), h('option', { value: 'built' }, '已构建'), h('option', { value: 'draft' }, '草稿')))),
        h('div', { style: { overflow: 'auto', maxHeight: 'min(64vh, 680px)' } }, h('table', { style: { width: '100%', borderCollapse: 'collapse', minWidth: '860px', fontSize: '12px' } },
          h('thead', null, h('tr', { style: { color: BRAND.inkMuted, textAlign: 'left', background: BRAND.canvas, position: 'sticky', top: 0, zIndex: 1 } }, ['Agent', '运行时', '能力', '版本', '构建', '操作'].map(label => h('th', { key: label, style: { padding: '11px 14px', borderBottom: '1px solid ' + BRAND.border, fontWeight: 750, whiteSpace: 'nowrap' } }, label)))),
          h('tbody', null, filteredPageAgents.map(agent => {
            const metadata = agent?.metadata || agent || {};
            const spec = agent?.spec || {};
            const id = metadata.id || agent?.id || '—';
            const runtime = spec.runtime?.type || agent?.runtime?.type || 'harness';
            const bindings = spec.bindings || {};
            const plugins = Array.isArray(bindings.plugins) ? bindings.plugins : [];
            const platformCount = kind => plugins.filter(item => String(item?.config?.binding?.resource?.kind || '') === kind).length;
            const counts = [
              ['模型', bindings.modelProfileIds?.length || (bindings.modelProfileId ? 1 : 0)],
              ['MCP', bindings.mcpServers?.length || 0],
              ['Skill', bindings.skills?.length || 0],
              ['Tool', bindings.tools?.length || 0],
              ['知识库', platformCount('knowledge-base')],
              ['记忆库', platformCount('memory-instance') || (spec.memory?.enabled ? 1 : 0)],
              ['Skill Center', platformCount('skill-space')],
            ].filter(([, count]) => count);
            const built = Array.isArray(agent?.builds) && agent.builds.some(item => String(item?.status || '').toUpperCase() === 'SUCCEEDED');
            return h('tr', { key: id, style: { borderBottom: '1px solid ' + BRAND.border } },
              h('td', { style: { padding: '13px 14px' } }, h('div', { style: { color: BRAND.ink, fontWeight: 800 } }, metadata.name || id), h('div', { style: { color: BRAND.inkMuted, fontSize: '10px', marginTop: '3px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } }, id)),
              h('td', { style: { padding: '13px 14px', color: BRAND.inkMuted, whiteSpace: 'nowrap' } }, RUNTIME_LABELS[runtime] || runtime),
              h('td', { style: { padding: '13px 14px', color: BRAND.inkMuted, whiteSpace: 'nowrap' } }, counts.length ? counts.map(([label, count]) => `${count} ${label}`).join(' · ') : '—'),
              h('td', { style: { padding: '13px 14px', color: BRAND.inkMuted, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } }, `r${metadata.revision || 1}`),
              h('td', { style: { padding: '13px 14px' } }, h(Pill, { tone: built ? 'accent' : 'signal' }, built ? '已构建' : '草稿')),
              h('td', { style: { padding: '13px 14px', whiteSpace: 'nowrap' } }, h('div', { style: { display: 'flex', gap: '6px' } }, h('button', { type: 'button', onClick: () => onOpenConversation?.(agent), style: { ...buttonStyle(), padding: '6px 9px', fontSize: '11px', color: 'var(--dsw-static-neutral-00, #fff)', background: BRAND.primaryFill, borderColor: 'transparent' } }, '打开绑定对话'), h('button', { type: 'button', onClick: () => onEdit(agent), style: { ...buttonStyle(), padding: '6px 9px', fontSize: '11px' } }, '编辑 Agent'))));
          })))),
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap', padding: '10px 14px', borderTop: '1px solid ' + BRAND.border, color: BRAND.inkMuted, fontSize: '11px' } },
          h('span', null, `${total || filteredPageAgents.length} 个 Agent · 第 ${Math.min(page, pageCount)}/${pageCount} 页`),
          h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
            h('select', { value: String(pageSize), onChange: event => { setPageSize(Number(event.target.value)); setPage(1); }, 'aria-label': '每页显示数量', style: { ...inputStyle(), width: '112px', marginTop: 0, padding: '0 7px' } }, h('option', { value: '10' }, '每页 10 条'), h('option', { value: '20' }, '每页 20 条'), h('option', { value: '50' }, '每页 50 条')),
            h('button', { type: 'button', disabled: page <= 1 || status === 'loading', onClick: () => setPage(current => Math.max(1, current - 1)), style: buttonStyle() }, '上一页'),
            h('button', { type: 'button', disabled: page >= pageCount || status === 'loading', onClick: () => setPage(current => Math.min(pageCount, current + 1)), style: buttonStyle() }, '下一页')))
      ) : null;
      return h('div', null,
        h(StudioSubnav, { value: tab, onChange: onTabChange, items: [{ id: 'agents', label: 'Agent 列表' }, { id: 'runtime', label: '运行目标' }] }),
        tab === 'runtime' ? h(RuntimeCatalogPage, { onNavigate }) : null,
        tab === 'runtime' ? null : h(React.Fragment, null,
        h('section', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px', border: '1px solid ' + BRAND.border, borderRadius: '16px', padding: '18px', background: BRAND.surface, marginBottom: '18px' } },
          h('div', null,
            h('div', { style: { color: BRAND.ink, fontSize: '15px', fontWeight: 800 } }, '从最短路径创建 Agent'),
            h('div', { style: { color: BRAND.inkMuted, fontSize: '12px', lineHeight: 1.55, marginTop: '5px' } }, '快速创建保留最少字段；一键创建使用内置模板；复杂编排可用多轮对话逐步生成并确认。')),
          h('div', { style: { display: 'flex', gap: '8px', flexShrink: 0 } },
            h('button', { type: 'button', onClick: () => onCreate('quick'), disabled: status !== 'ready', style: { height: '38px', border: '1px solid ' + BRAND.border, borderRadius: '9px', padding: '0 14px', color: BRAND.ink, background: BRAND.surface, fontSize: '12px', fontWeight: 800 } }, '快速创建'),
            h('button', { type: 'button', onClick: () => onCreate('conversation'), disabled: status !== 'ready', style: { height: '38px', border: '1px solid ' + BRAND.border, borderRadius: '9px', padding: '0 14px', color: BRAND.ink, background: BRAND.surface, fontSize: '12px', fontWeight: 800 } }, '对话创建'),
            h('button', { type: 'button', onClick: () => onCreate('one-click'), disabled: status !== 'ready', style: { height: '38px', border: 0, borderRadius: '9px', padding: '0 14px', color: 'var(--dsw-static-neutral-00, #fff)', background: status !== 'ready' ? 'var(--dsw-alias-label-tertiary, #aab7c4)' : BRAND.primaryFill, fontSize: '12px', fontWeight: 800 } }, '一键创建'))),
        created ? h('div', { role: 'status', style: { marginBottom: '14px', padding: '11px 13px', borderRadius: '10px', color: BRAND.accentStrong, background: BRAND.accentSoft, fontSize: '12px' } }, `${created.updated ? '已保存' : '已创建'} ${created.name || created.id}，Revision ${created.revision || 1}。可在编辑页调整绑定，在运行中心构建。`) : null,
        status === 'loading' ? h(EmptyState, { icon: '·', title: directServerMode ? '正在读取 AgentEngine Server' : '正在读取 Host', detail: directServerMode ? '从 AgentEngine Server 读取 Agent Catalog 和运行时能力。' : '从 DSH Host 读取 Agent Catalog 和运行时能力。' }) : null,
        status === 'error' ? h(EmptyState, { icon: '!', title: directServerMode ? 'AgentEngine Server 不可达' : 'Host 尚未连接', detail: error || (directServerMode ? '请检查全局 ~/.agentkit 配置、云端凭证和网络；当前不会回退到本地 DSH Host。' : '启动本地 DSH Host 后点击刷新。'), action: h('button', { type: 'button', onClick: load, style: buttonStyle() }, '重新连接') }) : null,
        status === 'ready' && agents.length === 0 ? h(EmptyState, { icon: '✦', title: '还没有 Agent', detail: '使用快速创建或一键创建生成第一个 Agent。' }) : null,
        status === 'ready' && agents.length > 0 && filteredAgents.length === 0 ? h(EmptyState, { icon: '⌕', title: '没有匹配的 Agent', detail: '调整搜索词或状态筛选。' }) : null,
        agentTable));
    }

    const PLATFORM_RESOURCE_META = [
      { kind: 'knowledge-base', label: '知识库', description: '绑定云端知识库，Agent 通过只读检索使用。' },
      { kind: 'memory-instance', label: '记忆库', description: '绑定长期记忆实例，用于跨会话召回与写入。' },
      { kind: 'skill-space', label: 'Skill Center', description: '选择云端 Skill Space；与本地 Skill 分开管理。' },
    ];

    function PlatformResourcePicker({ value, onChange, onMemory }) {
      const [catalogs, setCatalogs] = useState({});
      const [status, setStatus] = useState('loading');
      const [connecting, setConnecting] = useState(false);
      const [error, setError] = useState('');
      const load = async () => {
        setStatus('loading'); setError('');
        const results = await Promise.allSettled(PLATFORM_RESOURCE_META.map(item => hostRemote.platformResources(item.kind)));
        const next = {};
        PLATFORM_RESOURCE_META.forEach((item, index) => {
          const result = results[index];
          if (result?.status === 'fulfilled') next[item.kind] = result.value;
        });
        setCatalogs(next);
        const failed = results.find(item => item.status === 'rejected');
        setError(failed?.reason?.message || '');
        setStatus(Object.keys(next).length ? 'ready' : 'error');
      };
      useEffect(() => { void load(); }, []);
      const bindingKind = binding => String(binding?.config?.binding?.resource?.kind || '');
      const selectedId = kind => String(value.find(binding => bindingKind(binding) === kind)?.config?.binding?.resource?.id || '');
      const select = (kind, resourceId) => {
        const catalog = catalogs[kind];
        if (!catalog?.connectionRef) { setError('请先在设置中填写云端凭证，再连接平台资源。'); return; }
        const retained = value.filter(binding => bindingKind(binding) !== kind);
        if (!resourceId) { onChange(retained); if (kind === 'memory-instance') onMemory(false); return; }
        const resource = (catalog.items || []).find(item => item.id === resourceId);
        if (!resource || resource.disabled) return;
        const config = { schemaVersion: 1, binding: { id: `platform-${kind}`, connectionRef: catalog.connectionRef, resource: { kind, id: resource.id, region: resource.region }, required: true } };
        if (kind === 'knowledge-base') config.retrieval = { mode: 'tool', topK: 5, maxChars: 16000 };
        if (kind === 'skill-space') Object.assign(config, { selectionMode: 'discovery', selectedSkills: [], includePublic: false, executionMode: 'outer-agent' });
        onChange([...retained, { ecosystem: 'dsh', pluginRef: catalog.pluginRef, snapshotDigest: catalog.pluginSnapshotDigest, components: [catalog.componentId], enabled: true, config }]);
        if (kind === 'memory-instance') onMemory(true);
      };
      const connect = async () => {
        setConnecting(true); setError('');
        try { await hostRemote.bootstrapPlatformResources(); await load(); }
        catch (reason) { setError(reason?.message || '平台资源连接失败'); }
        finally { setConnecting(false); }
      };
      const hasConnection = Object.values(catalogs).some(catalog => Boolean(catalog?.connectionRef));
      return h('section', { style: { border: '1px solid ' + BRAND.border, borderRadius: '12px', padding: '14px', background: BRAND.surface, marginTop: '10px' } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', marginBottom: '6px' } },
          h('div', null, h('strong', { style: { color: BRAND.ink, fontSize: '13px' } }, '平台资源'), h('div', { style: { color: BRAND.inkMuted, fontSize: '11px', marginTop: '3px' } }, '创建时绑定知识库、记忆库和 Skill Center，引用会写入 Agent Revision。')),
          h('button', { type: 'button', onClick: connect, disabled: connecting || hasConnection, style: buttonStyle() }, connecting ? '连接中…' : hasConnection ? '平台已连接' : '连接金山云')),
        status === 'loading' ? h('div', { style: { color: BRAND.inkMuted, fontSize: '11px', padding: '8px 0' } }, '正在读取平台资源…') : null,
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '10px', marginTop: '8px' } }, PLATFORM_RESOURCE_META.map(meta => {
          const catalog = catalogs[meta.kind];
          return h('label', { key: meta.kind, style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, meta.label,
            h('select', { value: selectedId(meta.kind), onChange: event => select(meta.kind, event.target.value), style: inputStyle() },
              h('option', { value: '' }, catalog?.connectionRef ? `不绑定${meta.label}` : '请先连接云端'),
              (catalog?.items || []).map(item => h('option', { key: item.id, value: item.id, disabled: item.disabled }, item.disabled ? `${item.name}（不可绑定）` : `${item.name} · ${item.region}`))),
            h('div', { style: { marginTop: '4px', color: BRAND.inkMuted, fontSize: '10px', fontWeight: 400, lineHeight: 1.4 } }, meta.description));
        })),
        error ? h('div', { role: 'alert', style: { marginTop: '8px', color: BRAND.danger, fontSize: '11px' } }, error) : null);
    }

    function conversationalSlug(value) {
      const slug = String(value || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
      return (slug || `conversation-agent-${Date.now()}`).slice(0, 63) || 'conversation-agent';
    }

    function authoringMessageText(message) {
      if (message.role !== 'assistant') return message.content;
      try {
        const snapshot = JSON.parse(message.content);
        return `草稿已更新：${snapshot.name || '待确认 Agent'}\n${snapshot.spec?.description || snapshot.description || '可以继续补充需求。'}`;
      } catch { return message.content; }
    }

    /** Multi-turn authoring uses the Host authoring contract; it never owns a DSH session. */
    function ConversationalAgentCreatePage({ onBack, onCreated }) {
      const [messages, setMessages] = useState([]);
      const [input, setInput] = useState('');
      const [proposal, setProposal] = useState(null);
      const [draft, setDraft] = useState({ name: '', slug: '', description: '', prompt: '', task: '' });
      const [runtime, setRuntime] = useState('dsh-native');
      const [catalog, setCatalog] = useState({ model: [], mcp: [], skill: [] });
      const [authoringModel, setAuthoringModel] = useState('');
      const [agentModels, setAgentModels] = useState([]);
      const [mcp, setMcp] = useState([]);
      const [skills, setSkills] = useState([]);
      const [platformBindings, setPlatformBindings] = useState([]);
      const [memoryEnabled, setMemoryEnabled] = useState(false);
      const [busy, setBusy] = useState(false);
      const [stage, setStage] = useState('');
      const [error, setError] = useState('');
      const [notice, setNotice] = useState('');
      const [settingsOpen, setSettingsOpen] = useState(false);
      const activeRequest = useRef(null);

      useEffect(() => () => { activeRequest.current = null; }, []);

      useEffect(() => {
        let alive = true;
        Promise.allSettled(['model', 'mcp', 'skill'].map(kind => hostRemote.resources({ kind, limit: 100 }))).then(results => {
          if (!alive) return;
          const next = {};
          ['model', 'mcp', 'skill'].forEach((kind, index) => {
            next[kind] = results[index]?.status === 'fulfilled' && Array.isArray(results[index].value?.items) ? results[index].value.items : [];
          });
          setCatalog(next);
          const first = next.model[0]?.resourceId || '';
          setAuthoringModel(value => value || first);
          setAgentModels(value => value.length ? value : (first ? [first] : []));
          if (!first) setError('没有可用于生成草稿的模型，请先在设置中配置模型。');
        });
        return () => { alive = false; };
      }, []);

      const wait = ms => new Promise(resolve => window.setTimeout(resolve, ms));
      const toggle = (setter, id) => setter(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id]);
      const pollStatus = async requestId => {
        for (let index = 0; index < 100 && activeRequest.current === requestId; index += 1) {
          await wait(600);
          if (activeRequest.current !== requestId) return;
          try {
            const result = await hostRemote.authoringConversationStatus(requestId);
            if (activeRequest.current === requestId && result?.stage) setStage(String(result.stage));
            if (['done', 'failed'].includes(String(result?.stage || '').toLowerCase())) return;
          } catch { return; }
        }
      };

      const send = async event => {
        event?.preventDefault?.();
        const text = input.trim();
        if (!text || busy) return;
        if (!authoringModel || !agentModels.length) { setError('请先选择至少一个模型。'); setSettingsOpen(true); return; }
        setError(''); setNotice(''); setBusy(true); setStage('resolving_model'); setInput('');
        const next = [...messages, { role: 'user', content: text }];
        setMessages(next);
        const requestId = `studio-conversation-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        activeRequest.current = requestId;
        const statusPromise = pollStatus(requestId);
        // Include edits made in the review pane in the next model request,
        // while keeping earlier visible messages as immutable snapshots.
        const history = next.map(item => ({ role: item.role, content: item.content }));
        const previousIndex = history.findLastIndex(item => item.role === 'assistant');
        if (proposal && previousIndex >= 0) history[previousIndex].content = JSON.stringify({
          ...proposal, name: draft.name, slug: draft.slug, description: draft.description,
          spec: { ...proposal.spec, description: draft.description, instructions: { ...proposal.spec?.instructions, system: draft.prompt, task: draft.task } },
        });
        try {
          const result = await hostRemote.composeAuthoringConversation({
            messages: history,
            modelProfileId: authoringModel,
            runtimeType: runtime,
            agentModelProfileIds: agentModels,
            agentDefaultModelProfileId: agentModels[0] || null,
            toolResourceIds: [],
            mcpResourceIds: mcp,
            skillResourceIds: skills,
            requestId,
          });
          if (activeRequest.current !== requestId) return;
          const nextProposal = result?.proposal;
          if (!nextProposal) throw new Error('Host 没有返回可审查的 Agent 草稿');
          const spec = nextProposal.spec || {};
          setProposal(nextProposal);
          setDraft({
            name: String(nextProposal.name || '待确认 Agent'),
            slug: conversationalSlug(nextProposal.slug || nextProposal.name),
            description: String(spec.description || nextProposal.description || ''),
            prompt: String(spec.instructions?.system || nextProposal.instructions?.system || ''),
            task: String(spec.instructions?.task || ''),
          });
          // Keep the full structured proposal in the assistant turn. The
          // server parses this turn on the next request so a follow-up can
          // refine the existing Agent instead of starting from scratch.
          setMessages([...next, { role: 'assistant', content: JSON.stringify(nextProposal) }]);
          setStage('done');
          if (result?.fallback?.active) setNotice('生成模型暂时不可用，Host 已生成可编辑的本地兜底草稿；确认前请检查内容。');
        } catch (reason) {
          if (activeRequest.current === requestId) { setStage('failed'); setError(reason?.message || '对话构建失败'); }
        } finally {
          if (activeRequest.current === requestId) { activeRequest.current = null; setBusy(false); }
          void statusPromise;
        }
      };

      const create = async event => {
        event?.preventDefault?.();
        if (!proposal || busy) return;
        if (!draft.name.trim() || !draft.slug.trim() || !draft.prompt.trim()) { setError('请补全名称、Agent ID 和系统 Prompt。'); return; }
        if (!agentModels.length) { setError('请至少为 Agent 选择一个模型。'); setSettingsOpen(true); return; }
        setBusy(true); setError(''); setNotice(''); setStage('creating');
        try {
          const proposalSpec = proposal.spec || {};
          const spec = {
            ...proposalSpec,
            description: draft.description.trim() || proposalSpec.description || proposal.description || '',
            runtime: null,
            model: null,
            instructions: { ...(proposalSpec.instructions || {}), system: draft.prompt.trim(), task: draft.task.trim() },
            bindings: {
              ...(proposalSpec.bindings || {}),
              modelProfileId: agentModels[0] || authoringModel,
              modelProfileIds: agentModels.length ? agentModels : [authoringModel],
              policyTemplate: proposalSpec.bindings?.policyTemplate || 'strict',
              tools: runtime === 'dsh-native' || runtime === 'codex' ? [] : (proposalSpec.bindings?.tools || []),
              mcpServers: mcp.map(resourceId => ({ resourceId })),
              skills: skills.map(resourceId => ({ resourceId })),
              plugins: platformBindings,
            },
            memory: { ...(proposalSpec.memory || {}), enabled: memoryEnabled, recall: { ...(proposalSpec.memory?.recall || {}), enabled: memoryEnabled } },
          };
          const created = await hostRemote.quickAuthorAgent({ name: draft.name.trim(), slug: draft.slug.trim(), runtimeType: runtime, template: 'blank', description: spec.description, spec });
          const metadata = created?.metadata || {};
          onCreated({ id: metadata.id || draft.slug.trim(), name: metadata.name || draft.name.trim(), revision: metadata.revision || 1 });
        } catch (reason) { setStage('failed'); setError(reason?.message || '创建 Agent 失败'); }
        finally { setBusy(false); }
      };

      const picker = (kind, values, setter, label) => h('div', null,
        h('div', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700, marginBottom: '6px' } }, `${label}（${values.length}）`),
        catalog[kind].length ? h('div', { style: { display: 'grid', gap: '5px', maxHeight: '150px', overflow: 'auto' } }, catalog[kind].map(item => {
          const id = item.resourceId; const checked = values.includes(id);
          return h('label', { key: id, style: { display: 'flex', alignItems: 'center', gap: '7px', padding: '6px 8px', border: '1px solid ' + (checked ? BRAND.accentStrong : BRAND.border), borderRadius: '7px', background: checked ? BRAND.accentSoft : BRAND.surface, color: BRAND.ink, fontSize: '11px' } }, h('input', { type: 'checkbox', checked, onChange: () => toggle(setter, id) }), item.displayName || item.name || id);
        })) : h('div', { style: { color: BRAND.inkMuted, fontSize: '11px' } }, '暂无资源'));

      const draftPanel = h('section', { style: { border: '1px solid ' + BRAND.border, borderRadius: '14px', padding: '14px', background: BRAND.surface } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' } },
          h('strong', { style: { color: BRAND.ink, fontSize: '14px' } }, '草稿'),
          h(Pill, { tone: proposal ? 'accent' : 'signal' }, proposal ? '可检查' : '待生成')),
        proposal ? h('form', { onSubmit: create, style: { display: 'grid', gap: '9px' } },
          h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '名称', h('input', { value: draft.name, onChange: event => setDraft(current => ({ ...current, name: event.target.value })), style: inputStyle() })),
          h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, 'Agent ID', h('input', { value: draft.slug, onChange: event => setDraft(current => ({ ...current, slug: event.target.value })), style: inputStyle() })),
          h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '系统 Prompt', h('textarea', { value: draft.prompt, onChange: event => setDraft(current => ({ ...current, prompt: event.target.value })), rows: 6, style: { ...inputStyle(), height: 'auto', padding: '10px', resize: 'vertical' } })),
          h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '任务要求', h('textarea', { value: draft.task, onChange: event => setDraft(current => ({ ...current, task: event.target.value })), rows: 5, style: { ...inputStyle(), height: 'auto', padding: '10px', resize: 'vertical' } })),
          h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '用途描述', h('textarea', { value: draft.description, onChange: event => setDraft(current => ({ ...current, description: event.target.value })), rows: 3, style: { ...inputStyle(), height: 'auto', padding: '10px', resize: 'vertical' } })),
          h('button', { type: 'submit', disabled: busy, style: { ...buttonStyle(), color: busy ? BRAND.inkMuted : 'var(--dsw-static-neutral-00, #fff)', background: busy ? BRAND.accentSoft : BRAND.primaryFill, borderColor: busy ? BRAND.border : 'transparent' } }, busy ? '创建中…' : '确认创建 Agent'))
          : h('div', { style: { color: BRAND.inkMuted, fontSize: '11px', lineHeight: 1.55 } }, '先在左侧描述需求。每一轮都会保留上下文，草稿生成后可在这里检查并确认。'));
      const settingsPanel = h('section', { style: { border: '1px solid ' + BRAND.border, borderRadius: '14px', padding: '14px', background: BRAND.surface } },
        h('button', { type: 'button', onClick: () => setSettingsOpen(value => !value), style: { display: 'flex', justifyContent: 'space-between', width: '100%', border: 0, padding: 0, color: BRAND.ink, background: 'transparent', fontWeight: 800, fontSize: '13px', cursor: 'pointer' } }, h('span', null, '创建配置'), h('span', null, settingsOpen ? '收起' : '展开')),
        settingsOpen ? h('div', { style: { display: 'grid', gap: '10px', marginTop: '12px' } },
          h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '运行时', h('select', { value: runtime, disabled: busy, onChange: event => setRuntime(event.target.value), style: inputStyle() }, ALLOWED_RUNTIME_TYPES.map(value => h('option', { key: value, value }, RUNTIME_LABELS[value] || value)))),
          h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '生成模型', h('select', { value: authoringModel, onChange: event => setAuthoringModel(event.target.value), style: inputStyle() }, catalog.model.map(item => h('option', { key: item.resourceId, value: item.resourceId }, item.displayName || item.resourceId)))),
          picker('model', agentModels, setAgentModels, 'Agent 可用模型'),
          picker('mcp', mcp, setMcp, 'MCP Server'),
          picker('skill', skills, setSkills, 'Skill'),
          h(PlatformResourcePicker, { value: platformBindings, onChange: setPlatformBindings, onMemory: setMemoryEnabled }),
          h('div', { style: { color: BRAND.inkMuted, fontSize: '11px', lineHeight: 1.55 } }, '模型、MCP、Skill 可多选；知识库、记忆库各绑定一个。确认创建会保存绑定，能否执行还需通过运行时构建校验。', runtime === 'dsh-native' ? ' DSH Native 使用自身工具循环，不绑定 KsADK 原生 Tool。' : '')) : null);
      return h('div', null,
        h(SectionHeading, { title: '对话创建 Agent', detail: '描述需求、补充细节，检查草稿后确认创建。', action: h('button', { type: 'button', disabled: busy, onClick: onBack, style: buttonStyle() }, '返回 Agents') }),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 370px), 1fr))', gap: '16px', alignItems: 'start' } },
          h('section', { style: { border: '1px solid ' + BRAND.border, borderRadius: '14px', padding: '16px', background: BRAND.surface } },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' } }, h('strong', { style: { color: BRAND.ink, fontSize: '14px' } }, '需求对话'), h(Pill, { tone: messages.length ? 'accent' : 'neutral' }, messages.length ? `${Math.ceil(messages.length / 2)} 轮上下文` : '持续保留上下文')),
            h('div', { style: { display: 'grid', gap: '8px', minHeight: '230px', maxHeight: '430px', overflow: 'auto' } }, messages.length ? messages.map((item, index) => h('div', { key: index, style: { alignSelf: item.role === 'user' ? 'end' : 'start', maxWidth: '88%', padding: '10px 12px', borderRadius: '10px', color: BRAND.ink, background: item.role === 'user' ? BRAND.accentSoft : BRAND.canvas, fontSize: '12px', lineHeight: 1.5, whiteSpace: 'pre-wrap' } }, authoringMessageText(item))) : h('div', { style: { display: 'grid', placeItems: 'center', minHeight: '220px', color: BRAND.inkMuted, fontSize: '12px', textAlign: 'center' } }, h('div', null, h('strong', { style: { display: 'block', color: BRAND.ink, fontSize: '14px' } }, '从一句需求开始'), h('p', { style: { margin: '7px 0 0' } }, '例如：帮我做一个销售日报 Agent，能汇总群聊记录并标出待跟进事项。')))),
            busy ? h('div', { role: 'status', style: { color: BRAND.accentStrong, fontSize: '11px', margin: '8px 0' } }, stage === 'creating' ? '正在写入 Agent Revision…' : `正在${stage === 'generating' ? '生成草稿' : stage === 'validating' ? '校验绑定' : '理解你的需求'}…`) : null,
            error ? h('div', { role: 'alert', style: { color: BRAND.danger, fontSize: '11px', margin: '8px 0' } }, error) : null,
            notice ? h('div', { role: 'status', style: { color: BRAND.signal, fontSize: '11px', margin: '8px 0' } }, notice) : null,
            h('form', { onSubmit: send, style: { marginTop: '10px' } }, h('textarea', { value: input, onChange: event => setInput(event.target.value), onKeyDown: event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(event); } }, rows: 3, placeholder: '描述或调整你的 Agent…（Enter 发送，Shift + Enter 换行）', style: { ...inputStyle(), height: 'auto', padding: '10px', resize: 'vertical' } }), h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: '8px' } }, h('button', { type: 'submit', disabled: busy || !input.trim(), style: { ...buttonStyle(), color: busy || !input.trim() ? BRAND.inkMuted : 'var(--dsw-static-neutral-00, #fff)', background: busy || !input.trim() ? BRAND.accentSoft : BRAND.primaryFill, borderColor: busy || !input.trim() ? BRAND.border : 'transparent' } }, busy ? '处理中…' : '发送并更新草稿')))),
          h('aside', { style: { display: 'grid', gap: '12px' } }, draftPanel, settingsPanel))
      );
    }

    function AgentEditPage({ agentId, onBack, onSaved }) {
      const [agent, setAgent] = useState(null);
      const [error, setError] = useState('');
      useEffect(() => {
        let alive = true;
        hostRemote.agent(agentId).then(value => { if (alive) setAgent(value?.draft || value); })
          .catch(reason => { if (alive) setError(reason?.message || '读取 Agent 失败'); });
        return () => { alive = false; };
      }, [agentId]);
      if (!agent) return h(EmptyState, { title: error || '正在读取 Agent', detail: '读取当前版本和已有绑定。', action: h('button', { onClick: onBack, style: buttonStyle() }, '返回 Agents') });
      return h(AgentCreatePage, { initialAgent: agent, onBack, onCreated: onSaved });
    }

    function AgentCreatePage({ mode = 'quick', initialAgent = null, onBack, onCreated }) {
      const editing = Boolean(initialAgent);
      const originalSpec = initialAgent?.spec || {};
      const originalBindings = originalSpec.bindings || {};
      const idsOf = items => (items || []).map(item => typeof item === 'string' ? item : item.resourceId).filter(Boolean);
      const [step, setStep] = useState(0);
      const [saving, setSaving] = useState(false);
      const [error, setError] = useState('');
      const [catalogStatus, setCatalogStatus] = useState('loading');
      const [catalog, setCatalog] = useState({ model: [], tool: [], mcp: [], skill: [] });
      const [selectedModel, setSelectedModel] = useState(originalBindings.modelProfileId || '');
      const [selectedModels, setSelectedModels] = useState(originalBindings.modelProfileIds || (originalBindings.modelProfileId ? [originalBindings.modelProfileId] : []));
      const [selectedTools, setSelectedTools] = useState(idsOf(originalBindings.tools));
      const [selectedMcp, setSelectedMcp] = useState(idsOf(originalBindings.mcpServers));
      const [selectedSkills, setSelectedSkills] = useState(idsOf(originalBindings.skills));
      const [platformBindings, setPlatformBindings] = useState(originalBindings.plugins || []);
      const [memoryEnabled, setMemoryEnabled] = useState(Boolean(originalSpec.memory?.enabled));
      const [policy, setPolicy] = useState(originalBindings.policyTemplate || 'strict');
      const [form, setForm] = useState({
        id: initialAgent?.metadata?.id || 'local-agent', name: initialAgent?.metadata?.name || '我的第一个 Agent', runtime: originalSpec.runtime?.type || 'dsh-native',
        description: originalSpec.description || '', prompt: originalSpec.instructions?.system || '', template: 'blank',
      });
      const runtimeOptions = ALLOWED_RUNTIME_TYPES.map(runtimeType => ({ runtimeType, displayName: RUNTIME_LABELS[runtimeType] }));
      const templates = [['blank', '通用助手', '干净的 DSH Native Agent，创建后按需绑定能力。'], ['research', '研究助手', '适合资料检索、分析和带来源输出。']];
      const steps = mode === 'one-click'
        ? [['选择模板', '确定一键创建的起点'], ['绑定能力', '模型、Tool、MCP、Skill'], ['运行策略', '执行目标与权限'], ['检查并创建', '确认后写入 Host']]
        : [['定义 Agent', '身份、Prompt 与用途'], ['绑定能力', '模型、Tool、MCP、Skill'], ['运行策略', '执行目标与权限'], ['检查并创建', '确认后写入 Host']];
      const update = (key, value) => setForm(previous => ({ ...previous, [key]: value }));

      useEffect(() => {
        if (form.runtime === 'dsh-native' && !editing) setSelectedTools([]);
      }, [form.runtime]);

      useEffect(() => {
        let alive = true;
        setCatalogStatus('loading');
        Promise.allSettled(['model', 'tool', 'mcp', 'skill'].map(kind => hostRemote.resources(kind)))
          .then(results => {
            if (!alive) return;
            const next = {};
            ['model', 'tool', 'mcp', 'skill'].forEach((kind, index) => {
              next[kind] = results[index]?.status === 'fulfilled' && Array.isArray(results[index].value?.items)
                ? results[index].value.items : [];
            });
            setCatalog(next);
            if (!editing) {
              setSelectedModel(current => current || next.model?.[0]?.resourceId || '');
              setSelectedModels(current => current.length ? current : (next.model?.[0]?.resourceId ? [next.model[0].resourceId] : []));
            }
            if (next.model.length) setCatalogStatus('ready');
            else {
              setCatalogStatus('error');
              const failed = results.find(result => result.status === 'rejected');
              setError(failed?.reason?.message || '模型资源目录读取失败');
            }
          });
        return () => { alive = false; };
      }, []);

      const canNext = step === 0
        ? Boolean(form.id.trim() && form.name.trim())
        : step === 1 ? Boolean(selectedModel) : true;

      const create = async () => {
        if (saving || !form.id.trim() || !form.name.trim() || !selectedModel) return;
        setSaving(true); setError('');
        const id = form.id.trim().toLowerCase();
        try {
          const prompt = form.prompt.trim() || form.description.trim() || '你是一个可靠的通用助手，请直接回答用户问题；信息不足时先提出澄清问题。';
          // The managed Harness executes through the local host process. Its
          // runtime admission contract requires this capability explicitly;
          // without it the build can succeed but conversation-surface must
          // fail closed with PLUGIN_PERMISSION_DENIED. MCP adds its own
          // network lease. DSH Native and Codex keep the deny-by-default
          // permission set because their native loops do not need the
          // KsADK host-user capability.
          const allowedPermissions = form.runtime === 'harness'
            ? ['process:host-user', ...(selectedMcp.length ? ['network:mcp'] : [])]
            : [];
          const spec = {
            ...originalSpec,
            description: form.description.trim() || '由 AgentKit Studio 本地创建',
            runtime: { ...originalSpec.runtime, type: form.runtime },
            instructions: { ...originalSpec.instructions, system: prompt, task: originalSpec.instructions?.task || '' },
            security: editing ? originalSpec.security : { toolPolicy: 'deny-by-default', allowedPermissions },
            bindings: {
              ...originalBindings,
              modelProfileId: selectedModel,
              modelProfileIds: selectedModels.length ? selectedModels : [selectedModel],
              policyTemplate: policy,
              tools: selectedTools.map(resourceId => (originalBindings.tools || []).find(item => item.resourceId === resourceId) || { resourceId }),
              mcpServers: selectedMcp.map(resourceId => (originalBindings.mcpServers || []).find(item => item.resourceId === resourceId) || { resourceId }),
              skills: selectedSkills.map(resourceId => (originalBindings.skills || []).find(item => item.resourceId === resourceId) || { resourceId }),
              plugins: platformBindings,
            },
            memory: { ...originalSpec.memory, providerRef: platformBindings.some(item => item?.config?.binding?.resource?.kind === 'memory-instance') ? 'binding://platform-memory-instance' : originalSpec.memory?.providerRef === 'binding://platform-memory-instance' ? 'local-default' : originalSpec.memory?.providerRef || 'local-default', enabled: memoryEnabled, recall: { ...originalSpec.memory?.recall, enabled: memoryEnabled } },
          };
          const created = editing ? await hostRemote.updateAgent(id, spec, initialAgent.metadata.revision, form.name.trim()) : await hostRemote.quickAuthorAgent({
            name: form.name.trim(), slug: id, runtimeType: form.runtime,
            template: mode === 'one-click' ? form.template : 'blank',
            description: form.description.trim() || '由 AgentKit Studio 本地创建', spec,
          });
          const metadata = created?.metadata || {};
          onCreated({ id: metadata.id || id, name: metadata.name || form.name.trim(), revision: metadata.revision || 1 });
        } catch (reason) { setError(reason?.message || '创建 Agent 失败'); }
        finally { setSaving(false); }
      };

      const templateCards = mode === 'one-click' ? h('div', { style: { marginBottom: '20px' } },
        h('div', { style: { color: BRAND.ink, fontSize: '13px', fontWeight: 800, marginBottom: '10px' } }, '选择一键模板'),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '10px' } }, templates.map(([value, title, detail]) => h('button', {
          key: value, type: 'button', onClick: () => update('template', value),
          style: { minHeight: '88px', textAlign: 'left', border: '1px solid ' + (form.template === value ? BRAND.accentStrong : BRAND.border), borderRadius: '10px', padding: '13px', background: form.template === value ? BRAND.accentSoft : BRAND.surface, color: BRAND.ink, cursor: 'pointer' },
        }, h('div', { style: { fontWeight: 800, fontSize: '13px' } }, title), h('div', { style: { marginTop: '5px', color: BRAND.inkMuted, fontSize: '11px', lineHeight: 1.5 } }, detail))))) : null;

      const capabilityPicker = (kind, title, values, setValues) => h('section', {
        style: { border: '1px solid ' + BRAND.border, borderRadius: '12px', padding: '14px', background: BRAND.surface },
      }, h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '9px' } },
        h('strong', { style: { color: BRAND.ink, fontSize: '13px' } }, title),
        h('span', { style: { color: BRAND.inkMuted, fontSize: '11px' } }, `${values.length} 已选择`)),
      catalog[kind]?.length ? h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '7px' } }, catalog[kind].map(resource => {
        const id = resource.resourceId;
        const checked = values.includes(id);
        return h('label', { key: id, style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '9px 10px', border: '1px solid ' + (checked ? BRAND.accentStrong : BRAND.border), borderRadius: '8px', background: checked ? BRAND.accentSoft : BRAND.surface, color: BRAND.ink, cursor: 'pointer' } },
          h('input', { type: 'checkbox', checked, onChange: event => setValues(current => event.target.checked ? [...current, id] : current.filter(value => value !== id)) }),
          h('span', null, h('strong', { style: { display: 'block', fontSize: '12px' } }, resource.displayName || resource.name || id), h('span', { style: { display: 'block', marginTop: '2px', color: BRAND.inkMuted, fontSize: '10px' } }, resource.description || resource.version || id)));
      })) : h('div', { style: { color: BRAND.inkMuted, fontSize: '11px', padding: '6px 0' } }, catalogStatus === 'loading' ? '正在读取目录…' : '暂无可用资源'));

      const stepContent = step === 0 ? h(React.Fragment, null,
        templateCards,
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1.3fr', gap: '14px' } },
          h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, 'Agent ID', h('input', { value: form.id, disabled: editing, onChange: e => update('id', e.target.value), placeholder: 'local-agent', style: inputStyle() })),
          h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '名称', h('input', { value: form.name, onChange: e => update('name', e.target.value), placeholder: '我的 Agent', style: inputStyle() })),
          h('label', { style: { gridColumn: '1 / -1', color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '用途描述', h('textarea', { value: form.description, onChange: e => update('description', e.target.value), placeholder: '例如：企业知识库问答与资料检索', rows: 4, style: { ...inputStyle(), height: 'auto', padding: '10px', resize: 'vertical' } })),
          h('label', { style: { gridColumn: '1 / -1', color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '运行时', h('select', { value: form.runtime, disabled: editing, onChange: e => update('runtime', e.target.value), style: inputStyle() }, runtimeOptions.map(item => h('option', { key: item.runtimeType, value: item.runtimeType }, item.displayName)))),
        ),
        h('label', { style: { display: 'block', marginTop: '14px', color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '角色与系统 Prompt', h('textarea', { value: form.prompt, onChange: e => update('prompt', e.target.value), placeholder: '描述 Agent 的身份、边界和回答方式', rows: 5, style: { ...inputStyle(), height: 'auto', padding: '10px', resize: 'vertical' } })),
      ) : step === 1 ? h(React.Fragment, null,
        h('div', { style: { marginBottom: '14px', color: BRAND.inkMuted, fontSize: '12px', lineHeight: 1.55 } }, '模型、MCP、Skill 支持多选；知识库和记忆库各选一个。保存后形成新的 Agent 配置版本。'),
        h('section', { style: { border: '1px solid ' + BRAND.border, borderRadius: '12px', padding: '14px', background: BRAND.surface, marginBottom: '10px' } },
          h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '默认模型', h('select', { value: selectedModel, onChange: event => { setSelectedModel(event.target.value); setSelectedModels(current => current.includes(event.target.value) ? current : [event.target.value, ...current]); }, style: inputStyle() }, h('option', { value: '' }, catalogStatus === 'loading' ? '正在读取模型…' : '请选择模型'), catalog.model.map(resource => h('option', { key: resource.resourceId, value: resource.resourceId }, `${resource.displayName || resource.name} · ${resource.resourceId}`)))),
          h('div', { style: { marginTop: '12px', color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '可用模型（可多选）'),
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '7px', marginTop: '7px' } }, catalog.model.map(resource => {
            const checked = selectedModels.includes(resource.resourceId);
            return h('label', { key: resource.resourceId, style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 9px', border: '1px solid ' + (checked ? BRAND.accentStrong : BRAND.border), borderRadius: '8px', background: checked ? BRAND.accentSoft : BRAND.surface, color: BRAND.ink, cursor: 'pointer' } }, h('input', { type: 'checkbox', checked, onChange: event => setSelectedModels(current => event.target.checked ? [...current, resource.resourceId] : current.filter(id => id !== resource.resourceId)) }), h('span', null, resource.displayName || resource.name || resource.resourceId));
          }))),
        form.runtime === 'dsh-native'
          ? h('div', { style: { marginBottom: '10px', padding: '11px 12px', borderRadius: '9px', background: BRAND.canvas, color: BRAND.inkMuted, fontSize: '11px', lineHeight: 1.5 } }, 'DSH Native 使用 DSH 自身的工具循环；本次创建不会绑定 KsADK 原生 Tool。MCP、Skill 和平台资源仍可按需绑定。')
          : capabilityPicker('tool', 'Tools', selectedTools, setSelectedTools),
        capabilityPicker('mcp', 'MCP Servers', selectedMcp, setSelectedMcp),
        capabilityPicker('skill', 'Skills', selectedSkills, setSelectedSkills),
        h(PlatformResourcePicker, { value: platformBindings, onChange: setPlatformBindings, onMemory: value => setMemoryEnabled(value) }),
      ) : step === 2 ? h(React.Fragment, null,
        h('h3', { style: { margin: '0 0 6px', color: BRAND.ink, fontSize: '16px' } }, '运行目标与策略'),
        h('p', { style: { margin: '0 0 16px', color: BRAND.inkMuted, fontSize: '12px', lineHeight: 1.55 } }, '运行目标会写入 Agent Revision。DSH Native 是本地原生循环，KsADK Harness 和 Codex 由各自 Host 执行。'),
        h('div', { style: { display: 'grid', gap: '8px' } }, runtimeOptions.map(item => h('button', { key: item.runtimeType, type: 'button', onClick: () => update('runtime', item.runtimeType), style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', textAlign: 'left', border: '1px solid ' + (form.runtime === item.runtimeType ? BRAND.accentStrong : BRAND.border), borderRadius: '10px', padding: '14px', background: form.runtime === item.runtimeType ? BRAND.accentSoft : BRAND.surface, color: BRAND.ink, cursor: 'pointer' } }, h('span', null, h('strong', { style: { display: 'block', fontSize: '13px' } }, item.displayName), h('span', { style: { display: 'block', marginTop: '4px', color: BRAND.inkMuted, fontSize: '11px' } }, item.runtimeType)), form.runtime === item.runtimeType ? h(Pill, { tone: 'accent' }, '已选择') : null))),
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginTop: '16px' } },
          h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '权限策略', h('select', { value: policy, onChange: event => setPolicy(event.target.value), style: inputStyle() }, h('option', { value: 'strict' }, '严格权限'), h('option', { value: 'loose' }, '宽松权限'), h('option', { value: 'custom' }, '自定义权限'))),
          h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '23px', color: BRAND.ink, fontSize: '12px', fontWeight: 700 } }, h('input', { type: 'checkbox', checked: memoryEnabled, onChange: event => setMemoryEnabled(event.target.checked) }), '启用跨会话记忆')),
        h('div', { style: { marginTop: '18px', padding: '12px', borderRadius: '9px', background: BRAND.canvas, color: BRAND.inkMuted, fontSize: '12px', lineHeight: 1.6 } }, '运行目标属于 Agent Revision；权限策略和记忆开关会随本次创建一起保存。'),
      ) : h(React.Fragment, null,
        h('h3', { style: { margin: '0 0 14px', color: BRAND.ink, fontSize: '16px' } }, '检查并创建'),
        h('div', { style: { display: 'grid', borderTop: '1px solid ' + BRAND.border } }, [['Agent ID', form.id.trim().toLowerCase()], ['名称', form.name.trim()], ['运行目标', RUNTIME_LABELS[form.runtime] || form.runtime], ['默认模型', catalog.model.find(item => item.resourceId === selectedModel)?.displayName || selectedModel || '未选择'], ['模型白名单', `${selectedModels.length || (selectedModel ? 1 : 0)} 个`], ['能力', `${selectedTools.length} Tool · ${selectedMcp.length} MCP · ${selectedSkills.length} Skill`], ['平台资源', `${platformBindings.length} 项（知识库 / 记忆库 / Skill Center）`], ['记忆', memoryEnabled ? '已启用' : '未启用'], ['模板', mode === 'one-click' ? templates.find(item => item[0] === form.template)?.[1] : '通用助手']].map(([label, value]) => h('div', { key: label, style: { display: 'flex', justifyContent: 'space-between', gap: '20px', padding: '12px 0', borderBottom: '1px solid ' + BRAND.border, fontSize: '12px' } }, h('span', { style: { color: BRAND.inkMuted } }, label), h('strong', { style: { color: BRAND.ink, textAlign: 'right' } }, value)))),
        h('div', { style: { marginTop: '16px', padding: '12px', borderRadius: '9px', background: BRAND.canvas, color: BRAND.inkMuted, fontSize: '12px', lineHeight: 1.6 } }, editing ? `保存后创建新的配置版本；当前版本为 r${initialAgent.metadata.revision}。已有会话和构建不会被自动切换。` : '创建后保存 Prompt、模型和资源绑定，随后可构建并开始对话。'),
      );
      return h('div', null,
        h(SectionHeading, { eyebrow: 'Studio domain / Agents', title: editing ? '编辑 Agent' : mode === 'one-click' ? '一键创建 Agent' : '快速创建 Agent', detail: '沿用旧版 Studio 的创建工作台；基础信息、Prompt、资源绑定和运行策略在同一条创建流程中完成。', action: h('button', { type: 'button', onClick: onBack, style: buttonStyle() }, '返回 Agents') }),
        !editing && h('div', { style: { display: 'flex', gap: '4px', padding: '4px', marginBottom: '16px', border: '1px solid ' + BRAND.border, borderRadius: '10px', background: BRAND.surface, width: 'fit-content' } }, ['quick', 'one-click'].map(value => h('button', { key: value, type: 'button', onClick: () => { if (value !== mode) onBack(); }, style: { minHeight: '32px', border: 0, borderRadius: '7px', padding: '0 12px', color: value === mode ? BRAND.ink : BRAND.inkMuted, background: value === mode ? BRAND.accentSoft : 'transparent', fontSize: '12px', fontWeight: value === mode ? 800 : 650 } }, value === 'quick' ? '快速创建' : '一键创建'))),
        h('section', { style: { display: 'grid', gridTemplateColumns: '210px minmax(0, 1fr)', gap: '20px', alignItems: 'start' } },
          h('aside', { style: { border: '1px solid ' + BRAND.border, borderRadius: '14px', padding: '12px', background: BRAND.surface } },
            h('div', { style: { color: BRAND.inkMuted, fontSize: '10px', fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', padding: '8px 10px 12px' } }, '创建流程'),
            h('div', null, steps.map(([label, detail], index) => h('button', { key: label, type: 'button', onClick: () => (editing || index <= step) && setStep(index), style: { display: 'block', width: '100%', border: 0, borderLeft: '2px solid ' + (index === step ? BRAND.accentStrong : BRAND.border), borderRadius: '0 8px 8px 0', padding: '10px 10px 10px 12px', textAlign: 'left', color: index === step ? BRAND.ink : BRAND.inkMuted, background: index === step ? BRAND.accentSoft : 'transparent', cursor: editing || index <= step ? 'pointer' : 'default' } }, h('div', { style: { fontSize: '12px', fontWeight: 800 } }, `${index + 1}. ${label}`), h('div', { style: { marginTop: '3px', fontSize: '10px', lineHeight: 1.45 } }, detail)))),
            h('div', { style: { margin: '14px 10px 6px', paddingTop: '12px', borderTop: '1px solid ' + BRAND.border, color: BRAND.inkMuted, fontSize: '11px', lineHeight: 1.55 } }, '模型、MCP、Skill、知识库、记忆库、Prompt 和记忆策略可在本次创建直接绑定；创建后仍可在 Agent 详情中继续编辑。')),
          h('div', { style: { border: '1px solid ' + BRAND.border, borderRadius: '14px', padding: '22px', background: BRAND.surface, minWidth: 0 } },
            stepContent,
            error ? h('div', { role: 'alert', style: { marginTop: '16px', color: BRAND.danger, fontSize: '12px' } }, error) : null,
            h('div', { style: { display: 'flex', justifyContent: 'space-between', marginTop: '24px' } },
              h('button', { type: 'button', onClick: step === 0 ? onBack : () => setStep(step - 1), style: buttonStyle() }, step === 0 ? '取消' : '上一步'),
              step < 3 ? h('button', { type: 'button', disabled: !canNext, onClick: () => setStep(step + 1), style: { ...buttonStyle(), color: canNext ? 'var(--dsw-static-neutral-00, #fff)' : BRAND.inkMuted, background: canNext ? BRAND.primaryFill : BRAND.accentSoft, borderColor: canNext ? 'transparent' : BRAND.border } }, '下一步') : h('button', { type: 'button', disabled: saving || !canNext, onClick: create, style: { ...buttonStyle(), color: saving || !canNext ? BRAND.inkMuted : 'var(--dsw-static-neutral-00, #fff)', background: saving || !canNext ? BRAND.accentSoft : BRAND.primaryFill, borderColor: saving || !canNext ? BRAND.border : 'transparent' } }, saving ? '保存中…' : editing ? '保存 Agent' : mode === 'one-click' ? '一键创建并开始使用' : '快速创建并开始使用'))
          )
        )
      );
    }

    function inputStyle() {
      return { display: 'block', boxSizing: 'border-box', width: '100%', height: '36px', marginTop: '6px', padding: '0 10px', border: '1px solid ' + BRAND.border, borderRadius: '8px', color: BRAND.ink, background: 'var(--dsw-alias-bg-layer-1, #fbfdff)', fontSize: '12px' };
    }

    function buttonStyle() {
      return { border: '1px solid ' + BRAND.border, borderRadius: '9px', padding: '8px 12px', color: BRAND.ink, background: BRAND.surface, fontSize: '12px', fontWeight: 700, cursor: 'pointer' };
    }

    function DomainPage({ page }) {
      const content = {
        agents: ['Agent', '创建、配置和版本化可运行的 Agent。', '✦', 'Agent Catalog 与 Revision 接通后，这里会成为 Agent 的工作台。'],
        runtime: ['运行时', '选择执行目标，查看能力和运行状态。', '⌁', '当前 Agent 运行目标为 DSH Native、KsADK Harness 和 Codex；不绑定 Agent 时使用 DSH 原生会话。资源绑定会在 Host 能力未就绪时明确阻止构建。ADK / LangGraph 不进入新版 Studio 的产品选择器。'],
        resources: ['资源', '管理模型、工具、MCP 与 Skill 的目录生命周期。', '◈', '资源目录只负责发现、导入、探测、查看、刷新和删除；Agent 绑定在创建或编辑页完成。'],
        delivery: ['构建与部署', '从 Revision 到 Build、Deploy 和回滚。', '↗', '云端 API gap 完成核对后，这里接入真实异步 operation 和部署状态。'],
      }[page];
      return h('section', { style: { border: '1px solid ' + BRAND.border, borderRadius: '16px', padding: '22px', background: BRAND.surface } },
        h(SectionHeading, { eyebrow: 'Studio domain', title: content[0], detail: content[1], action: h(Pill, { tone: 'signal' }, 'Host 待接入') }),
        h(EmptyState, { icon: content[2], title: content[0] + '正在准备', detail: content[3], action: h(DisabledAction, null, '等待 Host 能力') }));
    }

    function ResourceDialog({ title, detail, children, onClose }) {
      return h('div', {
        role: 'presentation',
        onMouseDown: event => { if (event.target === event.currentTarget) onClose(); },
        style: { position: 'fixed', inset: 0, zIndex: 50, display: 'grid', placeItems: 'center', padding: '24px', background: 'rgba(7, 14, 24, 0.46)' },
      }, h('section', {
        role: 'dialog', 'aria-modal': 'true', 'aria-label': title,
        style: { width: 'min(680px, 100%)', maxHeight: 'min(760px, calc(100vh - 48px))', overflow: 'auto', border: '1px solid ' + BRAND.border, borderRadius: '16px', padding: '20px', background: BRAND.surface, boxShadow: '0 22px 70px rgba(7, 14, 24, 0.28)' },
      }, h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'flex-start', marginBottom: '16px' } },
        h('div', null, h('h2', { style: { margin: 0, color: BRAND.ink, fontSize: '18px' } }, title), detail ? h('p', { style: { margin: '6px 0 0', color: BRAND.inkMuted, fontSize: '12px', lineHeight: 1.5 } }, detail) : null),
        h('button', { type: 'button', 'aria-label': '关闭', onClick: onClose, style: { ...buttonStyle(), padding: '5px 9px', fontSize: '14px' } }, '×')),
        children));
    }

    function McpResourceDialog({ onClose, onCreated }) {
      const [form, setForm] = useState({ displayName: '', name: '', description: '', version: '1.0.0', transport: 'http', endpointUrl: '', command: '', args: '', apiKeyName: '', apiKeyValue: '', envRefs: '' });
      const [saving, setSaving] = useState(false);
      const [error, setError] = useState('');
      const setField = (key, value) => setForm(current => ({ ...current, [key]: value }));
      const save = async event => {
        event.preventDefault();
        if (saving) return;
        setError('');
        const name = form.name.trim() || form.displayName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        if (!name || !form.displayName.trim()) { setError('请填写 MCP 名称和显示名称。'); return; }
        if ((form.transport === 'http' || form.transport === 'sse') && !form.endpointUrl.trim()) { setError('HTTP/SSE MCP 需要填写服务地址。'); return; }
        if (form.transport === 'stdio' && !form.command.trim()) { setError('stdio MCP 需要填写启动命令。'); return; }
        const envRefs = {};
        form.envRefs.split(',').map(item => item.trim()).filter(Boolean).forEach(item => { const [key, ref] = item.split('=').map(part => part.trim()); if (key && ref) envRefs[key] = ref; });
        const credentialName = form.apiKeyName.trim();
        if (credentialName && form.apiKeyValue.trim()) {
          try { await hostRemote.putCredential(credentialName, form.apiKeyValue.trim()); }
          catch (reason) { setError(reason?.message || 'MCP 凭证保存失败'); return; }
          envRefs[form.transport === 'stdio' ? credentialName : 'Authorization'] = `env://${credentialName}`;
        }
        setSaving(true);
        try {
          const created = await hostRemote.createMcpResource({
            displayName: form.displayName.trim(), description: form.description.trim(),
            server: { name, version: form.version.trim() || '1.0.0', transport: form.transport, endpointUrl: form.endpointUrl.trim() || undefined, command: form.command.trim() || undefined, args: form.args.split(/\s+/).map(item => item.trim()).filter(Boolean), envRefs },
          });
          // Match the old Studio lifecycle: a newly added MCP is not bindable
          // until the Host has performed a real probe and persisted its tool
          // contract. The probe stays on the Host; the browser never connects.
          await hostRemote.probeMcpResource(created.resourceId);
          onCreated?.(created);
          onClose();
        } catch (reason) { setError(reason?.message || 'MCP 创建失败'); }
        finally { setSaving(false); }
      };
      const field = (label, key, placeholder, type = 'text') => h('label', { style: { display: 'grid', gap: '5px', color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, label, h('input', { type, value: form[key], placeholder, onChange: event => setField(key, event.target.value), style: inputStyle() }));
      return h(ResourceDialog, { title: '添加 MCP Server', detail: '创建后 Host 会保存连接声明并完成探测；绑定关系请在 Agent 创建或编辑页维护。', onClose },
        h('form', { onSubmit: save, style: { display: 'grid', gap: '12px' } },
          h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' } }, field('显示名称', 'displayName', '例如：企业搜索'), field('资源名称', 'name', '例如：enterprise-search')),
          h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' } }, field('版本', 'version', '1.0.0'), h('label', { style: { display: 'grid', gap: '5px', color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '传输方式', h('select', { value: form.transport, onChange: event => setField('transport', event.target.value), style: inputStyle() }, h('option', { value: 'http' }, 'HTTP'), h('option', { value: 'sse' }, 'SSE'), h('option', { value: 'stdio' }, 'stdio')))),
          field('说明', 'description', '这个 MCP 提供什么能力？'),
          (form.transport === 'stdio' ? field('启动命令', 'command', '例如：npx') : field('服务地址', 'endpointUrl', '例如：https://mcp.example.com')),
          form.transport === 'stdio' ? field('命令参数', 'args', '例如：-y @acme/search-mcp') : null,
          h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' } }, field('凭证名称（可选）', 'apiKeyName', '例如：SEARCH_API_KEY'), field('API Key（仅本次保存）', 'apiKeyValue', '不会写入资源目录', 'password')),
          field('环境变量引用（可选）', 'envRefs', '例如：API_KEY=env://SEARCH_API_KEY'),
          error ? h('div', { role: 'alert', style: { color: BRAND.danger, fontSize: '12px' } }, error) : null,
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '4px' } }, h('button', { type: 'button', onClick: onClose, style: buttonStyle() }, '取消'), h('button', { type: 'submit', disabled: saving, style: { ...buttonStyle(), color: 'var(--dsw-static-neutral-00, #fff)', background: saving ? BRAND.accentSoft : BRAND.primaryFill, borderColor: saving ? BRAND.border : 'transparent' } }, saving ? '正在探测…' : '保存并探测'))));
    }

    function formatResourceSize(value) {
      const bytes = Number(value || 0);
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
      return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
    }

    // Keep the file tree in the browser surface, but let the Host remain the
    // only authority that reads file contents. This mirrors the old Studio's
    // SkillFileBrowser without copying its React component or adding a second
    // resource store.
    function buildSkillFileTree(files) {
      const root = { name: '', path: '', directory: true, children: [] };
      for (const file of files) {
        const parts = String(file?.path || '').split('/').filter(Boolean);
        let parent = root;
        parts.forEach((part, index) => {
          const path = parts.slice(0, index + 1).join('/');
          const directory = index < parts.length - 1;
          let node = parent.children.find(item => item.name === part && item.directory === directory);
          if (!node) {
            node = { name: part, path, directory, file: directory ? undefined : file, children: [] };
            parent.children.push(node);
          }
          parent = node;
        });
      }
      const sortNodes = nodes => {
        nodes.sort((left, right) => Number(right.directory) - Number(left.directory) || left.name.localeCompare(right.name));
        nodes.forEach(node => sortNodes(node.children));
      };
      sortNodes(root.children);
      return root.children;
    }

    function SkillPreviewDialog({ title, preview, file, onClose, onSelect }) {
      const files = Array.isArray(preview?.files) ? preview.files : [];
      const [collapsed, setCollapsed] = useState(() => new Set());
      const tree = buildSkillFileTree(files);
      const renderNodes = (nodes, depth = 0) => nodes.map(node => {
        if (node.directory) {
          const isCollapsed = collapsed.has(node.path);
          return h('div', { key: `dir:${node.path}` },
            h('button', {
              type: 'button',
              'aria-expanded': !isCollapsed,
              onClick: () => setCollapsed(current => {
                const next = new Set(current);
                if (next.has(node.path)) next.delete(node.path); else next.add(node.path);
                return next;
              }),
              style: { display: 'flex', alignItems: 'center', gap: '5px', width: '100%', border: 0, borderRadius: '7px', padding: `6px 8px 6px ${8 + depth * 14}px`, textAlign: 'left', color: BRAND.ink, background: 'transparent', cursor: 'pointer', fontSize: '11px', fontWeight: 750 },
            }, isCollapsed ? '▸' : '▾', '▰', h('span', { title: node.name }, node.name)),
            !isCollapsed ? h('div', null, renderNodes(node.children, depth + 1)) : null);
        }
        const selected = file?.path === node.path;
        return h('button', {
          key: `file:${node.path}`,
          type: 'button',
          'aria-selected': selected,
          onClick: () => onSelect?.(node.path),
          style: { display: 'flex', alignItems: 'center', gap: '6px', width: '100%', border: 0, borderRadius: '7px', padding: `6px 8px 6px ${20 + depth * 14}px`, textAlign: 'left', color: BRAND.ink, background: selected ? BRAND.accentSoft : 'transparent', cursor: 'pointer', fontSize: '11px' },
        }, node.file?.kind === 'script' ? '▧' : '▤', h('span', { title: node.path, style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, node.name));
      });
      return h(ResourceDialog, { title: title || 'Skill 预览', detail: '只读查看 Skill 文件；导入前不会写入工作区。目录树和文件内容都由 Host 读取。', onClose },
        h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(190px, 0.8fr) minmax(0, 1.6fr)', gap: '12px', minHeight: '300px' } },
          h('div', { role: 'tree', 'aria-label': 'Skill 文件树', style: { border: '1px solid ' + BRAND.border, borderRadius: '10px', padding: '8px', overflow: 'auto', background: BRAND.surface } }, files.length ? renderNodes(tree) : h('div', { style: { color: BRAND.inkMuted, padding: '10px', fontSize: '12px' } }, '没有可预览文件。')),
          h('div', { style: { minWidth: 0, display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr)', gap: '8px' } },
            h('div', { style: { color: BRAND.inkMuted, fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, file ? `${file.path} · ${file.kind || 'text'} · ${formatResourceSize(file.size)}` : '选择左侧文件查看内容'),
            h('pre', { style: { margin: 0, minHeight: '260px', maxHeight: '460px', overflow: 'auto', border: '1px solid ' + BRAND.border, borderRadius: '10px', padding: '12px', color: BRAND.ink, background: BRAND.canvas, whiteSpace: 'pre-wrap', fontSize: '11px', lineHeight: 1.5 } }, file ? (file.content || `${file.path} · ${formatResourceSize(file.size)}`) : '选择左侧文件查看内容'))));
    }

    function McpToolsDialog({ resource, onClose }) {
      const tools = Array.isArray(resource?.contract?.discoveredTools) ? resource.contract.discoveredTools : (Array.isArray(resource?.health?.tools) ? resource.health.tools : []);
      return h(ResourceDialog, { title: `${resource?.displayName || resource?.name || 'MCP'} · 工具清单`, detail: '以下清单来自 Host 最近一次 MCP 探测；绑定关系请在 Agent 创建或编辑页维护。', onClose },
        tools.length ? h('div', { style: { display: 'grid', gap: '8px', maxHeight: '520px', overflow: 'auto' } }, tools.map(tool => h('article', { key: tool.name, style: { border: '1px solid ' + BRAND.border, borderRadius: '10px', padding: '10px 12px', background: BRAND.surface } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'baseline' } }, h('strong', { style: { color: BRAND.ink, fontSize: '12px' } }, tool.name || '未命名 Tool'), h('span', { style: { color: BRAND.inkMuted, fontSize: '10px' } }, tool.version || tool.executor || 'MCP')),
          h('p', { style: { margin: '5px 0 0', color: BRAND.inkMuted, fontSize: '11px', lineHeight: 1.5 } }, tool.description || '没有描述'),
          h('div', { style: { marginTop: '6px', color: BRAND.inkMuted, fontSize: '10px' } }, `${tool.approval ? `审批：${tool.approval}` : '审批策略由 Host 决定'}${tool.sideEffect ? ` · 副作用：${tool.sideEffect}` : ''}`)))) : h('div', { style: { color: BRAND.inkMuted, fontSize: '12px', padding: '20px 8px', textAlign: 'center' } }, 'Host 尚未返回工具清单，请先重新探测 MCP。'));
    }

    function SkillDiscoveryDialog({ onClose, onImported }) {
      const [scanPaths, setScanPaths] = useState('');
      const [discovery, setDiscovery] = useState(null);
      const [selected, setSelected] = useState([]);
      const [preview, setPreview] = useState(null);
      const [previewFile, setPreviewFile] = useState(null);
      const [status, setStatus] = useState('idle');
      const [error, setError] = useState('');
      const candidates = Array.isArray(discovery?.candidates) ? discovery.candidates : [];
      const scan = async () => {
        setStatus('scanning'); setError(''); setPreview(null); setPreviewFile(null); setSelected([]);
        try { setDiscovery(await hostRemote.discoverSkills(scanPaths.split(',').map(item => item.trim()).filter(Boolean))); setStatus('ready'); }
        catch (reason) { setStatus('error'); setError(reason?.message || 'Skill 扫描失败'); }
      };
      const toggle = id => setSelected(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
      const showPreview = async candidate => {
        try { const files = await hostRemote.previewDiscoveredSkill(discovery.inspectionToken, candidate.candidateId); setPreview({ title: candidate.displayName || candidate.name, files, candidate }); setPreviewFile(null); }
        catch (reason) { setError(reason?.message || 'Skill 预览失败'); }
      };
      const selectFile = async path => {
        if (!preview) return;
        try { setPreviewFile(await hostRemote.previewDiscoveredSkill(discovery.inspectionToken, preview.candidate.candidateId, path)); }
        catch (reason) { setError(reason?.message || 'Skill 文件读取失败'); }
      };
      const commit = async () => {
        if (!discovery?.inspectionToken || !selected.length || status === 'committing') return;
        setStatus('committing'); setError('');
        try { for (const id of selected) await hostRemote.commitDiscoveredSkill(discovery.inspectionToken, id, false); onImported?.(); onClose(); }
        catch (reason) { setStatus('error'); setError(reason?.message || 'Skill 导入失败；冲突项需要重新扫描后确认覆盖。'); }
      };
      return h(ResourceDialog, { title: '发现本地 Skill', detail: '扫描安全默认目录或指定工作区相对路径，预览后确认导入。', onClose },
        h('div', { style: { display: 'grid', gap: '12px' } },
          h('div', { style: { display: 'flex', gap: '8px', alignItems: 'end' } }, h('label', { style: { flex: 1, display: 'grid', gap: '5px', color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '扫描目录（逗号分隔）', h('input', { value: scanPaths, onChange: event => setScanPaths(event.target.value), placeholder: '留空扫描 skills, .agents/skills, .codex/skills, .claude/skills', style: inputStyle() })), h('button', { type: 'button', disabled: status === 'scanning', onClick: scan, style: buttonStyle() }, status === 'scanning' ? '扫描中…' : '扫描')),
          error ? h('div', { role: 'alert', style: { color: BRAND.danger, fontSize: '12px' } }, error) : null,
          candidates.length ? h('div', { style: { display: 'grid', gap: '7px', maxHeight: '330px', overflow: 'auto' } }, candidates.map(candidate => h('div', { key: candidate.candidateId, style: { display: 'flex', alignItems: 'center', gap: '9px', padding: '10px', border: '1px solid ' + BRAND.border, borderRadius: '9px', background: BRAND.surface } }, h('input', { type: 'checkbox', checked: selected.includes(candidate.candidateId), disabled: candidate.status === 'invalid', onChange: () => toggle(candidate.candidateId), 'aria-label': `选择 ${candidate.displayName || candidate.name}` }), h('div', { style: { flex: 1, minWidth: 0 } }, h('strong', { style: { color: BRAND.ink, fontSize: '12px' } }, candidate.displayName || candidate.name), h('div', { style: { color: BRAND.inkMuted, fontSize: '10px', marginTop: '3px' } }, `${candidate.path || '—'} · ${candidate.version || '未知版本'} · ${candidate.fileCount || 0} 文件`), candidate.risk?.requiresReview ? h('span', { style: { color: 'var(--dsw-alias-state-warn-primary, #8a5b13)', fontSize: '10px' } }, '包含脚本或网络标记，需人工复核') : null), h(Pill, { tone: candidate.status === 'ready' ? 'accent' : 'signal' }, candidate.status === 'conflict' ? '已安装' : candidate.status === 'invalid' ? '无效' : '可导入'), h('button', { type: 'button', onClick: () => void showPreview(candidate), style: { ...buttonStyle(), padding: '5px 8px', fontSize: '10px' } }, '预览')))) : status === 'ready' ? h('div', { style: { color: BRAND.inkMuted, fontSize: '12px', padding: '22px 0', textAlign: 'center' } }, '安全扫描目录中没有发现 Skill。') : null,
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', marginTop: '3px' } }, h('span', { style: { color: BRAND.inkMuted, fontSize: '11px' } }, discovery ? `发现 ${candidates.length} 个候选 · 已选择 ${selected.length}` : '请先扫描'), h('div', { style: { display: 'flex', gap: '8px' } }, h('button', { type: 'button', onClick: onClose, style: buttonStyle() }, '取消'), h('button', { type: 'button', disabled: !selected.length || status === 'committing', onClick: commit, style: { ...buttonStyle(), color: 'var(--dsw-static-neutral-00, #fff)', background: !selected.length || status === 'committing' ? BRAND.accentSoft : BRAND.primaryFill, borderColor: !selected.length || status === 'committing' ? BRAND.border : 'transparent' } }, status === 'committing' ? '导入中…' : '导入选中 Skill')))),
          preview ? h(SkillPreviewDialog, { title: preview.title, preview: preview.files, onClose: () => setPreview(null), onSelect: async path => { await selectFile(path); }, file: previewFile }) : null);
    }

    function ModelResourceDialog({ onClose, onCreated }) {
      const [form, setForm] = useState({ name: '', displayName: '', model: '', endpointUrl: '', credentialRef: 'env://MODEL_API_KEY', description: '' });
      const [saving, setSaving] = useState(false);
      const [error, setError] = useState('');
      const setField = (key, value) => setForm(current => ({ ...current, [key]: value }));
      const save = async event => {
        event.preventDefault();
        if (saving) return;
        const name = form.name.trim().toLowerCase();
        if (!/^[a-z][a-z0-9._-]{1,127}$/.test(name)) { setError('名称需要是 2-128 位小写字母、数字、点、下划线或短横线。'); return; }
        if (!form.displayName.trim() || !form.model.trim() || !form.endpointUrl.trim()) { setError('请填写显示名称、模型 ID 和接口地址。'); return; }
        setSaving(true); setError('');
        try {
          const result = await hostRemote.createModelResource({
            name,
            displayName: form.displayName.trim(),
            version: '1.0.0',
            description: form.description.trim(),
            spec: { provider: 'openai-compatible', model: form.model.trim(), endpointUrl: form.endpointUrl.trim(), credentialRef: form.credentialRef.trim() || undefined, wireApi: 'chat' },
          });
          onCreated?.(result); onClose();
        } catch (reason) { setError(reason?.message || '模型创建失败'); }
        finally { setSaving(false); }
      };
      const field = (label, key, placeholder, type = 'text') => h('label', { style: { display: 'grid', gap: '5px', color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, label, h('input', { type, value: form[key], placeholder, onChange: event => setField(key, event.target.value), style: inputStyle() }));
      return h(ResourceDialog, { title: '添加模型资源', detail: '资源页只登记模型端点；API Key 由设置页和全局配置管理，Agent 绑定在创建或编辑页完成。', onClose },
        h('form', { onSubmit: save, style: { display: 'grid', gap: '12px' } },
          h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' } }, field('资源名称', 'name', 'ksyun-chat'), field('显示名称', 'displayName', '金山云 Chat')),
          field('模型 ID', 'model', 'deepseek-v4-flash'),
          field('接口地址', 'endpointUrl', 'https://api.example.com/v1/chat/completions'),
          field('凭证引用（可选）', 'credentialRef', 'env://MODEL_API_KEY'),
          field('说明（可选）', 'description', '模型用途和协议说明'),
          error ? h('div', { role: 'alert', style: { color: BRAND.danger, fontSize: '12px' } }, error) : null,
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' } }, h('button', { type: 'button', onClick: onClose, style: buttonStyle() }, '取消'), h('button', { type: 'submit', disabled: saving, style: { ...buttonStyle(), color: 'var(--dsw-static-neutral-00, #fff)', background: saving ? BRAND.accentSoft : BRAND.primaryFill, borderColor: saving ? BRAND.border : 'transparent' } }, saving ? '创建中…' : '创建模型'))));
    }

    function ToolResourceDialog({ onClose, onCreated }) {
      const [form, setForm] = useState({ name: '', displayName: '', description: '', category: 'custom', executor: 'builtin' });
      const [saving, setSaving] = useState(false);
      const [error, setError] = useState('');
      const setField = (key, value) => setForm(current => ({ ...current, [key]: value }));
      const save = async event => {
        event.preventDefault();
        if (saving) return;
        const name = form.name.trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) { setError('Tool 名称需要使用字母、数字和下划线。'); return; }
        if (!form.displayName.trim()) { setError('请填写显示名称。'); return; }
        setSaving(true); setError('');
        try {
          const result = await hostRemote.createToolResource({ displayName: form.displayName.trim(), category: form.category.trim() || 'custom', contract: { name, version: '1.0.0', description: form.description.trim(), inputSchema: { type: 'object', properties: {} }, outputSchema: { type: 'object' }, executor: form.executor } });
          onCreated?.(result); onClose();
        } catch (reason) { setError(reason?.message || 'Tool 创建失败'); }
        finally { setSaving(false); }
      };
      const field = (label, key, placeholder) => h('label', { style: { display: 'grid', gap: '5px', color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, label, h('input', { value: form[key], placeholder, onChange: event => setField(key, event.target.value), style: inputStyle() }));
      return h(ResourceDialog, { title: '添加 Tool 资源', detail: '先登记 Tool Contract，再在 Agent 创建或编辑页选择一个或多个 Tool。', onClose },
        h('form', { onSubmit: save, style: { display: 'grid', gap: '12px' } },
          h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' } }, field('Tool 名称', 'name', 'lookup_customer'), field('显示名称', 'displayName', '客户查询')),
          h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' } }, field('分类', 'category', 'custom'), h('label', { style: { display: 'grid', gap: '5px', color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '执行器', h('select', { value: form.executor, onChange: event => setField('executor', event.target.value), style: inputStyle() }, h('option', { value: 'builtin' }, 'builtin'), h('option', { value: 'deferred' }, 'deferred'), h('option', { value: 'python' }, 'python'), h('option', { value: 'mcp' }, 'mcp')))),
          field('说明（可选）', 'description', 'Tool 的用途和副作用'),
          error ? h('div', { role: 'alert', style: { color: BRAND.danger, fontSize: '12px' } }, error) : null,
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' } }, h('button', { type: 'button', onClick: onClose, style: buttonStyle() }, '取消'), h('button', { type: 'submit', disabled: saving, style: { ...buttonStyle(), color: 'var(--dsw-static-neutral-00, #fff)', background: saving ? BRAND.accentSoft : BRAND.primaryFill, borderColor: saving ? BRAND.border : 'transparent' } }, saving ? '创建中…' : '创建 Tool'))));
    }

    function ResourcesPage() {
      const [resourceKind, setResourceKind] = useState('model');
      const [resources, setResources] = useState([]);
      const [platformCatalog, setPlatformCatalog] = useState(null);
      const [page, setPage] = useState(0);
      const [pageSize, setPageSize] = useState(20);
      const [cursorStack, setCursorStack] = useState([null]);
      const [nextCursor, setNextCursor] = useState(null);
      const [total, setTotal] = useState(0);
      const [query, setQuery] = useState('');
      const [submittedQuery, setSubmittedQuery] = useState('');
      const [status, setStatus] = useState('loading');
      const [message, setMessage] = useState('');
      const [error, setError] = useState('');
      const [mcpDialogOpen, setMcpDialogOpen] = useState(false);
      const [mcpPreview, setMcpPreview] = useState(null);
      const [skillDialogOpen, setSkillDialogOpen] = useState(false);
      const [skillPreview, setSkillPreview] = useState(null);
      const [skillPreviewFile, setSkillPreviewFile] = useState(null);
      const [modelDialogOpen, setModelDialogOpen] = useState(false);
      const [toolDialogOpen, setToolDialogOpen] = useState(false);
      const [resourcePreview, setResourcePreview] = useState(null);
      const [deleting, setDeleting] = useState(false);
      const platformKinds = ['knowledge-base', 'memory-instance', 'skill-space'];
      const isPlatform = platformKinds.includes(resourceKind);
      const requestSeq = useRef(0);
      const resourceKinds = [
        ['model', '模型'], ['tool', 'Tool'], ['mcp', 'MCP'], ['skill', 'Skill'],
        ['knowledge-base', '知识库'], ['memory-instance', '记忆库'], ['skill-space', 'Skill Center'],
      ];
      const label = resourceKinds.find(item => item[0] === resourceKind)?.[1] || '资源';

      const load = async (kind = resourceKind, cursor = null, resetPaging = true) => {
        const seq = ++requestSeq.current;
        setStatus('loading'); setError(''); setMessage('');
        if (resetPaging) { setPage(0); setCursorStack([null]); setNextCursor(null); }
        try {
          const result = platformKinds.includes(kind)
            ? await hostRemote.platformResources(kind)
            : await hostRemote.resources({ kind, limit: pageSize, cursor, query: submittedQuery.trim() });
          if (seq !== requestSeq.current) return;
          if (platformKinds.includes(kind)) {
            setPlatformCatalog(result || { items: [] }); setResources([]); setNextCursor(null); setTotal(Number(result?.total) || (result?.items || []).length || 0);
          } else {
            setResources(Array.isArray(result?.items) ? result.items : []);
            setNextCursor(result?.nextCursor || null);
            setTotal(Number(result?.total) || 0);
            setPlatformCatalog(null);
          }
          setStatus('ready');
        } catch (reason) {
          if (seq === requestSeq.current) { setStatus('error'); setError(reason?.message || '资源目录不可用'); }
        }
      };
      useEffect(() => {
        const timer = setTimeout(() => setSubmittedQuery(query), 250);
        return () => clearTimeout(timer);
      }, [query]);
      useEffect(() => { void load(resourceKind, null, true); }, [resourceKind, pageSize, submittedQuery]);
      const reloadCatalog = () => load(resourceKind, null, true);
      const probeMcp = async resource => {
        setMessage(''); setError('');
        try {
          const result = await hostRemote.probeMcpResource(resource.resourceId);
          setMessage(`${resource.displayName || resource.name} 已探测，发现 ${result?.health?.toolCount || result?.toolCount || 0} 个 Tool。`);
          await reloadCatalog();
        } catch (reason) { setError(reason?.message || 'MCP 探测失败'); }
      };
      const previewInstalledSkill = async resource => {
        try {
          const files = await hostRemote.previewInstalledSkill(resource.resourceId);
          setSkillPreview({ title: resource.displayName || resource.name || resource.resourceId, files, resource });
          setSkillPreviewFile(null);
        } catch (reason) { setError(reason?.message || 'Skill 文件读取失败'); }
      };
      const loadSkillFile = async path => {
        if (!skillPreview?.resource) return;
        try { setSkillPreviewFile(await hostRemote.previewInstalledSkill(skillPreview.resource.resourceId, path)); }
        catch (reason) { setError(reason?.message || 'Skill 文件读取失败'); }
      };
      const remove = async resource => {
        if (deleting) return;
        const name = resource.displayName || resource.name || resource.resourceId;
        if (typeof window !== 'undefined' && !window.confirm(`确定从资源目录删除“${name}”吗？Agent 已有的 Revision 不会被这里静默改写。`)) return;
        setDeleting(true); setError(''); setMessage('');
        try {
          await hostRemote.deleteResource(resource.resourceId);
          setMessage(`${name} 已从资源目录删除。需要变更 Agent 绑定时，请到 Agent 创建或编辑页提交新的 Revision。`);
          await reloadCatalog();
        } catch (reason) { setError(reason?.message || '资源删除失败'); }
        finally { setDeleting(false); }
      };
      const previousPage = async () => {
        if (page <= 0 || status === 'loading') return;
        const previous = page - 1;
        setPage(previous);
        await load(resourceKind, cursorStack[previous] || null, false);
      };
      const nextPage = async () => {
        if (!nextCursor || status === 'loading') return;
        const next = page + 1;
        setCursorStack(current => [...current.slice(0, next), nextCursor]);
        setPage(next);
        await load(resourceKind, nextCursor, false);
      };
      const pageCount = total ? Math.max(1, Math.ceil(total / pageSize)) : (nextCursor ? page + 2 : page + 1);
      const sourceLabel = item => item.source || item.provider || item.origin || '—';
      const kindDetail = item => item.contract?.model || item.contract?.entrypoint || item.contract?.transport || item.region || item.version || '—';
      const rows = isPlatform ? (platformCatalog?.items || []) : resources;
      const tableRows = rows.map(resource => {
            const id = resource.resourceId || resource.id || resource.name;
            const name = resource.displayName || resource.name || id;
            const canDelete = !isPlatform && resource.source === 'local';
            return h('tr', { key: id, style: { borderBottom: '1px solid ' + BRAND.border } },
              h('td', { style: { padding: '12px 13px', color: BRAND.ink } }, h('strong', null, name), h('div', { style: { color: BRAND.inkMuted, fontSize: '10px', marginTop: '3px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', wordBreak: 'break-all' } }, id)),
              h('td', { style: { padding: '12px 13px', color: BRAND.inkMuted, whiteSpace: 'nowrap' } }, sourceLabel(resource)),
              h('td', { style: { padding: '12px 13px', color: BRAND.inkMuted, whiteSpace: 'nowrap' } }, kindDetail(resource)),
              h('td', { style: { padding: '12px 13px', whiteSpace: 'nowrap' } }, h(Pill, { tone: resource.disabled ? 'signal' : String(resource.status || 'ready').toLowerCase() === 'ready' ? 'accent' : 'signal' }, resource.disabled ? '不可用' : resource.status || 'ready')),
              h('td', { style: { padding: '12px 13px', whiteSpace: 'nowrap' } },
                h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
                  h('button', { type: 'button', onClick: () => setResourcePreview(resource), style: { ...buttonStyle(), padding: '5px 8px', fontSize: '10px' } }, '查看'),
                  resourceKind === 'mcp' ? h('button', { type: 'button', onClick: () => void probeMcp(resource), style: { ...buttonStyle(), padding: '5px 8px', fontSize: '10px' } }, '重新探测') : null,
                  resourceKind === 'mcp' ? h('button', { type: 'button', onClick: () => setMcpPreview(resource), style: { ...buttonStyle(), padding: '5px 8px', fontSize: '10px' } }, '查看工具') : null,
                  resourceKind === 'skill' ? h('button', { type: 'button', onClick: () => void previewInstalledSkill(resource), style: { ...buttonStyle(), padding: '5px 8px', fontSize: '10px' } }, '查看文件') : null,
                  canDelete ? h('button', { type: 'button', disabled: deleting, onClick: () => void remove(resource), style: { ...buttonStyle(), padding: '5px 8px', fontSize: '10px', color: BRAND.danger } }, '删除') : null,
                )));
      });
      const table = rows.length ? h('div', { style: { maxHeight: 'min(58vh, 620px)', overflow: 'auto', border: '1px solid ' + BRAND.border, borderRadius: '12px', background: BRAND.surface } },
        h('table', { style: { width: '100%', borderCollapse: 'collapse', minWidth: '760px', fontSize: '12px' } },
          h('thead', { style: { position: 'sticky', top: 0, zIndex: 1 } }, h('tr', { style: { color: BRAND.inkMuted, textAlign: 'left', background: BRAND.canvas } }, ['名称', '来源', '版本 / 类型', '状态', '操作'].map(column => h('th', { key: column, style: { padding: '11px 13px', borderBottom: '1px solid ' + BRAND.border, fontWeight: 750, whiteSpace: 'nowrap' } }, column)))),
          h('tbody', null, tableRows))) : null;
      const platformTable = platformCatalog ? h('section', { style: { border: '1px solid ' + BRAND.border, borderRadius: '12px', padding: '14px', background: BRAND.surface } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '12px', marginBottom: '10px' } }, h('div', null, h('strong', { style: { color: BRAND.ink, fontSize: '14px' } }, label), h('div', { style: { color: BRAND.inkMuted, fontSize: '11px', marginTop: '4px' } }, platformCatalog.connectionRef ? '云端目录资源只在这里做发现、查看和刷新；每类默认只允许绑定一个资源。绑定动作在 Agent 创建或编辑页完成。' : '当前没有可用云端凭证，先到设置页配置后再读取目录。')), h(Pill, { tone: platformCatalog.connectionRef ? 'accent' : 'signal' }, platformCatalog.connectionRef ? '目录已连接' : '待连接')),
        platformCatalog.items?.length ? table : h(EmptyState, { icon: '◈', title: `暂无${label}`, detail: platformCatalog.connectionRef ? '云端目录没有返回可用资源。' : '连接云端后刷新此目录。' })) : null;
      return h('div', null,
        h(ContentIntro, { detail: '资源库只负责资源目录生命周期：发现、导入、探测、查看、删除和状态刷新。新增或变更 Agent 绑定关系请在 Agent 创建页或编辑页完成。模型、Tool、MCP、Skill 可绑定多个；知识库、记忆库和 Skill Center 每类默认绑定一个。', action: h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end' } },
          resourceKind === 'model' ? h('button', { type: 'button', onClick: () => setModelDialogOpen(true), style: buttonStyle() }, '添加模型') : null,
          resourceKind === 'tool' ? h('button', { type: 'button', onClick: () => setToolDialogOpen(true), style: buttonStyle() }, '添加 Tool') : null,
          resourceKind === 'mcp' ? h('button', { type: 'button', onClick: () => setMcpDialogOpen(true), style: buttonStyle() }, '添加 MCP') : null,
          resourceKind === 'skill' ? h('button', { type: 'button', onClick: () => setSkillDialogOpen(true), style: buttonStyle() }, '扫描本地 Skill') : null,
          h('button', { type: 'button', onClick: () => void reloadCatalog(), style: buttonStyle() }, '刷新'),
          h(Pill, { tone: status === 'ready' ? 'accent' : 'signal' }, status === 'ready' ? 'Host 已连接' : 'Host 待接入')) }),
        h(StudioPageTabs, { ariaLabel: '资源类型', value: resourceKind, onChange: setResourceKind, items: resourceKinds.map(([id, value]) => ({ id, label: value })) }),
        status === 'loading' ? h(EmptyState, { icon: '·', title: '正在读取资源目录', detail: '读取 Host 的资源清单和云端平台目录。' }) : null,
        status === 'error' ? h(EmptyState, { icon: '!', title: '资源目录不可用', detail: error, action: h('button', { type: 'button', onClick: () => void reloadCatalog(), style: buttonStyle() }, '重新读取') }) : null,
        status === 'ready' ? h(React.Fragment, null,
          !isPlatform ? h('section', { style: { display: 'grid', gap: '10px' } },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
              h('input', { type: 'search', value: query, onChange: event => setQuery(event.target.value), placeholder: `搜索${label}`, 'aria-label': '搜索资源', style: { ...inputStyle(), marginTop: 0, maxWidth: '460px', flex: '1 1 280px' } }),
              h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', color: BRAND.inkMuted, fontSize: '11px' } }, h('span', null, `${total || resources.length} 项 · 第 ${page + 1}/${pageCount} 页`), h('select', { value: String(pageSize), onChange: event => setPageSize(Number(event.target.value)), 'aria-label': '每页显示数量', style: { ...inputStyle(), width: '112px', marginTop: 0, padding: '0 7px' } }, h('option', { value: '10' }, '每页 10 条'), h('option', { value: '20' }, '每页 20 条'), h('option', { value: '50' }, '每页 50 条')))),
            table || h(EmptyState, { icon: '◈', title: `暂无${label}`, detail: '可以从右上角添加、发现或刷新资源。' }),
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', color: BRAND.inkMuted, fontSize: '11px' } }, h('span', null, `当前页 ${resources.length} 项`), h('div', { style: { display: 'flex', gap: '6px' } }, h('button', { type: 'button', disabled: page <= 0 || status === 'loading', onClick: () => void previousPage(), style: buttonStyle() }, '上一页'), h('button', { type: 'button', disabled: !nextCursor || status === 'loading', onClick: () => void nextPage(), style: buttonStyle() }, '下一页')))
          ) : platformTable,
          message ? h('div', { role: 'status', style: { marginTop: '10px', color: BRAND.accentStrong, fontSize: '12px' } }, message) : null,
          error ? h('div', { role: 'alert', style: { marginTop: '10px', color: BRAND.danger, fontSize: '12px' } }, error) : null,
        ) : null,
        modelDialogOpen ? h(ModelResourceDialog, { onClose: () => setModelDialogOpen(false), onCreated: reloadCatalog }) : null,
        toolDialogOpen ? h(ToolResourceDialog, { onClose: () => setToolDialogOpen(false), onCreated: reloadCatalog }) : null,
        mcpDialogOpen ? h(McpResourceDialog, { onClose: () => setMcpDialogOpen(false), onCreated: reloadCatalog }) : null,
        mcpPreview ? h(McpToolsDialog, { resource: mcpPreview, onClose: () => setMcpPreview(null) }) : null,
        skillDialogOpen ? h(SkillDiscoveryDialog, { onClose: () => setSkillDialogOpen(false), onImported: reloadCatalog }) : null,
        skillPreview ? h(SkillPreviewDialog, { title: skillPreview.title, preview: skillPreview.files, file: skillPreviewFile, onClose: () => { setSkillPreview(null); setSkillPreviewFile(null); }, onSelect: loadSkillFile }) : null,
        resourcePreview ? h(ResourceDialog, { title: resourcePreview.displayName || resourcePreview.name || resourcePreview.resourceId, detail: '只读查看 Host 资源声明。Agent 绑定关系不会在资源库页面修改。', onClose: () => setResourcePreview(null) }, h('pre', { style: { margin: 0, maxHeight: '520px', overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: BRAND.ink, background: BRAND.canvas, border: '1px solid ' + BRAND.border, borderRadius: '10px', padding: '12px', fontSize: '11px', lineHeight: 1.5 } }, JSON.stringify(resourcePreview, null, 2))) : null);
    }

    function MarketplacePage() {
      const [status, setStatus] = useState('loading');
      const [items, setItems] = useState([]);
      const [errors, setErrors] = useState([]);
      const [busyKey, setBusyKey] = useState('');
      const [message, setMessage] = useState('');
      const load = async () => {
        setStatus('loading');
        setMessage('');
        const results = await Promise.allSettled([hostRemote.dshPlugins(), hostRemote.codexPlugins()]);
        const next = [];
        const nextErrors = [];
        for (const [index, result] of results.entries()) {
          const ecosystem = index === 0 ? 'DSH' : 'Codex';
          if (result.status === 'fulfilled') {
            for (const item of (result.value?.items || [])) next.push({ ...item, ecosystem });
            if (result.value?.error?.message) nextErrors.push(`${ecosystem}：${result.value.error.message}`);
          } else nextErrors.push(`${ecosystem}：${result.reason?.message || '插件宿主不可用'}`);
        }
        setItems(next);
        setErrors(nextErrors);
        setStatus('ready');
      };
      const mutate = async (item, operation) => {
        const pluginId = String(item.pluginId || item.id || '').trim();
        if (!pluginId || busyKey) return;
        const key = `${item.ecosystem}:${pluginId}`;
        setBusyKey(key); setMessage(''); setErrors([]);
        try {
          if (item.ecosystem === 'dsh') {
            if (operation === 'install') {
              const source = item.source?.package || item.distributionName || pluginId;
              await hostRemote.installDshPlugin(source, true);
            } else if (operation === 'enable') await hostRemote.enableDshPlugin(pluginId);
            else if (operation === 'disable') await hostRemote.disableDshPlugin(pluginId);
            else if (operation === 'update') await hostRemote.updateDshPlugin(pluginId);
            else if (operation === 'uninstall') await hostRemote.uninstallDshPlugin(pluginId);
          } else if (operation === 'install') {
            await hostRemote.installCodexPlugin(pluginId, item.marketplaceName);
          } else if (operation === 'uninstall') {
            await hostRemote.uninstallCodexPlugin(pluginId);
          }
          setMessage(`${item.displayName || pluginId}：${operation === 'install' ? '已安装' : operation === 'uninstall' ? '已卸载' : operation === 'enable' ? '已启用' : operation === 'disable' ? '已停用' : '已更新'}。`);
          await load();
        } catch (reason) {
          setErrors([reason?.message || '插件操作失败']);
        } finally { setBusyKey(''); }
      };
      useEffect(() => { void load(); }, []);
      return h('div', null,
        h(SectionHeading, { eyebrow: 'Studio domain', title: '插件市场', detail: '统一管理 DSH 与 Codex 两个插件生态；变更会调用对应 Host，并在 Profile 重载后生效。', action: h(Pill, { tone: status === 'ready' ? 'accent' : 'signal' }, status === 'ready' ? '目录已读取' : '正在读取') }),
        status === 'loading' ? h(EmptyState, { icon: '·', title: '正在读取插件目录', detail: '分别询问 DSH Profile Host 和 Codex App Server。' }) : null,
        errors.length ? h('div', { role: 'status', style: { marginBottom: '14px', padding: '10px 12px', borderRadius: '9px', background: 'var(--dsw-alias-state-warn-tertiary, #fff3da)', color: 'var(--dsw-alias-state-warn-primary, #8a5b13)', fontSize: '12px' } }, errors.join('；')) : null,
        message ? h('div', { role: 'status', style: { marginBottom: '14px', padding: '10px 12px', borderRadius: '9px', background: BRAND.accentSoft, color: BRAND.accentStrong, fontSize: '12px' } }, message) : null,
        status === 'ready' && items.length === 0 ? h(EmptyState, { icon: '⌘', title: '暂时没有可展示的插件', detail: '两个插件宿主都没有返回可见插件。', action: h('button', { type: 'button', onClick: load, style: buttonStyle() }, '重新读取') }) : null,
        items.length ? h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '12px' } }, items.map((item, index) => h('article', { key: `${item.ecosystem}-${item.pluginId || item.id || index}`, style: { border: '1px solid ' + BRAND.border, borderRadius: '14px', padding: '16px', background: BRAND.surface } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'flex-start' } },
            h('div', null, h('div', { style: { color: BRAND.ink, fontWeight: 750, fontSize: '14px' } }, item.displayName || item.name || item.pluginId || '未命名插件'), h('div', { style: { color: BRAND.inkMuted, fontSize: '11px', marginTop: '5px', wordBreak: 'break-all' } }, item.pluginId || item.id || '—')),
            h(Pill, { tone: item.ready || item.enabled || item.installed ? 'accent' : 'neutral' }, item.ecosystem)),
          h('p', { style: { color: BRAND.inkMuted, lineHeight: 1.55, margin: '12px 0 0', fontSize: '12px' } }, item.description || item.interface?.shortDescription || '由插件生态提供的可选能力。'),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '12px' } }, item.resolvedVersion ? h(Pill, null, 'v' + item.resolvedVersion) : null, item.providerRef ? h(Pill, { tone: 'accent' }, 'AgentProvider') : null, item.clientExtension ? h(Pill, null, '界面扩展') : null),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '7px', marginTop: '14px' } },
            !item.installed ? h('button', { type: 'button', disabled: Boolean(busyKey), onClick: () => mutate(item, 'install'), style: buttonStyle() }, busyKey === `${item.ecosystem}:${item.pluginId || item.id}` ? '处理中…' : '安装') : null,
            item.installed && item.ecosystem === 'dsh' ? h('button', { type: 'button', disabled: Boolean(busyKey), onClick: () => mutate(item, item.enabled ? 'disable' : 'enable'), style: buttonStyle() }, item.enabled ? '停用' : '启用') : null,
            item.installed && item.ecosystem === 'dsh' ? h('button', { type: 'button', disabled: Boolean(busyKey), onClick: () => mutate(item, 'update'), style: buttonStyle() }, '更新') : null,
            item.installed ? h('button', { type: 'button', disabled: Boolean(busyKey), onClick: () => { if (window.confirm(`确定卸载 ${item.displayName || item.pluginId || item.id} 吗？`)) void mutate(item, 'uninstall'); }, style: { ...buttonStyle(), color: BRAND.danger } }, '卸载') : null,
          ),
        ))) : null,
        status === 'ready' ? h('button', { type: 'button', onClick: load, style: { ...buttonStyle(), marginTop: '16px' } }, '刷新目录') : null,
      );
    }

    function UnsupportedStudioPage({ title, detail }) {
      return h('div', null,
        h(ContentIntro, { detail, action: h(Pill, { tone: 'signal' }, 'Host API 未接入') }),
        h(EmptyState, { icon: '·', title: title + '暂未接入', detail: '这个入口保留在产品信息架构中，但当前版本不会用假数据模拟。接入对应 Host 合同后再开放操作。' }));
    }

    function RuntimeResourcesPage() {
      const [status, setStatus] = useState('loading');
      const [resources, setResources] = useState([]);
      const [workspace, setWorkspace] = useState(null);
      const [deployments, setDeployments] = useState([]);
      const [query, setQuery] = useState('');
      const [error, setError] = useState('');
      const load = async () => {
        setStatus('loading'); setError('');
        try {
          const [catalog, bootstrap, deploymentResult] = await Promise.all([
            hostRemote.resources({ limit: 200 }),
            hostRemote.bootstrap(),
            hostRemote.deployments(),
          ]);
          setResources(Array.isArray(catalog?.items) ? catalog.items : []);
          setWorkspace(bootstrap?.workspace || bootstrap || null);
          setDeployments(Array.isArray(deploymentResult?.items) ? deploymentResult.items : []);
          setStatus('ready');
        } catch (reason) { setStatus('error'); setError(reason?.message || '运行资源读取失败'); }
      };
      useEffect(() => { void load(); }, []);
      const normalized = query.trim().toLowerCase();
      const groups = [['model', '模型'], ['tool', 'Tool'], ['mcp', 'MCP Server'], ['skill', 'Skill']];
      const visible = resources.filter(item => !normalized || `${item.displayName || ''} ${item.name || ''} ${item.resourceId || ''}`.toLowerCase().includes(normalized));
      const readyCount = resources.filter(item => String(item.status || '').toLowerCase() === 'ready').length;
      const deploymentReady = deployments.filter(item => String(item.status || '').toUpperCase() === 'READY').length;
      return h('div', null,
        h(ContentIntro, { detail: '运行资源是当前 Host 可见的真实模型、Tool、MCP 和 Skill；状态来自 catalog，不在页面生成假数据。', action: h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, h(Pill, { tone: status === 'ready' ? 'accent' : 'signal' }, status === 'ready' ? 'Host 已连接' : status === 'loading' ? '读取中' : 'Host 待接入'), h('button', { type: 'button', onClick: () => void load(), style: buttonStyle() }, '刷新')) }),
        status === 'loading' ? h(EmptyState, { icon: '·', title: '正在读取运行资源', detail: '读取 Host catalog、工作区和部署回执。' }) : null,
        status === 'error' ? h(EmptyState, { icon: '!', title: '运行资源不可用', detail: error, action: h('button', { type: 'button', onClick: () => void load(), style: buttonStyle() }, '重新读取') }) : null,
        status === 'ready' ? h(React.Fragment, null,
          h('section', { style: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '10px', marginBottom: '14px' } },
            [['可见资源', resources.length], ['可用资源', readyCount], ['工作区', workspace?.path || workspace?.status || '已连接'], ['云端部署', deploymentReady ? `${deploymentReady} 已就绪` : '暂无就绪']].map(([label, value]) => h('div', { key: label, style: { border: '1px solid ' + BRAND.border, borderRadius: '12px', padding: '14px', background: BRAND.surface } }, h('div', { style: { color: BRAND.inkMuted, fontSize: '11px' } }, label), h('strong', { style: { display: 'block', marginTop: '6px', color: BRAND.ink, fontSize: '15px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, String(value))))),
          h('input', { type: 'search', value: query, onChange: event => setQuery(event.target.value), placeholder: '搜索运行资源', 'aria-label': '搜索运行资源', style: { ...inputStyle(), margin: '0 0 14px', maxWidth: '460px' } }),
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '12px' } }, groups.map(([kind, label]) => {
            const items = visible.filter(item => item.kind === kind).slice(0, 8);
            return h('section', { key: kind, style: { border: '1px solid ' + BRAND.border, borderRadius: '12px', background: BRAND.surface, overflow: 'hidden' } },
              h('div', { style: { display: 'flex', justifyContent: 'space-between', padding: '13px 14px', borderBottom: '1px solid ' + BRAND.border } }, h('strong', { style: { color: BRAND.ink, fontSize: '13px' } }, label), h('span', { style: { color: BRAND.inkMuted, fontSize: '11px' } }, `${visible.filter(item => item.kind === kind).length} 项`)),
              items.length ? h('div', { style: { display: 'grid' } }, items.map(item => h('div', { key: item.resourceId, style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '9px', padding: '10px 14px', borderBottom: '1px solid ' + BRAND.border } }, h('div', { style: { minWidth: 0 } }, h('strong', { style: { display: 'block', color: BRAND.ink, fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.displayName || item.name || item.resourceId), h('span', { style: { display: 'block', color: BRAND.inkMuted, fontSize: '10px', marginTop: '3px' } }, item.version || item.source || item.resourceId)), h(Pill, { tone: String(item.status || '').toLowerCase() === 'ready' ? 'accent' : 'signal' }, item.status || '未知')))) : h('div', { style: { padding: '20px 14px', color: BRAND.inkMuted, fontSize: '12px' } }, normalized ? '没有匹配资源。' : '暂无资源。'));
          }))
        ) : null);
    }

    function DeliveryPage() {
      const [agents, setAgents] = useState([]);
      const [deployments, setDeployments] = useState([]);
      const [operations, setOperations] = useState([]);
      const [selectedAgent, setSelectedAgent] = useState('');
      const [selectedBuild, setSelectedBuild] = useState('');
      const [region, setRegion] = useState('cn-beijing-6');
      const [environment, setEnvironment] = useState('production');
      const [status, setStatus] = useState('loading');
      const [saving, setSaving] = useState(false);
      const [error, setError] = useState('');
      const [message, setMessage] = useState('');

      const load = async (preferredAgent = selectedAgent) => {
        setStatus('loading');
        setError('');
        try {
          const [agentResult, deploymentResult, operationResult] = await Promise.all([
            hostRemote.agents(), hostRemote.deployments(), hostRemote.operations(),
          ]);
          const nextAgents = Array.isArray(agentResult?.items) ? agentResult.items : [];
          const nextAgent = preferredAgent && nextAgents.some(item => (item?.metadata?.id || item?.id) === preferredAgent)
            ? preferredAgent : (nextAgents[0]?.metadata?.id || nextAgents[0]?.id || '');
          setAgents(nextAgents);
          setSelectedAgent(nextAgent);
          setDeployments(Array.isArray(deploymentResult?.items) ? deploymentResult.items : []);
          setOperations(Array.isArray(operationResult?.items) ? operationResult.items : []);
          // The collection endpoint intentionally keeps list rows small and
          // does not include the revision/build history. Load the selected
          // agent detail before rendering Delivery; otherwise an agent with a
          // successful build is incorrectly shown as “0 个” and deployment
          // cannot be selected. This also gives the UI the same source of
          // truth as the build mutation route.
          const current = nextAgents.find(item => (item?.metadata?.id || item?.id) === nextAgent);
          const detail = nextAgent ? await hostRemote.agent(nextAgent) : null;
          const builds = Array.isArray(detail?.builds) ? detail.builds : (Array.isArray(current?.builds) ? current.builds : []);
          if (nextAgent && detail) {
            setAgents(nextAgents.map(item => (item?.metadata?.id || item?.id) === nextAgent ? { ...item, ...detail } : item));
          }
          const readyBuild = builds.find(item => String(item?.status || '').toUpperCase() === 'SUCCEEDED') || builds[0];
          setSelectedBuild(String(readyBuild?.id || ''));
          setStatus('ready');
        } catch (reason) {
          setStatus('error');
          setError(reason?.message || '构建与部署状态不可用');
        }
      };
      useEffect(() => { void load(); }, []);

      const currentAgent = agents.find(item => (item?.metadata?.id || item?.id) === selectedAgent);
      const builds = Array.isArray(currentAgent?.builds) ? currentAgent.builds : [];
      const readyBuilds = builds.filter(item => String(item?.status || '').toUpperCase() === 'SUCCEEDED');
      const idempotency = prefix => `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
      const chooseAgent = event => {
        const id = event.target.value;
        setSelectedAgent(id);
        setSelectedBuild('');
        const nextAgent = agents.find(item => (item?.metadata?.id || item?.id) === id);
        const knownBuilds = Array.isArray(nextAgent?.builds) ? nextAgent.builds : [];
        const knownReady = knownBuilds.find(item => String(item?.status || '').toUpperCase() === 'SUCCEEDED') || knownBuilds[0];
        if (knownReady) setSelectedBuild(String(knownReady.id || ''));
        // Agent list rows do not carry build history. Hydrate the newly
        // selected row so switching targets does not regress to an empty
        // deployment selector.
        void hostRemote.agent(id).then(detail => {
          const detailBuilds = Array.isArray(detail?.builds) ? detail.builds : [];
          setAgents(previous => previous.map(item => (item?.metadata?.id || item?.id) === id ? { ...item, ...detail } : item));
          const ready = detailBuilds.find(item => String(item?.status || '').toUpperCase() === 'SUCCEEDED') || detailBuilds[0];
          setSelectedBuild(String(ready?.id || ''));
        }).catch(() => { /* the selected agent remains usable for a new build */ });
      };
      const createBuild = async () => {
        if (!selectedAgent || saving) return;
        setSaving(true); setError(''); setMessage('');
        try {
          const detail = await hostRemote.agent(selectedAgent);
          const revision = Number(detail?.metadata?.revision || detail?.draft?.metadata?.revision || currentAgent?.metadata?.revision || 1);
          const result = await hostRemote.createBuild(selectedAgent, revision, idempotency('studio-build'));
          setMessage(`Build 已提交：${result?.buildId || result?.id || '等待异步完成'}`);
          await load(selectedAgent);
        } catch (reason) { setError(reason?.message || 'Build 提交失败'); }
        finally { setSaving(false); }
      };
      const createDeployment = async () => {
        if (!selectedBuild || saving) return;
        setSaving(true); setError(''); setMessage('');
        try {
          const result = await hostRemote.createDeployment(selectedBuild, {
            target: { region: region.trim(), environment: environment.trim() },
            binding: {},
            release_policy: { strategy: 'rolling', approval: 'none' },
          }, idempotency('studio-deploy'));
          setMessage(`部署已提交：${result?.operationId || result?.id || '等待异步完成'}`);
          await load(selectedAgent);
        } catch (reason) { setError(reason?.message || '部署提交失败'); }
        finally { setSaving(false); }
      };
      const cancel = async operationId => {
        try { await hostRemote.cancelOperation(operationId); await load(selectedAgent); }
        catch (reason) { setError(reason?.message || '取消操作失败'); }
      };
      const buildRows = builds.length ? builds.map(item => h('tr', { key: item.id, style: { borderBottom: '1px solid ' + BRAND.border } },
        h('td', { style: { padding: '10px 12px', color: BRAND.ink, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11px' } }, item.id || '—'),
        h('td', { style: { padding: '10px 12px', color: BRAND.inkMuted } }, item.revision ? `Revision ${item.revision}` : '—'),
        h('td', { style: { padding: '10px 12px' } }, h(Pill, { tone: String(item.status || '').toUpperCase() === 'SUCCEEDED' ? 'accent' : 'signal' }, item.status || 'UNKNOWN')))) : h('tr', null, h('td', { colSpan: 3, style: { padding: '18px 12px', color: BRAND.inkMuted } }, '当前 Agent 还没有 Build。'));
      return h('div', null,
        h(SectionHeading, { eyebrow: 'Studio domain / Delivery', title: '构建与部署', detail: 'Build 固化 Agent Revision；Deployment 只接受已成功的 Build，所有动作由本地 Host 通过异步 operation 承载。', action: h(Pill, { tone: status === 'ready' ? 'accent' : 'signal' }, status === 'ready' ? 'Host 已连接' : '读取中') }),
        status === 'loading' ? h(EmptyState, { icon: '·', title: '正在读取交付状态', detail: '读取 Agent、Build、Deployment 和 Operation。' }) : null,
        status === 'error' ? h(EmptyState, { icon: '!', title: '交付状态不可用', detail: error, action: h('button', { type: 'button', onClick: () => load(), style: buttonStyle() }, '重新读取') }) : null,
        status === 'ready' ? h(React.Fragment, null,
          h('section', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: '12px', alignItems: 'end', border: '1px solid ' + BRAND.border, borderRadius: '14px', padding: '16px', background: BRAND.surface } },
            h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '目标 Agent', h('select', { value: selectedAgent, onChange: chooseAgent, style: inputStyle() }, agents.map(item => { const id = item?.metadata?.id || item?.id; return h('option', { key: id, value: id }, `${item?.metadata?.name || item?.name || id} · ${id}`); }))),
            h('button', { type: 'button', onClick: createBuild, disabled: saving || !selectedAgent, style: { ...buttonStyle(), color: saving || !selectedAgent ? BRAND.inkMuted : 'var(--dsw-static-neutral-00, #fff)', background: saving || !selectedAgent ? BRAND.accentSoft : BRAND.primaryFill, borderColor: saving || !selectedAgent ? BRAND.border : 'transparent' } }, saving ? '提交中…' : '构建当前 Revision')),
          h('section', { style: { marginTop: '14px', border: '1px solid ' + BRAND.border, borderRadius: '14px', overflow: 'hidden', background: BRAND.surface } },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 16px', borderBottom: '1px solid ' + BRAND.border } }, h('strong', { style: { color: BRAND.ink, fontSize: '14px' } }, 'Build 历史'), h('span', { style: { color: BRAND.inkMuted, fontSize: '11px' } }, `${builds.length} 个`)),
            h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: '12px' } }, h('thead', null, h('tr', { style: { color: BRAND.inkMuted, textAlign: 'left', background: BRAND.canvas } }, ['Build', '版本', '状态'].map(label => h('th', { key: label, style: { padding: '10px 12px', fontWeight: 750 } }, label)))), h('tbody', null, buildRows))),
          h('section', { style: { marginTop: '14px', display: 'grid', gap: '12px', border: '1px solid ' + BRAND.border, borderRadius: '14px', padding: '16px', background: BRAND.surface } },
            h('div', { style: { color: BRAND.ink, fontWeight: 800, fontSize: '14px' } }, '部署已成功的 Build'),
            h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 1fr 1fr auto', gap: '9px', alignItems: 'end' } },
              h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, 'Build', h('select', { value: selectedBuild, onChange: event => setSelectedBuild(event.target.value), style: inputStyle() }, h('option', { value: '' }, readyBuilds.length ? '请选择 Build' : '暂无成功 Build'), readyBuilds.map(item => h('option', { key: item.id, value: item.id }, `${item.id} · Revision ${item.revision || '—'}`)))),
              h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '区域', h('input', { value: region, onChange: event => setRegion(event.target.value), style: inputStyle() })),
              h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '环境', h('input', { value: environment, onChange: event => setEnvironment(event.target.value), style: inputStyle() })),
              h('button', { type: 'button', onClick: createDeployment, disabled: saving || !selectedBuild, style: { ...buttonStyle(), color: saving || !selectedBuild ? BRAND.inkMuted : 'var(--dsw-static-neutral-00, #fff)', background: saving || !selectedBuild ? BRAND.accentSoft : BRAND.primaryFill, borderColor: saving || !selectedBuild ? BRAND.border : 'transparent' } }, '提交部署'))),
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '14px', marginTop: '14px' } },
            h('section', { style: { border: '1px solid ' + BRAND.border, borderRadius: '14px', padding: '16px', background: BRAND.surface } }, h('strong', { style: { color: BRAND.ink, fontSize: '14px' } }, '部署记录'), deployments.length ? h('div', { style: { display: 'grid', gap: '8px', marginTop: '12px' } }, deployments.slice(0, 8).map(item => h('div', { key: item.id, style: { display: 'flex', justifyContent: 'space-between', gap: '8px', color: BRAND.inkMuted, fontSize: '11px' } }, h('span', null, item.id || '—'), h(Pill, { tone: item.status === 'READY' ? 'accent' : 'signal' }, item.status || 'UNKNOWN')))) : h('p', { style: { color: BRAND.inkMuted, fontSize: '12px' } }, '暂无部署记录。')),
            h('section', { style: { border: '1px solid ' + BRAND.border, borderRadius: '14px', padding: '16px', background: BRAND.surface } }, h('strong', { style: { color: BRAND.ink, fontSize: '14px' } }, '异步操作'), operations.length ? h('div', { style: { display: 'grid', gap: '8px', marginTop: '12px' } }, operations.slice(0, 8).map(item => h('div', { key: item.id, style: { display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center', color: BRAND.inkMuted, fontSize: '11px' } }, h('span', null, `${item.kind || item.type || 'operation'} · ${item.status || 'UNKNOWN'}`), ['RUNNING', 'PENDING', 'ADMITTING', 'DEPLOYING'].includes(String(item.status || '').toUpperCase()) ? h('button', { type: 'button', onClick: () => cancel(item.id), style: { ...buttonStyle(), padding: '4px 7px', fontSize: '10px' } }, '取消') : null))) : h('p', { style: { color: BRAND.inkMuted, fontSize: '12px' } }, '暂无异步操作。'))),
          message ? h('div', { role: 'status', style: { marginTop: '12px', color: BRAND.accentStrong, fontSize: '12px' } }, message) : null,
          error ? h('div', { role: 'alert', style: { marginTop: '12px', color: BRAND.danger, fontSize: '12px' } }, error) : null,
        ) : null);
    }

    function ResourceWorkspace() {
      const [tab, setTab] = useState(() => {
        try {
          const value = window.localStorage.getItem('agentkit-studio:resource-tab');
          if (value) window.localStorage.removeItem('agentkit-studio:resource-tab');
          return value || 'models';
        } catch { return 'models'; }
      });
      return h('div', null,
        h(StudioSubnav, { value: tab, onChange: setTab, items: [{ id: 'models', label: '模型与工具' }, { id: 'marketplace', label: '插件市场' }, { id: 'runtime-resources', label: '运行资源' }] }),
        tab === 'models' ? h(ResourcesPage) : tab === 'marketplace' ? h(MarketplacePage) : h(RuntimeResourcesPage));
    }

    function scheduleLabel(task) {
      const schedule = task?.schedule || {};
      if (schedule.kind === 'cron') return `Cron · ${schedule.expression || '—'}`;
      if (schedule.kind === 'interval' || schedule.kind === 'every') {
        const seconds = Number(schedule.everySeconds || schedule.every_seconds || 0);
        if (seconds >= 86400 && seconds % 86400 === 0) return `每 ${seconds / 86400} 天`;
        if (seconds >= 3600 && seconds % 3600 === 0) return `每 ${seconds / 3600} 小时`;
        if (seconds >= 60 && seconds % 60 === 0) return `每 ${seconds / 60} 分钟`;
        return `每 ${seconds || '—'} 秒`;
      }
      if (schedule.kind === 'after') return `延迟 ${schedule.afterSeconds || schedule.after_seconds || '—'} 秒`;
      if (schedule.kind === 'daily') return `每天 ${schedule.time || '—'}`;
      if (schedule.kind === 'weekly') return `每周 ${schedule.time || '—'}`;
      if (schedule.kind === 'at') return schedule.scheduledAt ? `一次 · ${new Date(schedule.scheduledAt).toLocaleString()}` : '一次性任务';
      return schedule.at ? `一次 · ${new Date(schedule.at).toLocaleString()}` : '一次性任务';
    }

    function AutomationPage({ scheduleRemote }) {
      const [status, setStatus] = useState('loading');
      const [tasks, setTasks] = useState([]);
      const [nativeTasks, setNativeTasks] = useState([]);
      const [agents, setAgents] = useState([]);
      const [error, setError] = useState('');
      const [message, setMessage] = useState('');
      const [editorOpen, setEditorOpen] = useState(false);
      const [saving, setSaving] = useState(false);
      const [busyTask, setBusyTask] = useState('');
      const [historyTask, setHistoryTask] = useState('');
      const [history, setHistory] = useState([]);
      const [editingTask, setEditingTask] = useState(null);
      const [availability, setAvailability] = useState(null);
      const [section, setSection] = useState('tasks');
      const [viewMode, setViewMode] = useState('board');
      const [query, setQuery] = useState('');
      const [agentFilter, setAgentFilter] = useState('');
      const [historyRows, setHistoryRows] = useState([]);
      const [historyStatus, setHistoryStatus] = useState('idle');
      const [form, setForm] = useState({ agentId: '', displayName: '', prompt: '', kind: 'interval', everySeconds: '3600', expression: '0 9 * * 1-5', at: '' });

      const agentId = item => item?.metadata?.id || item?.id || '';
      const agentName = item => item?.metadata?.name || item?.name || agentId(item);
      const load = async () => {
        setStatus('loading'); setError('');
        try {
          const [scheduleResult, agentResult] = await Promise.all([hostRemote.schedules(), hostRemote.agents()]);
          const nextAgents = Array.isArray(agentResult?.items) ? agentResult.items : [];
          setAgents(nextAgents);
          setTasks(Array.isArray(scheduleResult?.items) ? scheduleResult.items : []);
          try {
            const records = scheduleRemote?.catalog ? await scheduleRemote.catalog() : [];
            setNativeTasks(Array.isArray(records) ? records : []);
          } catch {
            setNativeTasks([]);
          }
          setAvailability(scheduleResult?.availability || null);
          setStatus('ready');
          setForm(previous => ({ ...previous, agentId: previous.agentId || agentId(nextAgents[0]) }));
        } catch (reason) {
          setStatus('error'); setError(reason?.message || '自动化目录读取失败');
        }
      };
      useEffect(() => { void load(); }, []);
      useEffect(() => {
        if (section !== 'history' || status !== 'ready') return undefined;
        let cancelled = false;
        setHistoryStatus('loading');
        Promise.all(tasks.slice(0, 50).map(async task => {
          try {
            const result = await hostRemote.scheduleOccurrences(task.taskId, task?.target?.agentId);
            return (Array.isArray(result?.items) ? result.items : []).map(item => ({ ...item, taskName: task.displayName || task.taskId, taskId: task.taskId }));
          } catch { return []; }
        })).then(rows => {
          if (cancelled) return;
          setHistoryRows(rows.flat().sort((a, b) => new Date(b.completedAt || b.scheduledFor || 0) - new Date(a.completedAt || a.scheduledFor || 0)));
          setHistoryStatus('ready');
        }).catch(() => { if (!cancelled) setHistoryStatus('error'); });
        return () => { cancelled = true; };
      }, [section, status, tasks]);

      const save = async () => {
        if (!form.agentId || !form.displayName.trim() || !form.prompt.trim()) {
          setError('请选择 Agent，并填写任务名称和提示词。'); return;
        }
        const schedule = { kind: form.kind, timezone: 'Asia/Shanghai' };
        if (form.kind === 'interval') schedule.everySeconds = Math.max(60, Number(form.everySeconds) || 3600);
        if (form.kind === 'cron') schedule.expression = form.expression.trim();
        if (form.kind === 'once') schedule.at = new Date(form.at || Date.now() + 3600000).toISOString();
        setSaving(true); setError(''); setMessage('');
        try {
          const payload = { displayName: form.displayName.trim(), prompt: form.prompt.trim(), schedule, enabled: editingTask ? editingTask.enabled !== false : true, continuity: editingTask?.continuity || 'new_session' };
          if (editingTask) {
            await hostRemote.updateSchedule(form.agentId, editingTask.taskId, payload);
            setMessage('自动化已更新。');
          } else {
            await hostRemote.createSchedule(form.agentId, payload);
            setMessage('自动化已创建，Host 会按计划生成执行记录。');
          }
          setEditorOpen(false);
          setEditingTask(null);
          setForm(previous => ({ ...previous, displayName: '', prompt: '' }));
          await load();
        } catch (reason) { setError(reason?.message || '自动化创建失败'); }
        finally { setSaving(false); }
      };
      const startEdit = task => {
        const schedule = task?.schedule || {};
        const kind = schedule.kind === 'cron' || schedule.kind === 'once' ? schedule.kind : 'interval';
        setEditingTask(task);
        setForm({
          agentId: task?.target?.agentId || '',
          displayName: task?.displayName || '',
          prompt: task?.command?.payload?.content || '',
          kind,
          everySeconds: String(schedule.everySeconds || schedule.every_seconds || 3600),
          expression: String(schedule.expression || '0 9 * * 1-5'),
          at: schedule.at ? new Date(schedule.at).toISOString().slice(0, 16) : '',
        });
        setEditorOpen(true); setError(''); setMessage('');
      };
      const toggle = async task => {
        const targetAgent = task?.target?.agentId;
        if (!targetAgent || !task?.taskId) return;
        setBusyTask(task.taskId); setError(''); setMessage('');
        try {
          await hostRemote.updateSchedule(targetAgent, task.taskId, {
            displayName: task.displayName || task.taskId,
            prompt: task?.command?.payload?.content || '',
            schedule: task.schedule,
            enabled: task.enabled === false,
            continuity: task.continuity || 'new_session',
          });
          setMessage(task.enabled === false ? '自动化已启用。' : '自动化已暂停。');
          await load();
        } catch (reason) { setError(reason?.message || '更新自动化状态失败'); }
        finally { setBusyTask(''); }
      };
      const runNow = async task => {
        const targetAgent = task?.target?.agentId;
        if (!targetAgent || !task?.taskId) return;
        setBusyTask(task.taskId); setError(''); setMessage('');
        try {
          await hostRemote.runSchedule(targetAgent, task.taskId);
          setMessage(`已提交立即运行：${task.displayName || task.taskId}`);
          await load();
        } catch (reason) { setError(reason?.message || '立即运行失败'); }
        finally { setBusyTask(''); }
      };
      const remove = async task => {
        const targetAgent = task?.target?.agentId;
        if (!targetAgent || !task?.taskId) return;
        if (typeof window !== 'undefined' && !window.confirm(`删除自动化“${task.displayName || task.taskId}”？`)) return;
        setBusyTask(task.taskId); setError('');
        try { await hostRemote.deleteSchedule(targetAgent, task.taskId); setMessage('自动化已删除。'); await load(); }
        catch (reason) { setError(reason?.message || '自动化删除失败'); }
        finally { setBusyTask(''); }
      };
      const showHistory = async task => {
        if (historyTask === task.taskId) { setHistoryTask(''); setHistory([]); return; }
        setHistoryTask(task.taskId); setHistory([]); setError('');
        try {
          const result = await hostRemote.scheduleOccurrences(task.taskId, task?.target?.agentId);
          setHistory(Array.isArray(result?.items) ? result.items : []);
        } catch (reason) { setError(reason?.message || '执行记录读取失败'); }
      };
      const visibleTasks = tasks.filter(task => {
        const name = String(task?.displayName || task?.taskId || '').toLowerCase();
        const prompt = String(task?.command?.payload?.content || '').toLowerCase();
        const agent = String(task?.target?.agentId || '').toLowerCase();
        const needle = query.trim().toLowerCase();
        return (!needle || name.includes(needle) || prompt.includes(needle) || agent.includes(needle))
          && (!agentFilter || agent === agentFilter.toLowerCase());
      });
      const taskStatus = task => task.enabled === false ? 'paused' : 'scheduled';
      const taskGroups = [
        { id: 'scheduled', label: '待执行' },
        { id: 'paused', label: '已暂停 / 已结束' },
      ];
      const openTemplate = kind => {
        const templates = {
          daily: { displayName: '每日工作摘要', prompt: '整理今天工作区中的变更并给出摘要', kind: 'cron', expression: '0 10 * * 1-5' },
          interval: { displayName: '定期服务巡检', prompt: '检查服务状态，发现异常时给出原因和处理建议', kind: 'interval', everySeconds: '1800' },
          weekly: { displayName: '每周总结', prompt: '总结本周工作区中的重要进展、风险和待办', kind: 'cron', expression: '0 17 * * 5' },
        };
        setEditingTask(null);
        setForm(previous => ({ ...previous, ...templates[kind] }));
        setEditorOpen(true); setError(''); setMessage('');
      };
      const taskCard = task => {
        const target = agents.find(item => agentId(item) === task?.target?.agentId);
        const active = historyTask === task.taskId;
        return h('section', { key: task.taskId, style: { border: '1px solid ' + BRAND.border, borderRadius: '14px', padding: '15px 16px', background: BRAND.surface, minWidth: 0 } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '16px', alignItems: 'flex-start' } },
            h('div', { style: { minWidth: 0 } }, h('strong', { style: { color: BRAND.ink, fontSize: '14px' } }, task.displayName || task.taskId), h('div', { style: { color: BRAND.inkMuted, fontSize: '11px', marginTop: '5px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `${target ? agentName(target) : task?.target?.agentId || '目标 Agent'} · ${scheduleLabel(task)}`)),
            h(Pill, { tone: task.enabled ? 'accent' : 'signal' }, task.enabled ? '已启用' : '已暂停')),
          h('p', { style: { color: BRAND.inkMuted, fontSize: '12px', margin: '12px 0 0', whiteSpace: 'pre-wrap', minHeight: '36px' } }, task?.command?.payload?.content || '—'),
          h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center', marginTop: '12px', color: BRAND.inkMuted, fontSize: '11px', flexWrap: 'wrap' } }, h('span', null, task.enabled && task.nextRunAt ? `下次执行：${new Date(task.nextRunAt).toLocaleString()}` : '未安排下一次执行'), h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, h('button', { type: 'button', onClick: () => void showHistory(task), style: { ...buttonStyle(), background: BRAND.surface } }, active ? '收起记录' : '执行记录'), h('button', { type: 'button', onClick: () => startEdit(task), style: { ...buttonStyle(), background: BRAND.surface } }, '编辑'), h('button', { type: 'button', onClick: () => void toggle(task), disabled: busyTask === task.taskId, style: { ...buttonStyle(), background: BRAND.surface } }, task.enabled === false ? '启用' : '暂停'), h('button', { type: 'button', onClick: () => void runNow(task), disabled: busyTask === task.taskId || task.enabled === false, style: { ...buttonStyle(), background: BRAND.primaryFill, color: 'var(--dsw-static-neutral-00, #fff)' } }, busyTask === task.taskId ? '提交中…' : '立即运行'), h('button', { type: 'button', onClick: () => void remove(task), disabled: busyTask === task.taskId, style: { ...buttonStyle(), background: BRAND.surface, color: BRAND.danger } }, '删除'))),
          active ? h('div', { style: { marginTop: '12px', paddingTop: '12px', borderTop: '1px solid ' + BRAND.border } }, history.length ? history.slice(0, 8).map(item => h('div', { key: item.occurrenceId, style: { display: 'flex', justifyContent: 'space-between', gap: '12px', color: BRAND.inkMuted, fontSize: '11px', padding: '4px 0' } }, h('span', null, item.state || 'unknown'), h('span', null, item.completedAt ? new Date(item.completedAt).toLocaleString() : item.scheduledFor ? new Date(item.scheduledFor).toLocaleString() : '—'))) : h('span', { style: { color: BRAND.inkMuted, fontSize: '11px' } }, '暂无执行记录。')) : null);
      };

      return h('div', null,
        h(SectionHeading, { eyebrow: 'Studio domain / Automation', title: '自动化', detail: '把一次性、间隔或 Cron 计划绑定到已构建的 Agent；创建和执行由 Host Scheduler 负责，结果回到会话与执行记录。', action: h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, h(Pill, { tone: availability?.triggerActive ? 'accent' : 'neutral' }, availability?.triggerActive ? '调度运行中' : '调度待就绪'), h('button', { type: 'button', onClick: () => { setEditingTask(null); setEditorOpen(true); setMessage(''); }, style: buttonStyle() }, '新建自动化'), h('button', { type: 'button', onClick: () => void load(), style: { ...buttonStyle(), background: BRAND.surface } }, '刷新')) }),
        status === 'loading' ? h(EmptyState, { icon: '·', title: '正在读取自动化', detail: '读取计划、可用 Agent 和调度器状态。' }) : null,
        status === 'error' ? h(EmptyState, { icon: '!', title: '自动化不可用', detail: error, action: h('button', { type: 'button', onClick: () => void load(), style: buttonStyle() }, '重新读取') }) : null,
        status === 'ready' ? h(React.Fragment, null,
          editorOpen ? h('section', { style: { border: '1px solid ' + BRAND.border, borderRadius: '14px', padding: '16px', background: BRAND.surface, marginBottom: '14px' } },
            h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '12px' } },
              h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '绑定 Agent', h('select', { value: form.agentId, onChange: event => setForm(previous => ({ ...previous, agentId: event.target.value })), style: inputStyle() }, agents.map(item => h('option', { key: agentId(item), value: agentId(item) }, `${agentName(item)} · ${agentId(item)}`)))),
              h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '任务名称', h('input', { value: form.displayName, onChange: event => setForm(previous => ({ ...previous, displayName: event.target.value })), placeholder: '例如：每日工作摘要', style: inputStyle() }))),
            h('label', { style: { display: 'block', marginTop: '12px', color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '到期时发送给 Agent 的提示词', h('textarea', { value: form.prompt, onChange: event => setForm(previous => ({ ...previous, prompt: event.target.value })), rows: 3, placeholder: '例如：整理今天工作区中的变更并给出摘要', style: { ...inputStyle(), resize: 'vertical' } })),
            h('div', { style: { display: 'grid', gridTemplateColumns: '180px minmax(0, 1fr)', gap: '12px', marginTop: '12px', alignItems: 'end' } },
              h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '触发方式', h('select', { value: form.kind, onChange: event => setForm(previous => ({ ...previous, kind: event.target.value })), style: inputStyle() }, h('option', { value: 'interval' }, '固定间隔'), h('option', { value: 'cron' }, 'Cron'), h('option', { value: 'once' }, '执行一次'))),
              form.kind === 'interval' ? h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '间隔秒数（最少 60）', h('input', { type: 'number', min: 60, value: form.everySeconds, onChange: event => setForm(previous => ({ ...previous, everySeconds: event.target.value })), style: inputStyle() })) : null,
              form.kind === 'cron' ? h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '五段 Cron（Asia/Shanghai）', h('input', { value: form.expression, onChange: event => setForm(previous => ({ ...previous, expression: event.target.value })), style: inputStyle() })) : null,
              form.kind === 'once' ? h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '执行时间', h('input', { type: 'datetime-local', value: form.at, onChange: event => setForm(previous => ({ ...previous, at: event.target.value })), style: inputStyle() })) : null),
            h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' } }, h('button', { type: 'button', onClick: () => setEditorOpen(false), style: { ...buttonStyle(), background: BRAND.surface } }, '取消'), h('button', { type: 'button', onClick: () => void save(), disabled: saving || !agents.length, style: { ...buttonStyle(), color: saving || !agents.length ? BRAND.inkMuted : 'var(--dsw-static-neutral-00, #fff)', background: saving || !agents.length ? BRAND.accentSoft : BRAND.primaryFill, borderColor: saving || !agents.length ? BRAND.border : 'transparent' } }, saving ? '保存中…' : '创建')),
          ) : null,
          h('section', { style: { display: 'grid', gap: '12px', marginBottom: '14px', border: '1px solid ' + BRAND.border, borderRadius: '14px', padding: '14px 16px', background: BRAND.surface } },
            h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' } },
              h('div', { style: { display: 'flex', gap: '6px' } }, h('button', { type: 'button', onClick: () => setSection('tasks'), style: { ...buttonStyle(), background: section === 'tasks' ? BRAND.accentSoft : BRAND.surface } }, `全部任务 ${tasks.length}`), h('button', { type: 'button', onClick: () => setSection('history'), style: { ...buttonStyle(), background: section === 'history' ? BRAND.accentSoft : BRAND.surface } }, '执行记录')),
              h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } }, h('input', { value: query, onChange: event => setQuery(event.target.value), placeholder: '搜索任务或提示词', 'aria-label': '搜索自动化', style: { ...inputStyle(), width: '180px' } }), h('select', { value: agentFilter, onChange: event => setAgentFilter(event.target.value), 'aria-label': '按 Agent 筛选', style: { ...inputStyle(), width: '170px' } }, h('option', { value: '' }, '全部 Agent'), agents.map(item => h('option', { key: agentId(item), value: agentId(item) }, agentName(item)))), section === 'tasks' ? h('button', { type: 'button', onClick: () => setViewMode(viewMode === 'board' ? 'list' : 'board'), style: { ...buttonStyle(), background: BRAND.surface } }, viewMode === 'board' ? '列表视图' : '看板视图') : null)),
            section === 'tasks' ? h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', color: BRAND.inkMuted, fontSize: '11px' } }, h('span', null, '从常用任务开始：'), h('button', { type: 'button', onClick: () => openTemplate('daily'), style: { ...buttonStyle(), background: BRAND.surface } }, '每日简报 · 工作日 10:00'), h('button', { type: 'button', onClick: () => openTemplate('interval'), style: { ...buttonStyle(), background: BRAND.surface } }, '定期巡检 · 每 30 分钟'), h('button', { type: 'button', onClick: () => openTemplate('weekly'), style: { ...buttonStyle(), background: BRAND.surface } }, '每周总结 · 周五 17:00')) : null),

          h('section', { style: { display: 'grid', gap: '10px', marginBottom: '14px', border: '1px solid ' + BRAND.border, borderRadius: '14px', padding: '14px 16px', background: BRAND.surface } },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '12px', flexWrap: 'wrap' } },
              h('strong', { style: { color: BRAND.ink, fontSize: '14px' } }, `DSH 原生会话自动化 ${nativeTasks.length}`),
              h('span', { style: { color: BRAND.inkMuted, fontSize: '11px' } }, '由对话中的 schedule_create 创建；与 Host Agent 自动化分开存储')),
            nativeTasks.length ? nativeTasks.map(task => h('div', { key: `${task.sessionId}-${task.id}`, style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 150px 120px', gap: '12px', alignItems: 'center', border: '1px solid ' + BRAND.border, borderRadius: '10px', padding: '10px 12px' } },
              h('div', null, h('strong', { style: { color: BRAND.ink, fontSize: '12px' } }, task.title || '未命名任务'), h('div', { style: { color: BRAND.inkMuted, fontSize: '11px', marginTop: '3px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, task.prompt || '—')),
              h('span', { style: { color: BRAND.inkMuted, fontSize: '11px' } }, scheduleLabel({ schedule: task })),
              h(Pill, { tone: task.status === 'active' ? 'accent' : 'neutral' }, task.status === 'active' ? '已启用' : '已结束'))) :
              h('div', { style: { border: '1px dashed ' + BRAND.border, borderRadius: '10px', padding: '13px 14px', color: BRAND.inkMuted, fontSize: '12px', lineHeight: 1.6 } },
                h('strong', { style: { display: 'block', color: BRAND.ink, fontSize: '12px', marginBottom: '4px' } }, '当前会话还没有 DSH 原生自动化'),
                h('span', null, '在新会话中直接说“每天 9 点提醒我整理工作摘要”，DSH 会调用 schedule_create；创建后刷新本页即可看到任务。'))),
          section === 'history' ? (historyStatus === 'loading' ? h(EmptyState, { icon: '·', title: '正在读取执行记录', detail: '按任务读取 Host Scheduler 的 occurrence 历史。' }) : !historyRows.length ? h(EmptyState, { icon: '◷', title: '暂无执行记录', detail: visibleTasks.length ? '任务尚未执行，或调整筛选条件。' : '调整搜索或 Agent 筛选条件。' }) : h('div', { style: { display: 'grid', gap: '8px' } }, historyRows.filter(item => visibleTasks.some(task => task.taskId === item.taskId)).slice(0, 100).map(item => h('div', { key: item.occurrenceId || `${item.taskId}-${item.scheduledFor}`, style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 130px 170px', gap: '12px', alignItems: 'center', border: '1px solid ' + BRAND.border, borderRadius: '10px', padding: '10px 12px', background: BRAND.surface, color: BRAND.inkMuted, fontSize: '11px' } }, h('div', null, h('strong', { style: { color: BRAND.ink, fontSize: '12px' } }, item.taskName), h('div', { style: { marginTop: '3px' } }, item.occurrenceId || '—')), h(Pill, { tone: item.state === 'completed' || item.state === 'succeeded' ? 'accent' : item.state === 'failed' ? 'signal' : 'neutral' }, item.state || 'unknown'), h('span', null, item.completedAt ? new Date(item.completedAt).toLocaleString() : item.scheduledFor ? new Date(item.scheduledFor).toLocaleString() : '—'))))) : (!visibleTasks.length ? h(EmptyState, { icon: '◷', title: tasks.length ? '没有匹配的自动化' : '还没有自动化', detail: tasks.length ? '调整搜索或 Agent 筛选条件。' : agents.length ? '可以在这里创建计划。计划会绑定到 Agent 的当前 Build；也可以先用上面的常用任务模板。' : '先创建并构建一个 Agent，自动化才有可执行目标。' }) : viewMode === 'list' ? h('div', { style: { display: 'grid', gap: '10px' } }, visibleTasks.map(taskCard)) : h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '12px' } }, taskGroups.map(group => {
            const items = visibleTasks.filter(task => taskStatus(task) === group.id);
            return h('section', { key: group.id, style: { display: 'grid', alignContent: 'start', gap: '10px', minWidth: 0 } }, h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 2px', color: BRAND.inkMuted, fontSize: '12px', fontWeight: 750 } }, h('span', null, group.label), h('span', null, String(items.length))), items.length ? items.map(taskCard) : h('div', { style: { border: '1px dashed ' + BRAND.border, borderRadius: '12px', padding: '18px', color: BRAND.inkMuted, fontSize: '12px', textAlign: 'center' } }, group.id === 'scheduled' ? '新建任务，安排下一次执行' : '暂无任务'));
          }))),
          message ? h('div', { role: 'status', style: { marginTop: '12px', color: BRAND.accentStrong, fontSize: '12px' } }, message) : null,
          error ? h('div', { role: 'alert', style: { marginTop: '12px', color: BRAND.danger, fontSize: '12px' } }, error) : null,
        ) : null);
    }

    function OperationsWorkspace({ scheduleRemote }) {
      const [tab, setTab] = useState('delivery');
      return h('div', null,
        h(StudioSubnav, { value: tab, onChange: setTab, items: [{ id: 'delivery', label: '构建与部署' }, { id: 'automation', label: '自动化' }, { id: 'evaluation', label: '评测' }, { id: 'observability', label: '观测' }, { id: 'channels', label: 'Channels' }] }),
        tab === 'delivery' ? h(DeliveryPage) : tab === 'automation' ? h(AutomationPage, { scheduleRemote }) : h(OperationalPage, { page: tab }));
    }

    function OperationalPage({ page }) {
      const [status, setStatus] = useState('loading');
      const [data, setData] = useState(null);
      const [error, setError] = useState('');
      const definitions = {
        evaluation: {
          title: '评测', note: '数据集与回归', icon: '✓',
          detail: '评测目标、数据集和运行记录由 KsADK Host 统一管理。',
          load: async () => hostRemote.evaluationTargets(),
          summarize: result => [
            ['构建目标', result?.builds?.length || 0, '可作为评测 target'],
            ['评测集', result?.evalsets?.length || 0, '本地已导入数据集'],
          ],
        },
        observability: {
          title: '观测', note: '运行与追踪', icon: '◌',
          detail: '运行事件通过 Host 写入本地 trace store，Studio 只展示聚合结果。',
          load: async () => hostRemote.tracesOverview(),
          summarize: result => [
            ['运行次数', result?.total || 0, '最近 24 小时'],
            ['已完成', result?.completed || 0, result?.successRate == null ? '暂无成功率' : `成功率 ${Math.round(result.successRate * 100)}%`],
            ['Token 用量', result?.totalTokens || 0, '输入与输出合计'],
          ],
        },
        channels: {
          title: 'Channels', note: '渠道连接', icon: '⌘',
          detail: 'Channel Connector 连接由 Host 管理，凭证与 Agent 绑定不进入 DSH 会话状态。',
          load: async () => hostRemote.channelConnection(),
          summarize: result => [
            ['连接状态', result?.configured ? '已配置' : '未配置', result?.serverUrl || '等待 Channel Gateway'],
            ['绑定 Agent', Array.isArray(result?.agents) ? result.agents.length : 0, '按 Agent 维护渠道映射'],
            ['账号', result?.accountId || '—', 'Host 当前工作区'],
          ],
        },
      }[page];

      const load = async () => {
        setStatus('loading');
        setError('');
        try {
          setData(await definitions.load());
          setStatus('ready');
        } catch (reason) {
          setError(reason?.message || 'Host 尚未连接');
          setStatus('error');
        }
      };
      useEffect(() => { load(); }, [page]);

      if (!definitions) return null;
      const cards = status === 'ready' ? definitions.summarize(data).map(([label, value, detail]) => h(Metric, { key: label, label, value: String(value), detail, tone: value === '未配置' ? 'signal' : 'neutral' })) : null;
      return h('div', null,
        h(SectionHeading, { eyebrow: 'Studio domain', title: definitions.title, detail: definitions.detail, action: h(Pill, { tone: status === 'ready' ? 'accent' : 'signal' }, status === 'ready' ? 'Host 已连接' : 'Host 待接入') }),
        status === 'loading' ? h(EmptyState, { icon: '·', title: '正在读取 Host', detail: '读取真实的 ' + definitions.title + ' 状态。' }) : null,
        status === 'error' ? h(EmptyState, { icon: '!', title: definitions.title + '暂不可用', detail: error, action: h('button', { type: 'button', onClick: load, style: buttonStyle() }, '重新连接') }) : null,
        status === 'ready' ? h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px' } }, cards) : null,
        status === 'ready' ? h('section', { style: { marginTop: '16px', border: '1px solid ' + BRAND.border, borderRadius: '14px', padding: '18px', background: BRAND.surface } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' } },
            h('strong', { style: { color: BRAND.ink, fontSize: '14px' } }, 'Host 数据源'),
            h('button', { type: 'button', onClick: load, style: buttonStyle() }, '刷新')),
          h('div', { style: { color: BRAND.inkMuted, fontSize: '12px', lineHeight: 1.6 } },
            page === 'evaluation' ? '评测执行器已在 Host 注册，当前工作区还没有构建目标或评测集。' : page === 'observability' ? '观测存储已接入；首次运行 Agent 后会在这里看到 trace 和 token 汇总。' : 'Channel Connector API 已接入；配置 Gateway 后可继续绑定具体 Agent。')) : null);
    }

    function HostStatusPill() {
      const [status, setStatus] = useState('loading');
      useEffect(() => {
        let alive = true;
        const probe = async () => {
          try {
            const result = await hostRemote.health();
            if (alive && result?.status === 'ok') { setStatus('ready'); return; }
          } catch { /* The session exchange can race on the first panel mount. */ }
          try {
            const result = await hostRemote.bootstrap();
            if (alive) setStatus(result?.workspaceReady === false ? 'error' : 'ready');
          } catch {
            if (alive) setStatus('error');
          }
        };
        void probe();
        return () => { alive = false; };
      }, []);
      return h(Pill, { tone: status === 'ready' ? 'accent' : 'signal' }, status === 'ready' ? 'Host 已连接' : status === 'loading' ? '读取 Host' : 'Host 待接入');
    }

    /**
     * DSH's document title is selected at build time, so the plugin cannot
     * replace it through a slot. Keep the browser chrome product-owned while
     * preserving the current session title. This observes only the public
     * title element and is disposed with the plugin context.
     */
    function productDocument() {
      if (typeof document === 'undefined') return null;
      // DSH Web mounts global panels in a same-origin srcdoc frame. Browser
      // chrome belongs to the top-level document, so brand that document when
      // the embedding boundary permits it and otherwise stay frame-local.
      try {
        const parentDocument = window.parent && window.parent !== window ? window.parent.document : null;
        return parentDocument || document;
      } catch { return document; }
    }

    function adoptProductDocumentTitle() {
      const ownerDocument = productDocument();
      if (!ownerDocument) return () => {};
      const project = () => {
        const current = String(ownerDocument.title || '').trim();
        const base = current.split(' — ')[0].trim();
        const isDshBuildTitle = base.startsWith('DSH') || base === 'DeepSeek Harness';
        const next = base === 'AgentKit Studio'
          ? 'AgentKit Studio'
          : base && !isDshBuildTitle
            ? `${base} — AgentKit Studio`
            : 'AgentKit Studio';
        // Writing even an unchanged title queues another MutationObserver
        // callback and can keep the browser on the plugin boot screen forever.
        if (ownerDocument.title !== next) ownerDocument.title = next;
      };
      project();
      const title = ownerDocument.querySelector('title');
      if (!title || typeof MutationObserver === 'undefined') return () => {};
      const observer = new MutationObserver(project);
      observer.observe(title, { childList: true, characterData: true, subtree: true });
      return () => observer.disconnect();
    }

    // Keep the embedded document aligned with the Studio brand. The public
    // webserver index injection in index.mjs handles the top-level document;
    // this path is the fallback for hosts that only expose the panel realm.
    function adoptProductDocumentBrand() {
      const ownerDocument = productDocument();
      if (!ownerDocument) return () => {};
      const mark = encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="29" fill="#f7ffff" stroke="#0aa6a6" stroke-width="2"/><path d="M32 6 7 54h11l5-10h18l5 10h11L32 6Zm0 18 5 10H27l5-10Z" fill="#0aa6a6"/></svg>');
      const href = `data:image/svg+xml,${mark}`;
      const existing = Array.from(ownerDocument.querySelectorAll('link[rel~="icon"]'));
      const links = existing.length ? existing : [ownerDocument.createElement('link')];
      const previous = links.map(link => ({ link, rel: link.rel, type: link.type, href: link.href }));
      links.forEach(link => { link.rel = 'icon'; link.type = 'image/svg+xml'; link.href = href; if (!link.isConnected) ownerDocument.head.append(link); });
      return () => previous.forEach(({ link, rel, type, href: previousHref }) => { link.rel = rel; link.type = type; link.href = previousHref; });
    }

    function StudioShell({ scheduleRemote, page = 'overview', onNavigate }) {
      const activeNav = PANELS.find(item => item.page === page) || PANELS[0];
      return h('div', {
        'data-agentkit-studio': 'application-shell',
        style: { minHeight: '100%', background: BRAND.canvas, color: BRAND.ink, fontFamily: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
      },
      h('main', { style: { minWidth: 0, padding: '24px 28px 30px', overflow: 'auto' } },
        h('header', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '20px', marginBottom: '24px' } },
          h('div', null,
            h('div', { style: { color: BRAND.accentStrong, fontSize: '11px', fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase' } }, 'AgentKit Studio'),
            h('h1', { style: { color: BRAND.ink, margin: '6px 0 5px', fontSize: '25px', letterSpacing: '-0.035em' } }, activeNav.label),
            h('p', { style: { color: BRAND.inkMuted, margin: 0, fontSize: '13px' } }, activeNav.note)),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '9px' } }, h(Pill, { tone: 'neutral' }, 'Local'), h(HostStatusPill)))),
        page === 'overview' ? h(OverviewPage, { onNavigate }) : page === 'agents' ? h(AgentWorkspace, { onNavigate }) : page === 'resource-hub' ? h(ResourceWorkspace) : page === 'operations' ? h(OperationsWorkspace, { scheduleRemote }) : h(DomainPage, { page }));
    }

    function StudioPanelIcon({ size, active, glyph, panelId }) {
      const paths = {
        'studio-overview': h('path', { d: 'M5 11 12 5l7 6v7h-5v-5h-4v5H5v-7Z', fill: 'none', stroke: 'currentColor', strokeWidth: '1.7', strokeLinejoin: 'round' }),
        'studio-agents': h('path', { d: 'm12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Zm5.5 12.5.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z', fill: 'none', stroke: 'currentColor', strokeWidth: '1.5', strokeLinejoin: 'round' }),
        'studio-resources': h('path', { d: 'm12 3 8 8-8 8-8-8 8-8Zm0 5 3 3-3 3-3-3 3-3Z', fill: 'none', stroke: 'currentColor', strokeWidth: '1.6', strokeLinejoin: 'round' }),
        'studio-operations': h('path', { d: 'M5 19 19 5m0 0h-7m7 0v7', fill: 'none', stroke: 'currentColor', strokeWidth: '1.8', strokeLinecap: 'round', strokeLinejoin: 'round' }),
      };
      return h('span', {
        'aria-hidden': 'true',
        'data-studio-panel-id': panelId || undefined,
        style: { display: 'inline-grid', placeItems: 'center', width: String(size) + 'px', height: String(size) + 'px', borderRadius: '5px', color: active ? BRAND.accentStrong : 'currentColor', background: active ? BRAND.accentSoft : 'transparent', fontSize: size >= 18 ? '16px' : '14px', fontWeight: 700 },
      }, h('svg', { width: Math.max(14, Number(size || 18) - 1), height: Math.max(14, Number(size || 18) - 1), viewBox: '0 0 24 24', fill: 'none' }, paths[panelId] || h('path', { d: 'M5 12h14', stroke: 'currentColor', strokeWidth: '1.7', strokeLinecap: 'round' })));
    }

    function SettingsRow({ label, value, detail, tone = 'neutral' }) {
      return h('div', {
        style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '18px', padding: '14px 0', borderBottom: '1px solid ' + BRAND.border },
      },
      h('div', null,
        h('div', { style: { color: BRAND.ink, fontSize: '13px', fontWeight: 700 } }, label),
        h('div', { style: { color: BRAND.inkMuted, fontSize: '12px', marginTop: '4px', lineHeight: 1.45 } }, detail)),
      h(Pill, { tone }, value));
    }

    const MODEL_CREDENTIAL_NAMES = ['AGENTKIT_MODEL_API_KEY', 'OPENAI_API_KEY'];
    const DEFAULT_KSYUN_BASE_URL = 'http://kspmas.ksyun.com/v1';
    const DEFAULT_KSYUN_MODEL = 'deepseek-v4.1-flash';
    const DSH_MODEL_SETTINGS_NS = 'llm-pi-ai';
    const DSH_DEFAULT_MODEL_SETTINGS_NS = 'agent-default-model';
    const DSH_MODEL_ROUTE = 'agentkit-studio';
    const DSH_MODEL_CREDENTIAL = 'AGENTKIT_MODEL_API_KEY';

    /**
     * Bridge Studio's product form to the DSH model contract. KsADK remains
     * the source for Studio defaults and cloud credentials, but DSH chat only
     * sees providers registered through its own settings/credentials Remotes.
     * Keeping this bridge on the public Remote surface avoids a second model
     * catalog or a browser-owned chat implementation.
     */
    function createDshModelBridge(ctx) {
      const describe = async () => {
        const response = await ctx.remote.settings.describe();
        if (!response?.ok) throw new Error(response?.error?.message || 'DSH 模型配置不可用');
        return response.value;
      };
      return {
        describe,
        apply: async ({ provider, baseUrl, modelName, apiKey }) => {
          const document = await describe();
          const namespace = (document.namespaces || []).find(item => item.ns === DSH_MODEL_SETTINGS_NS);
          const existing = namespace?.user?.providers?.[DSH_MODEL_ROUTE]
            || namespace?.value?.providers?.[DSH_MODEL_ROUTE]
            || {};
          const normalizedProvider = String(provider || 'ksyun').trim() || 'ksyun';
          const normalizedModel = String(modelName || '').trim();
          const normalizedBaseUrl = String(baseUrl || '').trim()
            || (normalizedProvider === 'ksyun' ? DEFAULT_KSYUN_BASE_URL : '');
          if (!normalizedModel || !normalizedBaseUrl) {
            throw new Error('请填写模型名称；自定义提供商才需要填写 API 地址');
          }
          const profile = {
            ...existing,
            displayName: 'AgentKit Studio',
            api: 'openai-completions',
            apiKeyEnv: DSH_MODEL_CREDENTIAL,
            baseURL: normalizedBaseUrl,
            models: [{
              id: normalizedModel,
              name: normalizedModel,
              contextWindow: 262144,
              maxTokens: 32768,
            }],
          };
          const normalizedKey = String(apiKey || '').trim();
          const response = await ctx.remote.settings.mutate(
            DSH_MODEL_SETTINGS_NS,
            [{ op: 'set', path: ['providers', DSH_MODEL_ROUTE], value: profile }],
            namespace?.revision,
          );
          if (!response?.ok) throw new Error(response?.error?.message || 'DSH 模型配置保存失败');
          const defaultNamespace = (await describe()).namespaces?.find(item => item.ns === DSH_DEFAULT_MODEL_SETTINGS_NS);
          if (!defaultNamespace) throw new Error('DSH 默认模型设置不可用，无法让新会话使用该模型');
          const defaultResponse = await ctx.remote.settings.mutate(
            DSH_DEFAULT_MODEL_SETTINGS_NS,
            [
              { op: 'set', path: ['provider'], value: DSH_MODEL_ROUTE },
              { op: 'set', path: ['model'], value: normalizedModel },
            ],
            defaultNamespace.revision,
          );
          if (!defaultResponse?.ok) throw new Error(defaultResponse?.error?.message || 'DSH 默认模型保存失败');
          if (normalizedKey) {
            const stored = await ctx.remote.credentials.set(DSH_MODEL_CREDENTIAL, normalizedKey);
            if (!stored?.ok) throw new Error(stored?.error?.message || 'DSH 模型凭证保存失败');
          }
          return { provider, route: DSH_MODEL_ROUTE, model: normalizedModel };
        },
        credentialStatus: async () => {
          const response = await ctx.remote.credentials.describe([DSH_MODEL_CREDENTIAL]);
          if (!response?.ok) throw new Error(response?.error?.message || 'DSH 模型凭证不可用');
          return response.value?.[DSH_MODEL_CREDENTIAL] || { configured: false };
        },
      };
    }

    function ModelSettingsSection({ dshModel }) {
      const [form, setForm] = useState({
        provider: 'ksyun', baseUrl: DEFAULT_KSYUN_BASE_URL, modelName: DEFAULT_KSYUN_MODEL, apiKey: '',
        cloudAccessKey: '', cloudSecretKey: '', cloudAccountId: '', cloudRegion: '',
        cloudServerUrl: '', cloudBucket: '',
      });
      const [modelStatus, setModelStatus] = useState({ configured: false, source: 'missing' });
      const [cloudStatus, setCloudStatus] = useState({ configured: false, source: 'missing' });
      const [dshStatus, setDshStatus] = useState({ configured: false, model: '', credentialConfigured: false });
      const [status, setStatus] = useState('loading');
      const [message, setMessage] = useState('');
      const [error, setError] = useState('');
      const [saving, setSaving] = useState(false);

      const load = async () => {
        setStatus('loading');
        setError('');
        try {
          const [settings, primaryStatus, aliasStatus, dshDocument, dshCredential] = await Promise.all([
            hostRemote.settings(),
            hostRemote.credential(MODEL_CREDENTIAL_NAMES[0]),
            hostRemote.credential(MODEL_CREDENTIAL_NAMES[1]),
            dshModel.describe(),
            dshModel.credentialStatus(),
          ]);
          const selectedModelStatus = primaryStatus?.configured ? primaryStatus : aliasStatus;
          setModelStatus(selectedModelStatus || { configured: false, source: 'missing' });
          setCloudStatus({
            configured: Boolean(settings?.cloudAccountConfigured),
            source: settings?.configurationSources?.cloudAccessKey || 'missing',
          });
          const dshProfile = (dshDocument?.namespaces || [])
            .find(item => item.ns === DSH_MODEL_SETTINGS_NS)?.value?.providers?.[DSH_MODEL_ROUTE];
          const configuredModel = dshProfile?.models?.[0]?.id || '';
          const configuredBaseUrl = dshProfile?.baseURL || '';
          const configuredCredential = dshProfile?.apiKeyEnv || '';
          const studioProvider = settings?.modelProvider || 'ksyun';
          const studioModel = settings?.modelName || DEFAULT_KSYUN_MODEL;
          const configuredStudioBaseUrl = settings?.modelBaseUrl || '';
          const studioBaseUrl = studioProvider === 'ksyun'
            ? (configuredStudioBaseUrl || DEFAULT_KSYUN_BASE_URL)
            : (configuredStudioBaseUrl === DEFAULT_KSYUN_BASE_URL ? '' : configuredStudioBaseUrl);
          if (studioModel && studioBaseUrl
            && (configuredModel !== studioModel || configuredBaseUrl !== studioBaseUrl || configuredCredential !== DSH_MODEL_CREDENTIAL)) {
            // Keep the DSH model directory convergent with the Studio/Host
            // defaults even when the user edits ~/.agentkit outside this page.
            // No secret is copied here; a key is synchronized only on an
            // explicit Save with a newly entered value.
            try {
              await dshModel.apply({ provider: studioProvider, baseUrl: studioBaseUrl, modelName: studioModel, apiKey: '' });
              setDshStatus({ configured: true, model: studioModel, credentialConfigured: Boolean(dshCredential?.configured || selectedModelStatus?.configured) });
            } catch (reason) {
              setDshStatus({ configured: Boolean(configuredModel), model: configuredModel, credentialConfigured: Boolean(dshCredential?.configured || selectedModelStatus?.configured) });
              setError(reason?.message || 'DSH 模型目录同步失败');
            }
          } else {
            setDshStatus({ configured: Boolean(configuredModel), model: configuredModel, credentialConfigured: Boolean(dshCredential?.configured || selectedModelStatus?.configured) });
          }
          setForm(current => ({
            ...current,
            provider: studioProvider,
            baseUrl: settings?.modelBaseUrl || (studioProvider === 'ksyun' ? DEFAULT_KSYUN_BASE_URL : ''),
            modelName: settings?.modelName || DEFAULT_KSYUN_MODEL,
            cloudAccountId: settings?.cloudAccountId || '',
            cloudRegion: settings?.cloudRegion || '',
            cloudServerUrl: settings?.cloudServerUrl || '',
            cloudBucket: settings?.cloudBucket || '',
          }));
          setStatus('ready');
        } catch (reason) {
          setStatus('error');
          setError(reason?.message || 'Host 尚未连接');
        }
      };

      useEffect(() => { load(); }, []);

      const setField = (key, value) => setForm(current => ({ ...current, [key]: value }));
      const sourceLabel = source => ({
        global: '全局 ~/.agentkit',
        workspace: '当前工作区',
        environment: '环境变量',
        'workspace-alias': '当前工作区别名',
        'global-alias': '全局 ~/.agentkit（兼容别名）',
        session: '本次 Host 会话',
        missing: '未配置',
      }[source] || source || '未配置');

      const save = async event => {
        event.preventDefault();
        if (saving || status !== 'ready') return;
        setSaving(true);
        setMessage('');
        setError('');
        try {
          const modelProvider = form.provider.trim() || 'ksyun';
          const modelBaseUrl = form.baseUrl.trim() || (modelProvider === 'ksyun' ? DEFAULT_KSYUN_BASE_URL : '');
          const settingsPayload = {
            modelProvider,
            modelBaseUrl,
            modelName: form.modelName.trim() || DEFAULT_KSYUN_MODEL,
            cloudAccountId: form.cloudAccountId.trim(),
            cloudRegion: form.cloudRegion.trim(),
            cloudServerUrl: form.cloudServerUrl.trim(),
            cloudBucket: form.cloudBucket.trim(),
          };
          if (form.cloudAccessKey.trim()) settingsPayload.cloudAccessKey = form.cloudAccessKey.trim();
          if (form.cloudSecretKey.trim()) settingsPayload.cloudSecretKey = form.cloudSecretKey.trim();
          await hostRemote.updateSettings(settingsPayload);
          if (form.apiKey.trim()) {
            await hostRemote.putCredential('AGENTKIT_MODEL_API_KEY', form.apiKey.trim());
          }
          await dshModel.apply({
            provider: modelProvider,
            baseUrl: modelBaseUrl,
            modelName: form.modelName.trim() || DEFAULT_KSYUN_MODEL,
            apiKey: form.apiKey.trim(),
          });
          setForm(current => ({ ...current, apiKey: '', cloudAccessKey: '', cloudSecretKey: '' }));
          setMessage('已保存到本机 Host，并同步到 DSH 聊天模型目录；新会话可直接选择该模型。');
          await load();
        } catch (reason) {
          setError(reason?.message || '保存模型与凭证失败');
        } finally {
          setSaving(false);
        }
      };

      const field = (label, key, placeholder, type = 'text') => h('label', {
        style: { display: 'block', color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 },
      }, label, h('input', {
        type, value: form[key], placeholder, autoComplete: type === 'password' ? 'new-password' : 'off',
        onChange: event => setField(key, event.target.value), style: inputStyle(),
      }));

      const isKsyun = form.provider === 'ksyun';
      const changeProvider = event => {
        const provider = event.target.value;
        setForm(current => ({
          ...current,
          provider,
          baseUrl: provider === 'ksyun'
            ? (current.baseUrl || DEFAULT_KSYUN_BASE_URL)
            : (current.baseUrl === DEFAULT_KSYUN_BASE_URL ? '' : current.baseUrl),
        }));
      };
      return h('div', { style: { color: BRAND.ink, fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif' } },
        status === 'error' ? h('div', { role: 'alert', style: { marginBottom: '10px', color: BRAND.danger, fontSize: '12px' } }, error) : null,
        h('form', { onSubmit: save, style: { display: 'grid', gap: '14px', maxWidth: '900px' } },
          h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '14px', alignItems: 'start' } },
            h('section', { style: { border: '1px solid ' + BRAND.border, borderRadius: '12px', padding: '14px', background: BRAND.surface } },
              h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center', marginBottom: '10px' } },
                h('div', null,
                  h('h3', { style: { margin: 0, color: BRAND.ink, fontSize: '14px' } }, '默认模型'),
                  h('p', { style: { margin: '3px 0 0', color: BRAND.inkMuted, fontSize: '11px' } }, '新会话和未绑定专属模型的 Agent 使用')),
                h(Pill, { tone: dshStatus.configured && dshStatus.credentialConfigured ? 'accent' : 'signal' }, dshStatus.configured ? 'DSH 已识别' : '待同步')),
              h('div', { style: { display: 'grid', gridTemplateColumns: '0.9fr 1.1fr', gap: '9px' } },
                h('label', { style: { display: 'block', color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '提供商', h('select', { value: form.provider, onChange: changeProvider, style: inputStyle() },
                  h('option', { value: 'ksyun' }, '金山云模型服务'),
                  h('option', { value: 'openai-compatible' }, 'OpenAI 兼容接口'),
                  h('option', { value: 'custom' }, '自定义提供商'))),
                field('模型名称', 'modelName', DEFAULT_KSYUN_MODEL)),
              isKsyun ? h('div', { style: { marginTop: '8px', color: BRAND.inkMuted, fontSize: '10px' } }, '金山云模型服务使用默认地址，无需填写 API 地址。') : field('API 地址', 'baseUrl', '例如：https://api.example.com/v1'),
              h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '6px', alignItems: 'end', marginTop: '8px' } },
                field('API Key（留空表示不修改）', 'apiKey', modelStatus.configured ? '已配置，留空保持不变' : '由本机 Host 安全保存', 'password'),
                h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', color: BRAND.inkMuted, fontSize: '10px', flexWrap: 'wrap' } },
                  h('span', null, '来源：', sourceLabel(modelStatus.source)),
                  isKsyun
                    ? h('a', { href: 'https://ksp.console.ksyun.com/#/apiKey', target: '_blank', rel: 'noopener noreferrer', style: { color: BRAND.accentStrong, textDecoration: 'underline' } }, '获取 Key')
                    : h('span', { style: { color: BRAND.inkMuted } }, '请填写该提供商的 API Key'))),
            ),
            h('section', { style: { border: '1px solid ' + BRAND.border, borderRadius: '12px', padding: '14px', background: BRAND.surface } },
              h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center', marginBottom: '10px' } },
                h('div', null,
                  h('h3', { style: { margin: 0, color: BRAND.ink, fontSize: '14px' } }, '云端凭证'),
                  h('p', { style: { margin: '3px 0 0', color: BRAND.inkMuted, fontSize: '11px' } }, '用于构建、部署和资源访问')),
                h(Pill, { tone: cloudStatus.configured ? 'accent' : 'signal' }, cloudStatus.configured ? '已配置' : '未配置')),
              h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '9px' } },
                field('Access Key', 'cloudAccessKey', cloudStatus.configured ? '已配置，留空保持不变' : '云端 Access Key', 'password'),
                field('Secret Key', 'cloudSecretKey', cloudStatus.configured ? '已配置，留空保持不变' : '云端 Secret Key', 'password')),
              h('details', { style: { marginTop: '10px', color: BRAND.inkMuted, fontSize: '11px' } },
                h('summary', { style: { cursor: 'pointer', color: BRAND.ink, fontWeight: 700 } }, '高级云端设置'),
                h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '9px', marginTop: '8px' } },
                  field('Account ID', 'cloudAccountId', '可选'),
                  field('区域', 'cloudRegion', '例如：cn-beijing-6'),
                  field('控制面地址', 'cloudServerUrl', '例如：https://agentengine.example.com'),
                  field('对象存储桶', 'cloudBucket', '可选'))),
              h('div', { style: { marginTop: '9px', color: BRAND.inkMuted, fontSize: '10px' } }, '当前来源：', sourceLabel(cloudStatus.source))),
          ),
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '9px', flexWrap: 'wrap' } },
            message ? h('span', { role: 'status', style: { color: BRAND.accentStrong, fontSize: '11px', marginRight: 'auto' } }, message) : null,
            error ? h('span', { role: 'alert', style: { color: BRAND.danger, fontSize: '11px', marginRight: 'auto' } }, error) : null,
            h('button', { type: 'button', onClick: load, style: buttonStyle() }, '重新读取'),
            h('button', { type: 'submit', disabled: saving || status !== 'ready', style: { ...buttonStyle(), color: 'var(--dsw-static-neutral-00, #fff)', background: saving || status !== 'ready' ? 'var(--dsw-alias-label-tertiary, #aab7c4)' : BRAND.primaryFill, borderColor: 'transparent' } }, saving ? '保存中…' : '保存配置'))));
    }

    function StudioSettingsSection() {
      return h('div', {
        style: { color: BRAND.ink, fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
      },
      h(SectionHeading, { eyebrow: 'AgentKit Studio', title: 'Studio 设置', detail: '产品级配置会通过 Studio Host 的 settings schema 持久化。当前 Host 尚未连接，展示项保持只读。' }),
      h('section', { style: { border: '1px solid ' + BRAND.border, borderRadius: '14px', padding: '0 18px', background: BRAND.surface } },
        h(SettingsRow, { label: '会话绑定策略', value: '可选 Agent', detail: '不选择 Agent 时直接使用 DSH 原生会话；选择后在新会话创建时固定主 Agent', tone: 'accent' }),
        h(SettingsRow, { label: '默认执行目标', value: 'Local Host', detail: '创建 Agent 和运行会话时使用的默认目标', tone: 'signal' }),
        h(SettingsRow, { label: 'Studio Host', value: '待接入', detail: 'Health、capability 和 Session Remote 尚未连接', tone: 'signal' }),
        h(SettingsRow, { label: '事件流诊断', value: '关闭', detail: '连接 Host 后可以开启结构化 Session 事件日志' }),
        h(SettingsRow, { label: 'AgentKit Studio 版本', value: STUDIO_VERSION, detail: '产品外壳与运行适配层版本' }),
        h(SettingsRow, { label: 'DSH 宿主兼容版本', value: DSH_VERSION, detail: '固定的宿主基线，不代表 Studio 产品版本' })),
      h('div', { style: { marginTop: '16px', padding: '14px 16px', borderRadius: '12px', color: BRAND.inkMuted, background: BRAND.canvas, fontSize: '12px', lineHeight: 1.55 } }, '工作区、会话、模型和凭证的通用设置继续由系统设置页承载；Studio 只扩展自己的执行目标、Host 能力和产品选项。'));
    }

    function apply(ctx) {
      activeConnection = ctx.connection;
      // Schedule is a capability, not a hard requirement for the fixed
      // dsh-v0.1.7-rc.2 host. Older profiles can still expose the Studio
      // shell and all model/agent/resource surfaces while the automation
      // panel reports that its host service is unavailable.
      const scheduleRemote = ctx.remote && typeof ctx.remote.schedule?.catalog === 'function'
        ? ctx.remote.schedule
        : null;
      ctx.effect(() => adoptProductDocumentTitle(), 'agentkit-studio: document title');
      ctx.effect(() => adoptProductDocumentBrand(), 'agentkit-studio: document favicon');
      // DSH owns the official composer and its native session.prompt path.
      // Studio does not inject a sink or bridge into InputHub. The authoring
      // tools registered by the Host let this native conversation create and
      // refine a reviewed Agent draft. A selected Studio Agent remains
      // metadata until the separate public admission/provider contract carries
      // its Revision into execution.
      // Replace the official DSH brand row through its public slots. This
      // preserves the frame while giving the product its own identity.
      ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register(
        { name: 'sidebar.brand.mark' },
        ({ size }) => h('span', { style: { display: 'inline-flex', color: BRAND.accentStrong } }, h(StudioMark, { size: size || 24, title: '' })),
      ));
      ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register(
        { name: 'sidebar.brand.name' },
        () => h('span', { style: { color: BRAND.ink, fontSize: '13px', fontWeight: 800, letterSpacing: '-0.02em' } }, 'AgentKit Studio'),
      ));
      ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register(
        { name: 'conversation.hero.brand.mark' },
        ({ size }) => h('span', { style: { display: 'inline-flex', color: BRAND.accentStrong } }, h(StudioMark, { size, title: '' })),
      ));
      ctx.slots.inject('conversation.hero.brand.name', () => ctx.slots.register(
        { name: 'conversation.hero.brand.name' },
        () => h('span', null, 'AgentKit Studio'),
      ));
      ctx.slots.inject('conversation.header.leading', () => ctx.slots.register(
        { name: 'conversation.header.leading' },
        () => h(AgentContextSelector),
      ));

      // Each product domain is a first-class DSH main panel. The rows land in
      // the official panel list directly below New Session, matching the old
      // Studio information architecture. Page-level resource tabs remain in
      // the content area; the four product domains never become a second row
      // of tabs inside their own detail page.
      const navigateStudio = target => {
        const next = PANELS.find(item => item.page === target || item.id === target);
        if (next) ctx.layout.selectPanel(next.id);
      };
      ctx.effect(() => {
        const openAuthoring = event => {
          if (event?.detail !== 'conversation') return;
          try { window.localStorage.setItem('agentkit-studio:open-authoring', 'conversation'); } catch {}
          navigateStudio('studio-agents');
        };
        const openBoundConversation = event => {
          const agentId = String(event?.detail?.agentId || '').trim();
          if (!agentId) return;
          try { window.localStorage.setItem(OPEN_BOUND_CONVERSATION_KEY, agentId); } catch {}
          navigateStudio('studio-agents');
        };
        window.addEventListener('agentkit-studio:open-authoring', openAuthoring);
        window.addEventListener('agentkit-studio:open-bound-conversation', openBoundConversation);
        return () => {
          window.removeEventListener('agentkit-studio:open-authoring', openAuthoring);
          window.removeEventListener('agentkit-studio:open-bound-conversation', openBoundConversation);
        };
      }, 'agentkit-studio:authoring-entry');
      PANELS.forEach((panel, index) => {
        ctx.slots.inject('main', () => ctx.slots.register(
          { name: 'main', key: panel.id },
          () => h(StudioShell, { page: panel.page, onNavigate: navigateStudio, scheduleRemote }),
        ));
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          { name: 'sidebar.panellist', id: panel.id, order: 1 + index, label: panel.label },
          props => h(StudioPanelIcon, { ...props, glyph: panel.glyph, panelId: panel.id }),
        ));
      });


      // Settings remains the official DSH modal and navigation shell. Studio
      // contributes native sections into that shell. The model page is Studio
      // owned; its save path also writes DSH's public llm-pi-ai settings and
      // credentials contracts so the official composer model seat can resolve it.
      const dshModel = createDshModelBridge(ctx);

      // The Studio model form is not guaranteed to be opened before the user
      // starts a conversation. Keep the official DSH model directory in sync
      // from the Host configuration at plugin boot and after a DSH reconnect,
      // so a fresh chat never falls back to the stale profile default merely
      // because the settings modal was not visited first.
      let modelSyncInFlight = null;
      const syncModelFromStudioHost = async () => {
        if (modelSyncInFlight) return modelSyncInFlight;
        modelSyncInFlight = (async () => {
          try {
            const settings = await hostRemote.settings();
            const modelName = String(settings?.modelName || DEFAULT_KSYUN_MODEL).trim();
            const modelProvider = String(settings?.modelProvider || 'ksyun').trim() || 'ksyun';
            const baseUrl = String(settings?.modelBaseUrl || '').trim()
              || (modelProvider === 'ksyun' ? DEFAULT_KSYUN_BASE_URL : '');
            if (!modelName || !baseUrl) return;
            const document = await dshModel.describe();
            const providerNamespace = (document.namespaces || []).find(item => item.ns === DSH_MODEL_SETTINGS_NS);
            const providerProfile = providerNamespace?.value?.providers?.[DSH_MODEL_ROUTE]
              || providerNamespace?.user?.providers?.[DSH_MODEL_ROUTE]
              || {};
            const defaultNamespace = (document.namespaces || []).find(item => item.ns === DSH_DEFAULT_MODEL_SETTINGS_NS);
            const defaultValue = defaultNamespace?.value || defaultNamespace?.user || {};
            const currentModel = providerProfile?.models?.[0]?.id || '';
            const currentBaseUrl = providerProfile?.baseURL || '';
            if (currentModel === modelName
              && currentBaseUrl === baseUrl
              && defaultValue?.provider === DSH_MODEL_ROUTE
              && defaultValue?.model === modelName) return;
            await dshModel.apply({
              provider: modelProvider,
              baseUrl,
              modelName,
              apiKey: '',
            });
          } catch (reason) {
            // DSH remains usable when the optional Studio Host is offline;
            // the settings surface reports the actionable error on demand.
            console.warn('[agentkit-studio] model sync skipped:', reason?.message || reason);
          } finally {
            modelSyncInFlight = null;
          }
        })();
        return modelSyncInFlight;
      };
      void syncModelFromStudioHost();
      ctx.on('connection/reset', () => { void syncModelFromStudioHost(); });
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: 'agentkit-models', order: 190, label: '模型与凭证',
      }, () => h(ModelSettingsSection, { dshModel })));
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: 'agentkit-studio', order: 200, label: 'AgentKit Studio',
      }, StudioSettingsSection));
    }

    return {
      name: 'agentkit-studio',
      inject: ['slots', 'layout', 'connection', 'remote', 'remote.settings', 'remote.credentials', 'remote.llm'],
      apply,
    };
  },
});
