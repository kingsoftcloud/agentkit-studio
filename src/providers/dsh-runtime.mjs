import { randomUUID } from 'node:crypto';
import { nativeCodexUsage } from './codex-usage.mjs';
/**
 * DSH LLM adapter for Studio-owned Agent revisions.
 *
 * The adapter keeps the official DSH Session/Conversation renderer and durable
 * event loop in charge. Studio only translates the assembled DSH request into
 * the AgentEngine/local-runtime stream and back into DSH text chunks.
 */
import { prepareLocalResourceContext, writeBoundMemory } from '../local-runtime.mjs';
import { readSse } from '../sse.mjs';
import { CODEX_PROVIDER } from './codex-models.mjs';
import { dshModelFailure } from '../model-failure.mjs';
import { createCodexToolRecorder } from './codex-tool-events.mjs';
import { gatewayHistory } from './dsh-messages.mjs';
import { assertStudioRuntimeType, assertStudioRunBinding } from '../runtime-contract.mjs';
import { resolveRuntimeBridge } from '../host/runtime-bridge.mjs';

const ROUTE = 'agentkit-studio';

/**
 * Agent preset scopes dispatch `agent/request` before the root Agent loop
 * calls `llm.stream`. Keep the selected scope's transport context across that
 * boundary without exposing a Studio-specific model in the native picker.
 */
export function bindDshAgentRoute(sessionId, binding = {}, owner, scope) {
  const id = String(sessionId || '').trim();
  if (!id) return () => {};
  const runtime = String(binding.runtime || 'harness').trim();
  const local = binding.local === true;
  const buildId = String(binding.buildId || '').trim();
  const revision = Number(binding.agentRevision);
  if (local && runtime !== 'codex' && buildId && (!Number.isInteger(revision) || revision < 1)) {
    throw Object.assign(new Error('冻结 DSH Build 路由必须绑定正整数 Agent revision'), { code: 'RUN_IDENTITY_INVALID' });
  }
  const route = {
    agentId: String(binding.agentId || '').trim(),
    agent: binding.agent,
    runtime,
    local,
    buildId,
    agentRevision: binding.agentRevision,
    cloudVersionId: binding.cloudVersionId,
    toolAdapter: binding.toolAdapter,
    nativeTools: binding.nativeTools === true,
  };
  return resolveRuntimeBridge(owner).bindRoute(id, route, scope);
}

export function unbindDshAgentRoutes(agentId, owner) {
  resolveRuntimeBridge(owner).unbindAgentRoutes(agentId);
}

/**
 * Publish the Host-owned bridge to preset-scoped DSH plugins. The plugin uses
 * the `llm/stream` waterfall, so the durable DSH request keeps its original
 * provider/model (and the native model picker stays truthful) while only the
 * actual transport call is delegated to Studio.
 */
export function setDshRuntimeAdapter(adapter, owner) {
  return resolveRuntimeBridge(owner).setAdapter(adapter);
}

/**
 * Install the Host-owned executor used by the public DSH ToolRegistry bridge.
 * The registry lives in the DSH loop, while MCP credentials and transports
 * remain private to the Studio Host process.
 */
export function setDshResourceToolExecutor(executor, owner) {
  return resolveRuntimeBridge(owner).setResourceToolExecutor(executor);
}

export async function executeDshResourceTool(input = {}, owner) {
  return resolveRuntimeBridge(owner).executeResourceTool(input);
}

