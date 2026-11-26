/**
 * Deep verification that a Studio model profile, once published to DSH, is
 * actually understood by DSH's own pi-ai adapter — not just well-formed by
 * Studio's own lights.
 *
 * It runs Studio's `applyProfiles` to produce the DSH provider config, then
 * feeds that config to DSH's real `resolveRouteModels` and prints the
 * materialized model (thinking-level map, capacities, modalities).
 *
 * Needs a DSH checkout with dependencies installed. Run with tsx:
 *   DSH_LLM_PI_AI=/path/to/packages/llm/llm-pi-ai tsx scripts/verify-studio-dsh-config.mjs
 * Defaults DSH_LLM_PI_AI to ../deepseek-harness/packages/llm/llm-pi-ai.
 */
import { createModelBridge, DSH_MODEL_SETTINGS_NS, DSH_DEFAULT_MODEL_SETTINGS_NS } from '../src/client/dsh/model-bridge.mjs';

const piAi = process.env.DSH_LLM_PI_AI || new URL('../../deepseek-harness/packages/llm/llm-pi-ai/', import.meta.url).pathname;
const { resolveRouteModels } = await import(`${piAi}/src/catalog.ts`);

const profile = { id: 'p1', provider: 'custom', modelName: 'glm-5.3', baseUrl: 'http://kspmas.ksyun.com/v1', connectionName: '星流', credentialName: 'KEY', enabled: true, default: true, input: ['text'], reasoningLevels: ['low', 'high', 'max'], reasoningEfforts: true, defaultReasoningEffort: 'high' };
const namespaces = [{ ns: DSH_MODEL_SETTINGS_NS, revision: 1, value: { providers: {} } }, { ns: DSH_DEFAULT_MODEL_SETTINGS_NS, revision: 1, value: {} }];
const writes = [];
const bridge = createModelBridge({ hostRemote: { modelCatalog: async () => ({ items: [{ id: 'glm-5.3', input: ['text'] }] }) } }).createDshModelBridge({ remote: { settings: { describe: async () => ({ ok: true, value: { namespaces } }), mutate: async (ns, ops) => { writes.push({ ns, ops }); return { ok: true }; } }, credentials: { set: () => {} } } });
await bridge.applyProfiles({ profiles: [profile] });
const op = writes[0].ops.find(o => o.op === 'set');
const route = op.path[1];
const providerConfig = op.value;
console.log('=== Studio 写出的 DSH provider 配置 ===');
console.log('route:', route, '| displayName:', providerConfig.displayName, '| api:', providerConfig.api);
console.log('models:', JSON.stringify(providerConfig.models));
console.log('compat:', JSON.stringify(providerConfig.compat));

console.log('\n=== DSH resolveRouteModels 识别结果 ===');
const resolved = resolveRouteModels({ provider: route, models: providerConfig.models, api: providerConfig.api, baseURL: providerConfig.baseURL, compat: providerConfig.compat }, 'strict');
for (const m of resolved.models) {
  console.log('model', m.id, '| reasoning:', m.reasoning, '| thinkingLevelMap:', JSON.stringify(m.thinkingLevelMap), '| contextWindow:', m.contextWindow, '| maxTokens:', m.maxTokens, '| input:', JSON.stringify(m.input));
}
const model = resolved.models.find(m => m.id === 'glm-5.3');
if (!model) throw new Error('DSH did not materialize glm-5.3');
if (model.thinkingLevelMap?.high !== 'high' || model.thinkingLevelMap?.max !== 'max' || model.thinkingLevelMap?.low !== 'low') {
  throw new Error(`thinking level map mismatch: ${JSON.stringify(model.thinkingLevelMap)}`);
}
if (model.contextWindow !== 1000000) throw new Error(`context window should come from the catalog, got ${model.contextWindow}`);
if (providerConfig.displayName !== '星流 · glm-5.3') throw new Error(`display name should use the connection name, got ${providerConfig.displayName}`);
console.log('\nOK: Studio 配置被 DSH 正确识别（显示名、目录容量、low/high/max 档位映射）。');
