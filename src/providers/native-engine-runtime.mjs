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
 * Codex path. A2A is not carried over this path yet. */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { spawnEngine as defaultSpawnEngine } from './engine-protocol-client.mjs';

export const NATIVE_ENGINE_RUNTIME = 'native-engine';
const MODEL_ENV = 'AGENTKIT_ENGINE_MODEL_API_KEY';
const failure = (code, message) => Object.assign(new Error(message), { code });
const text = value => typeof value === 'string' && value.trim().length > 0;

/** Engine executable from configuration. Falling back to an installed engine
 * package keeps existing installs working until an operator pins a channel. */
export function resolveEngineCommand(env = process.env) {
  if (text(env.AGENTKIT_ENGINE_COMMAND)) {
    let args = [];
    if (text(env.AGENTKIT_ENGINE_ARGS)) {
      try { args = JSON.parse(env.AGENTKIT_ENGINE_ARGS); } catch { throw failure('NATIVE_ENGINE_CONFIG_INVALID', 'AGENTKIT_ENGINE_ARGS 必须是 JSON 字符串数组。'); }
      if (!Array.isArray(args) || !args.every(item => typeof item === 'string')) throw failure('NATIVE_ENGINE_CONFIG_INVALID', 'AGENTKIT_ENGINE_ARGS 必须是 JSON 字符串数组。');
    }
    return { command: env.AGENTKIT_ENGINE_COMMAND, args, source: 'configured' };
  }
  try {
    const entry = createRequire(import.meta.url).resolve('@kingsoftcloud/agentkit-harness-node/native/engine-server');
    return { command: process.execPath, args: [entry], source: 'installed-package' };
  } catch {
    throw failure('NATIVE_ENGINE_UNAVAILABLE', '未找到 Native 引擎：请设置 AGENTKIT_ENGINE_COMMAND 指向引擎可执行文件。');
  }
}

