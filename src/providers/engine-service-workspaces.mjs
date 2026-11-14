import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { engineServiceEndpoint, engineServiceFetch } from './engine-service-client.mjs';

export const HARNESS_SERVICE_MODEL_PROVIDER = 'agentkit-studio-harness-service';

export function canonicalEngineWorkspace(cwd) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return null;
  try {
    const root = realpathSync(cwd);
    return statSync(root).isDirectory() ? root : null;
  } catch { return null; }
}

const contains = (parent, child) => {
  const suffix = relative(parent, child);
  return !suffix || !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('..' + sep);
};

export function engineServiceWorkspaces(env) {
  try {
    const configured = env.AGENTKIT_ENGINE_SERVICE_WORKSPACES;
    if (configured !== undefined && env.AGENTKIT_ENGINE_SERVICE_URL) throw new Error();
    const rows = configured !== undefined ? JSON.parse(configured) : env.AGENTKIT_ENGINE_SERVICE_URL ? [{
      workspace: env.AGENTKIT_ENGINE_SERVICE_WORKSPACE,
      endpoint: env.AGENTKIT_ENGINE_SERVICE_URL,
      tokenEnv: 'AGENTKIT_ENGINE_SERVICE_TOKEN',
      caFile: env.AGENTKIT_ENGINE_SERVICE_CA_FILE,
      model: env.AGENTKIT_ENGINE_SERVICE_MODEL,
      previewOrigin: env.AGENTKIT_STUDIO_NATIVE_APPLICATION_PREVIEW_ORIGIN,
      previewEntry: env.AGENTKIT_STUDIO_NATIVE_APPLICATION_PREVIEW_ENTRY,
    }] : [];
    if (!Array.isArray(rows) || (configured !== undefined && !rows.length)) throw new Error();
    const routes = new Map();
    const endpoints = new Set(), tokens = new Set(), previewOrigins = new Set();
    for (const row of rows) {
      const workspaceRoot = canonicalEngineWorkspace(row.workspace);
      const token = Object.hasOwn(env, row.tokenEnv) ? env[row.tokenEnv] : undefined;
      const endpoint = engineServiceEndpoint(row.endpoint, token);
      if (!workspaceRoot || endpoints.has(endpoint) || tokens.has(token)
        || [...routes.keys()].some(root => contains(root, workspaceRoot) || contains(workspaceRoot, root))) throw new Error();
      let preview;
      if (row.previewOrigin !== undefined || row.previewEntry !== undefined) {
        const url = new URL(row.previewOrigin);
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/'
          || url.username || url.password || url.search || url.hash || previewOrigins.has(url.origin)) throw new Error();
        previewOrigins.add(url.origin);
        preview = { workspaceRoot, origin: url.origin, entryPath: row.previewEntry };
      }
      endpoints.add(endpoint);
      tokens.add(token);
      routes.set(workspaceRoot, { workspaceRoot, endpoint, token, fetchImpl: engineServiceFetch(endpoint, row.caFile),
        modelSelection: { provider: HARNESS_SERVICE_MODEL_PROVIDER, model: row.model?.trim() || 'Harness' }, preview });
    }
    return routes;
  } catch {
    throw Object.assign(new Error('Harness 服务配置无效。请检查工作区、服务地址、凭据及预览地址。'), { code: 'NATIVE_ENGINE_CONFIG_INVALID' });
  }
}
