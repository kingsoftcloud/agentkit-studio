import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

async function loadPi(hostAnchor) {
  const entry = createRequire(hostAnchor ?? import.meta.url).resolve('@deepseek-ai/dsh-llm-pi-ai');
  const resolve = specifier => pathToFileURL(createRequire(entry).resolve(specifier, { conditions: new Set(['import', 'node']) })).href;
  const [{ PiAiAdapter }, { InMemoryCredentialStore, defaultProviderAuthContext }, { openAIResponsesApi }] = await Promise.all([
    import(pathToFileURL(entry).href),
    import(resolve('@earendil-works/pi-ai')),
    import(resolve('@earendil-works/pi-ai/api/openai-responses.lazy')),
  ]);
  return { PiAiAdapter, openAIResponsesApi, auth: { credentials: new InMemoryCredentialStore(), authContext: defaultProviderAuthContext } };
}

export function createKsxcDesktopModelAdapter({ LlmAdapter, modelAccess, hostAnchor }) {
  let pi;
  const describe = ({ contextWindow, ...model }) => ({ ...model, inputModalities: ['text'],
    ...(contextWindow ? { context: { contextWindow } } : {}) });
  return new class extends LlmAdapter {
    providerInfo() { return { id: 'ksxc', name: 'KSXC' }; }
    async listModels() { return (await modelAccess.list()).map(describe); }
    async resolveModel(_provider, model, signal) { return describe(await modelAccess.model(model, signal)); }
    async *stream(options) {
      const [{ PiAiAdapter, openAIResponsesApi, auth }, profile] = await Promise.all([
        pi ??= loadPi(hostAnchor).catch(error => { pi = undefined; throw error; }),
        modelAccess.profile(options.model, options.signal),
      ]);
      const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      const descriptor = { id: options.model, provider: 'ksxc', name: profile.label, api: profile.protocol, baseUrl: profile.baseUrl, input: ['text'],
        reasoning: false, contextWindow: profile.contextWindow ?? 128_000, maxTokens: 8192, cost };
      const piProvider = { ...openAIResponsesApi(), id: 'ksxc', name: 'KSXC', baseUrl: profile.baseUrl,
        getModels: () => [descriptor],
        auth: { apiKey: { name: 'KSXC',
          resolve: async ({ credential }) => ({ auth: { apiKey: credential?.key }, source: 'KSXC' }) } } };
      const profiles = new Map([['ksxc', {
        provider: 'ksxc', displayName: 'KSXC', piProvider, streamIdleTimeoutMs: 900_000,
        modelErrors: new Map(), defaultReasoningEfforts: new Map(), configuredMaxTokens: new Map(),
      }]]);
      const adapter = new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => profile.apiKey, auth });
      yield* adapter.stream(options);
    }
  }();
}
