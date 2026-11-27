import { isCredentialRefName } from '../../credential-ref.mjs';
import { harnessModelEndpoint, normalizeModelEndpoint } from '../../model-endpoint.mjs';
import { admitModelCapabilities } from '../../model-capabilities.mjs';
import { studioReasoning, providerDisplayName } from '../../model-reasoning.mjs';
import { dshConnectionHeaders, providerWireApi } from '../../model-profile-contract.mjs';
import { dshModelRoute } from '../../model-route.mjs';
export const MODEL_CREDENTIAL_NAMES = ['AGENTKIT_MODEL_API_KEY', 'OPENAI_API_KEY'];

export const DEFAULT_KSYUN_BASE_URL = 'http://kspmas.ksyun.com/v1';

export const DEFAULT_KSYUN_MODEL = 'deepseek-v4.1-flash';

export const DSH_MODEL_SETTINGS_NS = 'llm-pi-ai';

export const DSH_DEFAULT_MODEL_SETTINGS_NS = 'agent-default-model';

export const DSH_MODEL_ROUTE = 'agentkit-studio';

export const DSH_MODEL_CREDENTIAL = 'AGENTKIT_MODEL_API_KEY';

export function modelProfileId(profile, index = 0) {
  const provider = String(profile?.provider || 'ksyun').trim() || 'ksyun';
  const model = String(profile?.modelName || '').trim() || `model-${index + 1}`;
  return String(profile?.id || `${provider}:${model}`).trim().replace(/[^a-zA-Z0-9._:-]+/g, '-');
}

export function modelCredentialName(profile, index = 0) {
  // Returned verbatim: this name is already referenced by the stored model
  // profile, so renaming it here would orphan that reference. A name outside
  // the DSH grammar is caught at the write path instead of rewritten silently.
  return String(profile?.credentialName || `AGENTKIT_MODEL_API_KEY_${modelProfileId(profile, index).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`).trim();
}


