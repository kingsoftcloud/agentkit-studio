/** Authenticated transport for one frozen Build. DSH remains the runtime and history owner. */
import { CLOUD_EXECUTION_POLICY_CAPABILITY, executionModesUpTo, readExecutionMode, readExecutionPolicy } from './execution-policy.mjs';
import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createRuntimeResponsesContract } from './runtime-responses-contract.mjs';
import { createRuntimeResponsesStream } from './runtime-responses-stream.mjs';
import { assistantInputLimit } from './assistant-transport.mjs';
import { ASSISTANT_SCHEDULE_CAPABILITY } from './contracts/assistant-schedule.mjs';
import { ASSISTANT_BROWSER_CAPABILITY, ASSISTANT_CODE_EXECUTION_CAPABILITY, ASSISTANT_MANAGED_PERMISSION_CAPABILITY } from './contracts/assistant-capabilities.mjs';
import { ASSISTANT_NATIVE_CAPABILITY, isAssistantNativeOperation } from './contracts/assistant-native.mjs';
import { ASSISTANT_ATTACHMENT_CAPABILITIES } from './contracts/assistant-attachments.mjs';

const hash = value => createHash('sha256').update(value).digest();
const identity = value => /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const fail = (code, status = 400) => Object.assign(new Error(code), { code, status });
/** A request may only select a mode inside the ceiling declared by this runtime. */
const PERMISSION_MODE_HEADER = 'x-agentkit-permission-mode';

function readRequestedExecutionMode(value) {
  if (value === undefined) return null;
  if (Array.isArray(value)) throw fail('RUNTIME_PERMISSION_MODE_INVALID');
  const mode = String(value).trim();
  if (!/^[a-z][a-z-]{0,31}$/.test(mode) || !readExecutionMode(mode)) throw fail('RUNTIME_PERMISSION_MODE_INVALID');
  return mode;
}

