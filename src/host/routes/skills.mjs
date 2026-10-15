/** skills operations; authentication and lifetime belong to the dispatcher. */
export function createSkillRoutes({ skillDiscoveryPromise }) {
    return async (endpoint, payload, signal) => {
        if (endpoint === 'skills/discover' || endpoint === 'skills/preview-discovered' || endpoint === 'skills/commit-discovered' || endpoint === 'skills/list' || endpoint === 'skills/preview-installed') {
            const skills = await skillDiscoveryPromise;
            try {
                if (endpoint === 'skills/discover')
                    return { ok: true, value: await skills.discover(Array.isArray(payload?.scanPaths) ? payload.scanPaths : null) };
                if (endpoint === 'skills/preview-discovered')
                    return { ok: true, value: await skills.previewDiscovered(payload?.inspectionToken, payload?.candidateId, String(payload?.path || '')) };
                if (endpoint === 'skills/commit-discovered')
                    return { ok: true, value: await skills.commitDiscovered(payload?.inspectionToken, payload?.candidateId, payload?.overwrite === true) };
                if (endpoint === 'skills/list')
                    return { ok: true, value: await skills.listInstalled() };
                return { ok: true, value: await skills.previewInstalled(payload?.resourceId, String(payload?.path || '')) };
            }
            catch (error) {
                return { ok: false, error: {
                        code: error?.code || 'SKILL_DISCOVERY_FAILED',
                        message: error instanceof Error ? error.message : String(error),
                        details: error?.details || {},
                    } };
            }
        }
    };
}
