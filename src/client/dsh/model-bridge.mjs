import { isCredentialRefName } from '../../credential-ref.mjs';
import { normalizeModelEndpoint } from '../../model-endpoint.mjs';
import { admitModelCapabilities } from '@kingsoftcloud/agentkit-harness-core/model-capabilities';
import { studioReasoning } from '../../model-reasoning.mjs';
import { providerWireApi } from '../../model-profile-contract.mjs';
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
      const duplicateRoute = routes.find((route, index) => routes.indexOf(route) !== index);
      if (duplicateRoute) throw Object.assign(new Error(`模型路由冲突：${duplicateRoute}。请缩短或修改模型配置 ID`), { code: 'MODEL_ROUTE_COLLISION' });
      const operations = valid.map((profile, index) => {
        const route = routes[index];
        const modelName = String(profile.modelName).trim();
        const provider = String(profile.provider || 'ksyun').trim() || 'ksyun';
        const baseUrl = normalizeModelEndpoint(profile.baseUrl, provider);
        if (!baseUrl) throw new Error(`模型 ${modelName} 需要填写 API 地址`);
        const credentialName = modelCredentialName(profile, index);
        const reasoning = studioReasoning(profile);
        const reasoningEfforts = reasoning?.efforts ?? (profile.reasoningLevels?.length === 0 ? false : undefined);
        // Kspmas model metadata is multimodal, but custom DSH routes fall
        // back to text-only unless the capability is declared explicitly.
        // Keep the input contract on each profile so read_image and native
        // image messages are admitted consistently with the upstream model.
        const items = catalogs[index]?.items || [];
        const fallback = { id: modelName, name: modelName, input: profile.input || ['text'] };
        const configuredModel = items.find(item => item.id === modelName);
        // Keep catalog siblings on legacy routes for existing selections.
        const routedModels = profile.modelOnly ? [configuredModel || fallback] : configuredModel ? items : [...items, fallback];
        const dedicated = routedModels.length === 1;
        const models = routedModels
          .map(model => {
            const configured = model.id === modelName;
            const capability = admitModelCapabilities({ ...profile, input: configured ? profile.input : undefined }, model);
            return { id: model.id, name: model.name || model.id, contextWindow: capability.contextWindow,
              maxTokens: capability.maxOutputTokens, input: capability.input,
              ...(configured && reasoningEfforts !== undefined ? { reasoningEfforts } : {}),
              ...(configured && reasoning && supportsModelDefaults && !dedicated ? { defaultReasoningEffort: reasoning.defaultEffort } : {}) };
          });
        const wire = providerWireApi(profile);
        return { route, modelName, provider, baseUrl, credentialName, operation: { op: 'set', path: ['providers', route], value: {
          displayName: `${provider} · ${modelName}`, api: wire, apiKeyEnv: credentialName,
          baseURL: baseUrl,
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
          // A route default would also be sent to every catalog sibling.
          ...(reasoning && dedicated ? { reasoning: reasoning.defaultEffort } : {}),
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
      let response;
      try { response = await ctx.remote.settings.mutate(DSH_MODEL_SETTINGS_NS, providerOperations, namespace?.revision); }
      catch (error) { throw error; }
      checkActive();
      if (!response?.ok) throw new Error(response?.error?.message || 'DSH 模型配置保存失败');
      const defaultNamespace = (await describe()).namespaces?.find(item => item.ns === DSH_DEFAULT_MODEL_SETTINGS_NS);
      if (!defaultNamespace) throw new Error('DSH 默认模型设置不可用，无法让新会话使用该模型');
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
      for (const item of operations) {
        const key = String(keys[item.credentialName] || '').trim();
        if (!key) continue;
        // modelCredentialName already repairs the name, so this only fires when
        // a caller reached the write path another way. Failing the save beats
        // persisting a reference the Host cannot load on the next boot.
        if (!isCredentialRefName(item.credentialName)) throw new Error(`模型 ${item.modelName} 的凭证引用不合法（只允许字母、数字和下划线，且不能以数字开头）：${item.credentialName}`);
        checkActive();
        let stored;
        try { stored = await ctx.remote.credentials.set(item.credentialName, key); }
        catch (error) { await rollback(defaultNamespace); throw error; }
        checkActive();
        if (!stored?.ok) { await rollback(defaultNamespace); throw new Error(stored?.error?.message || `模型 ${item.modelName} 凭证保存失败`); }
      }
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