export function streamDshRuntime(options, { agentId, runtime, local, buildId, agentRevision, cloudVersionId, toolAdapter, nativeTools } = {}, owner) {
  const id = String(agentId || '').trim();
  if (!id) throw new Error('AgentKit Studio runtime bridge is unavailable');
  const runtimeType = assertStudioRuntimeType(runtime || 'harness');
  const sessionId = String(options.sessionId || '').trim();
  const frozenDshBuild = local === true && runtimeType !== 'codex' && Boolean(String(buildId || '').trim());
  const runId = String(options.runId || options.turnId || options.requestId || (frozenDshBuild ? `run_${randomUUID()}` : '')).trim();
  if (frozenDshBuild) {
    assertStudioRunBinding({ agentId: id, buildId, revision: agentRevision, sessionId, runId }, { agentId: id, sessionId });
  } else if (runId) {
    assertStudioRunBinding({ agentId: id, buildId, revision: agentRevision, sessionId, runId }, { agentId: id, sessionId });
  }
  const mode = local === true ? 'local' : 'cloud';
  return resolveRuntimeBridge(owner).stream(options, scoped => ({
    ...scoped,
    ...(runId ? { runId } : {}),
    studioSelectedModel: options.model,
    ...(options.provider === CODEX_PROVIDER ? { studioCodexModel: options.model } : {}),
    model: `${mode}:${id}`,
    studioRuntime: runtimeType,
    ...(buildId ? { buildId } : {}),
    ...(agentRevision ? {agentRevision} : {}),
    ...(cloudVersionId ? { cloudVersionId } : {}),
    ...(toolAdapter ? { studioToolAdapter: toolAdapter } : {}),
    ...(nativeTools ? { studioNativeTools: true } : {}),
  }));
}

/** A single Host waterfall owns transport selection; unrelated LLM calls
 * (including titles) retain their original adapter and credentials. */
export function routeDshRuntime(options, next, owner) {
  const route = resolveRuntimeBridge(owner).getRoute(options?.sessionId);
  return route ? streamDshRuntime(options, route, owner) : next();
}

function textOf(message) {
  if (!message || typeof message !== 'object') return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(part => part?.type === 'text' || part?.kind === 'text')
    .map(part => String(part.text || part.value || '')).join('');
}

function isUserInput(message) {
  return message?.role === 'user' && (!message.source || message.source.kind === 'user');
}

function lastUser(messages) {
  return [...(Array.isArray(messages) ? messages : [])].reverse()
    .find(isUserInput);
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
  const abort = () => { try { void reader.cancel?.(signal.reason); } catch {} };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const chunks = {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (signal?.aborted) throw cloudCancelledError(signal.reason);
          const { done, value } = await reader.read();
          if (signal?.aborted) throw cloudCancelledError(signal.reason);
          if (done) break;
          yield value;
        }
      },
    };
    yield* readSse(chunks);
  } catch (error) {
    if (signal?.aborted) throw cloudCancelledError(signal.reason);
    if (error instanceof SyntaxError) throw Object.assign(new Error('云端 Agent 流包含无效事件'), { code: 'CLOUD_STREAM_INVALID' });
    if (error?.code === 'UPSTREAM_STREAM_TRUNCATED') throw Object.assign(new Error('云端 Agent 流在事件结束前断开'), { code: 'CLOUD_STREAM_INCOMPLETE' });
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    try { reader.releaseLock?.(); } catch {}
  }
}

function createChunkState() {
  return {
    currentKind: '', currentIndex: -1, currentText: '', nextIndex: 0,
    toolNames: new Map(), toolStarted: new Set(), lastTextByKind: new Map(), finished: false,
  };
}

function closeCurrentBlock(state) {
  if (!state.currentKind || state.currentIndex < 0) return [];
  const index = state.currentIndex;
  const block = { type: state.currentKind, text: state.currentText };
  state.lastTextByKind.set(state.currentKind, state.currentText);
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
  state.lastTextByKind.set(kind, state.currentText);
  frames.push({ type: kind === 'reasoning' ? 'reasoning-delta' : 'text-delta', index: state.currentIndex, text });
  return frames;
}

function appendSnapshot(state, kind, value) {
  const text = String(value || '');
  if (!text) return [];
  const previous = state.lastTextByKind.get(kind) || '';
  if (text === previous) return [];
  if (text.startsWith(previous)) return appendBlock(state, kind, text.slice(previous.length));
  if (state.currentKind === kind && state.currentText === previous) {
    // The provider's done/replace event is authoritative. Update the open
    // block without emitting the same full snapshot as a second delta.
    state.currentText = text;
    state.lastTextByKind.set(kind, text);
    return [];
  }
  return [...closeCurrentBlock(state), ...appendBlock(state, kind, text)];
}