export async function startBuildRuntimeHttp({ agentId, buildId, managedIdentity, platformActions, withResourceContext, bundleSha256 = '', deploymentVersion = 'initial', token, runner, executionPolicy, executionPolicyMax, validatePrevious, assistant, hosted, approval, model = '', models = [model], host = '127.0.0.1', port = 8080, maxActive = 16, runLog = entry => console.info(JSON.stringify(entry)) } = {}) {
  const managed = !buildId && managedIdentity?.agentId === agentId && identity(managedIdentity?.versionId || '') && /^[a-f0-9]{64}$/.test(managedIdentity?.manifestSha256 || '');
  if (!agentId || (managedIdentity ? !managed : !/^build_[0-9a-f]{20}$/.test(buildId || '')) || String(token || '').length < 24 || typeof runner !== 'function') throw fail('RUNTIME_CONFIG_INVALID');
  const declaredPolicy = readExecutionPolicy(executionPolicy);
  const ceiling = readExecutionMode(executionPolicyMax) || declaredPolicy?.permissionMode || 'read-only';
  const allowedPermissionModes = executionModesUpTo(ceiling);
  const scope = managed ? JSON.stringify([managedIdentity.versionId, managedIdentity.manifestSha256]) : buildId;
  const tokenHash = hash(token);
  const responses = createRuntimeResponsesContract({ agentId, buildId, definitionId: managedIdentity?.manifestSha256, versionId: managedIdentity?.versionId, token, model, models });
  const active = new Map();
  platformActions?.setRunControl({ cancelRun: (runId, sessionId, principalDigest) => {
    const target = active.get(runId);
    if (!target || target.sessionId !== sessionId || target.principalDigest !== principalDigest) return false;
    target.abort.abort(fail('RUNTIME_CANCELLED', 409)); return true;
  }, cancelSession: sessionId => {
    for (const target of active.values()) if (target.sessionId === sessionId) target.abort.abort(fail('RUNTIME_CANCELLED', 409));
  } });
  let closing = false;
  const json = (res, status, value) => { if (!res.destroyed) { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); } };
  const server = createServer(async (req, res) => {
    let runId, abort, heartbeat, projection, approvalRun, action, input, runStartedAt, logIdentity, terminalLogged = false;
    // Stdout is the existing cloud collector's input. Log only correlation and
    // outcomes: never prompts, model output, tool arguments or upstream errors.
    const logRun = (event, code) => {
      if (!logIdentity || terminalLogged) return;
      terminalLogged = event !== 'runtime.run.started';
      const entry = { at: new Date().toISOString(), event, ...logIdentity,
        ...(event === 'runtime.run.started' ? {} : { durationMs: Math.max(0, Math.round(performance.now() - runStartedAt)) }),
        ...(code ? { code: /^(?:RUNTIME|RESPONSES|HISTORY|RESOURCE|MODEL|MANAGED)_[A-Z0-9_]{1,80}$/.test(code) ? code : 'RUNTIME_RUN_FAILED' } : {}) };
      try { runLog(entry)?.catch?.(() => {}); } catch { /* Logging cannot change a run's outcome. */ }
    };
    try {
      const url = new URL(req.url, 'http://runtime');
      if (req.method === 'GET' && url.pathname === '/health') { json(res, closing ? 503 : 200, { status: closing ? 'stopping' : 'ready' }); return; }
      const bearer = /^Bearer (.+)$/i.exec(String(req.headers.authorization || ''));
      if (req.headers.origin || !bearer || !timingSafeEqual(hash(bearer[1]), tokenHash)) throw fail('RUNTIME_UNAUTHORIZED', 401);
      if (closing) throw fail('RUNTIME_STOPPING', 503);
      if (assistant?.retiring?.() && !['/v1/assistant/close', '/v1/agentkit/runtime'].includes(url.pathname)) throw fail('ASSISTANT_CLOSED', 410);
      if (req.method === 'GET' && url.pathname === '/v1/agentkit/runtime') {
        const owner = managed ? { format: 'agentengine.managed-runtime/v1', ...managedIdentity }
          : { format: 'agentkit.runtime-identity/v1', agentId, buildId, bundleSha256, deploymentVersion };
        json(res, 200, { ...owner, status: 'ready', model, models, ...(declaredPolicy ? { executionPolicy: declaredPolicy } : {}), ...(declaredPolicy && allowedPermissionModes.length ? { allowedPermissionModes } : {}), capabilities: ['bound-model-selection', 'resource-checks', ...(declaredPolicy && allowedPermissionModes.length ? [CLOUD_EXECUTION_POLICY_CAPABILITY] : []), ...(assistant ? ['personal-assistant/v1', ...(assistant.managedPermissionsSupported ? [ASSISTANT_MANAGED_PERMISSION_CAPABILITY] : []), ...(assistant.nativeCarrierSupported ? [ASSISTANT_NATIVE_CAPABILITY] : []), ...(assistant.cloudExecutionSupported ? [ASSISTANT_CODE_EXECUTION_CAPABILITY] : []), ...(assistant.cloudBrowserSupported ? [ASSISTANT_BROWSER_CAPABILITY] : []), ...(assistant.scopedCancelSupported ? ['personal-assistant-cancel-turn/v1'] : []), ...(assistant.imageReadSupported ? ['personal-assistant-images/v1'] : []), ...(assistant.attachmentUploadSupported ? [ASSISTANT_ATTACHMENT_CAPABILITIES.upload] : []), ...(assistant.contentSupported ? [ASSISTANT_ATTACHMENT_CAPABILITIES.content] : []), ...(assistant.fileReadSupported ? [ASSISTANT_ATTACHMENT_CAPABILITIES.read] : []), ...(assistant.approvalBridgeSupported ? ['personal-assistant-approval-bridge/v1'] : []), ...(assistant.deletionSupported ? ['personal-assistant-delete/v1'] : []), ...(assistant.identitySupported ? ['personal-assistant-identity/v1'] : []), ...(assistant.scheduleManagerSupported ? [ASSISTANT_SCHEDULE_CAPABILITY] : [])] : [])] }); return;
      }
      if (managed && (req.headers['x-agentengine-target-version-id'] !== managedIdentity.versionId
        || req.headers['x-agentengine-manifest-sha256'] !== managedIdentity.manifestSha256)) throw fail('RUNTIME_DEPLOYMENT_CHANGED', 409);
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
        platformActions?.authorizeCancel(req.headers, target);
        target.abort.abort(fail('RUNTIME_CANCELLED', 409));
        json(res, 202, { runId: targetId, ...(cancelResponse ? { id: cancelResponse[1] } : {}), cancellationRequested: true }); return;
      }
      action = /^\/agentengine\/api\/v1\/([A-Za-z]+)$/.exec(url.pathname)?.[1];
      const isHostedRun = action === 'RunAgent' && hosted;
      const isManagedRun = action === 'RunAgent' && platformActions;
      const isResponses = url.pathname === '/v1/responses' || isHostedRun || isManagedRun || (platformActions && url.pathname === '/runs');
      if (req.method !== 'POST' || (!isResponses && url.pathname !== '/runs' && !isHostedRun && !isManagedRun && !(action && platformActions) && !(action && hosted))) throw fail('RUNTIME_ROUTE_NOT_FOUND', 404);
      const requestedMode = readRequestedExecutionMode(req.headers[PERMISSION_MODE_HEADER]);
      if (requestedMode && !allowedPermissionModes.includes(requestedMode)) throw fail('RUNTIME_PERMISSION_MODE_DENIED', 403);
      if (isResponses && req.headers['last-event-id']) throw fail('RESPONSES_STREAM_REPLAY_UNSUPPORTED');
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw fail('RUNTIME_JSON_REQUIRED', 415);
      const chunks = []; let bytes = 0;
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        bytes += chunk.length;
        if (bytes > 256 * 1024) { req.resume(); throw fail('RUNTIME_INPUT_TOO_LARGE', 413); }
        chunks.push(chunk);
      }
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('RUNTIME_INVALID_JSON'); }
      if (action && !isResponses) {
        if (hosted && !isHostedRun) {
          const data = await hosted.dispatch(action, input, req.headers, AbortSignal.timeout(15000));
          json(res, 200, { Code: 0, Message: 'Success', Action: action, Data: data }); return;
        }
        if (platformActions) {
          if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('RUNTIME_INPUT_INVALID');
          const data = await platformActions.dispatch(action, input, req.headers, responses, AbortSignal.timeout(30000));
          json(res, 200, { Code: 0, Message: 'Success', RequestId: String(req.headers['x-ksc-request-id'] || ''), Action: action, Data: data }); return;
        }
      }
      if (action === 'RunAgent' && platformActions) input = platformActions.responsesInput(input);
      else if (platformActions && url.pathname === '/runs') {
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['input', 'sessionId', 'requestId', 'stream'].includes(key))) throw fail('RUNTIME_INPUT_INVALID');
        input = { input: input.input, session_id: input.sessionId, request_id: input.requestId, stream: input.stream };
      }
      if (!isResponses && (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['input', 'sessionId', 'requestId', 'stream'].includes(key))
        || typeof input.input !== 'string' || !input.input.trim() || typeof input.requestId !== 'string' || !identity(input.requestId)
        || (input.sessionId !== undefined && (typeof input.sessionId !== 'string' || !identity(input.sessionId)))
        || (input.stream !== undefined && typeof input.stream !== 'boolean'))) throw fail('RUNTIME_INPUT_INVALID');
      if (isResponses) {
        if (isHostedRun) input = await hosted.responsesInput(input, req.headers);
        else if (platformActions) input = await platformActions.parseResponses(input, req.headers, responses, AbortSignal.timeout(30000));
        else input = responses.parse(input, req.headers);
      }
      if (input.hosted && hosted) await hosted.prepareRun(input);
      if (action === 'RunAgent' && input.platformSession) input.publicSessionId = input.platformSession.sessionId;
      if (isResponses && input.approval) {
        // Responses compatibility path: one mcp_approval_response input settles
        // an already-presented interaction; it starts no model turn.
        if (!approval) throw fail('RUNTIME_APPROVAL_RESUME_UNAVAILABLE', 503);
        if (!input.stream) throw fail('RUNTIME_APPROVAL_STREAM_REQUIRED', 400);
        const receipt = approval.resolveInput({ sessionId: input.platformSession.sessionId,
          nativeSessionId: input.platformSession.nativeSessionId,
          interactionId: input.approval.requestId, approve: input.approval.approve });
        projection = createRuntimeResponsesStream(input, (event, data) => {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        });
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
        projection.start();
        projection.approvalSettled(input.approval.requestId, receipt.decision, receipt.revision);
        projection.complete({ output: '' });
        res.end('data: [DONE]\n\n');
        return;
      }
      const sessionId = isResponses ? input.sessionId : `runtime-${hash(`${agentId}\0${scope}\0${input.sessionId || input.requestId}`).toString('hex').slice(0, 32)}`;
      runId = isResponses ? input.runId : `run_${hash(`${sessionId}\0${input.requestId}`).toString('hex').slice(0, 32)}`;
      if (active.has(runId)) throw fail('RUNTIME_RUN_ACTIVE', 409);
      if (platformActions && [...active.values()].some(target => target.sessionId === sessionId)) throw fail('RUNTIME_SESSION_BUSY', 409);
      if (active.size >= maxActive) throw fail('RUNTIME_BUSY', 429);
      abort = new AbortController(); active.set(runId, { abort, responseId: input.responseId, sessionId, principalDigest: input.principalDigest });
      res.on('close', () => { if (!res.writableEnded) abort.abort(fail('RUNTIME_CLIENT_DISCONNECTED', 499)); });
      const emit = (event, data) => {
        if (res.destroyed || !input.stream) return;
        const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        if (res.writableLength + Buffer.byteLength(line) > 4 * 1024 * 1024) { abort.abort(fail('RUNTIME_SLOW_CONSUMER')); res.destroy(); return; }
        res.write(line);
      };
      if (platformActions) { await platformActions.checkRun(input); abort.signal.throwIfAborted(); }
      if (input.previous) {
        if (!validatePrevious) throw fail('RESPONSES_CONTINUATION_UNAVAILABLE', 503);
        await validatePrevious(input.previous, abort.signal);
        abort.signal.throwIfAborted();
      }
      runStartedAt = performance.now();
      logIdentity = { agentId, ...(managed ? { versionId: managedIdentity.versionId,
        runtimeName: managedIdentity.runtimeName } : { buildId, deploymentVersion }),
        sessionId: input.platformSession?.sessionId || input.sessionLabel || input.sessionId || sessionId,
        invocationId: input.requestId, runId };
      logRun('runtime.run.started');
      if (isResponses) projection = createRuntimeResponsesStream(input, emit);
      // Approval is a managed Host surface; a frozen Build keeps its existing
      // headless policy even when a caller sends the managed metadata field.
      const approvalMode = approval ? input.metadata?.agentengine?.tool_approval_mode : undefined;
      if (approvalMode !== undefined && (typeof approvalMode !== 'string' || !['ask', 'risk'].includes(approvalMode))) {
        throw fail('RUNTIME_APPROVAL_MODE_UNSUPPORTED');
      }
      if (approvalMode !== undefined && !input.stream) throw fail('RUNTIME_APPROVAL_STREAM_REQUIRED');
      approvalRun = approvalMode === undefined ? null : approval?.begin({ runId,
        sessionId: input.platformSession?.sessionId || sessionId, nativeSessionId: input.sessionId,
        mode: approvalMode, signal: abort.signal,
        publish: item => projection?.approval(item),
        publishDone: (interactionId, decision, revision) => projection?.approvalSettled(interactionId, decision, revision) });
      if (approvalMode !== undefined && !approvalRun) throw fail('RUNTIME_APPROVAL_UNAVAILABLE', 503);
      if (input.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
        if (projection) projection.start();
        else emit('run.started', { runId, sessionId, agentId, buildId, requestId: input.requestId });
        heartbeat = setInterval(() => { if (!res.destroyed && !abort.signal.aborted) res.write(': keepalive\n\n'); }, 15000); heartbeat.unref();
      }
      const invoke = () => runner({ agentId, buildId, sessionId, occurrenceId: runId, input: input.input,
        ...(isResponses ? { model: input.model } : {}),
        ...(approvalRun ? { approvalPolicy: approvalRun.policy } : {}),
        signal: abort.signal,
        ...(requestedMode || declaredPolicy?.permissionMode ? { permissionMode: requestedMode || declaredPolicy.permissionMode } : {}),
        ...(input.stream || projection ? { onFrame: frame => { if (!abort.signal.aborted) { if (projection) projection.frame(frame); else emit(frame.kind === 'assistant' ? 'dsh.assistant' : 'dsh.event', frame.value); } } } : {}) });
      const result = withResourceContext ? await withResourceContext({ headers: req.headers, subjectDigest: input.principalDigest, signal: abort.signal }, invoke) : await invoke();
      if (abort.signal.aborted) throw abort.signal.reason;
      await platformActions?.flushRun(input);
      abort.signal.throwIfAborted();
      const value = { ...result, requestId: input.requestId, runtimeRunId: runId, buildId };
      if (projection) {
        if (input.hosted) await hosted.flushRun(input);
        const response = projection.complete(result);
        logRun('runtime.run.completed');
        if (input.stream) res.end('data: [DONE]\n\n');
        else json(res, 200, action ? { Code: 0, Message: 'Success', Action: action, RequestId: String(req.headers['x-ksc-request-id'] || ''), Data: response } : response);
      } else {
        logRun('runtime.run.completed');
        if (input.stream) { emit('run.completed', value); res.end(); } else json(res, 200, value);
      }
    } catch (error) {
      // Managed terminal acknowledgement follows native writer settlement,
      // including cancellation. A failed durability barrier is not success.
      if (abort && platformActions) {
        try { await platformActions.settleRun(input); }
        catch (settlement) { error = settlement; }
      }
      const code = error?.code || 'RUNTIME_RUN_FAILED';
      logRun(['RUNTIME_CANCELLED', 'RUNTIME_CLIENT_DISCONNECTED'].includes(code) ? 'runtime.run.cancelled' : 'runtime.run.failed', code);
      if (res.headersSent && !res.destroyed) {
        if (projection) { projection.fail(code); res.end('data: [DONE]\n\n'); }
        else res.end(`event: run.failed\ndata: ${JSON.stringify({ runId, error: { code } })}\n\n`);
      }
      else if (!res.destroyed) json(res, error?.status || 500, action ? { Code: error?.status || 500, ReasonCode: code, Message: code, Action: action,
        RequestId: String(req.headers['x-ksc-request-id'] || ''), Data: { ReasonCode: code, Error: { Code: code } } } : { error: { code } });
    } finally { clearInterval(heartbeat); approvalRun?.close(); if (abort && active.get(runId)?.abort === abort) active.delete(runId); }
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
