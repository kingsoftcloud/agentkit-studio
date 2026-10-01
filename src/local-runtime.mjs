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

function extractText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join('\n');
  if (value && typeof value === 'object') {
    if (Array.isArray(value.Memories || value.memories)) return extractText(value.Memories || value.memories);
    return String(value.text || value.content || value.Content || value.Text || value.Memory || value.memory || value.output || value.Data || '');
  }
  return '';
}

function toolDefinition(tool) {
  return { type: 'function', function: { name: String(tool.name), description: String(tool.description || ''), parameters: tool.inputSchema || tool.parameters || { type: 'object', properties: {} } } };
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
  return /(?:记住|别忘了|请记|remember(?:\s+that)?)/i.test(String(input || ''));
}

function memoryWriteEnabled(record, binding, input) {
  if (!binding || record?.spec?.memory?.enabled !== true) return false;
  const mode = String(record?.spec?.memory?.write?.mode || 'candidate').trim().toLowerCase();
  if (mode === 'candidate') return true;
  return mode === 'explicit_only' && explicitMemoryIntent(input);
}

/** Persist one completed turn through the Host-owned memory adapter. */
export async function writeBoundMemory({ binding, resourceAdapter, input, assistantText, userId, sessionId, agentId } = {}) {
  if (!binding || typeof resourceAdapter?.writeMemory !== 'function') return { accepted: false, reason: 'adapter_unavailable' };
  const resource = binding.config?.binding?.resource || {};
  return resourceAdapter.writeMemory(resource.id || resource.resourceId, userId || sessionId || agentId, [
    { role: 'user', content: input },
    { role: 'assistant', content: assistantText },
  ], { sessionId: String(sessionId || ''), agentId: String(agentId || ''), flush: false });
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
export async function prepareLocalResourceContext({ record, input, resourceAdapter, toolAdapter, userId, agent, resourceMode = 'full' } = {}) {
  const bindings = resourceMode === 'prompt-only' ? {} : record?.spec?.bindings || record?.bindings || {};
  const skillIds = bindingIds(bindings, 'skills');
  const knowledge = bindings.plugins?.find(item => item?.config?.binding?.resource?.kind === 'knowledge-base');
  const memory = memoryBinding(bindings);
  const skillSpace = bindings.plugins?.find(item => item?.config?.binding?.resource?.kind === 'skill-space');
  const toolIds = boundToolIds(bindings.tools);
  if ((skillIds.length || knowledge || memory || skillSpace || (Array.isArray(bindings.mcpServers) && bindings.mcpServers.length)) && !resourceAdapter) {
    throw new LocalRuntimeError('RESOURCE_ADAPTER_MISSING', '该 Agent 绑定了资源，但本地资源适配器未启用');
  }
  if (toolIds.length && !toolAdapter) {
    throw new LocalRuntimeError('TOOL_ADAPTER_MISSING', '该 Agent 绑定了 DSH Tool，但当前会话没有可用的 Tool 适配器', { resourceIds: toolIds });
  }
  let resourceContext = '';
  if (skillIds.length) {
    const skills = await Promise.all(skillIds.map(id => resourceAdapter.loadSkill(id)));
    resourceContext += skills.filter(Boolean).map(skill => `Skill ${skill.name || ''}:\n${String(skill.content || '').slice(0, 12000)}`).join('\n\n');
  }
  if (skillSpace) {
    const resourceId = skillSpace.config.binding.resource.id || skillSpace.config.binding.resource.resourceId;
    const skill = await resourceAdapter.loadSkill(resourceId);
    if (skill?.content) resourceContext += `\n\n${String(skill.content).slice(0, 24000)}`;
  }
  if (knowledge) {
    const resourceId = knowledge.config.binding.resource.id || knowledge.config.binding.resource.resourceId;
    const hits = await resourceAdapter.searchKnowledge(resourceId, input);
    resourceContext += (hits || []).map(hit => `Knowledge: ${extractText(hit.content || hit.text || hit)}`).join('\n');
  }
  if (memory) {
    const resourceId = memory.config.binding.resource.id || memory.config.binding.resource.resourceId;
    if (typeof resourceAdapter.searchMemory !== 'function') throw new LocalRuntimeError('MEMORY_ADAPTER_MISSING', '记忆库适配器未启用');
    const hits = await resourceAdapter.searchMemory(resourceId, input, userId);
    resourceContext += (hits || []).map(hit => `Memory: ${extractText(hit.content || hit.text || hit.memory || hit)}`).join('\n');
  }
  const collected = await collectBoundTools(resourceAdapter, toolAdapter, bindings, agent);
  if (collected.warnings.length) resourceContext += `\n\nBound resource warnings:\n${collected.warnings.join('\n')}`;
  return { bindings, resourceContext, tools: collected.tools, warnings: collected.warnings, memory, memoryWrite: memoryWriteEnabled(record, memory, input) };
}

/** OpenAI-compatible chat-completions stream adapter over the model profile. */
function createGatewayModel({ profile, fetchImpl = fetch, signal }) { void profile;
  if (!profile?.baseUrl || !profile?.apiKey) throw new LocalRuntimeError('MODEL_PROFILE_INVALID', '模型配置缺少 baseUrl 或 API Key');
  return {
    async *stream({ messages, tools = [] }) {
      if (signal?.aborted) throw runtimeCancelledError();
      // The explicit route signal comes from the response lifecycle. Do not
      // substitute the IncomingMessage signal here: its body is already
      // consumed before the model request starts.
      const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000);
      const response = await fetchImpl(`${profile.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${profile.apiKey}` },
        body: JSON.stringify({ model: profile.modelName || profile.id, messages, stream: true, ...(tools.length ? { tools, tool_choice: 'auto' } : {}) }),
        signal: requestSignal,
      });
      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => '');
        throw new LocalRuntimeError('MODEL_STREAM_FAILED', `模型流请求失败（${response.status}）`, { status: response.status, detail: detail.slice(0, 200) });
      }
      const toolCalls = new Map();
      let finishReason = '';
      try {
        for await (const parsed of readSse(response.body)) {
        if (signal?.aborted) throw runtimeCancelledError();
        if (parsed?.error) {
          throw new LocalRuntimeError('MODEL_STREAM_FAILED', '模型流返回错误', { upstreamCode: String(parsed.error.code || '') });
        }
        const delta = parsed?.choices?.[0]?.delta;
        if (delta?.content) yield { type: 'text', text: delta.content };
        const reasoning = delta?.reasoning_content || delta?.reasoning;
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
        const usage = parsed?.usage;
        if (usage) yield { type: 'usage', inputTokens: usage.prompt_tokens || 0, outputTokens: usage.completion_tokens || 0 };
      }
      } catch (error) {
        if (error instanceof LocalRuntimeError) throw error;
        if (error?.code === 'UPSTREAM_STREAM_TRUNCATED') throw new LocalRuntimeError('UPSTREAM_STREAM_TRUNCATED', '模型流在结束前断开');
        if (error instanceof SyntaxError) throw new LocalRuntimeError('MODEL_STREAM_INVALID', '模型流包含无效事件');
        throw error;
      }
      if (finishReason === 'length' || finishReason === 'content_filter') {
        throw new LocalRuntimeError('MODEL_OUTPUT_INCOMPLETE', '模型输出未完整结束', { reason: finishReason });
      }
      if (finishReason === 'tool_calls' || toolCalls.size) {
        yield { type: 'tool_calls', calls: [...toolCalls.values()] };
      }
    },
  };
}

