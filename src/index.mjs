/**
 * AgentKit Studio host half.
 *
 * The official DSH Host owns the Session Controller, profile, persistence,
 * Remote and renderer. Studio does not intercept DSH prompts here and does
 * not translate them into legacy session/run action calls. Agent authoring
 * is exposed through the public DSH ToolRegistry: native conversations can
 * inspect catalogs, maintain a reviewed draft and explicitly commit it via
 * the Host API. A selected no-resource dsh-native Studio Agent is admitted
 * through DSH's public agent-preset registry; resource-bearing revisions
 * remain fail-closed until their provider contract is implemented.
 */
import { registerAuthoringTools } from './authoring-tools.mjs';
import { DshPresetAdmission } from './agent-preset-admission.mjs';

export const name = 'agentkit-studio';
export const inject = ['connection', 'webServer', 'credentials'];

const CONTROL_CHANNEL = '/agentkit';
const runtimeEnv = typeof process === 'object' && process?.env ? process.env : {};

/**
 * The Studio browser half runs in DSH's sandboxed srcdoc frame. A direct
 * fetch from that frame cannot carry a usable Origin, so the AgentEngine
 * control plane is reached through DSH's authenticated Connection RPC. The
 * Node Host owns credentials and calls the public Action API; no KsADK/Python
 * process is involved in this path.
 */
async function registerControlPlane(ctx) {
  // Keep Node-only configuration and HTTPS/KOP dependencies out of the
  // browser-facing plugin module graph. DSH loads this module for both the
  // Host and client faces; importing node:fs or aws4 at activation time makes
  // the whole plugin fail before the Host route can be registered.
  const configurationPromise = import('./global-config.mjs').then(({ createGlobalConfiguration }) =>
    createGlobalConfiguration({ env: runtimeEnv }));
  const serverClientPromise = configurationPromise.then(configuration =>
    import('./server-client.mjs').then(({ createAgentEngineClient }) =>
      createAgentEngineClient({
        configuration,
        sessionToken: runtimeEnv.AGENTKIT_STUDIO_HOST_SESSION_TOKEN || '',
        serverUrl: runtimeEnv.AGENTKIT_STUDIO_HOST_URL || 'http://127.0.0.1:8789',
      })));
  // Cordis exposes injected services through `get`; property access is only
  // available on typed service contexts and is absent in the plain plugin
  // apply context used by the DSH loader.
  const credentials = ctx.get('credentials');
  const models = await import('./model-service.mjs').then(({ createModelService }) => configurationPromise.then(configuration => createModelService({ configuration, credentials })));
  const syncModelCredential = models.sync;
  // The DSH loader awaits an async plugin apply. Do this before returning from
  // activation so the first prompt cannot race the global ~/.agentkit key
  // being copied into the official credential service. The previous fire and
  // forget call made a fresh browser session intermittently fail with
  // llm-pi-ai/no-credential even though the Models page was already configured.
  try {
    await syncModelCredential();
  } catch (error) {
    console.warn('[agentkit-studio] model credential sync skipped:', error?.message || error);
  }
  let presetRegistry;
  let presetAdmission;
  // The registry is an optional DSH service. Older profiles can still load
  // the Studio catalog and UI, but an Agent binding must return a typed
  // unavailable error instead of silently selecting the default DSH loop.
  ctx.inject(['agentPresets'], presetCtx => {
    presetRegistry = presetCtx.agentPresets;
    if (presetAdmission) presetAdmission.setRegistry(presetRegistry);
    presetCtx.effect(() => async () => {
      await presetAdmission?.dispose();
      presetRegistry = undefined;
    }, 'agentkit-studio: dynamic preset cleanup');
  });
  presetAdmission = new DshPresetAdmission({
    getAgent: async agentId => (await serverClientPromise).getAgent(agentId),
    getActiveModel: async () => (await configurationPromise).resolve(),
  });
  if (presetRegistry) presetAdmission.setRegistry(presetRegistry);
  const allowed = new Set(['agents/list', 'agents/ensure-preset', 'models/sync-credential', 'models/catalog', 'settings/get', 'settings/update', 'server/action']);
  const dispatch = async (endpoint, payload, signal) => {
    if (!allowed.has(endpoint)) {
      return { ok: false, error: { code: 'agentkit/not-found', message: 'Unknown AgentKit control endpoint', details: { endpoint } } };
    }
    try {
      if (endpoint === 'models/sync-credential') return { ok: true, value: await syncModelCredential() };
      if (endpoint === 'settings/get') return { ok: true, value: await models.settings() };
      if (endpoint === 'settings/update') return { ok: true, value: await models.save(payload) };
      if (endpoint === 'models/catalog') return { ok: true, value: await models.catalog(String(payload?.profileId || '')) };
      const serverClient = await serverClientPromise;
      // Agent catalog reads are now owned by the Studio Node host and call the
      // existing AgentEngine Action API directly. The DSH connection only
      // authenticates the browser-to-host hop; it is not a KsADK dependency.
      if (endpoint === 'agents/list') {
        const value = await serverClient.listAgents({
          page: Number(payload?.page || 1), pageSize: Number(payload?.limit || 50), query: String(payload?.query || ''),
        }, { signal });
        return { ok: true, value };
      }
      if (endpoint === 'agents/ensure-preset') {
        const agentId = String(payload?.agentId || '').trim();
        if (!agentId) return { ok: false, error: { code: 'INVALID_AGENT_ID', message: 'AgentId 不能为空', details: {} } };
        try {
          const value = await presetAdmission.ensure(agentId);
          return { ok: true, value };
        } catch (error) {
          return { ok: false, error: {
            code: error?.code || 'DSH_PRESET_ADMISSION_FAILED',
            message: error instanceof Error ? error.message : String(error),
            details: error?.details || {},
          } };
        }
      }
      if (endpoint === 'server/action') {
        const action = String(payload?.action || '');
        const body = payload?.payload && typeof payload.payload === 'object' ? payload.payload : {};
        if (action === 'settings/get') return { ok: true, value: await models.settings() };
        if (action === 'settings/update') return { ok: true, value: await models.save(body) };
        if (action === 'models/catalog') return { ok: true, value: await models.catalog(String(body.profileId || '')) };
        if (action === 'models/sync-credential') return { ok: true, value: await syncModelCredential() };
        if (action === 'GetAgent') {
          const value = await serverClient.getAgent(String(body.AgentId || body.agentId || ''));
          return { ok: true, value };
        }
        const resourceKinds = { ListKnowledgeBases: 'knowledge-base', ListMemoryInstances: 'memory-instance', ListMCPs: 'mcp', ListSkillWorkspaces: 'skill-space' };
        if (resourceKinds[action]) {
          const value = await serverClient.listResource(resourceKinds[action], body);
          return { ok: true, value };
        }
        const value = await serverClient.action(action, body);
        return { ok: true, value: value.data, requestId: value.requestId };
      }
    } catch (error) {
      if (signal?.aborted) return { ok: false, error: { code: 'gateway/cancelled', message: 'AgentKit request cancelled', details: {} } };
      return { ok: false, error: { code: error?.code || 'agentkit/server-unavailable', message: error instanceof Error ? error.message : String(error), details: { status: error?.status || 0 } } };
    }
  };
  // HostConnectionService's dedicated-RPC helper owns its registration fiber;
  // the plugin uses the same public Connection admission and WebServer route
  // boundary directly so this optional control plane can coexist with DSH's
  // single shared /api Typert interceptor.
  const { createModelProxyHandler } = await import('./model-proxy-handler.mjs');
  ctx.inject(['connection', 'webServer'], (webCtx) => {
    const modelRoute = webCtx.webServer.register({ kind: 'prefix', path: '/agentkit/models/', handler: createModelProxyHandler({ models, admit: request => webCtx.connection.admit(request) }) });
    webCtx.effect(() => modelRoute, 'agentkit-studio: model compatibility route');
    const registration = webCtx.webServer.register({
      kind: 'prefix',
      path: CONTROL_CHANNEL,
      handler: async (request, response) => {
        const admission = webCtx.connection.admit(request);
        if ('rejection' in admission) {
          response.writeHead(admission.rejection);
          response.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden');
          return;
        }
        if (request.method !== 'POST') {
          response.writeHead(404);
          response.end('not found');
          return;
        }
        const chunks = [];
        let size = 0;
        try {
          for await (const chunk of request) {
            size += chunk.length;
            if (size > 1024 * 1024) {
              response.writeHead(413);
              response.end('request too large');
              return;
            }
            chunks.push(chunk);
          }
          const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const endpoint = String(message?.method || '');
          // The node IncomingMessage is already at EOF after the JSON body is
          // read; its abort signal may be marked closed even though the RPC
          // caller is still waiting for the response.  The catalog request is
          // bounded by the Host's own timeout and must not be cancelled here.
          const result = await dispatch(endpoint, message?.payload, undefined);
          response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          response.end(JSON.stringify({ type: 'server-response', rpcId: String(message?.rpcId || ''), result }));
        } catch (error) {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ type: 'server-response', rpcId: '', result: {
            ok: false,
            error: { code: 'agentkit/bad-request', message: error instanceof Error ? error.message : String(error), details: {} },
          } }));
        }
      },
    });
    webCtx.effect(() => registration, 'agentkit-studio: control-plane route');
  });
}

