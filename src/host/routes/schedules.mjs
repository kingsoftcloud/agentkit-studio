/** schedules operations; authentication and lifetime belong to the dispatcher. */
export function createScheduleRoutes({ ctx, agentStorePromise, cloudSchedulesPromise, studioSchedulerPromise }) {
    return async (endpoint, payload, signal) => {
        try {
            if (endpoint.startsWith('schedules/')) {
                if (payload?.scope === 'cloud' || (payload?.agentId && !await (await agentStorePromise).get(payload.agentId))) {
                    return { ok: true, value: await (await cloudSchedulesPromise).execute(endpoint.slice('schedules/'.length), payload) };
                }
                const scheduler = await studioSchedulerPromise;
                if (!scheduler)
                    return { ok: false, error: { code: 'SCHEDULER_UNAVAILABLE', message: '调度器未初始化', details: {} } };
                if (endpoint === 'schedules/list') {
                    const native = ctx.get('schedule');
                    return { ok: true, value: { items: await scheduler.listSchedules(payload?.agentId || undefined), nativeItems: native?.catalog ? await native.catalog() : [], availability: { ...scheduler.availability(), nativeScheduleAvailable: Boolean(native?.catalog) } } };
                }
                if (endpoint === 'schedules/create')
                    return { ok: true, value: await scheduler.createSchedule(payload?.agentId || '', payload?.spec || payload) };
                if (endpoint === 'schedules/get')
                    return { ok: true, value: await scheduler.getSchedule(payload?.taskId) };
                if (endpoint === 'schedules/update')
                    return { ok: true, value: await scheduler.updateSchedule(payload?.taskId, { ...(payload?.patch || payload), ...(payload?.agentId ? { agentId: payload.agentId } : {}) }) };
                if (endpoint === 'schedules/delete')
                    return { ok: true, value: await scheduler.deleteSchedule(payload?.taskId) };
                if (endpoint === 'schedules/run')
                    return { ok: true, value: await scheduler.runNow(payload?.taskId) };
                if (endpoint === 'schedules/occurrences')
                    return { ok: true, value: { items: await scheduler.listOccurrences(payload?.taskId, payload?.agentId) } };
            }
        }
        catch (error) {
            return { ok: false, error: { code: error?.code || 'STUDIO_LOCAL_FAILED', message: error instanceof Error ? error.message : String(error), details: error?.details || {} } };
        }
    };
}
