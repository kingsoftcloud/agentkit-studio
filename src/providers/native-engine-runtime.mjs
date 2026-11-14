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
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { spawnEngine as defaultSpawnEngine } from './engine-protocol-client.mjs';
import { connectEngineService, engineServiceFetch, fetchEngineServiceView, ENGINE_TOOL_RECEIPT } from './engine-service-client.mjs';
import { nativeEngineApprovalReply } from './native-host-approval.mjs';
import { nativeEngineVerification } from './native-engine-verification.mjs';
import { canonicalEngineWorkspace, engineServiceWorkspaces } from './engine-service-workspaces.mjs';
export { HARNESS_SERVICE_MODEL_PROVIDER } from './engine-service-workspaces.mjs';

export const NATIVE_ENGINE_RUNTIME = 'native-engine';
export const NATIVE_ENGINE_EVENT = 'agentkit/native-engine-event';
export const NATIVE_ENGINE_TEXT = 'agentkit/native-engine-text';
export const NATIVE_ENGINE_TOOL_DRAFT = 'agentkit/native-engine-tool-draft';
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

function sessionToolPolicy(policy, sandbox) {
  if (!policy || policy.mode === 'loose') return null;
  if (sandbox !== 'danger-full-access') return policy;
  // Full access waives Agent-level confirmations. Custom denials and the
  // Host's own approval requirements remain part of tool admission.
  if (policy.mode === 'strict') return null;
  return { ...policy, rules: Object.fromEntries(Object.entries(policy.rules)
    .map(([name, action]) => [name, action === 'ask' ? 'inherit' : action])) };
}

/** DSH selects a model route before invoking the agent loop. This adapter
 * supplies that route's metadata. The authenticated loop waterfall owns execution. */
