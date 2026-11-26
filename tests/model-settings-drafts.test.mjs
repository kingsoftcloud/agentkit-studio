import test from 'node:test';
import assert from 'node:assert/strict';
import { clearModelSettingsDrafts, createModelSettingsSection, modelSettingsDraftKeys } from '../src/client/pages/model-settings.mjs';

const walk = node => node && typeof node === 'object' ? [node, ...(node.children || []).flatMap(walk)] : [];

const savedProfiles = () => [
  { id: 'alpha', provider: 'custom', modelName: 'alpha-model', baseUrl: 'https://alpha.test/v1', credentialName: 'ALPHA_KEY', enabled: true, default: true, input: ['text'] },
  { id: 'beta', provider: 'custom', modelName: 'beta-model', baseUrl: 'https://beta.test/v1', credentialName: 'BETA_KEY', enabled: true, default: false, input: ['text'] },
];

/**
 * 方案 C harness: a real mount of the shipped component with a fake Host.
 * State/effects are positional like React; effects honour deps so `load()` runs
 * once, and calling `settle()` again models a brand new mount of the sheet.
 */
function modelSettingsHarness({ profiles = savedProfiles(), host = {} } = {}) {
  const values = { modelProfiles: structuredClone(profiles) };
  const writes = [];
  const events = [];
  const hostRemote = {
    settings: async () => structuredClone(values),
    updateSettings: async patch => { writes.push(structuredClone(patch)); Object.assign(values, structuredClone(patch)); return {}; },
    syncModelCredential: async () => {},
    modelCatalog: async () => ({ items: [] }),
    ...host,
  };
  const dshModel = { describe: async () => ({ namespaces: [] }), credentialStatus: async () => ({ configured: true }), applyProfiles: async () => {} };
  const states = [], effects = [];
  let cursor = 0, dirty = true, tree;
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(value => value !== null && value !== undefined && value !== false) });
  const useState = initial => {
    const index = cursor++;
    if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
    return [states[index], next => { const value = typeof next === 'function' ? next(states[index]) : next; if (!Object.is(value, states[index])) { states[index] = value; dirty = true; } }];
  };
  const useRef = initial => useState(() => ({ current: initial }))[0];
  const useEffect = (effect, deps) => {
    const index = cursor++, previous = states[index];
    if (!previous || !deps || deps.some((value, i) => !Object.is(value, previous.deps?.[i]))) {
      states[index] = { deps, cleanup: previous?.cleanup };
      effects.push(() => { states[index].cleanup?.(); states[index].cleanup = effect(); });
    }
  };
  class CustomEvent { constructor(type) { this.type = type; } }
  const Component = createModelSettingsSection({
    ui: { React: { createElement: h, useState, useEffect, useRef }, SecretInput: 'SecretInput', BRAND: {} },
    hostRemote, window: { dispatchEvent: event => events.push(event.type) }, CustomEvent,
  });
  const render = () => { cursor = 0; dirty = false; tree = Component({ dshModel }); for (const effect of effects.splice(0)) effect(); };
  const settle = async () => { render(); for (let i = 0; i < 200; i += 1) { await Promise.resolve(); if (dirty) render(); } return tree; };
  return {
    settle, values, writes, events, nodes: () => walk(tree), text: () => JSON.stringify(tree),
    save: async () => { await walk(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); },
  };
}

const modelName = view => view.nodes().find(node => node.props?.['aria-label'] === '模型名称');
const apiKey = view => view.nodes().find(node => node.type === 'SecretInput');
const button = (view, label) => view.nodes().find(node => node.type === 'button' && (node.children || []).includes(label));
const modelRows = view => view.nodes().filter(node => node.type === 'button' && node.props['data-model-row']);
const providerRows = view => view.nodes().filter(node => node.type === 'button' && node.props['data-model-connection']);
const field = (view, label) => view.nodes().find(node => node.props?.['aria-label'] === label);
const selectProvider = async (view, index) => {
  if (button(view, '返回提供商')) { button(view, '返回提供商').props.onClick(); await view.settle(); }
  if (button(view, '模型提供商')) { button(view, '模型提供商').props.onClick(); await view.settle(); }
  providerRows(view)[index].props.onClick();
  await view.settle();
};
const selectModel = async (view, index) => {
  await selectProvider(view, index);
  modelRows(view)[0].props.onClick();
  await view.settle();
};
const saveButton = view => view.nodes().find(node => node.type === 'button' && node.props.type === 'submit' && node.props['data-variant'] === 'primary');
const unsavedChip = view => view.nodes().find(node => node.props?.['data-unsaved'] === 'true' && (node.children || []).includes('未保存'));
const draftNote = view => view.nodes().find(node => node.props?.className === 'ms-footer-note' && node.props?.['data-tone'] === 'draft');

