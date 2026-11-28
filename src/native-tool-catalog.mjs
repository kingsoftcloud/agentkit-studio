/** Native-owned additions to the legacy tool catalog. Catalog rows describe
 * capabilities; execution still requires an explicitly bound Native Build. */
import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { chromium } from 'playwright-core';
import toolDefaults from './contracts/harness-tool-defaults.json' with { type: 'json' };
import { nativeCommandBackend } from './providers/native-command-backend.mjs';
import { nativeDefaultToolsFromCatalog } from './native-capability-defaults.mjs';
import { NATIVE_CHILD_WORKSPACE_TOOLS } from './native-child-tools.mjs';
import { paginateResources } from './resource-catalog.mjs';
function hostHasBrowser(env) {
  const candidates = env.KSADK_BROWSER_EXECUTABLE_PATH ? [env.KSADK_BROWSER_EXECUTABLE_PATH] : [chromium.executablePath(),
    ...(process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'] : []),
    ...(process.platform === 'linux' ? ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'] : []),
  ];
  return candidates.some(path => {
    try { return isAbsolute(path) && statSync(path).isFile() && (accessSync(path, constants.X_OK), true); }
    catch { return false; }
  });
}

function definitions({ env = process.env, catalog = toolDefaults } = {}) {
  const commands = nativeCommandBackend(env) === 'local_process'
    && catalog.supportedCommandPlatforms.includes(`${process.platform}-${process.arch}`);
  return catalog.tools.filter(tool => tool.availability !== 'local-command' || commands);
}
export function nativeLocalToolContract(name, options) {
  const definition = definitions(options).find(tool => tool.name === name);
  if (!definition) return undefined;
  return contractForDefinition(definition);
}
function contractForDefinition(definition) {
  return { resourceId: definition.name, name: definition.name, description: definition.description,
    parameters: structuredClone(definition.parameters), executor: 'builtin', enabled: true,
    timeoutSeconds: definition.timeoutMs / 1000, sideEffect: definition.readOnly ? 'none' : definition.availability === 'local-command' ? 'unknown' : 'workspace',
    permissions: [...definition.permissions] };
}

export function nativeLocalToolResources({ env = process.env, catalog = toolDefaults } = {}) {
  const browserAvailable = hostHasBrowser(env);
  const childWorkspaceTools = new Set(catalog.childWorkspaceTools ?? NATIVE_CHILD_WORKSPACE_TOOLS);
  return definitions({ env, catalog }).map(tool => {
    const contract = contractForDefinition(tool), { parameters, ...metadata } = contract;
    const unavailableReason = tool.availability === 'browser' && !browserAvailable
      ? '未找到可用的本地浏览器，无法交互验证网页。' : null;
    return { resourceId: contract.resourceId, name: contract.name,
      displayName: tool.name === 'apply_workspace_patch' ? '结构化文件补丁 · Native' : `${tool.name} · Native`, description: contract.description,
      kind: 'tool', source: 'studio-native', status: unavailableReason ? 'not-configured' : 'available',
      ...(unavailableReason ? { disabled: true, unavailableReason } : {}), contract: { ...metadata,
        childWorkspace: childWorkspaceTools.has(tool.name), inputSchema: parameters } };
  });
}

/** Merge before pagination, as for the other Studio local/cloud catalogs.
 * Only authoring Native agents uses this merged catalog. Other engines retain
 * their original remote contract and cursor. No remote tool is registered here. */
export async function listStudioTools({ query = {}, serverClient, signal, catalog }) {
  const remoteQuery = { kind: 'tool', query: query.query, limit: query.limit,
    cursor: query.cursor, source: query.source, status: query.status };
  if (query.runtimeType !== 'harness') return serverClient.listCatalogResources(remoteQuery, { signal });
  paginateResources([], { ...query, kind: 'native-tool' }); // Reject invalid merged cursors/filters before remote I/O.
  const local = nativeLocalToolResources({ catalog }).filter(item => !query.status || query.status === item.status);
  const rows = [], cursors = new Set(); let cursor, warnings = [];
  for (let page = 0; ; page++) {
    signal?.throwIfAborted();
    if (page >= 20) throw Object.assign(Error('工具目录过大，请缩小搜索范围'), { code: 'RESOURCE_CATALOG_TOO_LARGE' });
    let result;
    try { result = await serverClient.listCatalogResources({ ...remoteQuery, limit: 200, cursor }, { signal }); }
    catch (error) {
      if (signal?.aborted || !['CATALOG_UNAVAILABLE', 'SERVER_UNAVAILABLE'].includes(error?.code)) throw error;
      warnings.push({ code: error.code, message: '旧工具目录暂不可用，当前仅显示已接入的 Native 本地工具。' });
      rows.length = 0; break;
    }
    if (!Array.isArray(result?.items)) throw Object.assign(Error('工具目录响应格式无效'), { code: 'RESOURCE_CATALOG_INVALID_RESPONSE' });
    rows.push(...result.items); warnings.push(...(result.warnings ?? []));
    cursor = result.nextCursor;
    if (!cursor) break;
    if (cursors.has(cursor)) throw Object.assign(Error('工具目录分页游标重复'), { code: 'INVALID_RESOURCE_CURSOR' });
    cursors.add(cursor);
  }
  // The distinct kind scopes merged cursors away from legacy remote cursors.
  return paginateResources([...local, ...rows], { ...query, kind: 'native-tool' }, { source: 'agentkit-studio', warnings });
}

export function defaultNativeToolBindings(options) {
  return nativeDefaultToolsFromCatalog(nativeLocalToolResources(options), options?.catalog?.defaultTools).map(resourceId => ({ resourceId }));
}
