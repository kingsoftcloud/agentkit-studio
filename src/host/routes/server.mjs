/** server operations; authentication and lifetime belong to the dispatcher. */
export function createServerActionRoutes({ serverClientPromise, models, syncModelCredential, describeGlobalModelCredential, configurationPromise, credentialsService }) {
    return async (endpoint, payload, signal) => {
        const serverClient = await serverClientPromise;
        if (endpoint === 'server/action') {
            const action = String(payload?.action || '');
            const body = payload?.payload && typeof payload.payload === 'object' ? payload.payload : {};
            if (action === 'settings/get')
                return { ok: true, value: await models.settings() };
            if (action === 'settings/update')
                return { ok: true, value: await models.save(body) };
            if (action === 'models/catalog')
                return { ok: true, value: await models.catalog(String(body.profileId || '')) };
            if (action === 'models/sync-credential')
                return { ok: true, value: await syncModelCredential() };
            if (action === 'models/credential-status')
                return { ok: true, value: await describeGlobalModelCredential({ configuration: await configurationPromise, credentials: credentialsService }) };
            if (action === 'GetAgent') {
                const value = await serverClient.getAgent(String(body.AgentId || body.agentId || ''));
                return { ok: true, value };
            }
            const resourceKinds = { ListKnowledgeBases: 'knowledge-base', ListMemoryInstances: 'memory-instance', ListMCPs: 'mcp', ListSkillWorkspaces: 'skill-space' };
            if (resourceKinds[action]) {
                const value = await serverClient.listResource(resourceKinds[action], body);
                return { ok: true, value };
            }
            const value = await serverClient.action(action, body);
            return { ok: true, value: value.data, requestId: value.requestId };
        }
    };
}
