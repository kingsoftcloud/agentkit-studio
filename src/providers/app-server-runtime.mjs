import { readExecutionMode } from '../execution-policy.mjs';
import { spawn as nodeSpawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { isAbsolute } from 'node:path';
import { createCodexUsageCounter } from './codex-usage.mjs';
import { codexItemToolChunk, createCodexCommandFallback } from './codex-tool-events.mjs';
import { codexConversationPrompt } from './codex-history.mjs';

export class AppServerRuntimeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
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

function isFinalPhase(phase) {
  return phase === 'final_answer' || phase === 'partial_answer' || phase === null || phase === undefined;
}

function isReasoningPhase(phase) {
  return phase === 'commentary' || phase === 'analysis' || phase === 'reasoning';
}

function normalizeReasoningSummary(value) {
  const candidate = String(value ?? '').trim().toLowerCase();
  return ['auto', 'concise', 'detailed', 'none'].includes(candidate) ? candidate : 'detailed';
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

function completedReasoningText(item) {
  const summary = Array.isArray(item?.summary) ? item.summary : [];
  const content = Array.isArray(item?.content) ? item.content : [];
  const read = values => values.map(value => typeof value === 'string' ? value : value?.text).filter(Boolean).join('\n\n');
  // Public summaries are preferred. Raw content is only a fallback for
  // App Server providers (for example open-source models) that expose no
  // summary item at all.
  return read(summary) || read(content);
}

/** One app-server process per operation. The Host owns the business transcript. */
export function createAppServerRuntime(options, { id, label, ErrorClass, command, verifyModel, classifyError, admitModel }) {
  const envPrefix = `AGENTKIT_${id.toUpperCase()}`;
  const failure = (code, message, details) => new ErrorClass(`${id.toUpperCase()}_${code}`, message, details);
  const asError = (value, fallback = `${label} App Server 运行失败`) =>
    value instanceof Error ? value : failure('RUNTIME_FAILED', String(value || fallback));
  const protocolFailure = (reason, details) => classifyError?.(reason)
    ?? failure('PROTOCOL_ERROR', classifyError ? `${label} 请求失败` : reason, classifyError ? undefined : details);

  function object(value, field) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw failure('PROTOCOL_INVALID', `${label} 返回了无效的 ${field}`);
    }
    return value;
  }

  function idOf(response, field) {
    const value = response?.result?.thread?.id || response?.result?.turn?.id;
    if (typeof value !== 'string' || !value) throw failure('PROTOCOL_INVALID', `${label} 返回了无效的 ${field}`);
    return value;
  }

  function writeJson(stdin, message) {
    try {
      stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      throw failure('TRANSPORT_FAILED', `无法向 ${label} App Server 写入请求`, { cause: String(error?.message || error) });
    }
  }

  const baseEnv = { ...(options.inheritEnv === false ? {} : process.env), ...(options.env || {}) };
  const executable = command.executable;
  const spawnImpl = options.spawnImpl || nodeSpawn;
  const cwd = String(options.cwd || tmpdir());
  const model = String(options.model || baseEnv[`${envPrefix}_MODEL`] || '').trim() || undefined;
  const approvalPolicy = String(options.approvalPolicy || baseEnv[`${envPrefix}_APPROVAL_POLICY`] || 'never');
  const sandbox = String(options.sandbox || baseEnv[`${envPrefix}_SANDBOX`] || '').trim() || undefined;
  // App Server defaults `turn/start.summary` to the model/provider setting,
  // which is commonly `none` for a minimal stdio client. Studio's DSH row can
  // only become a real disclosure when the public reasoning summary is present,
  // so request a readable summary by default while retaining an explicit
  // deployment override for providers that do not expose one.
  const reasoningSummary = normalizeReasoningSummary(options.reasoningSummary ?? baseEnv[`${envPrefix}_REASONING_SUMMARY`]);
  // A healthy agent may need many model/tool rounds. Only explicit caller
  // budgets impose a total deadline; stalled transports still time out.
  const timeoutMs = Math.max(0, Number(options.timeoutMs ?? baseEnv[`${envPrefix}_TIMEOUT_MS`]) || 0);
  const idleTimeoutMs = Math.max(10_000, Number(options.idleTimeoutMs ?? baseEnv[`${envPrefix}_IDLE_TIMEOUT_MS`]) || 600_000);
  const startupTimeoutMs = Math.max(10_000, Number(options.startupTimeoutMs) || 60_000);
  const shutdownTimeoutMs = Math.max(1, Number(options.shutdownTimeoutMs) || 5000);
  // Codex aborts one model response once its SSE stream stays silent for
  // `stream_idle_timeout_ms` (Codex default: 300s). Business turns on managed
  // runtimes can stream reasoning/report output for longer than that while the
  // upstream is still alive, so pin a larger per-round budget and keep it
  // deployment-tunable instead of inheriting Codex's 5-minute default.
  const streamIdleTimeoutMs = Math.max(1_000, Number(options.streamIdleTimeoutMs ?? baseEnv[`${envPrefix}_STREAM_IDLE_TIMEOUT_MS`]) || 900_000);
  async function* operation({ input, messages = [], imageInputs = [], signal, systemPrompt = '', dynamicTools = [],
    toolHandler, model: requestedModel, modelProvider, reasoningEffort, cwd: requestedCwd, sandbox: requestedSandbox,
    approvalPolicy: requestedApprovalPolicy, requestApproval, requestUserInput } = {}, catalog = false) {
    const cwd = String(requestedCwd ?? options.cwd ?? tmpdir());
    if (!isAbsolute(cwd)) throw failure('WORKSPACE_INVALID', `${label} 工作目录必须是绝对路径`);
    const selectedModel = String(requestedModel || model || '').trim() || undefined;
    // Each turn starts its own App Server thread, so a permission change may
    // apply to this turn alone; an invalid or absent value falls back to the
    // runtime default instead of reaching Codex.
    const turnSandbox = readExecutionMode(requestedSandbox) || sandbox;
    // A managed approval run may lift the process-wide unattended default for
    // this turn only. Portable turns without a bridge keep `never`.
    const turnApprovalPolicy = typeof requestedApprovalPolicy === 'string' && requestedApprovalPolicy.trim()
      ? requestedApprovalPolicy.trim() : approvalPolicy;
    const prompt = String(input || '').trim();
    if (!catalog && !prompt && !imageInputs.length) throw failure('INPUT_INVALID', `${label} 输入不能为空`);
    if (signal?.aborted) throw asError(signal.reason, `${label} 请求已取消`);

    // Use Codex's public custom-provider contract. Credentials belong only
    // to this child environment, never argv, thread RPC, or user config.
    const providerId = modelProvider ? 'agentkit_gateway' : verifyModel ? id : undefined;
    const providerArgs = modelProvider ? Object.entries({
      // Hosted Responses tools have no Chat Completions equivalent. Bound
      // MCP search tools remain available through Codex's dynamic tools.
      ...(modelProvider.api === 'chat-completions' ? { web_search: 'disabled' } : {}),
      model_provider: providerId,
      [`model_providers.${providerId}.name`]: 'Studio configured model',
      [`model_providers.${providerId}.base_url`]: modelProvider.baseUrl,
      [`model_providers.${providerId}.env_key`]: 'AGENTKIT_CODEX_MODEL_API_KEY',
      [`model_providers.${providerId}.wire_api`]: 'responses',
      [`model_providers.${providerId}.requires_openai_auth`]: false,
      [`model_providers.${providerId}.supports_websockets`]: false,
      [`model_providers.${providerId}.stream_idle_timeout_ms`]: streamIdleTimeoutMs,
    }).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]) : [];
    // Codex resolves the effort from config.toml; passing it as a CLI
    // override keeps it scoped to this ephemeral thread and out of user
    // configuration. Values are already narrowed to Codex's enum upstream.
    const reasoningArgs = reasoningEffort
      ? ['-c', `model_reasoning_effort=${JSON.stringify(String(reasoningEffort))}`] : [];

    let child;
    try {
      child = spawnImpl(executable, [...command.prefixArgs, 'app-server', '--stdio', ...providerArgs, ...reasoningArgs, ...(options.configArgs || [])], {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...baseEnv, ...(modelProvider ? { AGENTKIT_CODEX_MODEL_API_KEY: modelProvider.apiKey } : {}) },
      });
    } catch (error) {
      throw failure('PROVIDER_UNAVAILABLE', `无法启动 ${label} App Server（${executable}）`, { cause: String(error?.message || error) });
    }
    if (!child?.stdin || !child?.stdout) throw failure('PROVIDER_UNAVAILABLE', `${label} App Server 没有提供 stdio 通道`);

    const queue = createQueue();
    const pending = new Map();
    let requestId = 0;
    let buffer = '';
    const decoder = new StringDecoder('utf8');
    let threadId = '';
    let turnId = '';
    let closed = false;
    let disposed = false;
    let exited = false;
    const processClosed = options.awaitProcessExit
      ? new Promise(resolve => { child.once('exit', resolve); child.once('close', resolve); })
      : null;
    let killTimer;
    let timer;
    let budgetTimer;
    let started = false;
    const toolController = new AbortController();
    const countUsage = createCodexUsageCounter();
    const dynamicCalls = new Map();
    const phases = new Map();
    const deltaItems = new Set();
    const reasoningItems = new Set();
    const commandFallback = createCodexCommandFallback(id);
    const finish = error => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      clearTimeout(budgetTimer);
      toolController.abort(error);
      for (const resolver of pending.values()) resolver.reject(error || failure('TRANSPORT_CLOSED', `${label} 请求已关闭`));
      pending.clear();
      queue.close(error);
    };
    const activity = () => {
      if (closed) return;
      clearTimeout(timer);
      timer = setTimeout(() => finish(failure(
        started ? 'IDLE_TIMEOUT' : 'STARTUP_TIMEOUT',
        started ? `${label} 长时间没有返回进度，运行已停止；可以重试当前任务。` : `${label} App Server 启动超时`,
      )), started ? idleTimeoutMs : startupTimeoutMs);
    };
    const onData = chunk => {
      buffer += decoder.write(chunk);
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
      finish(failure(
        missing ? 'PROVIDER_UNAVAILABLE' : 'TRANSPORT_FAILED',
        missing ? `找不到 ${label} App Server（${executable}）` : `${label} App Server 连接失败`,
        { cause: String(error?.message || error) },
      ));
    };
    const onExit = (_code, _signal) => {
      exited = true;
      clearTimeout(killTimer);
      if (!closed) finish(failure('TRANSPORT_CLOSED', `${label} App Server 提前退出`));
    };
    const handleDynamicToolCall = async message => {
      const params = object(message.params || {}, 'dynamic tool 参数');
      const callId = String(params.callId || '');
      if (verifyModel && (!threadId || params.threadId !== threadId || (turnId && params.turnId !== turnId) || !callId)) {
        replyApproval(message.id, { success: false, contentItems: [{ type: 'inputText', text: 'Invalid tool request' }] });
        return;
      }
      const previous = callId && dynamicCalls.get(callId);
      if (previous) {
        replyApproval(message.id, await previous);
        return;
      }
      const call = runDynamicTool(params);
      if (callId) dynamicCalls.set(callId, call);
      replyApproval(message.id, await call);
    };
    const runDynamicTool = async params => {
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
          arguments: params.arguments ?? {},
        },
      });
      let result;
      try {
        if (typeof toolHandler !== 'function') throw failure('TOOL_UNAVAILABLE', `${label} 请求了未注册的工具：${String(params.tool || '')}`);
        const output = await toolHandler({
          name: String(params.tool || ''),
          namespace: params.namespace || null,
          arguments: params.arguments && typeof params.arguments === 'object' ? params.arguments : {},
          callId: String(params.callId || ''),
          threadId: String(params.threadId || threadId),
          turnId: String(params.turnId || turnId),
          signal: toolController.signal,
        });
        result = { contentItems: dynamicToolContent(output), success: true };
      } catch (error) {
        result = { contentItems: [{ type: 'inputText', text: String(error?.message || error).slice(0, 2000) }], success: false };
      }
      if (!closed) queue.push({
        method: 'agentkit/tool/status',
        params: {
          phase: result.success ? 'completed' : 'failed',
          name: String(params.tool || ''),
          callId: String(params.callId || ''),
          arguments: params.arguments ?? {},
          result,
        },
      });
      return result;
    };
    // Codex App Server asks the client for command/permission/patch approvals
    // only when the thread policy is `on-request`. A managed run routes those
    // asks through the Host's Interaction bridge; every other turn keeps the
    // historical automatic decline below.
    const approvalReason = value => {
      if (value === undefined || value === null) return undefined;
      const text = String(value);
      return text.length > 2000 ? text.slice(0, 2000) : text;
    };
    const replyApproval = (id, result) => {
      if (closed) return;
      try {
        writeJson(child.stdin, { jsonrpc: '2.0', id, result });
      } catch (error) { finish(asError(error)); return; }
      activity();
    };
    const handleUserQuestion = async (message) => {
      let params = {};
      let result = { answers: {} };
      try {
        params = object(message.params || {}, 'user-question 参数');
        const questions = Array.isArray(params.questions) ? params.questions : [];
        const outcome = await requestUserInput({
          toolName: `${id}/user-question`,
          callId: String(params.itemId || ''),
          questions,
          method: message.method,
          params,
          signal: toolController.signal,
        });
        const answers = outcome && typeof outcome === 'object'
          && outcome.answers && typeof outcome.answers === 'object' && !Array.isArray(outcome.answers)
          ? outcome.answers : {};
        result = { answers };
      } catch {
        // Declined/timeout: empty answers keep the app-server protocol healthy.
        result = { answers: {} };
      }
      replyApproval(message.id, result);
    };
    const handleApprovalRequest = async (message, kind) => {
      let params = {};
      let outcome;
      try {
        params = object(message.params || {}, 'approval 参数');
        const info = kind === 'permissions'
          ? { toolName: `${id}/permissions`, callId: String(params.itemId || ''), reason: approvalReason(params.reason ?? params.cwd) }
          : kind === 'patch'
            ? { toolName: `${id}/file-change`, callId: String(params.callId || ''), reason: approvalReason(params.reason) }
            : { toolName: `${id}/command`, callId: String(params.itemId || params.approvalId || ''), reason: approvalReason(params.reason || params.command) };
        outcome = await requestApproval({ ...info, method: message.method, params, signal: toolController.signal });
      } catch { outcome = undefined; }
      const approved = outcome === 'allowed-once';
      if (kind === 'permissions') {
        const permissions = approved && params.permissions && typeof params.permissions === 'object'
          && !Array.isArray(params.permissions) ? params.permissions : {};
        replyApproval(message.id, { permissions, scope: 'turn' });
      } else if (kind === 'patch') {
        replyApproval(message.id, { decision: approved ? 'approved' : 'denied' });
      } else {
        replyApproval(message.id, { decision: approved ? 'accept' : 'decline' });
      }
    };
    const handleMessage = message => {
      if (closed) return;
      if ((!message.params?.threadId || message.params.threadId === threadId)
        && (!message.params?.turnId || message.params.turnId === turnId)) activity();
      // Server-initiated requests have a method and an id. Handle those
      // before matching response ids because both sides use integer ids.
      if (message.method && message.id !== undefined) {
        if (message.method === 'item/tool/call') {
          void handleDynamicToolCall(message).catch(error => finish(asError(error)));
          return;
        }
        if (message.method === 'item/tool/requestUserInput' && typeof requestUserInput === 'function') {
          // Agent-initiated question: present it to the user and wait, instead
          // of the historical unattended auto-decline.
          void handleUserQuestion(message);
          return;
        }
        if (!verifyModel && typeof requestApproval === 'function') {
          if (message.method === 'item/commandExecution/requestApproval') {
            void handleApprovalRequest(message, 'command');
            return;
          }
          if (message.method === 'item/permissions/requestApproval') {
            void handleApprovalRequest(message, 'permissions');
            return;
          }
          if (message.method === 'applyPatchApproval') {
            void handleApprovalRequest(message, 'patch');
            return;
          }
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
        if (message.error) resolver.reject(protocolFailure(String(message.error.message || `${label} 请求失败`), { error: message.error }));
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
    child.stderr?.resume?.();
    child.stdout.on('error', onError);
    child.stdin.on?.('error', onError);
    child.on?.('error', onError);
    child.on?.('exit', onExit);
    activity();
    if (timeoutMs > 0) budgetTimer = setTimeout(() => finish(failure('TIMEOUT', `${label} App Server 运行超时`)), timeoutMs);
    const abort = () => {
      if (turnId && threadId) {
        try { writeJson(child.stdin, { jsonrpc: '2.0', id: ++requestId, method: 'turn/interrupt', params: { threadId, turnId } }); } catch {}
      }
      finish(failure('CANCELED', `${label} 运行已取消`));
    };
    signal?.addEventListener('abort', abort, { once: true });
    const dispose = async () => {
      if (disposed) return;
      disposed = true;
      signal?.removeEventListener('abort', abort);
      if (!closed) finish();
      try { child.stdin.end?.(); } catch {}
      try { child.kill?.('SIGTERM'); } catch {}
      if (!exited) {
        killTimer = setTimeout(() => { if (!exited) { try { child.kill?.('SIGKILL'); } catch {} } }, shutdownTimeoutMs);
        killTimer.unref?.();
        if (processClosed) {
          let deadline;
          try {
            await Promise.race([processClosed, new Promise(resolve => {
              deadline = setTimeout(resolve, shutdownTimeoutMs + 1000);
            })]);
          } finally { clearTimeout(deadline); }
        }
      }
    };
    try {
      await request('initialize', { clientInfo: { name: 'agentkit-studio', version: '0.0.1' }, capabilities: { experimentalApi: true } });
      writeJson(child.stdin, { method: 'initialized', params: {} });
      if (catalog || admitModel) {
        const models = [];
        const cursors = new Set();
        let cursor;
        do {
          const page = (await request('model/list', { limit: 100, ...(cursor ? { cursor } : {}) })).result;
          if (!Array.isArray(page?.data)) throw failure('PROTOCOL_INVALID', `${label} 模型目录格式无效`);
          models.push(...page.data);
          cursor = page.nextCursor;
          if (cursor && (typeof cursor !== 'string' || cursors.has(cursor) || cursors.size >= 100)) {
            throw failure('PROTOCOL_INVALID', `${label} 模型目录分页无效`);
          }
          cursors.add(cursor);
        } while (cursor);
        if (catalog) {
          yield models;
          return;
        }
        admitModel(models, selectedModel);
      }
      const developerInstructions = [String(systemPrompt || '').trim()].filter(Boolean).join('\n\n');
      const threadParams = {
        cwd,
        ephemeral: true,
        experimentalRawEvents: true,
        approvalPolicy: turnApprovalPolicy,
        ...(turnSandbox ? { sandbox: turnSandbox } : {}),
        ...(selectedModel ? { model: selectedModel } : {}),
        ...(providerId ? { modelProvider: providerId } : {}),
        ...(developerInstructions ? { developerInstructions } : {}),
        ...(Array.isArray(dynamicTools) && dynamicTools.length ? { dynamicTools } : {}),
      };
      const thread = await request('thread/start', threadParams);
      threadId = idOf(thread, 'thread id');
      verifyModel?.(thread.result, selectedModel);
      if (signal?.aborted) throw asError(signal.reason, `${label} 请求已取消`);
      const context = codexConversationPrompt({ input: prompt, messages });
      const turn = await request('turn/start', { threadId, summary: reasoningSummary, input: [
        ...(context ? [{ type: 'text', text: context, text_elements: [] }] : []),
        ...imageInputs.map(url => ({ type: 'image', url })),
      ] });
      turnId = idOf(turn, 'turn id');
      started = true;
      activity();

      for await (const message of queue) {
        const method = String(message.method || '');
        const params = object(message.params || {}, `${method} 参数`);
        if (params.threadId && params.threadId !== threadId) continue;
        if (params.turnId && params.turnId !== turnId) continue;
        if (method === 'thread/tokenUsage/updated') {
          const usage = countUsage(params.tokenUsage?.total);
          if (usage) yield { type: 'usage', usage };
          continue;
        }
        if (method === 'item/started') {
          const item = object(params.item || {}, 'item');
          if (item.id) phases.set(String(item.id), item.phase);
          const tool = codexItemToolChunk(item, 'started', id);
          commandFallback.observeNative(tool);
          if (tool) yield tool;
          continue;
        }
        if (method === 'rawResponseItem/completed') {
          commandFallback.observeRaw(params.item);
          continue;
        }
        if (method === 'agentkit/tool/status') {
          const phase = String(params.phase || '');
          const name = String(params.name || 'bound tool');
          if (['started', 'completed', 'failed'].includes(phase)) yield {
            type: 'tool', phase, name, id: String(params.callId || ''), arguments: params.arguments ?? {},
            ...(params.result ? { result: params.result } : {}),
          };
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
        if (method === 'item/reasoning/summaryTextDelta'
          || method === 'item/reasoning/textDelta'
          || method === 'item/plan/delta') {
          if (params.itemId) reasoningItems.add(String(params.itemId));
          const delta = String(params.delta || params.text || '');
          if (delta) yield { type: 'reasoning', text: delta };
          continue;
        }
        if (method === 'item/completed') {
          const item = object(params.item || {}, 'completed item');
          if (item.id) phases.set(String(item.id), item.phase);
          const tool = codexItemToolChunk(item, 'completed', id);
          commandFallback.observeNative(tool);
          if (tool) yield tool;
          if (item.type === 'reasoning' && !reasoningItems.has(String(item.id || ''))) {
            const text = completedReasoningText(item);
            if (text) yield { type: 'reasoning', text };
          }
          if (item.type === 'agentMessage' && !deltaItems.has(String(item.id || '')) && typeof item.text === 'string' && item.text) {
            yield { type: isFinalPhase(item.phase) ? 'text' : 'reasoning', text: item.text };
          }
          continue;
        }
        if (method === 'turn/completed') {
          yield* commandFallback.flush();
          const turnResult = object(params.turn || {}, 'completed turn');
          if (turnResult.status !== 'completed') {
            if (classifyError) throw classifyError(String(turnResult.error?.message || ''))
              ?? failure('TURN_FAILED', `${label} 运行失败`);
            const reason = String(turnResult.error?.message || '').split(modelProvider?.apiKey || '\0').join('[redacted]').slice(0, 1600);
            if (/\b429\b|\b(?:TPM|RPM)[ -]?(?:rate)?limit/i.test(reason)) {
              throw failure('MODEL_RATE_LIMITED', '模型服务限流（429），请稍后重试或在模型选择器中切换模型。工具较多、上下文较长时更容易触发每分钟 Token 限额。');
            }
            throw failure('TURN_FAILED', `${label} 运行失败${reason ? `：${reason}` : `（${String(turnResult.status || 'unknown')}）`}`);
          }
          break;
        }
      }
    } catch (error) {
      yield* commandFallback.flush();
      throw asError(error);
    } finally {
      for (const resolver of pending.values()) resolver.reject(failure('TRANSPORT_CLOSED', `${label} 请求已关闭`));
      pending.clear();
      await dispose();
    }
  }
  return {
    executable,
    cwd,
    stream: options => operation(options),
    async listModels({ signal } = {}) {
      for await (const models of operation({ signal }, true)) return models;
      return [];
    },
  };
}
