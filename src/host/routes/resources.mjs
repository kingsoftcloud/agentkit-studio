/** Resource operations behind the existing authenticated dispatch boundary. */
import { listStudioTools } from '../../native-tool-catalog.mjs';
export function createResourceRoutes({
  models, serverClientPromise, localMcpStorePromise, skillDiscoveryPromise, mcpProbePromise,
}) {
  return async (endpoint, payload, signal) => {
    const serverClient = await serverClientPromise;
    if (endpoint === 'resources/list') {
      const kind = String(payload?.kind || '').trim();
      if (!kind || ['model', 'skill', 'mcp', 'knowledge-base', 'memory-instance'].includes(kind)) {
        const { listStudioResources, listStudioRuntimeResources } = await import('../../resource-catalog.mjs');
        return { ok: true, value: await (kind ? listStudioResources : listStudioRuntimeResources)({ query: payload, models, serverClient, signal,
          localMcpStore: await localMcpStorePromise, skillDiscovery: await skillDiscoveryPromise, mcpProbes: await mcpProbePromise }) };
      }
      if (kind === 'tool') {
        const value = await listStudioTools({ query: payload, serverClient, signal });
        return { ok: true, value };
      }
      const resourceKind = kind;
      const value = await serverClient.listResource(resourceKind, { Page: 1, PageSize: Math.min(Number(payload?.limit || 100), 100) }, { signal });
      return { ok: true, value };
    }
    if (endpoint === 'mcp/create') {
      const localStore = await localMcpStorePromise;
      return { ok: true, value: await localStore.create(payload || {}) };
    }
    if (endpoint === 'mcp/update') {
      const localStore = await localMcpStorePromise;
      const resourceId = String(payload?.resourceId || '').trim();
      return { ok: true, value: await localStore.update(resourceId, payload || {}) };
    }
    if (endpoint === 'mcp/probe') {
      const resourceId = String(payload?.resourceId || '').trim();
      return { ok: true, value: await (await mcpProbePromise).probe(resourceId) };
    }
    if (endpoint === 'mcp/delete' || endpoint === 'resources/delete') {
      const { deleteStudioMcp } = await import('../../resource-lifecycle.mjs');
      return { ok: true, value: await deleteStudioMcp(payload, { localStore: await localMcpStorePromise, serverClient: await serverClientPromise }) };
    }
  };
}
