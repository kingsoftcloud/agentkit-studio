import { DEFAULT_KSYUN_BASE_URL, DEFAULT_KSYUN_MODEL, DSH_MODEL_CREDENTIAL, DSH_MODEL_SETTINGS_NS, modelCredentialName, modelProfileId } from '../dsh/model-bridge.mjs';
import { BRAND as DEFAULT_BRAND } from '../theme.mjs';
import { normalizeModelEndpoint } from '../../model-endpoint.mjs';
import { modelRuntimeOptions } from '../../model-profile-contract.mjs';
import { reasoningProfileFor, studioReasoning } from '../../model-reasoning.mjs';
import { leaseDocumentResource } from '../dsh/document-resource.mjs';
import modelSettingsStyles from '../styles/model-settings.css.mjs';

/** The settings sheet is a document-level asset shared by every mount. */
function ensureModelSettingsStyles(document) {
  if (!document?.head) return () => {};
  return leaseDocumentResource(document, 'agentkit-studio:model-settings', () => {
    if (document.querySelector('style[data-agentkit-studio-model-settings]')) return () => {};
    const style = document.createElement('style');
    style.setAttribute('data-agentkit-studio-model-settings', 'true');
    style.textContent = modelSettingsStyles;
    document.head.append(style);
    return () => style.remove();
  });
}

/*
 * 方案 C：切换模型时，未保存的编辑只活在内存草稿里。
 *
 * The table is keyed by profile id and lives at module scope so that closing
 * and reopening the settings sheet — a full unmount, including the
 * Electron-embedded host where `beforeunload` never fires — restores the draft
 * of the same model. It is intentionally never persisted: no Host write, no
 * localStorage, no file. Reloading the page, opening a second window or using
 * another device starts from the saved configuration, and nothing here is
 * shared between windows.
 */
const MODEL_DRAFT_EDIT = 'edit';
const MODEL_DRAFT_NEW = 'new';
const MODEL_DRAFT_REMOVED = 'removed';
const modelDrafts = new Map();
const CLOUD_FIELDS = ['cloudAccessKey', 'cloudSecretKey', 'cloudAccountId', 'cloudRegion', 'cloudServerUrl', 'cloudBucket'];

/** Forget every in-memory draft (tests, and any surface that discards drafts). */
export function clearModelSettingsDrafts() { modelDrafts.clear(); }

/** The model ids that currently hold an in-memory draft (tests/diagnostics). */
export function modelSettingsDraftKeys() { return [...modelDrafts.keys()]; }

const profileKey = (profile, index) => String(profile?.id || profile?.credentialName || index || 'default');
const cloudSnapshot = source => Object.fromEntries(CLOUD_FIELDS.map(key => [key, String(source?.[key] ?? '')]));

/** JSON with recursively sorted object keys, so a field-order change never reads as an edit. */
const stableString = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
  : item);

/** Overlay the window's drafts on the just-loaded saved profiles. */
function restoreModelDrafts(profiles) {
  const restored = [];
  const known = new Set();
  for (const [index, profile] of profiles.entries()) {
    known.add(profileKey(profile, index));
    const draft = modelDrafts.get(profileKey(profile, index));
    if (draft?.kind === MODEL_DRAFT_REMOVED) continue;
    restored.push(draft?.kind === MODEL_DRAFT_EDIT ? { ...profile, ...draft.fields } : profile);
  }
  for (const [key, draft] of modelDrafts) {
    if (draft.kind === MODEL_DRAFT_NEW && !known.has(key)) restored.push(draft.profile);
  }
  return restored.length ? restored : profiles.slice(0, 1);
}

const SOURCE_LABELS = {
  file: '本机保存',
  'legacy-global': '全局配置',
  global: '全局配置',
  workspace: '当前工作区',
  environment: '环境变量',
  'workspace-alias': '当前工作区',
  'global-alias': '全局配置',
  session: '本次会话',
  missing: '未配置',
};

const PROVIDER_LABELS = { ksyun: '金山云模型服务', openai: 'OpenAI' };

/** Reasoner labels shared by the「思考等级」selector and its notices. */
const REASONING_LABELS = { low: '低', medium: '中', high: '高', max: '最高' };

/** One line per provider explaining what the selector actually sends. */
const REASONING_HINTS = {
  ksyun: '金山云接受 low/high/max，按所选值原样发送。',
  deepseek: 'DeepSeek 接受 low/high/max，按所选值原样发送。',
  openai: 'OpenAI 只接受 minimal/low/medium/high；没有「最高 → max」，越界档位不会被发送。',
  codex: 'Codex 只接受 minimal/low/medium/high，「最高」会按 high 发送。',
  custom: '未识别的提供商只提供低/高两档，并按同名值发送，避免上游拒绝非法档位。',
};
const reasoningHint = capability => REASONING_HINTS[capability.provider] || REASONING_HINTS.custom;

