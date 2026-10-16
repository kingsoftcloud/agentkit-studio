/** agents operations; authentication and lifetime belong to the dispatcher. */
export function createAgentRoutes({ agentStorePromise, agentCatalogPromise, studioBuildPromise, deployments, getAdmission, serverClientPromise, templateAuthoring }) {
    return async (endpoint, payload, signal) => {
        const serverClient = await serverClientPromise;
        if (endpoint === 'agents/local-delete') {
            const store = await agentStorePromise;
            try {
                const record = await store.get(String(payload?.agentId || ''));
                if (!record)
                    return { ok: false, error: { code: 'AGENT_NOT_FOUND', message: '本地 Agent 不存在', details: {} } };
                await store.remove(String(payload.agentId));
                return { ok: true, value: { agentId: String(payload.agentId), deleted: true } };
            }
            catch (error) {
                return { ok: false, error: { code: error?.code || 'LOCAL_AGENT_FAILED', message: error instanceof Error ? error.message : String(error), details: {} } };
            }
        }
        if (endpoint === 'agents/create-local' || endpoint === 'agents/local-get' || endpoint === 'agents/update-local') {
            const store = await agentStorePromise;
            try {
                if (endpoint === 'agents/create-local') {
                    const record = await templateAuthoring.create({
                        templateSource: payload?.templateSource,
                        name: payload?.name,
                        runtimeType: payload?.runtimeType || payload?.spec?.runtime?.type || 'dsh-native',
                        description: payload?.description || payload?.spec?.description || '',
                        spec: payload?.spec || {},
                        bindings: payload?.bindings || payload?.spec?.bindings || {},
                    });
                    return { ok: true, value: { ...record, builds: [] } };
                }
                if (endpoint === 'agents/local-get')
                    return { ok: true, value: await store.get(String(payload?.agentId || '')) };
                const record = await store.update(String(payload?.agentId || ''), {
                    name: payload?.name, description: payload?.description,
                    spec: payload?.spec, bindings: payload?.bindings,
                });
                return { ok: true, value: { ...record, builds: [] } };
            }
            catch (error) {
                return { ok: false, error: { code: error?.code || 'LOCAL_AGENT_FAILED', message: error instanceof Error ? error.message : String(error), details: error?.details || {} } };
            }
        }
        if (endpoint === 'agents/update-cloud') {
            const agentId = String(payload?.agentId || '').trim();
            if (!agentId)
                return { ok: false, error: { code: 'INVALID_AGENT_ID', message: 'AgentId 不能为空', details: {} } };
            const { buildCloudAgentUpdate } = await import('../../server-client.mjs');
            const update = buildCloudAgentUpdate(agentId, {
                spec: payload?.spec || {},
                name: payload?.name,
                description: payload?.spec?.description,
            });
            await serverClient.action('UpdateAgent', update, { signal });
            try {
                return { ok: true, value: await serverClient.getAgent(agentId, { signal }) };
            }
            catch {
                return { ok: true, value: { metadata: { id: agentId, name: update.Name || agentId, revision: Number(payload?.revision || 1) + 1 }, spec: payload?.spec || {} } };
            }
        }
        if (endpoint === 'agents/list') {
            return { ok: true, value: await (await agentCatalogPromise).list(payload, { signal }) };
        }
        if (endpoint === 'agents/ensure-preset') {
            const agentId = String(payload?.agentId || '').trim();
            if (!agentId)
                return { ok: false, error: { code: 'INVALID_AGENT_ID', message: 'AgentId 不能为空', details: {} } };
            try {
                const localStore = await agentStorePromise;
                const local = await localStore.get(agentId);
                if (!local)
                    await (await deployments()).agents.connect(agentId);
                const buildId = String(payload?.buildId || '').trim();
                const build = buildId ? await (await studioBuildPromise).build.resolve(agentId, buildId) : null;
                // The no-build path remains the original local admission contract:
                // getAdmission().ensure(agentId, { agent: local }).
                const value = local
                    ? await getAdmission().ensure(agentId, { agent: build ? { ...build, metadata: { ...local.metadata, ...build.metadata, local: true } } : local })
                    : await getAdmission().ensure(agentId);
                return { ok: true, value };
            }
            catch (error) {
                return { ok: false, error: {
                        code: error?.code || 'DSH_PRESET_ADMISSION_FAILED',
                        message: error instanceof Error ? error.message : String(error),
                        details: error?.details || {},
                    } };
            }
        }
        if (endpoint === 'agents/conversation-surface') {
            // A cloud Agent can run through the existing Session/Run Actions. A
            // local Studio Build is not required for this transport; Build is a
            // separate deployment concern and remains explicitly unsupported.
            const agentId = String(payload?.agentId || '').trim();
            if (!agentId)
                return { ok: false, error: { code: 'INVALID_AGENT_ID', message: 'AgentId 不能为空', details: {} } };
            try {
                const agent = await serverClient.getAgent(agentId, { signal });
                const sessionId = String(payload?.sessionId || '').trim();
                if (!sessionId)
                    return { ok: false, error: { code: 'INVALID_SESSION_ID', message: 'SessionId 不能为空', details: { agentId } } };
                try {
                    await serverClient.action('GetSession', { SessionId: sessionId }, { signal });
                }
                catch (error) {
                    if (error?.status !== 404)
                        throw error;
                    await serverClient.action('CreateSession', { AgentId: agentId, SessionId: sessionId, Tags: { source: 'agentkit-studio' } }, { signal });
                }
                const history = await serverClient.action('ListSessionEvents', { AgentId: agentId, SessionId: sessionId, Limit: 200 }, { signal });
                return { ok: true, value: { agentId, sessionId, transport: 'agentengine-action', events: history.data?.Events || [], watermark: history.data?.AfterSeqId || 0 } };
            }
            catch (error) {
                return { ok: false, error: {
                        code: error?.code === 'SERVER_ACTION_FAILED' && error?.status === 404 ? 'AGENT_NOT_FOUND' : (error?.code || 'CONVERSATION_SURFACE_FAILED'),
                        message: error instanceof Error ? error.message : String(error),
                        details: error?.details || {},
                    } };
            }
        }
    };
}
