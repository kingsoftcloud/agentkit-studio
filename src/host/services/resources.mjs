import { join } from 'node:path';
import { ownAsyncResource } from '../runtime-bridge.mjs';
import { optionalResourceAdapter } from './optional-resource.mjs';
/** Domain construction only; state belongs to this Host scope. */
export function createResourceServices(ctx, { storeDir: studioStoreDir, portableRuntime, managedRuntime, credentialsService, serverClientPromise, resourceAdapterFactory }) {
    const skillDiscoveryPromise = import('../../skill-discovery.mjs').then(({ createSkillDiscovery }) => createSkillDiscovery({ storeDir: join(studioStoreDir, 'skills') }));
    const localMcpStorePromise = import('../../local-mcp-store.mjs').then(({ createLocalMcpStore }) => createLocalMcpStore({ storeDir: join(studioStoreDir, 'resources', 'mcp') }));
    const mcpProbePromise = import('../../mcp-probes.mjs').then(({ createMcpProbes }) => createMcpProbes({ storeDir: join(studioStoreDir, 'resources', 'mcp-probes'), localStore: () => localMcpStorePromise, adapters: () => resourceAdaptersPromise }));
    const resourceAdaptersPromise = ownAsyncResource(ctx, optionalResourceAdapter(Promise.all([
        skillDiscoveryPromise,
        serverClientPromise,
        localMcpStorePromise,
    ]).then(async ([skillDiscovery, serverClient, localMcpStore]) => {
        const { createLocalResourceAdapters } = await import('../../local-resource-adapters.mjs');
        const managedMcpServers = new Map((managedRuntime?.declaration?.resources?.mcp_servers || []).map(item => [String(item.id), {
            resourceId: String(item.id), endpointUrl: item.endpoint, transport: item.transport || 'http',
            ...(item.env_refs ? { envRefs: item.env_refs } : {}),
        }]));
        const resourceStore = {
            get: async id => managedMcpServers.get(String(id)) || await portableRuntime?.resourceStore?.get(id) || await localMcpStore.get(id),
        };
        const adapters = await (resourceAdapterFactory || createLocalResourceAdapters)({ serverClient, skillDiscovery, credentials: credentialsService, resourceStore });
        if (portableRuntime)
            adapters.loadSkill = portableRuntime.loadSkill;
        return adapters;
    })), 'agentkit-studio: resource adapter lifetime');
    return { skillDiscoveryPromise, localMcpStorePromise, mcpProbePromise, resourceAdaptersPromise };
}
