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
        if (endpoint === 'models/catalog') {
            const profileId = String(payload?.profileId || '');
            const value = payload?.includeCards === true
                ? await models.catalog(profileId, { includeCards: true })
                : await models.catalog(profileId);
            return { ok: true, value };
        }
        if (endpoint === 'models/cards')
            return { ok: true, value: await models.cards() };
        if (endpoint === 'models/probe')
            return { ok: true, value: await models.probe(payload || {}) };
        if (endpoint === 'models/wire')
            return { ok: true, value: await models.probeWire(payload || {}, signal) };
        if (endpoint === 'models/efforts')
            return { ok: true, value: await models.probeEfforts(payload || {}, signal) };
        if (endpoint === 'models/codex')
            return { ok: true, value: await listCodexAgentModels({ models, catalog: codexModels }) };
    };
}
