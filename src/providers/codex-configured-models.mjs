/** Host-only resolution of Studio model selections for Codex's Responses provider. */
import { dshModelRoute, dshModelSelection } from '../agent-preset-admission.mjs';
import { listStudioResources } from '../resource-catalog.mjs';
import { codexModelSelection } from './codex-models.mjs';
import { studioReasoning } from '../model-reasoning.mjs';

const failure = (code, message) => Object.assign(new Error(message), { code });

export async function resolveConfiguredCodexModel({ provider, model }, models) {
  const settings = await models.settings();
  const profiles = (settings.modelProfiles || []).filter(item => item.enabled !== false && dshModelRoute(item) === provider);
  if (profiles.length !== 1) throw failure('CODEX_MODEL_PROVIDER_UNAVAILABLE', '所选模型提供商不存在、已停用或路由重复，请检查模型设置。');
  // Resolve by the selected route, not the global default: equal model names
  // on two gateways must never redirect a credential to the other gateway.
  const profile = await models.profile(profiles[0].id);
  if (model !== profile.modelName && !(await models.catalog(profile.id)).items.some(item => item.id === model)) {
    throw failure('CODEX_MODEL_UNAVAILABLE', '所选模型不在此提供商的目录中，请重新选择模型。');
  }
  const reasoning = studioReasoning(profile);
  return { model,
    ...(reasoning ? { reasoningEfforts: reasoning.efforts } : {}),
    modelProvider: { baseUrl: profile.baseUrl, apiKey: profile.apiKey, ...(profile.codexApi === 'chat-completions' ? { api: 'chat-completions' } : {}) } };
}

export async function selectCodexAgentModel(agent, { models, catalog }) {
  const settings = { values: await models.settings() };
  const configured = dshModelSelection(agent, settings);
  if (configured) return configured;
  const bindings = agent?.spec?.bindings || {}, first = bindings.modelProfileIds?.[0];
  const id = bindings.modelProfileId || (typeof first === 'string' ? first : first?.resourceId);
  let native, nativeError;
  try { native = await catalog.list(); } catch (error) { nativeError = error; }
  if (native && (!id || native.items.some(item => item.resourceId === id))) return codexModelSelection(agent, native);
  if (id) {
    const profile = await models.profile(id);
    const selection = dshModelSelection(agent, settings, { resolvedProfile: profile });
    if (selection) return selection;
  }
  throw nativeError || failure('CODEX_MODEL_UNAVAILABLE', '绑定模型不可用，请在 Agent 编辑页重新选择模型。');
}

export async function listCodexAgentModels({ models, catalog }) {
  const [gateway, native] = await Promise.allSettled([
    listStudioResources({ query: { kind: 'model', limit: 200 }, models }), catalog.list(),
  ]);
  if (gateway.status === 'rejected' && native.status === 'rejected') throw gateway.reason;
  const configured = gateway.status === 'fulfilled' ? gateway.value : { items: [] };
  const codex = native.status === 'fulfilled' ? native.value : { items: [] };
  const items = [...new Map([...codex.items, ...configured.items].map(item => [item.resourceId, item])).values()];
  return { items, defaultModel: codex.defaultModel || configured.defaultModel, source: 'codex-and-configured-models',
    warnings: [...(configured.warnings || []), ...(native.status === 'rejected' ? [{ code: native.reason?.code || 'CODEX_CATALOG_UNAVAILABLE', message: 'Codex 原生模型目录不可用，仍可选择已配置的网关模型。' }] : [])] };
}
