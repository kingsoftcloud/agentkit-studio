import { join } from 'node:path';
/** Domain construction only; state belongs to this Host scope. */
export function createAgentServices({ storeDir: studioStoreDir, studioBuildPromise, deployments, assistant }) {
    const agentStorePromise = import('../../agent-store.mjs').then(({ createAgentStore }) => createAgentStore({ storeDir: join(studioStoreDir, 'agents') }));
    const agentCatalogPromise = import('../../agent-catalog.mjs').then(({ createAgentCatalog }) => createAgentCatalog({ assistant, store: () => agentStorePromise,
        builds: async (id) => (await studioBuildPromise).build.list(id), deployments: async () => (await deployments()).agents.list() }));
    const listLocalBuildTargets = async () => { const studio = await studioBuildPromise; const agents = await (await agentStorePromise).list(); return (await Promise.all(agents.map(async (agent) => (await studio.build.list(agent.metadata.id)).map(build => ({ ...build, name: `${agent.metadata.name} · Revision ${build.revision}` }))))).flat().filter(build => build.status === 'SUCCEEDED'); };
    return { agentStorePromise, agentCatalogPromise, listLocalBuildTargets };
}
