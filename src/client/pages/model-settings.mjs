import { DEFAULT_KSYUN_BASE_URL, DEFAULT_KSYUN_MODEL, DSH_MODEL_CREDENTIAL, modelCredentialName, modelProfileId } from '../dsh/model-bridge.mjs';
import { BRAND as DEFAULT_BRAND } from '../theme.mjs';
import { normalizeModelEndpoint } from '../../model-endpoint.mjs';
import { resolveModelBudgets } from '../../model-capabilities.mjs';
import { lookupModelCapabilities, setModelCapabilityCatalog } from '../../model-capability-catalog.mjs';
import { renderCapabilitySummary, applicableProbeLevels, createApplyProbeLevels, renderRemoveButton, saveFailureMessage, applyProfilesWithRollback, createProbeAllJobs, applyAllProbeResults, createProbeAll, renderCloudField } from './model-settings-capability.mjs';
import { profileKey, headerRowId, headerRows, headerRecord, headerRowProblem, stableString, clearModelEffortRange,
  normalizedConnectionAddress, connectionIdentity, modelConnections, connectionSource, BUDGET_KEYS, budgetDraft, modelProfilePayload } from './model-settings-profiles.mjs';
import { createModelSettingsDirectory, useModelSettingsCards } from './model-settings-directory.mjs';
import { createUseEffortProbe, REASONING_LABELS, renderModelEffortSettings } from './model-settings-effort-probe.mjs';
import { bindProviders, checkImportedWires, clearProviderDrafts, importedProfiles, keepDefaultModel, providerDraftCount,
  providerMetadata, rememberProviders, restoreProviders, updateProvider } from './model-provider-drafts.mjs';
import { modelReasoningConfig, reasoningProfileFor, studioReasoning } from '../../model-reasoning.mjs';
import { leaseDocumentResource } from '../dsh/document-resource.mjs';
import modelSettingsStyles from '../styles/model-settings.css.mjs';
import { renderProfileScores } from './model-card-view.mjs';
import modelCardStyles from '../styles/model-card.css.mjs';