export async function apply(ctx) {
  registerAuthoringTools(ctx);
  await registerControlPlane(ctx);
  ctx.on('webserver/index-inject', table => table.push({
    kind: 'global',
    name: '__AGENTKIT_STUDIO__',
    value: {
      version: '0.0.1',
      // Allow an isolated release-candidate process to report its own DSH
      // version without rebuilding the plugin artifact.
      dshVersion: runtimeEnv.AGENTKIT_STUDIO_DSH_VERSION || '0.1.7-rc.2',
      hostUrl: runtimeEnv.AGENTKIT_STUDIO_HOST_URL || 'http://127.0.0.1:8789',
      controlPlane: 'agentengine-server',
      // The Studio Host owns this short-lived local session token. It is not
      // a model or cloud credential; the browser exchanges it once for CSRF.
      sessionToken: runtimeEnv.AGENTKIT_STUDIO_HOST_SESSION_TOKEN || null,
    },
  }));
  // The DSH application owns the browser document, so a React panel cannot
  // reliably replace its favicon from the plugin sandbox.  Use the public
  // webserver index injection seam to install the product mark in the
  // top-level document after the shell's own links have been parsed.
  ctx.on('webserver/index-inject', table => table.push({
    kind: 'script',
    placement: 'head',
    text: `(() => {
      const href = 'data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="29" fill="#f7ffff" stroke="#0aa6a6" stroke-width="2"/><path d="M32 6 7 54h11l5-10h18l5 10h11L32 6Zm0 18 5 10H27l5-10Z" fill="#0aa6a6"/></svg>')}'
      const apply = () => {
        document.querySelectorAll('link[rel~="icon"]:not([data-agentkit-studio-favicon])').forEach(link => link.remove())
        let link = document.querySelector('link[data-agentkit-studio-favicon]')
        if (!link) {
          link = document.createElement('link')
          link.dataset.agentkitStudioFavicon = 'true'
          document.head.append(link)
        }
        link.rel = 'icon'
        link.type = 'image/svg+xml'
        link.href = href
      }
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply, { once: true })
      else apply()
    })()`
  }));
}

export default {
  name,
  inject,
  apply,
};
