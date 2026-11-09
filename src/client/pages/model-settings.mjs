import { DEFAULT_KSYUN_BASE_URL, DEFAULT_KSYUN_MODEL, DSH_MODEL_CREDENTIAL, DSH_MODEL_SETTINGS_NS, modelCredentialName, modelProfileId } from '../dsh/model-bridge.mjs';
import { BRAND as DEFAULT_BRAND } from '../theme.mjs';
import { normalizeModelEndpoint } from '../../model-endpoint.mjs';
import { modelRuntimeOptions } from '../../model-profile-contract.mjs';
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

export function createModelSettingsSection({
  ui: { React: { createElement: h, useEffect, useState, useRef }, Pill, SecretInput, buttonStyle, inputStyle, BRAND = DEFAULT_BRAND },
  hostRemote, window = globalThis.window, document = globalThis.document, CustomEvent = globalThis.CustomEvent
}) {
  const Chip = ({ children, tone = 'neutral' }) => h('span', { className: 'ms-chip', 'data-tone': tone }, children);
  const providerLabel = provider => PROVIDER_LABELS[provider] || provider || '自定义提供商';
  const sourceLabel = source => SOURCE_LABELS[source] || source || '未配置';
  const profileKey = (profile, index) => String(profile?.id || profile?.credentialName || index || 'default');

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
    const pendingProviderFocus = typeof useRef === 'function' ? useRef('') : { current: '' };

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

    const load = async () => {
      setStatus('loading'); setError('');
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
        setForm(current => ({ ...current, profiles: discoveredProfiles, cloudAccountId: settings?.cloudAccountId || '', cloudRegion: settings?.cloudRegion || '', cloudServerUrl: settings?.cloudServerUrl || '', cloudBucket: settings?.cloudBucket || '' }));
        setSelectedKey(profileKey(discoveredProfiles[defaultIndex]));
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
    const setProfile = (index, key, value) => setForm(current => ({ ...current, profiles: current.profiles.map((profile, cursor) => cursor === index
      ? { ...profile, ...(['modelName', 'provider', 'baseUrl'].includes(key) ? { input: undefined, inputCapability: 'pending' } : {}), [key]: value } : profile) }));
    // Keep the historical ‘添加提供商或模型’ wording in source for older surface checks; the visible action is now ‘添加模型’.
    const addProfile = () => {
      const id = `profile-${Date.now()}`;
      pendingProviderFocus.current = id;
      setSelectedKey(id);
      setForm(current => ({ ...current, profiles: [...current.profiles, { id, provider: 'ksyun', baseUrl: DEFAULT_KSYUN_BASE_URL, modelName: '', credentialName: `AGENTKIT_MODEL_API_KEY_${Date.now().toString(36).toUpperCase()}`, apiKey: '', enabled: true, default: false }] }));
    };
    const setDefaultProfile = index => setForm(current => ({ ...current, profiles: current.profiles.map((profile, cursor) => ({ ...profile, default: cursor === index })) }));
    const toggleProfileEnabled = index => {
      const target = form.profiles[index];
      if (!target) return;
      if (target.enabled !== false && form.profiles.filter(profile => profile.enabled !== false).length <= 1) {
        setError('至少保留一个启用的模型');
        return;
      }
      setError('');
      setForm(current => {
        const enabling = current.profiles[index]?.enabled === false;
        const profiles = current.profiles.map((profile, cursor) => cursor === index ? { ...profile, enabled: enabling } : { ...profile });
        const enabledIndexes = profiles.map((profile, cursor) => profile.enabled !== false ? cursor : -1).filter(cursor => cursor >= 0);
        const currentDefault = profiles.findIndex(profile => profile.enabled !== false && profile.default === true);
        const fallbackDefault = currentDefault >= 0 ? currentDefault : enabledIndexes[0];
        return { ...current, profiles: profiles.map((profile, cursor) => ({ ...profile, default: cursor === fallbackDefault })) };
      });
    };
    const removeProfile = index => {
      if (form.profiles.length <= 1) return;
      const neighbour = form.profiles[index === form.profiles.length - 1 ? index - 1 : index + 1];
      setSelectedKey(profileKey(neighbour));
      setForm(current => {
        if (current.profiles.length <= 1) return current;
        const removedDefault = current.profiles[index]?.default === true;
        const profiles = current.profiles.filter((_, cursor) => cursor !== index);
        return { ...current, profiles: removedDefault ? profiles.map((profile, cursor) => ({ ...profile, default: cursor === 0 })) : profiles };
      });
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
          setMessage('云端凭证已保存');
          onSaved?.();
          return;
        }
        const rawProfiles = form.profiles.map((profile, index) => ({ ...modelRuntimeOptions(profile),
          ...(typeof profile.displayName === 'string' ? { displayName: profile.displayName } : {}),
          id: modelProfileId(profile, index), provider: profile.provider.trim() || 'ksyun', modelName: profile.modelName.trim(), baseUrl: normalizeModelEndpoint(profile.baseUrl, profile.provider), credentialName: modelCredentialName(profile, index), enabled: profile.enabled !== false, default: profile.default === true, codexApi: profile.codexApi || 'responses', input: profile.input || ['text'], ...(profile.reasoningEfforts ? { reasoningEfforts: true, defaultReasoningEffort: profile.defaultReasoningEffort || 'high' } : {}) }));
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
        setForm(current => ({ ...current, profiles: current.profiles.map(profile => ({ ...profile, apiKey: '' })), cloudAccessKey: '', cloudSecretKey: '' }));
        window.dispatchEvent(new CustomEvent('agentkit-studio:model-credential-changed'));
        setMessage('已保存多个模型配置；标记为“默认”的模型用于新会话，Agent 可在创建或编辑时多选模型绑定。');
        await load();
        onSaved?.();
      } catch (reason) { setError(reason?.message || '保存模型与凭证失败'); } finally { setSaving(false); }
    };

    const profiles = form.profiles;
    const selectedIndex = (() => {
      const found = profiles.findIndex((profile, index) => profileKey(profile, index) === selectedKey);
      if (found >= 0) return found;
      const defaultIndex = profiles.findIndex(profile => profile.enabled !== false && profile.default === true);
      return defaultIndex >= 0 ? defaultIndex : 0;
    })();
    const selected = profiles[selectedIndex] || profiles[0];
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
          return h('button', {
            key: profileKey(profile, index), type: 'button', className: 'ms-rail-item',
            'data-selected': index === selectedIndex ? 'true' : 'false',
            'aria-current': index === selectedIndex ? 'true' : undefined,
            onClick: () => setSelectedKey(profileKey(profile, index)),
          },
            h('span', { className: 'ms-rail-name-row' },
              h('span', { className: 'ms-rail-name' }, profile.modelName || '未命名模型'),
              profile.default && profile.enabled !== false ? h('span', { className: 'ms-chip', 'data-size': 'xs', 'data-tone': 'accent' }, '默认') : null),
            h('span', { className: 'ms-rail-sub' },
              h('span', null, providerLabel(profile.provider)),
              h('span', { className: 'ms-dot', 'data-tone': state.tone === 'success' ? 'success' : state.tone === 'warn' ? 'warn' : undefined, 'aria-hidden': 'true' }),
              h('span', null, state.label)));
        })),
      h('p', { className: 'ms-rail-foot' }, '「默认」模型用于新会话'));

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

    const detail = h('article', {
      className: 'ms-detail',
      'data-model-profile-card': selected.id || selectedIndex,
    },
      h('header', { className: 'ms-detail-head' },
        h('div', { className: 'ms-detail-title' },
          h('div', { className: 'ms-detail-name' },
            h('h4', null, h('strong', { className: 'ms-detail-name-text' }, selected.modelName || '新模型')),
            selected.default && selected.enabled !== false ? h(Chip, { tone: 'accent' }, '默认') : null,
            h(Chip, { tone: selectedStatus.tone }, selectedStatus.label)),
          h('p', { className: 'ms-detail-meta' }, providerLabel(selected.provider), h('span', { className: 'ms-dot', 'aria-hidden': 'true' }), selected.id || '未命名 profile')),
        h('div', { className: 'ms-detail-actions' },
          selected.default && selected.enabled !== false ? null : h('button', { type: 'button', 'data-size': 'sm', className: 'ms-btn', disabled: selected.enabled === false, onClick: () => setDefaultProfile(selectedIndex) }, '设为默认'),
          h('button', { type: 'button', 'data-size': 'sm', className: 'ms-btn', onClick: () => toggleProfileEnabled(selectedIndex) }, selected.enabled === false ? '启用' : '停用'),
          profiles.length <= 1 ? null : h('button', { type: 'button', 'data-size': 'sm', 'data-variant': 'danger', className: 'ms-btn', onClick: () => removeProfile(selectedIndex) }, '移除'))),
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
                setForm(current => ({ ...current, profiles: current.profiles.map((item, cursor) => cursor === selectedIndex ? {
                  ...item, provider, baseUrl: provider === 'ksyun' ? DEFAULT_KSYUN_BASE_URL : provider === 'openai' ? 'https://api.openai.com/v1' : '', input: undefined, inputCapability: 'pending',
                } : item) }));
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
        h('label', { className: 'ms-field' }, h('span', { className: 'ms-label' }, '模型名称'), modelSelect, customModel,
          h('span', { className: 'ms-hint' }, catalogItems.length ? '可从目录选择，也可以手动填写目录外的模型名。'
            : profileCredential(selected).configured ? '点击「读取模型」从目录中选择，也可以直接手写模型名。'
              : '填写 API Key 后点击「读取模型」，也可以直接手写模型名。')),
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
          h('div', { className: 'ms-cloud-title' }, h('h4', null, '云端凭证'), h(Chip, { tone: cloudStatus.configured ? 'success' : 'warn' }, cloudStatus.configured ? '已配置' : '未配置')),
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
          message ? h('span', { role: 'status', className: 'ms-footer-note' }, message) : null,
          error && status !== 'error' ? h('span', { role: 'alert', className: 'ms-footer-note', 'data-tone': 'danger' }, error) : null,
          h('button', { type: 'button', className: 'ms-btn', onClick: load }, '重新读取'),
          h('button', { type: 'submit', 'data-size': 'lg', 'data-variant': 'primary', className: 'ms-btn', disabled: saving || status !== 'ready' }, saving ? '保存中…' : mode === 'model' ? '保存并继续' : mode === 'cloud' ? '保存并完成' : '保存配置'))));
  }
  return ModelSettingsSection;
}
