import { DEFAULT_KSYUN_BASE_URL, DEFAULT_KSYUN_MODEL, DSH_MODEL_CREDENTIAL, DSH_MODEL_SETTINGS_NS, modelCredentialName, modelProfileId } from '../dsh/model-bridge.mjs';
import { BRAND as DEFAULT_BRAND } from '../theme.mjs';
import { normalizeModelEndpoint } from '../../model-endpoint.mjs';

export function createModelSettingsSection({ ui, hostRemote, window = globalThis.window, CustomEvent = globalThis.CustomEvent }) {
  const { React, Pill, SecretInput, buttonStyle, inputStyle, BRAND = DEFAULT_BRAND } = ui;
  const { createElement: h, useEffect, useState } = React;
  function ModelSettingsSection({ dshModel, mode = 'all', onSaved }) {
    const [form, setForm] = useState({
      profiles: [{ id: 'default', provider: 'ksyun', baseUrl: DEFAULT_KSYUN_BASE_URL, modelName: DEFAULT_KSYUN_MODEL, credentialName: DSH_MODEL_CREDENTIAL, apiKey: '', enabled: true, default: true }],
      cloudAccessKey: '', cloudSecretKey: '', cloudAccountId: '', cloudRegion: '', cloudServerUrl: '', cloudBucket: '',
    });
    const [modelStatus, setModelStatus] = useState({});
    const [cloudStatus, setCloudStatus] = useState({ configured: false, source: 'missing' });
    const [dshStatus, setDshStatus] = useState({ configured: false, model: '', credentialConfigured: false });
    const [status, setStatus] = useState('loading');
    const [message, setMessage] = useState('');
    const [error, setError] = useState('');
    const [saving, setSaving] = useState(false);

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
        const hasDefault = loaded.some(profile => profile.default === true);
        const profiles = loaded.map((profile, index) => ({ ...legacy, ...profile, id: modelProfileId(profile, index), credentialName: modelCredentialName(profile, index), default: hasDefault ? profile.default === true : index === 0, apiKey: '' }));
        const discoveredProfiles = await hydrateModelInputs(profiles);
        if (discoveredProfiles.some((profile, index) => JSON.stringify(profile.input || ['text']) !== JSON.stringify(profiles[index].input || ['text']))) {
          // Repair profiles saved before nested architecture.input_modalities
          // was recognized, and immediately refresh DSH's provider route.
          await hostRemote.updateSettings({ modelProfiles: discoveredProfiles }).catch(() => {});
          await dshModel.applyProfiles({ profiles: discoveredProfiles, keys: {} }).catch(() => {});
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
    const setField = (key, value) => setForm(current => ({ ...current, [key]: value }));
    const setProfile = (index, key, value) => setForm(current => ({ ...current, profiles: current.profiles.map((profile, cursor) => cursor === index
      ? { ...profile, ...(['modelName', 'provider', 'baseUrl'].includes(key) ? { input: undefined, inputCapability: 'pending' } : {}), [key]: value } : profile) }));
    const addProfile = () => setForm(current => ({ ...current, profiles: [...current.profiles, { id: `profile-${Date.now()}`, provider: 'ksyun', baseUrl: DEFAULT_KSYUN_BASE_URL, modelName: '', credentialName: `AGENTKIT_MODEL_API_KEY_${Date.now().toString(36).toUpperCase()}`, apiKey: '', enabled: true, default: false }] }));
    const setDefaultProfile = index => setForm(current => ({ ...current, profiles: current.profiles.map((profile, cursor) => ({ ...profile, default: cursor === index })) }));
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
        const rawProfiles = form.profiles.map((profile, index) => ({ id: modelProfileId(profile, index), provider: profile.provider.trim() || 'ksyun', modelName: profile.modelName.trim(), baseUrl: normalizeModelEndpoint(profile.baseUrl, profile.provider), credentialName: modelCredentialName(profile, index), enabled: profile.enabled !== false, default: profile.default === true, codexApi: profile.codexApi || 'responses', input: profile.input || ['text'] }));
        const defaultIndex = rawProfiles.findIndex(profile => profile.default);
        const profiles = rawProfiles.map((profile, index) => ({ ...profile, default: defaultIndex < 0 ? index === 0 : index === defaultIndex }));
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
        await hostRemote.updateSettings({ modelProfiles: discoveredProfiles });
        await dshModel.applyProfiles({ profiles: discoveredProfiles, keys });
        setForm(current => ({ ...current, profiles: current.profiles.map(profile => ({ ...profile, apiKey: '' })), cloudAccessKey: '', cloudSecretKey: '' }));
        window.dispatchEvent(new CustomEvent('agentkit-studio:model-credential-changed'));
        setMessage('已保存多个模型配置；标记为“默认”的模型用于新会话，Agent 可在创建或编辑时多选模型绑定。');
        await load();
        onSaved?.();
      } catch (reason) { setError(reason?.message || '保存模型与凭证失败'); } finally { setSaving(false); }
    };
    const field = (label, key, placeholder, type = 'text') => h('label', { style: { display: 'block', color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, label, h(type === 'password' ? SecretInput : 'input', { label, type, value: form[key] || '', placeholder, autoComplete: type === 'password' ? 'new-password' : 'off', onChange: event => setField(key, event.target.value), style: inputStyle() }));
    return h('div', { 'data-studio-model-settings': true, 'data-onboarding-mode': mode, style: { color: BRAND.ink, minWidth: 0, padding: '0 0 18px', fontFamily: 'inherit' } },
      status === 'error' ? h('div', { role: 'alert', style: { marginBottom: '10px', color: BRAND.danger, fontSize: '12px' } }, error) : null,
      h('form', { onSubmit: save, style: { display: 'grid', gap: '24px', maxWidth: '760px' } },
        mode !== 'cloud' && h('section', null,
          h('div', { style: { marginBottom: '8px' } }, h('h3', { style: { margin: 0, color: BRAND.ink, fontSize: '16px', fontWeight: 600 } }, '模型与提供商'), h('p', { style: { margin: '6px 0 0', color: BRAND.inkMuted, fontSize: '13px', lineHeight: 1.5 } }, '设置聊天默认模型和凭证，输入能力由模型目录自动识别。')),
          h('div', { style: { display: 'grid' } }, form.profiles.map((profile, index) => h('article', { key: profile.id || index, style: { borderBottom: '1px solid ' + BRAND.border, padding: '16px 0' } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '14px' } }, h('div', { style: { display: 'flex', alignItems: 'center', gap: '7px' } }, h('strong', { style: { fontSize: '14px', fontWeight: 600, color: BRAND.ink } }, profile.modelName || '新模型'), profile.default ? h(Pill, { tone: 'accent' }, '默认') : null), h('div', { style: { display: 'flex', gap: '6px' } }, profile.default ? null : h('button', { type: 'button', onClick: () => setDefaultProfile(index), style: { ...buttonStyle(), padding: '4px 8px' } }, '设为默认'), form.profiles.length <= 1 ? null : h('button', { type: 'button', onClick: () => removeProfile(index), style: { ...buttonStyle(), padding: '4px 8px' } }, '移除'))),
            h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(150px, .8fr) minmax(180px, 1.2fr)', gap: '9px' } }, h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '提供商', h('select', { value: profile.provider === 'ksyun' || profile.provider === 'openai' ? profile.provider : 'custom', onChange: event => { setProfile(index, 'provider', event.target.value); setProfile(index, 'baseUrl', event.target.value === 'ksyun' ? DEFAULT_KSYUN_BASE_URL : event.target.value === 'openai' ? 'https://api.openai.com/v1' : ''); }, style: inputStyle() }, h('option', { value: 'ksyun' }, '金山云模型服务'), h('option', { value: 'openai' }, 'OpenAI'), h('option', { value: 'custom' }, '自定义提供商'))), h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '模型名称', h('input', { value: profile.modelName, placeholder: DEFAULT_KSYUN_MODEL, onChange: event => setProfile(index, 'modelName', event.target.value), style: inputStyle() }))),
            profile.provider === 'ksyun' ? h('div', { style: { marginTop: '8px', color: BRAND.inkMuted, fontSize: '10px' } }, '金山云模型服务使用默认地址，无需填写 API 地址。') : h('label', { style: { display: 'block', marginTop: '8px', color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, 'API 地址', h('input', { value: profile.baseUrl, placeholder: '例如：api.example.com 或完整接口地址', onChange: event => setProfile(index, 'baseUrl', event.target.value), onBlur: () => { try { setProfile(index, 'baseUrl', normalizeModelEndpoint(profile.baseUrl, profile.provider)); } catch (reason) { setError(reason.message); } }, style: inputStyle() })),
            h('div', { role: 'status', 'data-model-input-capability': profile.inputCapability || 'pending', style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px', margin: '14px 0', fontSize: '13px' } }, h('span', { style: { color: BRAND.inkMuted } }, '输入能力'),
              profile.inputCapability === 'catalog' ? [h(Pill, null, '文字'), profile.input?.includes('image') ? h(Pill, null, '图片') : null, h('span', { style: { color: BRAND.inkMuted, fontSize: '12px' } }, '模型目录已识别')]
                : h('span', { style: { color: BRAND.inkMuted } }, ({ unknown: '模型目录未提供能力信息', unavailable: '暂时无法读取模型目录', missing: '模型目录中未找到该模型' }[profile.inputCapability] || (status === 'loading' ? '正在读取模型目录…' : '保存后自动识别')))),
            h('label', { style: { display: 'block', marginTop: '8px', color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, 'API Key', h(SecretInput, { label: 'API Key', value: profile.apiKey, placeholder: modelStatus[profile.credentialName]?.configured ? '已配置，留空保持不变' : '由本机 Host 安全保存', autoComplete: 'new-password', onChange: event => setProfile(index, 'apiKey', event.target.value), style: inputStyle() }), h('div', { style: { display: 'flex', gap: '10px', marginTop: '6px', color: BRAND.inkMuted, fontSize: '12px', flexWrap: 'wrap' } }, h('span', null, sourceLabel(modelStatus[profile.credentialName]?.source)), profile.provider === 'ksyun' ? h('a', { href: 'https://ksp.console.ksyun.com/#/apiKey', target: '_blank', rel: 'noopener noreferrer', style: { color: BRAND.accentStrong, textDecoration: 'underline' } }, '获取 Key') : null)),
            mode === 'all' && h('details', { style: { marginTop: '14px', color: BRAND.inkMuted } }, h('summary', { style: { cursor: 'pointer', color: BRAND.ink } }, '高级连接设置'), h('label', { style: { display: 'block', marginTop: '10px' } }, 'Codex 连接协议', h('select', { value: profile.codexApi || 'responses', onChange: event => setProfile(index, 'codexApi', event.target.value), style: inputStyle() }, h('option', { value: 'responses' }, 'Responses'), h('option', { value: 'chat-completions' }, 'Chat Completions')), h('span', { style: { fontSize: '12px', display: 'block', marginTop: '6px' } }, '只影响 Codex 运行时。服务仅支持 Chat Completions 时选择该协议。')))
          ))),
          mode === 'all' && h('button', { type: 'button', onClick: addProfile, style: { ...buttonStyle(), marginTop: '10px' } }, '＋ 添加提供商或模型')),
        mode !== 'model' && h('section', { style: { border: '1px solid ' + BRAND.border, borderRadius: '12px', padding: '14px', background: BRAND.surface } }, h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center', marginBottom: '10px', flexWrap: 'wrap' } }, h('div', null, h('h3', { style: { margin: 0, color: BRAND.ink, fontSize: '14px' } }, '云端凭证'), h('p', { style: { margin: '3px 0 0', color: BRAND.inkMuted, fontSize: '11px' } }, '用于构建、部署和资源访问')), h(Pill, { tone: cloudStatus.configured ? 'accent' : 'signal' }, cloudStatus.configured ? '已配置' : '未配置')), h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '9px' } }, field('Access Key', 'cloudAccessKey', cloudStatus.configured ? '已配置，留空保持不变' : '云端 Access Key', 'password'), field('Secret Key', 'cloudSecretKey', cloudStatus.configured ? '已配置，留空保持不变' : '云端 Secret Key', 'password')), h('details', { style: { marginTop: '10px', color: BRAND.inkMuted, fontSize: '11px' } }, h('summary', { style: { cursor: 'pointer', color: BRAND.ink, fontWeight: 700 } }, '高级云端设置'), h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '9px', marginTop: '8px' } }, field('Account ID', 'cloudAccountId', '可选'), field('区域', 'cloudRegion', '例如：cn-beijing-6'), field('控制面地址', 'cloudServerUrl', '例如：https://agentengine.example.com'), field('对象存储桶', 'cloudBucket', '可选'))), h('div', { style: { marginTop: '9px', color: BRAND.inkMuted, fontSize: '10px' } }, '当前来源：', sourceLabel(cloudStatus.source))),
        h('div', { 'data-studio-form-footer': true, style: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '9px', flexWrap: 'wrap' } }, message ? h('span', { role: 'status', style: { color: BRAND.accentStrong, fontSize: '11px', marginRight: 'auto' } }, message) : null, error ? h('span', { role: 'alert', style: { color: BRAND.danger, fontSize: '11px', marginRight: 'auto' } }, error) : null, h('button', { type: 'button', onClick: load, style: buttonStyle() }, '重新读取'), h('button', { type: 'submit', disabled: saving || status !== 'ready', style: { ...buttonStyle(), color: BRAND.primaryText, background: saving || status !== 'ready' ? 'var(--dsw-alias-label-tertiary, #aab7c4)' : BRAND.primaryFill, borderColor: 'transparent' } }, saving ? '保存中…' : mode === 'model' ? '保存并继续' : mode === 'cloud' ? '保存并完成' : '保存配置'))));
  }
  return { ModelSettingsSection };
}
