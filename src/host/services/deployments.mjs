import { join } from 'node:path';
/** Domain construction only; state belongs to this Host scope. */
export function createDeploymentServices({ storeDir: studioStoreDir, env: runtimeEnv, studioBuildPromise, resourceAdaptersPromise, configurationPromise, credentialsService, cloudEndpointOptions, getModels, getPortableBundles, runtimeFetch }) {
    let deploymentsPromise;
    const deployments = () => deploymentsPromise ||= Promise.all([import('../../studio-deployments.mjs'), import('../../server-client.mjs'), configurationPromise, studioBuildPromise, resourceAdaptersPromise])
        .then(([{ createStudioDeployments }, { createAgentEngineDeploymentClient }, configuration, studio, adapters]) => createStudioDeployments({
        storeDir: join(studioStoreDir, 'deployments'), ...studio, portableBundles: getPortableBundles(), models: getModels(), adapters, credentials: credentialsService, configuration, env: runtimeEnv,
        client: createAgentEngineDeploymentClient({ configuration, ...cloudEndpointOptions }), fetchImpl: runtimeFetch,
    }));
    return { deployments };
}