function finishBlocks(state, kind = 'stop') {
  if (state.finished) return [];
  state.finished = true;
  return [...closeCurrentBlock(state), { type: 'finish', reason: { kind } }];
}

function appendNativeToolCall(state, call) {
  const id = String(call?.id || '').trim();
  const name = String(call?.name || '').trim();
  if (!id || !name) return [];
  const index = state.nextIndex++;
  return [
    ...closeCurrentBlock(state),
    { type: 'block-start', index, blockType: 'tool-call' },
    { type: 'tool-call-delta', index, id, name, argumentsDelta: String(call.arguments || '{}') },
    { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: String(call.arguments || '{}') } },
  ];
}

async function* codexFrames(codexRuntime, options, onChunk, toolRecorder) {
  const state = createChunkState();
  const usage = { inputTokens: 0, outputTokens: 0 };
  for await (const chunk of codexRuntime.stream(options)) {
    onChunk?.(chunk);
    if (chunk?.type === 'usage') {
      for (const [key, value] of Object.entries(chunk.usage)) usage[key] = (usage[key] || 0) + value;
      yield { type: 'usage', usage: nativeCodexUsage(usage) };
    }
    else if (chunk?.type === 'reasoning') yield* appendBlock(state, 'reasoning', chunk.text);
    else if (chunk?.type === 'tool') {
      if (toolRecorder?.record(chunk)) continue;
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
    error.code = item.payload?.code || 'STUDIO_LOCAL_RUNTIME_FAILED';
    error.details = item.payload?.details;
    throw error;
  }
  if (event?.runtimeEvent?.event_type === 'run.failed') {
    const error = new Error('AgentKit Studio 本地运行失败');
    error.code = 'STUDIO_LOCAL_RUNTIME_FAILED';
    throw error;
  }
  if (item?.kind === 'assistant_reasoning') return appendBlock(state, 'reasoning', item.payload?.operation === 'append' ? item.payload.text : '');
  if (item?.kind === 'assistant_text') return appendBlock(state, 'text', item.payload?.operation === 'append' ? item.payload.text : '');
  if (item?.kind === 'usage') {
    state.usage ||= { inputTokens: 0, outputTokens: 0 };
    for (const [key, value] of Object.entries(item.payload.usage)) state.usage[key] = (state.usage[key] || 0) + value;
    return [{ type: 'usage', usage: nativeCodexUsage(state.usage) }];
  }
  if (item?.kind === 'tool_call') {
    const callId = String(item.payload?.callId || '');
    const name = String(item.payload?.name || 'bound tool');
    if (callId) state.toolNames.set(callId, name);
    if (item.payload?.protocol === 'dsh') return appendNativeToolCall(state, { id: callId, name, arguments: item.payload?.arguments });
    return appendBlock(state, 'reasoning', `工具 ${name} 正在调用。`);
  }
  if (item?.kind === 'tool_result') {
    const callId = String(item.payload?.callId || '');
    const name = state.toolNames.get(callId) || 'bound tool';
    const phase = item.lifecycle === 'failed' ? '失败' : '已完成';
    return appendBlock(state, 'reasoning', `工具 ${name} ${phase}。`);
  }
  if (item?.kind === 'progress' && item.payload?.status === 'tool_calls') return finishBlocks(state, 'tool-calls');
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

export async function* cloudFrames(body, signal, { onEvent } = {}) {
  const state = createChunkState();
  const textItems = new Map();
  let activeTextKey;
  const textFrames = (kind, event, snapshot = false, done = false) => {
    const identity = event.item_id ?? event.output_index;
    const text = String((done ? event.text : event.delta) || '');
    if (identity === undefined) return [
      ...(snapshot ? appendSnapshot(state, kind, text) : appendBlock(state, kind, text)),
      ...(done ? closeBlock(state, kind) : []),
    ];
    const key = JSON.stringify([kind, identity, event.content_index ?? event.summary_index ?? 0]);
    const previous = textItems.get(key) || '';
    if (done && typeof event.text !== 'string') return activeTextKey === key ? closeBlock(state, kind) : [];
    if (snapshot && text === previous) {
      return done && activeTextKey === key ? closeBlock(state, kind) : [];
    }
    const frames = [];
    if (snapshot && textItems.has(key) && activeTextKey !== key) {
      throw Object.assign(new Error('云端已结束的消息内容发生变化'), { code: 'CLOUD_STREAM_ITEM_CHANGED' });
    }
    if (snapshot && !text.startsWith(previous)) {
      // A correction can replace an open block, but a late snapshot must never
      // overwrite another item's block or append an already displayed answer.
      if (activeTextKey !== key || state.currentKind !== kind || state.currentText !== previous) {
        throw Object.assign(new Error('云端已结束的消息内容发生变化'), { code: 'CLOUD_STREAM_ITEM_CHANGED' });
      }
      frames.push(...appendSnapshot(state, kind, text));
    } else {
      if (activeTextKey !== key) {
        frames.push(...closeCurrentBlock(state));
        activeTextKey = key;
      }
      frames.push(...appendBlock(state, kind, snapshot ? text.slice(previous.length) : text));
    }
    textItems.set(key, snapshot ? text : previous + text);
    if (done) frames.push(...closeBlock(state, kind));
    return frames;
  };
  let completed = false;
  for await (const event of parseSse(body, signal)) {
    if (signal?.aborted) throw cloudCancelledError(signal.reason);
    const type = String(event?.type || event?.event || '');
    if (await onEvent?.(event)) continue;
    if (/^response\.(failed|error)$/i.test(type) || /^error$/i.test(type)) {
      const detail = String(event?.error?.message || event?.message || '云端 Agent 运行失败').slice(0, 500);
      throw Object.assign(new Error(detail), { code: 'CLOUD_RUN_FAILED' });
    }
    if (/^response\.incomplete$/i.test(type)) {
      throw Object.assign(new Error('云端 Agent 流未完整结束'), { code: 'CLOUD_STREAM_INCOMPLETE' });
    }
    if (/^response\.cancel(?:ed|led)$/i.test(type)) throw cloudCancelledError();
    if (/^response\.completed$/i.test(type)) {
      completed = true;
      const usage = event.response?.usage || event.usage;
      if (usage && ['input_tokens', 'output_tokens'].every(key => Number.isSafeInteger(usage[key]) && usage[key] >= 0)) {
        yield { type: 'usage', usage: nativeCodexUsage({ inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
          cachedInputTokens: usage.input_tokens_details?.cached_tokens || 0, reasoningTokens: usage.output_tokens_details?.reasoning_tokens }) };
      }
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
    if (type.includes('reasoning_summary_text.delta')) {
      yield* textFrames('reasoning', event, event.replace === true);
    } else if (type.includes('output_text.delta')) {
      yield* textFrames('text', event, event.replace === true);
    } else if (type.includes('reasoning_summary_text.done')) {
      yield* textFrames('reasoning', event, true, true);
    } else if (type.includes('output_text.done')) {
      yield* textFrames('text', event, true, true);
    }
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
export function createDshRuntimeAdapter({ cloudClient, cloudRuntime, localHandler, codexRuntime, resolveCodexModel, codexResourceContext, resourceAdapter, observability, attachments, AdapterBase, bridge } = {}) {
  const adapter = {
    providerInfo(provider) { return { id: provider, name: 'AgentKit Studio Runtime' }; },
    resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model, modalities: ['text'] }); },
    async prepareCall(provider, model) {
      const metadata = await this.resolveModel(provider, model);
      return { model: metadata, stream: options => this.stream(options) };
    },
    async *stream(options = {}) {
      const routed = resolveRuntimeBridge(bridge).getRoute(options.sessionId);
      if (options.provider === CODEX_PROVIDER && !routed && !options.studioRuntime) throw Object.assign(new Error('请先绑定 Codex Agent，再选择 Codex 模型。'), { code: 'CODEX_AGENT_REQUIRED' });
      const model = String(options.model || '');
      const separator = model.indexOf(':');
      const mode = routed ? (routed.local ? 'local' : 'cloud') : separator > 0 ? model.slice(0, separator) : 'cloud';
      const agentId = routed?.agentId || (separator > 0 ? model.slice(separator + 1) : model);
      const runtime = routed?.runtime || options.studioRuntime;
      const toolAdapter = options.studioToolAdapter || routed?.toolAdapter;
      const nativeTools = options.studioNativeTools === true || routed?.nativeTools === true;
      const buildId = String(options.buildId || routed?.buildId || '').trim();
      const agentRevision = routed?.agentRevision || options.agentRevision;
      const toolAgent = routed?.agent || options.agent;
      const user = lastUser(options.messages);
      const input = textOf(user).trim();
      const hasImage = Array.isArray(user?.content) && user.content.some(block => block?.type === 'image' && block.offloaded !== true);
      if (!agentId) throw Object.assign(new Error('请先绑定 Agent，再发送消息'), { code: 'STUDIO_AGENT_REQUIRED' });
      if (!input && !hasImage) throw Object.assign(new Error('请输入文字或添加图片后发送'), { code: 'STUDIO_INPUT_REQUIRED' });
      if (mode === 'local') {
        const history = await gatewayHistory(options.messages, { attachments, signal: options.signal });
        const content = [...history].reverse().find(message => message.role === 'user')?.content || input;
        if (runtime === 'codex') {
          // DSH persists the selected workspace on the official Session header;
          // its Codex subagent uses this same seam. Keep it scoped to this turn.
          const cwd = toolAgent?.session?.header?.cwd;
          if (toolAgent && !cwd) throw Object.assign(new Error('DSH 会话未提供 Codex 工作目录，请重新选择工作区'), { code: 'CODEX_WORKSPACE_UNAVAILABLE' });
          const selection = { provider: options.provider, model: options.studioSelectedModel || options.studioCodexModel || options.model };
          const selected = options.provider && options.provider !== CODEX_PROVIDER
            ? await (typeof resolveCodexModel === 'function' ? resolveCodexModel(selection) : Promise.reject(Object.assign(new Error('此模型提供商未配置 Codex 接口，请在模型设置中检查配置。'), { code: 'CODEX_MODEL_PROVIDER_UNAVAILABLE' })))
            : { model: options.studioCodexModel || (options.provider === CODEX_PROVIDER ? selection.model : undefined) };
          if (!codexRuntime || typeof codexRuntime.stream !== 'function') {
            const error = new Error('Codex Provider 未注册；请安装并启用官方 Codex App Server Provider');
            error.code = 'CODEX_PROVIDER_UNAVAILABLE';
            throw error;
          }
          const resources = typeof codexResourceContext === 'function'
            ? await codexResourceContext({
              agentId,
              buildId,
              agentRevision,
              input,
              sessionId: String(options.sessionId || ''),
              userId: String(options.userId || options.metadata?.userId || options.user?.id || ''),
              toolAdapter,
              agent: toolAgent,
            })
            : {};
          const startedAt = new Date().toISOString();
          const traceId = String(options.runId || options.turnId || `run_codex_${Date.now().toString(36)}`);
          const traceEvents = [{ event_type: 'run.started', at: startedAt, run_id: traceId, session_id: String(options.sessionId || '') }];
          const toolRecorder = createCodexToolRecorder(toolAgent?.session, { recordModelContext: true });
          let responseText = '';
          const recordChunk = chunk => {
            const type = String(chunk?.type || '');
            const at = new Date().toISOString();
            if (type === 'usage') traceEvents.push({ event_type: 'model.usage', at, run_id: traceId, payload: { source: 'codex-app-server', usage: chunk.usage } });
            else if (type === 'request-metrics') traceEvents.push({ event_type: 'model.request', at, run_id: traceId, payload: chunk.metrics });
            else if (type === 'tool') traceEvents.push({ event_type: `tool.${String(chunk.phase || 'update')}`, at, run_id: traceId, payload: { name: String(chunk.name || 'bound tool') } });
            else if (type === 'reasoning' || type === 'text') {
              if (type === 'text') responseText += String(chunk.text || '');
              traceEvents.push({ event_type: `turn.${type}`, at, run_id: traceId, payload: { chars: String(chunk.text || '').length } });
            }
          };
          try {
            yield* codexFrames(codexRuntime, {
              agentId,
              ...(cwd ? { cwd } : {}),
              ...selected,
              sessionId: String(options.sessionId || ''),
              input,
              messages: Array.isArray(options.messages) ? options.messages : [],
              imageInputs: history.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'image_url').map(part => part.image_url.url) : []),
              signal: options.signal,
              systemPrompt: resources.systemPrompt || '',
              dynamicTools: resources.dynamicTools || [],
              toolHandler: resources.toolHandler,
            }, recordChunk, toolRecorder);
            if (typeof resources.writeMemory === 'function') {
              try {
                const result = await resources.writeMemory(responseText);
                traceEvents.push({ event_type: 'memory.write', at: new Date().toISOString(), run_id: traceId, payload: { accepted: result?.accepted === true } });
              } catch (error) {
                traceEvents.push({ event_type: 'memory.write.failed', at: new Date().toISOString(), run_id: traceId, payload: { code: String(error?.code || 'MEMORY_WRITE_FAILED') } });
              }
            }
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
          } finally {
            toolRecorder?.close();
          }
          return;
        }
        if (typeof localHandler !== 'function') throw new Error('AgentKit local runtime is unavailable');
        try { yield* localFrames(await localHandler(), {
          agentId,
          ...(buildId ? { buildId } : {}),
          ...(agentRevision ? {agentRevision} : {}),
          sessionId: String(options.sessionId || ''),
          userId: String(options.userId || options.metadata?.userId || options.user?.id || ''),
          input,
          content,
          history,
          ...(nativeTools ? { systemPrompt: (Array.isArray(options.messages) ? options.messages : []).filter(message => message?.role === 'system').map(textOf).filter(Boolean).join('\n\n') } : {}),
          ...(options.provider ? { modelSelection: { provider: options.provider, model: options.studioSelectedModel || options.model } } : {}),
          nativeTools,
          tools: Array.isArray(options.tools) ? options.tools : [],
        }, { signal: options.signal, toolAdapter, agent: toolAgent }); }
        catch (error) {
          // In a waterfall, throwing is a plugin failure. A public failure
          // finish lets DSH retry this model step and retain durable history.
          // Never replay a standalone loop that may already have run tools.
          const failure = nativeTools && !options.signal?.aborted && dshModelFailure(error);
          if (!failure) throw error;
          yield { type: 'finish', reason: { kind: 'error', failure } };
        }
        return;
      }
      if (hasImage) throw Object.assign(new Error('当前云端 Agent 镜像尚不支持图片输入，请使用本地 Agent'), { code: 'CLOUD_IMAGE_INPUT_UNAVAILABLE' });
      if (cloudRuntime) {
        yield* cloudRuntime({ ...options, agentId, cloudVersionId: routed?.cloudVersionId || options.cloudVersionId, userMessage: user, input, session: toolAgent?.session });
        return;
      }
      if (!cloudClient || typeof cloudClient.streamAction !== 'function') throw new Error('AgentEngine cloud runtime is unavailable');
      const sessionId = String(options.sessionId || '');
      const invocationId = String(options.invocationId || options.runId || '').trim();
      // ComponentConfig persists a cloud resource reference, but a custom
      // runtime does not automatically expose a knowledge or Skill tool to
      // RunAgent. Materialize bound resources at the Host boundary and send
      // the bounded context as a system message before the user turn.
      let cloudMessages = [{ role: 'user', content: input }];
      let cloudRecord = toolAgent && typeof toolAgent === 'object'
        ? toolAgent : { id: agentId };
      let preparedCloudResources = null;
      // The preset-scoped DSH Agent object is intentionally lightweight. Read
      // the authoritative cloud Agent detail when it does not carry the
      // normalized ComponentConfig projection needed by the resource adapter.
      if ((!Array.isArray(cloudRecord.spec?.bindings?.plugins)) && typeof cloudClient.getAgent === 'function') {
        cloudRecord = await cloudClient.getAgent(agentId, { signal: options.signal });
      }
      const cloudBindings = cloudRecord.spec?.bindings;
      const hasPlatformBindings = Array.isArray(cloudBindings?.plugins)
        && cloudBindings.plugins.some(item => {
          const kind = item?.config?.binding?.resource?.kind;
          return kind === 'knowledge-base' || kind === 'memory-instance' || kind === 'skill-space';
        });
      if (hasPlatformBindings) {
        if (!resourceAdapter) {
          const error = new Error('云端 Agent 绑定了平台资源，但 Studio 资源适配器不可用');
          error.code = 'CLOUD_RESOURCE_ADAPTER_MISSING';
          throw error;
        }
        const prepared = await prepareLocalResourceContext({
          record: cloudRecord,
          input,
          resourceAdapter,
          userId: String(options.userId || options.metadata?.userId || 'studio-anonymous'),
          agentId,
          agent: toolAgent,
        });
        preparedCloudResources = prepared;
        if (prepared.resourceContext) {
          cloudMessages = [
            {
              role: 'system',
              content: [
                '以下内容由 AgentKit Studio 在本轮从当前 Agent 绑定的知识库、记忆库或 Skill Space 读取。',
                '请把它作为受限上下文使用；如果上下文没有答案，请明确说明，不要编造召回结果。',
                prepared.resourceContext.slice(0, 48000),
              ].join('\n\n'),
            },
            ...cloudMessages,
          ];
        }
      }
      try {
        const upstream = await cloudClient.streamAction('RunAgent', {
          AgentId: agentId,
          SessionId: sessionId,
          Messages: cloudMessages,
          Stream: true,
          ApiFormat: 'responses',
          ...(invocationId ? { InvocationId: invocationId } : {}),
        }, { signal: options.signal });
        let assistantText = '';
        for await (const frame of cloudFrames(upstream.body, options.signal)) {
          if (frame?.type === 'text-delta') assistantText += String(frame.text || '');
          yield frame;
        }
        if (preparedCloudResources?.memoryWrite && preparedCloudResources.memory) {
          try {
            await writeBoundMemory({
              agent: toolAgent,
              binding: preparedCloudResources.memory,
              resourceAdapter,
              input,
              assistantText,
              userId: String(options.userId || options.metadata?.userId || 'studio-anonymous'),
              sessionId,
              agentId,
            });
          } catch (error) {
            // Memory persistence is a post-response side effect. Preserve the
            // completed cloud answer while allowing the adapter to report the
            // typed write error through its own trace/logging path.
            console.warn('[agentkit-studio] cloud memory write failed:', error?.message || error);
          }
        }
      } catch (error) {
        if (options.signal?.aborted && typeof cloudClient.action === 'function') {
          // Closing the local SSE is not a cloud cancellation. Send the
          // explicit Server control action after the upstream stream is
          // aborted; cancellation is best-effort because the original
          // cancellation must still surface as CLOUD_RUN_CANCELLED.
          await cloudClient.action('CancelRun', {
            AgentId: agentId,
            SessionId: sessionId,
            ...(invocationId ? { InvocationId: invocationId } : {}),
          }).catch(() => {});
        }
        throw error;
      }
    },
  };
  if (bridge) {
    const stream = adapter.stream;
    adapter.stream = options => bridge.trackStream(options || {}, scoped => stream.call(adapter, scoped));
  }
  if (!AdapterBase) return adapter;
  class StudioAdapter extends AdapterBase {}
  return Object.assign(new StudioAdapter(), adapter);
}

export const route = ROUTE;
