import { hostFetch } from './http-fetch.mjs';
/** Studio-owned model configuration. Only redacted metadata crosses Connection RPC. */
import { syncGlobalModelCredential } from './model-credential-sync.mjs';
import { STUDIO_REASONING_LEVELS, studioReasoning } from './model-reasoning.mjs';
import { catalogReasoningMetadata } from './model-catalog-reasoning.mjs';
import { modelCard } from './model-cards.mjs';
import { isRouteMindModel, ROUTEMIND_PROVIDER } from './host/services/routemind-models.mjs';
import { dshModelRoute, HARNESS_SERVICE_MODEL_PROVIDER } from './model-route.mjs';
import { autoScoresFromBenchmarkCatalog, autoScoresFromModelDirectory } from './routemind-preview.mjs';
import { createHash } from 'node:crypto';
import { modelCatalogLimits, admitModelCapabilities } from './model-capabilities.mjs';
import { hasConfiguredAuthentication, providerWireApi, requestHeaders } from './model-profile-contract.mjs';
import { normalizeModelEndpoint } from './model-endpoint.mjs';
import { diagnoseModelEfforts, untestedEfforts } from './model-effort-probe.mjs';
import { probeModelWire, probeModelWires } from './model-wire-probe.mjs';
import { inputModalities, modelInput } from './model-input.mjs';
export { modelInput };

