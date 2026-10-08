/** Authenticated model routes hosted by the public DSH WebServer service. */
import { once } from 'node:events';
import { responsesToChat, chatToResponses, createResponsesStreamTransformer } from './model-proxy.mjs';
import { readSse } from './sse.mjs';
import { prepareCodexProxyRequest } from './codex-proxy-tools.mjs';

export function createModelProxyHandler({ models, admit, fetchImpl = fetch, codexTools = false }) {
  return async (request, response) => {
    const admission = admit(request);
    if ('rejection' in admission) { response.writeHead(admission.rejection); response.end(); return; }
    const match = /^\/agentkit\/models\/([^/]+)\/v1\/(responses|chat\/completions)$/.exec(new URL(request.url, 'http://localhost').pathname);
    if (request.method !== 'POST' || !match) { response.writeHead(404); response.end(); return; }
    const controller = new AbortController();
    const disconnect = () => { if (!response.writableEnded) controller.abort(); };
    response.on('close', disconnect);
    const timer = setTimeout(() => controller.abort(), 120000);
    try {
      const chunks = []; let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 16 * 1024 * 1024) throw Object.assign(new Error('模型请求超出大小限制'), { status: 413, code: 'REQUEST_TOO_LARGE' });
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const profile = await models.profile(decodeURIComponent(match[1]));
      const convert = match[2] === 'responses';
      if (convert && input.previous_response_id) throw Object.assign(new Error('请传入完整对话历史；此兼容端点不保存远端 Response ID'), { status: 400, code: 'STATELESS_INPUT_REQUIRED' });
      const toolContext = convert && codexTools ? prepareCodexProxyRequest(input) : undefined;
      const body = convert ? responsesToChat(toolContext?.request || input) : input;
      // A route represents exactly one configured model. Callers choose a
      // different profile route to use a different model/credential pair.
      body.model = profile.modelName;
      if (body.stream) body.stream_options = { ...body.stream_options, include_usage: true };
      const upstream = await fetchImpl(`${profile.baseUrl}/chat/completions`, {
        method: 'POST', headers: { Authorization: `Bearer ${profile.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: controller.signal, redirect: 'error',
      });
      if (!upstream.ok) {
        await upstream.body?.cancel();
        throw Object.assign(new Error(`模型服务返回 ${upstream.status}`), { status: upstream.status, code: 'MODEL_UPSTREAM_ERROR' });
      }
      if (!body.stream) {
        const value = await upstream.json();
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify(convert ? chatToResponses(value, { toolContext }) : value));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      const write = async data => { if (data && !response.write(data)) await once(response, 'drain', { signal: controller.signal }); };
      if (!convert) { for await (const bytes of upstream.body) await write(bytes); }
      else {
        const transformer = createResponsesStreamTransformer({ model: profile.modelName, toolContext });
        let done = false;
        for await (const chunk of readSse(upstream.body, { onDone: () => { done = true; } })) await write(transformer.handle(chunk));
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
    } finally { clearTimeout(timer); response.off('close', disconnect); }
  };
}