test.beforeEach(() => clearModelSettingsDrafts());
test.afterEach(() => clearModelSettingsDrafts());

test('switching A → B → A keeps A’s unsaved edits and never prompts', async () => {
  const view = modelSettingsHarness();
  await view.settle();
  await selectModel(view, 0);
  assert.equal(modelName(view).props.value, 'alpha-model');
  assert.equal(unsavedChip(view), undefined);

  modelName(view).props.onChange({ target: { value: 'alpha-edited' } });
  await view.settle();
  assert.ok(unsavedChip(view), 'the edited model shows the 未保存 chip');
  assert.equal(saveButton(view).props['data-dirty'], 'true');
  assert.ok(draftNote(view), 'the footer explains the draft is memory-only');
  assert.match(draftNote(view).children.join(''), /刷新后丢失/);

  await selectModel(view, 1);
  assert.equal(modelName(view).props.value, 'beta-model', 'B shows its own saved values');
  assert.ok(apiKey(view), 'the connection block with its API Key is available in the model editor too');
  assert.equal(unsavedChip(view), undefined, 'B itself is clean');
  assert.equal(saveButton(view).props['data-dirty'], 'true', 'the form still has an unsaved draft');
  await selectProvider(view, 0);
  assert.equal(modelRows(view).filter(node => node.props['data-draft'] === true).length, 1, 'the list marks the drafted model');

  await selectModel(view, 0);
  assert.equal(modelName(view).props.value, 'alpha-edited', 'A’s unsaved model name is restored');
  assert.ok(unsavedChip(view));
  assert.deepEqual(modelSettingsDraftKeys(), ['alpha']);
  assert.deepEqual(view.values.modelProfiles.find(profile => profile.id === 'alpha').modelName, 'alpha-model', 'switching never writes to the Host');
  assert.deepEqual(view.writes, []);
});

test('saving persists the drafts, then clears the chip and the promoted save button', async () => {
  const view = modelSettingsHarness();
  await view.settle();
  await selectModel(view, 0);
  modelName(view).props.onChange({ target: { value: 'alpha-edited' } });
  await view.settle();
  assert.ok(unsavedChip(view));

  await view.save();
  await view.settle();
  assert.equal(view.values.modelProfiles.find(profile => profile.id === 'alpha').modelName, 'alpha-edited');
  assert.equal(unsavedChip(view), undefined, 'the saved model is no longer a draft');
  assert.equal(saveButton(view).props['data-dirty'], 'false');
  assert.equal(draftNote(view), undefined);
  assert.deepEqual(modelSettingsDraftKeys(), [], 'saving clears the memory draft table');

  const reopened = modelSettingsHarness({ profiles: view.values.modelProfiles });
  await reopened.settle();
  assert.equal(unsavedChip(reopened), undefined, 'a later mount does not resurrect a saved draft');
});

test('adding or cancelling a provider never creates an empty model', async () => {
  const view = modelSettingsHarness({ host: {
    probeModelEndpoint: async () => ({ items: [{ id: 'research-chat', input: ['text'] }] }),
  } });
  await view.settle();
  assert.equal(modelRows(view).length, 0, 'overview only shows providers');
  button(view, '＋ 添加提供商').props.onClick();
  await view.settle();
  assert.equal(modelName(view), undefined);
  assert.equal(field(view, '模型 ID'), undefined);
  button(view, '取消').props.onClick();
  await view.settle();
  assert.equal(providerRows(view).length, 2);
  assert.deepEqual(modelSettingsDraftKeys(), []);

  button(view, '＋ 添加提供商').props.onClick();
  await view.settle();
  field(view, '提供商类型').props.onChange({ target: { value: 'custom' } });
  await view.settle();
  field(view, '提供商名称').props.onChange({ target: { value: '研究网关' } });
  await view.settle();
  field(view, 'API 地址').props.onChange({ target: { value: 'https://research.test/v1' } });
  await view.settle();
  apiKey(view).props.onChange({ target: { value: 'test-research-key' } });
  await view.settle();
  await button(view, '测试连接').props.onClick();
  await view.settle();
  assert.ok(field(view, 'research-chat'), 'the connection check displays the catalog');
  assert.deepEqual(modelSettingsDraftKeys(), []);
  assert.deepEqual(view.writes, []);

  await button(view, '仅保存提供商').props.onClick();
  await view.settle();
  assert.match(view.text(), /暂未添加模型/);
  assert.equal(view.values.modelProfiles.length, 2);
  const provider = view.values.modelConnections.find(item => item.connectionName === '研究网关');
  assert.equal(provider.baseUrl, 'https://research.test/v1');
  assert.equal(view.values.modelProfileKeys[provider.credentialName], 'test-research-key');
  assert.equal(Object.hasOwn(provider, 'apiKey'), false);
});

