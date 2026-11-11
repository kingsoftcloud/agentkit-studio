/** Native engine as its own process (agentkit.engine/v1).
 *
 * Studio starts the configured engine executable, speaks the protocol and
 * renders its projected events. It imports no engine code: policy versions,
 * tools and the base system prompt belong to whichever engine build the
 * configured command points at, so upgrading the engine is a configuration
 * change and needs no Studio release.
 *
 * The returned object matches the process-runtime seam the Codex provider
 * uses (`stream(options)` yielding usage/reasoning/tool/text chunks), so the
 * DSH runtime adapter drives both the same way.
 *
 * Studio resource tools (MCP, knowledge, Skills, presentation) are passed as
 * host tools: the engine advertises them and sends each call back over
 * host/callTool, where Studio's own handler executes and authorizes it.
 * Memory recall and write-back stay host-side around the turn, as on the
 * Codex path. Bound A2A calls retain the Host's existing A2A authority. */
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { spawnEngine as defaultSpawnEngine } from './engine-protocol-client.mjs';
import { connectEngineService, engineServiceFetch, fetchEngineServiceView } from './engine-service-client.mjs';

export const NATIVE_ENGINE_RUNTIME = 'native-engine';
export const HARNESS_SERVICE_MODEL_PROVIDER = 'agentkit-studio-harness-service';
export const NATIVE_ENGINE_EVENT = 'agentkit/native-engine-event';
export const ENGINE_VIEW_CONTRACT = 'agentkit.engine-view/v1';
const SHA256 = /^[a-f0-9]{64}$/;

/** Engine-delivered task views, cached by content hash. Studio stores and serves
 * the bytes; it never builds or edits them. */
export function createEngineViewStore(stateRoot) {
  const dir = join(stateRoot, 'views');
  const path = sha256 => join(dir, `${sha256}.html`);
  const read = sha256 => {
    if (!SHA256.test(String(sha256)) || !existsSync(path(sha256))) return null;
    const html = readFileSync(path(sha256));
    return createHash('sha256').update(html).digest('hex') === sha256 ? html.toString('utf8') : null;
  };
  return {
    has: sha256 => read(sha256) !== null,
    save(view) {
      if (view?.contract !== ENGINE_VIEW_CONTRACT || typeof view.html !== 'string' || !SHA256.test(String(view.sha256))) return null;
      if (createHash('sha256').update(view.html).digest('hex') !== view.sha256) return null;
      mkdirSync(dir, { recursive: true });
      if (read(view.sha256) === null) { const temp = `${path(view.sha256)}.${process.pid}.tmp`; writeFileSync(temp, view.html); renameSync(temp, path(view.sha256)); }
      return view.sha256;
    },
    read,
  };
}
const MODEL_ENV = 'AGENTKIT_ENGINE_MODEL_API_KEY';
const failure = (code, message) => Object.assign(new Error(message), { code });
const text = value => typeof value === 'string' && value.trim().length > 0;

/** DSH selects a model route before invoking the agent loop. This adapter
 * supplies that route's metadata. The authenticated loop waterfall owns execution. */
export function createHarnessServiceModelAdapter(AdapterBase, publicModel) {
  return new class extends AdapterBase {
    providerInfo(provider) { return { id: provider, name: 'Harness' }; }
    async listModels(provider) { return [await this.resolveModel(provider, publicModel)]; }
    async resolveModel(provider, model) {
      if (model !== publicModel) throw failure('NATIVE_ENGINE_MODEL_UNAVAILABLE', '模型不在托管 Harness 绑定中。');
      return { provider, id: model, name: model, modalities: ['text'] };
    }
    async *stream() {
      throw failure('NATIVE_ENGINE_AGENT_LOOP_REQUIRED', '托管 Harness 仅接受绑定的 Agent 会话调用。');
    }
  }();
}

