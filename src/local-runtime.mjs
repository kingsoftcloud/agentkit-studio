/** Local agent runtime: execute locally-stored Studio agents through the
 * AgentKit harness with the configured gateway model.
 *
 * The conversation page POSTs a prompt; this handler runs the harness loop
 * (model stream -> canonical items) and emits the same canonical envelope the
 * cloud build stream uses, so the page renders one way for both runtimes.
 * Resource adapters are deliberately injected by the Host. The runtime does
 * not discover credentials or reach the control plane from the model loop.
 */

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
      tools.push({ ...tool, _resourceId: binding });
    }
  }
  return { tools, warnings };
}

/** OpenAI-compatible chat-completions stream adapter over the model profile. */
function createGatewayModel({ profile, fetchImpl = fetch }) { void profile;
  if (!profile?.baseUrl || !profile?.apiKey) throw new LocalRuntimeError('MODEL_PROFILE_INVALID', '模型配置缺少 baseUrl 或 API Key');
  return {
    async *stream({ messages, tools = [] }) {
      // NOTE: the host's IncomingMessage signal reads aborted once its body
      // is consumed, so it must NOT gate the upstream model request.
      const response = await fetchImpl(`${profile.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${profile.apiKey}` },
        body: JSON.stringify({ model: profile.modelName || profile.id, messages, stream: true, ...(tools.length ? { tools, tool_choice: 'auto' } : {}) }),
        signal: AbortSignal.timeout(180000),
      });
      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => '');
        throw new LocalRuntimeError('MODEL_STREAM_FAILED', `模型流请求失败（${response.status}）`, { status: response.status, detail: detail.slice(0, 200) });
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const toolCalls = new Map();
      let finishReason = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let split = buffer.indexOf('\n\n');
        while (split >= 0) {
          const record = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          for (const line of record.split(/\r?\n/)) {
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data);
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
            } catch { /* malformed SSE chunk ignored */ }
          }
          split = buffer.indexOf('\n\n');
        }
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

