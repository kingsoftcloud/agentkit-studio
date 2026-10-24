/** A2A 1.0 HTTP data plane, composed with trusted admission and durable Tasks.
 * A socket disconnect stops observation, never cancels the original Run.
 * The host must supply a real Server command receiver and durable fact source. */
import { createHash } from 'node:crypto';
import { canonical, copy, invariant, parseNativeJson } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { buildA2aAgentCard, JSONRPC_PATH, REST_PATH_PREFIX } from './native-a2a-agent-card.mjs';
import { createA2aInboundAdmission } from './native-a2a-inbound-admission.mjs';
import { createA2aInboundTaskStore } from './native-a2a-inbound-task-store.mjs';
import { createA2AEventDispatcher } from './native-a2a-event-dispatcher.mjs';

export const A2A_INBOUND_SERVER = 'agentkit.a2a-inbound-server/v1';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const terminal = new Set(['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED']);
const methods = { SendMessage: 'send_message', SendStreamingMessage: 'send_message', GetTask: 'get_task',
  CancelTask: 'cancel_task', SubscribeToTask: 'subscribe_to_task', 'message/send': 'send_message',
  'message/stream': 'send_message', 'tasks/get': 'get_task', 'tasks/cancel': 'cancel_task', 'tasks/resubscribe': 'subscribe_to_task' };
const streamingMethods = new Set(['SendStreamingMessage', 'SubscribeToTask', 'message/stream', 'tasks/resubscribe']);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const error = (code, message) => Object.assign(new Error(message), { code });
function protocolError(failure) {
  const code = failure?.code;
  if (code === 'A2A_PROTOCOL_PARSE') return { rpc: -32700, http: 400, message: 'Parse error' };
  if (code === 'A2A_PROTOCOL_METHOD') return { rpc: -32601, http: 501, message: 'Method not found' };
  if (code === 'A2A_INBOUND_TASK_NOT_FOUND' || code === 'A2A_INBOUND_TASK_BINDING_CONFLICT')
    return { rpc: -32001, http: 404, message: 'Task not found' };
  if (code === 'A2A_INBOUND_TERMINAL_CONFLICT') return { rpc: -32002, http: 409, message: 'Task is not cancelable' };
  if (code === 'A2A_PROTOCOL_UNSUPPORTED') return { rpc: -32004, http: 501, message: 'Unsupported operation' };
  if (['A2A_PROTOCOL_PARAMS', 'A2A_INBOUND_TASK_INVALID', 'A2A_INBOUND_MESSAGE_INVALID', 'A2A_INBOUND_CONTINUATION_CONFLICT',
    'A2A_INBOUND_COMMAND_CONFLICT'].includes(code)) return { rpc: -32602, http: 400, message: 'Invalid parameters' };
  if (code === 'A2A_PROTOCOL_INVALID') return { rpc: -32600, http: 400, message: 'Invalid request' };
  if (code === 'A2A_INGRESS_IDENTITY_INVALID') return { rpc: -32600, http: 403, message: 'Request does not match verified authority' };
  return { rpc: -32603, http: 503, message: 'Task outcome is not confirmed; query the original task' };
}
const paramsCheck = condition => invariant(condition, 'A2A_PROTOCOL_PARAMS');
function taskView(view, length) {
  const task = copy(view.task);
  if (length !== undefined) { paramsCheck(Number.isSafeInteger(length) && length >= 0); task.history = length ? task.history.slice(-length) : []; }
  return task;
}

