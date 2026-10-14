import { join } from 'node:path';
import { ownAsyncResource } from '../runtime-bridge.mjs';
/** Domain construction only; state belongs to this Host scope. */
export function createResourceServices(ctx, { storeDir: studioStoreDir, portableRuntime, credentialsService, serverClientPromise }) {
    const skillDiscoveryPromise = import('../../skill-discovery.mjs').then(({ createSkillDiscovery }) => createSkillDiscovery({ storeDir: join(studioStoreDir, 'skills') }));
    const localMcpStorePromise = import('../../local-mcp-store.mjs').then(({ createLocalMcpStore }) => createLocalMcpStore({ storeDir: join(studioStoreDir, 'resources', 'mcp') }));
    const mcpProbePromise = import('../../mcp-probes.mjs').then(({ createMcpProbes }) => createMcpProbes({ storeDir: join(studioStoreDir, 'resources', 'mcp-probes'), localStore: () => localMcpStorePromise, adapters: () => resourceAdaptersPromise }));
    const resourceAdaptersPromise = ownAsyncResource(ctx, Promise.all([
        skillDiscoveryPromise,
        serverClientPromise,
        localMcpStorePromise,
    ]).then(async ([skillDiscovery, serverClient, localMcpStore]) => {
        const { createLocalResourceAdapters } = await import('../../local-resource-adapters.mjs');
        const adapters = createLocalResourceAdapters({ serverClient, skillDiscovery, credentials: credentialsService, resourceStore: portableRuntime?.resourceStore || localMcpStore });
        if (portableRuntime)
            adapters.loadSkill = portableRuntime.loadSkill;
        return adapters;
    }), 'agentkit-studio: resource adapter lifetime');
    return { skillDiscoveryPromise, localMcpStorePromise, mcpProbePromise, resourceAdaptersPromise };
}
