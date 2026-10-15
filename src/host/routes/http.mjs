/** DSH Connection owns admission; these adapters preserve the HTTP/SSE surface. */
const CONTROL_CHANNEL = '/agentkit';
export async function registerControlPlaneRoutes(ctx, { models, dispatch, getLegacyLocalConversationHandler, serverClientPromise }) {
  // HostConnectionService's dedicated-RPC helper owns its registration fiber;
  // the plugin uses the same public Connection admission and WebServer route
  // boundary directly so this optional control plane can coexist with DSH's
  // single shared /api Typert interceptor.
  const { createModelProxyHandler } = await import('../../model-proxy-handler.mjs');
  ctx.inject(['connection', 'webServer'], (webCtx) => {
    const lifetime = new AbortController();
    webCtx.effect(() => () => lifetime.abort(), 'agentkit-studio: HTTP request lifetime');
    const modelRoute = webCtx.webServer.register({ kind: 'prefix', path: '/agentkit/models/', handler: createModelProxyHandler({ models, admit: request => webCtx.connection.admit(request) }) });
    webCtx.effect(() => modelRoute, 'agentkit-studio: model compatibility route');
    const registration = webCtx.webServer.register({
      kind: 'prefix',
      path: CONTROL_CHANNEL,
      handler: async (request, response) => {
        const admission = webCtx.connection.admit(request);
        if ('rejection' in admission) {
          response.writeHead(admission.rejection);
          response.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden');
          return;
        }
        if (request.method !== 'POST') {
          response.writeHead(404);
          response.end('not found');
          return;
        }
        const controller = new AbortController();
        const signal = AbortSignal.any([lifetime.signal, controller.signal]);
        // IncomingMessage EOF only completes the upload. The response remains
        // owned until its consumer disconnects or the registration is disposed.
        const disconnect = () => { if (!response.writableEnded) controller.abort(); };
        response.on?.('close', disconnect);
        const chunks = [];
        let size = 0;
        try {
          for await (const chunk of request) {
            size += chunk.length;
            if (size > 1024 * 1024) {
              response.writeHead(413);
              response.end('request too large');
              return;
            }
            chunks.push(chunk);
          }
          const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const endpoint = String(message?.method || '');
          signal.throwIfAborted();
          const result = await dispatch(endpoint, message?.payload, signal);
          if (response.destroyed) return;
          response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          response.end(JSON.stringify({ type: 'server-response', rpcId: String(message?.rpcId || ''), result }));
        } catch (error) {
          if (response.destroyed) return;
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ type: 'server-response', rpcId: '', result: {
            ok: false,
            error: { code: 'agentkit/bad-request', message: error instanceof Error ? error.message : String(error), details: {} },
          } }));
        } finally {
          response.off?.('close', disconnect);
        }
      },
    });
    const localRoute = webCtx.webServer.register({
      kind: 'prefix',
      path: '/agentkit/local-conversation',
      handler: (request, response) => {
        const admission = webCtx.connection.admit(request);
        if ('rejection' in admission) { response.writeHead(admission.rejection); response.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden'); return; }
        const controller = new AbortController();
        const signal = AbortSignal.any([lifetime.signal, controller.signal]);
        const disconnect = () => { if (!response.writableEnded) controller.abort(); };
        response.on?.('close', disconnect);
        void getLegacyLocalConversationHandler().then(handler => {
          signal.throwIfAborted();
          return handler(request, response, { signal });
        }).catch(error => {
          console.error('[local-runtime] handler failed:', error?.stack || error);
          if (response.destroyed) return;
          if (!response.headersSent) response.writeHead(500);
          response.end(JSON.stringify({ error: { message: String(error?.message || error).slice(0, 200) } }));
        }).finally(() => response.off?.('close', disconnect));
      },
    });
    const cloudConversationRoute = webCtx.webServer.register({
      kind: 'prefix',
      path: '/agentkit/cloud-conversation',
      handler: async (request, response) => {
        const admission = webCtx.connection.admit(request);
        if ('rejection' in admission) { response.writeHead(admission.rejection); response.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden'); return; }
        if (request.method !== 'POST') { response.writeHead(404); response.end('not found'); return; }
        const controller = new AbortController();
        const signal = AbortSignal.any([lifetime.signal, controller.signal]);
        const disconnect = () => { if (!response.writableEnded) controller.abort(); };
        response.on?.('close', disconnect);
        const chunks = []; let size = 0;
        try {
          for await (const chunk of request) {
            size += chunk.length;
            if (size > 1024 * 1024) { response.writeHead(413); response.end('request too large'); return; }
            chunks.push(chunk);
          }
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const agentId = String(body?.agentId || '').trim();
          const sessionId = String(body?.sessionId || '').trim();
          const input = body?.input;
          const text = Array.isArray(input?.parts) ? input.parts.filter(part => part?.kind === 'text').map(part => part.text || '').join('') : String(input?.input || input || '');
          if (!agentId || !sessionId || !text.trim()) throw Object.assign(new Error('AgentId、SessionId 和文本输入不能为空'), { code: 'INVALID_CONVERSATION_INPUT' });
          const client = await serverClientPromise;
          signal.throwIfAborted();
          const upstream = await client.streamAction('RunAgent', {
            AgentId: agentId, SessionId: sessionId, Messages: [{ role: 'user', content: text }],
            Stream: true, ApiFormat: 'responses', InvocationId: String(input?.inputId || body?.idempotencyKey || ''),
          }, { signal });
          response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
          for await (const chunk of upstream.body) response.write(chunk);
          response.end();
        } catch (error) {
          if (response.destroyed) return;
          if (!response.headersSent) response.writeHead(error?.status || 502, { 'content-type': 'application/json' });
          if (!response.writableEnded) response.end(JSON.stringify({ error: { code: error?.code || 'CLOUD_CONVERSATION_FAILED', message: error instanceof Error ? error.message : String(error) } }));
        } finally {
          response.off?.('close', disconnect);
        }
      },
    });
    webCtx.effect(() => localRoute, 'agentkit-studio: local conversation route');
    webCtx.effect(() => cloudConversationRoute, 'agentkit-studio: cloud conversation route');
    webCtx.effect(() => registration, 'agentkit-studio: control-plane route');
  });
}