test('the tested catalog saves with its provider and defaults, and retry reuses the same IDs', async () => {
  let failFirstSync = true;
  const wireChecks = [];
  const view = modelSettingsHarness({ host: {
    probeModelEndpoint: async () => ({ items: [
      { id: 'research-thinks', input: ['text'], reasoningLevels: ['low', 'high'], defaultReasoningEffort: 'low' },
      { id: 'research-default', input: ['text'], defaultReasoningEffort: 'high' },
    ] }),
    probeModelWire: async request => {
      wireChecks.push(request.models);
      return { items: [
        { modelName: 'research-thinks', wire: 'openai-responses' },
        { modelName: 'research-default', wire: 'openai-completions' },
      ] };
    },
    syncModelCredential: async () => {
      if (!failFirstSync) return;
      failFirstSync = false;
      throw new Error('同步需要重试');
    },
  } });
  await view.settle();
  button(view, '＋ 添加提供商').props.onClick();
  await view.settle();
  apiKey(view).props.onChange({ target: { value: 'fixture-key' } });
  await view.settle();
  await button(view, '测试连接').props.onClick();
  await view.settle();
  assert.equal(field(view, '本次添加的思考等级'), undefined);
  for (const name of ['research-thinks', 'research-default']) {
    field(view, name).props.onChange({ target: { checked: true } });
    await view.settle();
  }
  assert.deepEqual(view.writes, []);
  await button(view, '保存提供商和 2 个模型').props.onClick();
  await view.settle();
  assert.match(view.text(), /同步需要重试/);
  const first = view.writes[0];
  const provider = first.modelConnections.at(-1);
  const models = first.modelProfiles.filter(item => item.connectionId === provider.id);
  assert.deepEqual(models.map(item => [item.modelName, item.defaultReasoningEffort]), [['research-thinks', 'low'], ['research-default', undefined]]);
  assert.ok(models.every(item => item.modelOnly));
  assert.deepEqual(models[0].reasoningLevels, ['low', 'high']);
  assert.deepEqual(models[1].reasoningLevels, []);
  assert.deepEqual(wireChecks[0], ['research-thinks', 'research-default']);
  assert.deepEqual(models.map(model => [model.protocol, model.codexApi]),
    [['openai-responses', 'responses'], ['openai-chat', 'chat-completions']]);
  assert.equal(first.modelProfiles[0].protocol, undefined, 'existing profiles keep their wire');

  await button(view, '保存提供商和 2 个模型').props.onClick();
  await view.settle();
  assert.deepEqual(view.values.modelProfiles.filter(item => item.connectionId === provider.id).map(item => item.id), models.map(item => item.id));
  assert.equal(view.values.modelConnections.filter(item => item.id === provider.id).length, 1);
  assert.equal(modelRows(view).length, 2);
});

