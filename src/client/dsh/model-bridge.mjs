import { normalizeModelEndpoint } from '../../model-endpoint.mjs';
import { studioReasoning } from '../../model-reasoning.mjs';
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
      const valid = profiles.filter(profile => profile?.enabled !== false && String(profile?.modelName || '').trim())
        .sort((left, right) => Number(right.default === true) - Number(left.default === true));
      if (!valid.length) throw new Error('至少保留一个模型配置');
      const catalogs = await Promise.all(valid.map(profile => hostRemote.modelCatalog(modelProfileId(profile)).catch(() => null)));
      checkActive();
      const operations = valid.map((profile, index) => {
        const route = `agentkit-studio-${modelProfileId(profile, index).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.slice(0, 64);
        const modelName = String(profile.modelName).trim();
        const provider = String(profile.provider || 'ksyun').trim() || 'ksyun';
        const baseUrl = normalizeModelEndpoint(profile.baseUrl, provider);
        if (!baseUrl) throw new Error(`模型 ${modelName} 需要填写 API 地址`);
        const credentialName = modelCredentialName(profile, index);
        const reasoning = studioReasoning(profile);
        return { route, modelName, provider, baseUrl, credentialName, operation: { op: 'set', path: ['providers', route], value: {
          displayName: `${provider} · ${modelName}`, api: 'openai-completions', apiKeyEnv: credentialName,
          baseURL: baseUrl,
          // A concrete route default keeps fresh sessions on a thinking level
          // instead of DSH's "provider default" row, which would omit the
          // parameter and leave thinking to the gateway's own default.
          ...(reasoning ? { reasoning: reasoning.defaultEffort } : {}),
          // Kspmas model metadata is multimodal, but custom DSH routes fall
          // back to text-only unless the capability is declared explicitly.
          // Keep the input contract on each profile so read_image and native
          // image messages are admitted consistently with the upstream model.
          models: (catalogs[index]?.items?.length ? catalogs[index].items : [{ id: modelName, name: modelName, input: profile.input || ['text'] }])
            .map(model => ({ id: model.id, name: model.name || model.id, contextWindow: 262144, maxTokens: 32768,
              input: model.inputKnown === false && model.id === modelName ? profile.input || ['text'] : model.input || ['text'],
              // The profile describes one model; sibling catalog entries keep
              // their own (absent) capability instead of inheriting this map.
              ...(reasoning && model.id === modelName ? { reasoningEfforts: reasoning.efforts } : {}) })),
        } } };
      });
      const response = await ctx.remote.settings.mutate(DSH_MODEL_SETTINGS_NS, [
        ...Object.keys(namespace?.value?.providers || {}).filter(route => route.startsWith('agentkit-studio-') && !operations.some(item => item.route === route)).map(route => ({ op: 'unset', path: ['providers', route] })),
        ...operations.map(item => item.operation),
      ], namespace?.revision);
      checkActive();
      if (!response?.ok) throw new Error(response?.error?.message || 'DSH 模型配置保存失败');
      const defaultNamespace = (await describe()).namespaces?.find(item => item.ns === DSH_DEFAULT_MODEL_SETTINGS_NS);
      if (!defaultNamespace) throw new Error('DSH 默认模型设置不可用，无法让新会话使用该模型');
      const first = operations[0];
      const defaultResponse = await ctx.remote.settings.mutate(DSH_DEFAULT_MODEL_SETTINGS_NS, [
        { op: 'set', path: ['provider'], value: first.route }, { op: 'set', path: ['model'], value: first.modelName },
      ], defaultNamespace.revision);
      checkActive();
      if (!defaultResponse?.ok) throw new Error(defaultResponse?.error?.message || 'DSH 默认模型保存失败');
      for (const item of operations) {
        const key = String(keys[item.credentialName] || '').trim();
        if (!key) continue;
        checkActive();
        const stored = await ctx.remote.credentials.set(item.credentialName, key);
        checkActive();
        if (!stored?.ok) throw new Error(stored?.error?.message || `模型 ${item.modelName} 凭证保存失败`);
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
