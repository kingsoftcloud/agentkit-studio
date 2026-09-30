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

export function streamDshRuntime(options, { agentId, runtime, local } = {}) {
  const id = String(agentId || '').trim();
  if (!id || !activeAdapter) throw new Error('AgentKit Studio runtime bridge is unavailable');
  const mode = local === true ? 'local' : 'cloud';
  return activeAdapter.stream({ ...options, model: `${mode}:${id}`, studioRuntime: runtime });
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

function makeDshChunks(text) {
  const value = String(text || '');
  return value ? [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: value },
    { type: 'block-end', index: 0, block: { type: 'text', text: value } },
    { type: 'finish', reason: { kind: 'stop' } },
  ] : [
    { type: 'finish', reason: { kind: 'stop' } },
  ];
}

async function* localFrames(handler, payload) {
  const requestBody = Buffer.from(JSON.stringify(payload));
  const chunks = [];
  const request = {
    async *[Symbol.asyncIterator]() { yield requestBody; },
  };
  const response = {
    headersSent: false,
    writableEnded: false,
    statusCode: 200,
    writeHead(status) { this.headersSent = true; this.statusCode = status; },
    write(chunk) { chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)); },
    end(chunk = '') { if (chunk) this.write(chunk); this.writableEnded = true; },
  };
  await handler(request, response);
  if (response.statusCode >= 400) {
    const raw = chunks.join('');
    let detail;
    try { detail = JSON.parse(raw)?.error; } catch { detail = undefined; }
    const error = new Error(detail?.message || `Studio local runtime failed (${response.statusCode})`);
    error.code = detail?.code || 'STUDIO_LOCAL_RUNTIME_FAILED';
    throw error;
  }
  const records = chunks.join('').split(/(?=data: )/g);
  let text = '';
  for (const record of records) {
    const line = record.split(/\r?\n/).find(item => item.startsWith('data:'));
    if (!line) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]') continue;
    try {
      const event = JSON.parse(raw);
      const item = event?.conversationItem;
      if (item?.kind === 'assistant_text') {
        const payloadText = String(item?.payload?.text || '');
        if (item?.payload?.operation === 'append') text += payloadText;
        else if (payloadText) text = payloadText;
      }
    } catch { /* ignore non-json terminal marker */ }
  }
  yield* makeDshChunks(text);
}

/** Create the one provider route mounted by the AgentKit Studio host. */
export function createDshRuntimeAdapter({ cloudClient, localHandler } = {}) {
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
        if (typeof localHandler !== 'function') throw new Error('AgentKit local runtime is unavailable');
        yield* localFrames(await localHandler(), {
          agentId,
          sessionId: String(options.sessionId || ''),
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
      let text = '';
      for await (const event of parseSse(upstream.body)) {
        const delta = event?.delta || event?.output_text?.delta || event?.response?.output_text?.delta;
        if (typeof delta === 'string') text += delta;
      }
      yield* makeDshChunks(text);
    },
  };
}

export const route = ROUTE;