/** Local engine executable installed and updated independently of Studio. */
export function resolveEngineCommand(env = process.env) {
  if (text(env.AGENTKIT_ENGINE_COMMAND)) {
    let args = [];
    if (text(env.AGENTKIT_ENGINE_ARGS)) {
      try { args = JSON.parse(env.AGENTKIT_ENGINE_ARGS); } catch { throw failure('NATIVE_ENGINE_CONFIG_INVALID', 'AGENTKIT_ENGINE_ARGS 必须是 JSON 字符串数组。'); }
      if (!Array.isArray(args) || !args.every(item => typeof item === 'string')) throw failure('NATIVE_ENGINE_CONFIG_INVALID', 'AGENTKIT_ENGINE_ARGS 必须是 JSON 字符串数组。');
    }
    return { command: env.AGENTKIT_ENGINE_COMMAND, args, source: 'configured' };
  }
  throw failure('NATIVE_ENGINE_UNAVAILABLE', '请设置 AGENTKIT_ENGINE_COMMAND 指向独立安装的 Harness 可执行文件。');
}

export function createNativeEngineRuntime({ stateRoot, env = process.env, spawnEngine = defaultSpawnEngine, resolveCommand = resolveEngineCommand, viewService } = {}) {
  if (!text(stateRoot)) throw failure('NATIVE_ENGINE_CONFIG_INVALID', 'Native 引擎缺少状态目录。');
  const views = createEngineViewStore(stateRoot);
  const serviceEndpoint = env.AGENTKIT_ENGINE_SERVICE_URL;
  const serviceFetch = serviceEndpoint && engineServiceFetch(serviceEndpoint, env.AGENTKIT_ENGINE_SERVICE_CA_FILE);
  const viewFetch = viewService?.endpoint && (viewService.endpoint === serviceEndpoint
    && viewService.caFile === env.AGENTKIT_ENGINE_SERVICE_CA_FILE ? serviceFetch
    : engineServiceFetch(viewService.endpoint, viewService.caFile));
  return {
    usesService: Boolean(serviceEndpoint),
    async *stream({ input, inputImages = [], messages = [], signal, systemPrompt = '', model, modelProvider, cwd, sessionId, turnId, sandbox, requestApproval, agentToolPolicy, requestPolicyApproval, dynamicTools = [], toolHandler, nativeHostToolHandler } = {}) {
      if (!text(input) && !inputImages.length) throw failure('STUDIO_INPUT_REQUIRED', '请输入文字或添加图片后发送');
      const objective = text(input) ? input : '请查看用户提供的图片并说明其中的内容。';
      if (!text(cwd)) throw failure('NATIVE_ENGINE_WORKSPACE_UNAVAILABLE', '会话未提供工作目录，请重新选择工作区');
      if (serviceEndpoint && (!text(env.AGENTKIT_ENGINE_SERVICE_WORKSPACE)
        || resolve(cwd) !== resolve(env.AGENTKIT_ENGINE_SERVICE_WORKSPACE)))
        throw failure('NATIVE_ENGINE_WORKSPACE_UNAVAILABLE', '该会话的工作区没有绑定到配置的 Harness 服务。');
      if (!serviceEndpoint && (!text(model) || !text(modelProvider?.baseUrl))) throw failure('NATIVE_ENGINE_MODEL_UNAVAILABLE', '所选模型缺少可用的接口地址，请检查模型设置。');
      const session = text(sessionId) ? sessionId : 'studio-session';
      const stateDir = join(stateRoot, createHash('sha256').update(session).digest('hex').slice(0, 32));
      mkdirSync(stateDir, { recursive: true });
      const { command, args } = serviceEndpoint ? {} : resolveCommand(env);
      const allowed = Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'USER', 'LOGNAME', 'SHELL', 'SystemRoot', 'TEMP', 'TMP']
        .filter(name => env[name] !== undefined).map(name => [name, env[name]]));
      // An interactive approval seat decides each call. Without one, the Session's
      // permission mode decides: workspace-write and full access allow, anything else denies.
      const interactive = typeof requestApproval === 'function';
      const standing = ['workspace-write', 'danger-full-access'].includes(sandbox) ? 'allow' : 'deny';
      const policy = serviceEndpoint && agentToolPolicy?.mode !== 'loose' ? agentToolPolicy : null;
      let hostTools = { tools: [], originalName: name => name };
      const onApproveTool = !interactive && !serviceEndpoint ? undefined : async request => {
        const responder = interactive ? requestApproval : request.requiresUserApproval ? requestPolicyApproval : null;
        if (typeof responder !== 'function') return request.requiresUserApproval ? 'deny' : standing;
        const tool = hostTools.originalName(request.tool ?? 'tool');
        const outcome = await responder({ toolName: `native/${tool}`,
          callId: request.interactionId ?? '', reason: approvalReason({ ...request, tool }), signal });
        return outcome === 'allowed-once' ? 'allow' : 'deny';
      };
      const onCallTool = !dynamicTools.length || typeof toolHandler !== 'function' ? undefined : async request => {
        const call = { name: hostTools.originalName(String(request.name || '')), namespace: null, arguments: request.arguments ?? {},
          callId: String(request.callId || ''), threadId: session, turnId: String(turnId ?? ''), signal: signal ?? new AbortController().signal };
        if (nativeHostToolHandler && request.runId !== runId)
          return { status: 'error', content: { code: 'HOST_TOOL_RUN_MISMATCH', executed: false } };
        const native = await nativeHostToolHandler?.({ ...call, runId: request.runId, effect: request.effect });
        if (native !== undefined) return { status: native.status, content: toolContent(native.content) };
        try {
          const output = await toolHandler(call);
          return { status: 'ok', content: toolContent(output) };
        } catch (error) { return { status: 'error', content: { message: String(error?.message || error).slice(0, 2000) } }; }
      };
      let diagnostics = '';
      const engine = serviceEndpoint ? connectEngineService({ endpoint: serviceEndpoint,
        token: env.AGENTKIT_ENGINE_SERVICE_TOKEN, sessionId: createHash('sha256').update(session).digest('hex'),
        onApproveTool, onCallTool, requiredToolPolicy: policy?.contract,
        requiredToolEffects: dynamicTools.some(tool => tool.effectProtocol), fetchImpl: serviceFetch }) : spawnEngine({ command, args: [...args, '--workspace', cwd, '--state-dir', stateDir, '--session', session, '--approval', standing],
        env: { ...allowed, AGENTKIT_ENGINE_MODEL_NAME: model, AGENTKIT_ENGINE_MODEL_BASE_URL: modelProvider.baseUrl,
          AGENTKIT_ENGINE_MODEL_API_KEY_ENV: MODEL_ENV, [MODEL_ENV]: modelProvider.apiKey ?? '',
          ...(Number.isSafeInteger(modelProvider.contextWindow) ? { AGENTKIT_ENGINE_MODEL_CONTEXT_WINDOW: String(modelProvider.contextWindow) } : {}),
          ...(modelProvider.images ? { AGENTKIT_ENGINE_MODEL_IMAGES: '1' } : {}) },
        onApproveTool, onCallTool, hostName: 'agentkit-studio', onLog: chunk => { diagnostics = (diagnostics + chunk).slice(-4000); } });
      const runId = `studio-${createHash('sha256').update(`${session}\n${turnId ?? Date.now()}\n${objective}`).digest('hex').slice(0, 32)}`;
      const abort = () => { engine.cancel(runId).catch(() => {}); };
      try {
        let hello;
        try { hello = await engine.initialize(); }
        catch (error) {
          if (['NATIVE_ENGINE_TOOL_POLICY_UNAVAILABLE', 'NATIVE_ENGINE_TOOL_EFFECT_UNAVAILABLE'].includes(error.code)) throw error;
          throw failure('NATIVE_ENGINE_UNAVAILABLE', `Native 引擎启动失败：${error.message}`);
        }
        if (onCallTool) hostTools = engineHostTools(dynamicTools, { reserved: hello.engine?.reservedToolNames ?? [],
          ...(hello.engine?.hostToolNamePattern ? { pattern: hello.engine.hostToolNamePattern } : {}) });
        signal?.throwIfAborted();
        if (inputImages.length) {
          const limits = hello.capabilities?.inputImages;
          if (!Number.isSafeInteger(limits?.maxCount) || !Number.isSafeInteger(limits?.maxEncodedBytes))
            throw failure('NATIVE_ENGINE_IMAGE_UNAVAILABLE', '当前 Harness 服务或模型未声明图片输入能力。');
          if (inputImages.length > limits.maxCount || inputImages.reduce((bytes, block) =>
            bytes + Buffer.byteLength(block.image_url.url, 'utf8'), 0) > limits.maxEncodedBytes)
            throw failure('NATIVE_ENGINE_IMAGE_LIMIT', '图片超出当前 Harness 服务的输入限制。');
        }
        const toolPolicy = policy && { ...policy, rules: {
          ...policy.rules,
          ...Object.fromEntries(hostTools.tools.filter(tool => Object.hasOwn(policy.rules, hostTools.originalName(tool.name)))
            .map(tool => [tool.name, policy.rules[hostTools.originalName(tool.name)]])),
        } };
        const started = await engine.startRun({ runId, objective, conversation: engineConversation(messages, input), hostInstructions: systemPrompt,
          ...(inputImages.length ? { inputImages } : {}), ...(toolPolicy ? { toolPolicy } : {}), ...(onCallTool && hostTools.tools.length ? { hostTools: hostTools.tools } : {}) });
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        // A remote Run retains its original view after an engine upgrade.
        let view = null;
        const offered = started && Object.hasOwn(started, 'view') ? started.view : hello.capabilities?.ui;
        if (offered?.contract === ENGINE_VIEW_CONTRACT && SHA256.test(String(offered.sha256))) {
          if (views.has(offered.sha256)) view = offered.sha256;
          else { try { view = views.save(await engine.view(serviceEndpoint ? offered.sha256 : undefined)); } catch { view = null; } }
        }
        yield { type: 'engine', engine: { version: hello.engine?.version ?? null, preset: hello.engine?.preset ?? null, protocol: hello.protocolVersion }, view };
        let finalText = null, rest;
        for (let cursor = 0; ;) {
          const page = await engine.events(runId, cursor, 5000);
          for (const event of page.events) {
            yield { type: 'engine-event', runId, view, event };
            for (const chunk of chunksOf(event)) yield chunk;
            if (event.kind === 'run.terminal' && text(event.detail)) finalText = event.detail;
          }
          cursor = page.cursor;
          if (!page.running && page.events.length === 0) {
            rest = await engine.status(runId);
            if (rest.running) continue;
            const approval = rest.pendingApproval;
            if (!approval || !engine.approve || !onApproveTool) break;
            signal?.throwIfAborted();
            const decision = await onApproveTool(approval);
            signal?.throwIfAborted();
            const receipt = await engine.approve(runId, approval.interactionId, decision);
            if (!['accepted', 'duplicate'].includes(receipt?.status))
              throw failure('NATIVE_ENGINE_APPROVAL_CONFLICT', '该工具审批已变化，请核对任务中的最新状态。');
          }
        }
        // The final answer is the Run's delivered text; commentary during the task was shown as progress.
        if (text(rest.finalText ?? finalText)) yield { type: 'text', text: rest.finalText ?? finalText };
        if (!rest.terminal || rest.outcome === 'failed' || rest.phase === 'failed')
          throw failure('NATIVE_ENGINE_RUN_INCOMPLETE', runFailureMessage(rest));
      } finally {
        signal?.removeEventListener('abort', abort);
        await engine.close().catch(() => {});
      }
    },
    view: sha256 => views.read(sha256),
    async resolveView(sha256) {
      if (!SHA256.test(sha256)) return null;
      const cached = views.read(sha256);
      if (cached !== null) return cached;
      let html = serviceEndpoint
        ? await fetchEngineServiceView(serviceEndpoint, env.AGENTKIT_ENGINE_SERVICE_TOKEN, sha256, serviceFetch) : null;
      if (html === null && viewFetch && (viewService.endpoint !== serviceEndpoint
        || viewService.token !== env.AGENTKIT_ENGINE_SERVICE_TOKEN))
        html = await fetchEngineServiceView(viewService.endpoint, viewService.token, sha256, viewFetch);
      if (html === null) return null;
      if (!views.save({ contract: ENGINE_VIEW_CONTRACT, sha256, html })) throw new Error('engine_service_view_mismatch');
      return html;
    },
  };
}

