/** Domain construction only; state belongs to this Host scope. */
export function createPlatformServices(ctx, { env: runtimeEnv, portableRuntime, cloudEndpointOptions }) {
    const configurationPromise = import('../../global-config.mjs').then(({ createGlobalConfiguration }) => createGlobalConfiguration({ env: runtimeEnv, inheritLegacy: !portableRuntime }));
    const credentialsService = ctx.get('credentials');
    const serverClientPromise = configurationPromise.then(configuration => import('../../server-client.mjs').then(({ createAgentEngineClient }) => createAgentEngineClient({
        configuration,
        sessionToken: runtimeEnv.AGENTKIT_STUDIO_HOST_SESSION_TOKEN || '',
        serverUrl: runtimeEnv.AGENTKIT_STUDIO_HOST_URL || 'http://127.0.0.1:8789',
        ...cloudEndpointOptions,
    })));
    const deploymentClientPromise = Promise.all([import('../../server-client.mjs'), configurationPromise])
        .then(([{ createAgentEngineDeploymentClient }, configuration]) => createAgentEngineDeploymentClient({ configuration, ...cloudEndpointOptions }));
    return { configurationPromise, credentialsService, serverClientPromise, deploymentClientPromise };
}
