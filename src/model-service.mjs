import { hostFetch } from './http-fetch.mjs';
/** Studio-owned model configuration. Only redacted metadata crosses Connection RPC. */
import { syncGlobalModelCredential } from './model-credential-sync.mjs';
import { STUDIO_REASONING_LEVELS, studioReasoning } from './model-reasoning.mjs';
import { catalogReasoningMetadata } from './model-catalog-reasoning.mjs';
import { createHash } from 'node:crypto';
import { modelCatalogLimits, admitModelCapabilities } from '@kingsoftcloud/agentkit-harness-core/model-capabilities';
import { providerWireApi, requestHeaders } from './model-profile-contract.mjs';
import { diagnoseModelEfforts, untestedEfforts } from './model-effort-probe.mjs';
import { probeModelWire, probeModelWires } from './model-wire-probe.mjs';

function inputModalities(model = {}) {
  // KSPMAS/OpenAI-compatible gateways expose capabilities under
  // `architecture.input_modalities`; older gateways put the same field at the
  // top level. Accept both shapes so a multimodal model is not downgraded to
  // text-only when its profile is synchronized into DSH.
  const architecture = model.architecture && typeof model.architecture === 'object' ? model.architecture : {};
  return model.input_modalities || model.inputModalities || architecture.input_modalities || architecture.inputModalities || model.input;
}

export function modelInput(model = {}) {
  const values = inputModalities(model);
  return ['text', ...(Array.isArray(values) && values.some(value => ['image', '图片', '图像'].includes(value)) ? ['image'] : [])];
}

