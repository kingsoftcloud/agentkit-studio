/**
 * Small Codex App Server adapter for the DSH runtime bridge.
 *
 * DSH's official Codex provider also talks to `codex app-server --stdio`.
 * Studio keeps the same protocol boundary here instead of pretending that a
 * Codex Agent is an OpenAI-compatible gateway model. Each Studio turn uses an
 * ephemeral Codex thread; DSH remains the owner of the visible Session and
 * conversation history.
 */
import { resolveCodexCommand } from './codex-command.mjs';
import { spawn as nodeSpawn } from 'node:child_process';
import { tmpdir } from 'node:os';

export class CodexRuntimeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CodexRuntimeError';
    this.code = code;
    this.details = details;
  }
}

function asError(value, fallback = 'Codex App Server 运行失败') {
  return value instanceof Error ? value : new CodexRuntimeError('CODEX_RUNTIME_FAILED', String(value || fallback));
}

function createQueue() {
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
    close(error) {
      if (closed) return;
      closed = true;
      failure = error;
      while (waiters.length) {
        const waiter = waiters.shift();
        if (error) waiter.reject(error);
        else waiter.resolve({ value: undefined, done: true });
      }
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

function textOf(message) {
  if (!message || typeof message !== 'object') return '';
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content.filter(part => part?.type === 'text' || part?.kind === 'text')
    .map(part => String(part.text || part.value || '')).join('');
}

function promptFor({ input, messages = [] }) {
  const history = messages.filter(message => message?.role === 'user' || message?.role === 'assistant')
    .map(message => `${message.role === 'user' ? 'User' : 'Assistant'}: ${textOf(message)}`)
    .filter(line => !line.endsWith(': ')).slice(-20);
  if (!history.length) return input;
  return [
    'Continue this conversation. Treat the latest User message as the task.',
    'Conversation context:',
    ...history,
    `User: ${input}`,
  ].join('\n');
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CodexRuntimeError('CODEX_PROTOCOL_INVALID', `Codex 返回了无效的 ${label}`);
  }
  return value;
}

function idOf(response, label) {
  const value = response?.result?.thread?.id || response?.result?.turn?.id;
  if (typeof value !== 'string' || !value) throw new CodexRuntimeError('CODEX_PROTOCOL_INVALID', `Codex 返回了无效的 ${label}`);
  return value;
}

function writeJson(stdin, message) {
  try {
    stdin.write(`${JSON.stringify(message)}\n`);
  } catch (error) {
    throw new CodexRuntimeError('CODEX_TRANSPORT_FAILED', '无法向 Codex App Server 写入请求', { cause: String(error?.message || error) });
  }
}

function isFinalPhase(phase) {
  return phase === 'final_answer' || phase === null || phase === undefined;
}

function isReasoningPhase(phase) {
  return phase === 'commentary' || phase === 'analysis' || phase === 'reasoning';
}

function dynamicToolContent(value) {
  const values = Array.isArray(value) ? value : [value];
  const contentItems = values.flatMap(item => {
    if (item && typeof item === 'object') {
      if (item.type === 'inputText' && typeof item.text === 'string') return [item];
      if ((item.type === 'image' || item.type === 'inputImage') && typeof (item.imageUrl || item.image_url) === 'string') return [{ type: 'inputImage', imageUrl: item.imageUrl || item.image_url }];
      if (item.type === 'audio' && typeof (item.audioUrl || item.audio_url) === 'string') return [{ type: 'inputAudio', audioUrl: item.audioUrl || item.audio_url }];
      if (typeof item.text === 'string') return [{ type: 'inputText', text: item.text }];
    }
    if (item !== undefined && item !== null) return [{ type: 'inputText', text: typeof item === 'string' ? item : JSON.stringify(item) }];
    return [];
  });
  return contentItems.length ? contentItems : [{ type: 'inputText', text: '' }];
}

/**
 * @param {{ executable?: string, spawnImpl?: Function, cwd?: string, model?: string, approvalPolicy?: string, sandbox?: string, env?: object, timeoutMs?: number }} options
 */
export function createCodexRuntime(options = {}) {
  const command = resolveCodexCommand({ executable: options.executable, env: { ...process.env, ...(options.env || {}) } });
  const executable = command.executable;
  const spawnImpl = options.spawnImpl || nodeSpawn;
  const cwd = String(options.cwd || tmpdir());
  const model = String(options.model || process.env.AGENTKIT_CODEX_MODEL || '').trim() || undefined;
  const approvalPolicy = String(options.approvalPolicy || process.env.AGENTKIT_CODEX_APPROVAL_POLICY || 'never');
  const sandbox = String(options.sandbox || process.env.AGENTKIT_CODEX_SANDBOX || '').trim() || undefined;
  const timeoutMs = Math.max(10_000, Number(options.timeoutMs) || 180_000);

  return {
    executable,
    cwd,
    async *stream({ input, messages = [], signal, systemPrompt = '', dynamicTools = [], toolHandler, model: requestedModel } = {}) {
      const selectedModel = String(requestedModel || model || '').trim() || undefined;
      const prompt = String(input || '').trim();
      if (!prompt) throw new CodexRuntimeError('CODEX_INPUT_INVALID', 'Codex 输入不能为空');
      if (signal?.aborted) throw asError(signal.reason, 'Codex 请求已取消');

      let child;
      try {
        child = spawnImpl(executable, [...command.prefixArgs, 'app-server', '--stdio'], {
          cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, ...(options.env || {}) },
        });
      } catch (error) {
        throw new CodexRuntimeError('CODEX_PROVIDER_UNAVAILABLE', `无法启动 Codex App Server（${executable}）`, { cause: String(error?.message || error) });
      }
      if (!child?.stdin || !child?.stdout) throw new CodexRuntimeError('CODEX_PROVIDER_UNAVAILABLE', 'Codex App Server 没有提供 stdio 通道');

      const queue = createQueue();
      const pending = new Map();
      let requestId = 0;
      let buffer = '';
      let threadId = '';
      let turnId = '';
      let closed = false;
      let disposed = false;
      let timer;
      const phases = new Map();
      const deltaItems = new Set();
      const finish = error => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        for (const resolver of pending.values()) resolver.reject(error || new CodexRuntimeError('CODEX_TRANSPORT_CLOSED', 'Codex 请求已关闭'));
        pending.clear();
        queue.close(error);
      };
      const onData = chunk => {
        buffer += Buffer.from(chunk).toString('utf8');
        let split = buffer.indexOf('\n');
        while (split >= 0) {
          const line = buffer.slice(0, split).trim();
          buffer = buffer.slice(split + 1);
          if (line) {
            let message;
            try { message = JSON.parse(line); } catch { message = null; }
            if (message) handleMessage(message);
          }
          split = buffer.indexOf('\n');
        }
      };
      const onError = error => {
        const missing = error?.code === 'ENOENT';
        finish(new CodexRuntimeError(
          missing ? 'CODEX_PROVIDER_UNAVAILABLE' : 'CODEX_TRANSPORT_FAILED',
          missing ? `找不到 Codex App Server（${executable}）` : 'Codex App Server 连接失败',
          { cause: String(error?.message || error) },
        ));
      };
      const onExit = (_code, _signal) => { if (!closed) finish(new CodexRuntimeError('CODEX_TRANSPORT_CLOSED', 'Codex App Server 提前退出')); };
      const handleDynamicToolCall = async message => {
        const params = object(message.params || {}, 'dynamic tool 参数');
        // The app-server owns the actual dynamic-tool lifecycle, but DSH still
        // owns the visible Session. Publish a small internal status event so
        // the native renderer can show the resource call while the request is
        // in flight. This is deliberately not a DSH `tool-call` block: DSH's
        // loop would try to execute that block a second time.
        queue.push({
          method: 'agentkit/tool/status',
          params: {
            phase: 'started',
            name: String(params.tool || ''),
            callId: String(params.callId || ''),
          },
        });
        let result;
        try {
          if (typeof toolHandler !== 'function') throw new CodexRuntimeError('CODEX_TOOL_UNAVAILABLE', `Codex 请求了未注册的工具：${String(params.tool || '')}`);
          const output = await toolHandler({
            name: String(params.tool || ''),
            namespace: params.namespace || null,
            arguments: params.arguments && typeof params.arguments === 'object' ? params.arguments : {},
            callId: String(params.callId || ''),
            threadId: String(params.threadId || threadId),
            turnId: String(params.turnId || turnId),
            signal,
          });
          result = { contentItems: dynamicToolContent(output), success: true };
        } catch (error) {
          result = { contentItems: [{ type: 'inputText', text: String(error?.message || error).slice(0, 2000) }], success: false };
        }
        try {
          queue.push({
            method: 'agentkit/tool/status',
            params: {
              phase: result.success ? 'completed' : 'failed',
              name: String(params.tool || ''),
              callId: String(params.callId || ''),
            },
          });
          writeJson(child.stdin, { jsonrpc: '2.0', id: message.id, result });
        } catch (error) { finish(asError(error)); }
      };
      const handleMessage = message => {
        // Server-initiated requests have a method and an id. Handle those
        // before matching response ids because both sides use integer ids.
        if (message.method && message.id !== undefined) {
          if (message.method === 'item/tool/call') {
            void handleDynamicToolCall(message);
            return;
          }
          // Unattended Studio turns never grant filesystem/command approvals.
          // Replying keeps the app-server protocol healthy and lets it publish
          // a typed declined item in the native conversation stream.
          const result = message.method === 'item/permissions/requestApproval'
            ? { permissions: {}, scope: 'turn' }
            : message.method === 'item/tool/requestUserInput'
              ? { answers: {} }
              : message.method === 'mcpServer/elicitation/request'
                ? { action: 'decline', content: null, _meta: null }
                : { decision: 'decline' };
          writeJson(child.stdin, { jsonrpc: '2.0', id: message.id, result });
          return;
        }
        if (message.id !== undefined && pending.has(message.id)) {
          const resolver = pending.get(message.id);
          pending.delete(message.id);
          if (message.error) resolver.reject(new CodexRuntimeError('CODEX_PROTOCOL_ERROR', String(message.error.message || 'Codex 请求失败'), { error: message.error }));
          else resolver.resolve(message);
          return;
        }
        if (message.method) queue.push(message);
      };
      const request = (method, params) => new Promise((resolve, reject) => {
        const id = ++requestId;
        pending.set(id, { resolve, reject });
        try { writeJson(child.stdin, { jsonrpc: '2.0', id, method, params }); }
        catch (error) { pending.delete(id); reject(error); }
      });
      child.stdout.on('data', onData);
      child.stdout.on('error', onError);
      child.stdin.on?.('error', onError);
      child.on?.('error', onError);
      child.on?.('exit', onExit);
      timer = setTimeout(() => finish(new CodexRuntimeError('CODEX_TIMEOUT', 'Codex App Server 运行超时')), timeoutMs);
      const abort = () => {
        if (turnId && threadId) {
          try { writeJson(child.stdin, { jsonrpc: '2.0', id: ++requestId, method: 'turn/interrupt', params: { threadId, turnId } }); } catch {}
        }
        finish(new CodexRuntimeError('CODEX_CANCELED', 'Codex 运行已取消'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        signal?.removeEventListener('abort', abort);
        if (!closed) finish();
        try { child.stdin.end?.(); } catch {}
        try { child.kill?.('SIGTERM'); } catch {}
      };
      try {
        await request('initialize', { clientInfo: { name: 'agentkit-studio', version: '0.0.1' }, capabilities: { experimentalApi: true } });
        writeJson(child.stdin, { method: 'initialized', params: {} });
        const developerInstructions = [String(systemPrompt || '').trim()].filter(Boolean).join('\n\n');
        const threadParams = {
          cwd,
          ephemeral: true,
          approvalPolicy,
          ...(sandbox ? { sandbox } : {}),
          ...(selectedModel ? { model: selectedModel } : {}),
          ...(developerInstructions ? { developerInstructions } : {}),
          ...(Array.isArray(dynamicTools) && dynamicTools.length ? { dynamicTools } : {}),
        };
        threadId = idOf(await request('thread/start', threadParams), 'thread id');
        const turn = await request('turn/start', { threadId, input: [{ type: 'text', text: promptFor({ input: prompt, messages }), text_elements: [] }] });
        turnId = idOf(turn, 'turn id');

        for await (const message of queue) {
          const method = String(message.method || '');
          const params = object(message.params || {}, `${method} 参数`);
          if (params.threadId && params.threadId !== threadId) continue;
          if (params.turnId && params.turnId !== turnId) continue;
          if (method === 'item/started') {
            const item = object(params.item || {}, 'item');
            if (item.id) phases.set(String(item.id), item.phase);
            continue;
          }
          if (method === 'agentkit/tool/status') {
            const phase = String(params.phase || '');
            const name = String(params.name || 'bound tool');
            if (phase === 'started') yield { type: 'tool', phase, name };
            else if (phase === 'completed' || phase === 'failed') yield { type: 'tool', phase, name };
            continue;
          }
          if (method === 'item/agentMessage/delta') {
            const delta = String(params.delta || '');
            if (!delta) continue;
            if (params.itemId) deltaItems.add(String(params.itemId));
            const phase = phases.get(String(params.itemId || ''));
            yield { type: isReasoningPhase(phase) ? 'reasoning' : 'text', text: delta };
            continue;
          }
          if (method === 'item/reasoning/summaryTextDelta' || method === 'item/plan/delta') {
            const delta = String(params.delta || params.text || '');
            if (delta) yield { type: 'reasoning', text: delta };
            continue;
          }
          if (method === 'item/completed') {
            const item = object(params.item || {}, 'completed item');
            if (item.id) phases.set(String(item.id), item.phase);
            if (item.type === 'agentMessage' && !deltaItems.has(String(item.id || '')) && typeof item.text === 'string' && item.text) {
              yield { type: isFinalPhase(item.phase) ? 'text' : 'reasoning', text: item.text };
            }
            continue;
          }
          if (method === 'turn/completed') {
            const turnResult = object(params.turn || {}, 'completed turn');
            if (turnResult.status !== 'completed') throw new CodexRuntimeError('CODEX_TURN_FAILED', `Codex Turn 结束状态：${String(turnResult.status || 'unknown')}`, { error: turnResult.error || null });
            break;
          }
        }
      } catch (error) {
        throw asError(error);
      } finally {
        for (const resolver of pending.values()) resolver.reject(new CodexRuntimeError('CODEX_TRANSPORT_CLOSED', 'Codex 请求已关闭'));
        pending.clear();
        dispose();
      }
    },
  };
}
