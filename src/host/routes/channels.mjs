/** channels operations; authentication and lifetime belong to the dispatcher. */
export function createChannelRoutes({ studioChannelsPromise }) {
    return async (endpoint, payload, signal) => {
        try {
            if (endpoint.startsWith('channels/')) {
                const channels = await studioChannelsPromise;
                if (!channels)
                    return { ok: false, error: { code: 'CHANNELS_UNAVAILABLE', message: '渠道模块未初始化', details: {} } };
                if (endpoint === 'channels/connection')
                    return { ok: true, value: await channels.getConnection() };
                if (endpoint === 'channels/update')
                    return { ok: true, value: await channels.updateConnection(payload || {}) };
                if (endpoint === 'channels/agent-update')
                    return { ok: true, value: await channels.updateAgentConnection(payload?.agentId, payload || {}) };
                if (endpoint === 'channels/action')
                    return { ok: true, value: await channels.proxyAction(payload?.action || '', payload?.payload || {}) };
            }
        }
        catch (error) {
            return { ok: false, error: { code: error?.code || 'STUDIO_LOCAL_FAILED', message: error instanceof Error ? error.message : String(error), details: error?.details || {} } };
        }
    };
}
