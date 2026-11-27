/** Publish the imported models through DSH's public settings service before headless admission. */
import { isDeepStrictEqual } from 'node:util';
import { dshModelSelection } from './agent-preset-admission.mjs';
import { portableError } from './portable-resources.mjs';
import { admitModelCapabilities } from './model-capabilities.mjs';
import { studioReasoning, providerDisplayName } from './model-reasoning.mjs';
import { dshConnectionHeaders, providerWireApi } from './model-profile-contract.mjs';

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
  const routes = new Map(), operations = [];
  // Two profiles share a route only when they share a connection. Compare the
  // raw identity: the connection id when present, else the profile id (a
  // profile without one is its own connection). The route name is normalized,
  // so two different identities can normalize onto one name and would
  // otherwise silently overwrite each other.
  const identityOf = profile => String(profile.connectionId || profile.id || '').trim();
  for (const profile of profiles) {
    const route = dshModelSelection({ spec: { bindings: { modelProfileId: profile.id } } }, { values: { modelProfiles: profiles } })?.provider;
    if (!route) throw portableError('PORTABLE_MODEL_ROUTE_COLLISION', '模型配置生成了重复的 DSH 路由，请修改模型资源 ID');
    const group = routes.get(route);
    if (group && group.identity !== identityOf(profile)) {
      throw portableError('PORTABLE_MODEL_ROUTE_COLLISION', '模型配置生成了重复的 DSH 路由，请修改模型资源 ID');
    }
    if (!group) routes.set(route, { identity: identityOf(profile), members: [] });
    routes.get(route).members.push(profile);
  }
  for (const [route, { members }] of routes) {
    const profile = members[0];
    const reasoning = studioReasoning(profile);
    const wire = providerWireApi(profile);
    const models = [];
    for (const member of members) {
      const facts = await profileCapabilities(member, resolveCapabilities);
      const memberReasoning = studioReasoning(member);
      models.push({ id: member.modelName, name: member.modelName,
        contextWindow: facts.contextWindow,
        maxTokens: member.maxOutputTokens ?? Math.min(facts.maxOutputTokens, OPERATING_MAX_OUTPUT_TOKENS),
        input: facts.input, ...(memberReasoning ? { reasoningEfforts: memberReasoning.efforts } : {}) });
    }
    const value = { displayName: providerDisplayName(profile), api: wire, apiKeyEnv: profile.credentialName,
      baseURL: profile.baseUrl, ...dshConnectionHeaders(members),
      // Kspmas validates message roles and answers
      // `400 Invalid request: role 'developer' is not allowed`. pi-ai sends the
      // system prompt as `developer` to every reasoning model on a route it
      // does not detect as non-standard, and a Studio route is always an
      // OpenAI-compatible gateway pi-ai cannot know: keep `system`.
      //
      // `store` is the same story one field over: the proxy is stateless (a
      // `previous_response_id` is refused outright), so a gateway that only
      // implements the older request shape — LiteLLM and friends — rejects the
      // key itself, and dropping it costs a stateless route nothing.
      //
      // It is also an `openai-completions`-only key; DSH rejects a route that
      // sets it while no model speaks that protocol, which is what a profile
      // declaring `protocol: openai-responses` would otherwise hit.
      compat: { supportsDeveloperRole: false, ...(wire === 'openai-completions' ? { supportsStore: false } : {}) },
      ...(reasoning ? { reasoning: reasoning.defaultEffort } : {}), models };
    if (!isDeepStrictEqual(namespace.value?.providers?.[route], value)) operations.push({ op: 'set', path: ['providers', route], value });
  }
  if (operations.length) await settings.mutate('llm-pi-ai', operations, namespace.revision);
  return { providerCount: routes.size };
}
