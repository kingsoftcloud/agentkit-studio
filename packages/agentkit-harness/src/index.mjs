/** DSH plugin entry point for the independent AgentKit Harness package. */
import { AgentKitHarnessService } from './core.mjs';
import { createDshHarnessAdapter } from './dsh-adapter.mjs';

export const name = 'agentkit-harness';
export const inject = ['agents', 'sessions', 'llm'];

/**
 * Mount the product facade as `ctx.agentkitHarness`.
 *
 * `config.model` is optional. When present, the plugin registers it through
 * DSH's official `ctx.llm.registerAdapter` seam and the DSH fiber owns the
 * registration lifetime.
 */
export function apply(ctx, config = {}) {
  const service = new AgentKitHarnessService(ctx, config);
  ctx.provide('agentkitHarness', service);
  if (config.model !== undefined) {
    if (!ctx.llm || typeof ctx.llm.registerAdapter !== 'function') {
      throw new TypeError('agentkit-harness model configuration requires the DSH LlmRuntime plugin');
    }
    const provider = config.provider || 'agentkit-harness';
    const adapter = config.adapter || createDshHarnessAdapter({ model: config.model, provider, modelName: config.modelName });
    ctx.llm.registerAdapter([provider], adapter);
  }
}

export default { name, inject, apply };

export * from './core.mjs';
export * from './contract.mjs';
export * from './dsh-adapter.mjs';
