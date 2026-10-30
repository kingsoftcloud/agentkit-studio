/** Native-owned additions to the legacy tool catalog. Catalog rows describe
 * capabilities; execution still requires an explicitly bound Native Build. */
import { workspacePatchDefinition, workspaceRewindDefinitions, workspaceToolDefinitions } from '@kingsoftcloud/agentkit-harness-node/native/workspace-tools';
import { nativeWebToolDefinitions } from '@kingsoftcloud/agentkit-harness-node/native/web-tools';
import { studioBrowserDefinition } from '@kingsoftcloud/agentkit-harness-node/native/browser-workspace-protocol';
import { resolveNativeBrowserExecutable } from '@kingsoftcloud/agentkit-harness-node/native/browser-availability';
import { localCommandToolDefinitions } from '@kingsoftcloud/agentkit-harness-node/native/local-command-tools';
import { supportsLocalProcessPlatform } from '@kingsoftcloud/agentkit-harness-node/native/local-process';
import { nativeCommandBackend } from './providers/native-e2b-host.mjs';
import { resolveWebSearchConfig } from './providers/native-dsh-web.mjs';
import { nativeDefaultToolsFromCatalog } from './native-capability-defaults.mjs';
import { paginateResources } from './resource-catalog.mjs';
const commandNames = new Set(['sandbox_status', 'run_command', 'read_command_output', 'stop_command']);
const definitions = (env = process.env) => [workspacePatchDefinition(), ...workspaceRewindDefinitions(), ...workspaceToolDefinitions(), ...nativeWebToolDefinitions(),
  studioBrowserDefinition(),
  ...(nativeCommandBackend(env) === 'local_process' && supportsLocalProcessPlatform() ? localCommandToolDefinitions() : [])];

export function nativeLocalToolContract(name) {
  const definition = definitions().find(tool => tool.name === name);
  if (!definition) return undefined;
  return contractForDefinition(definition);
}
function contractForDefinition(definition) {
  return { resourceId: definition.name, name: definition.name, description: definition.description,
    parameters: definition.parameters, executor: 'builtin', enabled: true,
    timeoutSeconds: definition.timeoutMs / 1000, sideEffect: definition.readOnly ? 'none' : commandNames.has(definition.name) ? 'unknown' : 'workspace', permissions: definition.permissions };
}

export function nativeLocalToolResources({ env = process.env } = {}) {
  const search = resolveWebSearchConfig(env);
  const browserExecutable = resolveNativeBrowserExecutable({ env });
  return definitions(env).map(tool => {
    const contract = contractForDefinition(tool), { parameters, ...metadata } = contract;
    const unavailableReason = tool.name === 'web_search' && !search.provider
      ? '尚未配置网页搜索服务；公开网页读取仍可用。'
      : tool.name === 'browser_inspect_workspace' && !browserExecutable ? '未找到可用的本地浏览器，无法交互验证网页。' : null;
    return { resourceId: contract.resourceId, name: contract.name,
      displayName: tool.name === 'apply_workspace_patch' ? '结构化文件补丁 · Native' : `${tool.name} · Native`, description: contract.description,
      kind: 'tool', source: 'studio-native', status: unavailableReason ? 'not-configured' : 'available',
      ...(unavailableReason ? { disabled: true, unavailableReason } : {}), contract: { ...metadata, inputSchema: parameters } };
  });
}

/** Merge before pagination, as for the other Studio local/cloud catalogs.
 * Only authoring Native agents uses this merged catalog. Other engines retain
 * their original remote contract and cursor. No remote tool is registered here. */
export async function listStudioTools({ query = {}, serverClient, signal }) {
  const remoteQuery = { kind: 'tool', query: query.query, limit: query.limit,
    cursor: query.cursor, source: query.source, status: query.status };
  if (query.runtimeType !== 'harness') return serverClient.listCatalogResources(remoteQuery, { signal });
  paginateResources([], { ...query, kind: 'native-tool' }); // Reject invalid merged cursors/filters before remote I/O.
  const local = nativeLocalToolResources().filter(item => !query.status || query.status === item.status);
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
  return nativeDefaultToolsFromCatalog(nativeLocalToolResources(options)).map(resourceId => ({ resourceId }));
}
