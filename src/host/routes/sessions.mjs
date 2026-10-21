/** sessions operations; authentication and lifetime belong to the dispatcher. */
export function createSessionRoutes({ ctx, getSessionLogExporter, getNativeHost }) {
    return async (endpoint, payload, signal) => {
        if (endpoint === 'sessions/native-child-history' || endpoint === 'sessions/native-child-result') {
            const result = endpoint === 'sessions/native-child-result';
            const allowed = ['agentId', 'sessionId', 'runId', 'offset', 'limit', ...(result ? ['childRunId'] : ['inventoryDigest'])];
            const required = ['agentId', 'sessionId', ...(result ? ['childRunId'] : [])];
            if (!payload || Array.isArray(payload) || Object.keys(payload).some(key => !allowed.includes(key))
                || required.some(key => typeof payload[key] !== 'string' || !payload[key].trim() || payload[key].length > 256)
                || payload.runId !== undefined && (typeof payload.runId !== 'string' || !payload.runId.trim() || payload.runId.length > 256)
                || payload.offset !== undefined && (!Number.isSafeInteger(payload.offset) || payload.offset < 0)
                || payload.limit !== undefined && (!Number.isSafeInteger(payload.limit) || payload.limit < 1 || payload.limit > (result ? 16000 : 64))
                || !result && payload.inventoryDigest !== undefined && (typeof payload.inventoryDigest !== 'string' || !/^[0-9a-f]{64}$/.test(payload.inventoryDigest)))
                throw Object.assign(new Error('Invalid Native child history request'), { code: 'STUDIO_NATIVE_CHILD_HISTORY_INVALID' });
            if (typeof getNativeHost !== 'function')
                throw Object.assign(new Error('Native child history unavailable'), { code: 'STUDIO_NATIVE_CHILD_HISTORY_UNAVAILABLE' });
            signal?.throwIfAborted();
            const host = await getNativeHost();
            signal?.throwIfAborted();
            return { ok: true, value: result ? host.childResult(payload) : host.childHistory(payload) };
        }
        if (['sessions/native-child-tasks', 'sessions/native-child-promote', 'sessions/native-child-send', 'sessions/native-child-cancel'].includes(endpoint)) {
            const promote = endpoint === 'sessions/native-child-promote';
            const send = endpoint === 'sessions/native-child-send', cancel = endpoint === 'sessions/native-child-cancel';
            const mutate = promote || send || cancel;
            const allowed = mutate ? ['agentId', 'sessionId', 'runId', 'childRunId', 'commandId', ...(send ? ['text', 'expectedGoalRevision'] : [])] : ['agentId', 'sessionId', 'runId'];
            const required = mutate ? ['agentId', 'sessionId', 'runId', 'childRunId', 'commandId'] : ['agentId', 'sessionId'];
            if (!payload || Object.keys(payload).some(key => !allowed.includes(key))
                || required.some(key => typeof payload[key] !== 'string' || !payload[key].trim() || payload[key].length > 256)
                || payload.runId !== undefined && (typeof payload.runId !== 'string' || !payload.runId.trim() || payload.runId.length > 256)
                || send && (typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > 32768
                  || !Number.isSafeInteger(payload.expectedGoalRevision) || payload.expectedGoalRevision < 0))
                throw Object.assign(new Error('Invalid Native child control request'), { code: 'STUDIO_NATIVE_CHILD_CONTROL_INVALID' });
            if (typeof getNativeHost !== 'function')
                throw Object.assign(new Error('Native child controls unavailable'), { code: 'STUDIO_NATIVE_CHILD_CONTROL_UNAVAILABLE' });
            signal?.throwIfAborted();
            const host = await getNativeHost();
            signal?.throwIfAborted();
            return { ok: true, value: promote ? host.promoteChild(payload) : send ? host.sendChildInput(payload)
                : cancel ? host.cancelChild(payload) : host.childTasks(payload) };
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
