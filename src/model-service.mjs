/** Studio-owned model configuration. Only redacted metadata crosses Connection RPC. */
import { syncGlobalModelCredential } from './model-credential-sync.mjs';
import { createHash } from 'node:crypto';

export function modelInput(model = {}) {
  // KSPMAS/OpenAI-compatible gateways expose capabilities under
  // `architecture.input_modalities`; older gateways put the same field at the
  // top level. Accept both shapes so a multimodal model is not downgraded to
  // text-only when its profile is synchronized into DSH.
  const architecture = model.architecture && typeof model.architecture === 'object' ? model.architecture : {};
  const values = model.input_modalities || model.inputModalities || architecture.input_modalities || architecture.inputModalities || model.input || [];
  return ['text', ...(Array.isArray(values) && values.some(value => ['image', '图片', '图像'].includes(value)) ? ['image'] : [])];
}

export function createModelService({ configuration, credentials, fetchImpl = fetch }) {
  const catalogs = new Map();
  const sync = () => syncGlobalModelCredential({ configuration, credentials });
  const settings = () => configuration.describe();
  const save = async patch => { await configuration.update(patch); catalogs.clear(); await sync(); return settings(); };
  let creating = Promise.resolve();
  function create(resource = {}) {
    const operation = async () => {
      const id = String(resource.name || '').trim();
      const modelName = String(resource.spec?.model || '').trim();
      const credentialName = String(resource.spec?.credentialRef || 'env://AGENTKIT_MODEL_API_KEY').replace(/^env:\/\//, '').trim();
      if (!/^[a-z][a-z0-9._-]{1,127}$/.test(id) || !modelName || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(credentialName)) throw Object.assign(new Error('模型名称、模型 ID 或凭证引用无效'), { code: 'MODEL_PROFILE_INVALID' });
      let url;
      try { url = new URL(resource.spec?.endpointUrl); } catch { /* validated below */ }
      if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Object.assign(new Error('模型 API 地址无效'), {code:'MODEL_URL_INVALID'});
      const baseUrl = url.href.replace(/\/chat\/completions\/?$/, '').replace(/\/$/, '');
      const current = await settings();
      const profiles = current.modelProfiles || [];
      if (profiles.some(item => item.id === id)) throw Object.assign(new Error('模型资源名称已存在，请使用其他名称'), {code:'MODEL_PROFILE_EXISTS'});
      await save({modelProfiles:[...profiles.map(({credentialConfigured,...item})=>item),{id,displayName:String(resource.displayName || id),provider:'openai-compatible',modelName,baseUrl,credentialName,enabled:true,default:profiles.length===0}]});
      return {resourceId:id,name:resource.displayName || id,kind:'model',status:'configured'};
    };
    const pending = creating.then(operation);
    creating = pending.catch(()=>{});
    return pending;
  }
  async function profile(id) {
    const { values } = await configuration.resolve();
    const profiles = values.modelProfiles?.length ? values.modelProfiles : [{ id: 'default', provider: values.modelProvider || 'ksyun', modelName: values.modelName, baseUrl: values.modelBaseUrl, credentialName: 'AGENTKIT_MODEL_API_KEY', apiKey: values.modelApiKey }];
    // An empty id selects the default profile (first valid when no marker
    // exists), matching the model proxy's routing default.
    const effectiveId = String(id || '').trim() || (profiles.find(item => item.enabled !== false && item.default)?.id || profiles.find(item => item.enabled !== false)?.id || '');
    // Agent specs historically stored the model name in `modelProfileId`,
    // while Studio settings use a stable profile id.  Accept both forms so
    // existing agents keep running after profile-backed routing is enabled.
    const selected = profiles.find(item => item.id === effectiveId && item.enabled !== false)
      || profiles.find(item => item.modelName === effectiveId && item.enabled !== false);
    if (!selected) {
      const missing = () => Object.assign(new Error('模型配置不存在、已停用或不在网关目录中'), { code: 'MODEL_NOT_FOUND', status: 404 });
      if (!id || profiles.some(item => item.enabled === false && (item.id === effectiveId || item.modelName === effectiveId))) throw missing();
      let gateway;
      try { gateway = await profile(''); } catch { throw missing(); }
      if (!(await gatewayModels(gateway)).some(item => item.id === effectiveId)) throw missing();
      return { ...gateway, modelName: effectiveId };
    }
    const resolved = await credentials.resolve(selected.credentialName || 'AGENTKIT_MODEL_API_KEY');
    const key = resolved?.value || selected.apiKey;
    if (!key) throw Object.assign(new Error('请先在模型与凭证中配置 API Key'), { code: 'MODEL_CREDENTIAL_MISSING', status: 409 });
    const baseUrl = selected.baseUrl || (selected.provider === 'ksyun' ? 'http://kspmas.ksyun.com/v1' : '');
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Object.assign(new Error('模型 API 地址无效'), { code: 'MODEL_URL_INVALID', status: 400 });
    return { ...selected, baseUrl: baseUrl.replace(/\/$/, ''), apiKey: key };
  }
  async function gatewayModels(selected, refresh = false) {
    const key = createHash('sha256').update(selected.baseUrl + '\0' + selected.apiKey).digest('hex');
    const cached = catalogs.get(key);
    if (!refresh && cached && cached.expires > Date.now()) return cached.items;
    const response = await fetchImpl(`${selected.baseUrl}/models`, { headers: { Authorization: `Bearer ${selected.apiKey}` }, signal: AbortSignal.timeout(15000), redirect: 'error' });
    if (!response.ok) throw Object.assign(new Error(`读取模型目录失败（${response.status}）`), { code: 'MODEL_CATALOG_FAILED' });
    const data = await response.json();
    const items = (data.data || data.models || []).filter(item => typeof item.id === 'string').map(item => ({ id: item.id, name: item.name || item.id, input: modelInput(item) }));
    if (catalogs.size >= 32) catalogs.delete(catalogs.keys().next().value);
    catalogs.set(key, { items, expires: Date.now() + 60000 });
    return items;
  }
  async function catalog(id) {
    const selected = await profile(id);
    return { defaultModel: selected.modelName, items: await gatewayModels(selected, true) };
  }
  return { settings, save, create, sync, profile, catalog };
}
