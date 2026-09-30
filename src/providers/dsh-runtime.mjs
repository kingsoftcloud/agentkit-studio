/**
 * DSH LLM adapter for Studio-owned Agent revisions.
 *
 * The adapter keeps the official DSH Session/Conversation renderer and durable
 * event loop in charge. Studio only translates the assembled DSH request into
 * the AgentEngine/local-runtime stream and back into DSH text chunks.
 */

const ROUTE = 'agentkit-studio';
let activeAdapter;

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

export function streamDshRuntime(options, { agentId, runtime, local, buildId } = {}) {
  const id = String(agentId || '').trim();
  if (!id || !activeAdapter) throw new Error('AgentKit Studio runtime bridge is unavailable');
  const mode = local === true ? 'local' : 'cloud';
  return activeAdapter.stream({ ...options, model: `${mode}:${id}`, studioRuntime: runtime, ...(buildId ? { buildId } : {}) });
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

async function* parseSse(body) {
  if (!body) return;
  const reader = body.getReader?.();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let split = buffer.indexOf('\n\n');
    while (split >= 0) {
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
}

function createChunkState() {
  return { text: '', reasoning: '', textStarted: false, reasoningStarted: false, textEnded: false, reasoningEnded: false };
}

function closeBlock(state, kind) {
  const isReasoning = kind === 'reasoning';
  const started = isReasoning ? state.reasoningStarted : state.textStarted;
  const endedKey = isReasoning ? 'reasoningEnded' : 'textEnded';
  if (!started || state[endedKey]) return [];
  state[endedKey] = true;
  const value = isReasoning ? state.reasoning : state.text;
  return [{ type: 'block-end', index: isReasoning ? 0 : 1, block: { type: isReasoning ? 'reasoning' : 'text', text: value } }];
}

function appendBlock(state, kind, value) {
  const text = String(value || '');
  if (!text) return [];
  const frames = [];
  if (kind === 'text' && state.reasoningStarted && !state.reasoningEnded) frames.push(...closeBlock(state, 'reasoning'));
  if (kind === 'reasoning' && state.textStarted && !state.textEnded) frames.push(...closeBlock(state, 'text'));
  const isReasoning = kind === 'reasoning';
  const startedKey = isReasoning ? 'reasoningStarted' : 'textStarted';
  const endedKey = isReasoning ? 'reasoningEnded' : 'textEnded';
  if (!state[startedKey]) {
    state[startedKey] = true;
    frames.push({ type: 'block-start', index: isReasoning ? 0 : 1, blockType: kind });
  }
  if (state[endedKey]) return frames;
  if (isReasoning) state.reasoning += text;
  else state.text += text;
  frames.push({ type: isReasoning ? 'reasoning-delta' : 'text-delta', index: isReasoning ? 0 : 1, text });
  return frames;
}

function finishBlocks(state) {
  return [...closeBlock(state, 'reasoning'), ...closeBlock(state, 'text'), { type: 'finish', reason: { kind: 'stop' } }];
}

async function* codexFrames(codexRuntime, options) {
  const state = createChunkState();
  for await (const chunk of codexRuntime.stream(options)) {
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
  if (event?.runtimeEvent?.event_type === 'run.completed') return finishBlocks(state);
  return [];
}

async function* localFrames(handler, payload) {
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
  const handlerPromise = Promise.resolve().then(() => handler(request, response)).catch(error => {
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

async function* cloudFrames(body) {
  const state = createChunkState();
  for await (const event of parseSse(body)) {
    const type = String(event?.type || event?.event || '');
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
  yield* finishBlocks(state);
}

/** Create the one provider route mounted by the AgentKit Studio host. */
export function createDshRuntimeAdapter({ cloudClient, localHandler, codexRuntime, codexResourceContext } = {}) {
  return {
    providerInfo(provider) { return { id: provider, name: 'AgentKit Studio Runtime' }; },
    resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model, modalities: ['text'] }); },
    async prepareCall(provider, model) {
      const metadata = await this.resolveModel(provider, model);
      return { model: metadata, stream: options => this.stream(options) };
    },
    async *stream(options = {}) {
      const model = String(options.model || '');
      const separator = model.indexOf(':');
      const mode = separator > 0 ? model.slice(0, separator) : 'cloud';
      const agentId = separator > 0 ? model.slice(separator + 1) : model;
      const user = lastUser(options.messages);
      const input = textOf(user).trim();
      if (!agentId || !input) throw new Error('AgentKit Studio runtime requires an AgentId and user input');
      if (mode === 'local') {
        if (options.studioRuntime === 'codex') {
          if (!codexRuntime || typeof codexRuntime.stream !== 'function') {
            const error = new Error('Codex Provider 未注册；请安装并启用官方 Codex App Server Provider');
            error.code = 'CODEX_PROVIDER_UNAVAILABLE';
            throw error;
          }
          const resources = typeof codexResourceContext === 'function'
            ? await codexResourceContext({
              agentId,
              buildId: String(options.buildId || ''),
              input,
              sessionId: String(options.sessionId || ''),
              userId: String(options.userId || options.metadata?.userId || options.user?.id || ''),
            })
            : {};
          yield* codexFrames(codexRuntime, {
            agentId,
            sessionId: String(options.sessionId || ''),
            input,
            messages: Array.isArray(options.messages) ? options.messages : [],
            signal: options.signal,
            systemPrompt: resources.systemPrompt || '',
            dynamicTools: resources.dynamicTools || [],
            toolHandler: resources.toolHandler,
          });
          return;
        }
        if (typeof localHandler !== 'function') throw new Error('AgentKit local runtime is unavailable');
        yield* localFrames(await localHandler(), {
          agentId,
          ...(options.buildId ? { buildId: options.buildId } : {}),
          sessionId: String(options.sessionId || ''),
          userId: String(options.userId || options.metadata?.userId || options.user?.id || ''),
          input,
          history: historyOf(options.messages),
        });
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
      yield* cloudFrames(upstream.body);
    },
  };
}

export const route = ROUTE;
