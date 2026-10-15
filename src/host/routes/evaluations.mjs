/** evaluations operations; authentication and lifetime belong to the dispatcher. */
export function createEvaluationRoutes({ studioEvaluationPromise, listLocalBuildTargets }) {
    return async (endpoint, payload, signal) => {
        try {
            if (endpoint.startsWith('evaluations/')) {
                const evaluation = await studioEvaluationPromise;
                if (!evaluation)
                    return { ok: false, error: { code: 'EVALUATION_UNAVAILABLE', message: '评测模块未初始化', details: {} } };
                if (endpoint === 'evaluations/list')
                    return { ok: true, value: await evaluation.listRuns(payload || {}) };
                if (endpoint === 'evaluations/get')
                    return { ok: true, value: await evaluation.getRun(payload?.runId) };
                if (endpoint === 'evaluations/targets')
                    return { ok: true, value: await evaluation.listTargets({ builds: await listLocalBuildTargets() }) };
                if (endpoint === 'evaluations/evalsets')
                    return { ok: true, value: await evaluation.listEvalsets() };
                if (endpoint === 'evaluations/import')
                    return { ok: true, value: await evaluation.importEvalset({ content: payload?.content, fileName: payload?.fileName }) };
                if (endpoint === 'evaluations/create')
                    return { ok: true, value: await evaluation.createEvaluation(payload || {}) };
            }
        }
        catch (error) {
            return { ok: false, error: { code: error?.code || 'STUDIO_LOCAL_FAILED', message: error instanceof Error ? error.message : String(error), details: error?.details || {} } };
        }
    };
}