/** The settings sheet is a document-level asset shared by every mount. */
function ensureModelSettingsStyles(document) {
  if (!document?.head) return () => {};
  return leaseDocumentResource(document, 'agentkit-studio:model-settings', () => {
    if (document.querySelector('style[data-agentkit-studio-model-settings]')) return () => {};
    const style = document.createElement('style');
    style.setAttribute('data-agentkit-studio-model-settings', 'true');
    style.textContent = modelSettingsStyles + modelCardStyles;
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
let modelProfileSequence = 0;
const newProfileId = () => `profile-${Date.now().toString(36)}-${++modelProfileSequence}`;

/** Forget every in-memory draft (tests, and any surface that discards drafts). */
export function clearModelSettingsDrafts() { modelDrafts.clear(); clearProviderDrafts(); }

/** The model ids that currently hold an in-memory draft (tests/diagnostics). */
export function modelSettingsDraftKeys() { return [...modelDrafts.keys()]; }

const cloudSnapshot = source => Object.fromEntries(CLOUD_FIELDS.map(key => [key, String(source?.[key] ?? '')]));

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

const PROVIDER_LABELS = { ksyun: '金山云模型服务', openai: 'OpenAI', custom: '自定义提供商', 'openai-compatible': 'OpenAI 兼容' };

export function createModelSettingsSection({
  ui: { React: { createElement: h, useEffect, useState, useRef }, SecretInput, DisclosureRow, Tag, InfoIcon, BRAND = DEFAULT_BRAND },
  hostRemote, window = globalThis.window, document = globalThis.document, CustomEvent = globalThis.CustomEvent
}) {
  const Chip = ({ children, tone = 'neutral', ...rest }) => h('span', { className: 'ms-chip', 'data-tone': tone, ...rest }, children);
  const providerLabel = provider => PROVIDER_LABELS[provider] || provider || '自定义提供商';
  const sourceLabel = source => SOURCE_LABELS[source] || source || '未配置';
  const useEffortProbe = createUseEffortProbe({ useState, useRef, useEffect });
  const { useModelSettingsDirectory, backButton } = createModelSettingsDirectory({
    h, useState, useEffect, useRef, useEffortProbe, Chip, SecretInput, providerLabel, makeId: newProfileId, DisclosureRow, Tag, InfoIcon,
  });

  function ModelSettingsSection({ dshModel, mode = 'all', onSaved, simple = false }) {
    const [form, setForm] = useState({
      profiles: [{ id: 'default', provider: 'ksyun', baseUrl: DEFAULT_KSYUN_BASE_URL, modelName: DEFAULT_KSYUN_MODEL, credentialName: DSH_MODEL_CREDENTIAL, apiKey: '', enabled: true, default: true }],
      providers: [],
      cloudAccessKey: '', cloudSecretKey: '', cloudAccountId: '', cloudRegion: '', cloudServerUrl: '', cloudBucket: '',
    });
    const [modelStatus, setModelStatus] = useState({});
    const [modelCatalogs, setModelCatalogs] = useState({});
    // Whether each profile's model implements `/v1/responses`. Read-only: the
    // probe reports a recommendation and never writes the profile by itself.
    const [wireProbes, setWireProbes] = useState({});
    const [connectionStatus, setConnectionStatus] = useState({});
    const [cloudStatus, setCloudStatus] = useState({ configured: false, source: 'missing' });
    const [status, setStatus] = useState('loading');
    const [message, setMessage] = useState('');
    const [error, setError] = useState('');
    const [saving, setSaving] = useState(false);
    const saveLock = typeof useRef === 'function' ? useRef(false) : { current: false };
    const [selectedKey, setSelectedKey] = useState('');
    const [editing, setEditing] = useState(false);
    // The last configuration the Host confirmed; drafts are compared against it.
    const [savedState, setSavedState] = useState({ profiles: [], providers: [], storedProviders: [], cloud: {} });
    const selectionRef = typeof useRef === 'function' ? useRef('') : { current: '' };
    const addressAtFocus = typeof useRef === 'function' ? useRef(null) : { current: null };
    const profilesRef = typeof useRef === 'function' ? useRef(form.profiles) : { current: form.profiles };
    selectionRef.current = selectedKey;
    profilesRef.current = form.profiles;

    const runtimeProfiles = profiles => profiles.map(profile => {
      const { apiKey: _apiKey, inputCapability: _inputCapability, ...runtimeProfile } = profile;
      return runtimeProfile;
    });

    const hydrateModelInputs = async profiles => {
      const discovered = [...profiles];
      await Promise.all(modelConnections(profiles).map(async ({ models }) => {
        const enabled = models.find(({ profile }) => profile.enabled !== false)?.profile;
        let items;
        if (enabled) {
          try {
            const catalog = await hostRemote.modelCatalog(enabled.id);
            items = new Map(catalog.items.map(item => [item.id, item]));
          } catch { /* The stored input capability is still usable. */ }
        }
        for (const { profile, index } of models) {
          const model = items?.get(profile.modelName);
          discovered[index] = model
            ? { ...profile, ...(model.inputKnown === false ? {} : { input: model.input || ['text'] }), inputCapability: model.inputKnown === false ? 'unknown' : 'catalog' }
            : { ...profile, inputCapability: items ? 'missing' : 'unavailable' };
        }
      }));
      return discovered;
    };

    const load = async ({ discardDrafts = false } = {}) => {
      setStatus('loading'); setError('');
      if (discardDrafts) clearModelSettingsDrafts();
      try {
        const settings = await hostRemote.settings();
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
        const storedProviders = settings?.modelConnections || [];
        const groups = modelConnections(discoveredProfiles, storedProviders);
        const providers = groups.map(group => group.connection);
        const boundProfiles = bindProviders(discoveredProfiles, groups);
        const credentials = [...new Set(providers.map(item => item.credentialName))];
        const credentialStatuses = await Promise.all(credentials.map(async name => [name, await dshModel.credentialStatus(name).catch(() => ({ configured: false }))]));
        const statusMap = Object.fromEntries(credentialStatuses);
        setModelStatus(statusMap);
        setCloudStatus({ configured: Boolean(settings?.cloudAccountConfigured), source: settings?.configurationSources?.cloudAccessKey || 'missing' });
        // Saved profiles are the comparison baseline; the editor shows the same
        // list with this window's drafts laid back over it.
        const restoredProfiles = restoreModelDrafts(boundProfiles);
        const restoredDefaultIndex = restoredProfiles.findIndex(profile => profile.enabled !== false && profile.default === true);
        const restoredEnabledIndex = restoredProfiles.findIndex(profile => profile.enabled !== false);
        const fallbackIndex = restoredDefaultIndex >= 0 ? restoredDefaultIndex : restoredEnabledIndex >= 0 ? restoredEnabledIndex : 0;
        const keptIndex = restoredProfiles.findIndex((profile, index) => profileKey(profile, index) === selectionRef.current);
        const selectionIndex = keptIndex >= 0 ? keptIndex : fallbackIndex;
        setSavedState({ profiles: boundProfiles, providers, storedProviders, cloud: cloudSnapshot(settings) });
        setForm(current => ({ ...current, profiles: restoredProfiles, providers: restoreProviders(providers), cloudAccountId: settings?.cloudAccountId || '', cloudRegion: settings?.cloudRegion || '', cloudServerUrl: settings?.cloudServerUrl || '', cloudBucket: settings?.cloudBucket || '' }));
        setSelectedKey(profileKey(restoredProfiles[selectionIndex], selectionIndex));
        setStatus('ready');
      } catch (reason) { setStatus('error'); setError(reason?.message || 'Host 尚未连接'); }
    };
    useEffect(() => { load(); }, []);
    useEffect(() => ensureModelSettingsStyles(document), []);
    const setField = (key, value) => setForm(current => ({ ...current, [key]: value }));

    const savedProfiles = new Map(savedState.profiles.map((profile, index) => [profileKey(profile, index), profile]));
    const savedProfile = key => savedProfiles.get(key);
    const isNewProfile = (profile, index) => Boolean(profile) && !savedProfile(profileKey(profile, index));
    // Capability discovery (模型目录识别出的 input) is derived metadata, not an
    // edit: reading the catalog must not by itself raise the unsaved chip.
    // 预算字段在编辑区是文本、请求头是键值行；比较前统一归一化，这样「输出了
    // 同样的数字」不会被误判成未保存，而清空预算或删掉最后一条请求头仍然是改动。
    const editableProfile = ({ input: _input, inputCapability: _inputCapability, ...profile }) => {
      const fields = { ...profile };
      for (const key of BUDGET_KEYS) if (fields[key] !== undefined) fields[key] = budgetDraft(fields[key]);
      return { ...fields, headers: headerRecord(profile.headers) };
    };
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
        modelDrafts.set(key, { kind: MODEL_DRAFT_NEW, profile: { ...profile, ...fields } });
        return;
      }
      const previous = modelDrafts.get(key);
      modelDrafts.set(key, { kind: MODEL_DRAFT_EDIT, fields: { ...(previous?.kind === MODEL_DRAFT_EDIT ? previous.fields : {}), ...fields } });
    };
    const patchProfile = (index, fields) => {
      rememberDraft(form.profiles[index], index, fields);
      setForm(current => ({ ...current, profiles: current.profiles.map((profile, cursor) => cursor === index ? { ...profile, ...fields } : profile) }));
    };
    const setProfile = (index, key, value) => patchProfile(index, {
      [key]: value,
      ...(key === 'modelName' ? { input: undefined, inputCapability: 'pending', protocol: undefined } : {}),
      ...(key === 'modelName' ? clearModelEffortRange(form.profiles[index]) : {}),
    });
    const setSharedField = (matches, key, value) => {
      const profiles = form.profiles.map((profile, cursor) => {
        if (!matches(profile) || profile[key] === value) return profile;
        rememberDraft(profile, cursor, { [key]: value });
        return { ...profile, [key]: value };
      });
      setForm(current => ({ ...current, profiles }));
    };
    const setApiKey = (index, value) => {
      const name = form.profiles[index].credentialName;
      setSharedField(profile => profile.credentialName === name, 'apiKey', value);
    };
    // 请求头行也只活在内存草稿里：保存时才归一化成 `profile.headers` 的普通
    // 对象，空行与非法名称被丢弃；删掉最后一行即移除该字段。
    const updateHeaderRows = (index, mutate) => {
      const profile = form.profiles[index];
      if (!profile) return;
      setProfile(index, 'headers', mutate(headerRows(profile.headers)));
    };
    const addHeaderRow = () => updateHeaderRows(selectedIndex, rows => [...rows, { id: headerRowId(), name: '', value: '' }]);
    const setHeaderRow = (rowIndex, key, value) => updateHeaderRows(selectedIndex,
      rows => rows.map((row, cursor) => cursor === rowIndex ? { ...row, [key]: value } : row));
    const removeHeaderRow = rowIndex => updateHeaderRows(selectedIndex, rows => rows.filter((_, cursor) => cursor !== rowIndex));
    const setDefaultProfile = async index => {
      const next = form.profiles.map((profile, cursor) => ({ ...profile, default: cursor === index }));
      setForm(current => ({ ...current, profiles: next }));
      await saveConfiguration({ ...form, profiles: next });
    };
    const toggleProfileEnabled = async index => {
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
      setForm(current => ({ ...current, profiles: next }));
      await saveConfiguration({ ...form, profiles: next });
    };
    const removeProfile = async index => {
      if (form.profiles.length <= 1) return;
      const target = form.profiles[index];
      if (target.enabled !== false && form.profiles.filter(profile => profile.enabled !== false).length <= 1) {
        setError('至少保留一个启用的模型');
        return;
      }
      const remaining = form.profiles.filter((_, cursor) => cursor !== index);
      const neighbourIndex = Math.min(index, remaining.length - 1);
      const nextDefaultIndex = target.default ? remaining.findIndex(profile => profile.enabled !== false) : -1;
      const next = nextDefaultIndex < 0 ? remaining
        : remaining.map((profile, cursor) => ({ ...profile, default: cursor === nextDefaultIndex }));
      if (remaining[neighbourIndex]) setSelectedKey(profileKey(remaining[neighbourIndex], neighbourIndex));
      if (mode === 'all') setEditing(false);
      setForm(current => ({ ...current, profiles: next }));
      await saveConfiguration({ ...form, profiles: next });
    };
    // 取消新增：这份新草稿还没进过存储，直接丢弃，列表与选中项回到添加前。
    // 撤销修改：只丢掉当前模型的草稿，回到已保存的那份配置。
    const revertProfile = index => {
      const target = form.profiles[index];
      if (!target) return;
      if (isNewProfile(target, index)) { removeProfile(index); return; }
      const persisted = savedProfile(profileKey(target, index));
      modelDrafts.delete(profileKey(target, index));
      if (!persisted) return;
      if (mode === 'all') {
        const connection = Object.fromEntries(['provider', 'baseUrl', 'credentialName', 'connectionId', 'connectionName', 'credentialConfigured', 'apiKey']
          .map(key => [key, target[key]]));
        const reverted = { ...persisted, ...connection };
        if (stableString(editableProfile(reverted)) !== stableString(editableProfile(persisted))) rememberDraft(persisted, index, connection);
        setForm(current => ({ ...current, profiles: current.profiles.map((profile, cursor) => cursor === index ? reverted : profile) }));
        return;
      }
      const profiles = form.profiles.map((profile, cursor) => {
        if (cursor === index) return { ...persisted };
        if (!target.apiKey || !profile.apiKey || profile.credentialName !== target.credentialName) return profile;
        rememberDraft(profile, cursor, { apiKey: '' });
        return { ...profile, apiKey: '' };
      });
      setForm(current => ({ ...current, profiles }));
    };
    const saveConfiguration = async configuration => {
      if (saveLock.current || status !== 'ready') return false;
      saveLock.current = true;
      setSaving(true); setMessage(''); setError('');
      const failure = saveFailureMessage;
      try {
        if (mode === 'cloud') {
          const access = configuration.cloudAccessKey.trim(), secret = configuration.cloudSecretKey.trim();
          if (!cloudStatus.configured && (!access || !secret)) throw new Error('请填写 Access Key 和 Secret Key，或跳过云端配置');
          await hostRemote.updateSettings({ ...(access ? { cloudAccessKey: access } : {}), ...(secret ? { cloudSecretKey: secret } : {}), cloudAccountId: configuration.cloudAccountId.trim(), cloudRegion: configuration.cloudRegion.trim(), cloudServerUrl: configuration.cloudServerUrl.trim(), cloudBucket: configuration.cloudBucket.trim() });
          setForm(current => ({ ...current, cloudAccessKey: '', cloudSecretKey: '' }));
          setSavedState(current => ({ ...current, cloud: { ...cloudSnapshot(configuration), cloudAccessKey: '', cloudSecretKey: '' } }));
          setMessage('云端凭证已保存');
          onSaved?.();
          return true;
        }
        // 保存前把输出预算折算到上下文窗口以内，与运行时 admission 保持一致：
        // Host 里存的值就是 DSH 实际生效值，用户不必自己算「窗口的一半」。
        const clampedOutputs = [];
        const rawProfiles = configuration.profiles.map(modelProfilePayload).map(profile => {
          if (profile.maxOutputTokens === undefined && profile.contextWindow === undefined) return profile;
          const budgets = resolveModelBudgets(profile, null);
          if (!budgets.adjusted) return profile;
          clampedOutputs.push(`${profile.modelName} → ${budgets.maxOutputTokens}`);
          // Persist the window too: a user-typed 2,000,000 would otherwise leave
          // the Host claiming a capacity DSH actually caps at 1,000,000.
          return { ...profile, contextWindow: budgets.contextWindow, maxOutputTokens: budgets.maxOutputTokens };
        });
        const activeDefaultIndex = rawProfiles.findIndex(profile => profile.enabled !== false && profile.default);
        const firstEnabledIndex = rawProfiles.findIndex(profile => profile.enabled !== false);
        const defaultIndex = activeDefaultIndex >= 0 ? activeDefaultIndex : firstEnabledIndex;
        if (defaultIndex < 0) throw new Error('至少保留一个启用的模型');
        const incomplete = rawProfiles.find(profile => !profile.modelName || (profile.enabled && !profile.baseUrl));
        if (incomplete) {
          if (mode === 'all') { setSelectedKey(incomplete.id); setEditing(true); }
          throw new Error(incomplete.modelName ? `模型 ${incomplete.modelName} 需要填写 API 地址` : '每个模型配置都需要填写模型名称');
        }
        const keys = Object.fromEntries([...configuration.providers, ...configuration.profiles].map(item => [item.credentialName, String(item.apiKey || '').trim()]).filter(([, value]) => value));
        const added = configuration.profiles.filter(profile => profile.modelOnly && !profile.protocol && !savedProfile(profileKey(profile)));
        const wires = typeof hostRemote.probeModelWire === 'function'
          ? await checkImportedWires(added, (profile, models) => hostRemote.probeModelWire({ ...probeTargetFor(profile), models }))
          : new Map();
        const profiles = rawProfiles.map((profile, index) => {
          const wire = wires.get(profile.id);
          const chat = wire === 'openai-completions';
          return {
            ...profile, default: index === defaultIndex,
            ...(wire ? { protocol: chat ? 'openai-chat' : 'openai-responses' } : {}),
            ...(chat && !configuration.profiles[index].codexApi ? { codexApi: 'chat-completions' } : {}),
          };
        });
        const unverified = [...wires.values()].filter(wire => wire === 'unknown').length;
        const first = profiles.find(profile => profile.default === true) || profiles[0];
        if (mode === 'model' && !keys[first.credentialName] && !modelStatus[first.credentialName]?.configured) throw new Error('请填写模型 API Key');
        const payload = { modelProvider: first.provider, modelBaseUrl: first.baseUrl, modelName: first.modelName, modelProfiles: profiles, modelProfileKeys: keys, cloudAccountId: configuration.cloudAccountId.trim(), cloudRegion: configuration.cloudRegion.trim(), cloudServerUrl: configuration.cloudServerUrl.trim(), cloudBucket: configuration.cloudBucket.trim() };
        if (mode === 'all' || providerDraftCount()) payload.modelConnections = configuration.providers.map(providerMetadata).filter(Boolean);
        if (configuration.cloudAccessKey?.trim()) payload.cloudAccessKey = configuration.cloudAccessKey.trim();
        if (configuration.cloudSecretKey?.trim()) payload.cloudSecretKey = configuration.cloudSecretKey.trim();
        // Snapshot every field this save writes, so a failed DSH sync restores
        // the whole configuration — a partial rollback would leave a deleted
        // connection beside a resurrected profile.
        const rollbackPayload = {
          modelProfiles: runtimeProfiles(savedState.profiles),
          ...(payload.modelConnections ? { modelConnections: savedState.storedProviders } : {}),
          ...(payload.modelProfileKeys ? { modelProfileKeys: Object.fromEntries(savedState.profiles.map((profile, index) => [profile.credentialName, ''])) } : {}),
          cloudAccountId: savedState.cloud?.cloudAccountId ?? '', cloudRegion: savedState.cloud?.cloudRegion ?? '',
          cloudServerUrl: savedState.cloud?.cloudServerUrl ?? '', cloudBucket: savedState.cloud?.cloudBucket ?? '',
        };
        await hostRemote.updateSettings(payload);
        await hostRemote.syncModelCredential();
        const discoveredProfiles = await hydrateModelInputs(profiles);
        const persistedProfiles = runtimeProfiles(discoveredProfiles);
        await hostRemote.updateSettings({ modelProfiles: persistedProfiles });
        await applyProfilesWithRollback({ dshModel, persistedProfiles, keys, hostRemote, rollbackProfiles: rollbackPayload.modelProfiles, rollbackPayload });
        // The Host now holds these values: every draft has served its purpose.
        clearModelSettingsDrafts();
        setForm(current => ({ ...current, ...configuration,
          profiles: configuration.profiles.map(profile => ({ ...profile, apiKey: '' })),
          providers: configuration.providers.map(provider => ({ ...provider, apiKey: '' })), cloudAccessKey: '', cloudSecretKey: '' }));
        window.dispatchEvent(new CustomEvent('agentkit-studio:model-credential-changed'));
        setMessage([
          unverified ? `模型配置已保存 · ${unverified} 个模型的接口待确认` : '模型配置已保存',
          clampedOutputs.length ? `最大输出已按上下文窗口折算：${clampedOutputs.join('、')}` : '',
        ].filter(Boolean).join('；'));
        await load();
        onSaved?.();
        return true;
      } catch (reason) {
        setError(failure(reason));
        return false;
      } finally {
        saveLock.current = false;
        setSaving(false);
      }
    };
    const save = event => {
      event.preventDefault();
      if (modelDirectory.importPanel || modelDirectory.editorActions) return;
      return saveConfiguration(form);
    };
    // 重新读取：显式回到存储里的配置，因此丢弃全部草稿；丢弃过就说明白。
    const reload = async () => {
      const discarded = modelDrafts.size + providerDraftCount();
      setMessage('');
      if (mode === 'all') { setEditing(false); modelDirectory.showOverview(); }
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
    const reasoningFor = profile => {
      const declared = profile?.reasoningEfforts;
      if (declared && typeof declared === 'object' && !Array.isArray(declared)) {
        const resolved = studioReasoning(profile);
        if (resolved) return resolved;
      }
      return studioReasoning({ ...profile, reasoningEfforts: true });
    };
    const selectedReasoning = reasoningFor(selected) || { efforts: {}, defaultEffort: '' };
    const reasoningValue = selected?.reasoningEfforts
      ? (selectedReasoning.efforts[selected.defaultReasoningEffort] ? selected.defaultReasoningEffort : selectedReasoning.defaultEffort)
      : '';
    const hostCredentials = new Set([...savedState.profiles, ...savedState.providers].filter(item => item.credentialConfigured).map(item => item.credentialName));
    const profileCredential = profile => ({
      ...modelStatus[profile.credentialName],
      configured: Boolean(modelStatus[profile.credentialName]?.configured || hostCredentials.has(profile.credentialName)),
    });
    const profileStatus = profile => profile.enabled === false ? { tone: 'neutral', label: '已停用' }
      : profile.apiKey?.trim() ? { tone: 'warn', label: '凭证待保存' }
        : profileCredential(profile).configured ? { tone: 'success', label: '已配置' } : { tone: 'warn', label: '需要配置' };
    const profileCatalogKey = profile => String(profile.id || profile.credentialName || 'default');
    const catalogScope = profile => stableString([connectionIdentity(profile), profile.apiKey?.trim() || '']);
    const effortScope = profile => stableString([profile.id, profile.modelName, profile.protocol, catalogScope(profile)]);
    const effortProbe = useEffortProbe((editing || mode === 'model') ? effortScope(selected) : '');
    const allProbe = useEffortProbe('all-models');
    const activeResult = (results, profile) => {
      const result = results[profileCatalogKey(profile)];
      return result?.scope === catalogScope(profile) ? result : undefined;
    };
    const catalogItemsFor = profile => activeResult(modelCatalogs, profile)?.items || [];
    const connectionFor = profile => activeResult(connectionStatus, profile) || {};
    const wireProbeFor = profile => {
      const probe = wireProbes[profileCatalogKey(profile)];
      return probe?.scope === effortScope(profile) ? probe : {};
    };

    /**
     * Ask the Host which wire this model speaks.
     *
     * 星流's `/v1/models` declares no capability flag, so the form cannot
     * know statically; asking is the only honest answer. The call is
     * read-only — it returns a recommendation and the operator decides
     * whether to write `protocol`.
     */
    const probeWireFor = async profile => {
      const key = profileCatalogKey(profile);
      const modelName = String(profile.modelName || '').trim();
      if (!modelName) return;
      const scope = effortScope(profile);
      const publish = result => setWireProbes(current => ({ ...current, [key]: { scope, ...result } }));
      publish({ state: 'probing' });
      try {
        const result = await hostRemote.probeModelWire(probeTargetFor(profile));
        publish({ state: 'done', wire: String(result?.wire || 'unknown') });
      } catch (failure) {
        publish({ state: 'error', message: String(failure?.message || failure) });
      }
    };
    const candidateFor = profile => {
      // 尚未保存的请求头也要随探测一起发送，否则「先填 Key 再读目录」的流程会在
      // 按 Header 鉴权的网关上失败。
      const headers = headerRecord(profile.headers);
      return {
        provider: profile.provider || 'custom',
        baseUrl: normalizeModelEndpoint(profile.baseUrl, profile.provider),
        modelName: String(profile.modelName || '').trim(),
        apiKey: String(profile.apiKey || '').trim(),
        ...(headers ? { headers } : {}),
      };
    };
    const storedConnectionFor = profile => {
      const identity = connectionIdentity(profile);
      return savedState.profiles.find(item => item.enabled !== false && connectionIdentity(item) === identity);
    };
    const probeTargetFor = connection => {
      const draft = candidateFor(connection);
      if (draft.apiKey) return draft;
      const identity = connectionIdentity(connection);
      const matches = item => connectionIdentity(item) === identity;
      const provider = savedState.storedProviders.find(item => item.id === (connection.connectionId || connection.id) && matches(item));
      const profile = savedState.profiles.find(item => item.id === connection.id && matches(item))
        || (!provider && savedState.profiles.find(matches));
      if (!profile && !provider) throw new Error('请先填写 API Key 或保存提供商');
      return { ...(profile ? { profileId: profile.id } : { connectionId: provider.id }), modelName: draft.modelName };
    };
    const probeEfforts = (connection, modelName, signal, detectWire = true) => hostRemote.probeModelEfforts({
      ...probeTargetFor({ ...connection, modelName }),
      ...(detectWire ? { detectWire: true } : { protocol: connection.protocol || 'openai-chat' }),
    }, signal);
    const probeSelectedEfforts = () => effortProbe.progress ? effortProbe.stop() : effortProbe.run([{ key: selected.id }],
      (_job, signal) => probeEfforts(selected, selected.modelName, signal, Boolean(selected.modelOnly && !selected.protocol && !savedProfile(profileKey(selected)))));
    const { probeAllEfforts } = createProbeAll({ allProbe, form, lookupModelCapabilities, probeEfforts, setMessage, profileKey, useEffect, useRef, patchProfile, applicableProbeLevels, hostRemote, setModelCapabilityCatalog });
    const fetchCatalog = async profile => {
      if (profile.apiKey?.trim() && typeof hostRemote.probeModelEndpoint === 'function') {
        return hostRemote.probeModelEndpoint(candidateFor(profile));
      }
      const stored = storedConnectionFor(profile);
      if (stored && profileCredential(stored).configured && typeof hostRemote.modelCatalog === 'function') {
        try {
          const catalog = await hostRemote.modelCatalogWithCards?.(stored.id);
          if (catalog) return catalog;
        } catch { /* The plain catalog is still available when card loading fails. */ }
        return hostRemote.modelCatalog(stored.id);
      }
      throw new Error('请先填写 API Key');
    };
    const fetchProviderCatalog = group => {
      const connection = connectionSource(group);
      const stored = savedState.storedProviders.find(item => item.id === connection.id);
      if (!connection.apiKey && stored && connectionIdentity(stored) === connectionIdentity(connection) && typeof hostRemote.probeModelEndpoint === 'function') {
        return hostRemote.probeModelEndpoint({ connectionId: connection.id });
      }
      return fetchCatalog(connection);
    };
    const readModelCatalog = async index => {
      const profile = form.profiles[index];
      if (!profile) return;
      const key = profileCatalogKey(profile);
      const scope = catalogScope(profile);
      const forThisConnection = item => item.id === profile.id && catalogScope(item) === scope;
      const reportStatus = (state, message) => setConnectionStatus(current => ({ ...current, [key]: { scope, state, message } }));
      reportStatus('loading', '正在读取模型目录…');
      try {
        const catalog = await fetchCatalog(profile);
        const items = Array.isArray(catalog?.items) ? catalog.items : [];
        const currentIndex = profilesRef.current.findIndex(forThisConnection);
        if (currentIndex < 0) return;
        setModelCatalogs(current => ({ ...current, [key]: { scope, items } }));
        const current = profilesRef.current[currentIndex];
        const modelName = current.modelName.trim();
        const chosen = modelName ? items.find(item => item.id === modelName) : items[0];
        if (chosen) {
          if (!modelName) rememberDraft(current, currentIndex, { modelName: chosen.id });
          setForm(previous => ({ ...previous, profiles: previous.profiles.map(item => {
            if (!forThisConnection(item) || item.modelName !== current.modelName) return item;
            return { ...item, modelName: chosen.id, input: chosen.input || ['text'], inputCapability: chosen.inputKnown === false ? 'unknown' : 'catalog' };
          }) }));
        }
        reportStatus('success', `已读取 ${items.length} 个模型`);
      } catch (reason) {
        if (profilesRef.current.some(forThisConnection)) reportStatus('error', reason?.message || '读取模型目录失败');
      }
    };
    const testModelConnection = async index => {
      const profile = form.profiles[index];
      if (!profile) return;
      const key = profileCatalogKey(profile);
      const scope = catalogScope(profile);
      const stillCurrent = () => profilesRef.current.some(item => item.id === profile.id && catalogScope(item) === scope);
      const reportStatus = (state, message) => setConnectionStatus(current => ({ ...current, [key]: { scope, state, message } }));
      reportStatus('loading', '正在测试连接…');
      try {
        let result;
        const stored = savedProfile(profileKey(profile, index));
        if (!profile.apiKey?.trim() && stored && stored.enabled !== false && connectionIdentity(stored) === connectionIdentity(profile)
          && profileCredential(profile).configured && typeof hostRemote.testModelProfile === 'function') {
          result = await hostRemote.testModelProfile(profile.id);
        } else {
          result = await fetchCatalog(profile);
        }
        if (!stillCurrent()) return;
        const items = Array.isArray(result?.items) ? result.items : [];
        if (items.length) setModelCatalogs(current => ({ ...current, [key]: { scope, items } }));
        const chosen = String(profile.modelName || '').trim();
        const available = !chosen || !items.length || items.some(item => item.id === chosen);
        reportStatus(available ? 'success' : 'warning', available ? '连接成功' : '连接成功，但当前模型不在目录中');
      } catch (reason) {
        if (stillCurrent()) reportStatus('error', reason?.message || '连接失败');
      }
    };

    const ready = status === 'ready';
    const selectedDirty = ready && isDirtyProfile(selected, selectedIndex);
    const selectedDraft = selectedDirty && isNewProfile(selected, selectedIndex);
    const connections = mode === 'all' ? modelConnections(profiles, form.providers) : [];
    const drafts = new Set();
    if (ready && mode !== 'cloud') {
      const keys = new Set();
      profiles.forEach((profile, index) => {
        const key = profileKey(profile, index);
        keys.add(key);
        if (isDirtyProfile(profile, index)) drafts.add(key);
      });
      for (const key of savedProfiles.keys()) if (!keys.has(key)) drafts.add(key);
    }
    const draftCount = drafts.size;
    const cloudDirty = ready && cloudIsDirty();
    const providerCount = mode === 'all' ? providerDraftCount() : 0;
    const formDirty = draftCount > 0 || providerCount > 0 || cloudDirty;
    const stageModels = async picks => {
      if (!ready || saving) return false;
      const added = importedProfiles(connections, picks, newProfileId);
      if (!added.length) return false;
      const next = [...form.profiles, ...added];
      setForm(current => ({ ...current, profiles: next }));
      setError(''); setMessage('');
      await saveConfiguration({ ...form, profiles: next });
      return true;
    };
    const stageProviderChanges = async (providers, profiles) => {
      rememberProviders(providers, savedState.providers);
      setForm(current => ({ ...current, providers, profiles }));
      setError(''); setMessage('');
      await saveConfiguration({ ...form, providers, profiles });
    };
    const stageProvider = input => {
      if (!ready || saving) return '';
      const existing = form.providers.find(item => item.id === input.id);
      const updated = updateProvider({ input, existing, providers: form.providers, profiles, makeId: newProfileId });
      stageProviderChanges(updated.providers, updated.profiles);
      return updated.id;
    };
    const saveProvider = async (input, picks, profileIds) => {
      if (!ready || saveLock.current) return '';
      const updated = updateProvider({ input, providers: form.providers, profiles, makeId: newProfileId });
      const { id, providers } = updated;
      const connection = providers.find(item => item.id === id);
      const added = importedProfiles([{ id, address: connection.baseUrl, connection, models: [] }],
        new Map([[id, picks]]), item => profileIds.get(item.id) || newProfileId());
      const saved = await saveConfiguration({ ...form, providers, profiles: [...updated.profiles, ...added] });
      return saved ? id : '';
    };
    const removeProvider = async group => {
      if (!ready || saving) return false;
      const removed = new Set(group.models.map(({ profile }) => profile.id));
      const remaining = keepDefaultModel(profiles.filter(profile => !removed.has(profile.id)));
      if (!remaining.length) { setError('请先保留一个已启用的模型'); return false; }
      await stageProviderChanges(form.providers.filter(provider => provider.id !== group.id), remaining);
      return true;
    };
    const { cardForProfile, autoCard } = useModelSettingsCards({ useState, useEffect, hostRemote, window });
    const modelDirectory = useModelSettingsDirectory({
      cardForProfile, autoCard,
      status, saving, connections, profileCount: profiles.length, drafts, stageModels, stageProvider, saveProvider, removeProvider,
      fetchCatalog: fetchProviderCatalog,
      probeEfforts: typeof hostRemote.probeModelEfforts === 'function' ? probeEfforts : undefined,
      probeAll: { run: probeAllEfforts, progress: allProbe.progress },
      checkProvider: input => {
        const group = connections.find(item => item.id === input.id);
        if (!input.apiKey.trim() && group?.provider === input.provider && group.address === input.baseUrl) return fetchProviderCatalog(group);
        return fetchCatalog({ ...group?.connection, ...input });
      },
      openModel: key => { setSelectedKey(key); setEditing(true); setError(''); },
      credentialConfigured: profile => profileCredential(profile).configured,
    });
    const { renderDirectory, importPanel, importedCount, selectedConnections, addSelected, editorActions } = modelDirectory;

    const cloudField = (label, key, placeholder, type = 'text') =>
      renderCloudField(h, { SecretInput, label, key, placeholder, type, value: form[key], onChange: value => setField(key, value) });
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
    // The accessible name is the stable contract the acceptance scripts use
    // (`getByLabel('模型名称')`), so it must not change when the catalog loads.
    // "自定义" belongs in the placeholder/hint, which screen readers get as
    // description rather than as a different control name.
    const customModel = (!catalogItems.length || !hasSelectedModel) ? h('input', {
      className: 'ms-input',
      'aria-label': '模型名称',
      value: selected.modelName,
      placeholder: catalogItems.length ? '输入目录外的自定义模型名' : '先读取模型目录，或手动填写',
      onChange: event => setProfile(selectedIndex, 'modelName', event.target.value),
    }) : null;
    const capabilityHint = { unknown: '模型目录未提供能力信息', unavailable: '暂时无法读取模型目录', missing: '模型目录中未找到该模型' }[selected.inputCapability]
      || (status === 'loading' ? '正在读取模型目录…' : '保存后自动识别');
    const capability = h('div', { className: 'ms-capability', 'data-model-input-capability': selected.inputCapability || 'pending' },
      h('span', { className: 'ms-label' }, '输入能力'),
      selected.inputCapability === 'catalog'
        ? [h(Chip, { key: 'text' }, '文字'), selected.input?.includes('image') ? h(Chip, { key: 'image' }, '图片') : null]
        : h('span', { className: 'ms-hint' }, capabilityHint));

    const capacitySummary = renderCapabilitySummary(h, selected);

    const probeReport = effortProbe.reportFor(selected.id);
    const applyProbeLevels = createApplyProbeLevels({ patchProfile, selectedIndex, setMessage });
    // 探测结果直接生效：可用档位写回草稿（可撤销），不再要用户二次点「应用」。
    useEffect(() => { const levels = applicableProbeLevels(probeReport); if (levels.length) applyProbeLevels(levels); }, [probeReport]);
    const reasoningField = renderModelEffortSettings(h, {
      efforts: selectedReasoning.efforts, value: reasoningValue, levels: selected.reasoningLevels,
      protocol: selected.protocol, provisional: !Array.isArray(selected.reasoningLevels) && reasoningProfileFor(selected.provider).fallback,
      probing: Boolean(effortProbe.progress), canProbe: Boolean(selected.modelName?.trim() && hostRemote.probeModelEfforts && !lookupModelCapabilities(selected)),
      report: probeReport,
      onProbe: probeSelectedEfforts, onChange: level => patchProfile(selectedIndex, {
        reasoningEfforts: level ? true : undefined, defaultReasoningEffort: level || undefined,
      }),
    });

    // 「请求预算与请求头」默认收起：只有需要覆盖网关默认值的模型才展开配置。
    // 预算留空即沿用网关默认值；请求头是「名称 → 值」的可重复行，值可能是凭证，
    // 所以只写进本机配置，不进入日志、提示或未保存快照。
    const budgetInput = (label, key, placeholder) => h('label', { className: 'ms-field' },
      h('span', { className: 'ms-label' }, label),
      h('input', {
        className: 'ms-input',
        'aria-label': label,
        inputMode: 'numeric',
        autoComplete: 'off',
        value: selected[key] === undefined || selected[key] === null ? '' : String(selected[key]),
        placeholder,
        onChange: event => setProfile(selectedIndex, key, event.target.value),
      }));
    const advancedHeaders = headerRows(selected.headers);
    const advancedHeaderProblem = headerRowProblem(advancedHeaders);
    const requestBudget = h('details', { className: 'ms-advanced', 'data-model-request-budget': true },
      h('summary', null, '请求预算与请求头'),
      h('div', { className: 'ms-grid ms-grid-3' },
        budgetInput('最大输出 Token', 'maxOutputTokens', '例如：8192'),
        budgetInput('上下文窗口', 'contextWindow', '例如：128000'),
        budgetInput('请求超时（ms）', 'requestTimeoutMs', '例如：110000')),
      h('p', { className: 'ms-hint' }, '留空沿用网关默认值；这些预算与请求头只作用于当前模型配置，不改变其他模型。'),
      h('div', { className: 'ms-headers', 'data-model-headers': true },
        h('div', { className: 'ms-headers-head' },
          h('span', { className: 'ms-label' }, '自定义请求头'),
          h('span', { className: 'ms-meta' }, advancedHeaders.length ? `${advancedHeaders.length} 条` : '未配置')),
        advancedHeaders.length
          ? advancedHeaders.map((row, index) => h('div', { key: row.id, className: 'ms-header-row', 'data-model-header-row': index },
            h('input', {
              className: 'ms-input', 'aria-label': `请求头名称 ${index + 1}`, value: row.name,
              placeholder: '例如：X-Gateway-Token', autoComplete: 'off', spellCheck: false,
              onChange: event => setHeaderRow(index, 'name', event.target.value),
            }),
            h('input', {
              className: 'ms-input', 'aria-label': `请求头值 ${index + 1}`, value: row.value,
              placeholder: '值只保存在本机配置', autoComplete: 'off', spellCheck: false,
              onChange: event => setHeaderRow(index, 'value', event.target.value),
            }),
            h('button', {
              type: 'button', className: 'ms-btn', 'data-size': 'sm', 'data-variant': 'danger',
              'aria-label': `删除请求头 ${index + 1}`, onClick: () => removeHeaderRow(index),
            }, '删除')))
          : h('p', { className: 'ms-hint' }, '还没有自定义请求头。'),
        h('div', { className: 'ms-actions' },
          h('button', { type: 'button', className: 'ms-btn', 'data-size': 'sm', 'data-model-add-header': true, onClick: addHeaderRow }, '＋ 添加请求头'),
          advancedHeaderProblem ? h('p', { role: 'alert', className: 'ms-note', 'data-tone': 'danger' }, advancedHeaderProblem) : null),
        h('p', { className: 'ms-hint' }, '请求头随「读取模型」一起发送；配置的 Authorization 优先于 API Key，值不会写入日志。')));

    const credentialUsage = profiles.filter(profile => profile.credentialName === selected.credentialName).length;
    const separateCredential = () => ({ credentialName: modelCredentialName({ id: newProfileId() }), apiKey: '' });
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
          mode === 'all' ? h('p', { className: 'ms-detail-meta' }, providerLabel(selected.provider)) : null),
        h('div', { className: 'ms-detail-actions' },
          selected.default && selected.enabled !== false ? null : h('button', { type: 'button', 'data-size': 'sm', className: 'ms-btn', disabled: selected.enabled === false, onClick: () => setDefaultProfile(selectedIndex) }, '设为默认'),
          h('button', { type: 'button', 'data-size': 'sm', className: 'ms-btn', onClick: () => toggleProfileEnabled(selectedIndex) }, selected.enabled === false ? '启用' : '停用'),
          selectedDirty && !selectedDraft ? h('button', { type: 'button', 'data-size': 'sm', className: 'ms-btn', onClick: () => revertProfile(selectedIndex) }, '撤销修改') : null,
          selectedDraft
            ? h('button', { type: 'button', 'data-size': 'sm', 'data-variant': 'danger', className: 'ms-btn', onClick: () => removeProfile(selectedIndex) }, '取消')
            : renderRemoveButton(h, {
              lastEnabled: selected.enabled !== false && form.profiles.filter(profile => profile.enabled !== false).length <= 1,
              onClick: () => removeProfile(selectedIndex),
            }))),
      h('div', { className: 'ms-grid ms-grid-2 ms-model-fields' },
        h('div', { className: 'ms-field' }, h('span', { className: 'ms-label' }, '模型名称'), modelSelect, customModel),
        simple ? null : reasoningField),
      simple ? null : capacitySummary,
      simple ? null : capability,
      renderProfileScores(h, cardForProfile(selected)),
      mode !== 'cloud' ? h('details', { className: 'ms-advanced', 'data-model-connection': true },
        h('summary', null, '连接'),
      h('div', { className: 'ms-editor-section-head' },
        h('span', { className: 'ms-meta' }, '凭证来源 · ', sourceLabel(profileCredential(selected).source))),
      h('div', { className: 'ms-grid ms-grid-2 ms-model-fields' },
          h('label', { className: 'ms-field' },
            h('span', { className: 'ms-label' }, '提供商'),
            h('select', {
              className: 'ms-select',
              'data-model-provider': selected.id || selectedIndex,
              'aria-label': '提供商',
              value: selected.provider === 'ksyun' || selected.provider === 'openai' ? selected.provider : 'custom',
              onChange: event => {
                const provider = event.target.value;
                const fields = { provider, baseUrl: provider === 'ksyun' ? DEFAULT_KSYUN_BASE_URL : provider === 'openai' ? 'https://api.openai.com/v1' : '',
                  input: undefined, inputCapability: 'pending', ...clearModelEffortRange(selected) };
                if (credentialUsage > 1 && provider !== selected.provider) Object.assign(fields, separateCredential());
                // 切换提供商后，原档位可能不在新提供商的枚举里（例如「最高」在
                // OpenAI 下没有 max）：自动落到新提供商的默认档，并给一条
                // 非阻塞提示，而不是等保存后才由上游拒绝。
                const capability = reasoningProfileFor(provider);
                // An explicit object map described the previous provider's wire
                // contract; after a provider switch the new table governs again.
                const legacyEffort = !Array.isArray(selected.reasoningLevels) && selected.reasoningEfforts;
                if (legacyEffort && typeof legacyEffort === 'object') fields.reasoningEfforts = true;
                if (legacyEffort && reasoningValue && !capability.levels.includes(reasoningValue)) {
                  fields.defaultReasoningEffort = capability.default;
                  setMessage(`已切换到${providerLabel(provider)}：思考等级「${REASONING_LABELS[reasoningValue] || reasoningValue}」不受支持，已改为「${REASONING_LABELS[capability.default]}」（发送 ${capability.wire[capability.default]}）。`);
                } else setMessage('');
                patchProfile(selectedIndex, fields);
              },
            }, h('option', { value: 'ksyun' }, '金山云模型服务'), h('option', { value: 'openai' }, 'OpenAI'), h('option', { value: 'custom' }, '自定义提供商'))),
          h('div', { className: 'ms-field' },
            h('span', { className: 'ms-label', id: `ms-base-label-${selectedIndex}` }, 'API 地址'),
            selected.provider === 'ksyun'
              ? h('div', { className: 'ms-static', 'aria-labelledby': `ms-base-label-${selectedIndex}`,
                title: selected.baseUrl || DEFAULT_KSYUN_BASE_URL }, selected.baseUrl || DEFAULT_KSYUN_BASE_URL)
              : h('input', {
                className: 'ms-input',
                'aria-label': 'API 地址',
                value: selected.baseUrl,
                placeholder: '例如：https://api.example.com/v1',
                onFocus: () => { addressAtFocus.current = { id: selected.id, address: normalizedConnectionAddress(selected) }; },
                onChange: event => setProfile(selectedIndex, 'baseUrl', event.target.value),
                onKeyDown: event => {
                  if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
                },
                onBlur: event => {
                  const origin = addressAtFocus.current;
                  addressAtFocus.current = null;
                  try {
                    const baseUrl = normalizeModelEndpoint(event.target.value, selected.provider);
                    const moved = credentialUsage > 1 && origin?.id === selected.id && origin.address !== baseUrl;
                    if (moved || baseUrl !== selected.baseUrl) {
                      patchProfile(selectedIndex, { baseUrl, input: undefined, inputCapability: 'pending', protocol: undefined,
                        ...clearModelEffortRange(selected), ...(moved ? separateCredential() : {}) });
                    }
                    setError('');
                  } catch (reason) { setError(reason.message); }
                },
              })),
        h('div', { className: 'ms-field' },
          h('div', { className: 'ms-field-head' }, h('span', { className: 'ms-label' }, 'API Key'),
            selected.provider === 'ksyun' ? h('a', { className: 'ms-link', href: 'https://ksp.console.ksyun.com/#/apiKey',
              target: '_blank', rel: 'noopener noreferrer' }, '获取 Key ↗') : null),
          h(SecretInput, {
            label: 'API Key', value: selected.apiKey, className: 'ms-input',
            placeholder: profileCredential(selected).configured ? '已配置，留空保持不变' : '先填写 Key，再读取模型',
            autoComplete: 'new-password',
            onChange: event => setApiKey(selectedIndex, event.target.value),
          }),
          credentialUsage > 1 ? h('span', { className: 'ms-hint' }, `此凭证供 ${credentialUsage} 个模型使用`) : null)),
      h('div', { className: 'ms-actions' },
        h('button', { type: 'button', 'data-size': 'sm', className: 'ms-btn', onClick: () => readModelCatalog(selectedIndex),
          disabled: connection.state === 'loading' }, connection.state === 'loading' ? '读取中…' : '读取模型'),
        h('button', { type: 'button', 'data-size': 'sm', className: 'ms-btn', onClick: () => testModelConnection(selectedIndex), disabled: connection.state === 'loading' }, '测试连接')),
      connection.message ? h('p', { role: 'status', className: 'ms-note', 'data-tone': connection.state === 'error' ? 'danger' : connection.state === 'warning' ? 'warn' : 'success' }, connection.message) : null) : null,
      simple ? null : h('div', { className: 'ms-advanced-group' },
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
            h('div', { className: 'ms-field' },
              h('span', { className: 'ms-label' }, 'DSH 接口'),
              h('span', { className: 'ms-inline', 'data-wire-probe': wireProbeFor(selected).state || 'idle' },
                h('button', {
                  type: 'button', className: 'ms-btn', 'data-size': 'sm', 'data-wire-probe-button': true,
                  disabled: wireProbeFor(selected).state === 'probing' || !String(selected.modelName || '').trim(),
                  onClick: () => { void probeWireFor(selected); },
                }, wireProbeFor(selected).state === 'probing' ? '探测中…' : '探测接口'),
                wireProbeFor(selected).state === 'done'
                  ? h('span', { className: 'ms-hint', 'data-wire-probe-result': wireProbeFor(selected).wire },
                    wireProbeFor(selected).wire === 'openai-responses'
                      ? ' ✅ 支持 Responses '
                      : wireProbeFor(selected).wire === 'openai-completions'
                        ? ' ➖ 只支持 Chat Completions '
                        : ' ❓ 无结论 ',
                    (wireProbeFor(selected).wire === 'openai-responses' && selected.protocol !== 'openai-responses')
                      ? h('button', {
                        type: 'button', className: 'ms-btn', 'data-size': 'sm', 'data-wire-probe-apply': true,
                        onClick: () => setProfile(selectedIndex, 'protocol', 'openai-responses'),
                      }, '让 DSH 走 Responses')
                      : null,
                    (wireProbeFor(selected).wire === 'openai-completions' && selected.protocol === 'openai-responses')
                      ? h('button', {
                        type: 'button', className: 'ms-btn', 'data-size': 'sm', 'data-wire-probe-apply': true,
                        onClick: () => setProfile(selectedIndex, 'protocol', undefined),
                      }, '改回 Chat Completions')
                      : null)
                  : wireProbeFor(selected).state === 'error'
                    ? h('span', { className: 'ms-hint' }, ` ⚠️ ${wireProbeFor(selected).message}`)
                    : null)),
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
          h('p', { className: 'ms-hint' }, 'Codex、DSH 和 Native 各自使用对应配置。思考模式需要模型服务支持。')),
        requestBudget));

    const editor = () => h('section', { className: 'ms-model' },
      mode === 'all' ? backButton('返回提供商', () => { setEditing(false); setError(''); })
        : h('div', { className: 'ms-intro' }, h('h3', null, '模型与提供商')),
      h('div', { className: 'ms-panel' }, detail));
    const modelPanel = mode === 'cloud' ? null
      : importPanel || (mode === 'all' && !editing ? renderDirectory() : editor());

    const cloudHeading = h(mode === 'all' ? 'summary' : 'div', { className: 'ms-cloud-title' },
      h('span', null, '云端凭证'), h(Chip, { tone: cloudStatus.configured ? 'success' : 'neutral' }, cloudStatus.configured ? '已配置' : '未配置'),
      cloudDirty ? h(Chip, { tone: 'warn', 'data-unsaved': 'true' }, '未保存') : null);
    const cloudSection = mode === 'cloud' || (mode === 'all' && !editing && modelDirectory.atOverview) ? h(mode === 'all' ? 'details' : 'section', { className: 'ms-cloud' },
      cloudHeading,
      h('div', { className: 'ms-cloud-body' },
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
      h('p', { className: 'ms-hint' }, '凭证来源 · ', sourceLabel(cloudStatus.source)))) : null;

    return h('div', { 'data-studio-model-settings': true, 'data-onboarding-mode': mode, style: { color: BRAND.ink, minWidth: 0 } },
      h('form', { onSubmit: save, className: 'ms-form', noValidate: true },
        status === 'error' ? h('p', { role: 'alert', className: 'ms-alert' }, error) : null,
        h('fieldset', { className: 'ms-form-content', disabled: saving }, modelPanel, cloudSection),
        h('div', { 'data-studio-form-footer': true, className: 'ms-footer' },
          h('div', { className: 'ms-footer-notes' },
            importPanel ? h('span', { role: 'status', className: 'ms-footer-note', 'data-tone': 'count' },
              importedCount ? `已选 ${importedCount} 个模型 · ${selectedConnections} 个连接` : '可切换连接继续选模型')
              : [
                message ? h('span', { key: 'message', role: 'status', className: 'ms-footer-note' }, message) : null,
                error && status !== 'error' ? h('span', { key: 'error', role: 'alert', className: 'ms-footer-note', 'data-tone': 'danger' }, error) : null,
                formDirty ? h('span', { key: 'draft', className: 'ms-footer-note', 'data-tone': 'draft' },
                  [providerCount ? `${providerCount} 个提供商` : '', draftCount ? `${draftCount} 个模型` : ''].filter(Boolean).join('、')
                    + '未保存 · 刷新后丢失') : null,
              ]),
          h('div', { className: 'ms-footer-actions' }, editorActions || (importPanel
            ? h('button', { type: 'button', 'data-variant': 'primary', className: 'ms-btn', disabled: !importedCount, onClick: addSelected }, '添加所选模型')
            : [
              h('button', { key: 'reload', type: 'button', className: 'ms-btn', onClick: reload, disabled: saving || status === 'loading' }, '重新读取'),
              h('button', { key: 'save', type: 'submit', 'data-variant': 'primary', 'data-dirty': formDirty ? 'true' : 'false', className: 'ms-btn', disabled: saving || !ready }, saving ? '保存中…' : mode === 'model' ? '保存并继续' : mode === 'cloud' ? '保存并完成' : '保存配置'),
            ])))));
  }
  return ModelSettingsSection;
}
