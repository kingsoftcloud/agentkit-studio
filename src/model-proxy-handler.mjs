import { hostFetch } from './http-fetch.mjs';
/** Authenticated model routes hosted by the public DSH WebServer service. */
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { responsesToChat, chatToResponses, createResponsesStreamTransformer, normalizeDeveloperRole } from './model-proxy.mjs';
import { readSse } from './sse.mjs';
import { prepareCodexProxyRequest } from './codex-proxy-tools.mjs';
import { createModelIdleDeadline } from './model-idle-deadline.mjs';
import { requestHeaders } from './model-profile-contract.mjs';
import { applyReasoningFallback, dropCarrierlessReasoningTurns, dropOrphanToolReceipts, isReasoningEffortRejection, isReasoningReplayRejection, logReasoningFallback, normalizeEmptyAssistantTurns, normalizeReasoningContent, studioReasoningFallbackWire } from './model-reasoning.mjs';

/**
 * Bounded provider identifiers from a rejected-request body.
 *
 * Never returns message text: an OpenAI-compatible gateway may echo the whole
 * conversation back inside `error.message`. Only the short machine-readable
 * `error.code` / `error.type` survive, which is what the DSH failure contract
 * classifies on.
 */
export function upstreamErrorIdentifiers(detail) {
  const identifiers = {};
  if (typeof detail !== 'string' || !detail.trim()) return identifiers;
  let value;
  try { value = JSON.parse(detail); } catch { return identifiers; }
  const error = value?.error && typeof value.error === 'object' ? value.error : value;
  for (const [field, key] of [['upstreamCode', 'code'], ['upstreamType', 'type']]) {
    const candidate = error?.[key];
    if (typeof candidate === 'string' && /^[\w.-]{1,80}$/.test(candidate)) identifiers[field] = candidate;
  }
  return identifiers;
}

/**
 * Outbound headers for one profile.
 *
 * A configured `Authorization` (or any other header) is an explicit operator
 * choice — a gateway may take its credential in a different header — so it
 * wins over the API-key default. `Content-Type` stays proxy-owned: the body is
 * always JSON and a hand-edited config must not be able to describe it
 * otherwise.
 * @param {object} profile - the resolved model profile.
 * @returns {Record<string, string>} headers for the upstream request.
 */
export function upstreamRequestHeaders(profile) {
  const configured = requestHeaders(profile?.headers);
  const headers = { ...configured, 'Content-Type': 'application/json' };
  if (!Object.keys(configured).some(name => name.toLowerCase() === 'authorization')) {
    headers.Authorization = `Bearer ${profile?.apiKey}`;
  }
  return headers;
}

