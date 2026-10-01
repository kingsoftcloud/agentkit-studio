/**
 * DSH LLM adapter for Studio-owned Agent revisions.
 *
 * The adapter keeps the official DSH Session/Conversation renderer and durable
 * event loop in charge. Studio only translates the assembled DSH request into
 * the AgentEngine/local-runtime stream and back into DSH text chunks.
 */

const ROUTE = 'agentkit-studio';
let activeAdapter;
const agentRoutes = new Map();

/**
 * Agent preset scopes dispatch `agent/request` before the root Agent loop
 * calls `llm.stream`. Keep the selected scope's transport context across that
 * boundary without exposing a Studio-specific model in the native picker.
 */
export function bindDshAgentRoute(sessionId, binding = {}) {
  const id = String(sessionId || '').trim();
  if (!id) return () => {};
  const route = {
    agentId: String(binding.agentId || '').trim(),
    agent: binding.agent,
    runtime: String(binding.runtime || 'harness').trim(),
    local: binding.local === true,
    buildId: String(binding.buildId || '').trim(),
    toolAdapter: binding.toolAdapter,
  };
  agentRoutes.set(id, route);
  return () => {
    if (agentRoutes.get(id) === route) agentRoutes.delete(id);
  };
}

export function unbindDshAgentRoutes(agentId) {
  const id = String(agentId || '').trim();
  for (const [sessionId, route] of agentRoutes) {
    if (route.agentId === id) agentRoutes.delete(sessionId);
  }
}

/**
 * Publish the Host-owned bridge to preset-scoped DSH plugins. The plugin uses
 * the `llm/stream` waterfall, so the durable DSH request keeps its original
 * provider/model (and the native model picker stays truthful) while only the
 * actual transport call is delegated to Studio.
 */
export function setDshRuntimeAdapter(adapter) {
  activeAdapter = adapter;
  return () => { if (activeAdapter === adapter) activeAdapter = undefined; };
}

export function streamDshRuntime(options, { agentId, runtime, local, buildId, toolAdapter } = {}) {
  const id = String(agentId || '').trim();
  if (!id || !activeAdapter) throw new Error('AgentKit Studio runtime bridge is unavailable');
  const mode = local === true ? 'local' : 'cloud';
  return activeAdapter.stream({ ...options, model: `${mode}:${id}`, studioRuntime: runtime, ...(buildId ? { buildId } : {}), ...(toolAdapter ? { studioToolAdapter: toolAdapter } : {}) });
}

function textOf(message) {
  if (!message || typeof message !== 'object') return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(part => part?.type === 'text' || part?.kind === 'text')
    .map(part => String(part.text || part.value || '')).join('');
}

function historyOf(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter(message => message?.role === 'user' || message?.role === 'assistant')
    .map(message => ({ role: message.role, content: textOf(message) }))
    .filter(message => message.content);
}

function lastUser(messages) {
  return [...(Array.isArray(messages) ? messages : [])].reverse()
    .find(message => message?.role === 'user');
}

function cloudCancelledError(reason) {
  const detail = reason instanceof Error ? reason.message : String(reason || '');
  return Object.assign(new Error(detail && detail !== 'This operation was aborted' ? `云端 Agent 运行已取消：${detail}` : '云端 Agent 运行已取消'), {
    code: 'CLOUD_RUN_CANCELLED',
  });
}

async function* parseSse(body, signal) {
  if (signal?.aborted) throw cloudCancelledError(signal.reason);
  if (!body) return;
  const reader = body.getReader?.();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = '';
  const abort = () => { try { void reader.cancel?.(signal.reason); } catch {} };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) throw cloudCancelledError(signal.reason);
      const { done, value } = await reader.read();
      if (signal?.aborted) throw cloudCancelledError(signal.reason);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split = buffer.indexOf('\n\n');
      while (split >= 0) {
        if (signal?.aborted) throw cloudCancelledError(signal.reason);
        const record = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const data = record.split(/\r?\n/).filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart()).join('\n');
        if (data && data !== '[DONE]') {
          try { yield JSON.parse(data); } catch { /* ignore malformed provider frames */ }
        }
        split = buffer.indexOf('\n\n');
      }
    }
  } catch (error) {
    if (signal?.aborted) throw cloudCancelledError(signal.reason);
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    try { reader.releaseLock?.(); } catch {}
  }
}