test('probing selected catalog models reports partial results without changing the import', async () => {
  const calls = [];
  const view = modelSettingsHarness({ host: {
    probeModelEndpoint: async () => ({ items: [
      { id: 'known', reasoningLevels: ['low'] }, { id: 'edge' }, { id: 'silent' }, { id: 'not-selected' },
    ] }),
    probeModelEfforts: async payload => {
      calls.push(payload);
      return { wire: 'openai-completions', outcomes: [
        { level: 'low', outcome: 'accepted' }, { level: 'medium', outcome: 'timeout' }, { level: 'max', outcome: 'untested' },
      ] };
    },
  } });
  await view.settle();
  button(view, '＋ 添加提供商').props.onClick();
  await view.settle();
  apiKey(view).props.onChange({ target: { value: 'fixture-key' } });
  await view.settle();
  await button(view, '测试连接').props.onClick();
  await view.settle();
  for (const name of ['known', 'edge', 'silent']) {
    field(view, name).props.onChange({ target: { checked: true } });
    await view.settle();
  }
  await button(view, '探测 3 个模型的档位').props.onClick();
  await view.settle();
  assert.deepEqual(calls.map(item => item.modelName), ['known', 'edge', 'silent']);
  assert.ok(calls.every(item => item.apiKey === 'fixture-key' && item.detectWire));
  assert.match(view.text(), /请求通过 低 · 超时 中 · 未测 最高/);
  assert.match(view.text(), /沿用服务默认/);
  assert.deepEqual(view.writes, []);
  await button(view, '保存提供商和 3 个模型').props.onClick();
  const saved = view.writes[0].modelProfiles.slice(-3);
  assert.deepEqual(saved.map(({ modelName, reasoningLevels, defaultReasoningEffort }) => [modelName, reasoningLevels, defaultReasoningEffort]), [
    ['known', ['low'], 'low'], ['edge', [], undefined], ['silent', [], undefined],
  ]);
});

test('reprobing a saved model leaves its range and default intact even after a timeout', async () => {
  const profiles = savedProfiles();
  Object.assign(profiles[0], { reasoningEfforts: true, defaultReasoningEffort: 'high', reasoningLevels: ['low', 'high'] });
  let outcome = 'rejected';
  const calls = [];
  const view = modelSettingsHarness({ profiles, host: {
    probeModelEfforts: async payload => { calls.push(payload); return { outcomes: [{ level: 'high', outcome }] }; },
  } });
  await view.settle();
  await selectModel(view, 0);
  await button(view, '探测档位').props.onClick();
  await view.settle();
  assert.equal(field(view, '思考等级').props.value, 'high');
  assert.deepEqual(field(view, '思考等级').children.map(option => option.props.value), ['', 'low', 'high']);
  assert.deepEqual(calls[0], { profileId: 'alpha', modelName: 'alpha-model', protocol: 'openai-chat' });
  assert.match(view.text(), /拒绝 高/);
  assert.equal(unsavedChip(view), undefined);
  assert.deepEqual(view.writes, []);
  await view.save();
  await view.settle();
  assert.deepEqual(view.values.modelProfiles[0].reasoningLevels, ['low', 'high']);

  outcome = 'timeout';
  await button(view, '探测档位').props.onClick();
  await view.settle();
  assert.match(view.text(), /超时 高/);
  assert.equal(field(view, '思考等级').props.value, 'high');
  await view.save();
  await view.settle();
  assert.deepEqual(view.values.modelProfiles[0].reasoningLevels, ['low', 'high']);
  assert.equal(view.values.modelProfiles[0].defaultReasoningEffort, 'high');
});

test('closing and reopening the sheet restores the same draft from the memory table', async () => {
  const first = modelSettingsHarness();
  await first.settle();
  await selectModel(first, 0);
  modelName(first).props.onChange({ target: { value: 'alpha-edited' } });
  await first.settle();

  // A fresh mount is what closing and reopening the settings sheet does.
  const second = modelSettingsHarness();
  await second.settle();
  await selectModel(second, 0);
  assert.equal(modelName(second).props.value, 'alpha-edited');
  assert.ok(unsavedChip(second));
  assert.equal(second.values.modelProfiles.find(profile => profile.id === 'alpha').modelName, 'alpha-model', 'the draft was never persisted');

  // The in-memory draft is all there is: a new page starts from storage.
  clearModelSettingsDrafts();
  const third = modelSettingsHarness();
  await third.settle();
  await selectModel(third, 0);
  assert.equal(modelName(third).props.value, 'alpha-model');
  assert.equal(unsavedChip(third), undefined);
});

