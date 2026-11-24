import { AppServerRuntimeError, createAppServerRuntime } from './app-server-runtime.mjs';
import { resolveCodexCommand } from './codex-command.mjs';
import { createCodexModelProxy } from './codex-model-proxy.mjs';

export class CodexRuntimeError extends AppServerRuntimeError {}

export function createCodexRuntime(options = {}) {
  const baseEnv = { ...(options.inheritEnv === false ? {} : process.env), ...(options.env || {}) };
  const command = resolveCodexCommand({ executable: options.executable, env: baseEnv });
  const model = String(options.model || baseEnv.AGENTKIT_CODEX_MODEL || '').trim() || undefined;
  const streamIdleTimeoutMs = Math.max(1_000, Number(options.streamIdleTimeoutMs ?? baseEnv.AGENTKIT_CODEX_STREAM_IDLE_TIMEOUT_MS) || 900_000);
  // The loopback model proxy must never cut a silent-but-alive upstream before
  // Codex's own idle budget decides the round; it stays slightly larger unless
  // a deployment deliberately sets its own value.
  const modelIdleTimeoutMs = Math.max(streamIdleTimeoutMs,
    Number(options.modelIdleTimeoutMs ?? baseEnv.AGENTKIT_CODEX_MODEL_IDLE_TIMEOUT_MS) || streamIdleTimeoutMs + 60_000);

  const runtime = createAppServerRuntime(options, { id: 'codex', label: 'Codex', ErrorClass: CodexRuntimeError, command });
  return {
    ...runtime,
    async *stream(input = {}) {
      if (!['chat-completions', 'responses'].includes(input.modelProvider?.api)) { yield* runtime.stream(input); return; }
      if (input.signal?.aborted) throw new CodexRuntimeError('CODEX_CANCELED', 'Codex 运行已取消');
      const metrics = [];
      const proxy = await createCodexModelProxy({ profile: { ...input.modelProvider, modelName: input.model || model }, onRequestMetrics: value => metrics.push({ type: 'request-metrics', metrics: value }), idleTimeoutMs: modelIdleTimeoutMs });
      try {
        for await (const chunk of runtime.stream({ ...input, modelProvider: { api: input.modelProvider.api, baseUrl: proxy.baseUrl, apiKey: proxy.apiKey } })) {
          while (metrics.length) yield metrics.shift();
          yield chunk;
        }
      } finally {
        await proxy.close();
        while (metrics.length) yield metrics.shift();
      }
    },
  };
}