export function createHarnessServiceModelAdapter(AdapterBase, models, describeModel) {
  const catalog = new Set(typeof models === 'string' ? [models] : models);
  return new class extends AdapterBase {
    providerInfo(provider) { return { id: provider, name: 'Harness' }; }
    async listModels(provider) { return Promise.all([...catalog].map(model => this.resolveModel(provider, model))); }
    async resolveModel(provider, model) {
      if (!catalog.has(model)) throw failure('NATIVE_ENGINE_MODEL_UNAVAILABLE', '模型不在托管 Harness 绑定中。');
      const capabilities = await describeModel?.(model);
      return { provider, id: model, name: model, modalities: capabilities?.images ? ['text', 'image'] : ['text'] };
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
  const routes = engineServiceWorkspaces(env);
  const routeFor = cwd => routes.get(canonicalEngineWorkspace(cwd));
  const singleRoute = routes.size === 1 ? routes.values().next().value : undefined;
  const viewFetch = viewService?.endpoint && engineServiceFetch(viewService.endpoint, viewService.caFile);
  const modelCapabilities = new Map();
  return {
    usesService: routes.size > 0,
    serviceCatalogWorkspace: routes.keys().next().value,
    applicationPreviewAvailable: [...routes.values()].some(route => route.preview),
    serviceModels: [...new Set([...routes.values()].map(route => route.modelSelection.model))],
    async serviceModelInfo(model) {
      if (!modelCapabilities.has(model)) {
        const request = Promise.all([...routes.values()].filter(route => route.modelSelection.model === model).map(async route => {
          const engine = connectEngineService({ endpoint: route.endpoint, token: route.token, fetchImpl: route.fetchImpl,
            sessionId: 'studio-model-' + createHash('sha256').update(model).digest('hex'), observeOnly: true });
          try { return (await engine.initialize()).capabilities?.inputImages; }
          finally { await engine.close(); }
        })).then(results => ({ images: results.some(limits => Number.isSafeInteger(limits?.maxCount) && limits.maxCount > 0
          && Number.isSafeInteger(limits?.maxEncodedBytes) && limits.maxEncodedBytes > 0) }));
        modelCapabilities.set(model, request);
        request.catch(() => modelCapabilities.delete(model));
      }
      return modelCapabilities.get(model);
    },
    serviceWorkspace(cwd) {
      const route = cwd === undefined ? singleRoute : routeFor(cwd);
      return route && { workspaceRoot: route.workspaceRoot, modelSelection: { ...route.modelSelection } };
    },
    applicationPreview: cwd => routeFor(cwd)?.preview,
    async readDeliveryEvidence({ sessionId, runId, cwd, signal }) {
      const route = routeFor(cwd);
      if (!route) return null;
      signal?.throwIfAborted();
      const engine = connectEngineService({ endpoint: route.endpoint, token: route.token,
        sessionId: createHash('sha256').update(sessionId).digest('hex'), runId, observeOnly: true, fetchImpl: route.fetchImpl });
      const abort = () => void engine.close().catch(() => {});
      signal?.addEventListener('abort', abort, { once: true });
      try { return (await engine.status(runId, { deliveryPresentation: true })).deliveryEvidence ?? null; }
      finally { signal?.removeEventListener('abort', abort); await engine.close(); }
    },
    async *stream({ input, inputImages = [], messages = [], signal, systemPrompt = '', model, modelProvider, cwd, sessionId, turnId, sandbox, requestApproval, agentToolPolicy, requestPolicyApproval, dynamicTools = [], toolHandler, nativeHostToolHandler, nativeHostReceiptHandler, nextGuidance, commitGuidance } = {}) {
      if (!text(input) && !inputImages.length) throw failure('STUDIO_INPUT_REQUIRED', '请输入文字或添加图片后发送');
      const objective = text(input) ? input : '请查看用户提供的图片并说明其中的内容。';
      const workspaceRoot = canonicalEngineWorkspace(cwd);
      const service = routes.get(workspaceRoot);
      const serviceEndpoint = service?.endpoint;
      if (!workspaceRoot || routes.size && !service)
        throw failure('NATIVE_ENGINE_WORKSPACE_UNAVAILABLE', '该会话的工作区没有绑定到配置的 Harness 服务。');
      if (!serviceEndpoint && (!text(model) || !text(modelProvider?.baseUrl))) throw failure('NATIVE_ENGINE_MODEL_UNAVAILABLE', '所选模型缺少可用的接口地址，请检查模型设置。');
      const session = text(sessionId) ? sessionId : 'studio-session';
      const stateDir = join(stateRoot, createHash('sha256').update(JSON.stringify([workspaceRoot, session])).digest('hex').slice(0, 32));
      mkdirSync(stateDir, { recursive: true });
      const { command, args } = serviceEndpoint ? {} : resolveCommand(env);
      const allowed = Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'USER', 'LOGNAME', 'SHELL', 'SystemRoot', 'TEMP', 'TMP']
        .filter(name => env[name] !== undefined).map(name => [name, env[name]]));
      // An interactive approval seat decides each call. Without one, the Session's
      // permission mode decides: workspace-write and full access allow, anything else denies.
      const interactive = typeof requestApproval === 'function';
      const standing = ['workspace-write', 'danger-full-access'].includes(sandbox) ? 'allow' : 'deny';
      const policy = serviceEndpoint ? sessionToolPolicy(agentToolPolicy, sandbox) : null;
      let hostTools = { tools: [], originalName: name => name };
      const onApproveTool = !interactive && !serviceEndpoint ? undefined : async request => {
        if (serviceEndpoint && sandbox === 'workspace-write' && request.workspaceWriteSafe === true
          && !request.requiresUserApproval && !request.childRunId) return 'allow';
        const requiresApproval = request.requiresUserApproval === true || serviceEndpoint && sandbox === 'workspace-write'
          && (request.childRunId || ['run_command', 'stop_command', 'delete_workspace_file', 'rewind_workspace_files'].includes(request.tool));
        const responder = interactive ? requestApproval : requiresApproval ? requestPolicyApproval : null;
        const explain = requiresApproval && !request.childRunId;
        if (typeof responder !== 'function') return requiresApproval ? nativeEngineApprovalReply('unavailable', explain) : standing;
        const tool = hostTools.originalName(request.tool ?? 'tool');
        try {
          const outcome = await responder({ toolName: `native/${tool}`,
            callId: request.interactionId ?? '', reason: approvalReason({ ...request, tool }), signal });
          return nativeEngineApprovalReply(outcome, explain);
        } catch (error) {
          if (signal?.aborted || !explain) throw error;
          return nativeEngineApprovalReply('unavailable', explain);
        }
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
      const runId = `studio-${createHash('sha256').update(`${session}\n${text(turnId) ? turnId : randomUUID()}\n${objective}`).digest('hex').slice(0, 32)}`;
      const verification = serviceEndpoint ? nativeEngineVerification({ objective, runId }) : null;
      const onReadToolReceipt = nativeHostReceiptHandler && ((request, receiptSignal) => {
        if (request?.runId !== runId) return {};
        return nativeHostReceiptHandler({ ...request, name: hostTools.originalName(request.name),
          signal: signal ? AbortSignal.any([signal, receiptSignal]) : receiptSignal });
      });
      const engine = serviceEndpoint ? connectEngineService({ endpoint: serviceEndpoint,
        token: service.token, sessionId: createHash('sha256').update(session).digest('hex'),
        runId, runSignal: signal, onApproveTool, onCallTool, onReadToolReceipt, onVerifyGoal: verification?.verify, requiredToolPolicy: policy?.contract,
        requiredToolEffects: dynamicTools.some(tool => tool.effectProtocol), fetchImpl: service.fetchImpl }) : spawnEngine({ command, args: [...args, '--workspace', workspaceRoot, '--state-dir', stateDir, '--session', session, '--approval', standing],
        env: { ...allowed, AGENTKIT_ENGINE_MODEL_NAME: model, AGENTKIT_ENGINE_MODEL_BASE_URL: modelProvider.baseUrl,
          AGENTKIT_ENGINE_MODEL_API_KEY_ENV: MODEL_ENV, [MODEL_ENV]: modelProvider.apiKey ?? '',
          ...(Number.isSafeInteger(modelProvider.contextWindow) ? { AGENTKIT_ENGINE_MODEL_CONTEXT_WINDOW: String(modelProvider.contextWindow) } : {}),
          ...(modelProvider.images ? { AGENTKIT_ENGINE_MODEL_IMAGES: '1' } : {}),
          ...(env.KSADK_MODEL_COMPAT_RULE ? { AGENTKIT_ENGINE_MODEL_COMPAT_RULE: env.KSADK_MODEL_COMPAT_RULE } : {}) },
        onApproveTool, onCallTool, hostName: 'agentkit-studio', onLog: chunk => { diagnostics = (diagnostics + chunk).slice(-4000); } });
      let cancellation;
      const abort = () => { cancellation ??= engine.cancel(runId).catch(() => {}); };
      try {
        let hello;
        try { hello = await engine.initialize(); }
        catch (error) {
          if (['NATIVE_ENGINE_TOOL_POLICY_UNAVAILABLE', 'NATIVE_ENGINE_TOOL_EFFECT_UNAVAILABLE', 'NATIVE_ENGINE_VERIFICATION_UNAVAILABLE'].includes(error.code)) throw error;
          throw failure('NATIVE_ENGINE_UNAVAILABLE', `Native 引擎启动失败：${error.message}`);
        }
        const offeredTools = hello.capabilities?.hostToolReceipts === ENGINE_TOOL_RECEIPT ? dynamicTools
          : dynamicTools.map(({ receiptObservation: _receipt, ...tool }) => tool);
        if (onCallTool) hostTools = engineHostTools(offeredTools, { reserved: hello.engine?.reservedToolNames ?? [],
          ...(hello.engine?.hostToolNamePattern ? { pattern: hello.engine.hostToolNamePattern } : {}) });
        signal?.throwIfAborted();
        if (inputImages.length) {
          const limits = hello.capabilities?.inputImages;
          if (!Number.isSafeInteger(limits?.maxCount) || !Number.isSafeInteger(limits?.maxEncodedBytes))
            throw failure('NATIVE_ENGINE_IMAGE_UNAVAILABLE', '所连接的 Harness 没有启用图片输入，请检查该服务的模型能力配置。');
          if (inputImages.length > limits.maxCount || inputImages.reduce((bytes, block) =>
            bytes + Buffer.byteLength(block.image_url.url, 'utf8'), 0) > limits.maxEncodedBytes)
            throw failure('NATIVE_ENGINE_IMAGE_LIMIT', '图片超出当前 Harness 服务的输入限制。');
        }
        const toolPolicy = policy && { ...policy, rules: {
          ...policy.rules,
          ...Object.fromEntries(hostTools.tools.filter(tool => Object.hasOwn(policy.rules, hostTools.originalName(tool.name)))
            .map(tool => [tool.name, policy.rules[hostTools.originalName(tool.name)]])),
        } };
        // The remote start can be committed before its response reaches Studio.
        if (serviceEndpoint) signal?.addEventListener('abort', abort, { once: true });
        const started = await engine.startRun({ runId, objective, conversation: engineConversation(messages, input), hostInstructions: systemPrompt,
          ...(inputImages.length ? { inputImages } : {}), ...(toolPolicy ? { toolPolicy } : {}),
          ...(verification ? { hostVerification: verification.definition } : {}),
          ...(onCallTool && hostTools.tools.length ? { hostTools: hostTools.tools } : {}) });
        if (!serviceEndpoint) signal?.addEventListener('abort', abort, { once: true });
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
        let thinkingCursor = hello.capabilities?.liveThinking === true ? '' : undefined;
        let toolDraftCursor = hello.capabilities?.liveToolDrafts === true ? '' : undefined;
        let textCursor = hello.capabilities?.liveText === true ? '' : undefined;
        let canGuide = typeof nextGuidance === 'function' && typeof commitGuidance === 'function'
          && hello.capabilities?.methods?.includes('run/guide');
        let pendingGuidance = null;
        for (let cursor = 0; ;) {
          if (canGuide && !pendingGuidance) {
            const item = nextGuidance();
            if (item && text(item.text) && item.text.length <= 32768) {
              const inputId = 'guide-' + createHash('sha256').update(JSON.stringify([item.id, item.text])).digest('hex');
              const receipt = await engine.guide(runId, inputId, item.text);
              if (['accepted', 'duplicate'].includes(receipt.status)) pendingGuidance = { inputId, item };
              else canGuide = false;
            }
          }
          const page = await engine.events(runId, cursor, 5000, thinkingCursor, toolDraftCursor, textCursor);
          for (const event of page.events) {
            if (pendingGuidance && event.inputId === pendingGuidance.inputId) {
              if (event.kind === 'input.guidance_applied') {
                commitGuidance(pendingGuidance.item);
                pendingGuidance = null;
              } else if (event.kind === 'command.applied' && event.status !== 'applied') {
                canGuide = false;
                pendingGuidance = null;
              }
            }
            yield { type: 'engine-event', runId, view, event };
            for (const chunk of chunksOf(event)) yield chunk;
            if (event.kind === 'run.terminal' && text(event.detail)) finalText = event.detail;
          }
          const preview = page.thinking;
          if (thinkingCursor !== undefined && typeof preview?.id === 'string' && typeof preview.cursor === 'string'
            && typeof preview.text === 'string' && preview.text.length <= 8192 && preview.cursor !== thinkingCursor) {
            if (preview.text) yield { type: 'engine-thinking', attemptId: preview.id, text: preview.text };
            thinkingCursor = preview.cursor;
          }
          const body = page.text;
          if (textCursor !== undefined && SHA256.test(String(body?.requestId)) && typeof body.cursor === 'string'
            && /^[\da-f-]{36}:\d{1,16}$/.test(body.cursor) && body.cursor !== textCursor
            && Number.isSafeInteger(body.offset) && body.offset >= 0 && typeof body.text === 'string' && body.text.length <= 8192) {
            yield { type: 'engine-text', runId, requestId: body.requestId, cursor: body.cursor, offset: body.offset, delta: body.text };
            textCursor = body.cursor;
          }
          const draft = page.toolDraft;
          if (toolDraftCursor !== undefined && typeof draft?.cursor === 'string' && draft.cursor !== toolDraftCursor
            && SHA256.test(String(draft.requestId)) && Array.isArray(draft.tools) && draft.tools.length <= 16) {
            const tools = draft.tools.filter(tool => Number.isSafeInteger(tool?.index) && tool.index >= 0
              && typeof tool.name === 'string' && /^[A-Za-z][A-Za-z0-9_.:/-]{0,127}$/.test(tool.name));
            if (tools.length) yield { type: 'engine-tool-draft', runId, requestId: draft.requestId, tools };
            toolDraftCursor = draft.cursor;
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
        // The turn's abort stops event polling immediately. Let its separate
        // best-effort cancel reach the service before closing the connection.
        if (serviceEndpoint && cancellation) await Promise.race([cancellation, sleep(1000, undefined, { ref: false })]);
        await engine.close().catch(() => {});
      }
    },
    view: sha256 => views.read(sha256),
    async resolveView(sha256) {
      if (!SHA256.test(sha256)) return null;
      const cached = views.read(sha256);
      if (cached !== null) return cached;
      let html = singleRoute
        ? await fetchEngineServiceView(singleRoute.endpoint, singleRoute.token, sha256, singleRoute.fetchImpl) : null;
      if (html === null && viewFetch && (viewService.endpoint !== singleRoute?.endpoint
        || viewService.token !== singleRoute?.token))
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
    return [{ type: 'usage', usage: { inputTokens: event.usage.inputTokens ?? 0, outputTokens: event.usage.outputTokens ?? 0,
      ...Object.fromEntries(['cachedInputTokens', 'cacheWriteInputTokens', 'reasoningTokens']
        .filter(key => Number.isSafeInteger(event.usage[key]) && event.usage[key] >= 0).map(key => [key, event.usage[key]])) } },
      ...(event.kind === 'model.completed' && Array.isArray(event.tools) && text(event.detail) ? [{ type: 'reasoning', text: event.detail }] : [])];
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
      ...(spec.receiptObservation === true ? { receiptObservation: true } : {}),
      ...(spec.effectProtocol ? { effectProtocol: spec.effectProtocol } : {}) });
  }
  return { tools, originalName: name => originals.get(name) ?? name };
}
/** A model call ID can repeat across Runs. Preserve the identity of the
 * original effect across approval, transport retries, and host restarts. */
export function nativeHostToolCallId(runId, identity) {
  return 'harness-' + createHash('sha256').update(JSON.stringify([runId, identity])).digest('hex');
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
  if (text(rest.modelError)) return rest.modelError;
  const reason = rest.reason ?? rest.phase ?? 'unknown';
  if (rest.phase === 'paused') return `任务已暂停（${reason}），可稍后继续。`;
  return `任务未完成（${reason}）。`;
}
