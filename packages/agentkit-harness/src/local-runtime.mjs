/** Local agent runtime: execute locally-stored Studio agents through the
 * AgentKit harness with the configured gateway model.
 *
 * The conversation page POSTs a prompt; this handler runs the harness loop
 * (model stream -> canonical items) and emits the same canonical envelope the
 * cloud build stream uses, so the page renders one way for both runtimes.
 * Resource adapters are deliberately injected by the Host. The runtime does
 * not discover credentials or reach the control plane from the model loop.
 */
import { readSse } from './sse.mjs';
import { modelFailureDetails } from './model-failure.mjs';
import { formatSkillContext } from './skill-context.mjs';
import { chatCompletionUsage } from './chat-usage.mjs';
import { checkedResource } from './resource-checks.mjs';
import { boundSkillResources, loadBoundSkills } from './skill-bindings.mjs';
import { dshModelRoute } from './model-route.mjs';
import { createModelIdleDeadline } from './model-idle-deadline.mjs';

export class LocalRuntimeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'LocalRuntimeError';
    this.code = code;
    this.details = details;
  }
}

function bindingIds(bindings, key) {
  const values = Array.isArray(bindings?.[key]) ? bindings[key] : [];
  return values.map(value => typeof value === 'string' ? value : value?.resourceId || value?.id).filter(Boolean).map(String);
}

export { boundSkillResources } from './skill-bindings.mjs';

function extractText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join('\n');
  if (value && typeof value === 'object') {
    if (Array.isArray(value.Memories || value.memories)) return extractText(value.Memories || value.memories);
    if (Array.isArray(value.Content) || Array.isArray(value.content)) return extractText(value.Content || value.content);
    if (value.Data && typeof value.Data === 'object') return extractText(value.Data);
    return String(value.text || value.content || value.Content || value.Text || value.Memory || value.memory || value.output || value.Data || '');
  }
  return '';
}

function toolDefinition(tool) {
  return { type: 'function', function: { name: String(tool.name), description: String(tool.description || ''), parameters: tool.inputSchema || tool.parameters || { type: 'object', properties: {} } } };
}

function modelToolDefinitions(values = []) {
  return (Array.isArray(values) ? values : []).map(tool => {
    if (tool?.type === 'function' && tool.function) return tool;
    return toolDefinition(tool);
  }).filter(tool => tool.function?.name);
}

function runtimeCancelledError() {
  return new LocalRuntimeError('REQUEST_CANCELLED', '本地 Agent 运行已取消');
}

function codexName(value, index) {
  const candidate = String(value || '').replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+|_+$/g, '').slice(0, 120);
  return candidate || `mcp_tool_${index + 1}`;
}

/** Convert Host-materialized bound tools to Codex app-server dynamic tools. */
export function codexToolBindings(tools = []) {
  const used = new Set();
  return tools.map((tool, index) => {
    const base = codexName(tool.name, index);
    let name = base;
    let suffix = 2;
    while (used.has(name)) name = `${base.slice(0, 110)}_${suffix++}`;
    used.add(name);
    return {
      name,
      tool,
      spec: {
        type: 'function',
        name,
        description: String(tool.description || `MCP tool ${tool.name}`),
        inputSchema: tool.inputSchema || tool.parameters || { type: 'object', properties: {} },
      },
    };
  });
}

async function collectTools(resourceAdapter, bindings) {
  const mcpBindings = Array.isArray(bindings?.mcpServers) ? bindings.mcpServers : [];
  const tools = [];
  const warnings = [];
  for (const binding of mcpBindings) {
    const id = typeof binding === 'string' ? binding : binding?.resourceId || binding?.id || '';
    let listed;
    try {
      listed = await resourceAdapter.listMcpTools(binding);
    } catch (error) {
      // MCP discovery is needed only when the model elects to call a tool.
      // Keep a text-only turn usable when an endpoint is temporarily
      // unreachable (for example, a private endpoint or invalid TLS chain),
      // while still telling the model why the bound resource was skipped.
      warnings.push(`MCP ${id} 当前不可用：${String(error?.message || error).slice(0, 240)}`);
      continue;
    }
    for (const tool of listed || []) {
      if (tools.some(existing => existing.name === tool.name)) throw new LocalRuntimeError('MCP_TOOL_NAME_COLLISION', '多个 MCP 绑定暴露了同名工具', { name: tool.name });
      tools.push({ ...tool, _source: 'mcp', _resourceId: binding });
    }
  }
  return { tools, warnings };
}

