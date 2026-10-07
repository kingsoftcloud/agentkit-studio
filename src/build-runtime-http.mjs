/** Authenticated transport for one frozen Build. DSH remains the runtime and history owner. */
import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest();
const identity = value => /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const fail = (code, status = 400) => Object.assign(new Error(code), { code, status });

export async function startBuildRuntimeHttp({ agentId, buildId, token, runner, host = '127.0.0.1', port = 8080, maxActive = 16 } = {}) {
  if (!agentId || !/^build_[0-9a-f]{20}$/.test(buildId || '') || String(token || '').length < 24 || typeof runner !== 'function') throw fail('RUNTIME_CONFIG_INVALID');
  const tokenHash = hash(token);
  const active = new Map();
  let closing = false;
  const json = (res, status, value) => { if (!res.destroyed) { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); } };
  const server = createServer(async (req, res) => {
    let runId, abort, heartbeat;
    try {
      const url = new URL(req.url, 'http://runtime');
      if (req.method === 'GET' && url.pathname === '/health') { json(res, closing ? 503 : 200, { status: closing ? 'stopping' : 'ready' }); return; }
      const bearer = /^Bearer (.+)$/i.exec(String(req.headers.authorization || ''));
      if (req.headers.origin || !bearer || !timingSafeEqual(hash(bearer[1]), tokenHash)) throw fail('RUNTIME_UNAUTHORIZED', 401);
      if (closing) throw fail('RUNTIME_STOPPING', 503);
      const cancel = /^\/runs\/(run_[0-9a-f]{32})\/cancel$/.exec(url.pathname);
      if (req.method === 'POST' && cancel) {
        const target = active.get(cancel[1]);
        if (!target) throw fail('RUNTIME_RUN_NOT_ACTIVE', 404);
        target.abort(fail('RUNTIME_CANCELLED', 409));
        json(res, 202, { runId: cancel[1], cancellationRequested: true }); return;
      }
      if (req.method !== 'POST' || url.pathname !== '/runs') throw fail('RUNTIME_ROUTE_NOT_FOUND', 404);
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw fail('RUNTIME_JSON_REQUIRED', 415);
      const chunks = []; let bytes = 0;
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        bytes += chunk.length;
        if (bytes > 256 * 1024) { req.resume(); throw fail('RUNTIME_INPUT_TOO_LARGE', 413); }
        chunks.push(chunk);
      }
      let input;
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('RUNTIME_INVALID_JSON'); }
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['input', 'sessionId', 'requestId', 'stream'].includes(key))
        || typeof input.input !== 'string' || !input.input.trim() || typeof input.requestId !== 'string' || !identity(input.requestId)
        || (input.sessionId !== undefined && (typeof input.sessionId !== 'string' || !identity(input.sessionId)))
        || (input.stream !== undefined && typeof input.stream !== 'boolean')) throw fail('RUNTIME_INPUT_INVALID');
      const sessionId = `runtime-${hash(`${agentId}\0${buildId}\0${input.sessionId || input.requestId}`).toString('hex').slice(0, 32)}`;
      runId = `run_${hash(`${sessionId}\0${input.requestId}`).toString('hex').slice(0, 32)}`;
      if (active.has(runId)) throw fail('RUNTIME_RUN_ACTIVE', 409);
      if (active.size >= maxActive) throw fail('RUNTIME_BUSY', 429);
      abort = new AbortController(); active.set(runId, abort);
      res.on('close', () => { if (!res.writableEnded) abort.abort(fail('RUNTIME_CLIENT_DISCONNECTED', 499)); });
      const emit = (event, data) => {
        if (res.destroyed || abort.signal.aborted) return;
        const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        if (res.writableLength + Buffer.byteLength(line) > 4 * 1024 * 1024) { abort.abort(fail('RUNTIME_SLOW_CONSUMER')); res.destroy(); return; }
        res.write(line);
      };
      if (input.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
        emit('run.started', { runId, sessionId, agentId, buildId, requestId: input.requestId });
        heartbeat = setInterval(() => { if (!res.destroyed && !abort.signal.aborted) res.write(': keepalive\n\n'); }, 15000); heartbeat.unref();
      }
      const result = await runner({ agentId, buildId, sessionId, occurrenceId: runId, input: input.input, signal: abort.signal,
        ...(input.stream ? { onFrame: frame => emit(frame.kind === 'assistant' ? 'dsh.assistant' : 'dsh.event', frame.value) } : {}) });
      if (abort.signal.aborted) throw abort.signal.reason;
      const value = { ...result, requestId: input.requestId, runtimeRunId: runId, buildId };
      if (input.stream) { emit('run.completed', value); res.end(); } else json(res, 200, value);
    } catch (error) {
      const code = error?.code || 'RUNTIME_RUN_FAILED';
      if (res.headersSent && !res.destroyed) { res.end(`event: run.failed\ndata: ${JSON.stringify({ runId, error: { code } })}\n\n`); }
      else if (!res.destroyed) json(res, error?.status || 500, { error: { code } });
    } finally { clearInterval(heartbeat); if (abort && active.get(runId) === abort) active.delete(runId); }
  });
  server.requestTimeout = 30000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(); }); });
  return {
    address: server.address(),
    close: async () => {
      closing = true;
      for (const abort of active.values()) abort.abort(fail('RUNTIME_STOPPING', 503));
      const closed = new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
      await closed;
    },
  };
}
