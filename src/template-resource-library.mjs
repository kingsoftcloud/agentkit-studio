/** Available presets are separate from installed/selectable Agent resources. */
import { paginateResources } from './resource-catalog.mjs';
import { catalogSkillId } from './catalog-dependencies.mjs';
export function createTemplateResourceLibrary({ catalog, dependencies, skills, mcps, credentials }) {
  const refOf = value => ({ id: value.id, digest: value.digest });
  const matches = (row, item) => row.name === item.preset?.key && row.server?.transport === item.preset?.server?.transport
    && (row.server?.transport === 'stdio' ? row.server.command === item.preset.server.command
      && JSON.stringify(row.server.args || []) === JSON.stringify(item.preset.server.args || []) : row.server?.endpointUrl === item.preset?.server?.endpointUrl);
  async function installed(item) {
    if (item.kind === 'skill') {
      const assets = catalog.resource(refOf(item)).dependencies;
      const id = catalogSkillId(assets.package, assets.skills[0]);
      return (await skills.listInstalled()).items.find(row => row.resourceId === id);
    }
    return (await mcps.list({ limit: Infinity })).find(row => matches(row, item));
  }
  return {
    async list(query = {}) {
      const localSkills = new Set((await skills.listInstalled()).items.map(row => row.resourceId)), localMcps = await mcps.list({ limit: Infinity });
      const remote = catalog.isRemote ? await catalog.listResources(query) : null;
      const rows = (remote?.items || catalog.resources()).filter(row => row.kind === query.kind).map(item => {
        let local;
        if (item.kind === 'skill') { const assets = item.dependencySummary ? {package:{digest:item.dependencySummary.packageDigest},skills:[item.dependencySummary.skill]} : catalog.resource(refOf(item)).dependencies; const id = catalogSkillId(assets.package, assets.skills[0]); if (localSkills.has(id)) local = { resourceId: id, status: 'ready' }; }
        else local = localMcps.find(row => matches(row, item));
        const { preset, ...metadata } = item;
        return { ...metadata, resourceId: item.id, installed: Boolean(local), installedResourceId: local?.resourceId, installedStatus: local?.status,
          requiresConfiguration: item.kind === 'mcp' && (preset.setupReasons?.length > 0 || preset.requiredCredentials?.length > 0 || preset.authorizationRequired),
          installable: item.kind === 'skill' || Boolean(preset?.server?.endpointUrl || preset?.server?.command),
          setupReasons: preset?.setupReasons || [], authType: preset?.authType, endpointUrl: preset?.server?.endpointUrl };
      });
      return remote ? {...remote,items:rows} : paginateResources(rows, query, { source: 'personal-catalog' });
    },
    async install(ref, options = {}) {
      await catalog.ensure?.(ref,'skill',options);
      const item = catalog.resource(ref);
      if (item.kind !== 'skill') throw Object.assign(new Error('MCP 需要确认当前连接配置后再探测'), { code: 'MCP_CONFIGURATION_REQUIRED' });
      return { items: await dependencies.materialize(item,options), fileCount: item.fileCount };
    },
    async prepare(ref) {
      await catalog.ensure?.(ref,'mcp');
      const item = catalog.resource(ref);
      if (item.kind !== 'mcp') throw new Error('请选择 MCP 连接器');
      const preset = item.preset, current = await installed(item);
      const requiredCredentials = await Promise.all((preset.requiredCredentials || []).map(async row => ({ ...row, configured: Boolean((await credentials.describe(row.name))?.configured) })));
      return { ...(current || {}), name: preset.key, displayName: item.name, description: item.description, version: item.version, server: current?.server || preset.server,
        catalogRef: refOf(item), requiredCredentials, setupReasons: preset.setupReasons || [], authorizationRequired: preset.authorizationRequired === true };
    },
  };
}
