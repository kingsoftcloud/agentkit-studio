/** Publish the imported models through DSH's public settings service before headless admission. */
import { isDeepStrictEqual } from 'node:util';
import { dshModelSelection } from './agent-preset-admission.mjs';
import { portableError } from './portable-resources.mjs';
import { studioReasoning } from './model-reasoning.mjs';

export async function syncPortableModelProfiles({ settings, profiles }) {
  if (!settings?.describe || !settings?.mutate) throw portableError('PORTABLE_MODEL_BRIDGE_UNAVAILABLE', '目标 Host 缺少 DSH Settings 服务');
  const namespace = settings.describe({ redactSecrets: true }).find(item => item.ns === 'llm-pi-ai');
  if (!namespace) throw portableError('PORTABLE_MODEL_BRIDGE_UNAVAILABLE', '目标 Profile 未加载 DSH 模型提供商');
  const routes = new Set(), operations = [];
  for (const profile of profiles) {
    const route = dshModelSelection({ spec: { bindings: { modelProfileId: profile.id } } }, { values: { modelProfiles: profiles } })?.provider;
    if (!route || routes.has(route)) throw portableError('PORTABLE_MODEL_ROUTE_COLLISION', '模型配置生成了重复的 DSH 路由，请修改模型资源 ID');
    routes.add(route);
    const reasoning = studioReasoning(profile);
    // The imported profile is the only model on this route, so its declared
    // levels also describe every model entry the route exposes.
    const value = { displayName: `${profile.provider} · ${profile.modelName}`, api: 'openai-completions', apiKeyEnv: profile.credentialName,
      baseURL: profile.baseUrl,
      ...(reasoning ? { reasoning: reasoning.defaultEffort } : {}),
      models: [{ id: profile.modelName, name: profile.modelName, contextWindow: 262144, maxTokens: 32768, input: profile.input || ['text'],
        ...(reasoning ? { reasoningEfforts: reasoning.efforts } : {}) }] };
    if (!isDeepStrictEqual(namespace.value?.providers?.[route], value)) operations.push({ op: 'set', path: ['providers', route], value });
  }
  if (operations.length) await settings.mutate('llm-pi-ai', operations, namespace.revision);
  return { providerCount: routes.size };
}
