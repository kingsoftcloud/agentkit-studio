/** sessions operations; authentication and lifetime belong to the dispatcher. */
export function createSessionRoutes({ ctx, getSessionLogExporter }) {
    return async (endpoint, payload, signal) => {
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
