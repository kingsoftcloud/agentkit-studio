/** Local agent runtime: execute locally-stored Studio agents through the
 * AgentKit harness with the configured gateway model.
 *
 * The conversation page POSTs a prompt; this handler runs the harness loop
 * (model stream -> canonical items) and emits the same canonical envelope the
 * cloud build stream uses, so the page renders one way for both runtimes.
 * Resource bindings (MCP/Skill/knowledge) stay fail-closed: prompts note that
 * only model+prompt participate until the resource execution contract lands.
 */

export class LocalRuntimeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'LocalRuntimeError';
    this.code = code;
    this.details = details;
  }
}

/** OpenAI-compatible chat-completions stream adapter over the model profile. */
function createGatewayModel({ profile, fetchImpl = fetch }) { void profile;
  if (!profile?.baseUrl || !profile?.apiKey) throw new LocalRuntimeError('MODEL_PROFILE_INVALID', '模型配置缺少 baseUrl 或 API Key');
  return {
    async *stream({ messages }) {
      // NOTE: the host's IncomingMessage signal reads aborted once its body
      // is consumed, so it must NOT gate the upstream model request.
      const response = await fetchImpl(`${profile.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${profile.apiKey}` },
        body: JSON.stringify({ model: profile.modelName || profile.id, messages, stream: true }),
        signal: AbortSignal.timeout(180000),
      });
      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => '');
        throw new LocalRuntimeError('MODEL_STREAM_FAILED', `模型流请求失败（${response.status}）`, { status: response.status, detail: detail.slice(0, 200) });
      }
      const reader = response.body.getReader();
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
          for (const line of record.split(/\r?\n/)) {
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data);
              const delta = parsed?.choices?.[0]?.delta;
              if (delta?.content) yield { type: 'text', text: delta.content };
              const usage = parsed?.usage;
              if (usage) yield { type: 'usage', inputTokens: usage.prompt_tokens || 0, outputTokens: usage.completion_tokens || 0 };
            } catch { /* malformed SSE chunk ignored */ }
          }
          split = buffer.indexOf('\n\n');
        }
      }
    },
  };
}

/** Canonical items -> the conversation stream envelope the page already parses. */
function envelope(runId, sessionId, item) {
  return `data: ${JSON.stringify({ conversationItem: item, runId })}\n\n`;
}

export function createLocalConversationHandler({ agentStore, modelService, storeDir, fetchImpl = fetch } = {}) {

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

    const systemPrompt = String(record.spec?.instructions?.system || record.spec?.description || '');
    let profile;
    try { profile = await modelService.profile(''); } catch (error) {
      response.writeHead(409); response.end(JSON.stringify({ error: { code: error?.code || 'MODEL_CREDENTIAL_MISSING', message: error?.message || '模型配置不可用' } }));
      return;
    }

    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const runId = `run_local_${Date.now().toString(36)}`;
    let seq = 0;
    const send = item => { seq += 1; response.write(envelope(runId, agentId, { itemId: `${runId}-${seq}`, kind: item.kind, lifecycle: item.lifecycle, payload: item.payload, seq })); };

    const messages = [{ role: 'system', content: systemPrompt || 'You are a helpful assistant.' }, { role: 'user', content: input }];
    send({ kind: 'user_message', lifecycle: 'completed', payload: { text: input } });
    send({ kind: 'assistant_text', lifecycle: 'running', payload: { text: '' } });

    try {
      const model = createGatewayModel({ profile, fetchImpl });
      // The harness owns the canonical loop; here we drive its model stream
      // directly because locally-stored agents are model+prompt only (resource
      // bindings stay fail-closed).
      let text = '';
      for await (const chunk of model.stream({ messages })) {
        if (chunk.type === 'text') {
          text += chunk.text;
          send({ kind: 'assistant_text', lifecycle: 'running', payload: { operation: 'append', text: chunk.text } });
        }
      }
      send({ kind: 'assistant_text', lifecycle: 'completed', payload: { text } });
      send({ kind: 'progress', lifecycle: 'completed', payload: { status: 'completed' } });
      response.write(`data: ${JSON.stringify({ runId, runtimeEvent: { event_type: 'run.completed' } })}\n\n`);
      response.end('data: [DONE]\n\n');
    } catch (error) {
      send({ kind: 'error', lifecycle: 'completed', payload: { message: String(error?.message || error).slice(0, 300) } });
      response.write(`data: ${JSON.stringify({ runId, runtimeEvent: { event_type: 'run.failed' } })}\n\n`);
      response.end('data: [DONE]\n\n');
    }
  };
}
