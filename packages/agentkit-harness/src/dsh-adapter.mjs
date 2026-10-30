/**
 * Adapt an injected model to DSH's LlmAdapter contract.
 *
 * The model must already emit DSH StreamChunk values. This adapter performs
 * no Studio event conversion and therefore remains usable by any DSH host.
 */
export function createDshHarnessAdapter({ model, provider = 'agentkit-harness', modelName = 'agentkit-harness' } = {}) {
  if (!model || typeof model.stream !== 'function') throw new TypeError('Harness adapter requires model.stream');
  if (typeof provider !== 'string' || !provider.trim()) throw new TypeError('Harness adapter provider is required');
  return {
    providerInfo(route) {
      if (route !== provider) throw new Error(`Harness adapter does not own provider ${route}`);
      return { id: route, name: 'Star Harness' };
    },
    providerRetryPolicy() { return undefined; },
    imageRequestPricing() { return undefined; },
    async listModels(route) {
      if (route !== provider) return [];
      return [{ provider: route, id: modelName, name: modelName }];
    },
    async resolveModel(route, modelId) {
      if (route !== provider) throw new Error(`Harness adapter does not own provider ${route}`);
      return { provider: route, id: modelId, name: modelId };
    },
    async prepareCall(route, modelId, signal) {
      const resolved = await this.resolveModel(route, modelId, signal);
      return { model: resolved, stream: options => this.stream(options) };
    },
    stream(options = {}) {
      if (options.provider !== provider) throw new Error(`Harness adapter does not own provider ${options.provider}`);
      if (!Array.isArray(options.messages)) throw new TypeError('DSH GenerateOptions.messages is required');
      return model.stream(options);
    },
  };
}
