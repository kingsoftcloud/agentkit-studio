import { join } from 'node:path';
/** Domain construction only; state belongs to this Host scope. */
export function createAgentServices({ storeDir: studioStoreDir, studioBuildPromise, deployments, serverClientPromise, managedRuntime }) {
    const agentStorePromise = managedRuntime
        ? import('../../managed-runtime-definition.mjs').then(({ createManagedAgentStore }) => createManagedAgentStore(managedRuntime))
        : import('../../agent-store.mjs').then(({ createAgentStore }) => createAgentStore({ storeDir: join(studioStoreDir, 'agents') }));
    const agentCatalogPromise = import('../../agent-catalog.mjs').then(({ createAgentCatalog }) => createAgentCatalog({ store: () => agentStorePromise,
        builds: async (id) => (await studioBuildPromise).build.list(id), deployments: async () => (await deployments()).agents.list(),
        managedAgents: async query => {
            if (!serverClientPromise) return { items: [], warnings: [] };
            try {
                const client = await serverClientPromise;
                const items = [];
                let page = 1;
                let total = 0;
                do {
                    const result = await client.listAgents({ page, pageSize: 100, query: query.query || '', remoteOnly: true });
                    items.push(...(result.items || []));
                    total = Number(result.total) || items.length;
                    page += 1;
                } while (items.length < total && page < 100);
                return { items, warnings: [] };
            } catch (error) {
                return { items: [], warnings: [{ code: error?.code || 'CLOUD_CATALOG_UNAVAILABLE', message: '托管 Runtime 列表暂不可读取' }] };
            }
        } }));
    const listLocalBuildTargets = async () => { const studio = await studioBuildPromise; const agents = await (await agentStorePromise).list(); return (await Promise.all(agents.map(async (agent) => (await studio.build.list(agent.metadata.id)).map(build => ({ ...build, name: `${agent.metadata.name} · Revision ${build.revision}` }))))).flat().filter(build => build.status === 'SUCCEEDED'); };
    return { agentStorePromise, agentCatalogPromise, listLocalBuildTargets };
}