/** Canonical items -> the conversation stream envelope the page already parses. */
function envelope(runId, sessionId, item) {
  return `data: ${JSON.stringify({ conversationItem: item, runId })}\n\n`;
}

export function createLocalConversationHandler({ agentStore, buildStore, modelService, resourceAdapter, observability, fetchImpl = fetch } = {}) {

  return async function handle(request, response, { signal, toolAdapter, agent } = {}) {
    let body = '';
    for await (const chunk of request) body += chunk;
    if (body.length > 1024 * 1024) { response.writeHead(413); response.end('request too large'); return; }
    let parsed;
    try { parsed = JSON.parse(body || '{}'); } catch { response.writeHead(400); response.end('bad json'); return; }
    const agentId = String(parsed.agentId || '');
    const input = String(parsed.input || '').trim();
    if (!agentId || !input) { response.writeHead(400); response.end('agentId and input required'); return; }
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
      record = await store.get(agentId);
    } catch { record = null; }
    }
    if (!record) { response.writeHead(404); response.end('local agent not found'); return; }

    const agentName = String(record.metadata?.name || record.name || agentId);
    const systemPrompt = [record.spec?.instructions?.system || record.spec?.description || '', record.spec?.instructions?.task || ''].filter(Boolean).join('\n\n');
    let profile;
    const modelId = record.spec?.bindings?.modelProfileId || bindingIds(record.spec?.bindings, 'modelProfileIds')[0] || '';
    try { profile = await (modelService.profileForAgent || modelService.profile)(modelId); } catch (error) {
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
        userId: parsed.userId || parsed.sessionId || agentId,
        agent,
        resourceMode: parsed.resourceMode,
      });
      resourceContext = prepared.resourceContext;
      tools = prepared.tools;
      preparedMemoryWrite = prepared.memoryWrite ? prepared.memory : null;
    } catch (error) {
      response.writeHead(409);
      response.end(JSON.stringify({ error: { code: error?.code || 'RESOURCE_EXECUTION_FAILED', message: error?.message || '资源加载失败', details: error?.details || {} } }));
      return;
    }
    const history = Array.isArray(parsed.history) ? parsed.history.filter(item => ['user', 'assistant'].includes(item?.role) && typeof item.content === 'string').slice(-20).map(item => ({ role: item.role, content: item.content.slice(0, 16000) })) : [];
    const messages = [{ role: 'system', content: [systemPrompt || 'You are a helpful assistant.', resourceContext ? `Relevant resources:\n${resourceContext}` : ''].filter(Boolean).join('\n\n') }, ...history, { role: 'user', content: input }];
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    send({ kind: 'user_message', lifecycle: 'completed', payload: { text: input } });
    noteTrace('turn.input', { chars: input.length });
    send({ kind: 'assistant_text', lifecycle: 'running', payload: { text: '' } });

    try {
      const model = createGatewayModel({ profile, fetchImpl, signal });
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
        for await (const chunk of model.stream({ messages, tools: tools.map(toolDefinition) })) {
          if (chunk.type === 'text') { text += chunk.text; turnText += chunk.text; send({ kind: 'assistant_text', lifecycle: 'running', payload: { operation: 'append', text: chunk.text } }); }
          if (chunk.type === 'reasoning') { reasoning += chunk.text; turnReasoning += chunk.text; send({ kind: 'assistant_reasoning', lifecycle: 'running', payload: { operation: 'append', text: chunk.text } }); }
          if (chunk.type === 'tool_calls') calls = chunk.calls;
        }
        if (!calls.length) break;
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
              : await resourceAdapter.callMcpTool(tool._resourceId, call.name, args);
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
          const result = await writeBoundMemory({ binding: preparedMemoryWrite, resourceAdapter, input, assistantText: text, userId: parsed.userId, sessionId: parsed.sessionId, agentId });
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
