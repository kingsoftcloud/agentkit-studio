/** Turn-scoped, authenticated loopback transport for explicitly configured model APIs. */
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createModelProxyHandler } from '../model-proxy-handler.mjs';

export async function createCodexModelProxy({ profile, fetchImpl, onRequestMetrics, onReasoningFallback, idleTimeoutMs }) {
  return createAuthenticatedModelProxy({
    fetchImpl, onRequestMetrics, onReasoningFallback, idleTimeoutMs, codexTools: true,
    upstreamApi: profile.protocol === 'anthropic-messages' ? 'anthropic-messages' : profile.api || 'chat-completions',
    profileFor: async id => {
      if (id !== 'bound') throw Object.assign(new Error('模型路由不存在'), { code: 'MODEL_NOT_FOUND', status: 404 });
      return profile;
    },
  });
}

export async function createAuthenticatedModelProxy({ profileFor, ...options }) {
  const token = randomBytes(32).toString('hex');
  const authorization = Buffer.from(`Bearer ${token}`);
  const handler = createModelProxyHandler({
    ...options,
    models: { profile: profileFor },
    admit: request => {
      const value = Buffer.from(String(request.headers.authorization || ''));
      return !request.headers.origin && value.length === authorization.length && timingSafeEqual(value, authorization) ? {} : { rejection: 401 };
    },
  });
  const server = createServer((request, response) => { void handler(request, response).catch(() => { response.destroy(); }); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  server.unref();
  const origin = 'http://127.0.0.1:' + server.address().port;
  const modelUrl = id => `${origin}/agentkit/models/${encodeURIComponent(id)}/v1`;
  let closed = false;
  return {
    baseUrl: modelUrl('bound'), modelUrl,
    apiKey: token,
    async close() {
      if (closed) return;
      closed = true;
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    },
  };
}
