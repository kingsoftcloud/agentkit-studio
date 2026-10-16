/** Shared by the existing form and template authoring; secrets stay in the Host. */
export const PLATFORM_KINDS = ['knowledge-base', 'memory-instance', 'skill-space'];
const fail = (code, message) => { throw Object.assign(new Error(message), { code, status: 400 }); };
export async function listPlatformResources(serverClient, kind, { signal } = {}) {
  if (!PLATFORM_KINDS.includes(kind)) fail('INVALID_RESOURCE_KIND', '不支持的平台资源类型');
  const items = [];
  for (let page = 1; page <= 100; page++) {
    const result = await serverClient.listResource(kind, { Page: page, PageSize: 100 }, { signal });
    // Project only selectable metadata, never return backend credentials or configuration.
    items.push(...result.items.map(item => ({ id: item.id || item.resourceId, name: item.name,
      region: item.region, disabled: Boolean(item.disabled), status: item.status })));
    if (!result.items.length || items.length >= Number(result.total)) return {
      items, connectionRef: 'agentengine-server', pluginRef: '@kingsoftcloud/agentkit-studio/platform-resources',
      componentId: kind, pluginSnapshotDigest: 'platform-resources-v1', source: 'agentengine-server',
    };
  }
  fail('RESOURCE_CATALOG_TOO_LARGE', '资源目录过大，请缩小范围');
}
export function platformBinding(kind, id, catalog) {
  if (!PLATFORM_KINDS.includes(kind)) fail('INVALID_RESOURCE_KIND', '不支持的平台资源类型');
  const resource = catalog?.items?.find(item => item.id === id && !item.disabled);
  if (!resource || !catalog.connectionRef) fail('PLATFORM_RESOURCE_UNAVAILABLE', '所选平台资源已不可用，请重新选择');
  const config = { schemaVersion: 1, binding: { id: `platform-${kind}`, connectionRef: catalog.connectionRef,
    resource: { kind, id: resource.id, name: resource.name, region: resource.region }, required: true } };
  if (kind === 'knowledge-base') config.retrieval = { mode: 'tool', topK: 5, maxChars: 16000 };
  if (kind === 'skill-space') Object.assign(config, { selectionMode: 'discovery', selectedSkills: [], includePublic: false, executionMode: 'outer-agent' });
  return { ecosystem: 'dsh', pluginRef: catalog.pluginRef, snapshotDigest: catalog.pluginSnapshotDigest,
    components: [catalog.componentId], enabled: true, config };
}
