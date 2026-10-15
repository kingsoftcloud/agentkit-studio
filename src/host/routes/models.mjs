/** models operations; authentication and lifetime belong to the dispatcher. */
export function createModelRoutes({ models, syncModelCredential, describeGlobalModelCredential, configurationPromise, credentialsService, listCodexAgentModels, codexModels }) {
    return async (endpoint, payload, signal) => {
        if (endpoint === 'models/sync-credential')
            return { ok: true, value: await syncModelCredential() };
        if (endpoint === 'models/credential-status')
            return { ok: true, value: await describeGlobalModelCredential({ configuration: await configurationPromise, credentials: credentialsService }) };
        if (endpoint === 'models/create')
            return { ok: true, value: await models.create(payload) };
        if (endpoint === 'settings/get')
            return { ok: true, value: await models.settings() };
        if (endpoint === 'settings/update')
            return { ok: true, value: await models.save(payload) };
        if (endpoint === 'models/catalog')
            return { ok: true, value: await models.catalog(String(payload?.profileId || '')) };
        if (endpoint === 'models/codex')
            return { ok: true, value: await listCodexAgentModels({ models, catalog: codexModels }) };
    };
}
