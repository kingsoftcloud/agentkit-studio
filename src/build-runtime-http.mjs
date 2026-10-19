/** Authenticated transport for one frozen Build. DSH remains the runtime and history owner. */
import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createRuntimeResponsesContract } from './runtime-responses-contract.mjs';
import { createRuntimeResponsesStream } from './runtime-responses-stream.mjs';
import { assistantInputLimit } from './assistant-transport.mjs';
import { ASSISTANT_MANAGED_PERMISSION_CAPABILITY } from './contracts/assistant-capabilities.mjs';
import { ASSISTANT_NATIVE_CAPABILITY, isAssistantNativeOperation } from './contracts/assistant-native.mjs';
import { ASSISTANT_ATTACHMENT_CAPABILITIES } from './contracts/assistant-attachments.mjs';

const hash = value => createHash('sha256').update(value).digest();
const identity = value => /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const fail = (code, status = 400) => Object.assign(new Error(code), { code, status });

export async function startBuildRuntimeHttp({ agentId, buildId, bundleSha256 = '', deploymentVersion = 'initial', token, runner, validatePrevious, assistant, model = '', models = [model], host = '127.0.0.1', port = 8080, maxActive = 16 } = {}) {
  if (!agentId || !/^build_[0-9a-f]{20}$/.test(buildId || '') || String(token || '').length < 24 || typeof runner !== 'function') throw fail('RUNTIME_CONFIG_INVALID');
  const tokenHash = hash(token);
  const responses = createRuntimeResponsesContract({ agentId, buildId, token, model, models });
  const active = new Map();
  let closing = false;
  const json = (res, status, value) => { if (!res.destroyed) { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); } };
  const server = createServer(async (req, res) => {
    let runId, abort, heartbeat, projection;
    try {
      const url = new URL(req.url, 'http://runtime');
      if (req.method === 'GET' && url.pathname === '/health') { json(res, closing ? 503 : 200, { status: closing ? 'stopping' : 'ready' }); return; }
      const bearer = /^Bearer (.+)$/i.exec(String(req.headers.authorization || ''));
      if (req.headers.origin || !bearer || !timingSafeEqual(hash(bearer[1]), tokenHash)) throw fail('RUNTIME_UNAUTHORIZED', 401);
      if (closing) throw fail('RUNTIME_STOPPING', 503);
      if (assistant?.retiring?.() && !['/v1/assistant/close', '/v1/agentkit/runtime'].includes(url.pathname)) throw fail('ASSISTANT_CLOSED', 410);
      if (req.method === 'GET' && url.pathname === '/v1/agentkit/runtime') {
        json(res, 200, { format: 'agentkit.runtime-identity/v1', status: 'ready', agentId, buildId, bundleSha256, deploymentVersion, model, models, capabilities: ['bound-model-selection', 'resource-checks', ...(assistant ? ['personal-assistant/v1', ...(assistant.managedPermissionsSupported ? [ASSISTANT_MANAGED_PERMISSION_CAPABILITY] : []), ...(assistant.nativeCarrierSupported ? [ASSISTANT_NATIVE_CAPABILITY] : []), ...(assistant.scopedCancelSupported ? ['personal-assistant-cancel-turn/v1'] : []), ...(assistant.imageReadSupported ? ['personal-assistant-images/v1'] : []), ...(assistant.attachmentUploadSupported ? [ASSISTANT_ATTACHMENT_CAPABILITIES.upload] : []), ...(assistant.contentSupported ? [ASSISTANT_ATTACHMENT_CAPABILITIES.content] : []), ...(assistant.fileReadSupported ? [ASSISTANT_ATTACHMENT_CAPABILITIES.read] : []), ...(assistant.approvalBridgeSupported ? ['personal-assistant-approval-bridge/v1'] : []), ...(assistant.deletionSupported ? ['personal-assistant-delete/v1'] : []), ...(assistant.identitySupported ? ['personal-assistant-identity/v1'] : [])] : [])] }); return;
      }
      const assistantRoute = /^\/v1\/assistant\/([a-z-]+)$/.exec(url.pathname);
      if (req.method === 'POST' && assistantRoute && assistant) {
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw fail('RUNTIME_JSON_REQUIRED', 415);
        const chunks = []; let bytes = 0;
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
          bytes += chunk.length;
          if (bytes > assistantInputLimit(assistantRoute[1])) { req.resume(); throw fail('RUNTIME_INPUT_TOO_LARGE', 413); }
          chunks.push(chunk);
        }
        const body = Buffer.concat(chunks).toString('utf8');
        let payload; try { payload = JSON.parse(body); } catch { throw fail('RUNTIME_INVALID_JSON'); }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw fail('RUNTIME_INPUT_INVALID');
        // Read-side native long polls release their resources on disconnect.
        // Durable submit/upload admission remains cloud-owned and never uses
        // this transport AbortSignal to cancel an accepted Agent turn.
        const readAbort = isAssistantNativeOperation(assistantRoute[1]) ? new AbortController() : null;
        const disconnect = () => { if (!res.writableEnded) readAbort?.abort(); };
        if (readAbort) res.on('close', disconnect);
        let result;
        try { result = await assistant(assistantRoute[1], payload, readAbort ? { signal: readAbort.signal } : undefined); }
        finally { if (readAbort) res.off('close', disconnect); }
        json(res, assistantRoute[1] === 'submit' ? 202 : 200, result); return;
      }
      const cancel = /^\/runs\/(run_[0-9a-f]{32})\/cancel$/.exec(url.pathname);
      const cancelResponse = /^\/v1\/responses\/([^/]+)\/cancel$/.exec(url.pathname);
      if (req.method === 'POST' && (cancel || cancelResponse)) {
        const targetId = cancel ? cancel[1] : responses.cancellation(cancelResponse[1]);
        const target = active.get(targetId);
        if (!target || (cancelResponse && target.responseId !== cancelResponse[1])) throw fail('RUNTIME_RUN_NOT_ACTIVE', 404);
        target.abort.abort(fail('RUNTIME_CANCELLED', 409));
        json(res, 202, { runId: targetId, ...(cancelResponse ? { id: cancelResponse[1] } : {}), cancellationRequested: true }); return;
      }
      const isResponses = url.pathname === '/v1/responses';
      if (req.method !== 'POST' || (!isResponses && url.pathname !== '/runs')) throw fail('RUNTIME_ROUTE_NOT_FOUND', 404);
      if (isResponses && req.headers['last-event-id']) throw fail('RESPONSES_STREAM_REPLAY_UNSUPPORTED');
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw fail('RUNTIME_JSON_REQUIRED', 415);
      const chunks = []; let bytes = 0;
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        bytes += chunk.length;
        if (bytes > 256 * 1024) { req.resume(); throw fail('RUNTIME_INPUT_TOO_LARGE', 413); }
        chunks.push(chunk);
      }
      let input;
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('RUNTIME_INVALID_JSON'); }
      if (!isResponses && (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['input', 'sessionId', 'requestId', 'stream'].includes(key))
        || typeof input.input !== 'string' || !input.input.trim() || typeof input.requestId !== 'string' || !identity(input.requestId)
        || (input.sessionId !== undefined && (typeof input.sessionId !== 'string' || !identity(input.sessionId)))
        || (input.stream !== undefined && typeof input.stream !== 'boolean'))) throw fail('RUNTIME_INPUT_INVALID');
      if (isResponses) input = responses.parse(input, req.headers);
      const sessionId = isResponses ? input.sessionId : `runtime-${hash(`${agentId}\0${buildId}\0${input.sessionId || input.requestId}`).toString('hex').slice(0, 32)}`;
      runId = isResponses ? input.runId : `run_${hash(`${sessionId}\0${input.requestId}`).toString('hex').slice(0, 32)}`;
      if (active.has(runId)) throw fail('RUNTIME_RUN_ACTIVE', 409);
      if (active.size >= maxActive) throw fail('RUNTIME_BUSY', 429);
      abort = new AbortController(); active.set(runId, { abort, responseId: input.responseId });
      res.on('close', () => { if (!res.writableEnded) abort.abort(fail('RUNTIME_CLIENT_DISCONNECTED', 499)); });
      const emit = (event, data) => {
        if (res.destroyed || !input.stream) return;
        const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        if (res.writableLength + Buffer.byteLength(line) > 4 * 1024 * 1024) { abort.abort(fail('RUNTIME_SLOW_CONSUMER')); res.destroy(); return; }
        res.write(line);
      };
      if (input.previous) {
        if (!validatePrevious) throw fail('RESPONSES_CONTINUATION_UNAVAILABLE', 503);
        await validatePrevious(input.previous, abort.signal);
        abort.signal.throwIfAborted();
      }
      if (isResponses) projection = createRuntimeResponsesStream(input, emit);
      if (input.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
        if (projection) projection.start();
        else emit('run.started', { runId, sessionId, agentId, buildId, requestId: input.requestId });
        heartbeat = setInterval(() => { if (!res.destroyed && !abort.signal.aborted) res.write(': keepalive\n\n'); }, 15000); heartbeat.unref();
      }
      const result = await runner({ agentId, buildId, sessionId, occurrenceId: runId, input: input.input, ...(isResponses ? { model: input.model } : {}), signal: abort.signal,
        ...(input.stream || projection ? { onFrame: frame => { if (!abort.signal.aborted) { if (projection) projection.frame(frame); else emit(frame.kind === 'assistant' ? 'dsh.assistant' : 'dsh.event', frame.value); } } } : {}) });
      if (abort.signal.aborted) throw abort.signal.reason;
      const value = { ...result, requestId: input.requestId, runtimeRunId: runId, buildId };
      if (projection) {
        const response = projection.complete(result);
        if (input.stream) res.end('data: [DONE]\n\n'); else json(res, 200, response);
      } else if (input.stream) { emit('run.completed', value); res.end(); } else json(res, 200, value);
    } catch (error) {
      const code = error?.code || 'RUNTIME_RUN_FAILED';
      if (res.headersSent && !res.destroyed) {
        if (projection) { projection.fail(code); res.end('data: [DONE]\n\n'); }
        else res.end(`event: run.failed\ndata: ${JSON.stringify({ runId, error: { code } })}\n\n`);
      }
      else if (!res.destroyed) json(res, error?.status || 500, { error: { code } });
    } finally { clearInterval(heartbeat); if (abort && active.get(runId)?.abort === abort) active.delete(runId); }
  });
  server.requestTimeout = 30000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(); }); });
  return {
    address: server.address(),
    close: async () => {
      closing = true;
      await assistant?.dispose?.();
      for (const { abort } of active.values()) abort.abort(fail('RUNTIME_STOPPING', 503));
      const closed = new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
      await closed;
    },
  };
}
