/** Domain construction only; state belongs to this Host scope. */
export function createAuthoringServices(ctx, { serverClientPromise, agentStorePromise, configurationPromise, skillDiscoveryPromise, getTemplateAuthoring }) {
    // Authoring tools + resource catalogs read cloud/resource data through this
    // in-process remote — the legacy 8789 local Studio Host no longer exists.
    const authoringRemoteFactory = signal => Promise.all([serverClientPromise, agentStorePromise]).then(([serverClient]) => ({
        exchangeSession: async () => { },
        resources: async (query) => {
            const kind = new URLSearchParams(String(query || '')).get('kind') || 'model';
            if (kind === 'model') {
                const configuration = await configurationPromise;
                const credentials = ctx.get('credentials');
                const models = await import('../../model-service.mjs').then(({ createModelService }) => createModelService({ configuration, credentials }));
                const catalog = await models.catalog('');
                return { items: catalog.items.map(item => ({ resourceId: item.id, name: item.name || item.id })) };
            }
            if (kind === 'skill')
                return (await skillDiscoveryPromise).listInstalled();
            const actions = { mcp: 'ListMCPs' };
            const action = actions[kind];
            if (!action)
                return { items: [] };
            const serverClient = await serverClientPromise;
            const result = await serverClient.action(action, { Page: 1, PageSize: 100 }, { signal });
            const raw = result.data || {};
            const rows = raw.MCPs || raw.SkillWorkspaces || raw.KnowledgeBases || raw.MemoryInstances || raw.Items || [];
            return { items: rows.map(row => ({ resourceId: String(row.mcp_id || row.Id || row.id || ''), name: String(row.display_name || row.Name || row.name || row.mcp_id || row.Id || row.id || '') })) };
        },
        quickAuthorAgent: async (payload) => {
            const record = await getTemplateAuthoring().create({ ...payload, bindings: payload?.spec?.bindings || {} });
            return { metadata: record.metadata, spec: record.spec };
        },
    }));
    return { authoringRemoteFactory };
}
