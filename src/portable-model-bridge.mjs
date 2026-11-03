/** Publish the imported models through DSH's public settings service before headless admission. */
import { isDeepStrictEqual } from 'node:util';
import { dshModelSelection } from './agent-preset-admission.mjs';
import { portableError } from './portable-resources.mjs';
import { admitModelCapabilities } from '@kingsoftcloud/agentkit-harness-core/model-capabilities';
import { studioReasoning } from './model-reasoning.mjs';

const OPERATING_MAX_OUTPUT_TOKENS = 8192;

/** A managed declaration has no contextWindow, so the gateway catalog is the
 * only authority for the window; the output budget stays the historical
 * operating default unless the profile configures its own. */
async function profileCapabilities(profile, resolve) {
  if (typeof resolve !== 'function') return admitModelCapabilities(profile);
  try {
    const capabilities = await resolve(profile);
    if (capabilities) return capabilities;
  } catch { /* keep the admitted default when the gateway catalog is unreachable */ }
  return admitModelCapabilities(profile);
}

export async function syncPortableModelProfiles({ settings, profiles, capabilities: resolveCapabilities }) {
  if (!settings?.describe || !settings?.mutate) throw portableError('PORTABLE_MODEL_BRIDGE_UNAVAILABLE', '目标 Host 缺少 DSH Settings 服务');
  const namespace = settings.describe({ redactSecrets: true }).find(item => item.ns === 'llm-pi-ai');
  if (!namespace) throw portableError('PORTABLE_MODEL_BRIDGE_UNAVAILABLE', '目标 Profile 未加载 DSH 模型提供商');
  const routes = new Set(), operations = [];
  for (const profile of profiles) {
    const route = dshModelSelection({ spec: { bindings: { modelProfileId: profile.id } } }, { values: { modelProfiles: profiles } })?.provider;
    if (!route || routes.has(route)) throw portableError('PORTABLE_MODEL_ROUTE_COLLISION', '模型配置生成了重复的 DSH 路由，请修改模型资源 ID');
    routes.add(route);
    const reasoning = studioReasoning(profile);
    const facts = await profileCapabilities(profile, resolveCapabilities);
    const value = { displayName: `${profile.provider} · ${profile.modelName}`, api: 'openai-completions', apiKeyEnv: profile.credentialName,
      baseURL: profile.baseUrl, ...(reasoning ? { reasoning: reasoning.defaultEffort } : {}), models: [{ id: profile.modelName, name: profile.modelName,
        contextWindow: facts.contextWindow,
        maxTokens: profile.maxOutputTokens ?? Math.min(facts.maxOutputTokens, OPERATING_MAX_OUTPUT_TOKENS),
        input: facts.input, ...(reasoning ? { reasoningEfforts: reasoning.efforts } : {}) }] };
    if (!isDeepStrictEqual(namespace.value?.providers?.[route], value)) operations.push({ op: 'set', path: ['providers', route], value });
  }
  if (operations.length) await settings.mutate('llm-pi-ai', operations, namespace.revision);
  return { providerCount: routes.size };
}
