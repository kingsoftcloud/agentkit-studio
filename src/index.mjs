/**
 * AgentKit Studio host half.
 *
 * The official DSH Host owns the Session Controller, profile, persistence,
 * Remote and renderer. Studio does not intercept DSH prompts here and does
 * not translate them into legacy session/run action calls. Agent authoring
 * is exposed through the public DSH ToolRegistry: native conversations can
 * inspect catalogs, maintain a reviewed draft and explicitly commit it via
 * the Host API. A selected Studio Agent is still metadata on the native
 * composer until the separate public admission/provider contract is wired.
 */
import { registerAuthoringTools } from './authoring-tools.mjs';

export const name = 'agentkit-studio';
export const inject = ['connection', 'webServer'];

const CONTROL_CHANNEL = '/agentkit';
const runtimeEnv = typeof process === 'object' && process?.env ? process.env : {};

/**
 * The Studio browser half runs in DSH's sandboxed srcdoc frame. A direct
 * fetch from that frame cannot carry a usable Origin, so the AgentEngine
 * control plane is reached through DSH's authenticated Connection RPC. The
 * Node Host owns credentials and calls the public Action API; no KsADK/Python
 * process is involved in this path.
 */
function registerControlPlane(ctx) {
  // Keep Node-only configuration and HTTPS/KOP dependencies out of the
  // browser-facing plugin module graph. DSH loads this module for both the
  // Host and client faces; importing node:fs or aws4 at activation time makes
  // the whole plugin fail before the Host route can be registered.
  const serverClientPromise = import('./global-config.mjs').then(({ createGlobalConfiguration }) =>
    import('./server-client.mjs').then(({ createAgentEngineClient }) =>
      createAgentEngineClient({ configuration: createGlobalConfiguration({ env: runtimeEnv }) })));
  const allowed = new Set(['agents/list', 'server/action']);
  const dispatch = async (endpoint, payload, signal) => {
    if (!allowed.has(endpoint)) {
      return { ok: false, error: { code: 'agentkit/not-found', message: 'Unknown AgentKit control endpoint', details: { endpoint } } };
    }
    try {
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
      if (endpoint === 'server/action') {
        const action = String(payload?.action || '');
        const body = payload?.payload && typeof payload.payload === 'object' ? payload.payload : {};
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
  ctx.inject(['connection', 'webServer'], (webCtx) => {
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

export function apply(ctx) {
  registerAuthoringTools(ctx);
  registerControlPlane(ctx);
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
  // The DSH shell owns the browser document, so a React panel cannot
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
