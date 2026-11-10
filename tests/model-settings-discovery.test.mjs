import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelService } from '../src/model-service.mjs';
import { createModelSettingsSection } from '../src/client/pages/model-settings.mjs';

function ui(metadata, input, runtimeOptions = {}, hostOverrides = {}) {
  const values = { modelProfiles: [{ id: 'configured', provider: 'custom', modelName: 'vision', baseUrl: 'https://gateway.test/v1', credentialName: 'KEY', enabled: true, default: true, input, ...runtimeOptions }] };
  const config = {
    resolve: async () => ({ values }), describe: async () => ({ modelProfiles: values.modelProfiles }),
    update: async patch => Object.assign(values, patch),
  };
  const service = createModelService({ configuration: config, credentials: { resolve: async () => ({ value: 'test-key', source: 'env' }), set: async () => {} },
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: Array.isArray(metadata) ? metadata : [metadata] }) }) });
  const states = [], effects = [];
  let cursor = 0, dirty = true, tree, applied;
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat() });
  const useState = initial => {
    const index = cursor++;
    if (!(index in states)) states[index] = initial;
    return [states[index], next => { states[index] = typeof next === 'function' ? next(states[index]) : next; dirty = true; }];
  };
  const useEffect = callback => { const index = cursor++; if (!(index in states)) { states[index] = true; effects.push(callback); } };
  const host = { settings: service.settings, updateSettings: service.save, modelCatalog: service.catalog, syncModelCredential: service.sync, ...hostOverrides };
  const dshModel = { describe: async () => ({ namespaces: [] }), credentialStatus: async () => ({ configured: true }), applyProfiles: async payload => { applied = payload; } };
  const Component = createModelSettingsSection({
    ui: { React: { createElement: h, useState, useEffect }, BRAND: {}, Pill: 'pill', inputStyle: () => ({}), buttonStyle: () => ({}), SecretInput: 'SecretInput' },
    hostRemote: host, window: { dispatchEvent() {} }, CustomEvent: class {},
  });
  const render = () => { cursor = 0; dirty = false; tree = Component({ dshModel }); for (const callback of effects.splice(0)) callback(); };
  const settle = async () => { render(); for (let i = 0; i < 120; i++) { await Promise.resolve(); if (dirty) render(); } };
  const walk = node => node && typeof node === 'object' ? [node, ...(node.children || []).flatMap(walk)] : [];
  return { settle, nodes: () => walk(tree), text: () => JSON.stringify(tree), values, applied: () => applied,
    save: () => walk(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }) };
}

test('model settings auto-discover image capability, persist it and show it after reread without a checkbox', async () => {
  const view = ui({ id: 'vision', architecture: { input_modalities: ['文字', '图片'] } });
  await view.settle();
  assert.equal(view.nodes().some(node => node.type === 'input' && node.props.type === 'checkbox'), false);
  assert.match(view.text(), /图片/);
  await view.save();
  await view.settle();
  assert.deepEqual(view.values.modelProfiles[0].input, ['text', 'image']);
  assert.deepEqual(view.applied().profiles[0].input, ['text', 'image']);
  assert.match(view.text(), /图片/);
});

test('a catalog without capabilities displays unknown and retains the last known profile input', async () => {
  const view = ui({ id: 'vision' }, ['text', 'image']);
  await view.settle();
  assert.match(view.text(), /未提供能力信息/);
  await view.save();
  await view.settle();
  assert.deepEqual(view.values.modelProfiles[0].input, ['text', 'image']);
});

test('changing the model drops its previous image capability until the new model is discovered', async () => {
  const view = ui([{ id: 'vision', input: ['text', 'image'] }, { id: 'text', input: ['text'] }], ['text', 'image']);
  await view.settle();
  view.nodes().find(node => node.type === 'input' && node.props.value === 'vision').props.onChange({ target: { value: 'text' } });
  await view.settle();
  assert.match(view.text(), /保存后自动识别/);
  await view.save();
  await view.settle();
  assert.deepEqual(view.values.modelProfiles[0].input, ['text']);
  assert.deepEqual(view.applied().profiles[0].input, ['text']);
});

test('saving the model form preserves Native thinking, protocol and resource limits through both projections', async () => {
  const runtime = { displayName: 'Native validation', protocol: 'openai-chat', contextWindow: 128000,
    maxOutputTokens: 8192, requestTimeoutMs: 180000,
    parameters: { stream: true, thinking: { type: 'enabled' }, provider_thinking_display: true } };
  const view = ui({ id: 'vision', input: ['text'] }, ['text'], runtime);
  await view.settle(); await view.save(); await view.settle();
  for (const [key, value] of Object.entries(runtime)) {
    assert.deepEqual(view.values.modelProfiles[0][key], value, key);
    assert.deepEqual(view.applied().profiles[0][key], value, key);
  }
});

test('the Native thinking control changes only its declared option and preserves other model parameters', async () => {
  const view = ui({ id: 'vision', input: ['text'] }, ['text'], { parameters: { stream: true, temperature: 0.2 } });
  await view.settle();
  view.nodes().find(node => node.type === 'select' && node.props.value === 'default').props.onChange({ target: { value: 'enabled' } });
  await view.settle(); await view.save(); await view.settle();
  assert.deepEqual(view.values.modelProfiles[0].parameters, { stream: true, temperature: 0.2, thinking: { type: 'enabled' } });
  view.nodes().find(node => node.type === 'select' && node.props.value === 'enabled').props.onChange({ target: { value: 'default' } });
  await view.settle(); await view.save(); await view.settle();
  assert.deepEqual(view.values.modelProfiles[0].parameters, { stream: true, temperature: 0.2 });
});

