/** Studio-owned model configuration. Only redacted metadata crosses Connection RPC. */
import { syncGlobalModelCredential } from './model-credential-sync.mjs';

export function modelInput(model = {}) {
  const values = model.input_modalities || model.inputModalities || model.input || [];
  return ['text', ...(Array.isArray(values) && values.some(value => ['image', '图片', '图像'].includes(value)) ? ['image'] : [])];
}

export function createModelService({ configuration, credentials, fetchImpl = fetch }) {
  const sync = () => syncGlobalModelCredential({ configuration, credentials });
  const settings = () => configuration.describe();
  const save = async patch => { await configuration.update(patch); await sync(); return settings(); };
  async function profile(id) {
    const { values } = await configuration.resolve();
    const profiles = values.modelProfiles?.length ? values.modelProfiles : [{ id: 'default', provider: values.modelProvider || 'ksyun', modelName: values.modelName, baseUrl: values.modelBaseUrl, credentialName: 'AGENTKIT_MODEL_API_KEY', apiKey: values.modelApiKey }];
    // An empty id selects the default profile (first valid when no marker
    // exists), matching the model proxy's routing default.
    const effectiveId = String(id || '').trim() || (profiles.find(item => item.default)?.id || profiles[0]?.id || '');
    const selected = profiles.find(item => item.id === effectiveId && item.enabled !== false);
    if (!selected) throw Object.assign(new Error('模型配置不存在或已停用'), { code: 'MODEL_NOT_FOUND', status: 404 });
    const resolved = await credentials.resolve(selected.credentialName || 'AGENTKIT_MODEL_API_KEY');
    const key = resolved?.value || selected.apiKey;
    if (!key) throw Object.assign(new Error('请先在模型与凭证中配置 API Key'), { code: 'MODEL_CREDENTIAL_MISSING', status: 409 });
    const baseUrl = selected.baseUrl || (selected.provider === 'ksyun' ? 'http://kspmas.ksyun.com/v1' : '');
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Object.assign(new Error('模型 API 地址无效'), { code: 'MODEL_URL_INVALID', status: 400 });
    return { ...selected, baseUrl: baseUrl.replace(/\/$/, ''), apiKey: key };
  }
  async function catalog(id) {
    const selected = await profile(id);
    const response = await fetchImpl(`${selected.baseUrl}/models`, { headers: { Authorization: `Bearer ${selected.apiKey}` }, signal: AbortSignal.timeout(15000), redirect: 'error' });
    if (!response.ok) throw Object.assign(new Error(`读取模型目录失败（${response.status}）`), { code: 'MODEL_CATALOG_FAILED' });
    const data = await response.json();
    return { items: (data.data || data.models || []).filter(item => typeof item.id === 'string').map(item => ({ id: item.id, name: item.name || item.id, input: modelInput(item) })) };
  }
  return { settings, save, sync, profile, catalog };
}