/** Render projected engine events generically: a new engine event kind needs no Studio change. */
function chunksOf(event) {
  if (event.category === 'model' && event.usage)
    return [{ type: 'usage', usage: { inputTokens: event.usage.inputTokens ?? 0, outputTokens: event.usage.outputTokens ?? 0 } },
      ...(event.kind === 'model.completed' && Array.isArray(event.tools) && text(event.detail) ? [{ type: 'reasoning', text: event.detail }] : [])];
  if (event.category === 'model' && event.status === 'retrying') return [{ type: 'reasoning', text: `模型请求失败（${event.detail ?? 'unknown'}），正在重试。` }];
  if (event.category === 'tool' && text(event.title)) return [{ type: 'tool', name: event.title, phase: event.status === 'ok' ? 'completed' : 'failed' }];
  return [];
}
/** Studio dynamic tool specs -> engine host tools. The engine says which names
 * it reserves and which names it accepts; Studio never hard-codes engine tools.
 * A name the engine would refuse gets a stable alias, and calls are translated
 * back so Studio's handler still routes by the original name. */
export function engineHostTools(specs = [], { reserved = [], pattern = '^[A-Za-z][A-Za-z0-9_-]{0,63}$' } = {}) {
  const valid = new RegExp(pattern), taken = new Set(reserved), tools = [], originals = new Map();
  for (const spec of Array.isArray(specs) ? specs : []) {
    const original = String(spec?.name || '');
    if (!original || tools.length >= 128) continue;
    let name = original;
    if (!valid.test(name) || taken.has(name)) {
      const stem = original.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^[^A-Za-z]+/, '').slice(0, 48) || 'tool';
      const tag = createHash('sha256').update(original).digest('hex').slice(0, 8);
      name = `host_${stem}_${tag}`.slice(0, 64);
    }
    if (taken.has(name) || !valid.test(name)) continue;
    taken.add(name); originals.set(name, original);
    const schema = spec.inputSchema && typeof spec.inputSchema === 'object' && spec.inputSchema.type === 'object' ? spec.inputSchema : { type: 'object', properties: {} };
    tools.push({ name, description: String(spec.description || '').slice(0, 4000), parameters: schema,
      ...(typeof spec.readOnly === 'boolean' ? { readOnly: spec.readOnly } : {}),
      ...(Number.isSafeInteger(spec.timeoutMs) ? { timeoutMs: spec.timeoutMs } : {}),
      ...(spec.effectProtocol ? { effectProtocol: spec.effectProtocol } : {}) });
  }
  return { tools, originalName: name => originals.get(name) ?? name };
}
/** Earlier user and assistant text turns; the engine decides how they reach the model. */
export function engineConversation(messages = [], input = '') {
  const textOf = message => typeof message?.content === 'string' ? message.content
    : Array.isArray(message?.content) ? message.content.map(part => typeof part === 'string' ? part : part?.type === 'text' ? part.text ?? '' : '').join('') : '';
  const turns = (Array.isArray(messages) ? messages : [])
    .filter(message => message?.role === 'assistant' || message?.role === 'user' && (!message.source || message.source.kind === 'user'))
    .map(message => ({ role: message.role, text: textOf(message).trim() })).filter(turn => turn.text);
  const last = turns.at(-1);
  if (last?.role === 'user' && last.text === String(input).trim()) turns.pop();
  return turns;
}
function toolContent(output) {
  if (output == null) return null;
  if (typeof output === 'string') return { text: output };
  try { return JSON.parse(JSON.stringify(output)); } catch { return { text: String(output) }; }
}
function approvalReason(request) {
  const args = request.arguments ?? {};
  const subject = text(request.subject) ? request.subject
    : text(args.command) ? args.command : text(args.path) ? args.path : text(args.url) ? args.url : '';
  return `${request.tool ?? 'tool'}${subject ? `: ${subject.slice(0, 500)}` : ''}`;
}
function runFailureMessage(rest) {
  const reason = rest.reason ?? rest.phase ?? 'unknown';
  if (rest.phase === 'paused') return `任务已暂停（${reason}），可稍后继续。`;
  return `任务未完成（${reason}）。`;
}
