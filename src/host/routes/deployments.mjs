/** deployments operations; authentication and lifetime belong to the dispatcher. */
export function createDeploymentRoutes({ deployments }) {
    return async (endpoint, payload, signal) => {
        if (endpoint.startsWith('deployments/')) {
            const service = await deployments(), action = endpoint.slice('deployments/'.length);
            const value = await service[action](['prepare', 'create', 'prepareUpdate', 'applyUpdate'].includes(action) ? payload : String(payload?.deploymentId || ''));
            return { ok: true, value };
        }
    };
}