export function createModelSettingsSection({
  ui: { React: { createElement: h, useEffect, useState, useRef }, SecretInput, BRAND = DEFAULT_BRAND },
  hostRemote, window = globalThis.window, document = globalThis.document, CustomEvent = globalThis.CustomEvent
}) {
  const Chip = ({ children, tone = 'neutral', ...rest }) => h('span', { className: 'ms-chip', 'data-tone': tone, ...rest }, children);
  const providerLabel = provider => PROVIDER_LABELS[provider] || provider || '自定义提供商';
  const sourceLabel = source => SOURCE_LABELS[source] || source || '未配置';

  function ModelSettingsSection({ dshModel, mode = 'all', onSaved }) {
    const [form, setForm] = useState({
      profiles: [{ id: 'default', provider: 'ksyun', baseUrl: DEFAULT_KSYUN_BASE_URL, modelName: DEFAULT_KSYUN_MODEL, credentialName: DSH_MODEL_CREDENTIAL, apiKey: '', enabled: true, default: true }],
      cloudAccessKey: '', cloudSecretKey: '', cloudAccountId: '', cloudRegion: '', cloudServerUrl: '', cloudBucket: '',
    });
    const [modelStatus, setModelStatus] = useState({});
    const [modelCatalogs, setModelCatalogs] = useState({});
    const [connectionStatus, setConnectionStatus] = useState({});
    const [cloudStatus, setCloudStatus] = useState({ configured: false, source: 'missing' });
    const [dshStatus, setDshStatus] = useState({ configured: false, model: '', credentialConfigured: false });
    const [status, setStatus] = useState('loading');
    const [message, setMessage] = useState('');
    const [error, setError] = useState('');
    const [saving, setSaving] = useState(false);
    const [selectedKey, setSelectedKey] = useState('');
    // The last configuration the Host confirmed; drafts are compared against it.
    const [savedState, setSavedState] = useState({ profiles: [], cloud: {} });
    const pendingProviderFocus = typeof useRef === 'function' ? useRef('') : { current: '' };
    const selectionRef = typeof useRef === 'function' ? useRef('') : { current: '' };
    selectionRef.current = selectedKey;

    const runtimeProfiles = profiles => profiles.map(profile => {
      const { apiKey: _apiKey, inputCapability: _inputCapability, ...runtimeProfile } = profile;
      return runtimeProfile;
    });

    const hydrateModelInputs = async profiles => Promise.all(profiles.map(async profile => {
      try {
        const catalog = await hostRemote.modelCatalog(profile.id);
        const model = catalog.items.find(item => item.id === profile.modelName);
        return model ? { ...profile, ...(model.inputKnown === false ? {} : { input: model.input || ['text'] }), inputCapability: model.inputKnown === false ? 'unknown' : 'catalog' }
          : { ...profile, inputCapability: 'missing' };
      } catch {
        return { ...profile, inputCapability: 'unavailable' };
      }
    }));

    const load = async ({ discardDrafts = false } = {}) => {
      setStatus('loading'); setError('');
      if (discardDrafts) clearModelSettingsDrafts();
      try {
        const [settings, dshDocument] = await Promise.all([hostRemote.settings(), dshModel.describe()]);
        const legacy = { id: 'default', provider: settings?.modelProvider || 'ksyun', modelName: settings?.modelName || DEFAULT_KSYUN_MODEL, baseUrl: settings?.modelBaseUrl || (settings?.modelProvider === 'ksyun' ? DEFAULT_KSYUN_BASE_URL : ''), credentialName: DSH_MODEL_CREDENTIAL, enabled: true };
        const loaded = (Array.isArray(settings?.modelProfiles) && settings.modelProfiles.length ? settings.modelProfiles : [legacy]);
        const activeDefaultIndex = loaded.findIndex(profile => profile.enabled !== false && profile.default === true);
        const firstEnabledIndex = loaded.findIndex(profile => profile.enabled !== false);
        const defaultIndex = activeDefaultIndex >= 0 ? activeDefaultIndex : firstEnabledIndex >= 0 ? firstEnabledIndex : 0;
        const profiles = loaded.map((profile, index) => ({ ...legacy, ...profile, id: modelProfileId(profile, index), credentialName: modelCredentialName(profile, index), default: index === defaultIndex, apiKey: '' }));
        const discoveredProfiles = await hydrateModelInputs(profiles);
        if (discoveredProfiles.some((profile, index) => JSON.stringify(profile.input || ['text']) !== JSON.stringify(profiles[index].input || ['text']))) {
          // Repair profiles saved before nested architecture.input_modalities
          // was recognized, and immediately refresh DSH's provider route.
          const persistedProfiles = runtimeProfiles(discoveredProfiles);
          await hostRemote.updateSettings({ modelProfiles: persistedProfiles }).catch(() => {});
          await dshModel.applyProfiles({ profiles: persistedProfiles, keys: {} }).catch(() => {});
        }
        const credentialStatuses = await Promise.all(profiles.map(async profile => [profile.credentialName, await dshModel.credentialStatus(profile.credentialName).catch(() => ({ configured: false }))]));
        const statusMap = Object.fromEntries(credentialStatuses);
        setModelStatus(statusMap);
        setCloudStatus({ configured: Boolean(settings?.cloudAccountConfigured), source: settings?.configurationSources?.cloudAccessKey || 'missing' });
        const dshProfile = (dshDocument?.namespaces || []).find(item => item.ns === DSH_MODEL_SETTINGS_NS)?.value?.providers;
        const firstDsh = dshProfile ? Object.values(dshProfile)[0] : null;
        setDshStatus({ configured: Boolean(firstDsh?.models?.length), model: firstDsh?.models?.[0]?.id || '', credentialConfigured: Boolean(statusMap[discoveredProfiles[0].credentialName]?.configured) });
        // Saved profiles are the comparison baseline; the editor shows the same
        // list with this window's drafts laid back over it.
        const restoredProfiles = restoreModelDrafts(discoveredProfiles);
        const restoredDefaultIndex = restoredProfiles.findIndex(profile => profile.enabled !== false && profile.default === true);
        const restoredEnabledIndex = restoredProfiles.findIndex(profile => profile.enabled !== false);
        const fallbackIndex = restoredDefaultIndex >= 0 ? restoredDefaultIndex : restoredEnabledIndex >= 0 ? restoredEnabledIndex : 0;
        const keptIndex = restoredProfiles.findIndex((profile, index) => profileKey(profile, index) === selectionRef.current);
        const selectionIndex = keptIndex >= 0 ? keptIndex : fallbackIndex;
        setSavedState({ profiles: discoveredProfiles, cloud: cloudSnapshot(settings) });
        setForm(current => ({ ...current, profiles: restoredProfiles, cloudAccountId: settings?.cloudAccountId || '', cloudRegion: settings?.cloudRegion || '', cloudServerUrl: settings?.cloudServerUrl || '', cloudBucket: settings?.cloudBucket || '' }));
        setSelectedKey(profileKey(restoredProfiles[selectionIndex], selectionIndex));
        setStatus('ready');
      } catch (reason) { setStatus('error'); setError(reason?.message || 'Host 尚未连接'); }
    };
    useEffect(() => { load(); }, []);
    useEffect(() => ensureModelSettingsStyles(document), []);
    useEffect(() => {
      const profileId = pendingProviderFocus.current;
      if (!profileId || !window?.document?.querySelectorAll) return;
      const provider = [...window.document.querySelectorAll('[data-model-provider]')].find(node => node.getAttribute('data-model-provider') === profileId);
      if (provider) { provider.focus(); pendingProviderFocus.current = ''; }
    }, [form.profiles.length]);
    const setField = (key, value) => setForm(current => ({ ...current, [key]: value }));

    const savedProfile = key => (savedState.profiles || []).find((profile, index) => profileKey(profile, index) === key);
    const isNewProfile = (profile, index) => Boolean(profile) && !savedProfile(profileKey(profile, index));
    // Capability discovery (模型目录识别出的 input) is derived metadata, not an
    // edit: reading the catalog must not by itself raise the unsaved chip.
    const editableProfile = ({ input: _input, inputCapability: _inputCapability, ...profile }) => profile;
    /** A profile is edited when it differs from the last configuration the Host confirmed. */
    const isDirtyProfile = (profile, index) => {
      if (!profile) return false;
      const persisted = savedProfile(profileKey(profile, index));
      return persisted ? stableString(editableProfile(profile)) !== stableString(editableProfile(persisted)) : true;
    };
    const cloudIsDirty = () => CLOUD_FIELDS.some(key => String(form[key] ?? '') !== String(savedState.cloud?.[key] ?? ''));
    // 方案 C：任何字段改动先写进这张内存草稿表，再更新编辑区视图；只有
    // 「保存配置」会调用 Host 存储。
    const rememberDraft = (profile, index, fields) => {
      if (!profile) return;
      const key = profileKey(profile, index);
      if (isNewProfile(profile, index)) {
        const previous = modelDrafts.get(key);
        // `returnTo` remembers which model to re-select when this new draft is cancelled.
        modelDrafts.set(key, { kind: MODEL_DRAFT_NEW, profile: { ...profile, ...fields }, ...(previous?.returnTo ? { returnTo: previous.returnTo } : {}) });
        return;
      }
      const previous = modelDrafts.get(key);
      modelDrafts.set(key, { kind: MODEL_DRAFT_EDIT, fields: { ...(previous?.kind === MODEL_DRAFT_EDIT ? previous.fields : {}), ...fields } });
    };
    const setProfile = (index, key, value) => {
      const fields = { [key]: value, ...(['modelName', 'provider', 'baseUrl'].includes(key) ? { input: undefined, inputCapability: 'pending' } : {}) };
      rememberDraft(form.profiles[index], index, fields);
      setForm(current => ({ ...current, profiles: current.profiles.map((profile, cursor) => cursor === index ? { ...profile, ...fields } : profile) }));
    };
    // Keep the historical ‘添加提供商或模型’ wording in source for older surface checks; the visible action is now ‘添加模型’.
    const addProfile = () => {
      const id = `profile-${Date.now()}`;
      const profile = { id, provider: 'ksyun', baseUrl: DEFAULT_KSYUN_BASE_URL, modelName: '', credentialName: `AGENTKIT_MODEL_API_KEY_${Date.now().toString(36).toUpperCase()}`, apiKey: '', enabled: true, default: false };
      pendingProviderFocus.current = id;
      modelDrafts.set(profileKey(profile), { kind: MODEL_DRAFT_NEW, profile, returnTo: selectionRef.current });
      setSelectedKey(id);
      setForm(current => ({ ...current, profiles: [...current.profiles, profile] }));
    };
    const setDefaultProfile = index => {
      form.profiles.forEach((profile, cursor) => {
        if ((cursor === index) !== (profile.default === true)) rememberDraft(profile, cursor, { default: cursor === index });
      });
      setForm(current => ({ ...current, profiles: current.profiles.map((profile, cursor) => ({ ...profile, default: cursor === index })) }));
    };
    const toggleProfileEnabled = index => {
      const target = form.profiles[index];
      if (!target) return;
      if (target.enabled !== false && form.profiles.filter(profile => profile.enabled !== false).length <= 1) {
        setError('至少保留一个启用的模型');
        return;
      }
      setError('');
      const enabling = target.enabled === false;
      const flipped = form.profiles.map((profile, cursor) => cursor === index ? { ...profile, enabled: enabling } : { ...profile });
      const enabledIndexes = flipped.map((profile, cursor) => profile.enabled !== false ? cursor : -1).filter(cursor => cursor >= 0);
      const activeDefault = flipped.findIndex(profile => profile.enabled !== false && profile.default === true);
      const fallbackDefault = activeDefault >= 0 ? activeDefault : enabledIndexes[0];
      const next = flipped.map((profile, cursor) => ({ ...profile, default: cursor === fallbackDefault }));
      next.forEach((profile, cursor) => {
        const before = form.profiles[cursor];
        const fields = {};
        if (profile.enabled !== before.enabled) fields.enabled = profile.enabled;
        if (profile.default !== before.default) fields.default = profile.default;
        if (Object.keys(fields).length) rememberDraft(profile, cursor, fields);
      });
      setForm(current => ({ ...current, profiles: next }));
    };
    const removeProfile = index => {
      if (form.profiles.length <= 1) return;
      const target = form.profiles[index];
      const remaining = form.profiles.filter((_, cursor) => cursor !== index);
      const neighbourIndex = Math.min(index, remaining.length - 1);
      const removedDefault = target?.default === true;
      const next = removedDefault ? remaining.map((profile, cursor) => ({ ...profile, default: cursor === 0 })) : remaining;
      // A pending removal is a draft too: it survives closing the sheet and only
      // reaches storage on 「保存配置」; 「重新读取」 brings the model back.
      if (target) {
        if (isNewProfile(target, index)) modelDrafts.delete(profileKey(target, index));
        else modelDrafts.set(profileKey(target, index), { kind: MODEL_DRAFT_REMOVED });
      }
      if (removedDefault && next[0]) rememberDraft(next[0], 0, { default: true });
      if (remaining[neighbourIndex]) setSelectedKey(profileKey(remaining[neighbourIndex], neighbourIndex));
      setForm(current => ({ ...current, profiles: next }));
    };
    // 取消新增：这份新草稿还没进过存储，直接丢弃，列表与选中项回到添加前。
    const cancelProfile = index => {
      const target = form.profiles[index];
      if (!target) return;
      const draft = modelDrafts.get(profileKey(target, index));
      modelDrafts.delete(profileKey(target, index));
      if (pendingProviderFocus.current === target.id) pendingProviderFocus.current = '';
      const remaining = form.profiles.filter((_, cursor) => cursor !== index);
      const returnIndex = draft?.returnTo ? remaining.findIndex((profile, cursor) => profileKey(profile, cursor) === draft.returnTo) : -1;
      const neighbourIndex = returnIndex >= 0 ? returnIndex : Math.min(index, remaining.length - 1);
      if (remaining[neighbourIndex]) setSelectedKey(profileKey(remaining[neighbourIndex], neighbourIndex));
      setForm(current => ({ ...current, profiles: remaining }));
    };
    // 撤销修改：只丢掉当前模型的草稿，回到已保存的那份配置。
    const revertProfile = index => {
      const target = form.profiles[index];
      if (!target) return;
      if (isNewProfile(target, index)) { cancelProfile(index); return; }
      const persisted = savedProfile(profileKey(target, index));
      modelDrafts.delete(profileKey(target, index));
      if (!persisted) return;
      setForm(current => ({ ...current, profiles: current.profiles.map((profile, cursor) => cursor === index ? { ...persisted } : profile) }));
    };
    const save = async event => {
      event.preventDefault(); if (saving || status !== 'ready') return;
      setSaving(true); setMessage(''); setError('');
      try {
        if (mode === 'cloud') {
          const access = form.cloudAccessKey.trim(), secret = form.cloudSecretKey.trim();
          if (!cloudStatus.configured && (!access || !secret)) throw new Error('请填写 Access Key 和 Secret Key，或跳过云端配置');
          await hostRemote.updateSettings({ ...(access ? { cloudAccessKey: access } : {}), ...(secret ? { cloudSecretKey: secret } : {}), cloudAccountId: form.cloudAccountId.trim(), cloudRegion: form.cloudRegion.trim(), cloudServerUrl: form.cloudServerUrl.trim(), cloudBucket: form.cloudBucket.trim() });
          setForm(current => ({ ...current, cloudAccessKey: '', cloudSecretKey: '' }));
          setSavedState(current => ({ ...current, cloud: { ...cloudSnapshot(form), cloudAccessKey: '', cloudSecretKey: '' } }));
          setMessage('云端凭证已保存');
          onSaved?.();
          return;
        }
        const rawProfiles = form.profiles.map((profile, index) => ({ ...modelRuntimeOptions(profile),
          ...(typeof profile.displayName === 'string' ? { displayName: profile.displayName } : {}),
          id: modelProfileId(profile, index), provider: profile.provider.trim() || 'ksyun', modelName: profile.modelName.trim(), baseUrl: normalizeModelEndpoint(profile.baseUrl, profile.provider), credentialName: modelCredentialName(profile, index), enabled: profile.enabled !== false, default: profile.default === true, codexApi: profile.codexApi || 'responses', input: profile.input || ['text'], ...(profile.reasoningEfforts ? { reasoningEfforts: true, defaultReasoningEffort: profile.defaultReasoningEffort || reasoningProfileFor(profile.provider).default } : {}) }));
        const activeDefaultIndex = rawProfiles.findIndex(profile => profile.enabled !== false && profile.default);
        const firstEnabledIndex = rawProfiles.findIndex(profile => profile.enabled !== false);
        const defaultIndex = activeDefaultIndex >= 0 ? activeDefaultIndex : firstEnabledIndex;
        if (defaultIndex < 0) throw new Error('至少保留一个启用的模型');
        const profiles = rawProfiles.map((profile, index) => ({ ...profile, default: index === defaultIndex }));
        if (profiles.some(profile => !profile.modelName)) throw new Error('每个模型配置都需要填写模型名称');
        const keys = Object.fromEntries(form.profiles.map((profile, index) => [modelCredentialName(profile, index), String(profile.apiKey || '').trim()]).filter(([, value]) => value));
        const first = profiles.find(profile => profile.default === true) || profiles[0];
        if (mode === 'model' && !keys[first.credentialName] && !modelStatus[first.credentialName]?.configured) throw new Error('请填写模型 API Key');
        const payload = { modelProvider: first.provider, modelBaseUrl: first.baseUrl, modelName: first.modelName, modelProfiles: profiles, modelProfileKeys: keys, cloudAccountId: form.cloudAccountId.trim(), cloudRegion: form.cloudRegion.trim(), cloudServerUrl: form.cloudServerUrl.trim(), cloudBucket: form.cloudBucket.trim() };
        if (form.cloudAccessKey?.trim()) payload.cloudAccessKey = form.cloudAccessKey.trim();
        if (form.cloudSecretKey?.trim()) payload.cloudSecretKey = form.cloudSecretKey.trim();
        await hostRemote.updateSettings(payload);
        await hostRemote.syncModelCredential();
        const discoveredProfiles = await hydrateModelInputs(profiles);
        const persistedProfiles = runtimeProfiles(discoveredProfiles);
        await hostRemote.updateSettings({ modelProfiles: persistedProfiles });
        await dshModel.applyProfiles({ profiles: persistedProfiles, keys });
        // The Host now holds these values: every draft has served its purpose.
        clearModelSettingsDrafts();
        setForm(current => ({ ...current, profiles: current.profiles.map(profile => ({ ...profile, apiKey: '' })), cloudAccessKey: '', cloudSecretKey: '' }));
        window.dispatchEvent(new CustomEvent('agentkit-studio:model-credential-changed'));
        setMessage('已保存多个模型配置；标记为“默认”的模型用于新会话，Agent 可在创建或编辑时多选模型绑定。');
        await load();
        onSaved?.();
      } catch (reason) { setError(reason?.message || '保存模型与凭证失败'); } finally { setSaving(false); }
    };
    // 重新读取：显式回到存储里的配置，因此丢弃全部草稿；丢弃过就说明白。
    const reload = async () => {
      const discarded = modelDrafts.size;
      setMessage('');
      await load({ discardDrafts: true });
      if (discarded) setMessage('已丢弃未保存的草稿，并重新读取已保存的配置');
    };

    const profiles = form.profiles;
    const selectedIndex = (() => {
      const found = profiles.findIndex((profile, index) => profileKey(profile, index) === selectedKey);
      if (found >= 0) return found;
      const defaultIndex = profiles.findIndex(profile => profile.enabled !== false && profile.default === true);
      return defaultIndex >= 0 ? defaultIndex : 0;
    })();
    const selected = profiles[selectedIndex] || profiles[0];
    // 思考等级的单一数据源在 src/model-reasoning.mjs：这里只负责把该提供商
    // 支持的档位、默认档和实际发送值呈现出来，不再硬编码任何 wire 值。
    const reasoningFor = profile => {
      const declared = profile?.reasoningEfforts;
      if (declared && typeof declared === 'object' && !Array.isArray(declared)) {
        const resolved = studioReasoning(profile);
        if (resolved) return resolved;
      }
      return studioReasoning({ ...profile, reasoningEfforts: true });
    };
    const reasoningCapability = reasoningProfileFor(selected?.provider);
    const selectedReasoning = reasoningFor(selected);
    const reasoningLevels = Object.keys(selectedReasoning.efforts);
    const reasoningValue = selected?.reasoningEfforts
      ? (selectedReasoning.efforts[selected.defaultReasoningEffort] ? selected.defaultReasoningEffort : selectedReasoning.defaultEffort)
      : '';
    const reasoningWire = reasoningValue ? selectedReasoning.efforts[reasoningValue] : '';
    const defaultProfile = profiles.find(profile => profile.enabled !== false && profile.default) || profiles.find(profile => profile.enabled !== false) || profiles[0];
    const profileCredential = profile => modelStatus[profile.credentialName] || {};
    const profileStatus = profile => profile.enabled === false ? { tone: 'neutral', label: '已停用' } : profileCredential(profile).configured ? { tone: 'success', label: '已配置' } : { tone: 'warn', label: '需要配置' };
    const profileCatalogKey = profile => String(profile.id || profile.credentialName || 'default');
    const catalogItemsFor = profile => modelCatalogs[profileCatalogKey(profile)] || [];
    const connectionFor = profile => connectionStatus[profileCatalogKey(profile)] || {};
    const candidateFor = profile => ({
      provider: profile.provider || 'custom',
      baseUrl: normalizeModelEndpoint(profile.baseUrl, profile.provider),
      modelName: String(profile.modelName || '').trim(),
      apiKey: String(profile.apiKey || '').trim(),
    });
    const readModelCatalog = async index => {
      const profile = form.profiles[index];
      if (!profile) return;
      const key = profileCatalogKey(profile);
      setConnectionStatus(current => ({ ...current, [key]: { state: 'loading', message: '正在读取模型目录…' } }));
      try {
        const apiKey = String(profile.apiKey || '').trim();
        let catalog;
        if (apiKey && typeof hostRemote.probeModelEndpoint === 'function') {
          catalog = await hostRemote.probeModelEndpoint(candidateFor(profile));
        } else if (profileCredential(profile).configured && typeof hostRemote.modelCatalog === 'function') {
          catalog = await hostRemote.modelCatalog(profile.id);
        } else {
          throw new Error('请先填写 API Key');
        }
        const items = Array.isArray(catalog?.items) ? catalog.items : [];
        setModelCatalogs(current => ({ ...current, [key]: items }));
        const selectedId = String(profile.modelName || '').trim() || items[0]?.id || '';
        const chosen = items.find(item => item.id === selectedId);
        if (!String(profile.modelName || '').trim() && items[0]?.id)
          setProfile(index, 'modelName', items[0].id);
        if (chosen)
          setForm(current => ({ ...current, profiles: current.profiles.map((item, cursor) => cursor === index ? { ...item, input: chosen.input || ['text'], inputCapability: chosen.inputKnown === false ? 'unknown' : 'catalog' } : item) }));
        setConnectionStatus(current => ({ ...current, [key]: { state: 'success', message: `已读取 ${items.length} 个模型` } }));
      } catch (reason) {
        setConnectionStatus(current => ({ ...current, [key]: { state: 'error', message: reason?.message || '读取模型目录失败' } }));
      }
    };
    const testModelConnection = async index => {
      const profile = form.profiles[index];
      if (!profile) return;
      const key = profileCatalogKey(profile);
      setConnectionStatus(current => ({ ...current, [key]: { state: 'loading', message: '正在测试连接…' } }));
      try {
        let result;
        const apiKey = String(profile.apiKey || '').trim();
        if (apiKey && typeof hostRemote.probeModelEndpoint === 'function') {
          result = await hostRemote.probeModelEndpoint(candidateFor(profile));
        } else if (profileCredential(profile).configured && typeof hostRemote.testModelProfile === 'function') {
          result = await hostRemote.testModelProfile(profile.id);
        } else if (profileCredential(profile).configured && typeof hostRemote.modelCatalog === 'function') {
          result = await hostRemote.modelCatalog(profile.id);
        } else {
          throw new Error('请先填写 API Key');
        }
        const items = Array.isArray(result?.items) ? result.items : [];
        if (items.length) setModelCatalogs(current => ({ ...current, [key]: items }));
        const chosen = String(profile.modelName || '').trim();
        const available = !chosen || !items.length || items.some(item => item.id === chosen);
        setConnectionStatus(current => ({ ...current, [key]: { state: available ? 'success' : 'warning', message: available ? '连接成功' : '连接成功，但当前模型不在目录中' } }));
      } catch (reason) {
        setConnectionStatus(current => ({ ...current, [key]: { state: 'error', message: reason?.message || '连接失败' } }));
      }
    };

    const enabledCount = profiles.filter(profile => profile.enabled !== false).length;
    const configuredCount = profiles.filter(profile => profileCredential(profile).configured).length;
    const showRail = mode === 'all';
    // 方案 C 的提示态：编辑区标题旁的「未保存」chip 与页脚主按钮的醒目态，
    // 都由「当前视图 vs 已保存快照」推导，因此保存成功后自动消失。
    const ready = status === 'ready';
    const selectedDirty = ready && isDirtyProfile(selected, selectedIndex);
    const selectedDraft = selectedDirty && isNewProfile(selected, selectedIndex);
    const draftCount = ready ? profiles.filter((profile, index) => isDirtyProfile(profile, index)).length : 0;
    const cloudDirty = ready && cloudIsDirty();
    const formDirty = draftCount > 0 || cloudDirty;
    const cloudField = (label, key, placeholder, type = 'text') => h('label', { className: 'ms-field' },
      h('span', { className: 'ms-label' }, label),
      h(type === 'password' ? SecretInput : 'input', {
        label, type, className: 'ms-input', value: form[key] || '', placeholder,
        autoComplete: type === 'password' ? 'new-password' : 'off',
        onChange: event => setField(key, event.target.value),
      }));
    const section = (step, title, extra, ...children) => h('section', { className: 'ms-section' },
      h('div', { className: 'ms-section-head' },
        h('span', { className: 'ms-step', 'aria-hidden': 'true' }, String(step)),
        h('h5', { className: 'ms-section-title' }, title),
        extra || null),
      ...children);

    const statusStrip = h('section', { className: 'ms-status', 'data-model-summary': true, 'aria-label': '当前运行模型' },
      h('span', { className: 'ms-status-dot', 'aria-hidden': 'true' }),
      h('span', { className: 'ms-status-label' }, '默认模型'),
      h('span', { className: 'ms-status-model' }, defaultProfile?.modelName || '尚未选择模型'),
      defaultProfile ? h(Chip, { tone: 'accent' }, providerLabel(defaultProfile.provider)) : null,
      h('span', { className: 'ms-status-meta' }, `${profiles.length} 个模型 · ${enabledCount} 个已启用 · ${configuredCount} 个已配置凭证`));

    const rail = h('aside', { className: 'ms-rail', 'aria-label': '模型列表' },
      h('div', { className: 'ms-rail-head' }, h('span', null, '模型'), h('span', { className: 'ms-rail-count' }, String(profiles.length))),
      h('div', { className: 'ms-rail-items' },
        profiles.map((profile, index) => {
          const state = profileStatus(profile);
          const dirty = ready && isDirtyProfile(profile, index);
          return h('button', {
            key: profileKey(profile, index), type: 'button', className: 'ms-rail-item',
            'data-selected': index === selectedIndex ? 'true' : 'false',
            'data-draft': dirty ? 'true' : 'false',
            'aria-current': index === selectedIndex ? 'true' : undefined,
            title: dirty ? '有未保存的修改（仅保存在内存）' : undefined,
            onClick: () => setSelectedKey(profileKey(profile, index)),
          },
            h('span', { className: 'ms-rail-name-row' },
              h('span', { className: 'ms-rail-name' }, profile.modelName || '未命名模型'),
              profile.default && profile.enabled !== false ? h('span', { className: 'ms-chip', 'data-size': 'xs', 'data-tone': 'accent' }, '默认') : null,
              dirty ? h('span', { className: 'ms-rail-draft', 'data-unsaved': 'true', 'aria-hidden': 'true' }) : null),
            h('span', { className: 'ms-rail-sub' },
              h('span', null, providerLabel(profile.provider)),
              h('span', { className: 'ms-dot', 'data-tone': state.tone === 'success' ? 'success' : state.tone === 'warn' ? 'warn' : undefined, 'aria-hidden': 'true' }),
              h('span', null, state.label)));
        })),
      h('p', { className: 'ms-rail-foot' }, '「默认」模型用于新会话；带圆点的模型有未保存草稿'));

    const connection = connectionFor(selected);
    const catalogItems = catalogItemsFor(selected);
    const hasSelectedModel = catalogItems.some(item => item.id === selected.modelName);
    const selectedStatus = profileStatus(selected);
    const modelSelect = catalogItems.length ? h('select', {
      className: 'ms-select',
      'aria-label': '选择模型',
      value: hasSelectedModel ? selected.modelName : '__custom__',
      onChange: event => setProfile(selectedIndex, 'modelName', event.target.value === '__custom__' ? '' : event.target.value),
    }, catalogItems.map(item => h('option', { key: item.id, value: item.id }, item.name || item.id)), h('option', { value: '__custom__' }, '手动填写模型名')) : null;
    const customModel = (!catalogItems.length || !hasSelectedModel) ? h('input', {
      className: 'ms-input',
      'aria-label': catalogItems.length ? '自定义模型名称' : '模型名称',
      value: selected.modelName,
      placeholder: catalogItems.length ? '输入目录外的模型名' : '先读取模型目录，或手动填写',
      onChange: event => setProfile(selectedIndex, 'modelName', event.target.value),
    }) : null;
    const capabilityHint = { unknown: '模型目录未提供能力信息', unavailable: '暂时无法读取模型目录', missing: '模型目录中未找到该模型' }[selected.inputCapability]
      || (status === 'loading' ? '正在读取模型目录…' : '保存后自动识别');
    const capability = h('div', { className: 'ms-capability', 'data-model-input-capability': selected.inputCapability || 'pending' },
      h('span', { className: 'ms-capability-label' }, '输入能力'),
      selected.inputCapability === 'catalog'
        ? [h(Chip, { key: 'text' }, '文字'), selected.input?.includes('image') ? h(Chip, { key: 'image' }, '图片') : null, h('span', { key: 'hint', className: 'ms-hint' }, '模型目录已识别')]
        : h('span', { className: 'ms-hint' }, capabilityHint));

    // 「思考等级」只展示当前提供商支持的档位，选项里直接写出实际发送值：
    // 选「最高」在 Codex 下会显示「最高 → high」，不需要用户猜测降级。
    const reasoningField = h('label', { className: 'ms-field' },
      h('span', { className: 'ms-label' }, '思考等级'),
      h('select', {
        className: 'ms-select',
        'aria-label': '思考等级',
        'data-model-reasoning': reasoningWire,
        value: reasoningValue,
        onChange: event => {
          const level = event.target.value;
          setProfile(selectedIndex, 'reasoningEfforts', level ? true : undefined);
          setProfile(selectedIndex, 'defaultReasoningEffort', level || undefined);
        },
      }, h('option', { value: '' }, '不启用'),
        reasoningLevels.map(level => h('option', { key: level, value: level },
          `${REASONING_LABELS[level] || level} → ${selectedReasoning.efforts[level]}`))),
      h('span', { className: 'ms-hint' }, reasoningValue
        ? `实际发送 reasoning_effort=${reasoningWire}。${reasoningHint(reasoningCapability)}`
        : `不启用时不写入任何思考档位；模型不支持 reasoning_effort 时保持此项为空。${reasoningHint(reasoningCapability)}`));

    const detail = h('article', {
      className: 'ms-detail',
      'data-model-profile-card': selected.id || selectedIndex,
    },
      h('header', { className: 'ms-detail-head' },
        h('div', { className: 'ms-detail-title' },
          h('div', { className: 'ms-detail-name' },
            h('h4', null, h('strong', { className: 'ms-detail-name-text' }, selected.modelName || '新模型')),
            selected.default && selected.enabled !== false ? h(Chip, { tone: 'accent' }, '默认') : null,
            h(Chip, { tone: selectedStatus.tone }, selectedStatus.label),
            selectedDirty ? h(Chip, { tone: 'warn', 'data-unsaved': 'true', title: '草稿只保存在内存里，刷新或关闭窗口后会丢失' }, '未保存') : null),
          h('p', { className: 'ms-detail-meta' }, providerLabel(selected.provider), h('span', { className: 'ms-dot', 'aria-hidden': 'true' }), selected.id || '未命名 profile')),
        h('div', { className: 'ms-detail-actions' },
          selected.default && selected.enabled !== false ? null : h('button', { type: 'button', 'data-size': 'sm', className: 'ms-btn', disabled: selected.enabled === false, onClick: () => setDefaultProfile(selectedIndex) }, '设为默认'),
          h('button', { type: 'button', 'data-size': 'sm', className: 'ms-btn', onClick: () => toggleProfileEnabled(selectedIndex) }, selected.enabled === false ? '启用' : '停用'),
          selectedDirty && !selectedDraft ? h('button', { type: 'button', 'data-size': 'sm', className: 'ms-btn', onClick: () => revertProfile(selectedIndex) }, '撤销修改') : null,
          selectedDraft
            ? h('button', { type: 'button', 'data-size': 'sm', 'data-variant': 'danger', className: 'ms-btn', onClick: () => cancelProfile(selectedIndex) }, '取消')
            : profiles.length <= 1 ? null : h('button', { type: 'button', 'data-size': 'sm', 'data-variant': 'danger', className: 'ms-btn', onClick: () => removeProfile(selectedIndex) }, '移除'))),
      section(1, '连接', null,
        h('div', { className: 'ms-grid ms-grid-2' },
          h('label', { className: 'ms-field' },
            h('span', { className: 'ms-label' }, '提供商'),
            h('select', {
              className: 'ms-select',
              'data-model-provider': selected.id || selectedIndex,
              'aria-label': '提供商',
              value: selected.provider === 'ksyun' || selected.provider === 'openai' ? selected.provider : 'custom',
              onChange: event => {
                const provider = event.target.value;
                const fields = { provider, baseUrl: provider === 'ksyun' ? DEFAULT_KSYUN_BASE_URL : provider === 'openai' ? 'https://api.openai.com/v1' : '', input: undefined, inputCapability: 'pending' };
                // 切换提供商后，原档位可能不在新提供商的枚举里（例如「最高」在
                // OpenAI 下没有 max）：自动落到新提供商的默认档，并给一条
                // 非阻塞提示，而不是等保存后才由上游拒绝。
                const capability = reasoningProfileFor(provider);
                // An explicit object map described the previous provider's wire
                // contract; after a provider switch the new table governs again.
                if (selected.reasoningEfforts && typeof selected.reasoningEfforts === 'object') fields.reasoningEfforts = true;
                if (selected.reasoningEfforts && reasoningValue && !capability.levels.includes(reasoningValue)) {
                  fields.defaultReasoningEffort = capability.default;
                  setMessage(`已切换到${providerLabel(provider)}：思考等级「${REASONING_LABELS[reasoningValue] || reasoningValue}」不受支持，已改为「${REASONING_LABELS[capability.default]}」（发送 ${capability.wire[capability.default]}）。`);
                } else setMessage('');
                rememberDraft(form.profiles[selectedIndex], selectedIndex, fields);
                setForm(current => ({ ...current, profiles: current.profiles.map((item, cursor) => cursor === selectedIndex ? { ...item, ...fields } : item) }));
              },
            }, h('option', { value: 'ksyun' }, '金山云模型服务'), h('option', { value: 'openai' }, 'OpenAI'), h('option', { value: 'custom' }, '自定义提供商'))),
          h('div', { className: 'ms-field' },
            h('span', { className: 'ms-label', id: `ms-base-label-${selectedIndex}` }, 'API 地址'),
            selected.provider === 'ksyun'
              ? h('div', { className: 'ms-static', 'aria-labelledby': `ms-base-label-${selectedIndex}` }, h('span', null, selected.baseUrl || DEFAULT_KSYUN_BASE_URL), h('span', { className: 'ms-chip' }, '默认'))
              : h('input', {
                className: 'ms-input',
                'aria-label': 'API 地址',
                value: selected.baseUrl,
                placeholder: '例如：https://api.example.com/v1',
                onChange: event => setProfile(selectedIndex, 'baseUrl', event.target.value),
                onBlur: () => { try { setProfile(selectedIndex, 'baseUrl', normalizeModelEndpoint(selected.baseUrl, selected.provider)); } catch (reason) { setError(reason.message); } },
              }),
            h('span', { className: 'ms-hint' }, selected.provider === 'ksyun'
              ? '金山云使用官方默认地址，无需填写；切换为「自定义提供商」后可修改。'
              : '兼容 OpenAI 协议的服务地址，例如 https://api.example.com/v1。')))),
      section(2, '凭证', selected.provider === 'ksyun'
        ? h('a', { className: 'ms-link ms-section-extra', href: 'https://ksp.console.ksyun.com/#/apiKey', target: '_blank', rel: 'noopener noreferrer' }, '获取 Key ↗')
        : null,
        h('label', { className: 'ms-field' },
          h('span', { className: 'ms-label' }, 'API Key'),
          h(SecretInput, {
            label: 'API Key', value: selected.apiKey, className: 'ms-input',
            placeholder: profileCredential(selected).configured ? '已配置，留空保持不变' : '先填写 Key，再读取模型',
            autoComplete: 'new-password',
            onChange: event => setProfile(selectedIndex, 'apiKey', event.target.value),
          }),
          h('span', { className: 'ms-hint' }, 'Key 只保存在本机；已配置时留空表示不修改。')),
        h('div', { className: 'ms-actions' },
          h('button', { type: 'button', className: 'ms-btn', onClick: () => readModelCatalog(selectedIndex), disabled: connection.state === 'loading' }, connection.state === 'loading' ? '读取中…' : '读取模型'),
          h('button', { type: 'button', className: 'ms-btn', onClick: () => testModelConnection(selectedIndex), disabled: connection.state === 'loading' }, '测试连接'),
          h('span', { className: 'ms-meta' }, '凭证来源 · ', sourceLabel(profileCredential(selected).source))),
        connection.message ? h('p', { role: 'status', className: 'ms-note', 'data-tone': connection.state === 'error' ? 'danger' : connection.state === 'warning' ? 'warn' : 'success' }, connection.message) : null),
      section(3, '模型', null,
        h('div', { className: 'ms-grid ms-grid-2' },
          h('label', { className: 'ms-field' }, h('span', { className: 'ms-label' }, '模型名称'), modelSelect, customModel,
            h('span', { className: 'ms-hint' }, catalogItems.length ? '可从目录选择，也可以手动填写目录外的模型名。'
              : profileCredential(selected).configured ? '点击「读取模型」从目录中选择，也可以直接手写模型名。'
                : '填写 API Key 后点击「读取模型」，也可以直接手写模型名。')),
          reasoningField),
        capability),
      section(4, '高级', null,
        h('details', { className: 'ms-advanced' },
          h('summary', null, '连接与思考模式'),
          h('div', { className: 'ms-grid ms-grid-2' },
            h('label', { className: 'ms-field' },
              h('span', { className: 'ms-label' }, 'Codex 连接协议'),
              h('select', {
                className: 'ms-select', 'aria-label': 'Codex 连接协议',
                value: selected.codexApi || 'responses',
                onChange: event => setProfile(selectedIndex, 'codexApi', event.target.value),
              }, h('option', { value: 'responses' }, 'Responses'), h('option', { value: 'chat-completions' }, 'Chat Completions'))),
            h('label', { className: 'ms-field' },
              h('span', { className: 'ms-label' }, 'Native 思考模式'),
              h('select', {
                className: 'ms-select', 'aria-label': 'Native 思考模式',
                value: selected.parameters?.thinking?.type || 'default',
                onChange: event => {
                  const parameters = { ...(selected.parameters || {}) };
                  if (event.target.value === 'default') delete parameters.thinking;
                  else parameters.thinking = { type: event.target.value };
                  setProfile(selectedIndex, 'parameters', parameters);
                },
              }, h('option', { value: 'default' }, '服务默认'), h('option', { value: 'enabled' }, '开启'), h('option', { value: 'disabled' }, '关闭')))),
          h('p', { className: 'ms-hint' }, '连接协议只影响 Codex 运行时；思考模式需要服务支持，界面只展示模型实际返回的思考。'))));

    const modelPanel = mode !== 'cloud' ? h('section', { className: 'ms-model' },
      h('div', { className: 'ms-intro' },
        h('div', null,
          h('h3', null, '模型与提供商'),
          h('p', null, '配置提供商、凭证与模型；标记为「默认」的模型用于新会话。')),
        mode === 'all' ? h('button', { type: 'button', 'data-size': 'sm', className: 'ms-btn', onClick: addProfile }, '＋ 添加模型') : null),
      statusStrip,
      h('div', { className: 'ms-panel', 'data-rail': showRail ? 'true' : 'false' }, showRail ? rail : null, detail)) : null;

    const cloudSection = mode !== 'model' ? h('section', { className: 'ms-cloud', 'data-solo': mode === 'cloud' ? 'true' : 'false' },
      h('div', { className: 'ms-cloud-head' },
        h('div', null,
          h('div', { className: 'ms-cloud-title' }, h('h4', null, '云端凭证'), h(Chip, { tone: cloudStatus.configured ? 'success' : 'warn' }, cloudStatus.configured ? '已配置' : '未配置'),
            cloudDirty ? h(Chip, { tone: 'warn', 'data-unsaved': 'true', title: '草稿只保存在内存里，刷新或关闭窗口后会丢失' }, '未保存') : null),
          h('p', null, '用于构建、部署和资源访问，只保存在本机。'))),
      h('div', { className: 'ms-grid ms-grid-2' },
        cloudField('Access Key', 'cloudAccessKey', cloudStatus.configured ? '已配置，留空保持不变' : '云端 Access Key', 'password'),
        cloudField('Secret Key', 'cloudSecretKey', cloudStatus.configured ? '已配置，留空保持不变' : '云端 Secret Key', 'password')),
      h('details', { className: 'ms-advanced' },
        h('summary', null, '高级云端设置'),
        h('div', { className: 'ms-grid ms-grid-2' },
          cloudField('Account ID', 'cloudAccountId', '可选'),
          cloudField('区域', 'cloudRegion', '例如：cn-beijing-6'),
          cloudField('控制面地址', 'cloudServerUrl', '例如：https://agentengine.example.com'),
          cloudField('对象存储桶', 'cloudBucket', '可选'))),
      h('p', { className: 'ms-hint' }, '当前来源：', sourceLabel(cloudStatus.source))) : null;

    return h('div', { 'data-studio-model-settings': true, 'data-onboarding-mode': mode, style: { color: BRAND.ink, minWidth: 0 } },
      h('form', { onSubmit: save, className: 'ms-form', noValidate: true },
        status === 'error' ? h('p', { role: 'alert', className: 'ms-alert' }, error) : null,
        modelPanel,
        cloudSection,
        h('div', { 'data-studio-form-footer': true, className: 'ms-footer' },
          h('div', { className: 'ms-footer-notes' },
            message ? h('span', { role: 'status', className: 'ms-footer-note' }, message) : null,
            error && status !== 'error' ? h('span', { role: 'alert', className: 'ms-footer-note', 'data-tone': 'danger' }, error) : null,
            formDirty ? h('span', { className: 'ms-footer-note', 'data-tone': 'draft' }, '有未保存的改动 · 草稿仅保存在内存，刷新后丢失') : null),
          h('button', { type: 'button', className: 'ms-btn', onClick: reload }, '重新读取'),
          h('button', { type: 'submit', 'data-size': 'lg', 'data-variant': 'primary', 'data-dirty': formDirty ? 'true' : 'false', className: 'ms-btn', disabled: saving || status !== 'ready' }, saving ? '保存中…' : mode === 'model' ? '保存并继续' : mode === 'cloud' ? '保存并完成' : '保存配置'))));
  }
  return ModelSettingsSection;
}
