import { DEFAULT_KSYUN_BASE_URL, DEFAULT_KSYUN_MODEL, DSH_MODEL_CREDENTIAL, DSH_MODEL_SETTINGS_NS, modelCredentialName, modelProfileId } from '../dsh/model-bridge.mjs';
import { BRAND as DEFAULT_BRAND } from '../theme.mjs';
import { normalizeModelEndpoint } from '../../model-endpoint.mjs';
import { modelRuntimeOptions } from '../../model-profile-contract.mjs';

export function createModelSettingsSection({
  ui: { React: { createElement: h, useEffect, useState, useRef }, Pill, SecretInput, buttonStyle, inputStyle, BRAND = DEFAULT_BRAND },
  hostRemote, window = globalThis.window, CustomEvent = globalThis.CustomEvent
}) {
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
        setStatus('ready');
      } catch (reason) { setStatus('error'); setError(reason?.message || 'Host 尚未连接'); }
    };
    useEffect(() => { load(); }, []);
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
    const removeProfile = index => setForm(current => {
      if (current.profiles.length <= 1) return current;
      const removedDefault = current.profiles[index]?.default === true;
      const profiles = current.profiles.filter((_, cursor) => cursor !== index);
      return { ...current, profiles: removedDefault ? profiles.map((profile, cursor) => ({ ...profile, default: cursor === 0 })) : profiles };
    });
    const sourceLabel = source => ({ file: '本机保存', 'legacy-global': '全局配置', global: '全局配置', workspace: '当前工作区', environment: '环境变量', 'workspace-alias': '当前工作区', 'global-alias': '全局配置', session: '本次会话', missing: '未配置' }[source] || source || '未配置');
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
    const field = (label, key, placeholder, type = 'text') => h('label', { style: { display: 'block', color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, label, h(type === 'password' ? SecretInput : 'input', { label, type, value: form[key] || '', placeholder, autoComplete: type === 'password' ? 'new-password' : 'off', onChange: event => setField(key, event.target.value), style: inputStyle() }));
    const thinkingControl = (profile, index) => h('label', { style: { display: 'block', marginTop: '10px' } },
      'Native 思考模式', h('select', { value: profile.parameters?.thinking?.type || 'default', onChange: event => {
        const parameters = { ...(profile.parameters || {}) };
        if (event.target.value === 'default') delete parameters.thinking;
        else parameters.thinking = { type: event.target.value };
        setProfile(index, 'parameters', parameters);
      }, style: inputStyle() }, h('option', { value: 'default' }, '服务默认'), h('option', { value: 'enabled' }, '开启'), h('option', { value: 'disabled' }, '关闭')),
      h('span', { style: { fontSize: '12px', display: 'block', marginTop: '6px' } }, '服务需支持思考模式；界面只展示模型实际返回的思考。'));
    const modelProviderLabel = provider => ({ ksyun: '金山云模型服务', openai: 'OpenAI' }[provider] || provider || '自定义提供商');
    const profileCredential = profile => modelStatus[profile.credentialName] || {};
    const profileStatus = profile => profile.enabled === false ? { tone: 'neutral', label: '已停用' } : profileCredential(profile).configured ? { tone: 'accent', label: '已配置' } : { tone: 'signal', label: '需要配置' };
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
        const selected = items.find(item => item.id === selectedId);
        if (!String(profile.modelName || '').trim() && items[0]?.id)
          setProfile(index, 'modelName', items[0].id);
        if (selected)
          setForm(current => ({ ...current, profiles: current.profiles.map((item, cursor) => cursor === index ? { ...item, input: selected.input || ['text'], inputCapability: selected.inputKnown === false ? 'unknown' : 'catalog' } : item) }));
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
        const selected = String(profile.modelName || '').trim();
        const available = !selected || !items.length || items.some(item => item.id === selected);
        setConnectionStatus(current => ({ ...current, [key]: { state: available ? 'success' : 'warning', message: available ? '连接成功' : '连接成功，但当前模型不在目录中' } }));
      } catch (reason) {
        setConnectionStatus(current => ({ ...current, [key]: { state: 'error', message: reason?.message || '连接失败' } }));
      }
    };
    const modelSummary = () => {
      const defaultProfile = form.profiles.find(profile => profile.enabled !== false && profile.default) || form.profiles.find(profile => profile.enabled !== false) || form.profiles[0];
      const enabled = form.profiles.filter(profile => profile.enabled !== false).length;
      const configured = form.profiles.filter(profile => profileCredential(profile).configured).length;
      const summaryMain = h('div', { style: { minWidth: 0 } },
        h('div', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 800, letterSpacing: '0.11em', textTransform: 'uppercase' } }, '当前默认模型'),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginTop: '6px' } },
          h('strong', { style: { color: BRAND.ink, fontSize: '20px', lineHeight: 1.2 } }, defaultProfile?.modelName || '尚未选择模型'),
          defaultProfile ? h(Pill, { tone: 'accent' }, modelProviderLabel(defaultProfile.provider)) : null),
        h('p', { style: { margin: '6px 0 0', color: BRAND.inkMuted, fontSize: '12px', lineHeight: 1.5 } }, defaultProfile ? `${defaultProfile.baseUrl || '使用提供商默认地址'} · ${profileCredential(defaultProfile).configured ? '凭证已配置' : '等待凭证'}` : '添加一个模型后即可开始配置。'));
      const summaryMeta = h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap' } },
        h('div', { style: { minWidth: '92px', paddingLeft: '12px', borderLeft: '1px solid ' + BRAND.border } },
          h('div', { style: { color: BRAND.inkMuted, fontSize: '11px' } }, '模型数量'),
          h('strong', { style: { display: 'block', marginTop: '4px', color: BRAND.ink, fontSize: '18px' } }, String(form.profiles.length))),
        h('div', { style: { minWidth: '92px', paddingLeft: '12px', borderLeft: '1px solid ' + BRAND.border } },
          h('div', { style: { color: BRAND.inkMuted, fontSize: '11px' } }, '已启用'),
          h('strong', { style: { display: 'block', marginTop: '4px', color: BRAND.ink, fontSize: '18px' } }, `${enabled}/${form.profiles.length}`)),
        h('div', { style: { minWidth: '92px', paddingLeft: '12px', borderLeft: '1px solid ' + BRAND.border } },
          h('div', { style: { color: BRAND.inkMuted, fontSize: '11px' } }, '已配置凭证'),
          h('strong', { style: { display: 'block', marginTop: '4px', color: BRAND.ink, fontSize: '18px' } }, `${configured}/${form.profiles.length}`)));
      return h('section', { 'data-model-summary': true, style: { border: '1px solid ' + BRAND.border, borderRadius: '16px', padding: '18px 20px', background: BRAND.surface, boxShadow: '0 8px 24px rgba(11,18,32,0.04)' } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '16px', flexWrap: 'wrap' } },
          summaryMain,
          h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap' } }, summaryMeta, mode === 'all' ? h('button', { type: 'button', onClick: addProfile, style: { ...buttonStyle(), color: BRAND.primaryText, background: BRAND.primaryFill, borderColor: 'transparent', whiteSpace: 'nowrap' } }, '＋ 添加模型') : null)));
    };
    const profileCards = form.profiles.map((profile, index) => {
      const catalogItems = catalogItemsFor(profile);
      const connection = connectionFor(profile);
      const hasSelectedModel = catalogItems.some(item => item.id === profile.modelName);
      const modelSelect = catalogItems.length ? h('select', {
        value: hasSelectedModel ? profile.modelName : '__custom__',
        'aria-label': '选择模型',
        onChange: event => setProfile(index, 'modelName', event.target.value === '__custom__' ? '' : event.target.value),
        style: inputStyle(),
      }, catalogItems.map(item => h('option', { key: item.id, value: item.id }, item.name || item.id)), h('option', { value: '__custom__' }, '手动填写模型名')) : null;
      const customModel = (!catalogItems.length || !hasSelectedModel) ? h('input', {
        value: profile.modelName,
        'aria-label': '模型名称',
        placeholder: catalogItems.length ? '输入目录外的模型名' : '先读取模型目录，或手动填写',
        onChange: event => setProfile(index, 'modelName', event.target.value),
        style: inputStyle(),
      }) : null;
      return h('article', {
        key: profile.id || index,
        'data-model-profile-card': profile.id || index,
        style: { border: '1px solid ' + BRAND.border, borderRadius: '16px', padding: '18px 20px', background: BRAND.surface, boxShadow: '0 8px 24px rgba(11,18,32,0.04)' },
      },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap', marginBottom: '16px' } },
          h('div', { style: { minWidth: 0 } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap' } },
              h('strong', { style: { fontSize: '16px', fontWeight: 700, color: BRAND.ink, overflowWrap: 'anywhere' } }, profile.modelName || '新模型'),
              profile.default && profile.enabled !== false ? h(Pill, { tone: 'accent' }, '默认') : null,
              h(Pill, { tone: profileStatus(profile).tone }, profileStatus(profile).label)),
            h('div', { style: { marginTop: '5px', color: BRAND.inkMuted, fontSize: '12px' } }, modelProviderLabel(profile.provider), ' · ', profile.id || '未命名 profile')),
          h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
            profile.default && profile.enabled !== false ? null : h('button', { type: 'button', disabled: profile.enabled === false, onClick: () => setDefaultProfile(index), style: { ...buttonStyle(), padding: '6px 10px' } }, '设为默认'),
            h('button', { type: 'button', onClick: () => toggleProfileEnabled(index), style: { ...buttonStyle(), padding: '6px 10px' } }, profile.enabled === false ? '启用' : '停用'),
            form.profiles.length <= 1 ? null : h('button', { type: 'button', onClick: () => removeProfile(index), style: { ...buttonStyle(), padding: '6px 10px' } }, '移除'))),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' } },
          h('label', { style: { color: BRAND.inkMuted, fontSize: '12px', fontWeight: 700 } }, '提供商', h('select', {
            'data-model-provider': profile.id || index,
            'aria-label': '提供商',
            value: profile.provider === 'ksyun' || profile.provider === 'openai' ? profile.provider : 'custom',
            onChange: event => {
              const provider = event.target.value;
              setForm(current => ({ ...current, profiles: current.profiles.map((item, cursor) => cursor === index ? {
                ...item, provider, baseUrl: provider === 'ksyun' ? DEFAULT_KSYUN_BASE_URL : provider === 'openai' ? 'https://api.openai.com/v1' : '', input: undefined, inputCapability: 'pending',
              } : item) }));
            },
            style: inputStyle(),
          }, h('option', { value: 'ksyun' }, '金山云模型服务'), h('option', { value: 'openai' }, 'OpenAI'), h('option', { value: 'custom' }, '自定义提供商')),
          profile.provider === 'ksyun' ? h('div', { style: { padding: '10px 12px', borderRadius: '10px', background: BRAND.canvas, color: BRAND.inkMuted, fontSize: '12px', alignSelf: 'end' } }, '金山云使用默认地址，无需填写 API 地址。') : h('label', { style: { color: BRAND.inkMuted, fontSize: '12px', fontWeight: 700 } }, 'API 地址', h('input', {
            value: profile.baseUrl,
            'aria-label': 'API 地址',
            placeholder: '例如：https://api.example.com/v1',
            onChange: event => setProfile(index, 'baseUrl', event.target.value),
            onBlur: () => { try { setProfile(index, 'baseUrl', normalizeModelEndpoint(profile.baseUrl, profile.provider)); } catch (reason) { setError(reason.message); } },
            style: inputStyle(),
          }))),
        h('div', { style: { marginTop: '14px', padding: '12px', borderRadius: '12px', background: BRAND.canvas, border: '1px solid ' + BRAND.border } },
          h('label', { style: { display: 'block', color: BRAND.inkMuted, fontSize: '12px', fontWeight: 700 } }, '1. API Key', h(SecretInput, {
            label: 'API Key', value: profile.apiKey,
            placeholder: profileCredential(profile).configured ? '已配置，留空保持不变' : '先填写 Key，再读取模型',
            autoComplete: 'new-password',
            onChange: event => setProfile(index, 'apiKey', event.target.value), style: inputStyle(),
          })),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px', flexWrap: 'wrap' } },
            h('button', { type: 'button', onClick: () => readModelCatalog(index), disabled: connection.state === 'loading', style: { ...buttonStyle(), padding: '6px 10px' } }, connection.state === 'loading' ? '读取中…' : '读取模型'),
            h('button', { type: 'button', onClick: () => testModelConnection(index), disabled: connection.state === 'loading', style: { ...buttonStyle(), padding: '6px 10px' } }, '测试连接'),
            h('span', { style: { color: BRAND.inkMuted, fontSize: '11px' } }, sourceLabel(profileCredential(profile).source)),
            profile.provider === 'ksyun' ? h('a', { href: 'https://ksp.console.ksyun.com/#/apiKey', target: '_blank', rel: 'noopener noreferrer', style: { color: BRAND.accentStrong, textDecoration: 'underline' } }, '获取 Key') : null),
          connection.message ? h('div', { role: 'status', style: { marginTop: '6px', color: connection.state === 'error' ? BRAND.danger : connection.state === 'warning' ? BRAND.signal : BRAND.accentStrong, fontSize: '11px' } }, connection.message) : null),
        h('div', { style: { marginTop: '14px' } },
          h('label', { style: { display: 'block', color: BRAND.inkMuted, fontSize: '12px', fontWeight: 700 } }, '2. 选择模型', modelSelect, customModel,
            h('span', { style: { display: 'block', marginTop: '6px', color: BRAND.inkMuted, fontSize: '11px' } }, catalogItems.length ? '可从目录选择，也可以手动填写自定义模型名。' : '填写 API Key 后点击“读取模型”，也可以直接手动填写模型名。'))),
        h('div', { role: 'status', 'data-model-input-capability': profile.inputCapability || 'pending', style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px', margin: '16px 0 12px', padding: '10px 12px', borderRadius: '10px', background: BRAND.canvas, fontSize: '13px' } },
          h('span', { style: { color: BRAND.inkMuted, fontWeight: 700 } }, '输入能力'),
          profile.inputCapability === 'catalog' ? [h(Pill, null, '文字'), profile.input?.includes('image') ? h(Pill, null, '图片') : null, h('span', { style: { color: BRAND.inkMuted, fontSize: '12px' } }, '模型目录已识别')] : h('span', { style: { color: BRAND.inkMuted } }, ({ unknown: '模型目录未提供能力信息', unavailable: '暂时无法读取模型目录', missing: '模型目录中未找到该模型' }[profile.inputCapability] || (status === 'loading' ? '正在读取模型目录…' : '保存后自动识别')))),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' } },
          h('label', { style: { display: 'block', color: BRAND.inkMuted, fontSize: '12px', fontWeight: 700 } }, '思考等级', h('select', {
            value: profile.reasoningEfforts ? profile.defaultReasoningEffort || 'high' : '',
            onChange: event => { const level = event.target.value; setProfile(index, 'reasoningEfforts', level ? true : undefined); setProfile(index, 'defaultReasoningEffort', level || undefined); }, style: inputStyle(),
          }, h('option', { value: '' }, '不启用'), h('option', { value: 'low' }, '低'), h('option', { value: 'high' }, '高（推荐）'), h('option', { value: 'max' }, '最高')), h('span', { style: { display: 'block', marginTop: '6px', fontSize: '11px', color: BRAND.inkMuted, fontWeight: 400 } }, '仅对支持 reasoning_effort 的模型开启；启用后对话框模型选择器会出现“推理等级”。'))),
        mode === 'all' && h('details', { style: { marginTop: '14px', paddingTop: '12px', borderTop: '1px solid ' + BRAND.border, color: BRAND.inkMuted } }, h('summary', { style: { cursor: 'pointer', color: BRAND.ink, fontSize: '12px', fontWeight: 700 } }, '高级连接设置'), h('label', { style: { display: 'block', marginTop: '10px' } }, 'Codex 连接协议', h('select', { value: profile.codexApi || 'responses', onChange: event => setProfile(index, 'codexApi', event.target.value), style: inputStyle() }, h('option', { value: 'responses' }, 'Responses'), h('option', { value: 'chat-completions' }, 'Chat Completions')), h('span', { style: { fontSize: '12px', display: 'block', marginTop: '6px' } }, '只影响 Codex 运行时。服务仅支持 Chat Completions 时选择该协议。')), thinkingControl(profile, index))));
    });
    const modelSection = mode !== 'cloud' && h('section', null,
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: '16px', flexWrap: 'wrap', marginBottom: '12px' } }, h('div', null, h('h3', { style: { margin: 0, color: BRAND.ink, fontSize: '18px', fontWeight: 700 } }, '模型与提供商'), h('p', { style: { margin: '6px 0 0', color: BRAND.inkMuted, fontSize: '12px', lineHeight: 1.5 } }, '先填写 API Key，再读取模型目录并测试连接；也支持手动填写模型名。')), form.profiles.length ? h(Pill, { tone: 'neutral' }, `${form.profiles.length} 个模型`) : null),
      modelSummary(),
      h('div', { style: { display: 'grid', gap: '14px', marginTop: '14px' } }, profileCards));
    const cloudSection = mode !== 'model' && h('section', { style: { border: '1px solid ' + BRAND.border, borderRadius: '12px', padding: '14px', background: BRAND.surface } },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center', marginBottom: '10px', flexWrap: 'wrap' } }, h('div', null, h('h3', { style: { margin: 0, color: BRAND.ink, fontSize: '14px' } }, '云端凭证'), h('p', { style: { margin: '3px 0 0', color: BRAND.inkMuted, fontSize: '11px' } }, '用于构建、部署和资源访问')), h(Pill, { tone: cloudStatus.configured ? 'accent' : 'signal' }, cloudStatus.configured ? '已配置' : '未配置')),
      h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '9px' } }, field('Access Key', 'cloudAccessKey', cloudStatus.configured ? '已配置，留空保持不变' : '云端 Access Key', 'password'), field('Secret Key', 'cloudSecretKey', cloudStatus.configured ? '已配置，留空保持不变' : '云端 Secret Key', 'password')),
      h('details', { style: { marginTop: '10px', color: BRAND.inkMuted, fontSize: '11px' } }, h('summary', { style: { cursor: 'pointer', color: BRAND.ink, fontWeight: 700 } }, '高级云端设置'), h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '9px', marginTop: '8px' } }, field('Account ID', 'cloudAccountId', '可选'), field('区域', 'cloudRegion', '例如：cn-beijing-6'), field('控制面地址', 'cloudServerUrl', '例如：https://agentengine.example.com'), field('对象存储桶', 'cloudBucket', '可选'))), h('div', { style: { marginTop: '9px', color: BRAND.inkMuted, fontSize: '10px' } }, '当前来源：', sourceLabel(cloudStatus.source)));
    return h('div', { 'data-studio-model-settings': true, 'data-onboarding-mode': mode, style: { color: BRAND.ink, minWidth: 0, padding: '0 0 18px', fontFamily: 'inherit' } },
      status === 'error' ? h('div', { role: 'alert', style: { marginBottom: '10px', color: BRAND.danger, fontSize: '12px' } }, error) : null,
      h('form', { onSubmit: save, style: { display: 'grid', gap: '20px', width: '100%', maxWidth: '980px' } },
        modelSection,
        cloudSection,
        h('div', { 'data-studio-form-footer': true, style: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '9px', flexWrap: 'wrap' } }, message ? h('span', { role: 'status', style: { color: BRAND.accentStrong, fontSize: '11px', marginRight: 'auto' } }, message) : null, error ? h('span', { role: 'alert', style: { color: BRAND.danger, fontSize: '11px', marginRight: 'auto' } }, error) : null, h('button', { type: 'button', onClick: load, style: buttonStyle() }, '重新读取'), h('button', { type: 'submit', disabled: saving || status !== 'ready', style: { ...buttonStyle(), color: BRAND.primaryText, background: saving || status !== 'ready' ? 'var(--dsw-alias-label-tertiary, #aab7c4)' : BRAND.primaryFill, borderColor: 'transparent' } }, saving ? '保存中…' : mode === 'model' ? '保存并继续' : mode === 'cloud' ? '保存并完成' : '保存配置'))));
  }
  return ModelSettingsSection;
}
