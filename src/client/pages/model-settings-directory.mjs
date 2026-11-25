import { normalizeModelEndpoint } from '../../model-endpoint.mjs';
import { lookupModelCapabilities } from '../../model-capability-catalog.mjs';
import { resolveModelBudgets } from '../../model-capabilities.mjs';
import { profileKey } from './model-settings-profiles.mjs';
import { catalogItems, createModelCatalogPicker, matchingModels } from './model-settings-catalog-picker.mjs';

function connectionAddressLabel({ address }) {
  if (!address) return '未填写 API 地址';
  const url = new URL(address);
  return url.host + url.pathname;
}

const PROVIDER_TYPES = ['ksyun', 'openai', 'custom'];

export function createModelSettingsDirectory({ h, useState, useEffect, useRef, useEffortProbe, Chip, SecretInput, providerLabel, makeId }) {
  const title = group => group.name ? group.label : [providerLabel(group.provider), group.label].filter(Boolean).join(' · ');
  const searchField = (label, value, onChange) => h('label', { className: 'ms-search' },
    h('input', {
      type: 'search', className: 'ms-input', 'aria-label': label, placeholder: label, value,
      onChange: event => onChange(event.target.value),
      onKeyDown: event => { if (event.key === 'Enter') event.preventDefault(); },
    }));
  const backButton = (label, onClick) => h('button', { type: 'button', className: 'ms-back', onClick },
    h('span', { className: 'ms-chevron', 'aria-hidden': 'true' }), label);
  const button = (label, onClick, variant, extra = {}) => h('button', {
    type: 'button', className: 'ms-btn', 'data-variant': variant, onClick, ...extra,
  }, label);
  const field = (label, input) => h('label', { className: 'ms-field' }, h('span', { className: 'ms-label' }, label), input);
  const note = (text, type = 'status') => h('p', { role: type, className: 'ms-empty' }, text);
  const modelRows = createModelCatalogPicker(h);

  function useModelSettingsDirectory({
    status, saving, connections, profileCount, drafts, openModel, credentialConfigured,
    fetchCatalog, checkProvider, probeEfforts, stageModels, stageProvider, saveProvider, removeProvider,
  }) {
    const [query, setQuery] = useState('');
    const [modelQuery, setModelQuery] = useState('');
    const [providerId, setProviderId] = useState('');
    const [providerForm, setProviderForm] = useState(null);
    const [confirmRemove, setConfirmRemove] = useState(false);
    const [catalog, setCatalog] = useState(null);
    const batch = useEffortProbe(providerForm?.check || catalog?.token);
    const probing = Boolean(batch.progress);
    const ready = status === 'ready';
    const active = connections.find(group => group.id === providerId);
    const importGroup = catalog && connections.find(group => group.id === catalog.providerId);
    const importedCount = catalog ? [...catalog.picks.values()].reduce((total, items) => total + items.size, 0) : 0;
    const reportKey = (connection, modelName) => JSON.stringify([connection.id, modelName]);
    const jobsFor = (items, connection) => [...(items?.keys() || [])]
      .map(modelName => ({ key: reportKey(connection, modelName), modelName, connection }));
    const probeControl = jobs => {
      if (!probeEfforts || (!jobs.length && !probing)) return null;
      const run = () => batch.run(jobs, ({ connection, modelName }, signal) => probeEfforts(connection, modelName, signal));
      return h('div', { className: 'ms-effort-actions' },
        button(probing ? '停止探测' : `探测 ${jobs.length} 个模型的档位`, probing ? batch.stop : run, undefined, { 'data-size': 'sm' }),
        probing ? h('span', { role: 'status', className: 'ms-hint' }, `正在探测 ${batch.progress.done} / ${batch.progress.total}`)
          : h('span', { className: 'ms-hint' }, '会发送简短的测试请求，结果仅供诊断'));
    };

    const openProvider = id => {
      setProviderId(id);
      setModelQuery('');
      setConfirmRemove(false);
    };
    const editProvider = group => {
      const saved = group?.connection;
      const provider = saved?.provider || 'ksyun';
      setConfirmRemove(false);
      setProviderForm({
        id: group?.id || '', draftId: group ? '' : makeId(), provider,
        baseUrl: saved?.baseUrl ?? normalizeModelEndpoint('', provider),
        connectionName: saved?.connectionName || '', apiKey: '', error: '',
        picks: new Map(), profileIds: new Map(), query: '',
      });
    };
    const applyProvider = async () => {
      if (probing) batch.stop();
      try {
        const baseUrl = normalizeModelEndpoint(providerForm.baseUrl, providerForm.provider);
        if (!baseUrl) throw new Error('请填写 API 地址');
        const { picks, profileIds, ...connection } = providerForm;
        const input = { ...connection, baseUrl };
        const id = providerForm.id ? stageProvider(input) : await saveProvider(input, picks, profileIds);
        if (!id) return;
        setProviderForm(null);
        openProvider(id);
      } catch (error) {
        setProviderForm(current => ({ ...current, error: error?.message || '提供商配置无效' }));
      }
    };
    const testProvider = async () => {
      const attempt = { state: 'loading' };
      const report = check => setProviderForm(current => {
        if (current?.check !== attempt) return current;
        const picks = new Map(check.items?.filter(item => current.picks.has(item.id)).map(item => [item.id, item]));
        return { ...current, check, picks };
      });
      setProviderForm(current => ({ ...current, error: '', check: attempt }));
      try {
        const baseUrl = normalizeModelEndpoint(providerForm.baseUrl, providerForm.provider);
        if (!baseUrl) throw new Error('请填写 API 地址');
        const result = await checkProvider({ ...providerForm, baseUrl });
        const items = catalogItems(result);
        report({ state: 'success', baseUrl, items, message: '连接成功 · 目录返回 ' + items.length + ' 个模型' });
      } catch (error) {
        report({ state: 'error', message: error?.message || '连接失败' });
      }
    };

    // 填好地址和 Key 后自动拉取目录，不必先点「测试连接」。用 ref 去重，
    // 避免 setProviderForm 触发的重渲染把同一份配置重复拉取。
    // 简化测试 harness 不提供 useRef/useEffect 时自动拉取不启用，其余功能不变。
    const autoCheckRef = typeof useRef === 'function' ? useRef('') : { current: '' };
    if (typeof useEffect === 'function') useEffect(() => {
      if (!providerForm || providerForm.id) return;
      const { provider, baseUrl, apiKey, check } = providerForm;
      if (!baseUrl || !String(apiKey || '').trim()) return;
      if (check?.state === 'loading' || check?.state === 'success') return;
      const token = JSON.stringify([provider, baseUrl, apiKey]);
      if (autoCheckRef.current === token) return;
      autoCheckRef.current = token;
      void testProvider();
    }, [providerForm]);

    const renderNewProviderCatalog = () => {
      const { check, picks, query: catalogQuery } = providerForm;
      if (check?.state !== 'success') return null;
      const items = matchingModels(check.items, catalogQuery);
      const pick = (item, checked) => {
        const nextId = checked && !providerForm.profileIds.has(item.id) ? makeId() : '';
        setProviderForm(current => {
          const selected = new Map(current.picks);
          const profileIds = new Map(current.profileIds);
          if (checked) selected.set(item.id, item); else selected.delete(item.id);
          if (nextId) profileIds.set(item.id, nextId);
          return { ...current, picks: selected, profileIds };
        });
      };
      const connection = { ...providerForm, baseUrl: check.baseUrl };
      return h('section', { className: 'ms-panel ms-provider-catalog', 'aria-label': '模型目录' },
        h('div', { className: 'ms-provider-model-head' },
          h('h4', null, '模型目录'), h('span', { className: 'ms-row-status' }, picks.size ? '已选 ' + picks.size + ' 个' : '可跳过')),
        check.items.length ? h('div', { className: 'ms-import-toolbar' },
          searchField('搜索目录中的模型', catalogQuery, query => setProviderForm(current => ({ ...current, query }))),
          probeControl(jobsFor(picks, connection))) : null,
        items.length ? modelRows({ items, picks, connection, onPick: pick, probing,
          reportFor: id => batch.reportFor(reportKey(connection, id)) })
          : note(check.items.length ? '没有匹配的模型' : '该提供商未返回模型'));
    };

    // 手动填写模型 ID 常驻：目录拉不到、或模型不在厂商目录里时也能直接添加。
    const addManualModel = () => {
      const id = String(providerForm?.manual || '').trim();
      if (!id || !providerForm) return;
      const item = (providerForm.check?.items || []).find(entry => entry.id === id) || { id, inputKnown: false };
      const nextId = makeId();
      setProviderForm(current => {
        if (current.picks.has(id)) return { ...current, manual: '' };
        const selected = new Map(current.picks);
        const profileIds = new Map(current.profileIds);
        selected.set(id, item);
        profileIds.set(id, nextId);
        return { ...current, picks: selected, profileIds, manual: '' };
      });
    };
    const renderManualEntry = () => h('div', { className: 'ms-manual-entry', 'data-manual-model-entry': true },
      h('input', { className: 'ms-input', 'aria-label': '手动填写模型 ID', placeholder: '目录里没有？输入模型 ID 后添加',
        value: providerForm.manual || '',
        onChange: event => setProviderForm(current => ({ ...current, manual: event.target.value })),
        onKeyDown: event => { if (event.key === 'Enter') { event.preventDefault(); addManualModel(); } } }),
      button('添加', addManualModel, undefined, { 'data-size': 'sm', disabled: !String(providerForm.manual || '').trim() }));

    const renderProviderForm = () => {
      const { id, provider, baseUrl, connectionName, apiKey, error, check } = providerForm;
      const stored = connections.find(group => group.id === id)?.connection;
      const hasKey = stored && stored.provider === provider && stored.baseUrl === baseUrl && (stored.apiKey || credentialConfigured(stored));
      const types = PROVIDER_TYPES.includes(provider) ? PROVIDER_TYPES : [...PROVIDER_TYPES, provider];
    const set = (name, value) => {
      if (probing && name !== 'connectionName') batch.stop();
      setProviderForm(current => ({
        ...current, [name]: value, error: '',
        // 只有换地址才作废已勾选的模型；换 Key、名称都保留勾选，目录按新值重拉。
        ...(name === 'baseUrl' ? { check: null, picks: new Map(), query: '' }
          : name === 'apiKey' ? { check: null } : {}),
      }));
    };
      return h('section', { 'data-model-provider-editor': true },
        backButton(id ? '返回提供商' : '模型提供商', () => setProviderForm(null)),
        h('div', { className: 'ms-intro' }, h('h3', null, id ? '编辑提供商' : '添加提供商')),
        h('div', { className: 'ms-panel ms-detail' },
          h('div', { className: 'ms-grid ms-grid-2' },
            field('提供商类型', h('select', { className: 'ms-select', 'aria-label': '提供商类型', value: provider,
              onChange: event => {
                const next = event.target.value;
                if (probing) batch.stop();
                setProviderForm(current => ({ ...current, provider: next, baseUrl: normalizeModelEndpoint('', next),
                  error: '', check: null, query: '', picks: new Map() }));
              },
            }, types.map(type => h('option', { key: type, value: type }, providerLabel(type))))),
            field('名称（可选）', h('input', { className: 'ms-input', 'aria-label': '提供商名称', value: connectionName,
              placeholder: '例如：团队网关', maxLength: 64, onChange: event => set('connectionName', event.target.value) })),
            field('API 地址', h('input', { className: 'ms-input', 'aria-label': 'API 地址', value: baseUrl,
              placeholder: '例如：https://api.example.com/v1', onChange: event => set('baseUrl', event.target.value) })),
            h('div', { className: 'ms-field' },
              h('div', { className: 'ms-field-head' }, h('span', { className: 'ms-label' }, 'API Key'),
                provider === 'ksyun' ? h('a', { className: 'ms-link', href: 'https://ksp.console.ksyun.com/#/apiKey',
                  target: '_blank', rel: 'noopener noreferrer' }, '获取 Key ↗') : null),
              h(SecretInput, { className: 'ms-input', label: 'API Key', value: apiKey, autoComplete: 'new-password',
                placeholder: hasKey ? '已配置，留空保持' : '添加目录模型前填写', onChange: event => set('apiKey', event.target.value) }))),
          h('div', { className: 'ms-actions' },
            button(check?.state === 'loading' ? '测试中…' : '测试连接', testProvider, undefined,
              { disabled: probing || check?.state === 'loading', 'data-size': 'sm' }),
            check?.message ? h('p', { role: 'status', className: 'ms-note', 'data-tone': check.state === 'error' ? 'danger' : 'success' }, check.message) : null),
          error ? h('p', { role: 'alert', className: 'ms-note', 'data-tone': 'danger' }, error) : null),
        id ? null : [renderNewProviderCatalog(), renderManualEntry()]);
    };

    const readCatalog = async (token, group) => {
      const update = result => setCatalog(current => current?.token === token
        ? { ...current, results: new Map(current.results).set(group.id, result) } : current);
      update({ status: 'loading' });
      try {
        const response = await fetchCatalog(group);
        update({ status: 'ready', items: catalogItems(response) });
      } catch (error) {
        update({ status: 'error', message: error?.message || '读取模型目录失败' });
      }
    };
    const openImport = group => {
      const token = {};
      setCatalog({ token, providerId: group.id, query: '', manual: null, results: new Map(), picks: new Map() });
      void readCatalog(token, group);
    };
    const selectImportProvider = id => {
      const group = connections.find(item => item.id === id);
      if (!group) return;
      setCatalog(current => ({ ...current, providerId: id, query: '', manual: null }));
      if (!catalog.results.has(id)) void readCatalog(catalog.token, group);
    };
    const pickModel = (group, model, checked, manual = false) => setCatalog(current => {
      if (current?.token !== catalog.token) return current;
      const picks = new Map(current.picks);
      const items = new Map(picks.get(group.id));
      if (checked) items.set(model.id, model); else items.delete(model.id);
      if (items.size) picks.set(group.id, items); else picks.delete(group.id);
      return { ...current, picks, ...(manual ? { manual: null, query: '' } : {}) };
    });
    const addSelected = () => {
      if (!importedCount || !stageModels(catalog.picks)) return;
      openProvider(importGroup.id);
      setCatalog(null);
    };

    const renderImportPanel = () => {
      const group = importGroup;
      const selection = catalog.picks.get(group.id);
      const result = catalog.results.get(group.id);
      const items = result?.items || [];
      const existing = new Set(group.models.map(({ profile }) => profile.modelName.trim()));
      const catalogIds = new Set(items.map(item => item.id));
      const extra = [...(selection?.values() || [])].filter(item => !catalogIds.has(item.id));
      const matching = matchingModels([...items, ...extra], catalog.query);
      const jobs = connections.flatMap(connection => jobsFor(catalog.picks.get(connection.id), connection.connection));
      const addManual = () => {
        if (probing) return;
        const id = catalog.manual.trim();
        if (!id || existing.has(id) || selection?.has(id)) return;
        pickModel(group, items.find(item => item.id === id) || { id, inputKnown: false }, true, true);
      };
      return h('section', { 'data-model-import': true },
        backButton('返回提供商', () => setCatalog(null)),
        h('div', { className: 'ms-intro' }, h('h3', null, '从目录添加模型'),
          button('手动添加', () => setCatalog(current => ({ ...current, manual: current.manual === null ? '' : null })), undefined,
            { 'aria-expanded': catalog.manual !== null })),
        h('div', { className: 'ms-panel' },
          h('div', { className: 'ms-import-toolbar' },
            field('提供商', h('select', { className: 'ms-select', 'aria-label': '选择提供商', value: group.id,
              onChange: event => selectImportProvider(event.target.value) },
            connections.map(item => {
              const picked = catalog.picks.get(item.id)?.size;
              return h('option', { key: item.id, value: item.id }, title(item), picked ? ' · 已选 ' + picked : '');
            }))),
            catalog.manual !== null ? h('div', { className: 'ms-manual-entry' },
              h('input', { className: 'ms-input', 'aria-label': '模型 ID', value: catalog.manual, placeholder: '输入提供商的模型 ID',
                onChange: event => { const manual = event.target.value; setCatalog(current => ({ ...current, manual })); },
                onKeyDown: event => { if (event.key === 'Enter') { event.preventDefault(); addManual(); } } }),
              button('加入所选', addManual, undefined,
                { disabled: probing || !catalog.manual.trim() || existing.has(catalog.manual.trim()) || Boolean(selection?.has(catalog.manual.trim())) })) : null,
            items.length ? searchField('搜索目录中的模型', catalog.query, value => setCatalog(current => ({ ...current, query: value }))) : null,
            probeControl(jobs)),
          result?.status === 'error' ? h('div', { className: 'ms-catalog-message' },
            h('p', { role: 'alert', className: 'ms-note', 'data-tone': 'danger' }, result.message),
            button('重新读取', () => readCatalog(catalog.token, group), undefined, { 'data-size': 'sm', disabled: probing }))
            : result?.status !== 'ready' ? note('正在读取目录…')
              : !matching.length ? note(items.length ? '没有匹配的模型' : '该提供商未返回模型') : null,
          matching.length ? modelRows({ items: matching, picks: selection, existing, connection: group.connection,
            onPick: (item, checked) => pickModel(group, item, checked), manualIds: new Set(extra.map(item => item.id)), probing,
            reportFor: id => batch.reportFor(reportKey(group.connection, id)) }) : null));
    };

    const renderModelRow = ({ profile, index }) => {
      const key = profileKey(profile, index);
      const name = profile.modelName;
      const dirty = drafts.has(key);
      const catalog = lookupModelCapabilities(profile);
      const budgets = resolveModelBudgets(profile, null);
      const cap = budgets.contextWindow >= 1000000 ? `${Math.round(budgets.contextWindow / 1000000)}M` : `${Math.round(budgets.contextWindow / 1000)}K`;
      const vision = catalog?.image || profile.input?.includes('image');
      return h('li', { key }, h('button', { type: 'button', className: 'ms-model-row', 'data-model-row': key, 'data-draft': dirty,
        onClick: () => openModel(key) },
      h('span', { className: 'ms-model-name', title: name }, name),
      h('span', { className: 'ms-model-cap', 'data-model-cap': true, title: '上下文窗口' }, cap),
      vision ? h('span', { className: 'ms-model-vision', title: '支持图片输入' }, '视觉') : null,
      profile.enabled === false ? h('span', { className: 'ms-row-status' }, '已停用') : null,
      profile.default && profile.enabled !== false ? h(Chip, { tone: 'accent', 'data-size': 'xs' }, '默认') : null,
      dirty ? h('span', { className: 'ms-row-status', 'data-tone': 'draft' }, '未保存') : null,
      h('span', { className: 'ms-chevron', 'aria-hidden': 'true' })));
    };
    const renderProvider = group => {
      const validOthers = connections.some(item => item.id !== group.id && item.models.some(({ profile }) => profile.enabled !== false));
      const canRemove = validOthers || group.models.every(({ profile }) => profile.enabled === false);
      const removingDefault = group.models.some(({ profile }) => profile.enabled !== false && profile.default);
      const matches = group.models.filter(({ profile }) => profile.modelName.toLowerCase().includes(modelQuery.trim().toLowerCase()));
      return h('section', { 'data-model-provider': group.id },
        backButton('模型提供商', () => openProvider('')),
        h('div', { className: 'ms-intro' },
          h('div', null, h('h3', null, title(group)), h('p', null, connectionAddressLabel(group))),
          h('div', { className: 'ms-actions' },
            button('编辑提供商', () => editProvider(group)),
            button('移除提供商', () => setConfirmRemove(true), 'danger'))),
        confirmRemove ? h('section', { className: 'ms-remove-confirm', 'aria-label': '移除提供商确认' },
          h('strong', null, '移除「' + title(group) + '」？'),
          h('p', null, canRemove
            ? '保存后将移除该提供商及其 ' + group.models.length + ' 个模型。' + (removingDefault ? 'Studio 将使用剩余的一个已启用模型作为默认模型。' : '')
            : '此提供商包含最后一个已启用模型。请先在其他提供商添加或启用模型。'),
          h('div', { className: 'ms-actions' },
            button('取消', () => setConfirmRemove(false)),
            button('确认移除', () => { if (removeProvider(group)) openProvider(''); }, 'danger', { disabled: !canRemove }))) : null,
        h('div', { className: 'ms-panel' },
          h('div', { className: 'ms-provider-model-head' },
            h('h4', null, '已添加模型'), h('span', { className: 'ms-row-status' }, group.models.length + ' 个'),
            button('添加模型', () => openImport(group), 'primary')),
          group.models.length > 6 ? h('div', { className: 'ms-directory-toolbar' }, searchField('搜索这个提供商的模型', modelQuery, setModelQuery)) : null,
          matches.length ? h('ul', { className: 'ms-model-list ms-group-list', 'aria-label': '已添加模型' }, matches.map(renderModelRow))
            : note(group.models.length ? '没有匹配的模型' : '暂未添加模型')));
    };
    const renderOverview = () => {
      const term = query.trim().toLowerCase();
      const matches = connections.filter(group => [title(group), providerLabel(group.provider), connectionAddressLabel(group),
        ...group.models.map(({ profile }) => profile.modelName)].join(' ').toLowerCase().includes(term));
      return h('section', { 'data-model-directory': true },
        h('div', { className: 'ms-intro' },
          h('div', null, h('h3', null, '模型提供商'),
            ready ? h('p', null, connections.length + ' 个提供商 · ' + profileCount + ' 个模型') : null),
          button('＋ 添加提供商', () => editProvider(), 'primary', { disabled: !ready })),
        ready ? h('div', { className: 'ms-panel' },
          h('div', { className: 'ms-directory-toolbar' }, searchField('搜索提供商或模型', query, setQuery)),
          h('div', { className: 'ms-group-list', 'aria-label': '提供商列表' },
            !matches.length ? note('没有匹配的提供商') : null,
            matches.map(group => h('button', { key: group.id, type: 'button', className: 'ms-provider-row',
              'data-model-connection': group.id, onClick: () => openProvider(group.id) },
            h('span', { className: 'ms-connection-text' },
              h('span', { className: 'ms-connection-name' }, title(group)),
              h('span', { className: 'ms-connection-address' }, [
                group.name ? providerLabel(group.provider) : '', connectionAddressLabel(group),
              ].filter(Boolean).join(' · '))),
            !(group.connection.apiKey || credentialConfigured(group.connection)) ? h('span', { className: 'ms-connection-warning' }, '缺少 Key') : null,
            h('span', { className: 'ms-connection-count' }, group.models.length + ' 个模型'),
            h('span', { className: 'ms-chevron', 'aria-hidden': 'true' }))))) : status === 'loading' ? note('正在读取模型配置…') : null);
    };
    const renderDirectory = () => providerForm ? renderProviderForm() : active ? renderProvider(active) : renderOverview();
    const selectedCount = providerForm?.picks.size || 0;
    const saveLabel = selectedCount ? '保存提供商和 ' + selectedCount + ' 个模型' : '仅保存提供商';
    const editorActions = providerForm ? [
      button('取消', () => setProviderForm(null), undefined, { key: 'cancel', disabled: saving }),
      button(saving ? '保存中…' : providerForm.id ? '应用修改' : saveLabel, applyProvider, 'primary',
        { key: 'apply', disabled: saving || providerForm.check?.state === 'loading' }),
    ] : null;
    return {
      renderDirectory, importPanel: importGroup ? renderImportPanel() : null,
      importedCount, selectedConnections: catalog?.picks.size || 0, addSelected,
      editorActions, atOverview: !active && !providerForm && !importGroup,
      showOverview: () => { openProvider(''); setProviderForm(null); setCatalog(null); },
    };
  }
  return { useModelSettingsDirectory, backButton };
}
