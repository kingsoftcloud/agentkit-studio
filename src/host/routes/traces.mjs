/** traces operations; authentication and lifetime belong to the dispatcher. */
export function createTraceRoutes({ studioObservabilityPromise, serverClientPromise }) {
    return async (endpoint, payload, signal) => {
        const serverClient = await serverClientPromise;
        try {
            if (endpoint.startsWith('traces/')) {
                const observability = await studioObservabilityPromise;
                if (!observability)
                    return { ok: false, error: { code: 'OBSERVABILITY_UNAVAILABLE', message: '观测模块未初始化', details: {} } };
                if (endpoint === 'traces/overview') {
                    const local = await observability.overview(payload || {});
                    try {
                        const cloud = await serverClient.getObservabilityOverview({ range: payload?.range || '24h' }, { signal });
                        const summary = cloud?.Summary || {};
                        return { ok: true, value: { ...local, cloud: { sessionCount: summary.SessionCount, tokenCount: summary.TokenCount, agentRuntimeCount: summary.AgentRuntimeCount, errorCount: summary.ErrorCount, errorRate: summary.ErrorRate } } };
                    }
                    catch {
                        return { ok: true, value: local };
                    }
                }
                if (endpoint === 'traces/list')
                    return { ok: true, value: await observability.list(payload || {}) };
                if (endpoint === 'traces/get')
                    return { ok: true, value: await observability.get(payload?.traceId) };
                if (endpoint === 'traces/otlp')
                    return { ok: true, value: await observability.getOtlp(payload?.traceId) };
            }
        }
        catch (error) {
            return { ok: false, error: { code: error?.code || 'STUDIO_LOCAL_FAILED', message: error instanceof Error ? error.message : String(error), details: error?.details || {} } };
        }
    };
}
