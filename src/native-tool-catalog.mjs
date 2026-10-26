/** Native-owned additions to the legacy tool catalog. Catalog rows describe
 * capabilities; execution still requires an explicitly bound Native Build. */
import { workspacePatchDefinition, workspaceRewindDefinitions, workspaceToolDefinitions } from '../packages/agentkit-harness/src/native/workspace-tools.mjs';
import { paginateResources } from './resource-catalog.mjs';
const definitions = () => [workspacePatchDefinition(), ...workspaceRewindDefinitions(), ...workspaceToolDefinitions()];

export function nativeLocalToolContract(name) {
  const definition = definitions().find(tool => tool.name === name);
  if (!definition) return undefined;
  return contractForDefinition(definition);
}
function contractForDefinition(definition) {
  return { resourceId: definition.name, name: definition.name, description: definition.description,
    parameters: definition.parameters, executor: 'builtin', enabled: true,
    timeoutSeconds: definition.timeoutMs / 1000, sideEffect: definition.readOnly ? 'none' : 'workspace', permissions: definition.permissions };
}

export function nativeLocalToolResources() {
  return definitions().map(tool => {
    const contract = contractForDefinition(tool), { parameters, ...metadata } = contract;
    return { resourceId: contract.resourceId, name: contract.name,
      displayName: tool.name === 'apply_workspace_patch' ? '结构化文件补丁 · Native' : `${tool.name} · Native`, description: contract.description,
      kind: 'tool', source: 'studio-native', status: 'available', contract: { ...metadata, inputSchema: parameters } };
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