test('model settings keeps at least one enabled profile', async () => {
  const view = ui({ id: 'vision', input: ['text'] }, ['text']);
  await view.settle();
  const toggle = view.nodes().find(node => node.type === 'button' && node.children.includes('停用'));
  assert.ok(toggle);
  toggle.props.onClick();
  await view.settle();
  assert.match(view.text(), /至少保留一个启用的模型/);
  assert.match(view.text(), /已配置/);
});

test('model settings reads an unsaved key before selecting a model and keeps it out of save payloads', async () => {
  let probed;
  const view = ui({ id: 'vision', input: ['text'] }, ['text'], {}, {
    probeModelEndpoint: async payload => {
      probed = payload;
      return { items: [{ id: 'catalog-model', name: 'Catalog model', input: ['text'] }] };
    },
  });
  await view.settle();
  const keyField = view.nodes().find(node => node.props?.label === 'API Key');
  assert.ok(keyField);
  keyField.props.onChange({ target: { value: 'unsaved-key' } });
  await view.settle();
  const readButton = view.nodes().find(node => node.type === 'button' && node.children.includes('读取模型'));
  assert.ok(readButton);
  readButton.props.onClick();
  await view.settle();
  assert.equal(probed.apiKey, 'unsaved-key');
  assert.equal(view.values.modelProfiles[0].apiKey, undefined);
  assert.match(view.text(), /Catalog model/);
  assert.match(view.text(), /已读取 1 个模型/);
  const testButton = view.nodes().find(node => node.type === 'button' && node.children.includes('测试连接'));
  assert.ok(testButton);
  testButton.props.onClick();
  await view.settle();
  assert.match(view.text(), /连接成功/);
});

const reasoningSelect = view => view.nodes().find(node => node.type === 'select' && node.props['aria-label'] === '思考等级');
const providerSelect = view => view.nodes().find(node => node.type === 'select' && node.props['aria-label'] === '提供商');
const optionValues = select => select.children.filter(node => node.type === 'option').map(node => node.props.value);

test('the reasoning selector lists only the levels the provider accepts and shows the wire value', async () => {
  const view = ui({ id: 'gpt', input: ['text'] }, ['text'], { provider: 'openai', reasoningEfforts: true, defaultReasoningEffort: 'medium' });
  await view.settle();
  const select = reasoningSelect(view);
  assert.ok(select);
  assert.equal(select.props.value, 'medium');
  assert.equal(select.props['data-model-reasoning'], 'medium');
  assert.deepEqual(optionValues(select), ['', 'low', 'medium', 'high']);
  const labels = Object.fromEntries(select.children.filter(node => node.type === 'option').map(node => [node.props.value, node.children.join('')]));
  assert.equal(labels.high, '高 → high');
  assert.equal(labels.medium, '中 → medium');
  assert.equal('max' in labels, false);
  assert.match(view.text(), /实际发送 reasoning_effort=medium/);
});

test('a Codex profile shows that its top level is sent as high', async () => {
  const view = ui({ id: 'gpt', input: ['text'] }, ['text'], { provider: 'codex', reasoningEfforts: true, defaultReasoningEffort: 'max' });
  await view.settle();
  const select = reasoningSelect(view);
  assert.equal(select.props.value, 'max');
  assert.equal(select.props['data-model-reasoning'], 'high');
  const top = select.children.find(node => node.type === 'option' && node.props.value === 'max');
  assert.equal(top.children.join(''), '最高 → high');
  assert.match(view.text(), /实际发送 reasoning_effort=high/);
});

test('an unknown provider exposes only the two safe, same-named levels', async () => {
  const view = ui({ id: 'custom', input: ['text'] }, ['text'], { provider: 'custom', reasoningEfforts: true });
  await view.settle();
  const select = reasoningSelect(view);
  assert.deepEqual(optionValues(select), ['', 'low', 'high']);
  assert.match(view.text(), /未识别的提供商/);
});

test('switching provider falls back to its default level instead of keeping an illegal one', async () => {
  const view = ui({ id: 'deepseek', input: ['text'] }, ['text'], { provider: 'ksyun', reasoningEfforts: true, defaultReasoningEffort: 'max' });
  await view.settle();
  assert.equal(reasoningSelect(view).props.value, 'max');
  providerSelect(view).props.onChange({ target: { value: 'openai' } });
  await view.settle();
  assert.equal(reasoningSelect(view).props.value, 'medium');
  assert.match(view.text(), /思考等级「最高」不受支持，已改为「中」/);
  assert.match(view.text(), /发送 medium/);
  await view.save();
  await view.settle();
  assert.equal(view.values.modelProfiles[0].provider, 'openai');
  assert.equal(view.values.modelProfiles[0].reasoningEfforts, true);
  assert.equal(view.values.modelProfiles[0].defaultReasoningEffort, 'medium');
});

test('a model without reasoning keeps「不启用」and writes no effort into the profile', async () => {
  const view = ui({ id: 'vision', input: ['text'] }, ['text']);
  await view.settle();
  assert.equal(reasoningSelect(view).props.value, '');
  await view.save();
  await view.settle();
  assert.equal('reasoningEfforts' in view.values.modelProfiles[0], false);
  assert.equal('defaultReasoningEffort' in view.values.modelProfiles[0], false);
});