export function createA2aInboundServer({ card: cardOptions, admissionDirectory, taskDirectory, verifier, controlPlane, events,
  assertCurrent, includeReasoning = false } = {}) {
  invariant(typeof verifier?.verify === 'function' && typeof verifier?.verifyProbe === 'function'
    && typeof events?.subscribe === 'function' && typeof assertCurrent === 'function', 'A2A_INBOUND_CONFIGURATION_INVALID');
  // Public tool observations need their producer before they may be advertised.
  invariant(!cardOptions?.publicToolNames?.length, 'A2A_INBOUND_TOOL_PRODUCER_UNAVAILABLE');
  const card = buildA2aAgentCard(cardOptions), verify = verifier.verify, verifyProbe = verifier.verifyProbe;
  const lifetime = new AbortController(), background = new Map(), active = new Set();
  const guard = () => {
    lifetime.signal.throwIfAborted(); const verdict = assertCurrent();
    if (verdict && typeof verdict.then === 'function') void Promise.resolve(verdict).catch(() => {});
    invariant(verdict === true && verifier.verify === verify && verifier.verifyProbe === verifyProbe, 'A2A_INBOUND_AUTHORITY_LOST');
    return true;
  };
  const admission = createA2aInboundAdmission({ directory: admissionDirectory, verifier, controlPlane, events, assertCurrent: guard });
  const store = createA2aInboundTaskStore({ directory: taskDirectory, assertCurrent: guard, includeReasoning });
  const appendProduct = controlPlane.appendProductKernelFacts;
  invariant(typeof appendProduct === 'function', 'A2A_INBOUND_PRODUCT_OUTBOX_UNAVAILABLE');
  const dispatcher = createA2AEventDispatcher({ pending: () => store.pendingProduct(),
    update: (batch, action, failure) => store.updateProduct(batch, action, failure),
    deliveryLock: () => store.productDeliveryLock(), assertCurrent: guard,
    append: batch => { invariant(controlPlane.appendProductKernelFacts === appendProduct, 'A2A_INBOUND_AUTHORITY_LOST');
      const { platformTaskId, targetVersionId, remoteTaskId, remoteContextId, events, signal, assertCurrent } = batch;
      return appendProduct.call(controlPlane, { platformTaskId, targetVersionId, remoteTaskId, remoteContextId, events, signal, assertCurrent }); },
  });
  dispatcher.wake();
  function authenticate(request, probe = false) {
    guard(); const identity = probe ? verifyProbe.call(verifier, request) : verify.call(verifier, request); guard();
    if (!probe) invariant(identity.verifiedBodySha256 === sha(request.body) && identity.taskBinding, 'A2A_INGRESS_IDENTITY_INVALID');
    return identity;
  }
  const input = (request, task, signal) => ({ request, remoteTaskId: task.id, remoteContextId: task.contextId, signal });
  async function* observe(identity, request, task, signal) {
    const ids = { taskId: task.id, contextId: task.contextId };
    for await (const fact of admission.observe(input(request, task, signal))) {
      signal.throwIfAborted(); guard(); const result = store.apply(identity, ids, fact);
      dispatcher.wake();
      // The next admission step ACKs only after this atomic projection commit.
      for (let index = 0; index < result.updates.length; index++) yield {
        id: `${fact.event_id}:${index}`, payload: result.updates[index],
      };
    }
  }
  function detach(identity, request, task) {
    const state = admission.snapshot(input(request, task, lifetime.signal));
    if (!state.submission || state.uncertainOperations.length) return;
    const key = canonical([identity.accountId, identity.tenantId, identity.callerPrincipalType, identity.callerPrincipalId,
      identity.callerRuntimeId, identity.subAccountId, identity.targetAgentId, identity.targetRuntimeId, identity.targetA2aAgentId,
      identity.taskBinding.platformTaskId, identity.taskBinding.targetVersionId, task.id, state.submission.receipt.command_id]);
    if (background.has(key)) return;
    const promise = (async () => { for await (const _update of observe(identity, request, task, lifetime.signal)) {} })();
    background.set(key, promise); active.add(promise);
    void promise.catch(() => {}).finally(() => { if (background.get(key) === promise) background.delete(key); active.delete(promise); });
  }
  function decode(request, rpc) {
    let value;
    try { value = request.body.length ? parseNativeJson(new TextDecoder('utf-8', { fatal: true }).decode(request.body)) : {}; }
    catch { throw error('A2A_PROTOCOL_PARSE', 'Parse error'); }
    if (rpc) {
      invariant(object(value) && value.jsonrpc === '2.0' && Object.hasOwn(value, 'id')
        && (value.id === null || typeof value.id === 'string' || Number.isSafeInteger(value.id))
        && typeof value.method === 'string', 'A2A_PROTOCOL_INVALID');
      if (!Object.hasOwn(methods, value.method)) throw Object.assign(error('A2A_PROTOCOL_METHOD', 'Method not found'), { rpcId: value.id });
      if (!object(value.params)) throw Object.assign(error('A2A_PROTOCOL_PARAMS', 'Invalid parameters'), { rpcId: value.id });
      return { operation: methods[value.method], streaming: streamingMethods.has(value.method), params: value.params, id: value.id };
    }
    const path = request.path.slice(REST_PATH_PREFIX.length), send = /^\/message:(send|stream)$/u.exec(path),
      lookup = /^\/tasks\/([^/]+?)(?::(cancel|subscribe))?$/u.exec(path);
    if (send && request.method === 'POST') return { operation: 'send_message', streaming: send[1] === 'stream', params: value };
    if (lookup && request.method === (lookup[2] ? 'POST' : 'GET')) {
      let taskId; try { taskId = decodeURIComponent(lookup[1]); } catch { throw error('A2A_PROTOCOL_PARAMS', 'Invalid parameters'); }
      paramsCheck(object(value) && (value.id === undefined || value.id === taskId));
      const query = new URLSearchParams(request.query), historyLength = query.get('historyLength');
      if (historyLength !== null) paramsCheck(/^\d+$/u.test(historyLength) && query.getAll('historyLength').length === 1);
      return { operation: lookup[2] === 'cancel' ? 'cancel_task' : lookup[2] === 'subscribe' ? 'subscribe_to_task' : 'get_task',
        streaming: lookup[2] === 'subscribe', params: { ...value, id: taskId,
          ...(historyLength !== null ? { historyLength: Number(historyLength) } : {}) } };
    }
    throw error('A2A_PROTOCOL_METHOD', 'Method not found');
  }
  async function execute(request, parsed, identity, signal) {
    const { operation, params, streaming } = parsed;
    invariant(operation === identity.taskBinding.operation, 'A2A_INGRESS_IDENTITY_INVALID');
    paramsCheck(object(params));
    if (streaming) invariant(card.capabilities.streaming, 'A2A_PROTOCOL_UNSUPPORTED');
    if (params.historyLength !== undefined) paramsCheck(Number.isSafeInteger(params.historyLength) && params.historyLength >= 0);
    let view;
    if (operation === 'send_message') {
      paramsCheck(object(params.message) && (params.configuration === undefined || object(params.configuration)));
      const message = params.message, taskId = message.taskId ?? message.task_id, contextId = message.contextId ?? message.context_id;
      if (params.configuration?.returnImmediately !== undefined) paramsCheck(typeof params.configuration.returnImmediately === 'boolean');
      view = store.prepare(identity, { message, taskId, contextId });
      // A retry of an already terminal original Message reads the original
      // admission receipt. It neither changes the Task nor observes new work.
      const submission = await admission.submit({ ...input(request, view.task, signal),
        ...(view.continuation ? { continuation: view.continuation } : {}) });
      invariant(['accepted', 'duplicate'].includes(submission.receipt.status), 'A2A_INBOUND_COMMAND_NOT_ACCEPTED');
      view = store.admitted(identity, { taskId: view.task.id, contextId: view.task.contextId, message, submission });
      if (params.configuration?.returnImmediately === true && !streaming) {
        if (!terminal.has(view.task.status.state)) detach(identity, request, view.task);
        return { value: { task: taskView(view, params.historyLength) } };
      }
    } else {
      paramsCheck(typeof params.id === 'string' && params.id.length > 0);
      view = store.get(identity, { taskId: params.id });
      // Reading from the protocol store never grants a new Server mutation.
      if (operation === 'get_task') {
        if (!terminal.has(view.task.status.state)) detach(identity, request, view.task);
        return { value: taskView(view, params.historyLength) };
      }
      if (operation === 'subscribe_to_task') invariant(card.capabilities.streaming && !terminal.has(view.task.status.state), 'A2A_PROTOCOL_UNSUPPORTED');
      if (operation === 'cancel_task') {
        invariant(!terminal.has(view.task.status.state), 'A2A_INBOUND_TERMINAL_CONFLICT');
        const state = admission.snapshot(input(request, view.task, signal));
        // The admission journal decides whether this exact cancel is a safe
        // reconciliation. An unknown original cancel must remain retryable by
        // the same immutable Run, not be permanently blocked by this route.
        invariant(state.runId, 'A2A_INBOUND_RUN_INVALID');
        const submission = await admission.cancel({ ...input(request, view.task, signal), runId: state.runId });
        invariant(['accepted', 'duplicate'].includes(submission.receipt.status), 'A2A_INBOUND_COMMAND_NOT_ACCEPTED');
      }
    }
    if (streaming) {
      invariant(card.capabilities.streaming, 'A2A_PROTOCOL_UNSUPPORTED');
      return { stream: (async function* () {
        yield { id: `snapshot:${view.cursor}`, payload: { task: taskView(view, params.historyLength) } };
        if (!terminal.has(view.task.status.state) && view.task.status.state !== 'TASK_STATE_INPUT_REQUIRED')
          yield* observe(identity, request, view.task, signal);
      })() };
    }
    if (!terminal.has(view.task.status.state) && (view.task.status.state !== 'TASK_STATE_INPUT_REQUIRED' || operation === 'cancel_task'))
      for await (const _update of observe(identity, request, view.task, signal)) {}
    return { value: operation === 'cancel_task' ? store.get(identity, { taskId: view.task.id }).task
      : { task: store.get(identity, { taskId: view.task.id }).task } };
  }
  async function write(response, bytes, signal) {
    signal.throwIfAborted(); if (response.write(bytes)) return;
    await new Promise((resolve, reject) => {
      const done = () => { cleanup(); resolve(); }, stopped = () => { cleanup(); reject(signal.reason ?? error('A2A_HTTP_CLOSED', 'Closed')); };
      const cleanup = () => { response.off('drain', done); response.off('close', stopped); response.off('error', stopped); signal.removeEventListener('abort', stopped); };
      response.once('drain', done); response.once('close', stopped); response.once('error', stopped); signal.addEventListener('abort', stopped, { once: true });
      if (signal.aborted || response.destroyed) stopped();
    });
  }
  const handle = async (incoming, response, { signal: hostSignal = lifetime.signal } = {}) => {
    const disconnected = new AbortController(), signal = AbortSignal.any([hostSignal, lifetime.signal, disconnected.signal]);
    const onClose = () => { if (!response.writableEnded) disconnected.abort(error('A2A_HTTP_CLOSED', 'Closed')); };
    const stopRequest = () => { if (!incoming.complete) incoming.destroy(); if (!response.writableEnded) response.destroy(); };
    signal.addEventListener('abort', stopRequest, { once: true });
    response.on('close', onClose); let parsed, rpc = false;
    if (signal.aborted) stopRequest();
    const send = (http, payload) => { if (!response.destroyed && !response.writableEnded) {
      response.writeHead(http, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(canonical(payload));
    } };
    try {
      guard(); const url = incoming.url ?? '', separator = url.indexOf('?'), path = separator < 0 ? url : url.slice(0, separator),
        query = separator < 0 ? '' : url.slice(separator + 1);
      rpc = path === JSONRPC_PATH;
      if (!(rpc || path.startsWith(REST_PATH_PREFIX + '/') || path === '/.well-known/agent-card.json')) { send(404, { error: 'Not found' }); return; }
      if ((rpc && incoming.method !== 'POST') || path === '/.well-known/agent-card.json' && incoming.method !== 'GET') {
        send(405, { error: 'Method not allowed' }); return;
      }
      const chunks = []; let size = 0;
      if (Number(incoming.headers?.['content-length']) > 2 * 1024 ** 2) { send(413, { error: 'Request too large' }); return; }
      const bodyStream = incoming.iterator?.({ destroyOnReturn: false }) ?? incoming;
      for await (const chunk of bodyStream) {
        signal.throwIfAborted(); size += chunk.length;
        if (size > 2 * 1024 ** 2) { send(413, { error: 'Request too large' }); return; } chunks.push(chunk);
      }
      const request = { method: incoming.method, path, query, headers: { ...incoming.headers }, body: Buffer.concat(chunks) };
      let identity;
      try { identity = authenticate(request, path === '/.well-known/agent-card.json'); }
      catch { send(401, { error: 'Verified Gateway identity required' }); return; }
      if (path === '/.well-known/agent-card.json') { send(200, card); return; }
      parsed = decode(request, rpc); signal.throwIfAborted();
      const result = await execute(request, parsed, identity, signal); signal.throwIfAborted(); guard();
      const wire = result => rpc ? { jsonrpc: '2.0', id: parsed.id, result } : result;
      if (result.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
        try { for await (const update of result.stream) await write(response, `id: ${update.id}\ndata: ${canonical(wire(update.payload))}\n\n`, signal); }
        catch (failure) {
          if (!signal.aborted && !response.destroyed) { const safe = protocolError(failure);
            await write(response, `data: ${canonical(rpc ? { jsonrpc: '2.0', id: parsed.id, error: { code: safe.rpc, message: safe.message } }
              : { error: { code: safe.http, message: safe.message } })}\n\n`, signal); }
        }
        if (!response.destroyed) response.end();
      } else send(200, wire(result.value));
    } catch (failure) {
      if (signal.aborted || response.destroyed) return;
      const safe = protocolError(failure); send(rpc ? 200 : safe.http, rpc ? { jsonrpc: '2.0', id: parsed?.id ?? failure?.rpcId ?? null,
        error: { code: safe.rpc, message: safe.message } } : { error: { code: safe.http, message: safe.message } });
    } finally { response.off('close', onClose); signal.removeEventListener('abort', stopRequest); }
  };
  return Object.freeze({ contract: A2A_INBOUND_SERVER, card: copy(card), handle,
    async flushProductFacts() { return dispatcher.flush(); },
    async close() { lifetime.abort(); admission.close(); await dispatcher.stop({ flushTimeoutMs: 0 }); await Promise.allSettled([...active]); },
  });
}