test('移除立即生效：模型被直接删除，alpha 的字段编辑也一并保存', async () => {
  const view = modelSettingsHarness();
  await view.settle();
  await selectModel(view, 0);
  modelName(view).props.onChange({ target: { value: 'alpha-edited' } });
  await view.settle();

  await selectModel(view, 1);
  button(view, '移除').props.onClick();
  await view.settle();
  // 移除立即生效：B 被直接删除并保存，alpha 的字段编辑也一并保存，草稿清空。
  assert.equal(modelRows(view).length, 0);
  assert.deepEqual(modelSettingsDraftKeys(), [], '保存后清空所有草稿');
  assert.ok(view.writes.length > 0, '移除立即写入 Host');

  await button(view, '重新读取').props.onClick();
  await view.settle();
  await selectProvider(view, 1);
  assert.equal(modelRows(view).length, 0, 'B 已被真的删除，重新读取不会恢复');
  await selectProvider(view, 0);
  assert.match(view.text(), /alpha-edited/, 'alpha 的字段编辑已被保存（不是被丢弃）');
  assert.equal(unsavedChip(view), undefined);
});

test('「撤销修改」drops only the selected model draft', async () => {
  const view = modelSettingsHarness();
  await view.settle();
  await selectModel(view, 0);
  modelName(view).props.onChange({ target: { value: 'alpha-edited' } });
  await view.settle();
  assert.ok(button(view, '撤销修改'));
  button(view, '撤销修改').props.onClick();
  await view.settle();
  assert.equal(modelName(view).props.value, 'alpha-model');
  assert.equal(unsavedChip(view), undefined);
  assert.deepEqual(modelSettingsDraftKeys(), []);
  assert.deepEqual(view.writes, []);
});

const advancedField = (view, label) => view.nodes().find(node => node.type === 'input' && node.props?.['aria-label'] === label);
const requestBudget = view => view.nodes().find(node => node.type === 'details' && node.props?.['data-model-request-budget'] === true);
const addHeader = view => view.nodes().find(node => node.type === 'button' && (node.children || []).includes('＋ 添加请求头'));
const headerInputs = view => view.nodes().filter(node => node.type === 'input' && /^请求头(名称|值) \d+$/.test(String(node.props?.['aria-label'] || '')));

test('the advanced request budget and headers are memory-only drafts that switching models keeps and 撤销修改 drops', async () => {
  const view = modelSettingsHarness();
  await view.settle();
  await selectModel(view, 0);
  const block = requestBudget(view);
  assert.ok(block, '高级段包含「请求预算与请求头」');
  assert.equal(block.props.open, undefined, '默认不展开');
  assert.equal(advancedField(view, '最大输出 Token').props.value, '');
  assert.match(view.text(), /还没有自定义请求头/);

  advancedField(view, '最大输出 Token').props.onChange({ target: { value: '4096' } });
  await view.settle();
  addHeader(view).props.onClick();
  await view.settle();
  assert.deepEqual(headerInputs(view).map(node => node.props.value), ['', ''], '新行先留空');
  headerInputs(view)[0].props.onChange({ target: { value: 'X-Gateway-Token' } });
  await view.settle();
  headerInputs(view)[1].props.onChange({ target: { value: 'draft-token' } });
  await view.settle();
  assert.ok(unsavedChip(view), '高级字段的修改也是未保存草稿');
  assert.deepEqual(modelSettingsDraftKeys(), ['alpha']);
  assert.deepEqual(view.writes, [], '草稿不会写 Host');

  await selectModel(view, 1);
  assert.equal(advancedField(view, '最大输出 Token').props.value, '', 'B 看不到 A 的草稿');
  await selectModel(view, 0);
  assert.equal(advancedField(view, '最大输出 Token').props.value, '4096');
  assert.deepEqual(headerInputs(view).map(node => node.props.value), ['X-Gateway-Token', 'draft-token']);

  button(view, '撤销修改').props.onClick();
  await view.settle();
  assert.equal(advancedField(view, '最大输出 Token').props.value, '');
  assert.match(view.text(), /还没有自定义请求头/);
  assert.equal(unsavedChip(view), undefined);
  assert.deepEqual(modelSettingsDraftKeys(), []);
  assert.deepEqual(view.writes, []);
});