export function createModelBridge({ hostRemote }) {
  function createDshModelBridge(ctx, { isActive = () => true } = {}) {
    const checkActive = () => {
      if (!isActive()) throw Object.assign(new Error('Studio 已卸载，模型同步已取消'), { code: 'STUDIO_SCOPE_DISPOSED' });
    };
    const describe = async () => {
      checkActive();
      const response = await ctx.remote.settings.describe();
      checkActive();
      if (!response?.ok) throw new Error(response?.error?.message || 'DSH 模型配置不可用');
      return response.value;
    };
    const applyProfiles = async ({ profiles, keys = {} }) => {
      const document = await describe();
      const namespace = (document.namespaces || []).find(item => item.ns === DSH_MODEL_SETTINGS_NS);
      // Studio's bundled Host exposes model-specific defaults. A stock Host
      // can still take a route default when the route serves a single model.
      const supportsModelDefaults = Object.values(namespace?.schema?.refs || {})
        .some(schema => Object.hasOwn(schema?.dict || {}, 'defaultReasoningEffort'));
      const valid = profiles.filter(profile => profile?.enabled !== false && String(profile?.modelName || '').trim())
        .sort((left, right) => Number(right.default === true) - Number(left.default === true));
      if (!valid.length) throw new Error('至少保留一个模型配置');
      const catalogs = await Promise.all(valid.map(profile => hostRemote.modelCatalog(modelProfileId(profile)).catch(() => null)));
      checkActive();
      const routes = valid.map((profile, index) => dshModelRoute(profile, index));
      // DSH groups the selector by route, so one connection is one route and
      // every model of that connection shares it. Group the profiles by route
      // and emit a single operation per route.
      const byRoute = new Map();
      valid.forEach((profile, index) => {
        const route = routes[index];
        if (!byRoute.has(route)) byRoute.set(route, []);
        byRoute.get(route).push({ profile, index });
      });
      const operations = [...byRoute].map(([route, members]) => {
        const { profile, index } = members[0];
        const modelName = String(profile.modelName).trim();
        const provider = String(profile.provider || 'ksyun').trim() || 'ksyun';
        const wire = providerWireApi(profile);
        const baseUrl = normalizeModelEndpoint(profile.baseUrl, provider);
        if (!baseUrl) throw new Error(`模型 ${modelName} 需要填写 API 地址`);
        // DSH appends `/messages` to an Anthropic route's base URL, so the
        // route has to carry the same version segment the engine process is
        // given. Without it a summary request to the official DeepSeek
        // endpoint 404s while the engine's own turns keep working.
        const routedBaseUrl = harnessModelEndpoint(baseUrl, wire);
        const credentialName = modelCredentialName(profile, index);
        // A route serves exactly the models configured on its connection —
        // never the whole vendor catalog, which dragged embeddings, video and
        // speech models into the chat selector.
        const models = members.map(({ profile: member, index: memberIndex }) => {
          const memberName = String(member.modelName).trim();
          const reasoning = studioReasoning(member);
          const reasoningEfforts = reasoning?.efforts ?? (member.reasoningLevels?.length === 0 ? false : undefined);
          const items = catalogs[memberIndex]?.items || [];
          const fallback = { id: memberName, name: memberName, input: member.input || ['text'] };
          const configuredModel = items.find(item => item.id === memberName);
          const capability = admitModelCapabilities({ ...member, input: member.input }, configuredModel || fallback);
          return { id: memberName, name: memberName, contextWindow: capability.contextWindow,
            maxTokens: capability.maxOutputTokens, input: capability.input,
            ...(reasoningEfforts !== undefined ? { reasoningEfforts } : {}) };
        });
        // Route-level default thinking comes from the default model of the route.
        const defaultMember = members.find(({ profile: member }) => member.default === true) || members[0];
        const reasoning = studioReasoning(defaultMember.profile);
        return { route, modelName, provider, baseUrl, credentialName, operation: { op: 'set', path: ['providers', route], value: {
          displayName: providerDisplayName(profile), api: wire, apiKeyEnv: credentialName,
          baseURL: routedBaseUrl,
          ...dshConnectionHeaders(members.map(member => member.profile)),
          // Kspmas validates message roles and answers
          // `400 Invalid request: role 'developer' is not allowed`. pi-ai sends
          // the system prompt as `developer` to every reasoning model on a route
          // it does not detect as non-standard, and a Studio route is always an
          // OpenAI-compatible gateway pi-ai cannot know: keep `system`.
          //
          // `store` is the same story one field over: the proxy is stateless
          // (a `previous_response_id` is refused outright), so a gateway that
          // only implements the older request shape — LiteLLM and friends —
          // rejects the key itself, and dropping it costs a stateless route
          // nothing it could have used.
          //
          // It is also an `openai-completions`-only key. DSH rejects a route
          // that sets it while no model speaks that protocol — exactly the
          // case a profile declaring `protocol: openai-responses` creates —
          // so it is conditional on the wire this route actually uses.
          ...(wire !== 'anthropic-messages' ? {
            compat: { supportsDeveloperRole: false, ...(wire === 'openai-completions' ? { supportsStore: false } : {}) },
          } : {}),
          ...(reasoning ? { reasoning: reasoning.defaultEffort } : {}),
          models,
        } } };
      });
      const providerOperations = [
        ...Object.keys(namespace?.value?.providers || {}).filter(route => route.startsWith('agentkit-studio-') && !operations.some(item => item.route === route)).map(route => ({ op: 'unset', path: ['providers', route] })),
        ...operations.map(item => item.operation),
      ];
      const previousProviders = namespace?.value?.providers || {};
      const restoreProviders = Object.keys(previousProviders).filter(route => route.startsWith('agentkit-studio-'))
        .map(route => ({ op: 'set', path: ['providers', route], value: previousProviders[route] }))
        .concat(operations.map(item => item.route).filter(route => !Object.hasOwn(previousProviders, route))
          .map(route => ({ op: 'unset', path: ['providers', route] })));
      const rollback = async (defaultNamespace, providerRevision = namespace?.revision) => {
        try {
          if (restoreProviders.length) await ctx.remote.settings.mutate(DSH_MODEL_SETTINGS_NS, restoreProviders, providerRevision);
          if (defaultNamespace?.value) {
            const old = defaultNamespace.value;
            await ctx.remote.settings.mutate(DSH_DEFAULT_MODEL_SETTINGS_NS, [
              Object.hasOwn(old, 'provider') ? { op: 'set', path: ['provider'], value: old.provider } : { op: 'unset', path: ['provider'] },
              Object.hasOwn(old, 'model') ? { op: 'set', path: ['model'], value: old.model } : { op: 'unset', path: ['model'] },
              Object.hasOwn(old, 'reasoningEffort') ? { op: 'set', path: ['reasoningEffort'], value: old.reasoningEffort } : { op: 'unset', path: ['reasoningEffort'] },
            ], defaultNamespace.revision);
          }
        } catch { /* best-effort compensation, original failure remains authoritative */ }
      };
      // Write credentials before activating any route. The credential remote
      // intentionally does not expose secret reads, so a failed write cannot
      // be rolled back safely. An unused reference is harmless, while an
      // active route with only some credentials is not.
      for (const item of operations) {
        const key = String(keys[item.credentialName] || '').trim();
        if (!key) continue;
        if (!isCredentialRefName(item.credentialName)) throw new Error(`模型 ${item.modelName} 的凭证引用不合法（只允许字母、数字和下划线，且不能以数字开头）：${item.credentialName}`);
        checkActive();
        const stored = await ctx.remote.credentials.set(item.credentialName, key);
        checkActive();
        if (!stored?.ok) throw new Error(stored?.error?.message || `模型 ${item.modelName} 凭证保存失败`);
      }
      let response;
      try { response = await ctx.remote.settings.mutate(DSH_MODEL_SETTINGS_NS, providerOperations, namespace?.revision); }
      catch (error) { await rollback(); throw error; }
      checkActive();
      if (!response?.ok) { await rollback(); throw new Error(response?.error?.message || 'DSH 模型配置保存失败'); }
      const defaultNamespace = (await describe()).namespaces?.find(item => item.ns === DSH_DEFAULT_MODEL_SETTINGS_NS);
      if (!defaultNamespace) { await rollback(); throw new Error('DSH 默认模型设置不可用，无法让新会话使用该模型'); }
      const first = operations[0];
      // The default effort belongs to the default model: a level left behind by
      // an earlier profile makes every fresh session fail with
      // `UNSUPPORTED_REASONING_EFFORT` for a level this model never declared,
      // so a profile without a reasoning declaration must clear the field.
      const defaultEffort = studioReasoning(valid[0])?.defaultEffort;
      let defaultResponse;
      try {
        defaultResponse = await ctx.remote.settings.mutate(DSH_DEFAULT_MODEL_SETTINGS_NS, [
          { op: 'set', path: ['provider'], value: first.route }, { op: 'set', path: ['model'], value: first.modelName },
          defaultEffort ? { op: 'set', path: ['reasoningEffort'], value: defaultEffort } : { op: 'unset', path: ['reasoningEffort'] },
        ], defaultNamespace.revision);
      } catch (error) { await rollback(defaultNamespace); throw error; }
      checkActive();
      if (!defaultResponse?.ok) { await rollback(defaultNamespace); throw new Error(defaultResponse?.error?.message || 'DSH 默认模型保存失败'); }
      return { provider: first.provider, route: first.route, model: first.modelName, profiles: operations.map(({ operation, ...item }) => item) };
    };
    return {
      describe,
      applyProfiles,
      apply: async ({ provider, baseUrl, modelName, apiKey }) => applyProfiles({
        profiles: [{ provider, baseUrl, modelName, credentialName: DSH_MODEL_CREDENTIAL }],
        keys: { [DSH_MODEL_CREDENTIAL]: apiKey },
      }),
      credentialStatus: async name => {
        checkActive();
        const response = await ctx.remote.credentials.describe([name || DSH_MODEL_CREDENTIAL]);
        checkActive();
        if (!response?.ok) throw new Error(response?.error?.message || 'DSH 模型凭证不可用');
        return response.value?.[name || DSH_MODEL_CREDENTIAL] || { configured: false };
      },
    };
  }
  return { createDshModelBridge };
}
