import { join } from 'node:path';
import { ownAsyncResource } from '../runtime-bridge.mjs';
import { optionalResourceAdapter } from './optional-resource.mjs';
/** Domain construction only; state belongs to this Host scope. */
export function createResourceServices(ctx, { storeDir: studioStoreDir, portableRuntime, managedRuntime, credentialsService, serverClientPromise, resourceAdapterFactory, env: runtimeEnv }) {
    const declarationResources = managedRuntime?.declaration?.resources || {};
    // A ManagedRuntime with only inline MCP endpoints is self-contained: its
    // adapter must not wait for the optional Server/catalog or local Skill
    // domains. Those domains may be absent in a minimal production image, while
    // direct MCP discovery still has everything it needs in the manifest.
    const directManagedMcpOnly = Boolean(managedRuntime
      && Object.keys(declarationResources).every(key => key === 'mcp_servers')
      && Array.isArray(declarationResources.mcp_servers)
      && declarationResources.mcp_servers.length > 0
      && declarationResources.mcp_servers.every(item => typeof item?.endpoint === 'string' && item.endpoint));
    const skillDiscoveryPromise = directManagedMcpOnly
      ? Promise.resolve(undefined)
      : import('../../skill-discovery.mjs').then(({ createSkillDiscovery }) => createSkillDiscovery({ storeDir: join(studioStoreDir, 'skills') }));
    const resourceServerPromise = directManagedMcpOnly ? Promise.resolve(undefined) : serverClientPromise;
    const localMcpStorePromise = import('../../local-mcp-store.mjs').then(({ createLocalMcpStore }) => createLocalMcpStore({ storeDir: join(studioStoreDir, 'resources', 'mcp') }));
    const mcpProbePromise = import('../../mcp-probes.mjs').then(({ createMcpProbes }) => createMcpProbes({ storeDir: join(studioStoreDir, 'resources', 'mcp-probes'), localStore: () => localMcpStorePromise, adapters: () => resourceAdaptersPromise }));
    const resourceAdaptersPromise = ownAsyncResource(ctx, optionalResourceAdapter(Promise.all([
        skillDiscoveryPromise,
        resourceServerPromise,
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
        // MCP invocation identity is on by default. A third-party MCP server
        // with hand-written strict request validation can be admitted with
        // AGENTKIT_MCP_INVOCATION_IDENTITY=0 without patching the Host.
        const invocationIdentity = !/^(?:0|false|no|off)$/i.test(String(runtimeEnv?.AGENTKIT_MCP_INVOCATION_IDENTITY ?? '').trim());
        const adapters = await (resourceAdapterFactory || createLocalResourceAdapters)({ serverClient, skillDiscovery, credentials: credentialsService, resourceStore, invocationIdentity });
        if (portableRuntime)
            adapters.loadSkill = portableRuntime.loadSkill;
        return adapters;
    })), 'agentkit-studio: resource adapter lifetime');
    return { skillDiscoveryPromise, localMcpStorePromise, mcpProbePromise, resourceAdaptersPromise };
}