export function createModelService({ configuration, credentials, fetchImpl = hostFetch }) {
  const catalogs = new Map();
  const pendingCatalogs = new Map();
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
  async function profile(id, { admittedModel } = {}) {
    const { values } = await configuration.resolve();
    const profiles = values.modelProfiles?.length ? values.modelProfiles : [{ id: 'default', provider: values.modelProvider || 'ksyun', modelName: values.modelName || 'deepseek-v4.1-flash', baseUrl: values.modelBaseUrl, credentialName: 'AGENTKIT_MODEL_API_KEY', apiKey: values.modelApiKey }];
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
      try { gateway = await profile(''); } catch (error) { if (admittedModel) throw error; throw missing(); }
      const admitted = admittedModel?.profileId === gateway.id && admittedModel?.modelName === effectiveId;
      if (!admitted && !(await gatewayModels(gateway)).some(item => item.id === effectiveId)) throw missing();
      return { ...gateway, modelName: effectiveId };
    }
    const resolved = await credentials.resolve(selected.credentialName || 'AGENTKIT_MODEL_API_KEY');
    const key = resolved?.value || selected.apiKey;
    if (!key) throw Object.assign(new Error('请先在模型与凭证中配置 API Key'), { code: 'MODEL_CREDENTIAL_MISSING', status: 409 });
    const baseUrl = selected.baseUrl || (selected.provider === 'ksyun' ? 'http://kspmas.ksyun.com/v1' : '');
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Object.assign(new Error('模型 API 地址无效'), { code: 'MODEL_URL_INVALID', status: 400 });
    // Configuration stores `reasoningEfforts: true` as the opt-in marker; the
    // Harness needs the materialized wire map, so resolve it once here.
    const reasoning = studioReasoning(selected);
    return { ...selected,
      ...(reasoning ? { reasoningEfforts: reasoning.efforts, defaultReasoningEffort: reasoning.defaultEffort } : {}),
      baseUrl: baseUrl.replace(/\/$/, ''), apiKey: key };
  }
  async function gatewayModels(selected, refresh = false) {
    // A gateway can gate `/models` behind its own header, so the profile's
    // configured request headers reach the catalog read. Configuration wins
    // over the credential-derived Authorization: an explicitly configured
    // header is the caller's intent. With no headers configured the request is
    // byte-for-byte the same as before, and the cache key only grows when
    // headers exist so unrelated profiles keep sharing one catalog.
    const configured = requestHeaders(selected.headers);
    const fingerprint = Object.keys(configured).length
      ? '\0' + JSON.stringify(Object.entries(configured).sort(([left], [right]) => left.localeCompare(right))) : '';
    const key = createHash('sha256').update(selected.baseUrl + '\0' + selected.apiKey + fingerprint).digest('hex');
    const cached = catalogs.get(key);
    if (!refresh && cached && cached.expires > Date.now()) return cached.items;
    if (pendingCatalogs.has(key)) return pendingCatalogs.get(key);
    const operation = (async () => {
    const response = await fetchImpl(`${selected.baseUrl}/models`, { headers: { Authorization: `Bearer ${selected.apiKey}`, ...configured }, signal: AbortSignal.timeout(15000), redirect: 'error' });
    if (!response.ok) throw Object.assign(new Error(`读取模型目录失败（${response.status}）`), { code: 'MODEL_CATALOG_FAILED' });
    const data = await response.json();
    const items = (data.data || data.models || []).filter(item => typeof item.id === 'string').map(item => ({ id: item.id, name: item.name || item.id, input: modelInput(item),
      ...modelCatalogLimits(item),
      ...catalogReasoningMetadata(item),
      ...(Array.isArray(inputModalities(item)) && inputModalities(item).length ? {} : { inputKnown: false }) }));
    if (catalogs.size >= 32) catalogs.delete(catalogs.keys().next().value);
    catalogs.set(key, { items, expires: Date.now() + 60000 });
    return items;
    })();
    pendingCatalogs.set(key, operation);
    try { return await operation; }
    finally { if (pendingCatalogs.get(key) === operation) pendingCatalogs.delete(key); }
  }
  async function catalog(id) {
    const selected = await profile(id);
    return { defaultModel: selected.modelName, items: await gatewayModels(selected, true) };
  }
  /** Resolve a saved credential with the endpoint it belongs to, or use the draft's own key. */
  async function probeConnection(candidate) {
    const { connectionId, profileId } = candidate;
    if (connectionId || profileId) {
      const { values } = await configuration.resolve();
      const saved = connectionId
        ? values.modelConnections?.find(item => item.id === connectionId)
        : values.modelProfiles?.find(item => item.id === profileId)
          || (profileId === 'default' && !values.modelProfiles?.length && {
            provider: values.modelProvider, baseUrl: values.modelBaseUrl, apiKey: values.modelApiKey, credentialName: 'AGENTKIT_MODEL_API_KEY',
          });
      if (!saved) throw Object.assign(new Error('找不到已保存的模型或提供商'), { code: 'MODEL_CONNECTION_NOT_FOUND', status: 404 });
      const resolved = await credentials.resolve(saved.credentialName || 'AGENTKIT_MODEL_API_KEY');
      // A saved credential can only be sent to the saved endpoint and headers.
      const envKey = ['env', 'user-env', 'project-env'].includes(resolved?.source) && resolved.value;
      candidate = { ...saved, apiKey: envKey || saved.apiKey || resolved?.value };
    }
    const provider = String(candidate.provider || 'custom').trim() || 'custom';
    const baseUrl = String(candidate.baseUrl || (provider === 'ksyun' ? 'http://kspmas.ksyun.com/v1' : '')).replace(/\/$/, '');
    const apiKey = String(candidate.apiKey || '').trim();
    if (!apiKey) throw Object.assign(new Error('请先填写模型 API Key'), { code: 'MODEL_CREDENTIAL_MISSING', status: 409 });
    let url;
    try { url = new URL(baseUrl); } catch { /* validated below */ }
    if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw Object.assign(new Error('模型 API 地址无效'), { code: 'MODEL_URL_INVALID', status: 400 });
    return { provider, baseUrl: url.href.replace(/\/$/, ''), apiKey, headers: requestHeaders(candidate.headers),
      modelName: candidate.modelName, protocol: candidate.protocol };
  }
  async function probe(candidate = {}) {
    const target = await probeConnection(candidate);
    const items = await gatewayModels(target, true);
    const { provider, baseUrl } = target;
    const modelName = String(target.modelName || '').trim();
    return {
      provider,
      baseUrl,
      defaultModel: modelName || items[0]?.id || '',
      selectedModel: modelName,
      selectedAvailable: !modelName || items.some(item => item.id === modelName),
      items,
    };
  }
  async function probeEfforts(candidate = {}, signal) {
    const modelName = String(candidate.modelName || '').trim();
    if (!modelName) throw Object.assign(new Error('请先选择或填写模型 ID'), { code: 'MODEL_PROBE_INPUT_INVALID', status: 400 });
    const target = await probeConnection(candidate);
    const options = { ...target, modelName, fetchImpl, signal };
    const wire = candidate.detectWire
      ? await probeModelWire(options)
      : providerWireApi({ protocol: candidate.protocol ?? target.protocol });
    signal?.throwIfAborted();
    if (wire === 'unknown') return { modelName, wire, outcomes: untestedEfforts(STUDIO_REASONING_LEVELS) };
    const diagnosis = await diagnoseModelEfforts({
      ...options, levels: STUDIO_REASONING_LEVELS,
      wire: wire === 'openai-completions' ? 'openai-chat' : wire,
      modernChatLimit: target.provider === 'openai',
    });
    return { modelName, wire, ...diagnosis };
  }
  /** Read wire support with the credentials of the selected connection. */
  async function probeWire(candidate = {}, signal) {
    const modelName = String(candidate.modelName || '').trim();
    if (Array.isArray(candidate.models)) {
      const target = await probeConnection(candidate);
      const deadline = AbortSignal.timeout(15_000);
      const items = await probeModelWires({
        ...target, models: candidate.models, fetchImpl,
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      });
      return { items };
    }
    if (candidate.connectionId || candidate.profileId || candidate.apiKey) {
      const target = await probeConnection(candidate);
      const wire = await probeModelWire({ ...target, modelName, fetchImpl, signal });
      return { baseUrl: target.baseUrl, modelName, wire };
    }
    // Keep the original direct-address operation available to existing callers.
    const baseUrl = String(candidate.baseUrl || '').trim().replace(/\/+$/, '');
    if (!baseUrl || !modelName)
      throw Object.assign(new Error('探测需要模型地址与模型名'), { code: 'MODEL_PROBE_INPUT_INVALID', status: 400 });
    let apiKey;
    try { apiKey = (await credentials.resolve(candidate.credentialName || 'AGENTKIT_MODEL_API_KEY'))?.value; }
    catch { /* Allow gateways that do not require authentication. */ }
    const wire = await probeModelWire({ baseUrl, modelName, apiKey, headers: requestHeaders(candidate.headers), fetchImpl, signal });
    return { baseUrl, modelName, wire };
  }
  async function capabilities(selected, signal) {
    signal?.throwIfAborted();
    let items;
    try { items = await gatewayModels(selected); }
    catch { signal?.throwIfAborted(); return admitModelCapabilities(selected); }
    signal?.throwIfAborted();
    const item = items.find(item => item.id === selected.modelName);
    return admitModelCapabilities(selected, item, item ? 'available' : 'not-listed');
  }
  /** Admit capabilities for one declared profile. Managed declarations carry no
   * contextWindow of their own, so resolve the gateway catalog to use the
   * advertised window instead of the historical 128000 default. */
  async function capabilitiesOf(candidate, signal) {
    signal?.throwIfAborted();
    const baseUrl = String(candidate?.baseUrl || '').replace(/\/$/, '');
    let apiKey = candidate?.apiKey;
    if (!apiKey) {
      try { apiKey = (await credentials.resolve(candidate?.credentialName || 'AGENTKIT_MODEL_API_KEY'))?.value; }
      catch { signal?.throwIfAborted(); apiKey = null; }
    }
    if (!apiKey || !baseUrl) return admitModelCapabilities(candidate);
    return capabilities({ ...candidate, baseUrl, apiKey }, signal);
  }
  return { settings, save, create, sync, profile, catalog, probe, probeEfforts, probeWire, capabilities, capabilitiesOf };
}