export function createNativeEngineRuntime({ stateRoot, env = process.env, spawnEngine = defaultSpawnEngine, resolveCommand = resolveEngineCommand } = {}) {
  if (!text(stateRoot)) throw failure('NATIVE_ENGINE_CONFIG_INVALID', 'Native 引擎缺少状态目录。');
  return {
    async *stream({ input, signal, systemPrompt = '', model, modelProvider, cwd, sessionId, turnId, requestApproval, dynamicTools = [], toolHandler } = {}) {
      if (!text(input)) throw failure('STUDIO_INPUT_REQUIRED', '请输入文字后发送');
      if (!text(cwd)) throw failure('NATIVE_ENGINE_WORKSPACE_UNAVAILABLE', '会话未提供工作目录，请重新选择工作区');
      if (!text(model) || !text(modelProvider?.baseUrl)) throw failure('NATIVE_ENGINE_MODEL_UNAVAILABLE', '所选模型缺少可用的接口地址，请检查模型设置。');
      const session = text(sessionId) ? sessionId : 'studio-session';
      const stateDir = join(stateRoot, createHash('sha256').update(session).digest('hex').slice(0, 32));
      mkdirSync(stateDir, { recursive: true });
      const { command, args } = resolveCommand(env);
      const allowed = Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'USER', 'LOGNAME', 'SHELL', 'SystemRoot', 'TEMP', 'TMP']
        .filter(name => env[name] !== undefined).map(name => [name, env[name]]));
      // A host approval seat exists only for interactive runs; otherwise the engine denies writes and commands.
      const interactive = typeof requestApproval === 'function';
      const onApproveTool = !interactive ? undefined : async request => {
        const outcome = await requestApproval({ toolName: `native/${request.tool ?? 'tool'}`, callId: '', reason: approvalReason(request), signal });
        return outcome === 'allowed-once' ? 'allow' : 'deny';
      };
      let hostTools = { tools: [], originalName: name => name };
      const onCallTool = !dynamicTools.length || typeof toolHandler !== 'function' ? undefined : async request => {
        try {
          const output = await toolHandler({ name: hostTools.originalName(String(request.name || '')), namespace: null, arguments: request.arguments ?? {},
            callId: String(request.callId || ''), threadId: session, turnId: String(turnId ?? ''), signal });
          return { status: 'ok', content: toolContent(output) };
        } catch (error) { return { status: 'error', content: { message: String(error?.message || error).slice(0, 2000) } }; }
      };
      let diagnostics = '';
      const engine = spawnEngine({ command, args: [...args, '--workspace', cwd, '--state-dir', stateDir, '--session', session, '--approval', 'deny'],
        env: { ...allowed, AGENTKIT_ENGINE_MODEL_NAME: model, AGENTKIT_ENGINE_MODEL_BASE_URL: modelProvider.baseUrl,
          AGENTKIT_ENGINE_MODEL_API_KEY_ENV: MODEL_ENV, [MODEL_ENV]: modelProvider.apiKey ?? '',
          ...(Number.isSafeInteger(modelProvider.contextWindow) ? { AGENTKIT_ENGINE_MODEL_CONTEXT_WINDOW: String(modelProvider.contextWindow) } : {}),
          ...(modelProvider.images ? { AGENTKIT_ENGINE_MODEL_IMAGES: '1' } : {}) },
        onApproveTool, onCallTool, hostName: 'agentkit-studio', onLog: chunk => { diagnostics = (diagnostics + chunk).slice(-4000); } });
      const runId = `studio-${createHash('sha256').update(`${session}\n${turnId ?? Date.now()}\n${input}`).digest('hex').slice(0, 32)}`;
      const abort = () => { engine.cancel(runId).catch(() => {}); };
      try {
        let hello;
        try { hello = await engine.initialize(); }
        catch (error) { throw failure('NATIVE_ENGINE_UNAVAILABLE', `Native 引擎启动失败：${error.message}`); }
        if (onCallTool) hostTools = engineHostTools(dynamicTools, { reserved: hello.engine?.reservedToolNames ?? [],
          ...(hello.engine?.hostToolNamePattern ? { pattern: hello.engine.hostToolNamePattern } : {}) });
        yield { type: 'engine', engine: { version: hello.engine?.version ?? null, preset: hello.engine?.preset ?? null, protocol: hello.protocolVersion } };
        await engine.startRun({ runId, objective: input, hostInstructions: systemPrompt, ...(onCallTool && hostTools.tools.length ? { hostTools: hostTools.tools } : {}) });
        signal?.addEventListener('abort', abort, { once: true });
        let finalText = null;
        for (let cursor = 0; ;) {
          const page = await engine.events(runId, cursor, 5000);
          for (const event of page.events) {
            for (const chunk of chunksOf(event)) yield chunk;
            if (event.kind === 'run.terminal' && text(event.detail)) finalText = event.detail;
          }
          cursor = page.cursor;
          if (!page.running && page.events.length === 0) break;
        }
        const rest = await engine.status(runId);
        // The final answer is the Run's delivered text; commentary during the task was shown as progress.
        if (text(rest.finalText ?? finalText)) yield { type: 'text', text: rest.finalText ?? finalText };
        if (!rest.terminal || rest.outcome === 'failed' || rest.phase === 'failed')
          throw failure('NATIVE_ENGINE_RUN_INCOMPLETE', runFailureMessage(rest));
      } finally {
        signal?.removeEventListener('abort', abort);
        await engine.close().catch(() => {});
      }
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
    tools.push({ name, description: String(spec.description || '').slice(0, 4000), parameters: schema });
  }
  return { tools, originalName: name => originals.get(name) ?? name };
}
function toolContent(output) {
  if (output == null) return null;
  if (typeof output === 'string') return { text: output };
  try { return JSON.parse(JSON.stringify(output)); } catch { return { text: String(output) }; }
}
function approvalReason(request) {
  const args = request.arguments ?? {};
  const subject = text(args.command) ? args.command : text(args.path) ? args.path : text(args.url) ? args.url : '';
  return `${request.tool ?? 'tool'}${subject ? `: ${subject.slice(0, 500)}` : ''}`;
}
function runFailureMessage(rest) {
  const reason = rest.reason ?? rest.phase ?? 'unknown';
  if (rest.phase === 'paused') return `任务已暂停（${reason}），可稍后继续。`;
  return `任务未完成（${reason}）。`;
}