export function createLocalConversationHandler({ agentStore, modelService, resourceAdapter, observability, fetchImpl = fetch } = {}) {

  return async function handle(request, response) {
    let body = '';
    for await (const chunk of request) body += chunk;
    if (body.length > 1024 * 1024) { response.writeHead(413); response.end('request too large'); return; }
    let parsed;
    try { parsed = JSON.parse(body || '{}'); } catch { response.writeHead(400); response.end('bad json'); return; }
    const agentId = String(parsed.agentId || '');
    const input = String(parsed.input || '').trim();
    if (!agentId || !input) { response.writeHead(400); response.end('agentId and input required'); return; }

    let record;
    try {
      const store = await agentStore();
      record = await store.get(agentId);
    } catch { record = null; }
    if (!record) { response.writeHead(404); response.end('local agent not found'); return; }

    const systemPrompt = [record.spec?.instructions?.system || record.spec?.description || '', record.spec?.instructions?.task || ''].filter(Boolean).join('\n\n');
    const bindings = parsed.resourceMode === 'prompt-only' ? {} : record.spec?.bindings || record.bindings || {};
    const skillIds = bindingIds(bindings, 'skills');
    const knowledge = bindings.plugins?.find(item => item?.config?.binding?.resource?.kind === 'knowledge-base');
    const memory = bindings.plugins?.find(item => item?.config?.binding?.resource?.kind === 'memory-instance');
    const skillSpace = bindings.plugins?.find(item => item?.config?.binding?.resource?.kind === 'skill-space');
    if ((skillIds.length || knowledge || memory || skillSpace) && !resourceAdapter) {
      response.writeHead(409); response.end(JSON.stringify({ error: { code: 'RESOURCE_ADAPTER_MISSING', message: '该 Agent 绑定了资源，但本地资源适配器未启用' } })); return;
    }
    let profile;
    try { profile = await modelService.profile(''); } catch (error) {
      response.writeHead(409); response.end(JSON.stringify({ error: { code: error?.code || 'MODEL_CREDENTIAL_MISSING', message: error?.message || '模型配置不可用' } }));
      return;
    }

    const runId = `run_local_${Date.now().toString(36)}`;
    let seq = 0;
    const send = item => { seq += 1; response.write(envelope(runId, agentId, { itemId: `${runId}-${seq}`, kind: item.kind, lifecycle: item.lifecycle, payload: item.payload, seq })); };

    let resourceContext = '';
    let tools = [];
    try {
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
        const hits = await resourceAdapter.searchMemory(resourceId, input, parsed.userId || parsed.sessionId || agentId);
        resourceContext += (hits || []).map(hit => `Memory: ${extractText(hit.content || hit.text || hit.memory || hit)}`).join('\n');
      }
      const collected = resourceAdapter ? await collectTools(resourceAdapter, bindings) : { tools: [], warnings: [] };
      tools = collected.tools;
      if (collected.warnings.length) resourceContext += `\n\nBound resource warnings:\n${collected.warnings.join('\n')}`;
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
    send({ kind: 'assistant_text', lifecycle: 'running', payload: { text: '' } });

    try {
      const model = createGatewayModel({ profile, fetchImpl });
      // The harness owns the canonical loop; this local provider drives the
      // configured model while resource calls remain explicit Host actions.
      let text = '';
      let reasoning = '';
      for (let turn = 0; turn < 3; turn += 1) {
        let calls = [];
        for await (const chunk of model.stream({ messages, tools: tools.map(toolDefinition) })) {
          if (chunk.type === 'text') { text += chunk.text; send({ kind: 'assistant_text', lifecycle: 'running', payload: { operation: 'append', text: chunk.text } }); }
          if (chunk.type === 'reasoning') { reasoning += chunk.text; send({ kind: 'assistant_reasoning', lifecycle: 'running', payload: { operation: 'append', text: chunk.text } }); }
          if (chunk.type === 'tool_calls') calls = chunk.calls;
        }
        if (!calls.length) break;
        messages.push({ role: 'assistant', content: null, tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) });
        for (const call of calls) {
          let args;
          try { args = JSON.parse(call.arguments || '{}'); } catch { throw new LocalRuntimeError('MCP_TOOL_ARGUMENTS_INVALID', '模型生成的工具参数不是有效 JSON', { name: call.name }); }
          const tool = tools.find(candidate => candidate.name === call.name);
          if (!tool?._resourceId) throw new LocalRuntimeError('MCP_TOOL_NOT_BOUND', '模型请求了未绑定的工具', { name: call.name });
          send({ kind: 'tool_call', lifecycle: 'running', payload: { callId: call.id, name: call.name, arguments: args } });
          const result = await resourceAdapter.callMcpTool(tool._resourceId, call.name, args);
          const resultText = extractText(result) || JSON.stringify(result);
          messages.push({ role: 'tool', tool_call_id: call.id, content: resultText });
          send({ kind: 'tool_result', lifecycle: 'completed', payload: { callId: call.id, text: resultText } });
        }
      }
      if (reasoning) send({ kind: 'assistant_reasoning', lifecycle: 'completed', payload: { text: reasoning } });
      send({ kind: 'assistant_text', lifecycle: 'completed', payload: { text } });
      send({ kind: 'progress', lifecycle: 'completed', payload: { status: 'completed' } });
      await observability?.syncTrace({ traceId: runId, sessionId: String(parsed.sessionId || ''), agentId, status: 'completed', events: [{ event_type: 'run.completed', at: new Date().toISOString(), run_id: runId }] }).catch(error => console.warn('[local-runtime] trace sync failed:', error?.message || error));
      response.write(`data: ${JSON.stringify({ runId, runtimeEvent: { event_type: 'run.completed' } })}\n\n`);
      response.end('data: [DONE]\n\n');
    } catch (error) {
      send({ kind: 'error', lifecycle: 'completed', payload: { message: String(error?.message || error).slice(0, 300) } });
      await observability?.syncTrace({ traceId: runId, sessionId: String(parsed.sessionId || ''), agentId, status: 'failed', events: [{ event_type: 'run.failed', at: new Date().toISOString(), run_id: runId, payload: { error: String(error?.message || error) } }] }).catch(traceError => console.warn('[local-runtime] trace sync failed:', traceError?.message || traceError));
      response.write(`data: ${JSON.stringify({ runId, runtimeEvent: { event_type: 'run.failed' } })}\n\n`);
      response.end('data: [DONE]\n\n');
    }
  };
}
