import { validateDshA2aRequest } from '../services/dsh-a2a-control.mjs';
/** Session export and independent Host controls. Old in-process controls
 * are deliberately unavailable, including to embedders that supply a Host. */
export function createSessionRoutes({ ctx, getSessionLogExporter, getDshA2aControls }) {
    return async (endpoint, payload, signal) => {
        signal?.throwIfAborted();
        if (endpoint.startsWith('sessions/native-'))
            throw Object.assign(new Error('此操作属于已退役的进程内 Harness 会话。'), { code: 'STUDIO_LEGACY_HARNESS_RETIRED' });
        if (endpoint === 'sessions/dsh-a2a-history' || endpoint === 'sessions/dsh-a2a-control') {
            const control = endpoint === 'sessions/dsh-a2a-control'; validateDshA2aRequest(payload, control);
            if (typeof getDshA2aControls !== 'function')
                throw Object.assign(new Error('DSH A2A controls unavailable'), { code: 'STUDIO_DSH_A2A_UNAVAILABLE' });
            signal?.throwIfAborted(); const service = await getDshA2aControls(); signal?.throwIfAborted();
            return { ok: true, value: await (control ? service.control(payload, signal) : service.history(payload, signal)) };
        }
        if (endpoint === 'sessions/export-log') {
            const sessionId = String(payload?.sessionId || '').trim();
            if (!sessionId)
                throw Object.assign(new Error('Session ID 不能为空'), { code: 'SESSION_ID_MISSING' });
            const { readSessionLogText, flushLiveSessionLog, sessionLogExportDeps } = await getSessionLogExporter();
            const deps = sessionLogExportDeps(ctx);
            if (!deps.sessionPersistence)
                throw Object.assign(new Error('DSH Session 持久化不可用'), { code: 'SESSION_EXPORT_UNAVAILABLE' });
            await flushLiveSessionLog(deps, sessionId, signal);
            const content = await readSessionLogText(deps.sessionPersistence, sessionId, signal);
            if (content === undefined)
                throw Object.assign(new Error('Session 不存在'), { code: 'SESSION_NOT_FOUND' });
            if (Buffer.byteLength(content) > 8 * 1024 * 1024)
                throw Object.assign(new Error('会话日志超过 8 MiB，请从原生会话使用 /export 导出完整 ZIP'), { code: 'SESSION_EXPORT_TOO_LARGE' });
            return { ok: true, value: { content, filename: `dsh-session-${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.jsonl`, contentType: 'application/x-ndjson' } };
        }
    };
}