function boundToolIds(bindings) {
  const values = Array.isArray(bindings) ? bindings : [];
  return values.map(value => {
    if (typeof value === 'string') return value;
    return value?.resourceId || value?.id || value?.name || '';
  }).filter(Boolean).map(String);
}

function memoryBinding(bindings) {
  return Array.isArray(bindings?.plugins)
    ? bindings.plugins.find(item => item?.config?.binding?.resource?.kind === 'memory-instance')
    : null;
}

function explicitMemoryIntent(input) {
  // Only a direct imperative opts into writing. A recall question such as
  // “我之前要求记住的代号是什么” must not become another memory write.
  const text = String(input || '');
  // Object-first commands are equally explicit. Limit recognition to a
  // direct imperative with a memory destination, excluding quoted requests,
  // questions, conditions and negations in the object phrase.
  const objectFirst = /(?:^|[。.!！;；\n:：])\s*(?:(?:请帮我|请|帮我|麻烦你?)\s*)?把((?:以下|这(?:一)?条|这(?:个|些)|我的)[^。.!！;；\n:：?？“”"'「」『』]{0,160}?)(?:保存|写入|存入)(?:到|进)?(?:已绑定的?|绑定的?)?(?:长期)?记忆库\s*(?:[:：，,。.!！]|$)/.exec(text);
  return /(?:^|[。.!！;；\n:：])\s*(?:(?:请帮我|请|帮我|麻烦你?)\s*)?(?:记住|记下|别忘了)(?!了吗|什么|过)/.test(text)
    || /(?:^|[。.!！;；\n:：])\s*(?:(?:请帮我|请|帮我|麻烦你?)\s*)?(?:明确\s*)?(?:保存|写入|存入)(?:这(?:一)?条(?:信息|内容|记录)?|以下(?:信息|内容)?)?\s*(?:到|进)?\s*(?:长期记忆(?:库)?|记忆库)\s*(?:[:：，,。.!！]|$)/.test(text)
    || Boolean(objectFirst && !/不要|别|勿|是否|能否|如何|如果/.test(objectFirst[1]))
    || /(?:^|[。.!！;；\n:：])\s*(?:please\s+)?remember(?:\s+that)?\s+(?!what\b|when\b|how\b|whether\b|if\b)/i.test(text);
}

function memoryWriteEnabled(record, binding, input) {
  if (!binding || record?.spec?.memory?.enabled === false) return false;
  // Cloud Agent details expose a bound memory-instance through ComponentConfig
  // without Studio's local `spec.memory` projection. The binding itself is the
  // user's explicit opt-in for recall and post-turn persistence.
  const config = record?.spec?.memory || {};
  const mode = String(config.write?.mode || 'candidate').trim().toLowerCase();
  if (mode === 'candidate') return true;
  return mode === 'explicit_only' && explicitMemoryIntent(input);
}

/** Pure Host policy shared by ordinary and durable Native turn consumers. */
export function boundMemoryWritePolicy(record, input) {
  const binding = memoryBinding(record?.spec?.bindings || record?.bindings || {});
  if (!memoryWriteEnabled(record, binding, input)) return null;
  const resource = binding.config.binding.resource;
  return { resourceId: String(resource.id || resource.resourceId || ''),
    mode: String(record?.spec?.memory?.write?.mode || 'candidate').trim().toLowerCase(), flush: explicitMemoryIntent(input) };
}

/** Persist one completed turn through the Host-owned memory adapter. */
export async function writeBoundMemory({ binding, resourceAdapter, input, assistantText, userId, sessionId, agentId, agent, onResource } = {}) {
  if (!binding || typeof resourceAdapter?.writeMemory !== 'function') return { accepted: false, reason: 'adapter_unavailable' };
  const resource = binding.config?.binding?.resource || {};
  const resourceId = resource.id || resource.resourceId;
  return checkedResource({ kind: 'memory-instance', resourceId, action: 'write', agent, onResource }, () => resourceAdapter.writeMemory(resourceId, userId || 'studio-anonymous', [
    { role: 'user', content: input },
    { role: 'assistant', content: assistantText },
  ], {
    sessionId: String(sessionId || ''),
    agentId: String(agentId || ''),
    // AICP extracts ordinary turn syncs asynchronously. A direct "请记住"
    // request is an explicit fact-save operation and may flush this session;
    // candidate writes keep the cheaper queued path.
    flush: explicitMemoryIntent(input),
  }));
}

async function collectDshTools(toolAdapter, bindings, agent) {
  const ids = boundToolIds(bindings?.tools);
  if (!ids.length) return [];
  if (!toolAdapter || typeof toolAdapter.listTools !== 'function') {
    throw new LocalRuntimeError('TOOL_ADAPTER_MISSING', '该 Agent 绑定了 DSH Tool，但当前会话没有可用的 Tool 适配器', { resourceIds: ids });
  }
  const listed = await toolAdapter.listTools(ids, agent);
  return (listed || []).map(tool => ({ ...tool, _source: 'dsh', _resourceId: tool.resourceId || tool.name }));
}

async function collectBoundTools(resourceAdapter, toolAdapter, bindings, agent) {
  const mcp = resourceAdapter ? await collectTools(resourceAdapter, bindings) : { tools: [], warnings: [] };
  const dsh = await collectDshTools(toolAdapter, bindings, agent);
  const tools = [...mcp.tools, ...dsh];
  const seen = new Set();
  for (const tool of tools) {
    if (seen.has(tool.name)) throw new LocalRuntimeError('BOUND_TOOL_NAME_COLLISION', '多个绑定资源暴露了同名工具', { name: tool.name });
    seen.add(tool.name);
  }
  return { tools, warnings: mcp.warnings };
}

/**
 * Resolve the resources attached to a revision once, before a model turn.
 * Harness and Codex use the same Host-owned materialization path so a bound
 * MCP/Skill/knowledge/memory resource has identical semantics in both local
 * runtimes.
 */
export async function prepareLocalResourceContext({ record, input, resourceAdapter, toolAdapter, userId, agent, onResource, agentId = '', resourceMode = 'full' } = {}) {
  const promptOnly = resourceMode === 'prompt-only';
  const contextOnly = resourceMode === 'context-only';
  const toolsOnly = resourceMode === 'tools-only';
  const bindings = toolsOnly ? (record?.spec?.bindings || record?.bindings || {}) : promptOnly ? {} : record?.spec?.bindings || record?.bindings || {};
  const skillResources = boundSkillResources(bindings);
  const knowledge = bindings.plugins?.find(item => item?.config?.binding?.resource?.kind === 'knowledge-base');
  const memory = record?.spec?.memory?.enabled === false ? null : memoryBinding(bindings);
  const toolIds = boundToolIds(bindings.tools);
  if ((skillResources.length || knowledge || memory || (Array.isArray(bindings.mcpServers) && bindings.mcpServers.length)) && !resourceAdapter) {
    throw new LocalRuntimeError('RESOURCE_ADAPTER_MISSING', '该 Agent 绑定了资源，但本地资源适配器未启用');
  }
  if (toolIds.length && !toolAdapter) {
    throw new LocalRuntimeError('TOOL_ADAPTER_MISSING', '该 Agent 绑定了 DSH Tool，但当前会话没有可用的 Tool 适配器', { resourceIds: toolIds });
  }
  let resourceContext = '';
  if (!toolsOnly && record?.spec?.memory?.enabled === false && memoryBinding(bindings)) {
    resourceContext += '\n\nMemory binding contract: 当前 Agent 的跨会话长期记忆已关闭。Host 本轮没有查询记忆库，也不会写入记忆库；下面即使有 Knowledge，也只属于知识库检索，不能据此声称长期记忆已启用或已召回。\n';
  }
  if (!toolsOnly && skillResources.length) {
    const loaded = await loadBoundSkills(bindings, resourceAdapter, { agent, onResource });
    resourceContext += loaded.filter(item => item.value).map(({ kind, value }) => kind === 'skill'
      ? `Skill ${value.name || ''}:\n${formatSkillContext(value, { indexOnly: record?.spec?.runtime?.type === 'codex' })}`
      : `\n\n${formatSkillContext(value, { limit: 24000, indexOnly: record?.spec?.runtime?.type === 'codex' })}`).join('\n\n');
  }
  if (!toolsOnly && knowledge) {
    const resourceId = knowledge.config.binding.resource.id || knowledge.config.binding.resource.resourceId;
    const hits = await checkedResource({ kind: 'knowledge-base', resourceId, action: 'search', agent, onResource }, () => resourceAdapter.searchKnowledge(resourceId, input));
    resourceContext += '\n\nKnowledge binding contract: 当前 Agent 已绑定知识库，Host 已按当前问题检索该知识库。下面的 Knowledge 是实际检索片段，与长期 Memory 和 MCP 专题目录无关；不能因 MCP 专题为空就声称知识库未绑定。只引用实际片段，没有命中不等于没有绑定。\n';
    resourceContext += (hits || []).map(hit => {
      const segment = hit?.Segment || hit?.segment || hit;
      const content = extractText(segment);
      const title = segment?.Document?.Name || segment?.document?.name || '';
      return content ? `Knowledge${title ? ` (${String(title)})` : ''}: ${content}` : '';
    }).filter(Boolean).join('\n');
  }
  if (!toolsOnly && memory && record?.spec?.memory?.recall?.enabled !== false) {
    const resourceId = memory.config.binding.resource.id || memory.config.binding.resource.resourceId;
    if (typeof resourceAdapter.searchMemory !== 'function') throw new LocalRuntimeError('MEMORY_ADAPTER_MISSING', '记忆库适配器未启用');
    const hits = await checkedResource({ kind: 'memory-instance', resourceId, action: 'recall', agent, onResource }, () => resourceAdapter.searchMemory(resourceId, input, userId, { agentId }));
    resourceContext += '\n\nMemory binding contract: 当前 Agent 绑定了长期记忆库，下文的 Memory 召回及后续写入由 Host 管理，与上面的 Knowledge 检索片段和 MCP 专题目录分开，不需要模型调用独立记忆工具。';
    resourceContext += memoryWriteEnabled(record, memory, input)
      ? '本轮正常完成后，Host 会按配置向记忆库提交本轮内容；你不能因没有独立工具就声称记忆仅保留在当前会话，也不能在写入结果尚未返回时声称已保存。'
      : '当前写入策略下本轮不会写入记忆库，只使用实际召回内容；不能承诺已保存新记忆。';
    resourceContext += '\n实际召回内容来自当前记忆库查询；旧对话文本中的“待写入”等说法不能代替当前的查询结果，也不能据此声称本轮未召回。\n';
    resourceContext += (hits || []).map(hit => `Memory: ${extractText(hit.content || hit.text || hit.memory || hit)}`).join('\n');
  }
  const collected = contextOnly || toolsOnly || promptOnly
    ? { tools: [], warnings: [] }
    : await collectBoundTools(resourceAdapter, toolAdapter, bindings, agent);
  if (!toolsOnly && collected.warnings.length) resourceContext += `\n\nBound resource warnings:\n${collected.warnings.join('\n')}`;
  return { bindings, resourceContext, tools: collected.tools, warnings: collected.warnings, memory, memoryWrite: !toolsOnly && memoryWriteEnabled(record, memory, input) };
}

/** OpenAI-compatible chat-completions stream adapter over the model profile. */
function createGatewayModel({ profile, reasoningEffort, fetchImpl = fetch, signal, modelIdleTimeoutMs }) {
  if (!profile?.baseUrl || !profile?.apiKey) throw new LocalRuntimeError('MODEL_PROFILE_INVALID', '模型配置缺少 baseUrl 或 API Key');
  // Only a level this profile declared reaches the wire; an undeclared level
  // would be an unknown parameter to the gateway.
  const reasoningWire = reasoningEffort && profile.reasoningEfforts?.[reasoningEffort];
  return {
    async *stream({ messages, tools = [] }) {
      if (signal?.aborted) throw runtimeCancelledError();
      // The explicit route signal comes from the response lifecycle. Do not
      // substitute the IncomingMessage signal here: its body is already
      // consumed before the model request starts.
      const deadline = createModelIdleDeadline({ signal, timeoutMs: modelIdleTimeoutMs });
      const requestSignal = deadline.signal;
      try {
      let response;
      try { response = await fetchImpl(`${profile.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${profile.apiKey}` },
        body: JSON.stringify({ model: profile.modelName || profile.id, messages, stream: true, stream_options: { include_usage: true }, ...(tools.length ? { tools, tool_choice: 'auto' } : {}), ...(reasoningWire ? { reasoning_effort: reasoningWire } : {}) }),
        signal: requestSignal,
      }); } catch {
        if (signal?.aborted) throw runtimeCancelledError();
        throw new LocalRuntimeError(requestSignal.aborted ? 'MODEL_TIMEOUT' : 'MODEL_TRANSPORT_FAILED', requestSignal.aborted ? '模型请求超时' : '模型服务连接失败');
      }
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        throw new LocalRuntimeError('MODEL_STREAM_FAILED', `模型流请求失败（${response.status}）`, modelFailureDetails({ status: response.status, headers: response.headers, error: detail?.error }));
      }
      if (!response.body) throw new LocalRuntimeError('MODEL_EMPTY_RESPONSE', '模型未返回响应内容');
      deadline.touch();
      const toolCalls = new Map();
      let finishReason = '';
      let hasContent = false;
      let usage;
      try {
        for await (const parsed of readSse(response.body, { onChunk: deadline.touch })) {
        if (signal?.aborted) throw runtimeCancelledError();
        if (parsed?.error) {
          throw new LocalRuntimeError('MODEL_STREAM_FAILED', '模型流返回错误', modelFailureDetails({ error: parsed.error, headers: response.headers }));
        }
        const delta = parsed?.choices?.[0]?.delta;
        if (delta?.content) yield { type: 'text', text: delta.content };
        const reasoning = delta?.reasoning_content || delta?.reasoning;
        if (delta?.content || reasoning) hasContent = true;
        if (reasoning) yield { type: 'reasoning', text: reasoning };
        for (const call of delta?.tool_calls || []) {
          const index = Number(call.index || 0);
          const current = toolCalls.get(index) || { id: '', name: '', arguments: '' };
          current.id = call.id || current.id;
          current.name = call.function?.name || current.name;
          current.arguments += call.function?.arguments || '';
          toolCalls.set(index, current);
        }
        finishReason = parsed?.choices?.[0]?.finish_reason || finishReason;
        usage = chatCompletionUsage(parsed?.usage) || usage;
      }
      } catch (error) {
        if (signal?.aborted) throw runtimeCancelledError();
        if (error instanceof LocalRuntimeError) throw error;
        if (error?.code === 'UPSTREAM_STREAM_TRUNCATED') throw new LocalRuntimeError('UPSTREAM_STREAM_TRUNCATED', '模型流在结束前断开');
        if (error instanceof SyntaxError) throw new LocalRuntimeError('MODEL_STREAM_INVALID', '模型流包含无效事件');
        throw new LocalRuntimeError(requestSignal.aborted ? 'MODEL_TIMEOUT' : 'MODEL_TRANSPORT_FAILED', requestSignal.aborted ? '模型流超时' : '模型服务连接中断');
      }
      if (!finishReason) throw new LocalRuntimeError('UPSTREAM_STREAM_TRUNCATED', '模型流在完成前断开');
      if (finishReason === 'length' || finishReason === 'content_filter') {
        throw new LocalRuntimeError('MODEL_OUTPUT_INCOMPLETE', '模型输出未完整结束', { reason: finishReason });
      }
      // Retain the last valid snapshot; repeated trailer frames are not deltas.
      if (usage) yield { type: 'usage', usage };
      if (finishReason === 'tool_calls' || toolCalls.size) {
        yield { type: 'tool_calls', calls: [...toolCalls.values()] };
      }
      else if (!hasContent) throw new LocalRuntimeError('MODEL_EMPTY_RESPONSE', '模型未返回响应内容');
      } finally { deadline.dispose(); }
    },
  };
}