function createChunkState() {
  return {
    currentKind: '', currentIndex: -1, currentText: '', nextIndex: 0,
    toolNames: new Map(), toolStarted: new Set(),
  };
}

function closeCurrentBlock(state) {
  if (!state.currentKind || state.currentIndex < 0) return [];
  const index = state.currentIndex;
  const block = { type: state.currentKind, text: state.currentText };
  state.currentKind = '';
  state.currentIndex = -1;
  state.currentText = '';
  return [{ type: 'block-end', index, block }];
}

function closeBlock(state, kind) {
  if (state.currentKind !== kind) return [];
  return closeCurrentBlock(state);
}

function appendBlock(state, kind, value) {
  const text = String(value || '');
  if (!text) return [];
  const frames = [];
  if (state.currentKind !== kind) {
    frames.push(...closeCurrentBlock(state));
    const index = state.nextIndex++;
    state.currentKind = kind;
    state.currentIndex = index;
    state.currentText = '';
    frames.push({ type: 'block-start', index, blockType: kind });
  }
  state.currentText += text;
  frames.push({ type: kind === 'reasoning' ? 'reasoning-delta' : 'text-delta', index: state.currentIndex, text });
  return frames;
}

function finishBlocks(state) {
  return [...closeCurrentBlock(state), { type: 'finish', reason: { kind: 'stop' } }];
}

async function* codexFrames(codexRuntime, options, onChunk) {
  const state = createChunkState();
  for await (const chunk of codexRuntime.stream(options)) {
    onChunk?.(chunk);
    if (chunk?.type === 'reasoning') yield* appendBlock(state, 'reasoning', chunk.text);
    else if (chunk?.type === 'tool') {
      const name = String(chunk.name || 'bound tool');
      const phase = chunk.phase === 'started' ? '正在调用' : chunk.phase === 'completed' ? '已完成' : '失败';
      yield* appendBlock(state, 'reasoning', `工具 ${name} ${phase}。`);
    }
    else if (chunk?.type === 'text') yield* appendBlock(state, 'text', chunk.text);
  }
  yield* finishBlocks(state);
}

