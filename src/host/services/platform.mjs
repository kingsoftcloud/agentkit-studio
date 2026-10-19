import { createCloudRuntimeFetch } from '../../cloud-runtime-fetch.mjs';
/** Domain construction only; state belongs to this Host scope. */
export function createPlatformServices(ctx, { env: runtimeEnv, portableRuntime, cloudEndpointOptions, configurationHome }) {
    const configurationPromise = import('../../global-config.mjs').then(({ createGlobalConfiguration }) => createGlobalConfiguration({ env: runtimeEnv, home: configurationHome, inheritLegacy: !portableRuntime }));
    const credentialsService = ctx.get('credentials');
    const serverClientPromise = configurationPromise.then(configuration => import('../../server-client.mjs').then(({ createAgentEngineClient }) => createAgentEngineClient({
        configuration,
        sessionToken: runtimeEnv.AGENTKIT_STUDIO_HOST_SESSION_TOKEN || '',
        serverUrl: runtimeEnv.AGENTKIT_STUDIO_HOST_URL || '',
        ...cloudEndpointOptions,
    })));
    const deploymentClientPromise = Promise.all([import('../../server-client.mjs'), configurationPromise])
        .then(([{ createAgentEngineDeploymentClient }, configuration]) => createAgentEngineDeploymentClient({ configuration, ...cloudEndpointOptions }));
    const runtimeFetch = createCloudRuntimeFetch({ configuration: configurationPromise });
    ctx.effect(() => () => runtimeFetch.close(), 'agentkit-studio: cloud runtime transport lifetime');
    return { configurationPromise, credentialsService, serverClientPromise, deploymentClientPromise, runtimeFetch };
}