export function createModelProxyHandler({ models, admit, fetchImpl = hostFetch, codexTools = false, onRequestMetrics, onReasoningFallback = logReasoningFallback, upstreamApi = 'chat-completions', idleTimeoutMs = 120000 }) {
  if (!['chat-completions', 'responses'].includes(upstreamApi)) throw new TypeError('Unsupported model proxy API');
  return async (request, response) => {
    const admission = admit(request);
    if ('rejection' in admission) { response.writeHead(admission.rejection); response.end(); return; }
    const match = /^\/agentkit\/models\/([^/]+)\/v1\/(responses|chat\/completions)$/.exec(new URL(request.url, 'http://localhost').pathname);
    if (request.method !== 'POST' || !match || (upstreamApi === 'responses' && match[2] !== 'responses')) { response.writeHead(404); response.end(); return; }
    const controller = new AbortController();
    const disconnect = () => { if (!response.writableEnded) controller.abort(); };
    response.on('close', disconnect);
    let deadline;
    try {
      // The profile is resolved before the body is read so its request budget
      // bounds the idle deadline itself: a slow gateway must not outlive the
      // timeout the operator configured for this model.
      const profile = await models.profile(decodeURIComponent(match[1]));
      deadline = createModelIdleDeadline({ signal: controller.signal, timeoutMs: profile.requestTimeoutMs ?? idleTimeoutMs });
      const chunks = []; let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 16 * 1024 * 1024) throw Object.assign(new Error('模型请求超出大小限制'), { status: 413, code: 'REQUEST_TOO_LARGE' });
        chunks.push(chunk);
        deadline.touch();
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const nativeResponses = upstreamApi === 'responses';
      const convert = match[2] === 'responses' && !nativeResponses;
      if (convert && input.previous_response_id) throw Object.assign(new Error('请传入完整对话历史；此兼容端点不保存远端 Response ID'), { status: 400, code: 'STATELESS_INPUT_REQUIRED' });
      const toolContext = convert && codexTools ? prepareCodexProxyRequest(input) : undefined;
      const body = convert ? responsesToChat(toolContext?.request || input) : input;
      // The instructions role has two spellings and only one of them is
      // portable: OpenAI accepts `developer`, most OpenAI-compatible gateways
      // implement `system` alone and answer `400 Invalid request: role
      // 'developer' is not allowed` (Kspmas). A rename loses nothing, so it
      // happens before the request leaves the proxy — the native Responses
      // wire forwards items verbatim and would otherwise carry `developer`
      // straight to the gateway.
      normalizeDeveloperRole(body);
      // History is built upstream of this proxy (DSH's Responses projection,
      // Codex's own replay, the Responses-to-Chat conversion here), and each of
      // them can leave an assistant turn with neither text nor tool calls. No
      // gateway accepts that shape — Kspmas answers `400 Invalid assistant
      // message: content or tool_calls must be set` — and the turn carries no
      // information, so drop it rather than burn a round-trip on a retry that
      // cannot repair it.
      normalizeEmptyAssistantTurns(body);
      // The same history can lose an assistant call while keeping its tool
      // receipt, which a gateway refuses with `400 Messages with role 'tool'
      // must be a response to a preceding message with 'tool_calls'`. A
      // receipt without its call cannot be interpreted, so the orphan never
      // leaves the proxy either.
      dropOrphanToolReceipts(body);
      // Reasoning items are forwarded exactly as Codex emitted them: the same
      // request works when Codex reaches this gateway directly, so the proxy
      // must not rewrite the item shape up front. A provider that refuses the
      // optional `content` field is handled by the 400 fallback below, which
      // retries once with the field removed.
      // A route represents exactly one configured model. Callers choose a
      // different profile route to use a different model/credential pair.
      // An unbound native Codex provider may let Codex select its default model.
      if (!nativeResponses || profile.modelName) body.model = profile.modelName;
      // A configured output budget is the operator's declaration, named per
      // protocol. It replaces the client's own value (Codex derives one from its
      // config) only when the profile sets it, so an unconfigured profile keeps
      // forwarding exactly what the client asked for.
      if (profile.maxOutputTokens) {
        if (nativeResponses) body.max_output_tokens = profile.maxOutputTokens;
        else body.max_tokens = profile.maxOutputTokens;
      }
      if (body.stream && !nativeResponses) body.stream_options = { ...body.stream_options, include_usage: true };
      let serialized = JSON.stringify(body);
      if (onRequestMetrics) {
        const chars = value => JSON.stringify(value).length;
        const items = nativeResponses ? body.input : body.messages;
        const messages = Array.isArray(items) ? items : typeof items === 'string' ? [{ role: 'user', content: items }] : [];
        onRequestMetrics({ requestId: randomUUID(), protocol: upstreamApi, model: body.model,
          requestChars: serialized.length, requestBytes: Buffer.byteLength(serialized),
          toolCount: body.tools?.length || 0, toolsChars: body.tools ? chars(body.tools) : 0, messagesChars: chars(messages),
          instructionsChars: (body.instructions ? chars(body.instructions) : 0) + messages.filter(message => ['system', 'developer'].includes(message.role)).reduce((sum, message) => sum + chars(message), 0),
          conversationChars: messages.filter(message => !['system', 'developer'].includes(message.role)).reduce((sum, message) => sum + chars(message), 0) });
      }
      const upstreamUrl = `${profile.baseUrl}/${nativeResponses ? 'responses' : 'chat/completions'}`;
      const headers = upstreamRequestHeaders(profile);
      const requestUpstream = serializedBody => fetchImpl(upstreamUrl, {
        method: 'POST', headers,
        body: serializedBody, signal: deadline.signal, redirect: 'error',
      });
      let upstream = await requestUpstream(serialized);
      deadline.touch();
      let upstreamBodyConsumed = false;
      // Some OpenAI-compatible gateways answer with a 400 that names the
      // reasoning option instead of ignoring an unsupported level. Downgrade
      // once to the provider's highest legal value rather than failing a turn
      // whose content would otherwise succeed. Only one retry, only when the
      // body actually carried a different value.
      if (upstream.status === 400) {
        const detail = (await upstream.text().catch(() => '')).slice(0, 4096);
        upstreamBodyConsumed = true;
        const fallback = studioReasoningFallbackWire(profile);
        const replaced = isReasoningEffortRejection(upstream.status, detail) ? applyReasoningFallback(body, fallback) : undefined;
        if (replaced !== undefined) {
          // Observability must never turn a recoverable 400 into a turn
          // failure, so a misbehaving hook is ignored.
          try {
            onReasoningFallback({ provider: String(profile.provider || ''), model: String(profile.modelName || body.model || ''),
              from: replaced, to: fallback, status: upstream.status });
          } catch { /* logging is best-effort */ }
          serialized = JSON.stringify(body);
          upstream = await requestUpstream(serialized);
          deadline.touch();
          upstreamBodyConsumed = false;
        } else if (nativeResponses && isReasoningReplayRejection(upstream.status, detail)) {
          // Codex reaches this gateway directly without any rewrite, so
          // reasoning items are forwarded unchanged. Only a provider that
          // actually refuses the replayed turn justifies a repair, and then it
          // is repaired in one pass: a turn carrying nothing but reasoning is
          // illegal on this wire (magpie → 星流 prefill answers the
          // assistant-message rule for it), so its reasoning items are dropped;
          // a turn that carries text or a call keeps them, minus the optional
          // `content` field when the provider rejects that field.
          if (normalizeReasoningContent(body) + dropCarrierlessReasoningTurns(body) > 0) {
            serialized = JSON.stringify(body);
            upstream = await requestUpstream(serialized);
            deadline.touch();
            upstreamBodyConsumed = false;
          }
        }
      }
      if (!upstream.ok) {
        // A rejected request must stay diagnosable. The provider body can carry
        // the reason (`context_length_exceeded`, `invalid_request_error`, an
        // unsupported parameter), but it can also echo prompts and credentials,
        // so only bounded, credential-free identifiers leave this frame.
        const detail = upstreamBodyConsumed ? '' : (await upstream.text().catch(() => '')).slice(0, 4096);
        if (!upstreamBodyConsumed) upstreamBodyConsumed = true;
        throw Object.assign(new Error(`模型服务返回 ${upstream.status}`), {
          status: upstream.status, code: 'MODEL_UPSTREAM_ERROR',
          details: { status: upstream.status, ...upstreamErrorIdentifiers(detail) },
        });
      }
      if (!body.stream) {
        const value = await upstream.json();
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify(convert ? chatToResponses(value, { toolContext }) : value));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      const write = async data => { if (data && !response.write(data)) await once(response, 'drain', { signal: deadline.signal }); };
      if (!convert) { for await (const bytes of upstream.body) { deadline.touch(); await write(bytes); } }
      else {
        const transformer = createResponsesStreamTransformer({ model: profile.modelName, toolContext });
        let done = false;
        for await (const chunk of readSse(upstream.body, { onChunk: deadline.touch, onDone: () => { done = true; } })) await write(transformer.handle(chunk));
        // Some compatible gateways omit `choices[*].finish_reason` on the
        // final usage-only chunk and signal completion with [DONE]. The SSE
        // parser already consumed that sentinel, so the transformer closes
        // the response with the safe default `stop` in that case.
        if (!done && !transformer.state.finishReason) throw Object.assign(new Error('模型流未返回完成标记，连接已断开'), { code: 'UPSTREAM_STREAM_TRUNCATED' });
        await write(transformer.finish());
      }
      response.end();
    } catch (error) {
      if (response.destroyed) return;
      // Never forward upstream bodies/errors that could contain credentials.
      const safeCodes = new Set(['REQUEST_TOO_LARGE', 'STATELESS_INPUT_REQUIRED', 'UNSUPPORTED_TOOL_TYPE', 'CODEX_TOOL_CONVERSION_FAILED', 'UPSTREAM_STREAM_TRUNCATED', 'UPSTREAM_STREAM_ERROR', 'MODEL_UPSTREAM_ERROR']);
      const code = safeCodes.has(error.code) ? error.code : error instanceof SyntaxError ? 'INVALID_JSON' : 'MODEL_PROXY_FAILED';
      const value = { error: { code, message: code === 'MODEL_PROXY_FAILED' ? '模型连接失败或超时' : code === 'INVALID_JSON' ? '模型请求或响应不是有效 JSON' : error.message } };
      if (!response.headersSent) {
        response.writeHead(error.status || (code === 'INVALID_JSON' || code === 'UNSUPPORTED_TOOL_TYPE' ? 400 : 502), { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(value));
      } else response.end(`event: error\ndata: ${JSON.stringify({ type: 'error', ...value.error })}\n\n`);
    } finally { deadline?.dispose(); response.off('close', disconnect); }
  };
}
