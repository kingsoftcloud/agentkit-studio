/**
 * AgentKit Studio host half.
 *
 * The official DSH Host owns the Session Controller, profile, persistence,
 * Remote and renderer. Studio does not intercept DSH prompts here and does
 * not translate them into legacy session/run action calls. Agent authoring
 * is exposed through the public DSH ToolRegistry: native conversations can
 * inspect catalogs, maintain a reviewed draft and explicitly commit it via
 * the Host API. A selected no-resource dsh-native Studio Agent is admitted
 * through DSH's public agent-preset registry. Local Harness turns enter the
 * independent Native kernel; DSH-native and Codex retain their own loops.
 * DSH owns the Session and renderer for all three.
 */
import { AGENTKIT_STUDIO_MARK_SVG } from './brand.js';

export const name = 'agentkit-studio';
export const inject = ['connection', 'webServer', 'credentials'];
const runtimeEnv = typeof process === 'object' && process?.env ? process.env : {};

export async function apply(ctx) {
  // Managed runtimes receive a platform observability bundle (Langfuse OTLP
  // traces + CloudMonitor secondary). The plugin self-gates on that bundle, so
  // desktop and interactive sessions are unaffected. Publish the exporter
  // before the Host mounts: the frozen runtime resolves it while starting.
  const { installManagedObservability } = await import('./observability-otel.mjs');
  const observability = installManagedObservability(ctx);
  if (observability) ctx.provide('studioManagedObservability', observability);
  const { mountStudioHost } = await import('./host/bootstrap.mjs');
  await mountStudioHost(ctx, { env: runtimeEnv });
  const versions = await import('./studio-version.mjs').then(({ studioVersions }) => studioVersions(runtimeEnv));
  ctx.on('webserver/index-inject', table => table.push({
    kind: 'global',
    name: '__AGENTKIT_STUDIO__',
    value: {
      ...versions,
      // Cordis exposes this service only after the providing plugin is active.
      // Resolve it when the Host collects the index, not during apply().
      hostCompatibility: ctx.get('studioHostCompatibility').inspect(),
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
      const href = 'data:image/svg+xml,${encodeURIComponent(AGENTKIT_STUDIO_MARK_SVG)}'
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