export function createModelService({ configuration, credentials, fetchImpl = hostFetch, routeMindActive = () => false, routeMindGateway = async () => null }) {
  const catalogs = new Map();
  const pendingCatalogs = new Map();
  const displayCatalogs = new WeakMap();
  const sync = () => syncGlobalModelCredential({ configuration, credentials });
  const settings = () => configuration.describe();
  const save = async patch => {
    await configuration.update(patch);
    catalogs.clear();
    await sync();
    return settings();
  };
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
      const baseUrl = normalizeModelEndpoint(url.href, 'openai-compatible');
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
    let resolved;
    try { resolved = await credentials.resolve(selected.credentialName || 'AGENTKIT_MODEL_API_KEY'); }
    catch { resolved = undefined; }
    const key = resolved?.value || selected.apiKey;
    if (!key && !hasConfiguredAuthentication(selected.headers)) throw Object.assign(new Error('请先在模型与凭证中配置 API Key，或配置 Authorization/X-API-Key 请求头'), { code: 'MODEL_CREDENTIAL_MISSING', status: 409 });
    const baseUrl = normalizeModelEndpoint(selected.baseUrl || '', selected.provider);
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Object.assign(new Error('模型 API 地址无效'), { code: 'MODEL_URL_INVALID', status: 400 });
    // Configuration stores `reasoningEfforts: true` as the opt-in marker; the
    // Harness needs the materialized wire map, so resolve it once here.
    const reasoning = studioReasoning(selected);
    return { ...selected,
      ...(reasoning ? { reasoningEfforts: reasoning.efforts, defaultReasoningEffort: reasoning.defaultEffort } : {}),
      baseUrl: url.href.replace(/\/$/, ''), apiKey: key || '' };
  }
  async function gatewayCatalog(selected, refresh = false) {
    // A gateway can gate `/models` behind its own header, so the profile's
    // configured request headers reach the catalog read. Configuration wins
    // over the credential-derived Authorization: an explicitly configured
    // header is the caller's intent. With no headers configured the request is
    // byte-for-byte the same as before, and the cache key only grows when
    // headers exist so unrelated profiles keep sharing one catalog.
    const configured = requestHeaders(selected.headers);
    const fingerprint = Object.keys(configured).length
      ? '\0' + JSON.stringify(Object.entries(configured).sort(([left], [right]) => left.localeCompare(right))) : '';
    const key = createHash('sha256').update(selected.baseUrl + '\0' + (selected.apiKey || '') + fingerprint).digest('hex');
    const cached = catalogs.get(key);
    if (!refresh && cached && cached.expires > Date.now()) return cached;
    if (pendingCatalogs.has(key)) return pendingCatalogs.get(key);
    const operation = (async () => {
      const headers = { ...configured, ...(selected.apiKey && !Object.keys(configured).some(name => name.toLowerCase() === 'authorization') ? { Authorization: `Bearer ${selected.apiKey}` } : {}) };
      const response = await fetchImpl(`${selected.baseUrl}/models`, { headers, signal: AbortSignal.timeout(15000), redirect: 'error' });
      if (!response.ok) throw Object.assign(new Error(`读取模型目录失败（${response.status}）`), { code: 'MODEL_CATALOG_FAILED' });
      const data = await response.json();
      const entries = data?.data ?? data?.models;
      const raw = Array.isArray(entries) ? entries.filter(item => typeof item?.id === 'string' && item.id.trim()) : [];
      const items = raw.map(item => ({
        id: item.id, name: typeof item.name === 'string' && item.name.trim() ? item.name : item.id, input: modelInput(item),
        ...modelCatalogLimits(item),
        ...catalogReasoningMetadata(item),
        // Distinguish "the gateway reported modalities" from "it reported none":
        // only the former may be trusted as text-only, so the catalog cannot add
        // vision to a model the vendor declared text-only.
        ...(Array.isArray(inputModalities(item)) && inputModalities(item).length ? { inputKnown: true } : { inputKnown: false }),
      }));
      const snapshot = { raw, items, headers, expires: Date.now() + 60000 };
      if (catalogs.size >= 32) catalogs.delete(catalogs.keys().next().value);
      catalogs.set(key, snapshot);
      return snapshot;
    })();
    pendingCatalogs.set(key, operation);
    try { return await operation; }
    finally { if (pendingCatalogs.get(key) === operation) pendingCatalogs.delete(key); }
  }
  async function gatewayModels(selected, refresh = false) {
    return (await gatewayCatalog(selected, refresh)).items;
  }
  /**
   * Compatible RouteMind gateways advertise `owned_by: routemind` and can
   * supply measured cards. This optional read belongs to display surfaces.
   */
  async function routeMindCards(baseUrl, headers, raw) {
    if (!raw.some(item => item.owned_by === 'routemind')) return new Map();
    try {
      const root = baseUrl.replace(/\/v1$/, '');
      const response = await fetchImpl(`${root}/routemind/models`, { headers, signal: AbortSignal.timeout(5000), redirect: 'error' });
      if (!response.ok) {
        await response.body?.cancel();
        return new Map();
      }
      const body = await response.json();
      return new Map((Array.isArray(body?.models) ? body.models : []).filter(card => typeof card?.name === 'string').map(card => [card.name, card]));
    } catch { return new Map(); }
  }
  async function routeMindProfile(provider, modelName) {
    if (provider !== ROUTEMIND_PROVIDER || !isRouteMindModel(modelName)) return null;
    if (!await routeMindActive()) throw Object.assign(new Error('请先启用 RouteMind 智能路由'), { code: 'ROUTEMIND_DISABLED' });
    const gateway = await routeMindGateway();
    if (!gateway || !gateway.apiKey && !gateway.local)
      throw Object.assign(new Error('请配置可用的 RouteMind 网关和凭据'), { code: 'ROUTEMIND_GATEWAY_UNAVAILABLE' });
    return { id: provider + ':' + modelName, provider, modelName, ...gateway, protocol: 'openai-completions' };
  }
  const routeMindHeaders = gateway => gateway.apiKey ? { Authorization: 'Bearer ' + gateway.apiKey } : {};
  async function routeMindLiveCatalog(gateway) {
    if (!gateway) return new Map();
    return routeMindCards(gateway.baseUrl, routeMindHeaders(gateway), [{ owned_by: 'routemind' }]);
  }
  async function routeMindBenchmarkScores(gateway) {
    if (!gateway) return null;
    try {
      const response = await fetchImpl(`${gateway.baseUrl}/catalog`, {
        headers: routeMindHeaders(gateway), signal: AbortSignal.timeout(5000), redirect: 'error',
      });
      if (!response.ok) { await response.body?.cancel(); return null; }
      return autoScoresFromBenchmarkCatalog(await response.json());
    } catch { return null; }
  }
  function displayModels(selected, snapshot, shared = new Map()) {
    if (!displayCatalogs.has(snapshot)) displayCatalogs.set(snapshot, routeMindCards(selected.baseUrl, snapshot.headers, snapshot.raw));
    return displayCatalogs.get(snapshot).then(live => snapshot.items.map((item, index) => ({
      ...item,
      card: modelCard(snapshot.raw[index], { live: live.get(item.id) ?? scoreOnly(shared.get(item.id)), reasoningLevels: item.reasoningLevels }),
    })));
  }
  const scoreOnly = card => card && { scores: card.scores };
  async function catalogForDisplay(selected) {
    const snapshot = await gatewayCatalog(selected, true);
    if (!await routeMindActive()) return snapshot.items;
    const items = await displayModels(selected, snapshot, await routeMindLiveCatalog(await routeMindGateway()));
    return await routeMindActive() ? items : snapshot.items;
  }
  /**
   * Display cards for every model the enabled profiles' catalogs list, keyed by
   * model id, for the chat model selector. Best-effort: a profile whose catalog
   * cannot be read contributes nothing. Uses the catalog cache.
   */
  async function cards() {
    const inactive = { enabled: false, cards: {}, cardsByProvider: {} };
    if (!await routeMindActive()) return inactive;
    const { values } = await configuration.resolve();
    const enabledProfiles = (values.modelProfiles || []).filter(item => item.enabled !== false);
    const candidates = enabledProfiles.length ? enabledProfiles : [{ id: 'default' }];
    const seen = new Set([HARNESS_SERVICE_MODEL_PROVIDER]), ambiguous = new Set();
    const routes = [...new Map(candidates.map(candidate => {
      const provider = dshModelRoute(candidate);
      const binding = [candidate.baseUrl, candidate.connectionId, candidate.credentialName];
      const key = JSON.stringify([provider, binding]);
      return [key, { id: candidate.id, provider }];
    })).values()].map(route => {
      if (seen.has(route.provider)) ambiguous.add(route.provider);
      seen.add(route.provider);
      return route;
    });
    const configured = await routeMindGateway();
    const gateway = configured && (configured.apiKey || configured.local) ? configured : null;
    const shared = await routeMindLiveCatalog(gateway);
    if (!await routeMindActive()) return inactive;
    const autoScores = autoScoresFromModelDirectory(shared);
    const pendingAuto = autoScores ? Promise.resolve(autoScores) : routeMindBenchmarkScores(gateway);
    // Existing DSH routes can outlive a conflicting edit. Avoid attaching any
    // gateway's price to that route, even if only one catalog can be read.
    const lists = await Promise.all(routes.filter(route => !ambiguous.has(route.provider)).map(async ({ id, provider }) => {
      try {
        const selected = await profile(id);
        return { provider, items: await displayModels(selected, await gatewayCatalog(selected), shared) };
      } catch {
        const names = candidates.filter(candidate => dshModelRoute(candidate) === provider && candidate.modelName);
        const items = names.map(item => ({ id: item.modelName,
          card: modelCard({ id: item.modelName }, { live: scoreOnly(shared.get(item.modelName)) }) })).filter(item => item.card.scores);
        return items.length ? { provider, items } : null;
      }
    }));
    const routeMindAutoScores = await pendingAuto;
    if (!await routeMindActive()) return inactive;
    const byModel = new Map(), byProvider = new Map();
    for (const list of lists.filter(Boolean)) {
      byProvider.set(list.provider, Object.fromEntries(list.items.map(item => [item.id, item.card])));
      for (const item of list.items) {
        if (!byModel.has(item.id)) byModel.set(item.id, item.card);
        else if (byModel.get(item.id) !== item.card) byModel.set(item.id, null);
      }
    }
    return { enabled: true, cards: ambiguous.size ? {} : Object.fromEntries([...byModel].filter(([, card]) => card)),
      ...(routeMindAutoScores ? { routeMindAutoScores } : {}),
      cardsByProvider: Object.fromEntries(byProvider),
      sharedScores: Object.fromEntries([...shared].map(([id, card]) => [id, modelCard({ id }, { live: scoreOnly(card) }).scores]).filter(([, scores]) => scores)) };
  }
  async function catalog(id, { includeCards = false } = {}) {
    const selected = await profile(id);
    const items = await (includeCards ? catalogForDisplay(selected) : gatewayModels(selected, true));
    return { defaultModel: selected.modelName, items };
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
      let resolved;
      try { resolved = await credentials.resolve(saved.credentialName || 'AGENTKIT_MODEL_API_KEY'); }
      catch { resolved = undefined; }
      // A saved credential can only be sent to the saved endpoint and headers.
      const envKey = ['env', 'user-env', 'project-env'].includes(resolved?.source) && resolved.value;
      candidate = { ...saved, apiKey: envKey || saved.apiKey || resolved?.value };
    }
    const provider = String(candidate.provider || 'custom').trim() || 'custom';
    const baseUrl = normalizeModelEndpoint(candidate.baseUrl || '', provider);
    const apiKey = String(candidate.apiKey || '').trim();
    const headers = requestHeaders(candidate.headers);
    if (!apiKey && !hasConfiguredAuthentication(headers)) throw Object.assign(new Error('请先填写模型 API Key，或配置 Authorization/X-API-Key 请求头'), { code: 'MODEL_CREDENTIAL_MISSING', status: 409 });
    let url;
    try { url = new URL(baseUrl); } catch { /* validated below */ }
    if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw Object.assign(new Error('模型 API 地址无效'), { code: 'MODEL_URL_INVALID', status: 400 });
    return { provider, baseUrl: normalizeModelEndpoint(url.href, provider), apiKey, headers,
      modelName: candidate.modelName, protocol: candidate.protocol };
  }
  async function probe(candidate = {}) {
    const target = await probeConnection(candidate);
    const items = await catalogForDisplay(target);
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
    const baseUrl = normalizeModelEndpoint(candidate.baseUrl || '', candidate.provider || 'custom');
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
    if ((!apiKey && !hasConfiguredAuthentication(candidate?.headers)) || !baseUrl) return admitModelCapabilities(candidate);
    return capabilities({ ...candidate, baseUrl, apiKey }, signal);
  }
  return { settings, save, create, sync, profile, routeMindProfile, catalog, cards, probe, probeEfforts, probeWire, capabilities, capabilitiesOf };
}