/** Canonical items -> the conversation stream envelope the page already parses. */
function envelope(runId, sessionId, item) {
  return `data: ${JSON.stringify({ conversationItem: item, runId })}\n\n`;
}

export function createLocalConversationHandler({ agentStore, buildStore, modelService, resourceAdapter, observability, fetchImpl = fetch, modelIdleTimeoutMs = 180000 } = {}) {

  return async function handle(request, response, { signal, toolAdapter, agent } = {}) {
    let body = '';
    for await (const chunk of request) body += chunk;
    if (Buffer.byteLength(body) > 32 * 1024 * 1024) { response.writeHead(413); response.end('request too large'); return; }
    let parsed;
    try { parsed = JSON.parse(body || '{}'); } catch { response.writeHead(400); response.end('bad json'); return; }
    const agentId = String(parsed.agentId || '');
    const input = String(parsed.input || '').trim();
    const validContent = content => typeof content === 'string' ? Boolean(content.trim()) : Array.isArray(content) && content.length > 0
      && content.every(part => (part?.type === 'text' && typeof part.text === 'string') || (part?.type === 'image_url' && typeof part.image_url?.url === 'string' && part.image_url.url.length > 0))
      && content.some(part => part.type === 'image_url' || part.text.trim());
    const content = parsed.content ?? input;
    if (!agentId || !validContent(content)) { response.writeHead(400); response.end('agentId and input required'); return; }
    if (signal?.aborted) throw runtimeCancelledError();

    let record;
    if (parsed.buildId) {
      try {
        if (!buildStore?.resolve) throw new LocalRuntimeError('BUILD_RUNTIME_UNAVAILABLE', '本地 Build 运行适配器未启用');
        record = await buildStore.resolve(agentId, String(parsed.buildId));
        if (record.metadata?.local !== true) throw new LocalRuntimeError('BUILD_RUNTIME_UNSUPPORTED', '只有本地 Agent Build 支持冻结版本会话');
      } catch (error) {
        response.writeHead(409); response.end(JSON.stringify({ error: { code: error.code || 'BUILD_EXECUTION_FAILED', message: error.message } })); return;
      }
    } else {
    try {
      const store = await agentStore();
      record = parsed.agentRevision ? await store.getRevision(agentId,Number(parsed.agentRevision)) : await store.get(agentId);
    } catch { record = null; }
    }
    if (!record) { response.writeHead(404); response.end('local agent not found'); return; }

    const agentName = String(record.metadata?.name || record.name || agentId);
    const nativeTools = parsed.nativeTools === true;
    const systemPrompt = [record.spec?.instructions?.system || record.spec?.description || '', record.spec?.instructions?.task || ''].filter(Boolean).join('\n\n');
    let profile;
    const modelId = record.spec?.bindings?.modelProfileId || bindingIds(record.spec?.bindings, 'modelProfileIds')[0] || '';
    try {
      if (parsed.modelSelection !== undefined) {
        const selection = parsed.modelSelection;
        if (typeof selection?.provider !== 'string' || typeof selection?.model !== 'string') throw new LocalRuntimeError('BOUND_MODEL_SELECTION_INVALID', '模型选择格式无效');
        const ids = [...new Set([modelId, ...bindingIds(record.spec?.bindings, 'modelProfileIds')].filter(Boolean))];
        const profiles = await Promise.all((ids.length ? ids : ['']).map(id => (modelService.profileForAgent || modelService.profile)(id)));
        const matches = profiles.filter(item => dshModelRoute(item) === selection.provider && item.modelName === selection.model);
        // Draft presets use DSH's native picker, which exposes the bound
        // gateway catalog. Honor its model choice on that same credential
        // route; immutable Builds still admit only their frozen model names.
        if (!matches.length && nativeTools && !parsed.buildId && typeof modelService.catalog === 'function') {
          for (const [index, candidate] of profiles.entries()) {
            if (dshModelRoute(candidate) !== selection.provider) continue;
            const catalog = await modelService.catalog(ids[index] || '');
            if (catalog.items?.some(item => item.id === selection.model)) matches.push({ ...candidate, modelName: selection.model });
          }
        }
        if (matches.length !== 1) throw new LocalRuntimeError('BOUND_MODEL_SELECTION_UNAVAILABLE', '所选模型不在此 Agent 的绑定模型中，请重新选择');
        profile = matches[0];
      } else profile = await (modelService.profileForAgent || modelService.profile)(modelId);
    } catch (error) {
      response.writeHead(409); response.end(JSON.stringify({ error: { code: error?.code || 'MODEL_CREDENTIAL_MISSING', message: error?.message || '模型配置不可用' } }));
      return;
    }

    const runId = `run_local_${Date.now().toString(36)}`;
    const traceEvents = [];
    let seq = 0;
    const noteTrace = (eventType, payload = {}) => traceEvents.push({ event_type: eventType, at: new Date().toISOString(), run_id: runId, payload });
    const send = item => {
      seq += 1;
      response.write(envelope(runId, agentId, { itemId: `${runId}-${seq}`, kind: item.kind, lifecycle: item.lifecycle, payload: item.payload, seq }));
      const text = String(item.payload?.text || '');
      if ((item.kind === 'assistant_text' || item.kind === 'assistant_reasoning') && text) noteTrace(`turn.${item.kind === 'assistant_text' ? 'text' : 'reasoning'}`, { chars: text.length });
      else if (item.kind === 'tool_call') noteTrace('tool.started', { name: String(item.payload?.name || 'bound tool') });
      else if (item.kind === 'tool_result') noteTrace('tool.completed', { name: String(item.payload?.name || 'bound tool') });
    };

    let resourceContext = '';
    let tools = [];
    let preparedMemoryWrite = null;
    try {
      const prepared = await prepareLocalResourceContext({
        record,
        input,
        resourceAdapter,
        toolAdapter,
        userId: parsed.userId || 'studio-anonymous',
        agentId: record.metadata?.teamRole?.sourceAgentId || agentId,
        agent,
        resourceMode: nativeTools ? 'context-only' : parsed.resourceMode,
        onResource: check => noteTrace('resource.checked', check),
      });
      resourceContext = prepared.resourceContext;
      tools = nativeTools ? modelToolDefinitions(parsed.tools) : prepared.tools;
      preparedMemoryWrite = prepared.memoryWrite ? prepared.memory : null;
    } catch (error) {
      response.writeHead(409);
      response.end(JSON.stringify({ error: { code: error?.code || 'RESOURCE_EXECUTION_FAILED', message: error?.message || '资源加载失败', details: error?.details || {} } }));
      return;
    }
    const history = Array.isArray(parsed.history) ? parsed.history
      .filter(item => ['user', 'assistant', 'tool'].includes(item?.role)
        && (item.role === 'assistant' || validContent(item.content))
        && (item.role !== 'tool' || String(item.tool_call_id || '').trim()))
      .slice(nativeTools ? 0 : -20)
      .map(item => ({
        role: item.role,
        content: typeof item.content === 'string' ? (nativeTools ? item.content : item.content.slice(0, 16000)) : Array.isArray(item.content) ? item.content : null,
        ...(Array.isArray(item.tool_calls) ? { tool_calls: item.tool_calls } : {}),
        ...(item.tool_call_id ? { tool_call_id: String(item.tool_call_id) } : {}),
      })) : [];
    // DSH sends the current user message in `history` and also passes it as
    // the explicit runtime input. Keep one canonical user turn in the model
    // request; duplicating it makes tool continuations start with two user
    // messages and breaks the assistant/tool pairing on the next round.
    const lastInput = [...history].reverse().find(item => item.role === 'user');
    const hasCurrentInput = lastInput && JSON.stringify(lastInput.content) === JSON.stringify(content);
    const assembledSystemPrompt = nativeTools && typeof parsed.systemPrompt === 'string' && parsed.systemPrompt.trim() ? parsed.systemPrompt : systemPrompt;
    const messages = [{ role: 'system', content: [assembledSystemPrompt || 'You are a helpful assistant.', resourceContext ? `Relevant resources:\n${resourceContext}` : ''].filter(Boolean).join('\n\n') }, ...history, ...(hasCurrentInput ? [] : [{ role: 'user', content }])];
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    send({ kind: 'user_message', lifecycle: 'completed', payload: { text: input } });
    noteTrace('turn.input', { chars: input.length });
    send({ kind: 'assistant_text', lifecycle: 'running', payload: { text: '' } });

    try {
      const model = createGatewayModel({ profile, reasoningEffort: parsed.reasoningEffort, fetchImpl, signal, modelIdleTimeoutMs });
      // The harness owns the canonical loop; this local provider drives the
      // configured model while resource calls remain explicit Host actions.
      let text = '';
      let reasoning = '';
      const configuredSteps = Number(record.spec?.execution?.maxSteps || record.execution?.maxSteps || 12);
      const maxSteps = Math.min(100, Math.max(1, Number.isFinite(configuredSteps) ? Math.floor(configuredSteps) : 12));
      for (let turn = 0; turn < maxSteps; turn += 1) {
        let calls = [];
        let turnText = '';
        let turnReasoning = '';
        for await (const chunk of model.stream({ messages, tools: nativeTools ? tools : tools.map(toolDefinition) })) {
          if (chunk.type === 'text') { text += chunk.text; turnText += chunk.text; send({ kind: 'assistant_text', lifecycle: 'running', payload: { operation: 'append', text: chunk.text } }); }
          if (chunk.type === 'reasoning') { reasoning += chunk.text; turnReasoning += chunk.text; send({ kind: 'assistant_reasoning', lifecycle: 'running', payload: { operation: 'append', text: chunk.text } }); }
          if (chunk.type === 'tool_calls') calls = chunk.calls;
          if (chunk.type === 'usage') {
            noteTrace('model.usage', { source: 'chat-completions', usage: chunk.usage });
            send({ kind: 'usage', lifecycle: 'completed', payload: { usage: chunk.usage } });
          }
        }
        if (!calls.length) break;
        if (nativeTools) {
          for (const call of calls) {
            send({ kind: 'tool_call', lifecycle: 'completed', payload: {
              callId: call.id, name: call.name, arguments: call.arguments, protocol: 'dsh',
            } });
          }
          send({ kind: 'progress', lifecycle: 'completed', payload: { status: 'tool_calls' } });
          response.end('data: [DONE]\n\n');
          return;
        }
        messages.push({ role: 'assistant', content: turnText || null, tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })), ...(turnReasoning ? { reasoning_content: turnReasoning } : {}) });
        for (const call of calls) {
          if (signal?.aborted) throw runtimeCancelledError();
          let args;
          try { args = JSON.parse(call.arguments || '{}'); } catch { throw new LocalRuntimeError('MCP_TOOL_ARGUMENTS_INVALID', '模型生成的工具参数不是有效 JSON', { name: call.name }); }
          const tool = tools.find(candidate => candidate.name === call.name);
          if (!tool?._source) throw new LocalRuntimeError('BOUND_TOOL_NOT_FOUND', '模型请求了未绑定的工具', { name: call.name });
          send({ kind: 'tool_call', lifecycle: 'running', payload: { callId: call.id, name: call.name, arguments: args } });
          let result;
          try {
            result = tool._source === 'dsh'
              ? await toolAdapter.callTool(call.name, args, { callId: call.id, signal, agent })
              : await resourceAdapter.callMcpTool(tool._resourceId, call.name, args, { signal });
          } catch (error) {
            noteTrace('tool.failed', { name: call.name, code: String(error?.code || 'MCP_TOOL_FAILED') });
            throw error;
          }
          const resultText = extractText(result) || JSON.stringify(result);
          messages.push({ role: 'tool', tool_call_id: call.id, content: resultText });
          send({ kind: 'tool_result', lifecycle: 'completed', payload: { callId: call.id, name: call.name, text: resultText } });
        }
        if (turn + 1 >= maxSteps) throw new LocalRuntimeError('LOCAL_EXECUTION_LIMIT', `Agent 达到最大执行步数（${maxSteps}）`, { maxSteps });
      }
      if (reasoning) send({ kind: 'assistant_reasoning', lifecycle: 'completed', payload: { text: reasoning } });
      send({ kind: 'assistant_text', lifecycle: 'completed', payload: { text } });
      if (preparedMemoryWrite && typeof resourceAdapter?.writeMemory === 'function') {
        try {
          const result = await writeBoundMemory({ binding: preparedMemoryWrite, resourceAdapter, input, assistantText: text, userId: parsed.userId, sessionId: parsed.sessionId, agentId: record.metadata?.teamRole?.sourceAgentId || agentId, agent, onResource: check => noteTrace('resource.checked', check) });
          noteTrace('memory.write', { accepted: result?.accepted === true });
        } catch (error) {
          // Memory persistence is a post-response side effect. Keep the
          // completed answer visible while recording the typed write failure.
          noteTrace('memory.write.failed', { code: String(error?.code || 'MEMORY_WRITE_FAILED') });
        }
      }
      send({ kind: 'progress', lifecycle: 'completed', payload: { status: 'completed' } });
      await observability?.syncTrace({ traceId: runId, sessionId: String(parsed.sessionId || ''), agentId, agentName, status: 'completed', events: [...traceEvents, { event_type: 'run.completed', at: new Date().toISOString(), run_id: runId }] }).catch(error => console.warn('[local-runtime] trace sync failed:', error?.message || error));
      response.write(`data: ${JSON.stringify({ runId, runtimeEvent: { event_type: 'run.completed' } })}\n\n`);
      response.end('data: [DONE]\n\n');
    } catch (error) {
      if (signal?.aborted || error?.code === 'REQUEST_CANCELLED' || error?.name === 'AbortError') {
        await observability?.syncTrace({ traceId: runId, sessionId: String(parsed.sessionId || ''), agentId, agentName, status: 'canceled', events: [...traceEvents, { event_type: 'run.canceled', at: new Date().toISOString(), run_id: runId, payload: { reason: 'client disconnected' } }] }).catch(traceError => console.warn('[local-runtime] trace sync failed:', traceError?.message || traceError));
        if (!response.writableEnded && !response.destroyed) response.end('data: [DONE]\n\n');
        return;
      }
      send({ kind: 'error', lifecycle: 'completed', payload: {
        code: String(error?.code || 'LOCAL_RUNTIME_FAILED'),
        message: String(error?.message || error).slice(0, 300),
        ...(error?.details && typeof error.details === 'object' ? { details: error.details } : {}),
      } });
      await observability?.syncTrace({ traceId: runId, sessionId: String(parsed.sessionId || ''), agentId, agentName, status: 'failed', events: [...traceEvents, { event_type: 'run.failed', at: new Date().toISOString(), run_id: runId, payload: { error: String(error?.message || error) } }] }).catch(traceError => console.warn('[local-runtime] trace sync failed:', traceError?.message || traceError));
      response.write(`data: ${JSON.stringify({ runId, runtimeEvent: { event_type: 'run.failed' } })}\n\n`);
      response.end('data: [DONE]\n\n');
    }
  };
}