test('catalog import probes and saves the same model independently on two connections', async () => {
  const profiles = savedProfiles();
  profiles[1].baseUrl = profiles[0].baseUrl;
  const items = [
    { id: profiles[0].modelName, input: ['text'] },
    { id: profiles[1].modelName, input: ['text'] },
    { id: 'shared-model', input: ['text'] },
  ];
  const probes = [];
  const view = modelSettingsHarness({ profiles, host: {
    modelCatalog: async () => ({ items }),
    probeModelEfforts: async request => {
      probes.push(request);
      return { outcomes: [{ level: request.profileId === 'alpha' ? 'low' : 'high', outcome: 'confirmed' }] };
    },
    probeModelWire: async () => ({ items: [{ modelName: 'shared-model', wire: 'unknown' }] }),
  } });
  const selectConnection = () => view.nodes().find(node => node.props['aria-label'] === '选择提供商');
  const checkbox = name => view.nodes().find(node => node.props.type === 'checkbox' && node.props['aria-label'] === name);

  await view.settle();
  assert.equal(view.nodes().filter(node => node.props['data-model-connection']).length, 2);
  await selectProvider(view, 0);
  button(view, '编辑提供商').props.onClick();
  await view.settle();
  field(view, '提供商名称').props.onChange({ target: { value: '团队网关' } });
  await view.settle();
  button(view, '应用修改').props.onClick();
  await view.settle();
  button(view, '添加模型').props.onClick();
  await view.settle();
  assert.equal(field(view, '模型 ID'), undefined, 'the picker starts with the catalog');
  assert.equal(checkbox('alpha-model').props.disabled, true);
  checkbox('shared-model').props.onChange({ target: { checked: true } });
  await view.settle();
  selectConnection().props.onChange({ target: { value: 'beta' } });
  await view.settle();
  assert.equal(checkbox('shared-model').props.checked, false);
  checkbox('shared-model').props.onChange({ target: { checked: true } });
  await view.settle();
  selectConnection().props.onChange({ target: { value: 'alpha' } });
  await view.settle();
  assert.equal(checkbox('shared-model').props.checked, true);
  assert.match(view.text(), /已选 2 个模型 · 2 个连接/);
  await button(view, '探测 2 个模型的档位').props.onClick();
  await view.settle();
  assert.deepEqual(probes.map(({ profileId, modelName }) => [profileId, modelName]), [['alpha', 'shared-model'], ['beta', 'shared-model']]);
  assert.match(view.text(), /服务回显 低/);
  selectConnection().props.onChange({ target: { value: 'beta' } });
  await view.settle();
  assert.match(view.text(), /服务回显 高/);
  assert.doesNotMatch(view.text(), /服务回显 低/);
  selectConnection().props.onChange({ target: { value: 'alpha' } });
  await view.settle();
  button(view, '添加所选模型').props.onClick();
  await view.settle();
  assert.equal(modelRows(view).length, 2, 'the provider page only displays models from this provider');
  assert.ok(view.writes.length > 0, '添加所选模型立即写入 Host（结构性操作即时生效）');

  const saved = view.values.modelProfiles;
  assert.deepEqual(saved.filter(profile => profile.modelName === 'shared-model').map(profile => profile.credentialName), ['ALPHA_KEY', 'BETA_KEY']);
  assert.deepEqual(saved.filter(profile => profile.modelName === 'shared-model').map(profile => [profile.reasoningLevels, profile.protocol]),
    [[[], 'openai-responses'], [[], 'openai-responses']]);
  assert.match(view.text(), /2 个模型的接口待确认/);
  assert.ok(saved.filter(profile => profile.credentialName === 'ALPHA_KEY').every(profile => profile.connectionName === '团队网关'));
  assert.ok(saved.filter(profile => profile.credentialName === 'BETA_KEY').every(profile => !profile.connectionName));
  assert.deepEqual(saved.filter(profile => profile.default).map(profile => profile.id), ['alpha']);
});

test('removing a provider stages its models and keeps one enabled default', async () => {
  const view = modelSettingsHarness();
  await view.settle();
  await selectProvider(view, 0);
  button(view, '移除提供商').props.onClick();
  await view.settle();
  assert.match(view.text(), /1 个模型/);
  assert.equal(button(view, '确认移除').props.disabled, false);
  button(view, '确认移除').props.onClick();
  await view.settle();
  assert.equal(providerRows(view).length, 1);
  assert.ok(view.writes.length > 0, '移除提供商立即写入 Host（结构性操作即时生效）');
  await selectProvider(view, 0);
  button(view, '移除提供商').props.onClick();
  await view.settle();
  assert.equal(button(view, '确认移除').props.disabled, true);
  button(view, '取消').props.onClick();
  await view.settle();

  assert.deepEqual(view.values.modelConnections.map(item => item.id), ['beta']);
  assert.deepEqual(view.values.modelProfiles.map(item => [item.id, item.default]), [['beta', true]]);
});