function createAsyncQueue() {
  const values = [];
  const waiters = [];
  let closed = false;
  let failure;
  return {
    push(value) {
      if (closed) return;
      const waiter = waiters.shift();
      if (waiter) waiter.resolve({ value, done: false });
      else values.push(value);
    },
    close() {
      if (closed) return;
      closed = true;
      while (waiters.length) waiters.shift().resolve({ value: undefined, done: true });
    },
    fail(error) {
      if (closed) return;
      closed = true;
      failure = error;
      while (waiters.length) waiters.shift().reject(error);
    },
    async next() {
      if (values.length) return { value: values.shift(), done: false };
      if (failure) throw failure;
      if (closed) return { value: undefined, done: true };
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    [Symbol.asyncIterator]() { return this; },
  };
}

function parseLocalRecord(record, state) {
  const line = String(record).split(/\r?\n/).find(item => item.startsWith('data:'));
  if (!line) return [];
  const raw = line.slice(5).trim();
  if (!raw || raw === '[DONE]') return [];
  let event;
  try { event = JSON.parse(raw); } catch { return []; }
  const item = event?.conversationItem;
  if (item?.kind === 'error') {
    const error = new Error(String(item.payload?.message || 'AgentKit Studio 本地运行失败'));
    error.code = 'STUDIO_LOCAL_RUNTIME_FAILED';
    throw error;
  }
  if (event?.runtimeEvent?.event_type === 'run.failed') {
    const error = new Error('AgentKit Studio 本地运行失败');
    error.code = 'STUDIO_LOCAL_RUNTIME_FAILED';
    throw error;
  }
  if (item?.kind === 'assistant_reasoning') return appendBlock(state, 'reasoning', item.payload?.operation === 'append' ? item.payload.text : '');
  if (item?.kind === 'assistant_text') return appendBlock(state, 'text', item.payload?.operation === 'append' ? item.payload.text : '');
  if (item?.kind === 'tool_call') {
    const callId = String(item.payload?.callId || '');
    const name = String(item.payload?.name || 'bound tool');
    if (callId) state.toolNames.set(callId, name);
    return appendBlock(state, 'reasoning', `工具 ${name} 正在调用。`);
  }
  if (item?.kind === 'tool_result') {
    const callId = String(item.payload?.callId || '');
    const name = state.toolNames.get(callId) || 'bound tool';
    const phase = item.lifecycle === 'failed' ? '失败' : '已完成';
    return appendBlock(state, 'reasoning', `工具 ${name} ${phase}。`);
  }
  if (event?.runtimeEvent?.event_type === 'run.completed') return finishBlocks(state);
  return [];
}

async function* localFrames(handler, payload, { signal, toolAdapter, agent } = {}) {
  const requestBody = Buffer.from(JSON.stringify(payload));
  const queue = createAsyncQueue();
  const responseChunks = [];
  const request = {
    async *[Symbol.asyncIterator]() { yield requestBody; },
  };
  const response = {
    headersSent: false,
    writableEnded: false,
    statusCode: 200,
    writeHead(status) { this.headersSent = true; this.statusCode = status; },
    write(chunk) {
      const value = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      responseChunks.push(value);
      queue.push(value);
      return true;
    },
    end(chunk = '') { if (chunk) this.write(chunk); this.writableEnded = true; queue.close(); },
  };
  const handlerPromise = Promise.resolve().then(() => handler(request, response, { signal, toolAdapter, agent })).catch(error => {
    queue.fail(error);
    throw error;
  });
  const state = createChunkState();
  let buffer = '';
  try {
    for await (const chunk of queue) {
      buffer += chunk;
      let split = buffer.indexOf('\n\n');
      while (split >= 0) {
        const record = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        yield* parseLocalRecord(record, state);
        split = buffer.indexOf('\n\n');
      }
    }
    if (buffer.trim()) yield* parseLocalRecord(buffer, state);
    await handlerPromise;
    if (response.statusCode >= 400) {
      let detail;
      try { detail = JSON.parse(responseChunks.join(''))?.error; } catch { detail = undefined; }
      const error = new Error(detail?.message || `Studio local runtime failed (${response.statusCode})`);
      error.code = detail?.code || 'STUDIO_LOCAL_RUNTIME_FAILED';
      throw error;
    }
  } catch (error) {
    await handlerPromise.catch(() => {});
    if (response.statusCode >= 400) {
      const detail = String(error?.message || 'Studio local runtime failed');
      const wrapped = new Error(detail);
      wrapped.code = error?.code || 'STUDIO_LOCAL_RUNTIME_FAILED';
      throw wrapped;
    }
    throw error;
  }
}

async function* cloudFrames(body, signal) {
  const state = createChunkState();
  let completed = false;
  for await (const event of parseSse(body, signal)) {
    if (signal?.aborted) throw cloudCancelledError(signal.reason);
    const type = String(event?.type || event?.event || '');
    if (/^response\.(failed|error)$/i.test(type) || /^error$/i.test(type)) {
      const detail = String(event?.error?.message || event?.message || '云端 Agent 运行失败').slice(0, 500);
      throw Object.assign(new Error(detail), { code: 'CLOUD_RUN_FAILED' });
    }
    if (/^response\.incomplete$/i.test(type)) {
      throw Object.assign(new Error('云端 Agent 流未完整结束'), { code: 'CLOUD_STREAM_INCOMPLETE' });
    }
    if (/^response\.completed$/i.test(type)) {
      completed = true;
      continue;
    }
    const item = event?.item || event?.output_item || event?.response?.output_item || event?.data?.item || {};
    const callId = String(event?.call_id || event?.callId || item?.call_id || item?.callId || item?.id || '').trim();
    const toolName = String(event?.name || event?.tool_name || item?.name || item?.function?.name || item?.function?.function?.name || state.toolNames.get(callId) || '').trim();
    const itemType = String(item?.type || event?.tool_type || '').toLowerCase();
    const toolEvent = Boolean(toolName) && (itemType.includes('tool') || itemType.includes('call') || type.includes('tool') || type.includes('function_call'));
    if (toolEvent) {
      if (callId) state.toolNames.set(callId, toolName);
      const start = /output_item\.added|tool[_/.]call|function_call_arguments\.delta/i.test(type);
      const finish = /output_item\.done|tool[_/.]result|function_call_output/i.test(type);
      const failed = /fail|error/i.test(String(event?.status || item?.status || '')) || Boolean(event?.error || item?.error);
      if (start && (!callId || !state.toolStarted.has(callId))) {
        if (callId) state.toolStarted.add(callId);
        yield* appendBlock(state, 'reasoning', `工具 ${toolName} 正在调用。`);
      }
      if (finish) yield* appendBlock(state, 'reasoning', `工具 ${toolName} ${failed ? '失败' : '已完成'}。`);
      continue;
    }
    if (type.includes('reasoning_summary_text.delta')) yield* appendBlock(state, 'reasoning', event.delta);
    else if (type.includes('output_text.delta')) yield* appendBlock(state, 'text', event.delta);
    else if (type.includes('reasoning_summary_text.done')) yield* closeBlock(state, 'reasoning');
    else if (type.includes('output_text.done')) yield* closeBlock(state, 'text');
    else {
      const reasoning = event?.reasoning_content || event?.reasoning;
      const text = event?.delta || event?.output_text?.delta || event?.response?.output_text?.delta;
      if (reasoning) yield* appendBlock(state, 'reasoning', reasoning);
      if (text) yield* appendBlock(state, 'text', text);
    }
  }
  if (signal?.aborted) throw cloudCancelledError(signal.reason);
  if (!completed) throw Object.assign(new Error('云端 Agent 流未收到 response.completed'), { code: 'CLOUD_STREAM_INCOMPLETE' });
  yield* finishBlocks(state);
}

async function syncCodexTrace(observability, { traceId, sessionId, agentId, agentName, startedAt, status, events }) {
  if (typeof observability?.syncTrace !== 'function') return;
  await observability.syncTrace({
    traceId,
    sessionId,
    agentId,
    agentName,
    status,
    startedAt,
    completedAt: new Date().toISOString(),
    events,
  }).catch(error => console.warn('[agentkit-studio] Codex trace sync failed:', error?.message || error));
}

/** Create the one provider route mounted by the AgentKit Studio host. */
export function createDshRuntimeAdapter({ cloudClient, localHandler, codexRuntime, codexResourceContext, observability } = {}) {
  return {
    providerInfo(provider) { return { id: provider, name: 'AgentKit Studio Runtime' }; },
    resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model, modalities: ['text'] }); },
    async prepareCall(provider, model) {
      const metadata = await this.resolveModel(provider, model);
      return { model: metadata, stream: options => this.stream(options) };
    },
    async *stream(options = {}) {
      const routed = agentRoutes.get(String(options.sessionId || '').trim());
      const model = String(options.model || '');
      const separator = model.indexOf(':');
      const mode = routed ? (routed.local ? 'local' : 'cloud') : separator > 0 ? model.slice(0, separator) : 'cloud';
      const agentId = routed?.agentId || (separator > 0 ? model.slice(separator + 1) : model);
      const runtime = routed?.runtime || options.studioRuntime;
      const toolAdapter = options.studioToolAdapter || routed?.toolAdapter;
      const buildId = String(options.buildId || routed?.buildId || '').trim();
      const toolAgent = routed?.agent || options.agent;
      const user = lastUser(options.messages);
      const input = textOf(user).trim();
      if (!agentId || !input) throw new Error('AgentKit Studio runtime requires an AgentId and user input');
      if (mode === 'local') {
        if (runtime === 'codex') {
          if (!codexRuntime || typeof codexRuntime.stream !== 'function') {
            const error = new Error('Codex Provider 未注册；请安装并启用官方 Codex App Server Provider');
            error.code = 'CODEX_PROVIDER_UNAVAILABLE';
            throw error;
          }
          const resources = typeof codexResourceContext === 'function'
            ? await codexResourceContext({
              agentId,
              buildId,
              input,
              sessionId: String(options.sessionId || ''),
              userId: String(options.userId || options.metadata?.userId || options.user?.id || ''),
              toolAdapter,
              agent: toolAgent,
            })
            : {};
          const startedAt = new Date().toISOString();
          const traceId = String(options.runId || options.turnId || `run_codex_${Date.now().toString(36)}`);
          const traceEvents = [];
          const recordChunk = chunk => {
            const type = String(chunk?.type || '');
            const at = new Date().toISOString();
            if (type === 'tool') traceEvents.push({ event_type: `tool.${String(chunk.phase || 'update')}`, at, run_id: traceId, payload: { name: String(chunk.name || 'bound tool') } });
            else if (type === 'reasoning' || type === 'text') traceEvents.push({ event_type: `turn.${type}`, at, run_id: traceId, payload: { chars: String(chunk.text || '').length } });
          };
          try {
            yield* codexFrames(codexRuntime, {
              agentId,
              sessionId: String(options.sessionId || ''),
              input,
              messages: Array.isArray(options.messages) ? options.messages : [],
              signal: options.signal,
              systemPrompt: resources.systemPrompt || '',
              dynamicTools: resources.dynamicTools || [],
              toolHandler: resources.toolHandler,
            }, recordChunk);
            await syncCodexTrace(observability, {
              traceId,
              sessionId: String(options.sessionId || ''),
              agentId,
              agentName: resources.agentName || '',
              startedAt,
              status: 'completed',
              events: [...traceEvents, { event_type: 'run.completed', at: new Date().toISOString(), run_id: traceId }],
            });
          } catch (error) {
            const canceled = options.signal?.aborted || error?.code === 'CODEX_CANCELED';
            await syncCodexTrace(observability, {
              traceId,
              sessionId: String(options.sessionId || ''),
              agentId,
              agentName: resources.agentName || '',
              startedAt,
              status: canceled ? 'canceled' : 'failed',
              events: [...traceEvents, { event_type: canceled ? 'run.canceled' : 'run.failed', at: new Date().toISOString(), run_id: traceId, payload: { code: String(error?.code || '') } }],
            });
            throw error;
          }
          return;
        }
        if (typeof localHandler !== 'function') throw new Error('AgentKit local runtime is unavailable');
        yield* localFrames(await localHandler(), {
          agentId,
          ...(buildId ? { buildId } : {}),
          sessionId: String(options.sessionId || ''),
          userId: String(options.userId || options.metadata?.userId || options.user?.id || ''),
          input,
          history: historyOf(options.messages),
        }, { signal: options.signal, toolAdapter, agent: toolAgent });
        return;
      }
      if (!cloudClient || typeof cloudClient.streamAction !== 'function') throw new Error('AgentEngine cloud runtime is unavailable');
      const upstream = await cloudClient.streamAction('RunAgent', {
        AgentId: agentId,
        SessionId: String(options.sessionId || ''),
        Messages: [{ role: 'user', content: input }],
        Stream: true,
        ApiFormat: 'responses',
      }, { signal: options.signal });
      yield* cloudFrames(upstream.body, options.signal);
    },
  };
}

export const route = ROUTE;
